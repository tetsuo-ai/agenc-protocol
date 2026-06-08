//! Reclaim a terminal task's account rent (embeddable marketplace, Batch 1).
//!
//! Neither `complete_task` (via completion_helpers) nor `cancel_task` closes the
//! `Task` PDA itself — they close the escrow + claims and set a terminal status,
//! leaving the `Task` account (and its rent) stranded. `close_task` lets the task
//! creator reclaim that rent once the task is terminal (`Completed` or
//! `Cancelled`), and also closes the leftover `TaskJobSpec` pointer in the same
//! transaction.
//!
//! Escrow handling: most terminal paths (`cancel_task`, completion, and
//! `resolve_dispute`) fully close the escrow PDA before the task becomes terminal,
//! so the caller passes `escrow = None`. The one exception is `expire_dispute`,
//! which marks `escrow.is_closed = true` and drains the funds but does NOT close
//! the escrow account — leaving its rent stranded. For that path the caller passes
//! the still-alive escrow and `close_task` reclaims its rent too (only ever an
//! already-settled `is_closed` escrow, never one still holding funds).
//!
//! Hire/capacity handling: the `hire_record` PDA is ALWAYS a required account (the
//! caller passes the derived `["hire", task]` address even for non-hired tasks,
//! where it is an empty system account). If it is a live program-owned record, the
//! task came from `hire_from_listing`, and `close_task` frees the source listing's
//! `open_jobs` capacity slot and closes the link. Making it required (not optional)
//! is deliberate: a caller cannot skip the decrement to inflate a provider's
//! capacity counter.

use crate::errors::CoordinationError;
use crate::events::TaskClosed;
use crate::state::{HireRecord, ServiceListing, Task, TaskEscrow, TaskJobSpec, TaskStatus};
use anchor_lang::prelude::*;

/// Pure guard: a task is closable only in a terminal state with no live workers.
/// Extracted so the terminal-only rule is unit-testable and revert-sensitive.
pub(crate) fn validate_task_closable(status: TaskStatus, current_workers: u8) -> Result<()> {
    require!(
        matches!(status, TaskStatus::Completed | TaskStatus::Cancelled),
        CoordinationError::TaskNotClosable
    );
    // Defensive: a terminal task should never still reference a live worker; on
    // both terminal paths current_workers is driven to 0 before settlement.
    require!(current_workers == 0, CoordinationError::TaskNotClosable);
    Ok(())
}

