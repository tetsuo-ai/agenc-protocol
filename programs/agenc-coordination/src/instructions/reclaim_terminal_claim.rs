//! Batch 3 WS-CONTEST fix round (FIX 1b): reclaim a no-show claim stranded on
//! an already-terminal task.
//!
//! A worker who claims but never submits can normally be `expire_claim`-ed, but
//! that path requires a NON-terminal task (it touches the escrow, which every
//! terminal path closes). A contest that settles via accept or ghost-split — or
//! any multi-worker task that completes/cancels — can therefore leave a
//! claimed-but-never-submitted claim behind FOREVER: `current_workers > 0`
//! bricks `close_task` (Task PDA rent + child configs strand), and the no-show
//! worker's `active_tasks` slot leaks (10 leaks brick the agent).
//!
//! `reclaim_terminal_claim` is the permissionless un-bricker:
//! - requires a TERMINAL task (`Completed`/`Cancelled`), a non-completed claim,
//!   and PROOF there is no live submission: the seeds-derived
//!   `["task_submission", claim]` address must be system-owned + zero-data
//!   (unfakeable — same evidence rule as `expire_claim`);
//! - closes the claim: its rent-exempt minimum to the WORKER, any surplus (the
//!   contest entry deposit — FIX 4) FORFEITED to the protocol treasury (a
//!   no-show exit; never the creator);
//! - decrements `task.current_workers` and the worker's `active_tasks`;
//! - takes NO escrow account (closed by then) and pays NO cleanup reward.
//!
//! Full module only — the canary surface is unchanged.

