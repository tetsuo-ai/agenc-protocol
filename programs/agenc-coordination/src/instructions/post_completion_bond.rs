//! Post a symmetric 25% completion bond (Batch 3 §8, SOL v1).
//!
//! Both the creator and the worker post a bond equal to 25% of the reward into
//! their own dedicated PDA (`["completion_bond", task, party]`). The loser of a
//! dispute forfeits theirs, the winner is refunded, and a no-show worker's bond is
//! forfeited to the creator on `expire_claim`. The bond lives in its own PDA — never
//! on `TaskClaim` — so a no-show worker cannot get an auto-refund when the claim
//! closes to their wallet.

use crate::errors::CoordinationError;
use crate::events::BondPosted;
use crate::instructions::task_parent_helpers::load_canonical_parent_task;
use crate::state::{
    AgentRegistration, AgentStatus, CompletionBond, DependencyType, ProtocolConfig, Task,
    TaskClaim, TaskStatus, TaskType, HASH_SIZE, MANUAL_VALIDATION_SENTINEL,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

/// Prove the state of a dependent task's canonical parent account.
///
/// Remaining-account ABI: every task with a non-`None` dependency supplies its
/// canonical parent Task PDA at index 0. The account is required even after it
/// has been closed: a system-owned, zero-data account at that exact address is
/// an authenticated proof that no live Completed parent exists. Requiring the
/// address prevents a caller from omitting a live Completed parent to turn a
/// forfeiture into a refund on an exit path.
pub(crate) fn dependency_parent_completed(
    task: &Task,
    remaining_accounts: &[AccountInfo<'_>],
    program_id: &Pubkey,
) -> Result<bool> {
    if task.dependency_type == DependencyType::None {
        return Ok(true);
    }

    let parent_key = task
        .depends_on
        .ok_or(CoordinationError::InvalidDependencyType)?;
    let parent_info = remaining_accounts
        .first()
        .ok_or(CoordinationError::ParentTaskAccountRequired)?;
    require_keys_eq!(
        parent_info.key(),
        parent_key,
        CoordinationError::ParentTaskAccountRequired
    );

    // A closed PDA is reassigned to the system program with empty data. At the
    // seeds-pinned address this is positive evidence that a Completed parent is
    // not currently available, not caller-controlled missing-account evidence.
    if parent_info.owner == &system_program::ID && parent_info.data_is_empty() {
        return Ok(false);
    }
    require_keys_eq!(
        *parent_info.owner,
        *program_id,
        CoordinationError::InvalidAccountOwner
    );

    let parent = load_canonical_parent_task(parent_info, program_id)?;

    Ok(parent.status == TaskStatus::Completed)
}

#[derive(Accounts)]
#[instruction(role: u8)]
pub struct PostCompletionBond<'info> {
    #[account(seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()], bump = task.bump)]
    pub task: Box<Account<'info, Task>>,

    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// The bond PDA, keyed by the SIGNING wallet so the two sides get distinct PDAs
    /// and `init` makes one-bond-per-wallet-per-task automatic (a second post fails).
    #[account(
        init,
        payer = authority,
        space = CompletionBond::SIZE,
        seeds = [b"completion_bond", task.key().as_ref(), authority.key().as_ref()],
        bump
    )]
    pub completion_bond: Box<Account<'info, CompletionBond>>,

    /// Worker identity for ROLE_WORKER. Omitted for ROLE_CREATOR.
    #[account(
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump
    )]
    pub worker: Option<Box<Account<'info, AgentRegistration>>>,

    /// Live claim proving the worker signer is actually assigned to this task.
    /// Typed for ownership/discriminator checks; canonical PDA + bindings are
    /// verified in the handler because `worker` is role-conditional.
    pub worker_claim: Option<Box<Account<'info, TaskClaim>>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PostCompletionBond>, role: u8) -> Result<()> {
    let task = &ctx.accounts.task;
    let clock = Clock::get()?;

    // Posting creates new custody and therefore uses the entry gate. A pause or
    // incompatible version must never accept a fresh bond that exits may not know
    // how to settle.
    check_version_compatible(&ctx.accounts.protocol_config)?;

    // Dependency bonds are meaningful only after the work is actually
    // executable. For every dependency type, require the canonical parent at
    // remaining_accounts[0] and require that it is already Completed.
    require!(
        dependency_parent_completed(task, ctx.remaining_accounts, ctx.program_id)?,
        CoordinationError::ParentTaskNotCompleted
    );

    // Single-worker (Exclusive) only in v1: the hire path mints Exclusive tasks and
    // the 25/25 semantics assume exactly one creator and one worker.
    require!(
        task.task_type == TaskType::Exclusive,
        CoordinationError::BondUnsupportedTaskType
    );

    // Bonds may be posted any time before terminal settlement: creator while Open,
    // worker once InProgress, either side while a submission awaits review
    // (PendingValidation). Not during a dispute, freeze, or terminal state.
    require!(
        task.status == TaskStatus::Open
            || task.status == TaskStatus::InProgress
            || task.status == TaskStatus::PendingValidation,
        CoordinationError::InvalidStatusTransition
    );

    // Role binding: creator bonds are creator-only. Worker bonds require the
    // canonical live claimant identity and claim; merely being "not the creator"
    // is not evidence of a worker role and previously allowed arbitrary,
    // unenumerable bond PDAs to be stranded after task close.
    match role {
        CompletionBond::ROLE_CREATOR => {
            require!(
                ctx.accounts.authority.key() == task.creator,
                CoordinationError::BondPartyMismatch
            );
            require!(
                ctx.accounts.worker.is_none() && ctx.accounts.worker_claim.is_none(),
                CoordinationError::BondPartyMismatch
            );
        }
        CompletionBond::ROLE_WORKER => {
            require!(
                matches!(
                    task.status,
                    TaskStatus::InProgress | TaskStatus::PendingValidation
                ),
                CoordinationError::InvalidStatusTransition
            );
            let worker = ctx
                .accounts
                .worker
                .as_ref()
                .ok_or(CoordinationError::BondPartyMismatch)?;
            let claim = ctx
                .accounts
                .worker_claim
                .as_ref()
                .ok_or(CoordinationError::BondPartyMismatch)?;
            require!(
                !worker.is_retired_identity()
                    && matches!(worker.status, AgentStatus::Active | AgentStatus::Busy)
                    && worker.authority == ctx.accounts.authority.key(),
                CoordinationError::BondPartyMismatch
            );
            require!(
                claim.task == task.key()
                    && claim.worker == worker.key()
                    && !claim.is_completed
                    && claim.expires_at > clock.unix_timestamp,
                CoordinationError::BondPartyMismatch
            );
            let (expected_claim, _) = Pubkey::find_program_address(
                &[b"claim", task.key().as_ref(), worker.key().as_ref()],
                &crate::ID,
            );
            require!(
                claim.key() == expected_claim,
                CoordinationError::BondPartyMismatch
            );
        }
        _ => return Err(CoordinationError::BondRoleMismatch.into()),
    }

    // SOL-only v1.
    require!(
        task.reward_mint.is_none(),
        CoordinationError::BondUnsupportedTaskType
    );

    // Bonds are only supported on tasks whose SUCCESS path settles them: Auto
    // (constraint_hash == 0 -> complete_task) and manual-review (sentinel -> accept /
    // auto_accept). A ZK-private task (a real constraint_hash) settles via
    // complete_task_private, which does NOT settle bonds, so posting one there would
    // permanently strand it on completion. Reject bonds on private tasks (audit fix).
    require!(
        task.constraint_hash == [0u8; HASH_SIZE]
            || task.constraint_hash == MANUAL_VALIDATION_SENTINEL,
        CoordinationError::BondUnsupportedTaskType
    );

    // 25% of the reward, held as excess lamports on the bond PDA (on top of rent).
    let amount = (task.reward_amount as u128)
        .checked_mul(CompletionBond::BOND_BPS as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(10_000u128)
        .ok_or(CoordinationError::ArithmeticOverflow)? as u64;

    if amount > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.completion_bond.to_account_info(),
                },
            ),
            amount,
        )?;
    }

    let bond = &mut ctx.accounts.completion_bond;
    bond.task = task.key();
    bond.party = ctx.accounts.authority.key();
    bond.role = role;
    bond.amount = amount;
    bond.bond_mint = None;
    bond.posted_at = clock.unix_timestamp;
    bond.bump = ctx.bumps.completion_bond;
    bond._reserved = [0u8; 16];

    emit!(BondPosted {
        task: task.key(),
        party: bond.party,
        role,
        amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical_parent(status: TaskStatus) -> (Task, Pubkey) {
        let mut parent = Task {
            creator: Pubkey::new_unique(),
            task_id: [41u8; 32],
            status,
            ..Task::default()
        };
        let (key, bump) = Pubkey::find_program_address(
            &[b"task", parent.creator.as_ref(), parent.task_id.as_ref()],
            &crate::ID,
        );
        parent.bump = bump;
        (parent, key)
    }

    fn dependent_task(parent: Pubkey, dependency_type: DependencyType) -> Task {
        Task {
            depends_on: Some(parent),
            dependency_type,
            ..Task::default()
        }
    }

    fn serialized_task(task: &Task) -> Vec<u8> {
        let mut data = vec![0u8; Task::SIZE];
        task.try_serialize(&mut &mut data[..]).unwrap();
        data
    }

    fn account_info<'a>(
        key: &'a Pubkey,
        owner: &'a Pubkey,
        lamports: &'a mut u64,
        data: &'a mut [u8],
    ) -> AccountInfo<'a> {
        AccountInfo::new(key, false, false, lamports, data, owner, false, 0)
    }

    // Revert-sensitive: Data and Ordering were the exploitable cases. All three
    // dependency types now require the same canonical Completed-parent proof.
    #[test]
    fn every_dependency_type_accepts_only_a_completed_canonical_parent() {
        for dependency_type in [
            DependencyType::Data,
            DependencyType::Ordering,
            DependencyType::Proof,
        ] {
            let (parent, parent_key) = canonical_parent(TaskStatus::Completed);
            let child = dependent_task(parent_key, dependency_type);
            let mut lamports = 1;
            let mut data = serialized_task(&parent);
            let info = account_info(&parent_key, &crate::ID, &mut lamports, data.as_mut_slice());

            assert!(
                dependency_parent_completed(&child, std::slice::from_ref(&info), &crate::ID,)
                    .unwrap()
            );
        }
    }

    #[test]
    fn noncompleted_and_closed_parents_are_authenticated_refund_evidence() {
        for dependency_type in [
            DependencyType::Data,
            DependencyType::Ordering,
            DependencyType::Proof,
        ] {
            let (parent, parent_key) = canonical_parent(TaskStatus::Cancelled);
            let child = dependent_task(parent_key, dependency_type);
            let mut lamports = 1;
            let mut data = serialized_task(&parent);
            let info = account_info(&parent_key, &crate::ID, &mut lamports, data.as_mut_slice());
            assert!(
                !dependency_parent_completed(&child, std::slice::from_ref(&info), &crate::ID,)
                    .unwrap()
            );

            let mut closed_lamports = 0;
            let mut closed_data = Vec::new();
            let closed_info = account_info(
                &parent_key,
                &system_program::ID,
                &mut closed_lamports,
                closed_data.as_mut_slice(),
            );
            assert!(!dependency_parent_completed(
                &child,
                std::slice::from_ref(&closed_info),
                &crate::ID,
            )
            .unwrap());
        }
    }

    // Omission must fail: otherwise a worker could hide a live Completed parent
    // during expiry and select the refund branch instead of the forfeit branch.
    #[test]
    fn dependent_parent_account_cannot_be_omitted_or_substituted() {
        let (parent, parent_key) = canonical_parent(TaskStatus::Completed);
        let child = dependent_task(parent_key, DependencyType::Data);
        assert!(dependency_parent_completed(&child, &[], &crate::ID).is_err());

        let substituted_key = Pubkey::new_unique();
        let substituted_child = dependent_task(substituted_key, DependencyType::Data);
        let mut lamports = 1;
        let mut data = serialized_task(&parent);
        let info = account_info(
            &substituted_key,
            &crate::ID,
            &mut lamports,
            data.as_mut_slice(),
        );
        assert!(dependency_parent_completed(
            &substituted_child,
            std::slice::from_ref(&info),
            &crate::ID,
        )
        .is_err());
    }

    // Mainnet still contains pre-append-only-layout Task accounts. They must be
    // accepted as parent evidence without weakening PDA/status verification.
    #[test]
    fn completed_legacy_parent_layout_is_supported() {
        let (parent, parent_key) = canonical_parent(TaskStatus::Completed);
        let child = dependent_task(parent_key, DependencyType::Ordering);
        let mut data = serialized_task(&parent);
        data.truncate(Task::OLD_TASK_SIZE);
        let mut lamports = 1;
        let info = account_info(&parent_key, &crate::ID, &mut lamports, data.as_mut_slice());
        assert!(
            dependency_parent_completed(&child, std::slice::from_ref(&info), &crate::ID,).unwrap()
        );
    }

    #[test]
    fn completed_batch2_parent_layout_is_supported() {
        let (parent, parent_key) = canonical_parent(TaskStatus::Completed);
        let child = dependent_task(parent_key, DependencyType::Data);
        let mut data = serialized_task(&parent);
        data.truncate(Task::BATCH2_TASK_SIZE);
        let mut lamports = 1;
        let info = account_info(&parent_key, &crate::ID, &mut lamports, data.as_mut_slice());
        assert!(
            dependency_parent_completed(&child, std::slice::from_ref(&info), &crate::ID,).unwrap()
        );
    }

    #[test]
    fn malformed_parent_lengths_and_wrong_stored_bump_fail_closed() {
        let (parent, parent_key) = canonical_parent(TaskStatus::Completed);
        let child = dependent_task(parent_key, DependencyType::Proof);

        for malformed_len in [
            Task::OLD_TASK_SIZE - 1,
            Task::OLD_TASK_SIZE + 1,
            Task::BATCH2_TASK_SIZE - 1,
            Task::BATCH2_TASK_SIZE + 1,
        ] {
            let mut data = serialized_task(&parent);
            data.truncate(malformed_len);
            let mut lamports = 1;
            let info = account_info(&parent_key, &crate::ID, &mut lamports, data.as_mut_slice());
            assert!(
                dependency_parent_completed(&child, std::slice::from_ref(&info), &crate::ID,)
                    .is_err(),
                "unexpectedly accepted malformed parent length {malformed_len}",
            );
        }

        let mut wrong_bump = parent;
        wrong_bump.bump = wrong_bump.bump.wrapping_add(1);
        let mut data = serialized_task(&wrong_bump);
        let mut lamports = 1;
        let info = account_info(&parent_key, &crate::ID, &mut lamports, data.as_mut_slice());
        assert!(
            dependency_parent_completed(&child, std::slice::from_ref(&info), &crate::ID,).is_err()
        );
    }
}
