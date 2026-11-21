//! Exits for a RejectFrozen task (Batch 3 §8). A task frozen by `reject_and_freeze`
//! has NO other settlement path, so without these its escrow + claim + bonds would
//! strand. Both are exit paths (money-never-locks): they call
//! `check_version_compatible_for_exit` so a paused protocol still settles.
//!
//! A frozen task is ALWAYS a manual (CreatorReview) task. Humanless listing hires
//! create that validation mode directly, so both worker-payout exits must honor the
//! same immutable operator/referrer terms as normal accept and auto-accept paths.
//!
//! Revision 9 (A, B). `TaskSubmission.freeze_kind` selects the rules:
//! - 0, a revision 8 freeze: today's rules. The multisig may rule without a
//!   dispute; after `review_deadline_at` the timeout pays the worker.
//! - `FREEZE_KIND_DISPUTABLE`, a revision 9 freeze: `review_deadline_at` is the
//!   end of the dispute window. With no dispute, the buyer is refunded after it.
//!   With a dispute (a live `DisputeBond` at `["dispute_bond", task]`), the
//!   multisig rules until `ruling_deadline`: for the worker it is paid as on
//!   accept and gets its bond back; for the buyer it is refunded and receives the
//!   worker's bond. Not ruled in time: as if no dispute had been filed (the buyer
//!   is refunded, the bond goes back to the worker).
//!
//! Every ruling needs the threshold of owners WITHOUT a stake in it: the creator,
//! the worker wallet and live operator or referrer payees do not count.

use crate::errors::CoordinationError;
use crate::events::{
    rejection_dispute_outcome, RejectFrozenExpired, RejectFrozenResolved, RejectionDisputeSettled,
};
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
use crate::instructions::completion_helpers::{
    build_marketplace_fee_legs, calculate_fee_with_reputation, execute_completion_rewards,
};
use crate::instructions::constants::FREEZE_KIND_DISPUTABLE;
use crate::instructions::creator_stats_helpers::rejection_ruling_record_outcome;
use crate::instructions::dispute_bond_helpers::{
    is_empty_bond_address, load_live_dispute_bond, settle_dispute_bond, BondEnding,
};
use crate::instructions::dispute_helpers::ruling_conflicts;
use crate::instructions::record_account_helpers::{
    count_agent_stats, count_creator_stats, ensure_agent_stats, ensure_creator_stats,
};
use crate::instructions::task_validation_helpers::release_claim_slot;
use crate::state::{
    AgentRegistration, CompletionBond, DisputeBond, ProtocolConfig, SubmissionStatus, Task,
    TaskClaim, TaskEscrow, TaskStatus, TaskSubmission,
};
use crate::utils::multisig::{require_unconflicted_multisig_threshold, unique_account_infos};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

// =============================== resolve_reject_frozen ===============================

#[derive(Accounts)]
pub struct ResolveRejectFrozen<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), claim.worker.as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    #[account(
        mut,
        seeds = [b"task_submission", claim.key().as_ref()],
        bump = task_submission.bump,
        constraint = task_submission.task == task.key() @ CoordinationError::TaskSubmissionRequired
    )]
    pub task_submission: Box<Account<'info, TaskSubmission>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        constraint = worker.key() == claim.worker @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: protocol treasury (protocol fee on a Completed outcome).
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: task creator — escrow refund recipient on Cancelled; validated to task.creator.
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: worker payout + claim-rent recipient; validated to worker.authority.
    #[account(
        mut,
        constraint = worker_authority.key() == worker.authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker_authority: UncheckedAccount<'info>,

    /// CHECK: canonical hire link. Always supplied; direct tasks pass the empty
    /// system-owned PDA. A legacy live record carries fee terms not stamped on Task.
    #[account(
        seeds = [b"hire", task.key().as_ref()],
        bump
    )]
    pub hire_record: UncheckedAccount<'info>,

    /// CHECK: immutable operator payee, validated from Task/HireRecord when completion wins.
    #[account(mut)]
    pub operator: Option<UncheckedAccount<'info>>,

    /// CHECK: immutable referrer payee, validated from Task/HireRecord when completion wins.
    #[account(mut)]
    pub referrer: Option<UncheckedAccount<'info>>,

    /// Multisig review authority; `remaining_accounts` carries the co-signers.
    /// Writable (revision 9): it pays for a missing record.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: creator completion bond PDA — REQUIRED + seeds-fixed so the multisig
    /// cannot omit a live bond to dodge the forfeit (audit). settle no-ops if no bond
    /// was posted (the empty PDA). Forfeits go to `treasury` (== protocol_config.treasury).
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), creator.key().as_ref()],
        bump
    )]
    pub creator_completion_bond: UncheckedAccount<'info>,
    /// CHECK: worker completion bond PDA — REQUIRED + seeds-fixed (same rationale).
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), worker_authority.key().as_ref()],
        bump
    )]
    pub worker_completion_bond: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: revision 9 dispute bond `["dispute_bond", task]`, seeds-pinned here. A
    /// system-owned account with no data means "not disputed" (whatever lamports
    /// it holds); a live bond is validated and settled by `settle_dispute_bond`.
    #[account(mut, seeds = [b"dispute_bond", task.key().as_ref()], bump)]
    pub dispute_bond: UncheckedAccount<'info>,

    /// CHECK: revision 9 worker record `["agent_stats", worker.key()]`, seeds-pinned
    /// here. REQUIRED: the ruling moves `disputes_won` or `disputes_lost`. Created when missing by `ensure_agent_stats`, paid by
    /// `authority`.
    #[account(mut, seeds = [b"agent_stats", worker.key().as_ref()], bump)]
    pub worker_stats: UncheckedAccount<'info>,

    /// CHECK: revision 9 creator record `["creator_stats", task.creator]` (`creator` is constrained
    /// to the task creator),
    /// seeds-pinned here. REQUIRED: the ruling moves the mirror counter. Created when missing by
    /// `ensure_creator_stats`, paid by `authority`.
    #[account(mut, seeds = [b"creator_stats", creator.key().as_ref()], bump)]
    pub creator_stats: UncheckedAccount<'info>,
}

