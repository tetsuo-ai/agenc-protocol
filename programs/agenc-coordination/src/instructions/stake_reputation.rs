//! Stake SOL on agent reputation

use crate::errors::CoordinationError;
use crate::events::ReputationStaked;
use crate::state::{AgentRegistration, AgentStatus, ProtocolConfig, ReputationStake};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

use super::constants::REPUTATION_STAKING_COOLDOWN;

#[derive(Accounts)]
pub struct StakeReputation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent,
    )]
    pub agent: Account<'info, AgentRegistration>,

    #[account(
        init_if_needed,
        payer = authority,
        space = ReputationStake::SIZE,
        seeds = [b"reputation_stake", agent.key().as_ref()],
        bump,
        constraint = reputation_stake.key() != agent.key() @ CoordinationError::InvalidInput
    )]
    pub reputation_stake: Account<'info, ReputationStake>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<StakeReputation>, amount: u64) -> Result<()> {
    // Staking is new principal entering protocol custody, not an exit. Honor the
    // global pause/version boundary before accepting SOL; withdrawals remain
    // exit-safe while paused.
    check_version_compatible(&ctx.accounts.protocol_config)?;
    require!(amount > 0, CoordinationError::ReputationStakeAmountTooLow);

    let agent = &ctx.accounts.agent;
    require!(
        agent.status == AgentStatus::Active,
        CoordinationError::ReputationAgentNotActive
    );

    let clock = Clock::get()?;
    let stake = &mut ctx.accounts.reputation_stake;

    // Defense-in-depth: bind stake account identity to this agent for all
    // non-fresh accounts. This prevents accidental mismatches after future
    // migrations/refactors around init_if_needed flows.
    if stake.agent != Pubkey::default() {
        require!(
            stake.agent == ctx.accounts.agent.key(),
            CoordinationError::InvalidInput
        );
    }

    // Initialize on first use
    if stake.agent == Pubkey::default() {
        stake.agent = ctx.accounts.agent.key();
        stake.created_at = clock.unix_timestamp;
        stake.bump = ctx.bumps.reputation_stake;
    }

    // Principal conservation: an existing stake PDA must already hold its rent
    // reserve plus every lamport represented by `staked_amount`. Never accept new
    // principal into an under-collateralized/corrupt account and thereby mask the
    // deficit. A fresh `init_if_needed` account has `staked_amount == 0`, so the
    // same invariant naturally reduces to the normal rent-exemption check.
    let rent_minimum = Rent::get()?.minimum_balance(stake.to_account_info().data_len());
    let required_pre_balance = rent_minimum
        .checked_add(stake.staked_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        stake.to_account_info().lamports() >= required_pre_balance,
        CoordinationError::CorruptedData
    );

    let updated_staked_amount = stake
        .staked_amount
        .checked_add(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let updated_locked_until = clock
        .unix_timestamp
        .checked_add(REPUTATION_STAKING_COOLDOWN)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    stake.staked_amount = updated_staked_amount;
    stake.locked_until = updated_locked_until;

    // Transfer SOL after state is prepared so later logic does not depend on a
    // potentially stale post-CPI view of the stake account.
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: stake.to_account_info(),
            },
        ),
        amount,
    )?;

    emit!(ReputationStaked {
        agent: ctx.accounts.agent.key(),
        amount,
        total_staked: updated_staked_amount,
        locked_until: updated_locked_until,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