#[derive(Accounts)]
pub struct CloseTask<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == authority.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Account<'info, Task>,

    /// Optional leftover job-spec pointer for this task. When provided it is closed
    /// alongside the task so its rent is reclaimed too. Bound to this task by seeds
    /// + constraint so a caller cannot close another task's pointer.
    #[account(
        mut,
        seeds = [b"task_job_spec", task.key().as_ref()],
        bump = task_job_spec.bump,
        constraint = task_job_spec.task == task.key() @ CoordinationError::TaskJobSpecTaskMismatch
    )]
    pub task_job_spec: Option<Account<'info, TaskJobSpec>>,

    /// Optional still-alive escrow PDA. Only `expire_dispute` leaves the escrow
    /// account open (drained, `is_closed = true`) on a terminal task; provide it
    /// here to reclaim its rent. Bound to this task by seeds + constraint.
    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump,
        constraint = escrow.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub escrow: Option<Account<'info, TaskEscrow>>,

    /// Hire link PDA for this task. ALWAYS required — the caller passes the derived
    /// ["hire", task] address even for non-hired tasks (where it is an empty system
    /// account). close_task decides from the on-chain owner whether a live hire must
    /// be settled, so a caller cannot dodge the capacity decrement by omitting it.
    /// CHECK: address is fixed by seeds; live-vs-absent is determined by `owner` in
    /// the handler, and a live record is deserialized + validated there.
    #[account(
        mut,
        seeds = [b"hire", task.key().as_ref()],
        bump
    )]
    pub hire_record: UncheckedAccount<'info>,

    /// Source listing, required when a live hire link is present, so its `open_jobs`
    /// capacity counter can be decremented. Verified against `hire_record.listing`.
    #[account(
        mut,
        seeds = [b"service_listing", listing.provider_agent.as_ref(), listing.listing_id.as_ref()],
        bump = listing.bump
    )]
    pub listing: Option<Account<'info, ServiceListing>>,

    /// Task creator; receives the reclaimed rent. Mutable to credit lamports.
    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<CloseTask>) -> Result<()> {
    let clock = Clock::get()?;
    let task_key = ctx.accounts.task.key();
    let task = &ctx.accounts.task;
    require!(task.bump > 0, CoordinationError::CorruptedData);
    // Terminal status is the safety boundary: every path that reaches Completed or
    // Cancelled (cancel_task, completion_helpers, and dispute resolution) closes the
    // escrow + claims first, so a closable task never has an open escrow/claim to
    // orphan. close_task therefore does not take the escrow account (it is already
    // gone) and only reclaims the leftover Task (+ optional TaskJobSpec).
    validate_task_closable(task.status, task.current_workers)?;

    let job_spec_closed = ctx.accounts.task_job_spec.is_some();
    let escrow_closed = ctx.accounts.escrow.is_some();
    // A live hire link is one owned by this program; an empty/absent PDA (non-hired
    // task) is system-owned. The caller cannot omit it (it is a required account).
    let hire_record_closed = ctx.accounts.hire_record.owner == &crate::ID;

    emit!(TaskClosed {
        task_id: task.task_id,
        creator: task.creator,
        status: task.status as u8,
        job_spec_closed,
        escrow_closed,
        hire_record_closed,
        timestamp: clock.unix_timestamp,
    });

    let authority_info = ctx.accounts.authority.to_account_info();

    // Close the optional children in-handler; the Task PDA itself is closed via the
    // `close = authority` account constraint after this returns Ok.
    if let Some(job_spec) = ctx.accounts.task_job_spec.as_ref() {
        job_spec.close(authority_info.clone())?;
    }
    if let Some(escrow) = ctx.accounts.escrow.as_ref() {
        // Only ever reclaim rent from an already-settled escrow; refuse to touch
        // one that still holds undistributed funds (would strand/misdirect them).
        require!(escrow.is_closed, CoordinationError::InvalidInput);
        escrow.close(authority_info.clone())?;
    }
    // If a live hire link is present, free the listing's capacity slot and close the
    // link. Because hire_record is a required, seeds-fixed account, the caller cannot
    // skip this for a hired task — closing the capacity decrement loophole.
    if hire_record_closed {
        let hire_info = ctx.accounts.hire_record.to_account_info();
        let hire = {
            let data = hire_info.try_borrow_data()?;
            HireRecord::try_deserialize(&mut &data[..])?
        };
        require!(hire.task == task_key, CoordinationError::InvalidInput);

        let listing = ctx
            .accounts
            .listing
            .as_mut()
            .ok_or(CoordinationError::InvalidInput)?;
        require!(
            listing.key() == hire.listing,
            CoordinationError::InvalidInput
        );
        // saturating_sub: a capacity counter must never underflow.
        listing.open_jobs = listing.open_jobs.saturating_sub(1);
        listing.updated_at = clock.unix_timestamp;

        // Close the hire link: drain rent to the creator, then zero + tombstone the
        // data (mirrors cancel_task's claim-close pattern). The 0-lamport account is
        // garbage-collected by the runtime at end of transaction.
        let lamports = hire_info.lamports();
        **hire_info.try_borrow_mut_lamports()? = 0;
        **authority_info.try_borrow_mut_lamports()? = authority_info
            .lamports()
            .checked_add(lamports)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let mut data = hire_info.try_borrow_mut_data()?;
        data.fill(0);
        data[..8].copy_from_slice(&[255u8; 8]);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_terminal_with_no_workers() {
        assert!(validate_task_closable(TaskStatus::Completed, 0).is_ok());
        assert!(validate_task_closable(TaskStatus::Cancelled, 0).is_ok());
    }

    // Revert-sensitive: removing the terminal-status require! turns these red.
    #[test]
    fn rejects_non_terminal_status() {
        for status in [
            TaskStatus::Open,
            TaskStatus::InProgress,
            TaskStatus::PendingValidation,
            TaskStatus::Disputed,
        ] {
            assert!(validate_task_closable(status, 0).is_err());
        }
    }

    // Revert-sensitive: removing the current_workers require! turns this red.
    #[test]
    fn rejects_terminal_with_live_worker() {
        assert!(validate_task_closable(TaskStatus::Completed, 1).is_err());
    }
}
