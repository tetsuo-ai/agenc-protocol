//! Permissionlessly reclaim rent from a provably orphaned, rent-only task child.
//!
//! Historical `close_task` versions destroyed the parent `Task` before proving all
//! auxiliary children had been closed. Those children can no longer use their
//! normal lifecycle handlers because each loads the parent. This narrow recovery
//! rail accepts only explicitly enumerated account types that hold no protocol
//! principal, proves the stored parent (`Task` or `TaskSubmission`) is absent,
//! verifies the child's canonical PDA, and returns rent to the party that
//! originally funded the account.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::OrphanTaskChildReclaimed;
use crate::instructions::program_account_helpers::deserialize_program_account;
use crate::state::{
    AgentRegistration, ProtocolConfig, SubmissionStatus, TaskAttestorConfig, TaskJobSpec,
    TaskModeration, TaskSubmission, TaskValidationConfig, TaskValidationVote,
};

pub mod orphan_task_child_kind {
    pub const JOB_SPEC: u8 = 0;
    pub const VALIDATION_CONFIG: u8 = 1;
    pub const ATTESTOR_CONFIG: u8 = 2;
    pub const MODERATION: u8 = 3;
    pub const TERMINAL_SUBMISSION: u8 = 4;
    /// The event's existing `task` field carries the verified parent
    /// `TaskSubmission` for this kind. Append-only to keep historical codes stable.
    pub const VALIDATION_VOTE: u8 = 5;
}

#[derive(Accounts)]
pub struct ReclaimOrphanTaskChild<'info> {
    /// CHECK: program-owned child; discriminator, fields, and canonical PDA are
    /// validated in the handler before any lamports move.
    #[account(mut)]
    pub child: UncheckedAccount<'info>,

    /// CHECK: must equal the child's stored parent (`Task` for task-level
    /// children, `TaskSubmission` for validation votes) and be a provably
    /// absent system-owned, zero-data account. The field name is ABI-stable.
    pub parent_task: UncheckedAccount<'info>,

    /// CHECK: used only for terminal TaskSubmission children; must be the stored
    /// worker AgentRegistration and is fully deserialized/canonically verified.
    pub worker_agent: UncheckedAccount<'info>,

    /// CHECK: must equal the child payer derived from stored program state and be
    /// writable. The cranker can never choose the rent destination.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,

    /// Permissionless cranker. Its signature provides transaction accountability
    /// but grants no authority over the rent destination.
    pub authority: Signer<'info>,
}

