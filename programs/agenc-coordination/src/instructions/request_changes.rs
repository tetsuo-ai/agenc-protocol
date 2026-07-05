//! Request free, non-terminal revisions on a submitted result (Batch 3 §8).
//!
//! Unlike `reject_task_result` (which reopens the slot and closes the claim, forcing
//! a re-claim) and `reject_and_freeze` (terminal -> RejectFrozen), this keeps the
//! worker's claim OPEN and bounces the submission back for a fresh `submit_task_result`
//! in place. Bounded by `MAX_REVISION_ROUNDS` so a creator cannot grief a worker with
//! endless free revisions — past the cap they must accept, reject-and-freeze, or the
//! worker can let the review window lapse.

use crate::errors::CoordinationError;
use crate::events::TaskChangesRequested;
use crate::instructions::task_validation_helpers::{
    decrement_pending_submission_count, ensure_validation_config, ensure_validation_mode,
    is_manual_validation_task,
    note_submission_left_review,
};
use crate::state::{
    ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskStatus, TaskSubmission,
    TaskValidationConfig, ValidationMode, HASH_SIZE, RESULT_DATA_SIZE,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

/// Max submissions per claim before free revisions stop (1 initial + revisions).
pub const MAX_REVISION_ROUNDS: u16 = 3;

#[derive(Accounts)]
pub struct RequestChanges<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
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
}

pub fn handler(ctx: Context<RequestChanges>, changes_hash: [u8; HASH_SIZE]) -> Result<()> {
    // Review decision on an in-flight task; allowed while paused (entry-gated only).
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;

    require!(
        ctx.accounts.task.status == TaskStatus::PendingValidation,
        CoordinationError::TaskNotPendingValidation
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
    // Batch 3 WS-CONTEST: revision rounds are an Exclusive-review concept. On a
    // contest they would let the creator EXTEND task.deadline (below), sliding
    // `ghost_at` outward indefinitely and defeating the ghost-split guarantee, and
    // they stomp the shared task status while other entries are pending. Contest
    // entries settle only via reject / accept / distribute_ghost_share.
    require!(
        !ctx.accounts.task.is_contest_task(),
        CoordinationError::ContestFlowUnsupported
    );
    require!(
        changes_hash != [0u8; HASH_SIZE],
        CoordinationError::InvalidEvidenceHash
    );
    // Bounded free revisions: submission_count is incremented by each submit, so the
    // Nth review request is allowed only while the worker has rounds left.
    require!(
        ctx.accounts.task_submission.submission_count < MAX_REVISION_ROUNDS,
        CoordinationError::MaxRevisionRoundsExceeded
    );

    // Guarantee a change-requested worker a fair resubmit window (audit #70).
    // submit_task_result blocks once now > task.deadline or now > claim.expires_at,
    // so a creator who requests changes near the deadline would otherwise strand
    // the worker, then cancel the task as a "no-show" (cancel_task allows an
    // InProgress, past-deadline, zero-completion task) and forfeit the worker's
    // completion bond — stealing the bond of someone who actually delivered work.
    // Extend both bounds to at least now + the review window so the worker always
    // has time to resubmit before the task can become no-show-cancellable. Read the
    // window before borrowing claim/task mutably below.
    let resubmit_window = ctx
        .accounts
        .task_validation_config
        .review_window_secs
        .max(0);
    let min_resubmit_deadline = clock
        .unix_timestamp
        .checked_add(resubmit_window)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Bounce the submission back for an in-place resubmit; the claim stays OPEN and the
    // worker remains engaged (no slot release, no claim close).
    let claim = &mut ctx.accounts.claim;
    let claim_key = claim.key();
    let worker_key = claim.worker;
    claim.proof_hash = [0u8; HASH_SIZE];
    claim.result_data = [0u8; RESULT_DATA_SIZE];
    claim.is_completed = false;
    claim.is_validated = false;
    claim.completed_at = 0;
    // Keep the claim alive long enough for the resubmit (see #70 note above).
    if claim.expires_at > 0 && claim.expires_at < min_resubmit_deadline {
        claim.expires_at = min_resubmit_deadline;
    }

    decrement_pending_submission_count(&mut ctx.accounts.task_validation_config)?;
    note_submission_left_review(&mut ctx.accounts.task)?;

    let submission = &mut ctx.accounts.task_submission;
    submission.status = SubmissionStatus::Rejected; // resubmittable per submit_task_result
    submission.accepted_at = 0;
    submission.rejected_at = clock.unix_timestamp;
    submission.rejection_hash = changes_hash;
    let round = submission.submission_count;

    // Back to active so the worker resubmits in place (claim retained).
    let task = &mut ctx.accounts.task;
    task.status = TaskStatus::InProgress;
    // Push the task deadline out far enough that the worker can resubmit before the
    // task is no-show-cancellable (see #70 note above). A task with no deadline
    // (deadline == 0) is unaffected.
    if task.deadline > 0 && task.deadline < min_resubmit_deadline {
        task.deadline = min_resubmit_deadline;
    }

    emit!(TaskChangesRequested {
        task: task.key(),
        claim: claim_key,
        worker: worker_key,
        round,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
