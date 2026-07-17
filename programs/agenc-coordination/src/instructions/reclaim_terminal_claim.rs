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
use crate::instructions::task_validation_helpers::saturating_dec_counter;
use crate::state::{
    AgentRegistration, Dispute, DisputeStatus, ProtocolConfig, SubmissionStatus, Task, TaskClaim,
    TaskStatus, TaskSubmission,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

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

    // Audit F-2: never reclaim the defendant's claim while its dispute is Resolved
    // with the slash unapplied — apply_dispute_slash is the designated finalizer for
    // exactly this claim (and the current_workers slot resolve_dispute left for it);
    // reclaiming it would brick the finalizer, the deferred reserve, and the worker's
    // stake-clearing bookkeeping. The dispute travels as an OPTIONAL remaining
    // account (no IDL change; omission is disclosed in TODO.MD — it cannot profit
    // the caller, whose reclaim pays only the worker / treasury).
    if let Some(dispute_info) = ctx.remaining_accounts.first() {
        require!(
            dispute_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        let dispute = {
            let data = dispute_info.try_borrow_data()?;
            Dispute::try_deserialize(&mut &data[..])
                .map_err(|_| CoordinationError::InvalidInput)?
        };
        let (expected_dispute, _) = Pubkey::find_program_address(
            &[b"dispute", dispute.dispute_id.as_ref()],
            &crate::ID,
        );
        require!(
            dispute_info.key() == expected_dispute
                && dispute.task == task.key()
                && dispute.defendant == worker.key(),
            CoordinationError::InvalidInput
        );
        require!(
            dispute.status != DisputeStatus::Resolved || dispute.slash_applied,
            CoordinationError::ClaimSlashPending
        );
    }

    // Unfakeable no-live-submission proof, two acceptable forms (audit F-3):
    //  1. the seeds-derived submission address is system-owned + zero-data (no
    //     submission was ever made for this claim, or it was already closed with it);
    //  2. it holds a REJECTED submission (bounced via request_changes / quorum-reject).
    //     The review counters were already decremented at bounce time, so this form
    //     touches NEITHER live_submissions nor pending_submission_count — it only
    //     recovers the worker's submission rent below. A bounced worker's claim is
    //     otherwise stranded forever once a peer's completing accept flips the task
    //     terminal (resubmit needs a non-terminal task; expire_claim too).
    // A live program-owned submission in any OTHER state means the claim is still
    // settleable by the normal paths and must not be short-circuited.
    let submission_info = ctx.accounts.task_submission.to_account_info();
    let close_rejected_submission = if submission_info.owner == &anchor_lang::system_program::ID
        && submission_info.data_is_empty()
    {
        false
    } else if submission_info.owner == &crate::ID {
        let submission = {
            let data = submission_info.try_borrow_data()?;
            TaskSubmission::try_deserialize(&mut &data[..])
                .map_err(|_| CoordinationError::ClaimReclaimRequiresNoSubmission)?
        };
        require!(
            submission.status == SubmissionStatus::Rejected
                && submission.task == task.key()
                && submission.claim == claim.key(),
            CoordinationError::ClaimReclaimRequiresNoSubmission
        );
        true
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
    let rent_min = Rent::get()?.minimum_balance(claim_info.data_len());
    let total = claim_info.lamports();
    let forfeited = total.saturating_sub(rent_min);
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

    // A bounced (Rejected) submission carries no counter debt (request_changes
    // decremented both review counters at bounce time) — just return its rent to
    // the worker (rent_recipient is constrained == worker.authority) and tombstone
    // it, mirroring the claim-close pattern. Not reachable on the no-submission
    // evidence form.
    if close_rejected_submission {
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
