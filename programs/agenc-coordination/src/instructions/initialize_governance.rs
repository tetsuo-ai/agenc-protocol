//! Initialize governance configuration
//!
//! Creates the GovernanceConfig PDA that controls proposal creation parameters,
//! voting periods, execution delays, and quorum thresholds.
//!
//! Must be called by the protocol authority (matches ProtocolConfig.authority).

use crate::errors::CoordinationError;
use crate::events::GovernanceInitialized;
use crate::instructions::constants::{
    GOVERNANCE_VOTE_WEIGHT_CAP_MULTIPLIER, MIN_GOVERNANCE_DISTINCT_VOTERS,
    MIN_GOVERNANCE_QUORUM_WEIGHT, MIN_GOVERNANCE_VOTER_REPUTATION,
    MIN_GOVERNANCE_VOTER_STAKE_LAMPORTS,
};
use crate::state::{GovernanceConfig, ProposalGovernanceRules, ProtocolConfig};
use anchor_lang::prelude::*;

const GOVERNANCE_BASIS_POINTS: u128 = 10_000;

/// Compute the immutable quorum snapshot used by newly created proposals.
///
/// `ProtocolConfig.total_agents` is not a valid electorate denominator: it
/// counts agent identities of every status, while governance admits only Active
/// agents and deduplicates votes by wallet authority. An authority can also own
/// multiple registrations. Scaling quorum by that counter therefore lets
/// ineligible or duplicate identities make governance unreachable.
///
/// Instead, `quorum_bps` is applied to the maximum vote weight of the required
/// minimum distinct electorate, with a hard 100m vote-weight floor. Every rule
/// returned here is snapshotted into the Proposal account and used for its whole
/// election. The function rejects configurations whose three-voter capacity
/// cannot attain the hard floor; it never weakens the floor to fit bad inputs.
pub(crate) fn calculate_new_proposal_requirements(
    min_proposal_stake: u64,
    min_arbiter_stake: u64,
    quorum_bps: u16,
    approval_threshold_bps: u16,
) -> Result<(u64, ProposalGovernanceRules)> {
    require!(
        (1..=10_000).contains(&quorum_bps),
        CoordinationError::InvalidGovernanceParam
    );
    validate_approval_threshold(approval_threshold_bps)?;

    let max_vote_weight = min_arbiter_stake
        .checked_mul(GOVERNANCE_VOTE_WEIGHT_CAP_MULTIPLIER)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let min_voter_stake = min_proposal_stake.max(MIN_GOVERNANCE_VOTER_STAKE_LAMPORTS);
    require!(
        min_proposal_stake > 0 && min_voter_stake <= max_vote_weight,
        CoordinationError::InvalidGovernanceParam
    );

    let minimum_voters = MIN_GOVERNANCE_DISTINCT_VOTERS as u64;
    let minimum_electorate_capacity = max_vote_weight
        .checked_mul(minimum_voters)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        minimum_electorate_capacity >= MIN_GOVERNANCE_QUORUM_WEIGHT,
        CoordinationError::InvalidGovernanceParam
    );
    let minimum_stake_quorum = min_voter_stake
        .checked_mul(minimum_voters)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let scaled_numerator = (minimum_electorate_capacity as u128)
        .checked_mul(quorum_bps as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let percentage_quorum = scaled_numerator
        .checked_add(GOVERNANCE_BASIS_POINTS - 1)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(GOVERNANCE_BASIS_POINTS)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let percentage_quorum =
        u64::try_from(percentage_quorum).map_err(|_| CoordinationError::ArithmeticOverflow)?;

    let quorum = MIN_GOVERNANCE_QUORUM_WEIGHT
        .max(minimum_stake_quorum)
        .max(percentage_quorum);
    require!(
        quorum <= minimum_electorate_capacity,
        CoordinationError::InvalidGovernanceParam
    );

    let rules = ProposalGovernanceRules {
        min_voter_stake,
        min_voter_reputation: MIN_GOVERNANCE_VOTER_REPUTATION,
        max_vote_weight,
        min_distinct_voters: MIN_GOVERNANCE_DISTINCT_VOTERS,
        approval_threshold_bps,
    };
    rules.validate()?;
    Ok((quorum, rules))
}

