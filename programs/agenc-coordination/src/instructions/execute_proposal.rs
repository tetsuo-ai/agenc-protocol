//! Execute a governance proposal after voting period + timelock
//!
//! Dual outcome: if quorum or majority not met, the proposal is marked Defeated.
//! If quorum + majority are met and the timelock has elapsed, the proposal is executed.

use crate::errors::CoordinationError;
use crate::events::ProposalExecuted;
use crate::instructions::constants::MAX_PROTOCOL_FEE_BPS;
use crate::instructions::rate_limit_helpers::is_valid_dispute_stake_limit;
use crate::state::{GovernanceConfig, Proposal, ProposalStatus, ProposalType, ProtocolConfig};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

/// Maximum rate limit value (matches update_rate_limits.rs)
const MAX_RATE_LIMIT: u64 = 1000;

/// Maximum cooldown value: 1 week in seconds (matches update_rate_limits.rs)
const MAX_COOLDOWN: i64 = 604_800;

/// A passed proposal cannot retain executable authority forever. Seven days is
/// deliberately longer than the normal timelock while still bounding stale
/// treasury/config authority.
const PROPOSAL_EXECUTION_WINDOW: i64 = 7 * 24 * 60 * 60;

fn outcome_requirements_met(
    total_votes: u64,
    votes_for: u64,
    quorum: u64,
    total_voters: u16,
    min_distinct_voters: u16,
    approval_threshold_bps: u16,
) -> Result<bool> {
    if total_votes == 0 || total_votes < quorum || total_voters < min_distinct_voters {
        return Ok(false);
    }
    let lhs = (votes_for as u128)
        .checked_mul(10_000)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let rhs = (total_votes as u128)
        .checked_mul(approval_threshold_bps as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(lhs > rhs)
}

fn proposal_requires_protocol_multisig(proposal_type: ProposalType) -> bool {
    matches!(
        proposal_type,
        ProposalType::FeeChange | ProposalType::RateLimitChange
    )
}

#[derive(Accounts)]
pub struct ExecuteProposal<'info> {
    #[account(
        mut,
        seeds = [b"proposal", proposal.proposer.as_ref(), proposal.nonce.to_le_bytes().as_ref()],
        bump = proposal.bump
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"governance"],
        bump = governance_config.bump
    )]
    pub governance_config: Box<Account<'info, GovernanceConfig>>,

    /// Authority can be anyone (permissionless after voting ends)
    pub authority: Signer<'info>,

    /// Treasury account for TreasurySpend proposals. The optional signer type
    /// makes custody consent explicit in generated account metas.
    /// Must match protocol_config.treasury and be system owned.
    #[account(mut)]
    pub treasury: Option<Signer<'info>>,

    /// CHECK: Recipient for TreasurySpend proposals.
    /// Validated from proposal payload in handler.
    #[account(mut)]
    pub recipient: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ExecuteProposal>) -> Result<()> {
    let proposal = &mut ctx.accounts.proposal;
    let config = &mut ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    check_version_compatible(config)?;
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::InvalidInput
    );

    // Verify proposal is active
    require!(
        proposal.status == ProposalStatus::Active,
        CoordinationError::ProposalNotActive
    );

    // Verify voting period has ended
    require!(
        clock.unix_timestamp >= proposal.voting_deadline,
        CoordinationError::ProposalVotingNotEnded
    );

    // Schema-0 proposals are historical terminal records after the revision-5
    // zero-Active cutover. If one appears Active, fail closed into Defeated: it
    // remains permissionlessly terminalizable but can never execute under the
    // retired weak election rules. Corrupt rule snapshots receive the same safe
    // terminal treatment.
    let rules = match proposal.governance_rules() {
        Ok(rules) => rules,
        Err(_) => {
            proposal.status = ProposalStatus::Defeated;
            proposal.executed_at = clock.unix_timestamp;
            emit!(ProposalExecuted {
                proposal: proposal.key(),
                proposal_type: proposal.proposal_type as u8,
                votes_for: proposal.votes_for,
                votes_against: proposal.votes_against,
                total_voters: proposal.total_voters,
                timestamp: clock.unix_timestamp,
            });
            return Ok(());
        }
    };

    // Check the immutable snapshotted quorum, distinct-voter floor, and approval
    // threshold. GovernanceConfig cannot retroactively change this election.
    let total_votes = proposal
        .votes_for
        .checked_add(proposal.votes_against)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let outcome_met = outcome_requirements_met(
        total_votes,
        proposal.votes_for,
        proposal.quorum,
        proposal.total_voters,
        rules.min_distinct_voters,
        rules.approval_threshold_bps,
    )?;

    if !outcome_met {
        proposal.status = ProposalStatus::Defeated;
        proposal.executed_at = clock.unix_timestamp;

        emit!(ProposalExecuted {
            proposal: proposal.key(),
            proposal_type: proposal.proposal_type as u8,
            votes_for: proposal.votes_for,
            votes_against: proposal.votes_against,
            total_voters: proposal.total_voters,
            timestamp: clock.unix_timestamp,
        });

        return Ok(());
    }

    // Verify execution timelock has elapsed
    require!(
        clock.unix_timestamp >= proposal.execution_after,
        CoordinationError::TimelockNotElapsed
    );

    let execution_deadline = proposal
        .execution_after
        .checked_add(PROPOSAL_EXECUTION_WINDOW)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    if clock.unix_timestamp > execution_deadline {
        proposal.status = ProposalStatus::Defeated;
        proposal.executed_at = clock.unix_timestamp;
        emit!(ProposalExecuted {
            proposal: proposal.key(),
            proposal_type: proposal.proposal_type as u8,
            votes_for: proposal.votes_for,
            votes_against: proposal.votes_against,
            total_voters: proposal.total_voters,
            timestamp: clock.unix_timestamp,
        });
        return Ok(());
    }

    // Permissionless identity registration and refundable stake make voting an
    // unsafe sole authority for protocol configuration. A successful FeeChange
    // or RateLimitChange is therefore dual-control: the election must pass AND
    // the current ProtocolConfig M-of-N must co-sign this execution. Perform the
    // check only immediately before mutation so failed/expired proposals remain
    // permissionlessly terminalizable.
    if proposal_requires_protocol_multisig(proposal.proposal_type) {
        let unique_signers = unique_account_infos(ctx.remaining_accounts);
        require_multisig_threshold(config, &unique_signers)?;
    }

    // Execute based on proposal type
    match proposal.proposal_type {
        ProposalType::FeeChange => execute_fee_change(proposal, config)?,
        ProposalType::TreasurySpend => execute_treasury_spend(
            proposal,
            config,
            ctx.accounts.treasury.as_ref(),
            ctx.accounts.recipient.as_ref(),
            &ctx.accounts.system_program,
        )?,
        ProposalType::RateLimitChange => execute_rate_limit_change(proposal, config)?,
        ProposalType::ProtocolUpgrade => {
            // Protocol upgrade is a signaling marker — actual upgrade handled externally
        }
    }

    proposal.status = ProposalStatus::Executed;
    proposal.executed_at = clock.unix_timestamp;

    emit!(ProposalExecuted {
        proposal: proposal.key(),
        proposal_type: proposal.proposal_type as u8,
        votes_for: proposal.votes_for,
        votes_against: proposal.votes_against,
        total_voters: proposal.total_voters,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

fn execute_fee_change(proposal: &Proposal, config: &mut ProtocolConfig) -> Result<()> {
    let new_fee_bps = u16::from_le_bytes([proposal.payload[0], proposal.payload[1]]);
    require!(
        new_fee_bps <= MAX_PROTOCOL_FEE_BPS,
        CoordinationError::InvalidProposalPayload
    );
    config.protocol_fee_bps = new_fee_bps;
    Ok(())
}

fn execute_treasury_spend<'info>(
    proposal: &Proposal,
    config: &ProtocolConfig,
    treasury_opt: Option<&Signer<'info>>,
    recipient_opt: Option<&UncheckedAccount<'info>>,
    system_prog: &Program<'info, System>,
) -> Result<()> {
    let recipient_bytes: [u8; 32] = proposal.payload[0..32]
        .try_into()
        .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?;
    let recipient_key = Pubkey::from(recipient_bytes);

    // Reject zero-pubkey recipient to prevent sending SOL to an unspendable address
    require!(
        recipient_key != Pubkey::default(),
        CoordinationError::InvalidProposalPayload
    );

    let amount = u64::from_le_bytes(
        proposal.payload[32..40]
            .try_into()
            .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
    );

    let treasury = treasury_opt.ok_or(error!(CoordinationError::InvalidProposalPayload))?;
    let recipient = recipient_opt.ok_or(error!(CoordinationError::InvalidProposalPayload))?;

    require!(
        treasury.key() == config.treasury,
        CoordinationError::InvalidProposalPayload
    );
    require!(
        recipient.key() == recipient_key,
        CoordinationError::InvalidProposalPayload
    );

    require!(
        treasury.lamports() >= amount,
        CoordinationError::TreasuryInsufficientBalance
    );

    require!(
        treasury.owner == &system_program::ID && treasury.is_signer,
        CoordinationError::TreasuryNotSpendable
    );
    system_program::transfer(
        CpiContext::new(
            system_prog.to_account_info(),
            system_program::Transfer {
                from: treasury.to_account_info(),
                to: recipient.to_account_info(),
            },
        ),
        amount,
    )?;
    Ok(())
}

fn execute_rate_limit_change(proposal: &Proposal, config: &mut ProtocolConfig) -> Result<()> {
    // Payload layout:
    // [0..8]   task_creation_cooldown (i64 LE)
    // [8]      max_tasks_per_24h (u8)
    // [9..17]  dispute_initiation_cooldown (i64 LE)
    // [17]     max_disputes_per_24h (u8)
    // [18..26] min_stake_for_dispute (u64 LE)
    let task_creation_cooldown = i64::from_le_bytes(
        proposal.payload[0..8]
            .try_into()
            .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
    );
    let max_tasks_per_24h = proposal.payload[8];
    let dispute_initiation_cooldown = i64::from_le_bytes(
        proposal.payload[9..17]
            .try_into()
            .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
    );
    let max_disputes_per_24h = proposal.payload[17];
    let min_stake_for_dispute = u64::from_le_bytes(
        proposal.payload[18..26]
            .try_into()
            .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
    );

    // Validate bounds (same as update_rate_limits.rs)
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

    // Enforce the exact shared absolute + minimum-registration-relative cap.
    require!(
        is_valid_dispute_stake_limit(min_stake_for_dispute, config.min_agent_stake),
        CoordinationError::InvalidProposalPayload
    );

    config.task_creation_cooldown = task_creation_cooldown;
    config.max_tasks_per_24h = max_tasks_per_24h;
    config.dispute_initiation_cooldown = dispute_initiation_cooldown;
    config.max_disputes_per_24h = max_disputes_per_24h;
    config.min_stake_for_dispute = min_stake_for_dispute;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_heavily_weighted_voter_cannot_execute() {
        assert!(!outcome_requirements_met(1_000_000, 1_000_000, 10, 1, 3, 5_000).unwrap());
    }

    #[test]
    fn two_fully_weighted_voters_cannot_execute() {
        assert!(
            !outcome_requirements_met(200_000_000, 200_000_000, 100_000_000, 2, 3, 5_000,).unwrap()
        );
    }

    #[test]
    fn three_distinct_voters_can_meet_weight_and_approval() {
        assert!(
            outcome_requirements_met(100_000_000, 90_000_000, 100_000_000, 3, 3, 5_000).unwrap()
        );
    }

    #[test]
    fn distinct_voters_do_not_replace_quorum_or_approval() {
        assert!(!outcome_requirements_met(9, 9, 10, 3, 3, 5_000).unwrap());
        assert!(!outcome_requirements_met(10, 5, 10, 3, 3, 5_000).unwrap());
    }

    #[test]
    fn only_protocol_mutations_need_dual_control() {
        assert!(proposal_requires_protocol_multisig(ProposalType::FeeChange));
        assert!(proposal_requires_protocol_multisig(
            ProposalType::RateLimitChange
        ));
        assert!(!proposal_requires_protocol_multisig(
            ProposalType::TreasurySpend
        ));
        assert!(!proposal_requires_protocol_multisig(
            ProposalType::ProtocolUpgrade
        ));
    }
}