/// Multisig review decision on a frozen task. `approve_completion`:
/// - true  -> the rejection is overturned: pay the worker, refund the worker bond,
///   forfeit the creator bond to treasury; a revision 9 dispute bond goes back to
///   the worker.
/// - false -> the rejection is upheld: refund the creator, forfeit the worker bond to
///   treasury, refund the creator bond; a revision 9 dispute bond's principal goes
///   to the creator (its rent back to the worker).
///
/// Revision 9 (v2 wire): a reasoned ruling (`rationale_hash`, `rationale_uri`), the
/// conflicted-owner threshold, and the freeze rules in the module note.
pub fn resolve_handler(
    ctx: Context<ResolveRejectFrozen>,
    approve_completion: bool,
    rationale_hash: [u8; 32],
    rationale_uri: String,
) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    validate_frozen_rationale(&rationale_hash, &rationale_uri)?;
    // Revision 9: owners with a stake in the ruling (the creator and the worker
    // wallet) do not count toward the threshold. Review R2-1: fee payees do.
    let task_key = ctx.accounts.task.key();
    let conflicted = ruling_conflicts(
        ctx.accounts.task.creator,
        ctx.accounts.worker_authority.key(),
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_unconflicted_multisig_threshold(
        &ctx.accounts.protocol_config,
        &unique_signers,
        &conflicted,
    )?;
    // Exit path: a frozen task must settle even while paused (money never locks).
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;
    // Revision 9: create any missing record first. The create is a CPI, and a CPI
    // made after this handler moves lamports directly fails (UnbalancedInstruction).
    ensure_agent_stats(
        &ctx.accounts.worker_stats.to_account_info(),
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        ctx.accounts.worker.key(),
        ctx.bumps.worker_stats,
    )?;
    ensure_creator_stats(
        &ctx.accounts.creator_stats.to_account_info(),
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        ctx.accounts.creator.key(),
        ctx.bumps.creator_stats,
    )?;

    require!(
        ctx.accounts.task.status == TaskStatus::RejectFrozen,
        CoordinationError::TaskNotRejectFrozen
    );
    // Review R1-7: the rules come from the frozen submission only.
    require_frozen_submission(ctx.accounts.task_submission.status)?;
    // Revision 8 freeze: today's rules. Revision 9 freeze: a ruling needs a filed
    // dispute and must land inside its ruling window.
    let bond_info = ctx.accounts.dispute_bond.to_account_info();
    let rules = freeze_rules(ctx.accounts.task_submission.freeze_kind())?;
    let disputed = !is_empty_bond_address(&bond_info);
    let ruling_deadline = if disputed {
        load_live_dispute_bond(
            &bond_info,
            &task_key,
            &task_key,
            DisputeBond::KIND_REJECTION,
        )?
        .ruling_deadline
    } else {
        0
    };
    validate_frozen_ruling(rules, disputed, clock.unix_timestamp, ruling_deadline)?;

    let creator_info = ctx.accounts.creator.to_account_info();
    let worker_auth_info = ctx.accounts.worker_authority.to_account_info();
    // Forfeits go to the protocol treasury (already validated == protocol_config.treasury).
    let treasury_info = ctx.accounts.treasury.to_account_info();

    if approve_completion {
        // Worker vindicated: pay the worker and every snapshotted marketplace leg.
        let protocol_fee_bps = calculate_fee_with_reputation(
            ctx.accounts.task.protocol_fee_bps,
            ctx.accounts.worker.reputation,
        );
        let (operator_leg, referrer_leg) = build_marketplace_fee_legs(
            ctx.accounts.task.as_ref(),
            task_key,
            &ctx.accounts.hire_record.to_account_info(),
            ctx.accounts
                .operator
                .as_ref()
                .map(|account| account.as_ref()),
            ctx.accounts
                .referrer
                .as_ref()
                .map(|account| account.as_ref()),
        )?;
        ctx.accounts.claim.proof_hash = ctx.accounts.task_submission.proof_hash;
        ctx.accounts.claim.result_data = ctx.accounts.task_submission.result_data;
        ctx.accounts.claim.is_completed = true;
        ctx.accounts.claim.is_validated = true;
        ctx.accounts.claim.completed_at = clock.unix_timestamp;

        execute_completion_rewards(
            &mut ctx.accounts.task,
            &mut ctx.accounts.claim,
            &mut ctx.accounts.escrow,
            &mut ctx.accounts.worker,
            &mut ctx.accounts.protocol_config,
            &worker_auth_info,
            &ctx.accounts.treasury.to_account_info(),
            &creator_info,
            protocol_fee_bps,
            None,
            Some(ctx.accounts.task_submission.result_data),
            &clock,
            None,
            operator_leg,
            referrer_leg,
        )?;

        ctx.accounts.task_submission.status = SubmissionStatus::Accepted;
        ctx.accounts.task_submission.accepted_at = clock.unix_timestamp;

        // Worker vindicated: refund the worker bond, forfeit the creator bond to
        // treasury. Bonds are required+seeds-fixed, so the multisig cannot omit them
        // to dodge the forfeit; settle no-ops when no bond was posted.
        settle_completion_bond(
            &ctx.accounts.worker_completion_bond.to_account_info(),
            &worker_auth_info,
            &task_key,
            CompletionBond::ROLE_WORKER,
            BondDisposition::Refund,
        )?;
        settle_completion_bond(
            &ctx.accounts.creator_completion_bond.to_account_info(),
            &creator_info,
            &task_key,
            CompletionBond::ROLE_CREATOR,
            BondDisposition::Forfeit {
                recipient: &treasury_info,
            },
        )?;

        emit!(RejectFrozenResolved {
            task: task_key,
            outcome: 1,
            timestamp: clock.unix_timestamp,
        });
    } else {
        // Rejection upheld: refund the creator the full escrow; the worker forfeits.
        ctx.accounts.task.status = TaskStatus::Cancelled;

        // Release the worker's claim slot. The approve branch gets this via
        // execute_completion_rewards (update_task_state + update_worker_state); the
        // uphold branch settles manually, so without this call task.current_workers
        // stays > 0 (permanently unclosable task — close_task requires 0) and
        // worker.active_tasks stays inflated (blocks future claims at MAX_ACTIVE_TASKS
        // and blocks deregister_agent, which requires active_tasks == 0, locking the
        // worker's registration stake). Mirrors reject_task_result / resolve_dispute.
        release_claim_slot(
            &mut ctx.accounts.task,
            &mut ctx.accounts.worker,
            clock.unix_timestamp,
        )?;

        // Rejection upheld: forfeit the worker bond to treasury, refund the creator bond.
        settle_completion_bond(
            &ctx.accounts.worker_completion_bond.to_account_info(),
            &worker_auth_info,
            &task_key,
            CompletionBond::ROLE_WORKER,
            BondDisposition::Forfeit {
                recipient: &treasury_info,
            },
        )?;
        settle_completion_bond(
            &ctx.accounts.creator_completion_bond.to_account_info(),
            &creator_info,
            &task_key,
            CompletionBond::ROLE_CREATOR,
            BondDisposition::Refund,
        )?;

        // Close the escrow to the creator — refunds the full reward + rent.
        ctx.accounts.escrow.is_closed = true;
        ctx.accounts.escrow.close(creator_info.clone())?;

        emit!(RejectFrozenResolved {
            task: task_key,
            outcome: 0,
            timestamp: clock.unix_timestamp,
        });
    }

    // Revision 9 (B): the dispute bond follows the ruling: back to the worker when
    // the completion is approved; its principal to the creator when the rejection
    // is upheld (the rent always back to the worker). No bond (a revision 8 freeze)
    // moves nothing.
    let bond = settle_dispute_bond(
        &bond_info,
        &task_key,
        &task_key,
        DisputeBond::KIND_REJECTION,
        &worker_auth_info,
        &creator_info,
        if approve_completion {
            BondEnding::FilerUpheld
        } else {
            BondEnding::FilerRejected
        },
        clock.unix_timestamp,
    )?;
    // Review R1-10 (a): the event reports how a dispute of a revision 9 freeze
    // ended; a revision 8 freeze has none (`expire_reject_frozen` agrees).
    if rules == FreezeRules::Revision9 {
        emit!(RejectionDisputeSettled {
            task: task_key,
            outcome: if approve_completion {
                rejection_dispute_outcome::PAID_BY_RULING
            } else {
                rejection_dispute_outcome::REFUNDED_BY_RULING
            },
            bond_amount: bond.amount,
            bond_recipient: bond.principal_recipient,
            resolved_by: ctx.accounts.authority.key(),
            rationale_hash,
            timestamp: clock.unix_timestamp,
        });
    }

    // Revision 9 (E): a ruling on a freeze is recorded on both sides: approving
    // the completion is a worker win and a creator loss, upholding the rejection
    // the reverse.
    let record_outcome = rejection_ruling_record_outcome(approve_completion);
    count_agent_stats(
        &ctx.accounts.worker_stats.to_account_info(),
        ctx.accounts.worker.key(),
        record_outcome.worker_counter(),
        clock.unix_timestamp,
    )?;
    count_creator_stats(
        &ctx.accounts.creator_stats.to_account_info(),
        ctx.accounts.creator.key(),
        record_outcome.creator_counter(),
        clock.unix_timestamp,
    )?;

    // Return both worker-funded lifecycle accounts. The task is terminal on
    // either branch, so leaving the submission alive would strand its rent and
    // force creator cooperation through a later cleanup instruction.
    ctx.accounts.claim.close(worker_auth_info.clone())?;
    ctx.accounts.task_submission.close(worker_auth_info)?;

    Ok(())
}

