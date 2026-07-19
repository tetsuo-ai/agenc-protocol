//! Retire an agent identity and refund its tracked registration stake.

use crate::errors::CoordinationError;
use crate::events::{AgentDeregistered, AgentVerificationRevoked};
use crate::state::{
    AgentRegistration, AgentVerification, BidderMarketState, ProtocolConfig, ReputationStake,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct DeregisterAgent<'info> {
    #[account(
        mut,
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
    /// `slash_count` history — so the agent must withdraw its stake before retirement.
    /// CHECK: address fixed by seeds; existence/contents validated in the handler.
    #[account(
        seeds = [b"reputation_stake", agent.key().as_ref()],
        bump
    )]
    pub reputation_stake: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

fn require_no_defendant_liabilities(disputes_as_defendant: u8) -> Result<()> {
    require!(
        disputes_as_defendant == 0,
        CoordinationError::ActiveDisputesExist
    );
    Ok(())
}

pub fn handler(ctx: Context<DeregisterAgent>) -> Result<()> {
    let agent = &ctx.accounts.agent;
    let clock = Clock::get()?;

    // Suspension is a protocol-authority sanction. Allowing the sanctioned wallet to
    // close its identity would erase the only durable on-chain sanction and previously
    // let it re-register the same agent_id as Active immediately.
    require!(
        agent.status != crate::state::AgentStatus::Suspended,
        CoordinationError::AgentSuspended
    );

    // A retired identity is permanent and cannot be deregistered twice. This is mostly
    // defense-in-depth: the tombstone is Inactive and remains owned by this program.
    require!(
        !agent.is_retired_identity(),
        CoordinationError::AgentNotActive
    );

    // Ensure agent has no active tasks
    require!(
        agent.active_tasks == 0,
        CoordinationError::AgentHasActiveTasks
    );

    // The reputation stake must be fully withdrawn first. The ReputationStake PDA is
    // seeded on the agent PDA and is deliberately never closed (it preserves slash
    // history). Block retirement until staked_amount == 0 so the former authority
    // cannot strand funds behind an inactive identity. An agent that never staked has
    // an empty system-owned PDA here, which is treated as zero.
    {
        let stake_info = ctx.accounts.reputation_stake.to_account_info();
        if stake_info.owner == &crate::ID {
            let data = stake_info.try_borrow_data()?;
            // ReputationStake is deliberately never closed: its slash history is
            // permanent. A program-owned canonical PDA that does not deserialize is
            // therefore corruption, not "absence". Failing open here could retire the
            // owning identity while principal remains stranded in an unreadable child.
            let stake = ReputationStake::try_deserialize(&mut &data[..])
                .map_err(|_| CoordinationError::CorruptedData)?;
            require!(stake.agent == agent.key(), CoordinationError::InvalidInput);
            require!(
                stake.staked_amount == 0,
                CoordinationError::ReputationStakeNotWithdrawn
            );
        } else {
            // The only valid absence representation at a canonical PDA is an
            // empty system account (possibly prefunded with lamports). Never
            // treat arbitrary ownership or allocated data as "no stake".
            require!(
                stake_info.owner == &anchor_lang::system_program::ID && stake_info.data_is_empty(),
                CoordinationError::InvalidAccountOwner
            );
        }
    }

    // Defendant liability is counter-bound, not timestamp-bound. Dispute
    // initiation does not refresh the defendant's `last_active`, so allowing an
    // old activity timestamp to bypass this gate could release registration
    // stake immediately after a newly filed dispute. Every terminal dispute path
    // clears this counter (the worker-loss path does so in its permissionless
    // finalizer), therefore a nonzero value must fail closed without aging out.
    require_no_defendant_liabilities(agent.disputes_as_defendant)?;

    // ABI-preserving initiator liability gate. P6.3 retired arbiter voting, so
    // this historical byte now counts disputes initiated by the agent that have
    // not passed through the permissionless initiator-outcome finalizer. Unlike
    // a timestamp alone, the counter cannot age out while a stale dispute stays
    // Active or while a cancelled loss remains unapplied.
    require!(
        agent.active_dispute_votes == 0,
        CoordinationError::ActiveDisputeVotes
    );

    // Governance voting stores the proposal deadline in this legacy timestamp
    // slot. Require the full window plus a 24-hour cooldown to elapse before
    // releasing the registration stake, preventing one stake from being
    // recycled through fresh wallet/agent pairs during the same proposal.
    // Legacy values that stored the actual vote time remain conservatively safe.
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
    // bid-withdrawal path loads this AgentRegistration by seeds, so retiring it
    // while bids remain would brick the bidder's own bonds. The canonical ["bidder_market", agent]
    // PDA is REQUIRED in remaining_accounts[0] so the guard cannot be dodged by
    // omission; an agent that never bid has an empty system-owned PDA there,
    // which reads as zero live bids.
    let bidder_market_info = ctx
        .remaining_accounts
        .first()
        .ok_or(CoordinationError::InvalidInput)?;
    let (expected_bidder_market, expected_bidder_market_bump) =
        Pubkey::find_program_address(&[b"bidder_market", agent.key().as_ref()], &crate::ID);
    require!(
        bidder_market_info.key() == expected_bidder_market,
        CoordinationError::InvalidInput
    );
    if bidder_market_info.owner == &crate::ID {
        let data = bidder_market_info.try_borrow_data()?;
        // BidderMarketState also has no close/tombstone lifecycle. Treat malformed
        // program-owned state as corruption instead of silently assuming zero bids;
        // otherwise retirement could strand live bid bonds behind an unreadable child.
        let market = BidderMarketState::try_deserialize(&mut &data[..])
            .map_err(|_| CoordinationError::CorruptedData)?;
        require!(
            market.bidder == agent.key() && market.bump == expected_bidder_market_bump,
            CoordinationError::InvalidInput
        );
        require!(
            market.active_bid_count == 0,
            CoordinationError::AgentHasActiveBids
        );
    } else {
        require!(
            bidder_market_info.owner == &anchor_lang::system_program::ID
                && bidder_market_info.data_is_empty(),
            CoordinationError::InvalidAccountOwner
        );
    }

    // Revoke, but retain, the AgentVerification badge. The moderation authority
    // funded this account, so paying its rent to the retiring subject would be a
    // cross-party value transfer. Keeping the record also preserves the audit
    // trail while ensuring consumers see the retired identity as unverified.
    // REQUIRED in remaining_accounts[1]; an agent never verified has an empty
    // system PDA there.
    let verification_info = ctx
        .remaining_accounts
        .get(1)
        .ok_or(CoordinationError::InvalidInput)?;
    let (expected_verification, _) =
        Pubkey::find_program_address(&[b"agent_verification", agent.key().as_ref()], &crate::ID);
    require!(
        verification_info.key() == expected_verification,
        CoordinationError::InvalidInput
    );
    if verification_info.owner == &crate::ID {
        let mut badge = {
            let data = verification_info.try_borrow_data()?;
            match AgentVerification::try_deserialize(&mut &data[..]) {
                Ok(verification) => {
                    require!(
                        verification.agent == agent.key(),
                        CoordinationError::InvalidInput
                    );
                    Some(verification)
                }
                Err(_) => {
                    // Historical close paths used Anchor's closed-account
                    // discriminator. Accept only that exact tombstone shape;
                    // every other program-owned decode failure is corruption.
                    require!(
                        data.len() >= 8 && data[..8] == [255u8; 8],
                        CoordinationError::CorruptedData
                    );
                    None
                }
            }
        };
        if let Some(verification) = badge.as_mut() {
            require!(
                verification_info.is_writable,
                CoordinationError::InvalidInput
            );
            verification.revoked = true;
            let mut data = verification_info.try_borrow_mut_data()?;
            verification.try_serialize(&mut &mut data[..])?;

            emit!(AgentVerificationRevoked {
                agent: agent.key(),
                revoked_by: ctx.accounts.authority.key(),
                timestamp: clock.unix_timestamp,
            });
        }
    } else {
        require!(
            verification_info.owner == &anchor_lang::system_program::ID
                && verification_info.data_is_empty(),
            CoordinationError::InvalidAccountOwner
        );
    }

    // Update protocol stats
    let config = &mut ctx.accounts.protocol_config;
    config.total_agents = config
        .total_agents
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let agent_id = agent.agent_id;
    let agent_authority = agent.authority;
    let registration_stake = agent.stake;

    // Preserve the AgentRegistration PDA as a permanent identity tombstone. Durable
    // children are keyed by this PDA, so closing it would let an unrelated wallet
    // re-create the same address and inherit control/payout rights. Refund EVERY
    // lamport above the current rent floor, not only tracked registration stake:
    // collaborative dispute cleanup historically credited claim rent directly to
    // the Agent PDA, and leaving that excess behind would strand it forever.
    let agent_info = ctx.accounts.agent.to_account_info();
    let authority_info = ctx.accounts.authority.to_account_info();
    let rent_minimum = Rent::get()?.minimum_balance(agent_info.data_len());
    let refundable = agent_info
        .lamports()
        .checked_sub(rent_minimum)
        .ok_or(CoordinationError::InsufficientFunds)?;
    require!(
        refundable >= registration_stake,
        CoordinationError::InsufficientFunds
    );
    if refundable > 0 {
        **agent_info.try_borrow_mut_lamports()? = rent_minimum;
        **authority_info.try_borrow_mut_lamports()? = authority_info
            .lamports()
            .checked_add(refundable)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    let agent = &mut ctx.accounts.agent;
    agent.stake = 0;
    agent.last_state_update = clock.unix_timestamp;
    agent.mark_identity_retired();

    emit!(AgentDeregistered {
        agent_id,
        authority: agent_authority,
        timestamp: clock.unix_timestamp,
    });

    // The account deliberately remains program-owned and rent exempt. Anchor's
    // `init` constraint therefore makes this agent_id impossible to re-register.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defendant_liability_is_exact_and_never_ages_out() {
        assert!(require_no_defendant_liabilities(0).is_ok());
        assert!(require_no_defendant_liabilities(1).is_err());
        assert!(require_no_defendant_liabilities(u8::MAX).is_err());
    }
}
