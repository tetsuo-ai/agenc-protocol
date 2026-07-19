//! Withdraw SOL from reputation stake after cooldown

use crate::errors::CoordinationError;
use crate::events::ReputationStakeWithdrawn;
use crate::state::{AgentRegistration, ReputationStake};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct WithdrawReputationStake<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent,
    )]
    pub agent: Account<'info, AgentRegistration>,

    #[account(
        mut,
        seeds = [b"reputation_stake", agent.key().as_ref()],
        bump = reputation_stake.bump,
        constraint = reputation_stake.agent == agent.key() @ CoordinationError::InvalidInput,
        constraint = reputation_stake.key() != agent.key() @ CoordinationError::InvalidInput
    )]
    pub reputation_stake: Account<'info, ReputationStake>,
}

pub fn handler(ctx: Context<WithdrawReputationStake>, amount: u64) -> Result<()> {
    require!(amount > 0, CoordinationError::ReputationStakeAmountTooLow);

    let clock = Clock::get()?;
    let stake = &mut ctx.accounts.reputation_stake;
    let agent = &ctx.accounts.agent;

    // Check cooldown has passed
    require!(
        clock.unix_timestamp >= stake.locked_until,
        CoordinationError::ReputationStakeLocked
    );

    // Check no pending disputes as defendant
    require!(
        agent.disputes_as_defendant == 0,
        CoordinationError::ReputationDisputesPending
    );

    // Check sufficient balance
    require!(
        amount <= stake.staked_amount,
        CoordinationError::ReputationStakeInsufficientBalance
    );

    // Prove the physical lamports remain equal to (or exceed) the logical stake
    // plus the account's rent reserve after this withdrawal. Checked subtraction
    // alone would only prove the account has `amount`, not that all other stakers'
    // represented principal and rent remain backed if the account were corrupt.
    let remaining_staked = stake
        .staked_amount
        .checked_sub(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let post_balance = stake
        .to_account_info()
        .lamports()
        .checked_sub(amount)
        .ok_or(CoordinationError::ReputationStakeInsufficientBalance)?;
    let required_post_balance = Rent::get()?
        .minimum_balance(stake.to_account_info().data_len())
        .checked_add(remaining_staked)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        post_balance >= required_post_balance,
        CoordinationError::CorruptedData
    );

    // Transfer lamports from PDA to authority (program-owned account manipulation)
    let stake_info = stake.to_account_info();
    let authority_info = ctx.accounts.authority.to_account_info();

    **stake_info.try_borrow_mut_lamports()? = stake_info
        .lamports()
        .checked_sub(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    **authority_info.try_borrow_mut_lamports()? = authority_info
        .lamports()
        .checked_add(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    stake.staked_amount = remaining_staked;

    emit!(ReputationStakeWithdrawn {
        agent: ctx.accounts.agent.key(),
        amount,
        remaining_staked: stake.staked_amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