// =============================== expire_reject_frozen ===============================

#[derive(Accounts)]
pub struct ExpireRejectFrozen<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), claim.worker.as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    #[account(
        mut,
        seeds = [b"task_submission", claim.key().as_ref()],
        bump = task_submission.bump,
        constraint = task_submission.task == task.key() @ CoordinationError::TaskSubmissionRequired
    )]
    pub task_submission: Box<Account<'info, TaskSubmission>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        constraint = worker.key() == claim.worker @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: protocol treasury (protocol fee on the default worker payout).
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: task creator (escrow close residual / rent); validated to task.creator.
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: worker payout + claim-rent recipient; validated to worker.authority.
    #[account(
        mut,
        constraint = worker_authority.key() == worker.authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker_authority: UncheckedAccount<'info>,

    /// CHECK: canonical hire link. Always supplied; direct tasks pass the empty
    /// system-owned PDA. A legacy live record carries fee terms not stamped on Task.
    #[account(
        seeds = [b"hire", task.key().as_ref()],
        bump
    )]
    pub hire_record: UncheckedAccount<'info>,

    /// CHECK: immutable operator payee, validated from Task/HireRecord.
    #[account(mut)]
    pub operator: Option<UncheckedAccount<'info>>,

    /// CHECK: immutable referrer payee, validated from Task/HireRecord.
    #[account(mut)]
    pub referrer: Option<UncheckedAccount<'info>>,

    /// Permissionless caller. Writable (revision 9): it pays for a missing record.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: creator completion bond PDA — REQUIRED + seeds-pinned (audit F5/F12):
    /// refunded on this no-fault timeout exit. Making it omittable would let a caller
    /// strand a live bond into the terminal task, where reclaim_completion_bond can
    /// never reach it once the Task PDA is closed. Pass the derived PDA even for an
    /// un-bonded task (empty system account); settle_completion_bond no-ops on it.
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), creator.key().as_ref()],
        bump
    )]
    pub creator_completion_bond: UncheckedAccount<'info>,
    /// CHECK: worker completion bond PDA — REQUIRED + seeds-pinned to the validated
    /// worker authority (audit F5/F12); refunded on this no-fault exit.
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), worker_authority.key().as_ref()],
        bump
    )]
    pub worker_completion_bond: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: revision 9 dispute bond `["dispute_bond", task]`, seeds-pinned here. A
    /// system-owned account with no data means "not disputed" (whatever lamports
    /// it holds); a live bond is validated and settled by `settle_dispute_bond`.
    #[account(mut, seeds = [b"dispute_bond", task.key().as_ref()], bump)]
    pub dispute_bond: UncheckedAccount<'info>,

    /// CHECK: revision 9 worker record `["agent_stats", worker.key()]`, seeds-pinned
    /// here. REQUIRED: no counter moves (the freeze counted the rejection). Created when missing by `ensure_agent_stats`, paid by
    /// `authority`.
    #[account(mut, seeds = [b"agent_stats", worker.key().as_ref()], bump)]
    pub worker_stats: UncheckedAccount<'info>,

    /// CHECK: revision 9 creator record `["creator_stats", task.creator]` (`creator` is constrained
    /// to the task creator),
    /// seeds-pinned here. REQUIRED: no counter moves (the freeze counted the rejection). Created when missing by
    /// `ensure_creator_stats`, paid by `authority`.
    #[account(mut, seeds = [b"creator_stats", creator.key().as_ref()], bump)]
    pub creator_stats: UncheckedAccount<'info>,
}