use crate::errors::CoordinationError;
use crate::events::TerminalClaimReclaimed;
use crate::instructions::task_validation_helpers::{
    decrement_pending_submission_count, ensure_validation_config, note_submission_left_review,
    saturating_dec_counter,
};
use crate::state::{
    AgentRegistration, ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskStatus,
    TaskSubmission, TaskType, TaskValidationConfig,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

/// Generic terminal-claim cleanup is valid only when the Task still accounts
/// for that live claim. A terminal live claim with `current_workers == 0` is the
/// exact shape left by the deployed dispute resolver for a pending worker slash;
/// before the durable pending bit existed, no stronger omission-proof marker was
/// available on Task. Conservatively reserve that shape for
/// `apply_dispute_slash` so generic reclaim cannot erase its canonical evidence.
fn validate_terminal_claim_not_slash_reserved(task: &Task) -> Result<()> {
    require!(
        !task.worker_slash_pending() && task.current_workers > 0,
        CoordinationError::ClaimSlashPending
    );
    Ok(())
}

#[derive(Accounts)]
pub struct ReclaimTerminalClaim<'info> {
    /// Permissionless caller; pays only the transaction fee.
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed,
        constraint = claim.worker == worker.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    /// The derived `["task_submission", claim]` PDA — the unfakeable liveness
    /// probe. It must be system-owned with zero data (no submission was ever
    /// made for this claim, or it was already closed together with the claim by
    /// a settlement path — in which case THIS claim would not exist) OR hold a
    /// REJECTED submission (audit F-3 — then its rent is returned to the worker
    /// and it is tombstoned here, hence `mut`). A live program-owned submission
    /// in any other state means the claim is still settleable by the normal
    /// paths and must not be short-circuited.
    /// CHECK: address pinned by seeds; owner/data inspected in the handler.
    #[account(
        mut,
        seeds = [b"task_submission", claim.key().as_ref()],
        bump
    )]
    pub task_submission: UncheckedAccount<'info>,

    /// Validation counters for terminal cleanup of a still-Submitted
    /// Collaborative straggler. Omitted for the historical no-submission and
    /// Rejected-submission cleanup forms.
    #[account(
        mut,
        seeds = [b"task_validation", task.key().as_ref()],
        bump = task_validation_config.bump
    )]
    pub task_validation_config: Option<Box<Account<'info, TaskValidationConfig>>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: the protocol treasury, validated against `protocol_config.treasury`.
    /// Receives the forfeited contest entry-deposit surplus (never the creator);
    /// 0 lamports for non-contest claims.
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::ContestForfeitTreasuryRequired
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: receives the claim's rent-exempt minimum — validated to be the
    /// worker authority (stored pubkey; no caller-supplied-account trust).
    #[account(
        mut,
        constraint = rent_recipient.key() == worker.authority @ CoordinationError::InvalidRentRecipient
    )]
    pub rent_recipient: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<ReclaimTerminalClaim>) -> Result<()> {
    // Exit/cleanup path: must work even while the protocol is paused — a pause
    // must not keep a stranded claim (and the Task PDA behind it) locked.
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;
    let task = &mut ctx.accounts.task;
    let worker = &mut ctx.accounts.worker;
    let claim = &ctx.accounts.claim;

    // Only claims stranded on an already-terminal task. Everything earlier in
    // the lifecycle has a real settlement/expiry path (expire_claim, reject,
    // accept, ghost-split, cancel's claim drain) that this must never bypass.
    require!(
        matches!(task.status, TaskStatus::Completed | TaskStatus::Cancelled),
        CoordinationError::ClaimReclaimRequiresTerminalTask
    );
    // A completed claim was settled and closed by its settlement path; if one
    // still exists it is not ours to touch.
    require!(
        !claim.is_completed,
        CoordinationError::ClaimAlreadyCompleted
    );

    // Load-bearing, omission-proof slash guard. The pending bit lives on the
    // required Task account, so omitting the optional Dispute remaining account
    // can no longer reclaim the exact claim reserved for apply_dispute_slash.
    validate_terminal_claim_not_slash_reserved(task)?;

    // Unfakeable submission-state proof, with three accepted cleanup forms:
    //  1. the seeds-derived submission address is system-owned + zero-data (no
    //     submission was ever made for this claim, or it was already closed with it);
    //  2. it holds a REJECTED submission (bounced via request_changes / quorum-reject).
    //     The review counters were already decremented at bounce time, so this form
    //     touches NEITHER live_submissions nor pending_submission_count — it only
    //     recovers the worker's submission rent below. A bounced worker's claim is
    //     otherwise stranded forever once a peer's completing accept flips the task
    //     terminal (resubmit needs a non-terminal task; expire_claim too).
    //  3. a still-SUBMITTED Collaborative straggler after the task is Completed.
    //     The accepted completions already consumed the escrow; this branch
    //     releases the otherwise permanent claim/submission/counter debt and
    //     refunds all rent/surplus to the worker. It is never available for a
    //     contest, Exclusive task, or merely Cancelled task.
    // A live program-owned submission in any OTHER shape remains unavailable.
    let submission_info = ctx.accounts.task_submission.to_account_info();
    let (close_submission, submitted_straggler) = if submission_info.owner
        == &anchor_lang::system_program::ID
        && submission_info.data_is_empty()
    {
        (false, false)
    } else if submission_info.owner == &crate::ID {
        let submission = {
            let data = submission_info.try_borrow_data()?;
            TaskSubmission::try_deserialize(&mut &data[..])
                .map_err(|_| CoordinationError::ClaimReclaimRequiresNoSubmission)?
        };
        require!(
            submission.task == task.key()
                && submission.claim == claim.key()
                && submission.worker == worker.key(),
            CoordinationError::ClaimReclaimRequiresNoSubmission
        );
        match submission.status {
            SubmissionStatus::Rejected => (true, false),
            SubmissionStatus::Submitted => {
                require!(
                    task.status == TaskStatus::Completed
                        && task.task_type == TaskType::Collaborative,
                    CoordinationError::ClaimReclaimRequiresNoSubmission
                );
                let validation_config = ctx
                    .accounts
                    .task_validation_config
                    .as_mut()
                    .ok_or(CoordinationError::TaskValidationConfigRequired)?;
                ensure_validation_config(validation_config, &task.key(), task)?;
                decrement_pending_submission_count(validation_config)?;
                note_submission_left_review(task)?;
                (true, true)
            }
            _ => {
                return Err(CoordinationError::ClaimReclaimRequiresNoSubmission.into());
            }
        }
    } else {
        return Err(CoordinationError::ClaimReclaimRequiresNoSubmission.into());
    };

    // Free the slot counters — this is what un-bricks close_task
    // (current_workers -> 0) and the worker's active_tasks budget. saturating
    // (audit F-15): the designated un-bricker must not itself brick on drifted
    // legacy counters.
    task.current_workers = saturating_dec_counter(task.current_workers);
    worker.active_tasks = saturating_dec_counter(worker.active_tasks);

    // Split the claim lamports (FIX 4 forfeit rule): rent-exempt minimum back to
    // the worker, any surplus (the contest entry deposit) to the treasury — a
    // no-show exit forfeits the deposit; only submitters are made whole.
    let claim_info = claim.to_account_info();
    let total = claim_info.lamports();
    let forfeited = if submitted_straggler {
        0
    } else {
        let rent_min = Rent::get()?.minimum_balance(claim_info.data_len());
        total.saturating_sub(rent_min)
    };
    if forfeited > 0 {
        let treasury_info = ctx.accounts.treasury.to_account_info();
        **claim_info.try_borrow_mut_lamports()? = total
            .checked_sub(forfeited)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        **treasury_info.try_borrow_mut_lamports()? = treasury_info
            .lamports()
            .checked_add(forfeited)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }
    let worker_refund = claim_info.lamports();

    emit!(TerminalClaimReclaimed {
        task: task.key(),
        claim: claim.key(),
        worker_agent: worker.key(),
        worker_refund,
        forfeited,
        timestamp: clock.unix_timestamp,
    });

    // Close the claim: remaining lamports (the rent) to the worker authority.
    ctx.accounts
        .claim
        .close(ctx.accounts.rent_recipient.to_account_info())?;

    // Rejected submissions carry no counter debt; Submitted Collaborative
    // stragglers had both counters decremented above. Return the full account
    // balance to the worker and tombstone either form.
    if close_submission {
        let lamports = submission_info.lamports();
        **submission_info.try_borrow_mut_lamports()? = 0;
        **ctx.accounts.rent_recipient.try_borrow_mut_lamports()? = ctx
            .accounts
            .rent_recipient
            .lamports()
            .checked_add(lamports)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let mut data = submission_info.try_borrow_mut_data()?;
        data.fill(0);
        data[..8].copy_from_slice(&[255u8; 8]);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_claim_reclaim_reserves_current_and_legacy_slash_shapes() {
        let mut task = Task {
            current_workers: 1,
            ..Task::default()
        };
        assert!(validate_terminal_claim_not_slash_reserved(&task).is_ok());

        task.set_worker_slash_pending(true);
        assert!(validate_terminal_claim_not_slash_reserved(&task).is_err());

        task.set_worker_slash_pending(false);
        task.current_workers = 0;
        assert!(validate_terminal_claim_not_slash_reserved(&task).is_err());
    }
}