#[derive(Accounts)]
pub struct InitializeGovernance<'info> {
    #[account(
        init,
        payer = authority,
        space = GovernanceConfig::SIZE,
        seeds = [b"governance"],
        bump
    )]
    pub governance_config: Account<'info, GovernanceConfig>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
        constraint = authority.key() == protocol_config.authority @ CoordinationError::UnauthorizedAgent,
        constraint = protocol_config.key() != governance_config.key() @ CoordinationError::InvalidInput
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        constraint = authority.key() != protocol_config.key() @ CoordinationError::InvalidInput,
        constraint = authority.key() != governance_config.key() @ CoordinationError::InvalidInput
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeGovernance>,
    voting_period: i64,
    execution_delay: i64,
    quorum_bps: u16,
    approval_threshold_bps: u16,
    min_proposal_stake: u64,
) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::UnauthorizedAgent
    );
    require!(
        ctx.accounts.governance_config.authority == Pubkey::default()
            && ctx.accounts.governance_config.total_proposals == 0,
        CoordinationError::InvalidInput
    );
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol_config.authority,
        CoordinationError::UnauthorizedAgent
    );
    require_keys_neq!(
        ctx.accounts.protocol_config.key(),
        ctx.accounts.governance_config.key(),
        CoordinationError::InvalidInput
    );
    // Validate voting period
    require!(
        voting_period > 0 && voting_period <= GovernanceConfig::MAX_VOTING_PERIOD,
        CoordinationError::InvalidGovernanceParam
    );

    // Validate execution delay
    require!(
        (0..=GovernanceConfig::MAX_EXECUTION_DELAY).contains(&execution_delay),
        CoordinationError::InvalidGovernanceParam
    );

    // Validate quorum (1-10000 bps)
    require!(
        quorum_bps > 0 && quorum_bps <= 10000,
        CoordinationError::InvalidGovernanceParam
    );

    validate_approval_threshold(approval_threshold_bps)?;

    calculate_new_proposal_requirements(
        min_proposal_stake,
        ctx.accounts.protocol_config.min_arbiter_stake,
        quorum_bps,
        approval_threshold_bps,
    )?;

    let governance = &mut ctx.accounts.governance_config;
    governance.authority = ctx.accounts.authority.key();
    governance.min_proposal_stake = min_proposal_stake;
    governance.voting_period = voting_period;
    governance.execution_delay = execution_delay;
    governance.quorum_bps = quorum_bps;
    governance.approval_threshold_bps = approval_threshold_bps;
    governance.total_proposals = 0;
    governance.bump = ctx.bumps.governance_config;
    governance._reserved = [0u8; 64];

    let clock = Clock::get()?;
    emit!(GovernanceInitialized {
        authority: governance.authority,
        voting_period,
        execution_delay,
        quorum_bps,
        approval_threshold_bps,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Governance uses a strict `votes_for / total_votes > threshold` comparison.
/// A 10_000 bps threshold can therefore never pass, even with unanimous votes,
/// and would permanently disable governance on a freshly initialized deployment.
fn validate_approval_threshold(approval_threshold_bps: u16) -> Result<()> {
    require!(
        (1..10_000).contains(&approval_threshold_bps),
        CoordinationError::InvalidGovernanceParam
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_threshold_must_be_reachable() {
        assert!(validate_approval_threshold(1).is_ok());
        assert!(validate_approval_threshold(5_000).is_ok());
        assert!(validate_approval_threshold(9_999).is_ok());
        assert!(validate_approval_threshold(0).is_err());
        assert!(validate_approval_threshold(10_000).is_err());
    }

    #[test]
    fn live_configuration_has_a_hard_reachable_snapshot() {
        let (quorum, rules) =
            calculate_new_proposal_requirements(10_000_000, 10_000_000, 300, 5_000).unwrap();
        assert_eq!(quorum, 100_000_000);
        assert_eq!(rules.min_voter_stake, 10_000_000);
        assert_eq!(rules.min_voter_reputation, 5_000);
        assert_eq!(rules.max_vote_weight, 100_000_000);
        assert_eq!(rules.min_distinct_voters, 3);
        assert_eq!(rules.approval_threshold_bps, 5_000);

        let (maximum_quorum, _) =
            calculate_new_proposal_requirements(10_000_000, 10_000_000, 10_000, 5_000).unwrap();
        assert_eq!(maximum_quorum, 300_000_000);
    }

    #[test]
    fn proposal_quorum_configuration_fails_closed_on_unreachable_math() {
        // A 10k per-voter cap gives only 30k of three-voter capacity. The hard
        // 100m quorum must reject, never silently weaken itself to 30k.
        assert!(calculate_new_proposal_requirements(1, 1_000, 1, 5_000).is_err());
        assert!(calculate_new_proposal_requirements(0, 10_000_000, 1, 5_000).is_err());
        assert!(calculate_new_proposal_requirements(100_000_001, 10_000_000, 1, 5_000,).is_err());
        assert!(calculate_new_proposal_requirements(1, 10_000_000, 0, 5_000).is_err());
        assert!(calculate_new_proposal_requirements(1, 10_000_000, 10_001, 5_000).is_err());
        assert!(calculate_new_proposal_requirements(1, 10_000_000, 1, 10_000).is_err());
        assert!(calculate_new_proposal_requirements(u64::MAX, u64::MAX, 10_000, 5_000).is_err());
    }

    #[test]
    fn proposal_quorum_stays_inside_reachable_bounds_at_numeric_edges() {
        for min_arbiter_stake in [10_000_000, 100_000_000, u64::MAX / 30] {
            let max_vote_weight = min_arbiter_stake.checked_mul(10).unwrap();
            for min_proposal_stake in [1, MIN_GOVERNANCE_VOTER_STAKE_LAMPORTS, max_vote_weight] {
                for quorum_bps in [1, 300, 9_999, 10_000] {
                    let (quorum, rules) = calculate_new_proposal_requirements(
                        min_proposal_stake,
                        min_arbiter_stake,
                        quorum_bps,
                        5_000,
                    )
                    .unwrap();
                    assert!(quorum >= MIN_GOVERNANCE_QUORUM_WEIGHT);
                    assert!(quorum >= rules.min_voter_stake * 3);
                    assert!(quorum <= max_vote_weight * 3);
                }
            }
        }
    }
}