/// Permissionless timeout (no completion bond is forfeited: no fault was found).
/// - Revision 8 freeze: after `review_deadline_at` it defaults to the WORKER (the
///   creator failed to adjudicate): pays the worker and refunds both bonds.
/// - Revision 9 freeze, not disputed: after the dispute window the BUYER is
///   refunded (price and escrow rent) and both completion bonds are refunded; the
///   worker gets its claim and submission rent back and is not paid.
/// - Revision 9 freeze, disputed but not ruled by `ruling_deadline`: the outcome of
///   `unruled_rejection_dispute_outcome` (the buyer is refunded), and the dispute
///   bond goes back to the worker, principal and rent.
pub fn expire_handler(ctx: Context<ExpireRejectFrozen>) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::InvalidInput
    );
    // Exit path: must settle even while paused.
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;
    // Revision 9: create any missing record first. The create is a CPI, and a CPI
    // made after this handler moves lamports directly fails (UnbalancedInstruction).
    // No counter moves on an expiry: the freeze counted the rejection.
    ensure_agent_stats(
        &ctx.accounts.worker_stats.to_account_info(),
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        ctx.accounts.worker.key(),
        ctx.bumps.worker_stats,
    )?;
    ensure_creator_stats(
        &ctx.accounts.creator_stats.to_account_info(),
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        ctx.accounts.creator.key(),
        ctx.bumps.creator_stats,
    )?;

    require!(
        ctx.accounts.task.status == TaskStatus::RejectFrozen,
        CoordinationError::TaskNotRejectFrozen
    );
    // Review R1-7: the rules come from the frozen submission only.
    require_frozen_submission(ctx.accounts.task_submission.status)?;

    let task_key = ctx.accounts.task.key();
    let worker_auth_info = ctx.accounts.worker_authority.to_account_info();
    let creator_info = ctx.accounts.creator.to_account_info();
    let bond_info = ctx.accounts.dispute_bond.to_account_info();
    let rules = freeze_rules(ctx.accounts.task_submission.freeze_kind())?;
    let disputed = !is_empty_bond_address(&bond_info);
    let ruling_deadline = if disputed {
        load_live_dispute_bond(
            &bond_info,
            &task_key,
            &task_key,
            DisputeBond::KIND_REJECTION,
        )?
        .ruling_deadline
    } else {
        0
    };
    let outcome = frozen_expiry_outcome(
        rules,
        disputed,
        clock.unix_timestamp,
        ctx.accounts.task_submission.review_deadline_at,
        ruling_deadline,
    )?;

    let worker_payout = match outcome {
        FrozenExpiryOutcome::PayWorker => {
            let protocol_fee_bps = calculate_fee_with_reputation(
                ctx.accounts.task.protocol_fee_bps,
                ctx.accounts.worker.reputation,
            );
            let (operator_leg, referrer_leg) = build_marketplace_fee_legs(
                ctx.accounts.task.as_ref(),
                task_key,
                &ctx.accounts.hire_record.to_account_info(),
                ctx.accounts
                    .operator
                    .as_ref()
                    .map(|account| account.as_ref()),
                ctx.accounts
                    .referrer
                    .as_ref()
                    .map(|account| account.as_ref()),
            )?;
            ctx.accounts.claim.proof_hash = ctx.accounts.task_submission.proof_hash;
            ctx.accounts.claim.result_data = ctx.accounts.task_submission.result_data;
            ctx.accounts.claim.is_completed = true;
            ctx.accounts.claim.is_validated = true;
            ctx.accounts.claim.completed_at = clock.unix_timestamp;

            execute_completion_rewards(
                &mut ctx.accounts.task,
                &mut ctx.accounts.claim,
                &mut ctx.accounts.escrow,
                &mut ctx.accounts.worker,
                &mut ctx.accounts.protocol_config,
                &worker_auth_info,
                &ctx.accounts.treasury.to_account_info(),
                &creator_info,
                protocol_fee_bps,
                None,
                Some(ctx.accounts.task_submission.result_data),
                &clock,
                None,
                operator_leg,
                referrer_leg,
            )?;

            ctx.accounts.task_submission.status = SubmissionStatus::Accepted;
            ctx.accounts.task_submission.accepted_at = clock.unix_timestamp;
            // Report the ACTUAL lamports paid to the worker (reward minus protocol fee),
            // not the gross escrow; execute_completion_rewards records it on the claim.
            ctx.accounts.claim.reward_paid
        }
        FrozenExpiryOutcome::RefundBuyer => {
            // The uphold money path without its forfeits: cancel, release the claim
            // slot (as resolve_reject_frozen's uphold branch does) and close the
            // escrow to the creator (price and rent). The worker is paid nothing.
            ctx.accounts.task.status = TaskStatus::Cancelled;
            release_claim_slot(
                &mut ctx.accounts.task,
                &mut ctx.accounts.worker,
                clock.unix_timestamp,
            )?;
            ctx.accounts.escrow.is_closed = true;
            ctx.accounts.escrow.close(creator_info.clone())?;
            0
        }
    };

    // No fault on a timeout: refund BOTH completion bonds to their posters.
    // Required + seeds-pinned accounts (audit F5/F12), so this ALWAYS runs and a
    // live bond can never survive into the terminal task; settle no-ops on an
    // un-bonded task's empty PDA.
    settle_completion_bond(
        &ctx.accounts.worker_completion_bond.to_account_info(),
        &worker_auth_info,
        &task_key,
        CompletionBond::ROLE_WORKER,
        BondDisposition::Refund,
    )?;
    settle_completion_bond(
        &ctx.accounts.creator_completion_bond.to_account_info(),
        &creator_info,
        &task_key,
        CompletionBond::ROLE_CREATOR,
        BondDisposition::Refund,
    )?;

    // Revision 9 (B): a dispute left unruled returns the bond to the worker,
    // principal and rent. No bond moves nothing.
    let bond = settle_dispute_bond(
        &bond_info,
        &task_key,
        &task_key,
        DisputeBond::KIND_REJECTION,
        &worker_auth_info,
        &creator_info,
        BondEnding::Unruled,
        clock.unix_timestamp,
    )?;

    ctx.accounts.claim.close(worker_auth_info.clone())?;
    ctx.accounts.task_submission.close(worker_auth_info)?;

    emit!(RejectFrozenExpired {
        task: task_key,
        worker_payout,
        timestamp: clock.unix_timestamp,
    });
    if rules == FreezeRules::Revision9 {
        emit!(RejectionDisputeSettled {
            task: task_key,
            outcome: if disputed {
                rejection_dispute_outcome::REFUNDED_UNRULED
            } else {
                rejection_dispute_outcome::REFUNDED_UNDISPUTED
            },
            bond_amount: bond.amount,
            bond_recipient: bond.principal_recipient,
            resolved_by: Pubkey::default(),
            rationale_hash: [0u8; 32],
            timestamp: clock.unix_timestamp,
        });
    }

    Ok(())
}

