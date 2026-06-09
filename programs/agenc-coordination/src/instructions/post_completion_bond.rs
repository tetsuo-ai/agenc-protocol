//! Post a symmetric 25% completion bond (Batch 3 §8, SOL v1).
//!
//! Both the creator and the worker post a bond equal to 25% of the reward into
//! their own dedicated PDA (`["completion_bond", task, party]`). The loser of a
//! dispute forfeits theirs, the winner is refunded, and a no-show worker's bond is
//! forfeited to the creator on `expire_claim`. The bond lives in its own PDA — never
//! on `TaskClaim` — so a no-show worker cannot get an auto-refund when the claim
//! closes to their wallet.

use crate::errors::CoordinationError;
use crate::events::BondPosted;
use crate::state::{CompletionBond, Task, TaskStatus, TaskType};
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
#[instruction(role: u8)]
pub struct PostCompletionBond<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    /// The bond PDA, keyed by the SIGNING wallet so the two sides get distinct PDAs
    /// and `init` makes one-bond-per-wallet-per-task automatic (a second post fails).
    #[account(
        init,
        payer = authority,
        space = CompletionBond::SIZE,
        seeds = [b"completion_bond", task.key().as_ref(), authority.key().as_ref()],
        bump
    )]
    pub completion_bond: Box<Account<'info, CompletionBond>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PostCompletionBond>, role: u8) -> Result<()> {
    let task = &ctx.accounts.task;
    let clock = Clock::get()?;

    // Single-worker (Exclusive) only in v1: the hire path mints Exclusive tasks and
    // the 25/25 semantics assume exactly one creator and one worker.
    require!(
        task.task_type == TaskType::Exclusive,
        CoordinationError::BondUnsupportedTaskType
    );

    // Bonds are posted before settlement (creator while Open, worker once InProgress).
    require!(
        task.status == TaskStatus::Open || task.status == TaskStatus::InProgress,
        CoordinationError::InvalidStatusTransition
    );

    // Role binding: the creator bond must be posted by the task creator; the worker
    // bond by anyone who is NOT the creator (the worker authority). The party is the
    // signer, recorded on the bond and used as the seed + refund recipient.
    match role {
        CompletionBond::ROLE_CREATOR => {
            require!(
                ctx.accounts.authority.key() == task.creator,
                CoordinationError::BondPartyMismatch
            );
        }
        CompletionBond::ROLE_WORKER => {
            require!(
                ctx.accounts.authority.key() != task.creator,
                CoordinationError::BondPartyMismatch
            );
        }
        _ => return Err(CoordinationError::BondRoleMismatch.into()),
    }

    // SOL-only v1.
    require!(
        task.reward_mint.is_none(),
        CoordinationError::BondUnsupportedTaskType
    );

    // 25% of the reward, held as excess lamports on the bond PDA (on top of rent).
    let amount = (task.reward_amount as u128)
        .checked_mul(CompletionBond::BOND_BPS as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(10_000u128)
        .ok_or(CoordinationError::ArithmeticOverflow)? as u64;

    if amount > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.completion_bond.to_account_info(),
                },
            ),
            amount,
        )?;
    }

    let bond = &mut ctx.accounts.completion_bond;
    bond.task = task.key();
    bond.party = ctx.accounts.authority.key();
    bond.role = role;
    bond.amount = amount;
    bond.bond_mint = None;
    bond.posted_at = clock.unix_timestamp;
    bond.bump = ctx.bumps.completion_bond;
    bond._reserved = [0u8; 16];

    emit!(BondPosted {
        task: task.key(),
        party: bond.party,
        role,
        amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