struct ReclaimTarget {
    task: Pubkey,
    destination: RentDestination,
    kind: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RentDestination {
    /// The historical payer is still authenticated by immutable child state.
    Stored(Pubkey),
    /// The original worker identity was closed or re-created after submission.
    /// Its wallet can no longer be authenticated, so rent goes only to the
    /// canonical configured treasury.
    ProtocolTreasury,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, ReclaimOrphanTaskChild<'info>>,
) -> Result<()> {
    let child_info = ctx.accounts.child.to_account_info();
    require!(
        child_info.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );
    require!(child_info.is_writable, CoordinationError::InvalidInput);

    let target =
        classify_and_validate_child(&child_info, &ctx.accounts.worker_agent.to_account_info())?;

    let parent_info = ctx.accounts.parent_task.to_account_info();
    require!(
        parent_info.key() == target.task,
        CoordinationError::InvalidInput
    );
    require!(
        parent_info.owner == &anchor_lang::system_program::ID && parent_info.data_is_empty(),
        CoordinationError::OrphanTaskParentStillLive
    );

    let fixed_recipient_info = ctx.accounts.rent_recipient.to_account_info();
    let recipient_info = match target.destination {
        RentDestination::Stored(recipient) => {
            // Direct recovery has no dynamic suffix. Rejecting ignored accounts
            // keeps this instruction's conditional wire contract exact.
            require!(
                ctx.remaining_accounts.is_empty(),
                CoordinationError::SubmissionRentAccountsRequired
            );
            require!(
                fixed_recipient_info.key() == recipient && fixed_recipient_info.is_writable,
                CoordinationError::TaskChildRentRecipientRequired
            );
            fixed_recipient_info
        }
        RentDestination::ProtocolTreasury => {
            // Preserve the five fixed account metas. The closed/discontinuous
            // worker fallback appends exactly:
            //   remaining_accounts[0] = canonical ProtocolConfig (readonly)
            //   remaining_accounts[1] = configured treasury (writable)
            require!(
                ctx.remaining_accounts.len() == 2,
                CoordinationError::SubmissionRentAccountsRequired
            );
            let protocol_info = &ctx.remaining_accounts[0];
            let treasury_info = &ctx.remaining_accounts[1];
            let protocol_config: ProtocolConfig = deserialize_program_account(protocol_info)
                .map_err(|_| CoordinationError::CorruptedData)?;
            let (expected_protocol, expected_protocol_bump) =
                Pubkey::find_program_address(&[b"protocol"], &crate::ID);
            require_keys_eq!(
                protocol_info.key(),
                expected_protocol,
                CoordinationError::InvalidInput
            );
            require!(
                protocol_config.bump == expected_protocol_bump,
                CoordinationError::InvalidInput
            );
            require_keys_eq!(
                treasury_info.key(),
                protocol_config.treasury,
                CoordinationError::InvalidTreasury
            );
            // The fixed recipient remains the actual destination meta. Requiring
            // it to alias the authenticated suffix treasury avoids an ignored,
            // caller-selected writable account while retaining the old fixed ABI.
            require_keys_eq!(
                fixed_recipient_info.key(),
                treasury_info.key(),
                CoordinationError::InvalidTreasury
            );
            require!(
                fixed_recipient_info.is_writable && treasury_info.is_writable,
                CoordinationError::SubmissionRentAccountsRequired
            );
            require!(
                treasury_info.owner == &anchor_lang::system_program::ID
                    && treasury_info.data_is_empty()
                    && !treasury_info.executable,
                CoordinationError::InvalidTreasury
            );
            treasury_info.clone()
        }
    };
    require!(
        recipient_info.key() != child_info.key(),
        CoordinationError::InvalidInput
    );

    let reclaimed_lamports = child_info.lamports();
    **child_info.try_borrow_mut_lamports()? = 0;
    **recipient_info.try_borrow_mut_lamports()? = recipient_info
        .lamports()
        .checked_add(reclaimed_lamports)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let mut data = child_info.try_borrow_mut_data()?;
    data.fill(0);
    if data.len() >= 8 {
        data[..8].copy_from_slice(&[255u8; 8]);
    }

    emit!(OrphanTaskChildReclaimed {
        child: child_info.key(),
        task: target.task,
        recipient: recipient_info.key(),
        cranker: ctx.accounts.authority.key(),
        child_kind: target.kind,
        reclaimed_lamports,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

fn require_canonical_child(actual: &Pubkey, seeds: &[&[u8]], stored_bump: u8) -> Result<()> {
    let (expected, bump) = Pubkey::find_program_address(seeds, &crate::ID);
    require!(
        *actual == expected && stored_bump == bump,
        CoordinationError::InvalidInput
    );
    Ok(())
}

fn classify_and_validate_child(
    child_info: &AccountInfo,
    worker_agent_info: &AccountInfo,
) -> Result<ReclaimTarget> {
    let data = child_info.try_borrow_data()?;

    if let Ok(job_spec) = TaskJobSpec::try_deserialize(&mut &data[..]) {
        require_canonical_child(
            child_info.key,
            &[b"task_job_spec", job_spec.task.as_ref()],
            job_spec.bump,
        )?;
        return Ok(ReclaimTarget {
            task: job_spec.task,
            destination: RentDestination::Stored(job_spec.creator),
            kind: orphan_task_child_kind::JOB_SPEC,
        });
    }

    if let Ok(config) = TaskValidationConfig::try_deserialize(&mut &data[..]) {
        require!(
            config.pending_submission_count() == 0,
            CoordinationError::TaskChildRequiresDedicatedCleanup
        );
        require_canonical_child(
            child_info.key,
            &[b"task_validation", config.task.as_ref()],
            config.bump,
        )?;
        return Ok(ReclaimTarget {
            task: config.task,
            destination: RentDestination::Stored(config.creator),
            kind: orphan_task_child_kind::VALIDATION_CONFIG,
        });
    }

    if let Ok(config) = TaskAttestorConfig::try_deserialize(&mut &data[..]) {
        require_canonical_child(
            child_info.key,
            &[b"task_attestor", config.task.as_ref()],
            config.bump,
        )?;
        return Ok(ReclaimTarget {
            task: config.task,
            destination: RentDestination::Stored(config.creator),
            kind: orphan_task_child_kind::ATTESTOR_CONFIG,
        });
    }

    if let Ok(moderation) = TaskModeration::try_deserialize(&mut &data[..]) {
        let (v2, v2_bump) = Pubkey::find_program_address(
            &[
                b"task_moderation_v2",
                moderation.task.as_ref(),
                moderation.job_spec_hash.as_ref(),
                moderation.moderator.as_ref(),
            ],
            &crate::ID,
        );
        let (legacy, legacy_bump) = Pubkey::find_program_address(
            &[
                b"task_moderation",
                moderation.task.as_ref(),
                moderation.job_spec_hash.as_ref(),
            ],
            &crate::ID,
        );
        require!(
            (*child_info.key == v2 && moderation.bump == v2_bump)
                || (*child_info.key == legacy && moderation.bump == legacy_bump),
            CoordinationError::InvalidInput
        );
        return Ok(ReclaimTarget {
            task: moderation.task,
            destination: RentDestination::Stored(moderation.moderator),
            kind: orphan_task_child_kind::MODERATION,
        });
    }

    if let Ok(submission) = TaskSubmission::try_deserialize(&mut &data[..]) {
        require!(
            matches!(
                submission.status,
                SubmissionStatus::Accepted | SubmissionStatus::Rejected
            ),
            CoordinationError::TaskChildRequiresDedicatedCleanup
        );
        require_canonical_child(
            child_info.key,
            &[b"task_submission", submission.claim.as_ref()],
            submission.bump,
        )?;
        let destination = submission_rent_destination(&submission, worker_agent_info)?;
        return Ok(ReclaimTarget {
            task: submission.task,
            destination,
            kind: orphan_task_child_kind::TERMINAL_SUBMISSION,
        });
    }

    if let Ok(vote) = TaskValidationVote::try_deserialize(&mut &data[..]) {
        require_canonical_child(
            child_info.key,
            &[
                b"task_validation_vote",
                vote.submission.as_ref(),
                vote.reviewer.as_ref(),
            ],
            vote.bump,
        )?;
        return Ok(ReclaimTarget {
            // A validation vote stores the submission, not the enclosing task.
            // The common handler treats this field as the exact parent account
            // whose system-owned, zero-data tombstone proves orphanhood.
            task: vote.submission,
            destination: RentDestination::Stored(vote.reviewer),
            kind: orphan_task_child_kind::VALIDATION_VOTE,
        });
    }

    err!(CoordinationError::OrphanTaskChildUnsupported)
}

/// Authenticate the historical worker identity behind a terminal submission.
///
/// Revision 4 could close an AgentRegistration and a later wallet could recreate
/// the same PDA. The address and bump alone therefore do not prove continuity.
/// An original registration (including a revision-5 RETD tombstone) must strictly
/// predate the submission. Equality is deliberately discontinuous because the old
/// binary allowed same-slot/same-second close-and-recreate bundles. Closed or
/// discontinuous identities route only to the canonical treasury in the handler.
fn submission_rent_destination(
    submission: &TaskSubmission,
    worker_agent_info: &AccountInfo,
) -> Result<RentDestination> {
    require_keys_eq!(
        worker_agent_info.key(),
        submission.worker,
        CoordinationError::SubmissionRentAccountsRequired
    );

    if worker_agent_info.owner == &crate::ID {
        require!(
            worker_agent_info.data_len() == AgentRegistration::SIZE,
            CoordinationError::CorruptedData
        );
        let worker: AgentRegistration = deserialize_program_account(worker_agent_info)
            .map_err(|_| CoordinationError::CorruptedData)?;
        let (expected_worker, expected_bump) =
            Pubkey::find_program_address(&[b"agent", worker.agent_id.as_ref()], &crate::ID);
        require_keys_eq!(
            expected_worker,
            worker_agent_info.key(),
            CoordinationError::SubmissionRentAccountsRequired
        );
        require!(
            worker.bump == expected_bump
                && worker.authority != Pubkey::default()
                && worker.validate_reserved_fields(),
            CoordinationError::CorruptedData
        );

        if worker.registered_at < submission.submitted_at {
            return Ok(RentDestination::Stored(worker.authority));
        }
        return Ok(RentDestination::ProtocolTreasury);
    }

    require!(
        worker_agent_info.owner == &anchor_lang::system_program::ID
            && worker_agent_info.data_is_empty(),
        CoordinationError::InvalidAccountOwner
    );
    Ok(RentDestination::ProtocolTreasury)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vote(submission: Pubkey, reviewer: Pubkey) -> (TaskValidationVote, Pubkey) {
        let (key, bump) = Pubkey::find_program_address(
            &[
                b"task_validation_vote",
                submission.as_ref(),
                reviewer.as_ref(),
            ],
            &crate::ID,
        );
        (
            TaskValidationVote {
                submission,
                reviewer,
                reviewer_agent: Pubkey::new_unique(),
                submission_round: 3,
                approved: true,
                voted_at: 1_700_000_000,
                bump,
                _reserved: [0u8; 5],
            },
            key,
        )
    }

    fn serialized_vote(vote: &TaskValidationVote) -> Vec<u8> {
        let mut data = vec![0u8; TaskValidationVote::SIZE];
        vote.try_serialize(&mut &mut data[..]).unwrap();
        data
    }

    #[test]
    fn validation_vote_binds_canonical_submission_parent_and_stored_reviewer() {
        let submission = Pubkey::new_unique();
        let reviewer = Pubkey::new_unique();
        let (vote, vote_key) = vote(submission, reviewer);
        let mut vote_lamports = 1;
        let mut vote_data = serialized_vote(&vote);
        let vote_info = AccountInfo::new(
            &vote_key,
            false,
            true,
            &mut vote_lamports,
            vote_data.as_mut_slice(),
            &crate::ID,
            false,
            0,
        );
        let worker_key = anchor_lang::system_program::ID;
        let worker_owner = anchor_lang::system_program::ID;
        let mut worker_lamports = 0;
        let mut worker_data: [u8; 0] = [];
        let worker_info = AccountInfo::new(
            &worker_key,
            false,
            false,
            &mut worker_lamports,
            &mut worker_data,
            &worker_owner,
            false,
            0,
        );

        let target = classify_and_validate_child(&vote_info, &worker_info).unwrap();
        assert_eq!(target.task, submission);
        assert_eq!(target.destination, RentDestination::Stored(reviewer));
        assert_eq!(target.kind, orphan_task_child_kind::VALIDATION_VOTE);
        assert_eq!(orphan_task_child_kind::VALIDATION_VOTE, 5);
    }

    #[test]
    fn validation_vote_rejects_address_or_bump_substitution() {
        let submission = Pubkey::new_unique();
        let reviewer = Pubkey::new_unique();
        let (canonical_vote, canonical_key) = vote(submission, reviewer);
        let worker_key = anchor_lang::system_program::ID;
        let worker_owner = anchor_lang::system_program::ID;
        let mut worker_lamports = 0;
        let mut worker_data: [u8; 0] = [];
        let worker_info = AccountInfo::new(
            &worker_key,
            false,
            false,
            &mut worker_lamports,
            &mut worker_data,
            &worker_owner,
            false,
            0,
        );

        let substituted_key = Pubkey::new_unique();
        let mut substituted_lamports = 1;
        let mut substituted_data = serialized_vote(&canonical_vote);
        let substituted_info = AccountInfo::new(
            &substituted_key,
            false,
            true,
            &mut substituted_lamports,
            substituted_data.as_mut_slice(),
            &crate::ID,
            false,
            0,
        );
        assert!(classify_and_validate_child(&substituted_info, &worker_info).is_err());

        let mut wrong_bump_vote = canonical_vote;
        wrong_bump_vote.bump = wrong_bump_vote.bump.wrapping_add(1);
        let mut wrong_bump_lamports = 1;
        let mut wrong_bump_data = serialized_vote(&wrong_bump_vote);
        let wrong_bump_info = AccountInfo::new(
            &canonical_key,
            false,
            true,
            &mut wrong_bump_lamports,
            wrong_bump_data.as_mut_slice(),
            &crate::ID,
            false,
            0,
        );
        assert!(classify_and_validate_child(&wrong_bump_info, &worker_info).is_err());
    }
}