// ============================ revision 9 freeze rules (pure) ============================

/// Longest `rationale_uri` a frozen-task ruling takes: 128 bytes keeps the v2
/// transaction under the 1,232-byte limit with all of its accounts.
pub const MAX_FROZEN_RATIONALE_URI_LEN: usize = 128;

/// A ruling must carry a non-zero rationale hash (as `resolve_dispute` requires)
/// and a bounded pointer (empty allowed).
pub(crate) fn validate_frozen_rationale(
    rationale_hash: &[u8; 32],
    rationale_uri: &str,
) -> Result<()> {
    require!(
        rationale_hash.iter().any(|byte| *byte != 0),
        CoordinationError::InvalidRationaleHash
    );
    require!(
        rationale_uri.len() <= MAX_FROZEN_RATIONALE_URI_LEN,
        CoordinationError::RationaleUriTooLong
    );
    Ok(())
}

/// Which rules a freeze follows, from `TaskSubmission.freeze_kind`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FreezeRules {
    /// A freeze made before revision 9 (the byte reads 0).
    Revision8,
    /// A disputable revision 9 freeze.
    Revision9,
}

/// Review R1-7: both exits take the freeze's rules (`freeze_kind`) and its
/// payout from the submission they are given, so they accept only the frozen
/// one, which `reject_and_freeze` left Rejected. Another live claim's submission
/// on the same task (Submitted, say) is refused.
pub(crate) fn require_frozen_submission(status: SubmissionStatus) -> Result<()> {
    require!(
        status == SubmissionStatus::Rejected,
        CoordinationError::TaskSubmissionRequired
    );
    Ok(())
}

