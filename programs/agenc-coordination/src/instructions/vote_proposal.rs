//! Vote on a governance proposal

use crate::errors::CoordinationError;
use crate::events::GovernanceVoteCast;
use crate::state::{
    AgentRegistration, AgentStatus, GovernanceVote, Proposal, ProposalStatus, ProtocolConfig,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

fn calculate_governance_vote_weight(
    stake: u64,
    reputation: u16,
    max_vote_weight: u64,
) -> Result<u64> {
    require!(
        reputation <= crate::instructions::constants::MAX_REPUTATION,
        CoordinationError::CorruptedData
    );
    let stake_weight = stake.min(max_vote_weight);
    let weighted = (stake_weight as u128)
        .checked_mul(reputation as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(crate::instructions::constants::MAX_REPUTATION as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let vote_weight = u64::try_from(weighted).map_err(|_| CoordinationError::VoteOverflow)?;
    Ok(if stake_weight > 0 {
        vote_weight.max(1)
    } else {
        0
    })
}

#[derive(Accounts)]
pub struct VoteProposal<'info> {
    #[account(
        mut,
        seeds = [b"proposal", proposal.proposer.as_ref(), proposal.nonce.to_le_bytes().as_ref()],
        bump = proposal.bump
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    #[account(
        init,
        payer = authority,
        space = GovernanceVote::SIZE,
        // One governance vote per authority per proposal (Sybil mitigation).
        seeds = [b"governance_vote", proposal.key().as_ref(), authority.key().as_ref()],
        bump
    )]
    pub vote: Account<'info, GovernanceVote>,

    #[account(
        mut,
        seeds = [b"agent", voter.agent_id.as_ref()],
        bump = voter.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub voter: Box<Account<'info, AgentRegistration>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<VoteProposal>, approve: bool) -> Result<()> {
    let proposal = &mut ctx.accounts.proposal;
    let vote = &mut ctx.accounts.vote;
    let voter = &mut ctx.accounts.voter;
    let config = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    check_version_compatible(config)?;

    // Verify proposal is active
    require!(
        proposal.status == ProposalStatus::Active,
        CoordinationError::ProposalNotActive
    );

    // Verify voting period hasn't ended
    require!(
        clock.unix_timestamp < proposal.voting_deadline,
        CoordinationError::ProposalVotingEnded
    );

    // Verify voter is active
    require!(
        voter.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    let rules = proposal.governance_rules()?;
    require!(
        voter.stake >= rules.min_voter_stake,
        CoordinationError::ProposalInsufficientStake
    );
    require!(
        voter.reputation >= rules.min_voter_reputation,
        CoordinationError::InsufficientReputation
    );
    require!(
        voter.reputation <= crate::instructions::constants::MAX_REPUTATION,
        CoordinationError::CorruptedData
    );
    require!(
        rules.voter_is_eligible(voter.stake, voter.reputation),
        CoordinationError::InvalidGovernanceParam
    );

    // Election-critical limits come only from the immutable Proposal snapshot,
    // never mutable/global configuration read midway through a vote.
    let vote_weight =
        calculate_governance_vote_weight(voter.stake, voter.reputation, rules.max_vote_weight)?;
    require!(
        vote_weight > 0,
        CoordinationError::ProposalInsufficientStake
    );

    // Record vote
    vote.proposal = proposal.key();
    vote.voter = voter.key();
    vote.approved = approve;
    vote.voted_at = clock.unix_timestamp;
    vote.vote_weight = vote_weight;
    vote.bump = ctx.bumps.vote;
    vote._reserved = [0u8; 8];

    // Update proposal vote counts
    if approve {
        proposal.votes_for = proposal
            .votes_for
            .checked_add(vote_weight)
            .ok_or(CoordinationError::VoteOverflow)?;
    } else {
        proposal.votes_against = proposal
            .votes_against
            .checked_add(vote_weight)
            .ok_or(CoordinationError::VoteOverflow)?;
    }
    proposal.total_voters = proposal
        .total_voters
        .checked_add(1)
        .ok_or(CoordinationError::VoteOverflow)?;

    // Lock the registration stake through the proposal's entire voting window.
    // GovernanceVote is keyed by wallet authority, so recycling one stake into
    // fresh wallet/agent pairs requires deregistering the current voter first.
    // Deregistration reads this field and adds its existing 24-hour cooldown;
    // storing the deadline (not merely "now") closes the multi-day recycling
    // window without changing the AgentRegistration layout.
    voter.last_vote_timestamp = voter.last_vote_timestamp.max(proposal.voting_deadline);

    emit!(GovernanceVoteCast {
        proposal: proposal.key(),
        voter: voter.key(),
        approved: approve,
        vote_weight,
        votes_for: proposal.votes_for,
        votes_against: proposal.votes_against,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ProposalGovernanceRules;

    #[test]
    fn zero_stake_never_counts_as_a_governance_participant() {
        assert_eq!(
            calculate_governance_vote_weight(0, 10_000, 1_000_000).unwrap(),
            0
        );
    }

    #[test]
    fn positive_stake_has_positive_bounded_weight() {
        assert_eq!(
            calculate_governance_vote_weight(1_000_000, 3_000, 1_000_000).unwrap(),
            300_000
        );
        assert_eq!(
            calculate_governance_vote_weight(100_000_000, 10_000, 1_000_000).unwrap(),
            1_000_000
        );
    }

    #[test]
    fn corrupt_reputation_fails_closed_and_u64_cap_is_supported() {
        assert!(calculate_governance_vote_weight(1, 10_001, 1).is_err());
        assert_eq!(
            calculate_governance_vote_weight(u64::MAX, 10_000, u64::MAX).unwrap(),
            u64::MAX
        );
    }

    #[test]
    fn fresh_permissionless_identities_are_not_governance_voters() {
        let rules = ProposalGovernanceRules {
            min_voter_stake: 10_000_000,
            min_voter_reputation: 5_000,
            max_vote_weight: 100_000_000,
            min_distinct_voters: 3,
            approval_threshold_bps: 5_000,
        };
        assert!(!rules.voter_is_eligible(33_333_334, 3_000));
        assert!(rules.voter_is_eligible(10_000_000, 5_000));
    }
}
