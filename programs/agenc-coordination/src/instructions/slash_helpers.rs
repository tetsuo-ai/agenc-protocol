//! Shared helper functions for dispute slashing.
//!
//! Extracts common logic between `apply_dispute_slash` and `apply_initiator_slash`
//! to reduce duplication while keeping each handler self-contained for its
//! specific preconditions.

use crate::errors::CoordinationError;
use crate::events::{reputation_reason, ReputationChanged};
use crate::instructions::constants::{PERCENT_BASE, REPUTATION_SLASH_LOSS};
use crate::state::{AgentRegistration, DisputeStatus, ResolutionType};
use anchor_lang::prelude::*;

/// Window for applying defendant-worker slashing after dispute resolution (7 days).
/// Initiator outcomes use a non-expiring permissionless finalizer so cancellation
/// cannot reset a timestamp and race registration-stake withdrawal.
pub const SLASH_WINDOW: i64 = 604_800;

/// A worker has an explicit adverse ruling only when the resolver approves a
/// full Refund. Complete vindicates the worker; Split is a partial/no-fault
/// outcome; rejection means the initiator failed to prove their case.
pub fn worker_lost_dispute(approved: bool, resolution_type: ResolutionType) -> bool {
    approved && resolution_type == ResolutionType::Refund
}

/// Initiator-side fault is explicit only when they cancel their own dispute or
/// the resolver rejects it. An approved Split is neutral and must not create a
/// synthetic loser merely to satisfy a binary slash path.
pub fn initiator_lost_dispute(status: DisputeStatus, approved: bool) -> bool {
    status == DisputeStatus::Cancelled || (status == DisputeStatus::Resolved && !approved)
}

/// Validates that the defendant-worker slash window has not expired.
pub fn validate_slash_window(resolved_at: i64, clock: &Clock) -> Result<()> {
    require!(
        clock.unix_timestamp <= resolved_at.saturating_add(SLASH_WINDOW),
        CoordinationError::SlashWindowExpired
    );
    Ok(())
}

/// Calculates the approval percentage from dispute votes.
///
/// Returns `(total_votes, approval_pct)`.
/// Errors if total_votes is 0 or on arithmetic overflow.
pub fn calculate_approval_percentage(votes_for: u64, votes_against: u64) -> Result<(u64, u64)> {
    let total_votes = votes_for
        .checked_add(votes_against)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(total_votes > 0, CoordinationError::InsufficientVotes);

    let approval_pct = (votes_for as u128)
        .checked_mul(PERCENT_BASE as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(total_votes as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    Ok((
        total_votes,
        u64::try_from(approval_pct).map_err(|_| CoordinationError::ArithmeticOverflow)?,
    ))
}

/// Calculates slash amount from stake snapshot and current stake.
///
/// Uses snapshot stake to prevent post-dispute withdrawal attacks, then caps by
/// current stake to avoid underflow if stake dropped before slash execution.
pub fn calculate_slash_amount(
    stake_at_dispute: u64,
    current_stake: u64,
    slash_percentage: u8,
) -> Result<u64> {
    require!(slash_percentage <= 100, CoordinationError::InvalidInput);

    let slash_amount = (stake_at_dispute as u128)
        .checked_mul(slash_percentage as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(PERCENT_BASE as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    Ok(u64::try_from(slash_amount)
        .map_err(|_| CoordinationError::ArithmeticOverflow)?
        .min(current_stake))
}

/// Applies a reputation penalty to an agent for losing a dispute.
/// Emits a `ReputationChanged` event if the reputation actually changed.
pub fn apply_reputation_penalty(agent: &mut AgentRegistration, clock: &Clock) -> Result<()> {
    let old_rep = agent.reputation;
    agent.reputation = agent.reputation.saturating_sub(REPUTATION_SLASH_LOSS);
    if agent.reputation != old_rep {
        emit!(ReputationChanged {
            agent_id: agent.agent_id,
            old_reputation: old_rep,
            new_reputation: agent.reputation,
            reason: reputation_reason::DISPUTE_SLASH,
            timestamp: clock.unix_timestamp,
        });
    }
    Ok(())
}

/// Transfers slashed lamports from an agent account to the treasury.
///
/// Only handles the raw lamport transfer. The caller is responsible for
/// updating `agent.stake` on the deserialized Account before calling this.
pub fn transfer_slash_to_treasury(
    agent_info: &AccountInfo,
    treasury_info: &AccountInfo,
    slash_amount: u64,
) -> Result<()> {
    if slash_amount > 0 {
        **agent_info.try_borrow_mut_lamports()? = agent_info
            .lamports()
            .checked_sub(slash_amount)
            .ok_or(CoordinationError::InsufficientFunds)?;

        **treasury_info.try_borrow_mut_lamports()? = treasury_info
            .lamports()
            .checked_add(slash_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash_math_handles_max_u64_stake() {
        assert_eq!(calculate_slash_amount(u64::MAX, u64::MAX, 0).unwrap(), 0);
        assert_eq!(
            calculate_slash_amount(u64::MAX, u64::MAX, 25).unwrap(),
            u64::MAX / 4
        );
        assert_eq!(
            calculate_slash_amount(u64::MAX, u64::MAX, 100).unwrap(),
            u64::MAX
        );
        assert!(calculate_slash_amount(u64::MAX, u64::MAX, 101).is_err());
    }

    #[test]
    fn approval_math_handles_max_u64_votes() {
        let (total, percentage) = calculate_approval_percentage(u64::MAX - 1, 1).unwrap();
        assert_eq!(total, u64::MAX);
        assert_eq!(percentage, 99);
    }

    #[test]
    fn explicit_worker_loss_excludes_split_and_complete() {
        assert!(worker_lost_dispute(true, ResolutionType::Refund));
        assert!(!worker_lost_dispute(true, ResolutionType::Complete));
        assert!(!worker_lost_dispute(true, ResolutionType::Split));
        for resolution in [
            ResolutionType::Refund,
            ResolutionType::Complete,
            ResolutionType::Split,
        ] {
            assert!(!worker_lost_dispute(false, resolution));
        }
    }

    #[test]
    fn initiator_loss_requires_rejection_or_cancellation() {
        assert!(initiator_lost_dispute(DisputeStatus::Resolved, false));
        assert!(initiator_lost_dispute(DisputeStatus::Cancelled, true));
        assert!(!initiator_lost_dispute(DisputeStatus::Resolved, true));
        assert!(!initiator_lost_dispute(DisputeStatus::Expired, false));
    }
}
