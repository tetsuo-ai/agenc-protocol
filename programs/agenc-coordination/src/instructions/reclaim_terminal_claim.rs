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
use crate::state::{AgentRegistration, ProtocolConfig, Task, TaskClaim, TaskStatus};
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
    /// a settlement path — in which case THIS claim would not exist). A live
    /// program-owned submission here means the claim is still settleable by the
    /// normal paths and must not be short-circuited.
    /// CHECK: address pinned by seeds; owner/data inspected in the handler.
    #[account(
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

    // Unfakeable no-submission proof: the seeds-derived submission address must
    // be system-owned + zero-data. A live program-owned account here means a
    // submission still exists (e.g. a quorum-rejected straggler) — that worker
    // is NOT a no-show and this claim must not forfeit anything.
    let submission_info = ctx.accounts.task_submission.to_account_info();
    require!(
        submission_info.owner == &anchor_lang::system_program::ID
            && submission_info.data_is_empty(),
        CoordinationError::ClaimReclaimRequiresNoSubmission
    );

    // Free the slot counters — this is what un-bricks close_task
    // (current_workers -> 0) and the worker's active_tasks budget.
    task.current_workers = task
        .current_workers
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.active_tasks = worker
        .active_tasks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

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

    Ok(())
}
