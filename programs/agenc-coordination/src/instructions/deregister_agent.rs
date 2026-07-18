//! Deregister an agent and reclaim rent

use crate::errors::CoordinationError;
use crate::events::AgentDeregistered;
use crate::instructions::slash_helpers::SLASH_WINDOW;
use crate::state::{AgentRegistration, AgentVerification, BidderMarketState, ProtocolConfig, ReputationStake};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct DeregisterAgent<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub agent: Account<'info, AgentRegistration>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump,
        constraint = protocol_config.key() != agent.key() @ CoordinationError::InvalidInput
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// The agent's reputation-stake PDA. REQUIRED + seeds-pinned so a caller cannot omit
    /// it to dodge the "stake must be withdrawn first" guard (audit). For an agent that
    /// never staked this is an empty system-owned PDA (the handler treats it as zero
    /// stake). It is NOT closed here — `ReputationStake` is intentionally kept to preserve
    /// `slash_count` history — so the agent must withdraw its stake before deregistering;
    /// otherwise the staked SOL would be stranded (the agent PDA is gone) and, because the
    /// `agent_id` becomes re-registerable by anyone, withdrawable by a new owner.
    /// CHECK: address fixed by seeds; existence/contents validated in the handler.
    #[account(
        seeds = [b"reputation_stake", agent.key().as_ref()],
        bump
    )]
    pub reputation_stake: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<DeregisterAgent>) -> Result<()> {
    let agent = &ctx.accounts.agent;
    let clock = Clock::get()?;

    // Ensure agent has no active tasks
    require!(
        agent.active_tasks == 0,
        CoordinationError::AgentHasActiveTasks
    );

    // The reputation stake must be fully withdrawn first. The ReputationStake PDA is
    // seeded on the agent PDA and is deliberately never closed (it preserves slash
    // history), so if the agent is deregistered with a live stake the SOL is stranded —
    // and worse, because agent_id becomes re-registerable by anyone, a new owner of the
    // same agent_id could withdraw it (the withdraw path only checks has_one on the
    // re-created agent). Block deregistration until staked_amount == 0. An agent that
    // never staked has an empty system-owned PDA here, which is treated as zero.
    {
        let stake_info = ctx.accounts.reputation_stake.to_account_info();
        if stake_info.owner == &crate::ID {
            let data = stake_info.try_borrow_data()?;
            // Tombstoned/closed PDAs deserialize to nothing meaningful; a live stake
            // account decodes and exposes staked_amount.
            if let Ok(stake) = ReputationStake::try_deserialize(&mut &data[..]) {
                require!(
                    stake.staked_amount == 0,
                    CoordinationError::ReputationStakeNotWithdrawn
                );
            }
        }
    }

    // If defendant disputes are still tracked, only allow deregistration after the
    // slash window anchored to the agent's latest activity has elapsed.
    if agent.disputes_as_defendant > 0 {
        let time_since_last_activity = clock
            .unix_timestamp
            .checked_sub(agent.last_active)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        require!(
            time_since_last_activity > SLASH_WINDOW,
            CoordinationError::ActiveDisputesExist
        );
    }

    require!(
        agent.active_dispute_votes == 0,
        CoordinationError::ActiveDisputeVotes
    );

    // Conservative initiator-slash gating: hold deregistration for a full dispute
    // lifecycle window plus slash window after the last dispute initiation.
    if agent.last_dispute_initiated > 0 {
        let dispute_lifecycle_window = ctx
            .accounts
            .protocol_config
            .max_dispute_duration
            .max(ctx.accounts.protocol_config.voting_period)
            .max(0);
        let initiator_guard_window = dispute_lifecycle_window
            .checked_add(SLASH_WINDOW)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let time_since_last_dispute = clock
            .unix_timestamp
            .checked_sub(agent.last_dispute_initiated)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        require!(
            time_since_last_dispute > initiator_guard_window,
            CoordinationError::CooldownNotElapsed
        );
    }

    // Only check vote cooldown if agent has actually voted before
    // When last_vote_timestamp is 0 (never voted), skip the check
    if agent.last_vote_timestamp > 0 {
        /// Vote cooldown period (same as WINDOW_24H for consistency)
        /// Intentionally duplicated to allow independent adjustment
        const VOTE_COOLDOWN: i64 = 86400;
        let time_since_vote = clock
            .unix_timestamp
            .checked_sub(agent.last_vote_timestamp)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        require!(
            time_since_vote > VOTE_COOLDOWN,
            CoordinationError::RecentVoteActivity
        );
    }

    // Audit (2026-07 swarm): a bidder with LIVE bids must not deregister — every
    // bid-withdrawal path loads this AgentRegistration by seeds, so closing it
    // would brick the bidder's own bonds. The canonical ["bidder_market", agent]
    // PDA is REQUIRED in remaining_accounts[0] so the guard cannot be dodged by
    // omission; an agent that never bid has an empty system-owned PDA there,
    // which reads as zero live bids.
    let bidder_market_info = ctx
        .remaining_accounts
        .first()
        .ok_or(CoordinationError::InvalidInput)?;
    let (expected_bidder_market, _) = Pubkey::find_program_address(
        &[b"bidder_market", agent.key().as_ref()],
        &crate::ID,
    );
    require!(
        bidder_market_info.key() == expected_bidder_market,
        CoordinationError::InvalidInput
    );
    if bidder_market_info.owner == &crate::ID {
        let data = bidder_market_info.try_borrow_data()?;
        if let Ok(market) = BidderMarketState::try_deserialize(&mut &data[..]) {
            require!(market.bidder == agent.key(), CoordinationError::InvalidInput);
            require!(
                market.active_bid_count == 0,
                CoordinationError::AgentHasActiveBids
            );
        }
    }

    // Audit (2026-07 swarm): sweep the AgentVerification badge. It is keyed
    // ["agent_verification", agent] and this PDA is agent_id-seeded — so a
    // deregister -> re-register cycle (by anyone: the agent_id is up for grabs)
    // would attach the OLD registration's verified-domain badge to the NEW
    // registrant. REQUIRED in remaining_accounts[1]; a live badge is closed
    // (rent to the deregistering authority) so no badge outlives its
    // registration. An agent never verified has an empty system PDA there.
    let verification_info = ctx
        .remaining_accounts
        .get(1)
        .ok_or(CoordinationError::InvalidInput)?;
    let (expected_verification, _) = Pubkey::find_program_address(
        &[b"agent_verification", agent.key().as_ref()],
        &crate::ID,
    );
    require!(
        verification_info.key() == expected_verification,
        CoordinationError::InvalidInput
    );
    if verification_info.owner == &crate::ID {
        let badge_live = {
            let data = verification_info.try_borrow_data()?;
            match AgentVerification::try_deserialize(&mut &data[..]) {
                Ok(verification) => {
                    require!(
                        verification.agent == agent.key(),
                        CoordinationError::InvalidInput
                    );
                    true
                }
                // A tombstoned badge ([255; 8] discriminator) does not deserialize.
                Err(_) => false,
            }
        };
        if badge_live {
            let authority_info = ctx.accounts.authority.to_account_info();
            let lamports = verification_info.lamports();
            **verification_info.try_borrow_mut_lamports()? = 0;
            **authority_info.try_borrow_mut_lamports()? = authority_info
                .lamports()
                .checked_add(lamports)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            let mut data = verification_info.try_borrow_mut_data()?;
            data.fill(0);
            data[..8].copy_from_slice(&[255u8; 8]);
        }
    }

    // Update protocol stats
    let config = &mut ctx.accounts.protocol_config;
    config.total_agents = config
        .total_agents
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(AgentDeregistered {
        agent_id: agent.agent_id,
        authority: agent.authority,
        timestamp: clock.unix_timestamp,
    });

    // Account is closed automatically via `close = authority`
    Ok(())
}
