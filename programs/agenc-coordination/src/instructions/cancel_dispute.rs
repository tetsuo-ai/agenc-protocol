//! Cancel an active dispute at the initiator's request.
//!
//! This allows dispute initiators to cancel their disputes early if:
//! - They realize they made a mistake
//! - The parties reach an off-chain settlement
//! - Circumstances change making the dispute moot
//!
//! Constraints:
//! - Only the initiator can cancel
//! - Only active disputes can be cancelled
//! - The retired voter-count byte is either historical zero or the current
//!   `0xff` initiator-outcome provenance marker

use crate::errors::CoordinationError;
use crate::events::DisputeCancelled;
use crate::instructions::task_validation_helpers::is_manual_validation_task;
use crate::instructions::validation::validate_account_owner;
use crate::state::{
    AgentRegistration, Dispute, DisputeStatus, ProtocolConfig, Task, TaskStatus,
    TaskValidationConfig,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelDispute<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump,
        constraint = dispute.status == DisputeStatus::Active @ CoordinationError::DisputeNotActive
    )]
    pub dispute: Account<'info, Dispute>,

    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.key() == dispute.task @ CoordinationError::InvalidInput
    )]
    pub task: Account<'info, Task>,

    /// Only the initiator's authority can cancel
    #[account(
        constraint = authority.key() == dispute.initiator_authority @ CoordinationError::UnauthorizedResolver
    )]
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<CancelDispute>) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::UnauthorizedResolver
    );
    // Exit-safety: cancelling a dispute restores the task to a workable state and must
    // remain available while the protocol is paused or a task type is disabled, like
    // every other settlement/restoration path (money never locks). Use the exit gate,
    // not the entry gate (which rejects while paused) + require_task_type_enabled
    // (an entry-only control) the way this path previously did (audit).
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let dispute = &mut ctx.accounts.dispute;
    let task = &mut ctx.accounts.task;
    let clock = Clock::get()?;

    // Fail closed on retired voter-era/corrupt state. Historical disputes keep
    // zero; current disputes carry the initiator-counter provenance sentinel.
    dispute.initiator_outcome_counter_tracked()?;

    // Update dispute status
    dispute.status = DisputeStatus::Cancelled;
    dispute.resolved_at = clock.unix_timestamp;

    // Audit H-1: restore the ACTUAL pre-dispute state instead of hardcoding InProgress.
    // A dispute initiated on a PendingValidation task (a delivered submission under review)
    // was previously stomped to InProgress on cancel, orphaning the live submission —
    // accept/reject require PendingValidation and resubmit is blocked — so the creator
    // (initiate + cancel in one tx) could then no-show-cancel the task for a full escrow
    // refund AND forfeit the worker's completion bond as a fake no-show, stealing the bond
    // of a worker who actually delivered. Dispute initiation leaves the on-Task submission
    // and worker counters intact, so derive the restore status from them: a live submission
    // -> PendingValidation (which also makes the task non-cancellable, closing the theft);
    // else a live worker -> InProgress; else Open. No Dispute-account field / migration.
    if task.status == TaskStatus::Disputed {
        // Schema-aware derivation (H-1 follow-up): a schema-0 (pre-batch-3) task NEVER
        // maintains live_submissions() — it reads 0 forever — so for a legacy
        // manual-validation task the "submission under review" signal comes from the V2
        // pending-submission counter on the TaskValidationConfig instead. The config is
        // passed as an OPTIONAL second remaining account (after the defendant), leaving
        // the instruction's frozen IDL account list unchanged. The counter is written
        // unconditionally by submit_task_result, so it is intact for legacy tasks, and the
        // sentinel constraint_hash is only ever stamped together with the config PDA
        // (configure_task_validation / *_humanless), so it always exists. FAIL CLOSED
        // when the config is required but absent: restoring InProgress here would orphan
        // the live submission and re-open the no-show-cancel bond theft.
        let legacy_pending_submissions = if is_manual_validation_task(task)
            && task.task_schema() < Task::TASK_SCHEMA_CONTEST_AWARE
        {
            let config_info = ctx
                .remaining_accounts
                .get(1)
                .ok_or(CoordinationError::TaskValidationConfigRequired)?;
            validate_account_owner(config_info)?;
            let config_data = config_info.try_borrow_data()?;
            let validation_config = TaskValidationConfig::try_deserialize(&mut &config_data[..])?;
            require!(
                validation_config.task == task.key(),
                CoordinationError::TaskValidationConfigRequired
            );
            drop(config_data);
            Some(validation_config.pending_submission_count())
        } else {
            None
        };
        task.status = restore_status_after_dispute_cancel(
            task.live_submissions(),
            task.current_workers,
            legacy_pending_submissions,
        );
    }

    // Decrement defendant dispute counter (fix #544, #842)
    // remaining_accounts: [0] = dispute.defendant (required); [1] = TaskValidationConfig
    // (optional, required only for schema-0 manual-validation tasks — see H-1 above).
    require!(
        ctx.remaining_accounts.len() == 1 || ctx.remaining_accounts.len() == 2,
        CoordinationError::InvalidInput
    );
    let defendant_info = &ctx.remaining_accounts[0];
    validate_account_owner(defendant_info)?;
    require!(defendant_info.is_writable, CoordinationError::InvalidInput);
    require!(
        defendant_info.key() == dispute.defendant,
        CoordinationError::WorkerNotInDispute
    );

    let mut defendant_data = defendant_info.try_borrow_mut_data()?;
    let mut defendant = AgentRegistration::try_deserialize(&mut &**defendant_data)?;
    // Saturating decrement preserves recoverability for legacy stale counters.
    defendant.disputes_as_defendant = defendant.disputes_as_defendant.saturating_sub(1);
    // Use AnchorSerialize::serialize (Borsh only) — see dispute_helpers.rs comment (fix #960).
    AnchorSerialize::serialize(&defendant, &mut &mut defendant_data[8..])
        .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;

    emit!(DisputeCancelled {
        dispute_id: dispute.dispute_id,
        task: dispute.task,
        initiator: dispute.initiator,
        cancelled_at: clock.unix_timestamp,
    });

    Ok(())
}