pub(crate) fn freeze_rules(freeze_kind: u8) -> Result<FreezeRules> {
    match freeze_kind {
        0 => Ok(FreezeRules::Revision8),
        FREEZE_KIND_DISPUTABLE => Ok(FreezeRules::Revision9),
        _ => err!(CoordinationError::CorruptedData),
    }
}

/// The worker may dispute a revision 9 freeze while `now <= dispute_deadline`
/// (`TaskSubmission.review_deadline_at`). The undisputed refund needs the
/// complement, so on one cluster clock the two can never both succeed.
pub(crate) fn rejection_dispute_window_open(now: i64, dispute_deadline: i64) -> bool {
    now <= dispute_deadline
}

/// The multisig may rule on a disputed revision 9 freeze while
/// `now <= ruling_deadline`. The unruled refund needs the complement.
pub(crate) fn rejection_ruling_window_open(now: i64, ruling_deadline: i64) -> bool {
    now <= ruling_deadline
}

/// What a multisig ruling on a frozen task needs: nothing more for a revision 8
/// freeze (which can never carry a bond); a filed dispute and an open ruling
/// window for a revision 9 freeze.
pub(crate) fn validate_frozen_ruling(
    rules: FreezeRules,
    disputed: bool,
    now: i64,
    ruling_deadline: i64,
) -> Result<()> {
    match rules {
        FreezeRules::Revision8 => {
            require!(!disputed, CoordinationError::InvalidDisputeBond);
        }
        FreezeRules::Revision9 => {
            require!(disputed, CoordinationError::RejectionDisputeRequired);
            require!(
                rejection_ruling_window_open(now, ruling_deadline),
                CoordinationError::RulingWindowClosed
            );
        }
    }
    Ok(())
}

