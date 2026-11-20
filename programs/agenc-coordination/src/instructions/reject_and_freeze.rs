//! Terminally reject a submission and FREEZE the task for review (Batch 3 §8).
//!
//! Unlike `reject_task_result` (reopen for re-work) and `request_changes` (free
//! in-place revision), this is the escalation: the task moves to `RejectFrozen` and
//! settles ONLY via `resolve_reject_frozen` (multisig review decision) or
//! `expire_reject_frozen` (permissionless timeout that defaults to the worker). The
//! worker's claim and any completion bonds are RETAINED untouched — the frozen exit
//! pays the worker / disposes the bonds. No funds move here.

use crate::errors::CoordinationError;
use crate::events::TaskRejectFrozen;
use crate::instructions::agent_stats_helpers::Counter;
use crate::instructions::creator_stats_helpers::CreatorCounter;
use crate::instructions::record_account_helpers::{
    count_agent_stats, count_creator_stats, ensure_agent_stats, ensure_creator_stats,
};
use crate::instructions::task_validation_helpers::{
    decrement_pending_submission_count, ensure_validation_config, ensure_validation_mode,
    is_manual_validation_task, note_submission_left_review,
};
use crate::state::{
    ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskStatus, TaskSubmission, TaskType,
    TaskValidationConfig, ValidationMode, HASH_SIZE,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RejectAndFreeze<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        seeds = [b"claim", task.key().as_ref(), claim.worker.as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        mut,
        seeds = [b"task_validation", task.key().as_ref()],
        bump = task_validation_config.bump
    )]
    pub task_validation_config: Box<Account<'info, TaskValidationConfig>>,

    #[account(
        mut,
        seeds = [b"task_submission", claim.key().as_ref()],
        bump = task_submission.bump,
        constraint = task_submission.task == task.key() @ CoordinationError::TaskSubmissionRequired,
        constraint = task_submission.claim == claim.key() @ CoordinationError::TaskSubmissionRequired
    )]
    pub task_submission: Box<Account<'info, TaskSubmission>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    // P6.6 made this record optional; revision 9 requires it. The claim's worker
    // is the worker AgentRegistration PDA.
    /// CHECK: revision 9 worker record `["agent_stats", claim.worker]`, seeds-pinned
    /// here. REQUIRED: this freeze bumps `tasks_rejected`. Created when missing by `ensure_agent_stats`, paid by
    /// `creator`.
    #[account(mut, seeds = [b"agent_stats", claim.worker.as_ref()], bump)]
    pub agent_stats: UncheckedAccount<'info>,

    /// Required with the records (revision 9; optional before).
    pub system_program: Program<'info, System>,

    /// CHECK: revision 9 creator record `["creator_stats", task.creator]` (the task constraint makes
    /// `creator` the task creator),
    /// seeds-pinned here. REQUIRED: this freeze bumps `rejections`. Created when missing by
    /// `ensure_creator_stats`, paid by `creator`.
    #[account(mut, seeds = [b"creator_stats", creator.key().as_ref()], bump)]
    pub creator_stats: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<RejectAndFreeze>, rejection_hash: [u8; HASH_SIZE]) -> Result<()> {
    // Review decision on an escrowed task; allowed while paused (entry-gated only).
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;
    // Revision 9: create any missing record first. The create is a CPI, and a CPI
    // made after this handler moves lamports directly fails (UnbalancedInstruction).
    ensure_agent_stats(
        &ctx.accounts.agent_stats.to_account_info(),
        &ctx.accounts.creator.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        ctx.accounts.claim.worker,
        ctx.bumps.agent_stats,
    )?;
    ensure_creator_stats(
        &ctx.accounts.creator_stats.to_account_info(),
        &ctx.accounts.creator.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        ctx.accounts.creator.key(),
        ctx.bumps.creator_stats,
    )?;

    require!(
        ctx.accounts.task.status == TaskStatus::PendingValidation,
        CoordinationError::TaskNotPendingValidation
    );
    // Single-worker only: a Collaborative task escrows the FULL reward but the frozen
    // exits pay one worker's reward/required_completions share, which would strand the
    // remainder forever. Freezing is Exclusive-only (matches the bond v1 guard); a
    // Collaborative creator rejects via reject_task_result (reopen) instead. (audit fix)
    require!(
        ctx.accounts.task.task_type == TaskType::Exclusive,
        CoordinationError::RejectFrozenSingleWorkerOnly
    );
    // Audit F-7: SOL-only v1. Both frozen exits settle through
    // execute_completion_rewards' lamport path, which can never succeed against a
    // rent-only escrow PDA holding token-denominated accounting — one freeze on an
    // SPL task would lock 100% of the token escrow permanently. The same guard
    // already exists on contests, bonds, and ghost-split; this path was missed.
    require!(
        ctx.accounts.task.reward_mint.is_none(),
        CoordinationError::RejectFrozenSolOnly
    );
    require!(
        is_manual_validation_task(&ctx.accounts.task),
        CoordinationError::TaskValidationConfigRequired
    );
    ensure_validation_config(
        &ctx.accounts.task_validation_config,
        &ctx.accounts.task.key(),
        &ctx.accounts.task,
    )?;
    ensure_validation_mode(
        &ctx.accounts.task_validation_config,
        ValidationMode::CreatorReview,
    )?;
    require!(
        ctx.accounts.task_submission.status == SubmissionStatus::Submitted,
        CoordinationError::SubmissionNotPending
    );
    require!(
        rejection_hash != [0u8; HASH_SIZE],
        CoordinationError::InvalidEvidenceHash
    );
    require!(
        ctx.accounts
            .task
            .status
            .can_transition_to(TaskStatus::RejectFrozen),
        CoordinationError::InvalidStatusTransition
    );

    // Freeze for review. The claim + bonds are RETAINED (no close, no slot release,
    // no payout) — resolve/expire_reject_frozen settle them. The review window starts
    // now; expire_reject_frozen defaults to the worker after review_deadline_at.
    let review_window = ctx.accounts.task_validation_config.review_window_secs;
    let review_deadline_at = clock.unix_timestamp.saturating_add(review_window);

    let submission = &mut ctx.accounts.task_submission;
    submission.status = SubmissionStatus::Rejected;
    submission.accepted_at = 0;
    submission.rejected_at = clock.unix_timestamp;
    submission.rejection_hash = rejection_hash;
    submission.review_deadline_at = review_deadline_at;

    // Moving the submission out of Submitted must decrement the per-task pending counter,
    // exactly like every sibling that leaves Submitted (accept/auto_accept/reject/
    // request_changes/validate_task_result). reject_and_freeze skipped it (audit), so
    // TaskValidationConfig.pending_submission_count permanently overstated live submissions
    // by 1 after any freeze, breaking the "pending == #Submitted" invariant.
    decrement_pending_submission_count(&mut ctx.accounts.task_validation_config)?;

    let task = &mut ctx.accounts.task;
    // Batch 3 WS-CONTEST: keep the Task-level live-submission mirror in lockstep
    // with the pending count (schema-gated no-op for pre-batch-3 tasks). Freezing
    // is Exclusive-only, so a contest can never reach here.
    note_submission_left_review(task)?;
    task.status = TaskStatus::RejectFrozen;

    emit!(TaskRejectFrozen {
        task: task.key(),
        claim: ctx.accounts.claim.key(),
        worker: ctx.accounts.claim.worker,
        rejection_hash,
        review_deadline_at,
        timestamp: clock.unix_timestamp,
    });

    // P6.6 / revision 9: a freeze-for-review is a rejection. Fold it into the
    // worker's `tasks_rejected` and the creator's `rejections`; both records are
    // required accounts.
    let worker_agent_key = ctx.accounts.claim.worker;
    count_agent_stats(
        &ctx.accounts.agent_stats.to_account_info(),
        worker_agent_key,
        Counter::TasksRejected,
        clock.unix_timestamp,
    )?;
    count_creator_stats(
        &ctx.accounts.creator_stats.to_account_info(),
        ctx.accounts.creator.key(),
        CreatorCounter::Rejections,
        clock.unix_timestamp,
    )?;

    Ok(())
}