/// Audit H-1: derive the task status to restore when a dispute is cancelled, from state
/// that dispute initiation leaves intact. A live submission means the task was under review
/// (PendingValidation) and must be restored there so the delivered work is not orphaned;
/// otherwise a live worker means it was InProgress; otherwise Open. Pure + revert-sensitive.
///
/// `legacy_pending_submissions` carries the schema-0 signal: legacy tasks never maintain
/// `live_submissions()`, so the handler consults the TaskValidationConfig's pending counter
/// for them (Some) and passes None for schema-1 / non-manual tasks.
fn restore_status_after_dispute_cancel(
    live_submissions: u8,
    current_workers: u8,
    legacy_pending_submissions: Option<u16>,
) -> TaskStatus {
    if live_submissions > 0 || legacy_pending_submissions.unwrap_or(0) > 0 {
        TaskStatus::PendingValidation
    } else if current_workers > 0 {
        TaskStatus::InProgress
    } else {
        TaskStatus::Open
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Audit H-1 (revert-sensitive): cancelling a dispute on a task with a live submission
    // must restore PendingValidation, NOT InProgress — restoring InProgress orphans the
    // submission and re-opens the no-show-cancel bond theft. Reverting the helper to a
    // hardcoded InProgress turns the first assert red.
    #[test]
    fn restore_after_dispute_cancel_preserves_review_state() {
        // Live submission under review -> PendingValidation (blocks the no-show-cancel theft).
        assert!(matches!(
            restore_status_after_dispute_cancel(1, 1, None),
            TaskStatus::PendingValidation
        ));
        // No submission, worker still engaged -> InProgress (the original single-worker case).
        assert!(matches!(
            restore_status_after_dispute_cancel(0, 1, None),
            TaskStatus::InProgress
        ));
        // Nothing live -> Open.
        assert!(matches!(
            restore_status_after_dispute_cancel(0, 0, None),
            TaskStatus::Open
        ));
    }

    // H-1 follow-up (revert-sensitive): schema-0 manual-validation tasks derive the
    // under-review signal from the TaskValidationConfig pending counter, not
    // live_submissions() (which legacy tasks never maintain). Dropping the
    // legacy_pending_submissions disjunct turns the first assert red (InProgress would
    // orphan the legacy live submission and re-open the bond theft).
    #[test]
    fn restore_after_dispute_cancel_uses_legacy_pending_counter() {
        // Legacy task with a submission under review (pending == 1) -> PendingValidation.
        assert!(matches!(
            restore_status_after_dispute_cancel(0, 1, Some(1)),
            TaskStatus::PendingValidation
        ));
        // Pending count on a task with no live workers still wins over Open.
        assert!(matches!(
            restore_status_after_dispute_cancel(0, 0, Some(2)),
            TaskStatus::PendingValidation
        ));
        // Legacy task with nothing pending -> the worker count decides, as before.
        assert!(matches!(
            restore_status_after_dispute_cancel(0, 1, Some(0)),
            TaskStatus::InProgress
        ));
        assert!(matches!(
            restore_status_after_dispute_cancel(0, 0, Some(0)),
            TaskStatus::Open
        ));
    }
}