/// The money outcome of `expire_reject_frozen`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FrozenExpiryOutcome {
    /// Pay the worker as on accept (fee and legs).
    PayWorker,
    /// Refund the buyer the price and escrow rent.
    RefundBuyer,
}

/// Owner decision (design question 3, 2026-11-20): a disputed revision 9 freeze
/// that is not ruled in time ends as if no dispute had been filed: the buyer is
/// refunded, and `expire_reject_frozen` returns the worker's bond. This is the one
/// place that decides it.
pub(crate) fn unruled_rejection_dispute_outcome() -> FrozenExpiryOutcome {
    FrozenExpiryOutcome::RefundBuyer
}

/// When `expire_reject_frozen` may run and what it does.
pub(crate) fn frozen_expiry_outcome(
    rules: FreezeRules,
    disputed: bool,
    now: i64,
    review_deadline_at: i64,
    ruling_deadline: i64,
) -> Result<FrozenExpiryOutcome> {
    match rules {
        FreezeRules::Revision8 => {
            require!(!disputed, CoordinationError::InvalidDisputeBond);
            require!(
                now > review_deadline_at,
                CoordinationError::RejectFrozenTimeoutNotElapsed
            );
            Ok(FrozenExpiryOutcome::PayWorker)
        }
        FreezeRules::Revision9 if disputed => {
            require!(
                !rejection_ruling_window_open(now, ruling_deadline),
                CoordinationError::RejectionWindowStillOpen
            );
            Ok(unruled_rejection_dispute_outcome())
        }
        FreezeRules::Revision9 => {
            require!(
                !rejection_dispute_window_open(now, review_deadline_at),
                CoordinationError::RejectionWindowStillOpen
            );
            Ok(FrozenExpiryOutcome::RefundBuyer)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code<T: core::fmt::Debug>(result: Result<T>) -> u32 {
        match result {
            Err(anchor_lang::error::Error::AnchorError(e)) => e.error_code_number,
            other => panic!("expected an AnchorError, got {other:?}"),
        }
    }

    // Design 11.1 / lead check 4: window predicates at deadline - 1, deadline and
    // deadline + 1. Filing and ruling are inclusive at the deadline; both refunds
    // need the next second, so a filing (or ruling) and a refund never both pass.
    #[test]
    fn rejection_windows_are_disjoint_at_the_edges() {
        let d = 1_700_259_200;
        assert!(rejection_dispute_window_open(d - 1, d));
        assert!(rejection_dispute_window_open(d, d));
        assert!(!rejection_dispute_window_open(d + 1, d));
        assert!(rejection_ruling_window_open(d - 1, d));
        assert!(rejection_ruling_window_open(d, d));
        assert!(!rejection_ruling_window_open(d + 1, d));

        let r9 = FreezeRules::Revision9;
        // Undisputed refund: closed at d - 1 and d, open at d + 1.
        for now in [d - 1, d] {
            assert_eq!(
                code(frozen_expiry_outcome(r9, false, now, d, 0)),
                u32::from(CoordinationError::RejectionWindowStillOpen)
            );
        }
        assert_eq!(
            frozen_expiry_outcome(r9, false, d + 1, d, 0).unwrap(),
            FrozenExpiryOutcome::RefundBuyer
        );
        // Unruled refund: keyed to the ruling deadline, not the dispute deadline.
        let ruling = d + 259_200;
        for now in [ruling - 1, ruling] {
            assert_eq!(
                code(frozen_expiry_outcome(r9, true, now, d, ruling)),
                u32::from(CoordinationError::RejectionWindowStillOpen)
            );
        }
        assert_eq!(
            frozen_expiry_outcome(r9, true, ruling + 1, d, ruling).unwrap(),
            FrozenExpiryOutcome::RefundBuyer
        );
        // Ruling: allowed through the deadline, refused one second after.
        assert!(validate_frozen_ruling(r9, true, ruling - 1, ruling).is_ok());
        assert!(validate_frozen_ruling(r9, true, ruling, ruling).is_ok());
        assert_eq!(
            code(validate_frozen_ruling(r9, true, ruling + 1, ruling)),
            u32::from(CoordinationError::RulingWindowClosed)
        );
    }

    // Lead check 5: revision 8 versus revision 9 selection in both exits.
    #[test]
    fn revision_8_freezes_keep_revision_8_rules() {
        assert_eq!(freeze_rules(0).unwrap(), FreezeRules::Revision8);
        assert_eq!(freeze_rules(1).unwrap(), FreezeRules::Revision9);
        assert_eq!(
            code(freeze_rules(2)),
            u32::from(CoordinationError::CorruptedData)
        );
        let r8 = FreezeRules::Revision8;
        let d = 1_700_000_100;
        // Revision 8 timeout pays the worker after the review deadline.
        assert_eq!(
            code(frozen_expiry_outcome(r8, false, d, d, 0)),
            u32::from(CoordinationError::RejectFrozenTimeoutNotElapsed)
        );
        assert_eq!(
            frozen_expiry_outcome(r8, false, d + 1, d, 0).unwrap(),
            FrozenExpiryOutcome::PayWorker
        );
        // Revision 8: the multisig may rule with no dispute, at any time.
        assert!(validate_frozen_ruling(r8, false, d + 999_999, 0).is_ok());
        // A revision 8 freeze can never carry a bond; one would fail closed.
        assert_eq!(
            code(validate_frozen_ruling(r8, true, d, 0)),
            u32::from(CoordinationError::InvalidDisputeBond)
        );
        // Revision 9: no ruling without a dispute.
        assert_eq!(
            code(validate_frozen_ruling(FreezeRules::Revision9, false, d, 0)),
            u32::from(CoordinationError::RejectionDisputeRequired)
        );
    }

    // Owner decision (design question 3): an unruled dispute refunds the buyer.
    #[test]
    fn an_unruled_dispute_refunds_the_buyer() {
        assert_eq!(
            unruled_rejection_dispute_outcome(),
            FrozenExpiryOutcome::RefundBuyer
        );
    }

    #[test]
    fn frozen_rationale_is_required_and_bounded() {
        assert_eq!(
            code(validate_frozen_rationale(&[0u8; 32], "")),
            u32::from(CoordinationError::InvalidRationaleHash)
        );
        assert!(validate_frozen_rationale(&[1u8; 32], "").is_ok());
        let max = "a".repeat(MAX_FROZEN_RATIONALE_URI_LEN);
        assert!(validate_frozen_rationale(&[1u8; 32], &max).is_ok());
        let over = "a".repeat(MAX_FROZEN_RATIONALE_URI_LEN + 1);
        assert_eq!(
            code(validate_frozen_rationale(&[1u8; 32], &over)),
            u32::from(CoordinationError::RationaleUriTooLong)
        );
    }

    // Review R1-7: only the frozen (Rejected) submission selects the rules.
    #[test]
    fn only_the_frozen_submission_is_accepted() {
        assert!(require_frozen_submission(SubmissionStatus::Rejected).is_ok());
        for status in [
            SubmissionStatus::Idle,
            SubmissionStatus::Submitted,
            SubmissionStatus::Accepted,
        ] {
            assert_eq!(
                code(require_frozen_submission(status)),
                u32::from(CoordinationError::TaskSubmissionRequired)
            );
        }
    }
}
