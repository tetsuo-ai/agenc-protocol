//! Permissionless chunked settlement of one deferred collaborative peer claim
//! after a dispute ruling (the pull half of the O(1) dispute-unwind redesign,
//! docs/design/bid-accept-o1-redesign.md Part B).
//!
//! `resolve_dispute` / `expire_dispute` record the ruling and settle every
//! principal effect atomically, but no longer enumerate `(claim, worker,
//! task_submission)` peer bundles — each remaining collaborative peer is swept
//! here, one worker per transaction. The dispute transitions to its recorded
//! terminal status (Resolved or Expired) when the last peer settles. Settled
//! claims are tombstoned, so double settlement fails structurally; the
//! defendant is excluded (its claim settles through the ruling and the slash
//! finalizers).

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::DisputePeerClaimSettled;
use crate::instructions::dispute_helpers::settle_single_dispute_peer;
use crate::state::{Dispute, DisputeStatus, Task, TaskValidationConfig};
use crate::utils::version::check_version_compatible_for_exit;

#[derive(Accounts)]
pub struct SettleDisputeClaim<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, crate::state::ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,

    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = dispute.task == task.key() @ CoordinationError::TaskNotFound
    )]
    pub task: Box<Account<'info, Task>>,

    /// CHECK: canonical `["claim", task, worker]` PDA, owner, discriminator,
    /// and binding to `worker` are all enforced by the shared bundle
    /// validation in the handler (identical to the retired monolithic path).
    #[account(mut)]
    pub claim: UncheckedAccount<'info>,

    /// CHECK: canonical `["agent", agent_id]` AgentRegistration PDA bound by
    /// the shared bundle validation; receives the closed claim's rent.
    #[account(mut)]
    pub worker: UncheckedAccount<'info>,

    /// CHECK: canonical `["task_submission", claim]` PDA. A live record is
    /// swept with counter conservation; the exact empty system-owned PDA
    /// proves absence. Non-skippable evidence, as on the retired path.
    #[account(mut)]
    pub task_submission: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"task_validation", task.key().as_ref()],
        bump = task_validation_config.bump
    )]
    pub task_validation_config: Option<Box<Account<'info, TaskValidationConfig>>>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<SettleDisputeClaim>) -> Result<()> {
    // Exit-gated: settlement must remain available while the protocol is
    // paused — money and rent never lock (spec §7).
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let dispute = ctx.accounts.dispute.as_mut();
    require!(
        dispute.status == DisputeStatus::SettlementPending,
        CoordinationError::DisputeSettlementNotPending
    );
    require!(
        dispute.peer_workers_settled < dispute.peer_workers_total,
        CoordinationError::DisputeSettlementNotPending
    );

    let task = ctx.accounts.task.as_mut();
    let task_key = task.key();
    let defendant = dispute.defendant;
    settle_single_dispute_peer(
        task,
        &task_key,
        &ctx.accounts.claim.to_account_info(),
        &ctx.accounts.worker.to_account_info(),
        &ctx.accounts.task_submission.to_account_info(),
        defendant,
        ctx.accounts.task_validation_config.as_deref_mut(),
        ctx.program_id,
    )?;

    // One settled peer releases exactly one unit of the task's live-worker
    // accounting, mirroring the retired inline sweep.
    task.current_workers = task
        .current_workers
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    dispute.peer_workers_settled = dispute
        .peer_workers_settled
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    if dispute.peer_workers_settled == dispute.peer_workers_total {
        dispute.status = match dispute.pending_terminal_status {
            status if status == DisputeStatus::Resolved as u8 => DisputeStatus::Resolved,
            status if status == DisputeStatus::Expired as u8 => DisputeStatus::Expired,
            _ => return Err(CoordinationError::DisputeTerminalStatusCorrupt.into()),
        };
    }

    let clock = Clock::get()?;
    emit!(DisputePeerClaimSettled {
        dispute_id: dispute.dispute_id,
        task_id: task.task_id,
        worker: ctx.accounts.worker.key(),
        peers_remaining: dispute
            .peer_workers_total
            .checked_sub(dispute.peer_workers_settled)
            .ok_or(CoordinationError::ArithmeticOverflow)?,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
