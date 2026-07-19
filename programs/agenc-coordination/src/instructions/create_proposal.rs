//! Create a governance proposal

use crate::errors::CoordinationError;
use crate::events::ProposalCreated;
use crate::instructions::constants::MAX_PROTOCOL_FEE_BPS;
use crate::instructions::initialize_governance::calculate_new_proposal_requirements;
use crate::instructions::rate_limit_helpers::is_valid_dispute_stake_limit;
use crate::state::{
    AgentRegistration, AgentStatus, GovernanceConfig, Proposal, ProposalStatus, ProposalType,
    ProtocolConfig,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

/// Maximum rate limit value (matches update_rate_limits.rs)
const MAX_RATE_LIMIT: u64 = 1000;

/// Maximum cooldown value: 1 week in seconds (matches update_rate_limits.rs)
const MAX_COOLDOWN: i64 = 604_800;

/// Require one canonical byte representation for every currently implemented
/// proposal type. Ignored trailing bytes are dangerous in signed governance:
/// clients may display the same effective action differently, and a later
/// program version could reinterpret bytes that today's executor ignores.
fn validate_proposal_payload_padding(
    proposal_type: ProposalType,
    payload: &[u8; 64],
) -> Result<()> {
    let unused = match proposal_type {
        ProposalType::ProtocolUpgrade => &payload[..],
        ProposalType::FeeChange => &payload[2..],
        ProposalType::TreasurySpend => &payload[40..],
        ProposalType::RateLimitChange => &payload[26..],
    };
    require!(
        unused.iter().all(|byte| *byte == 0),
        CoordinationError::InvalidProposalPayload
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateProposal<'info> {
    #[account(
        init,
        payer = authority,
        space = Proposal::SIZE,
        seeds = [b"proposal", proposer.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,

    #[account(
        seeds = [b"agent", proposer.agent_id.as_ref()],
        bump = proposer.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub proposer: Box<Account<'info, AgentRegistration>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"governance"],
        bump = governance_config.bump
    )]
    pub governance_config: Box<Account<'info, GovernanceConfig>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateProposal>,
    nonce: u64,
    proposal_type: u8,
    title_hash: [u8; 32],
    description_hash: [u8; 32],
    payload: [u8; 64],
    voting_period: i64,
) -> Result<()> {
    let proposer = &ctx.accounts.proposer;
    let config = &ctx.accounts.protocol_config;
    let governance = &mut ctx.accounts.governance_config;
    let clock = Clock::get()?;

    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::UnauthorizedAgent
    );
    require!(
        ctx.accounts.proposal.proposer == Pubkey::default()
            && ctx.accounts.proposal.created_at == 0
            && ctx.accounts.proposal.bump == 0,
        CoordinationError::InvalidInput
    );

    check_version_compatible(config)?;

    // Verify proposer is active
    require!(
        proposer.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    let (quorum, governance_rules) = calculate_new_proposal_requirements(
        governance.min_proposal_stake,
        config.min_arbiter_stake,
        governance.quorum_bps,
        governance.approval_threshold_bps,
    )?;

    // A proposer must be eligible to participate in the election they create.
    require!(
        proposer.stake >= governance_rules.min_voter_stake,
        CoordinationError::ProposalInsufficientStake
    );
    require!(
        proposer.reputation >= governance_rules.min_voter_reputation,
        CoordinationError::InsufficientReputation
    );
    require!(
        governance_rules.voter_is_eligible(proposer.stake, proposer.reputation),
        CoordinationError::InvalidGovernanceParam
    );
    require!(
        title_hash != [0u8; 32] && description_hash != [0u8; 32],
        CoordinationError::InvalidProposalPayload
    );

    // Validate proposal type
    let prop_type = match proposal_type {
        0 => ProposalType::ProtocolUpgrade,
        1 => ProposalType::FeeChange,
        2 => ProposalType::TreasurySpend,
        3 => ProposalType::RateLimitChange,
        _ => return Err(error!(CoordinationError::InvalidProposalType)),
    };
    validate_proposal_payload_padding(prop_type, &payload)?;

    // Validate payload at creation time for typed proposals
    match prop_type {
        ProposalType::FeeChange => {
            let fee_bps = u16::from_le_bytes([payload[0], payload[1]]);
            require!(
                fee_bps <= MAX_PROTOCOL_FEE_BPS,
                CoordinationError::InvalidProposalPayload
            );
        }
        ProposalType::RateLimitChange => {
            // Same bounds as execute_proposal.rs and update_rate_limits.rs
            let task_creation_cooldown = i64::from_le_bytes(
                payload[0..8]
                    .try_into()
                    .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
            );
            let max_tasks_per_24h = payload[8];
            let dispute_initiation_cooldown = i64::from_le_bytes(
                payload[9..17]
                    .try_into()
                    .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
            );
            let max_disputes_per_24h = payload[17];

            require!(
                (1..=MAX_COOLDOWN).contains(&task_creation_cooldown),
                CoordinationError::InvalidProposalPayload
            );
            require!(
                (1..=MAX_COOLDOWN).contains(&dispute_initiation_cooldown),
                CoordinationError::InvalidProposalPayload
            );
            require!(
                max_tasks_per_24h >= 1,
                CoordinationError::InvalidProposalPayload
            );
            require!(
                (max_tasks_per_24h as u64) <= MAX_RATE_LIMIT,
                CoordinationError::InvalidProposalPayload
            );
            require!(
                max_disputes_per_24h >= 1,
                CoordinationError::InvalidProposalPayload
            );
            require!(
                (max_disputes_per_24h as u64) <= MAX_RATE_LIMIT,
                CoordinationError::InvalidProposalPayload
            );
            // Bind the exact shared dispute-stake policy at creation so an
            // unexecutable payload can never become a stranded Active proposal.
            let min_stake_for_dispute = u64::from_le_bytes(
                payload[18..26]
                    .try_into()
                    .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
            );
            require!(
                is_valid_dispute_stake_limit(min_stake_for_dispute, config.min_agent_stake),
                CoordinationError::InvalidProposalPayload
            );
        }
        ProposalType::TreasurySpend => {
            let recipient_bytes: [u8; 32] = payload[0..32]
                .try_into()
                .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?;
            let recipient = Pubkey::new_from_array(recipient_bytes);
            let amount = u64::from_le_bytes(
                payload[32..40]
                    .try_into()
                    .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
            );
            require!(
                recipient != Pubkey::default() && amount > 0,
                CoordinationError::InvalidProposalPayload
            );
        }
        ProposalType::ProtocolUpgrade => {}
    }

    // Voting period: the governance config value is BOTH the default and the floor.
    // A caller-provided period is capped at MAX and floored at the governance
    // default (audit: previously a proposer could pass voting_period = 1 and close
    // voting before the electorate could react — a captured-governance vector;
    // a mainnet proposal already ran at 600s).
    let effective_voting_period = if voting_period > 0 {
        voting_period
            .min(GovernanceConfig::MAX_VOTING_PERIOD)
            .max(governance.voting_period)
    } else {
        governance.voting_period
    };

    let voting_deadline = clock
        .unix_timestamp
        .checked_add(effective_voting_period)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let execution_after = voting_deadline
        .checked_add(governance.execution_delay)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let proposal = &mut ctx.accounts.proposal;
    proposal.proposer = ctx.accounts.proposer.key();
    proposal.proposer_authority = ctx.accounts.authority.key();
    proposal.nonce = nonce;
    proposal.proposal_type = prop_type;
    proposal.title_hash = title_hash;
    proposal.description_hash = description_hash;
    proposal.payload = payload;
    proposal.status = ProposalStatus::Active;
    proposal.created_at = clock.unix_timestamp;
    proposal.voting_deadline = voting_deadline;
    proposal.execution_after = execution_after;
    proposal.executed_at = 0;
    proposal.votes_for = 0;
    proposal.votes_against = 0;
    proposal.total_voters = 0;
    proposal.quorum = quorum;
    proposal.bump = ctx.bumps.proposal;
    proposal.set_governance_rules(governance_rules)?;

    // Increment governance proposal counter
    governance.total_proposals = governance
        .total_proposals
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(ProposalCreated {
        proposer: proposer.key(),
        proposal_type,
        title_hash,
        voting_deadline,
        quorum,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_governance_payloads_reject_hidden_trailing_bytes() {
        for (proposal_type, first_unused) in [
            (ProposalType::ProtocolUpgrade, 0usize),
            (ProposalType::FeeChange, 2),
            (ProposalType::TreasurySpend, 40),
            (ProposalType::RateLimitChange, 26),
        ] {
            let mut canonical = [0u8; 64];
            assert!(validate_proposal_payload_padding(proposal_type, &canonical).is_ok());
            canonical[first_unused] = 1;
            assert!(validate_proposal_payload_padding(proposal_type, &canonical).is_err());
        }

        let mut fee = [0u8; 64];
        fee[..2].copy_from_slice(&500u16.to_le_bytes());
        assert!(validate_proposal_payload_padding(ProposalType::FeeChange, &fee).is_ok());
    }
}
