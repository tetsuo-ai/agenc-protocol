//! Permissionless recovery of a stranded completion bond (Batch 3 audit fix).
//!
//! Bonds are normally settled as a side effect of the terminal settlement
//! instructions, but those pass the bond accounts OPTIONALLY — so the signer of a
//! terminal action could omit the counterparty's bond and strand it (audit MEDIUM),
//! and a worker bond posted from a non-authority wallet has no settlement path
//! (audit LOW). This instruction lets ANYONE refund a still-live bond to its poster
//! once the task is `Completed`.
//!
//! Safety: a `Completed` task is a clean success (complete_task / accept /
//! auto_accept) OR a worker-won dispute (resolve_dispute Complete) — in every case
//! BOTH bonds are owed back to their posters. A dispute LOSER's bond is forfeited
//! inside resolve_dispute (the SDK always passes the bond accounts there), so it is
//! already closed and cannot be reclaimed here. settle_completion_bond is a no-op for
//! an already-settled / non-existent bond, so a redundant call is harmless.

use crate::errors::CoordinationError;
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
use crate::state::{Task, TaskStatus};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ReclaimCompletionBond<'info> {
    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    /// CHECK: the bond PDA, address-fixed by seeds; ownership/role/party are fully
    /// validated by settle_completion_bond in the handler.
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), party.key().as_ref()],
        bump
    )]
    pub completion_bond: UncheckedAccount<'info>,

    /// CHECK: the bond poster + refund recipient; validated == bond.party by the helper.
    #[account(mut)]
    pub party: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ReclaimCompletionBond>, role: u8) -> Result<()> {
    // A Completed task owes both bonds back to their posters. A Cancelled task is also
    // accepted (audit F12/F13/F75) as a permissionless safety net: cancel_task settles
    // bonds only if the caller passes them, so a bond omitted on cancel would otherwise be
    // unrecoverable — this lets ANYONE (including the bond poster) refund a still-live bond
    // to its rightful party while the Task PDA is alive. settle_completion_bond refunds to
    // bond.party only, so it cannot misroute funds; a dispute LOSER's bond was already
    // forfeited+closed inside resolve_dispute, so it is a no-op here. Reclaim never forfeits.
    require!(
        ctx.accounts.task.status == TaskStatus::Completed
            || ctx.accounts.task.status == TaskStatus::Cancelled,
        CoordinationError::InvalidStatusTransition
    );

    settle_completion_bond(
        &ctx.accounts.completion_bond.to_account_info(),
        &ctx.accounts.party.to_account_info(),
        &ctx.accounts.task.key(),
        role,
        BondDisposition::Refund,
    )?;

    Ok(())
}
