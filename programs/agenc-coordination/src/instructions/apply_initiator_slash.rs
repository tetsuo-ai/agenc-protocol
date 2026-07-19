//! Finalize a terminal dispute's initiator outcome, applying slashing on loss.
//!
//! # Permissionless Design
//! For provenance-tagged current disputes, anyone may finalize after resolution,
//! expiry, or cancellation. Rejected/cancelled initiators are slashed; approved
//! and expired outcomes are financial no-ops, and the exact tracked counter unit
//! is released. Historical zero-marker disputes retain the deployed seven-day,
//! loss-only policy and never touch the new counter, preventing retroactive
//! penalties or cross-consumption across the upgrade boundary.

use crate::errors::CoordinationError;
use crate::instructions::constants::PERCENT_BASE;
use crate::instructions::slash_helpers::{
    apply_reputation_penalty, calculate_approval_percentage, calculate_slash_amount,
    initiator_lost_dispute, transfer_slash_to_treasury, validate_slash_window,
};
use crate::state::{AgentRegistration, Dispute, DisputeStatus, ProtocolConfig};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ApplyInitiatorSlash<'info> {
    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,

    // NOTE (audit F-2): the Task account was REMOVED from this instruction. It was
    // only ever used for the `dispute.task == task.key()` binding (inherent in the
    // stored `dispute.task`) and an unused local — but hard-requiring it let a task
    // creator `close_task` after a lost dispute and permanently brick this finalizer,
    // evading their own initiator slash. The defendant-side finalizer still needs the
    // Task (reward_mint), so that side is protected by the `current_workers` deferral
    // instead; see resolve_dispute.
    #[account(
        mut,
        seeds = [b"agent", initiator_agent.agent_id.as_ref()],
        bump = initiator_agent.bump
    )]
    pub initiator_agent: Box<Account<'info, AgentRegistration>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Treasury account to receive slashed lamports
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

/// Interpret the terminal initiator outcome without consulting mutable protocol
/// thresholds. P6.3 writes exactly one of `(1,0)` / `(0,1)` for a resolver ruling;
/// expiry is no-fault and cancellation is an explicit initiator loss.
fn terminal_initiator_lost(
    status: DisputeStatus,
    votes_for: u64,
    votes_against: u64,
) -> Result<bool> {
    let approved = match status {
        DisputeStatus::Resolved => match (votes_for, votes_against) {
            (1, 0) => true,
            (0, 1) => false,
            _ => return Err(CoordinationError::CorruptedData.into()),
        },
        DisputeStatus::Expired | DisputeStatus::Cancelled => false,
        DisputeStatus::Active => return Err(CoordinationError::DisputeNotResolved.into()),
    };
    Ok(initiator_lost_dispute(status, approved))
}

/// Select the finalization policy from the retired-byte provenance marker.
///
/// Current tagged disputes have a non-expiring, all-terminal finalizer because
/// their exact agent-side counter keeps stake locked. Historical zero-marker
/// disputes retain the deployed policy exactly: only rejected/cancelled losses,
/// only during the original seven-day window, and no no-fault bookkeeping.
fn initiator_lost_under_provenance_policy(
    dispute: &Dispute,
    dispute_threshold: u8,
    clock: &Clock,
) -> Result<bool> {
    if dispute.initiator_outcome_counter_tracked()? {
        require!(
            matches!(
                dispute.status,
                DisputeStatus::Resolved | DisputeStatus::Expired | DisputeStatus::Cancelled
            ),
            CoordinationError::DisputeNotResolved
        );
        require!(dispute.resolved_at > 0, CoordinationError::InvalidInput);
        return terminal_initiator_lost(dispute.status, dispute.votes_for, dispute.votes_against);
    }

    require!(
        matches!(
            dispute.status,
            DisputeStatus::Resolved | DisputeStatus::Cancelled
        ),
        CoordinationError::DisputeNotResolved
    );
    validate_slash_window(dispute.resolved_at, clock)?;
    let initiator_lost = if dispute.status == DisputeStatus::Cancelled {
        true
    } else {
        let (_total_votes, approval_pct) =
            calculate_approval_percentage(dispute.votes_for, dispute.votes_against)?;
        approval_pct < dispute_threshold as u64
    };
    require!(initiator_lost, CoordinationError::InvalidInput);
    Ok(true)
}

/// Release only the counter unit proven to belong to this dispute. Historical
/// zero-marker outcomes may still be finalized, but can never consume a unit
/// incremented by a newer dispute from the same agent.
fn release_tracked_initiator_outcome(
    dispute: &Dispute,
    initiator_agent: &mut AgentRegistration,
) -> Result<()> {
    if dispute.initiator_outcome_counter_tracked()? {
        initiator_agent.note_initiator_outcome_finalized()?;
    }
    Ok(())
}

pub fn handler(ctx: Context<ApplyInitiatorSlash>) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::InvalidInput
    );

    // Clone the account handle before taking the long-lived mutable data borrow.
    // The handle is only used for the checked lamport transfer below.
    let initiator_agent_info = ctx.accounts.initiator_agent.to_account_info();
    let dispute = &mut ctx.accounts.dispute;
    let initiator_agent = &mut ctx.accounts.initiator_agent;
    let config = &ctx.accounts.protocol_config;

    // Exit/finalizer gate, matching the sibling apply_dispute_slash. A tagged
    // pending initiator-outcome counter does not age out, so its permissionless
    // finalizer must remain callable while entry is paused. Historical records
    // still enforce their original deadline below.
    check_version_compatible_for_exit(config)?;
    require!(
        !dispute.initiator_slash_applied,
        CoordinationError::SlashAlreadyApplied
    );

    let clock = Clock::get()?;

    require!(
        initiator_agent.key() == dispute.initiator,
        CoordinationError::UnauthorizedAgent
    );

    // Verify initiator was actually a participant in the task being disputed (fix #581)
    // The initiator must have been either:
    // 1. The task creator (dispute.initiator_authority == task.creator), OR
    // 2. A worker who had a valid claim at dispute initiation
    //
    // At dispute creation (initiate_dispute), participation is validated by checking:
    // - task.creator == authority (for creators), OR
    // - initiator_claim.is_some() (for workers with active claims)
    //
    // Verify the initiator_agent's authority matches the stored initiator_authority
    // from the dispute to ensure consistency. Participation itself is pinned by
    // initiate_dispute; `dispute.task` is the stored task binding (audit F-2 — the
    // Task account is no longer loaded here).
    require!(
        initiator_agent.authority == dispute.initiator_authority,
        CoordinationError::NotTaskParticipant
    );

    let counter_tracked = dispute.initiator_outcome_counter_tracked()?;
    let initiator_lost =
        initiator_lost_under_provenance_policy(dispute, config.dispute_threshold, &clock)?;

    if initiator_lost {
        // Only a losing outcome depends on slash configuration. Approved and
        // expired no-fault finalization must remain available even if mutable
        // legacy config is malformed, or an innocent initiator could be locked.
        require!(
            config.slash_percentage <= 100,
            CoordinationError::InvalidInput
        );
        // Preserve the old zero-marker behavior exactly, including the nonzero
        // stake requirement and u64 checked arithmetic. Tagged disputes use the
        // hardened zero-principal bookkeeping path so an exhausted stake cannot
        // permanently trap an otherwise valid counter unit.
        let slash_amount = if counter_tracked {
            calculate_slash_amount(
                initiator_agent.stake,
                initiator_agent.stake,
                config.slash_percentage,
            )?
        } else {
            require!(
                initiator_agent.stake > 0,
                CoordinationError::InsufficientStake
            );
            initiator_agent
                .stake
                .checked_mul(config.slash_percentage as u64)
                .ok_or(CoordinationError::ArithmeticOverflow)?
                .checked_div(PERCENT_BASE)
                .ok_or(CoordinationError::ArithmeticOverflow)?
        };

        // Apply reputation penalty before the lamport transfer to satisfy the
        // borrow checker. This still runs when slash_amount == 0.
        apply_reputation_penalty(initiator_agent, &clock)?;

        if slash_amount > 0 {
            initiator_agent.stake = initiator_agent
                .stake
                .checked_sub(slash_amount)
                .ok_or(CoordinationError::ArithmeticOverflow)?;

            transfer_slash_to_treasury(
                &initiator_agent_info,
                &ctx.accounts.treasury.to_account_info(),
                slash_amount,
            )?;
        }
    }

    dispute.initiator_slash_applied = true;
    release_tracked_initiator_outcome(dispute, initiator_agent)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_terminal_initiator_outcome_has_an_exact_policy() {
        assert!(!terminal_initiator_lost(DisputeStatus::Resolved, 1, 0).unwrap());
        assert!(terminal_initiator_lost(DisputeStatus::Resolved, 0, 1).unwrap());
        assert!(!terminal_initiator_lost(DisputeStatus::Expired, 0, 0).unwrap());
        assert!(terminal_initiator_lost(DisputeStatus::Cancelled, 0, 0).unwrap());
    }

    #[test]
    fn malformed_or_active_ruling_never_releases_the_counter() {
        for ruling in [(0, 0), (1, 1), (2, 0), (0, 2)] {
            assert!(terminal_initiator_lost(DisputeStatus::Resolved, ruling.0, ruling.1,).is_err());
        }
        assert!(terminal_initiator_lost(DisputeStatus::Active, 0, 0).is_err());
    }

    #[test]
    fn historical_no_fault_outcome_cannot_consume_a_new_counter_unit() {
        let mut initiator = AgentRegistration {
            active_dispute_votes: 1,
            ..AgentRegistration::default()
        };
        let historical = Dispute {
            total_voters: 0,
            status: DisputeStatus::Expired,
            ..Dispute::default()
        };
        release_tracked_initiator_outcome(&historical, &mut initiator).unwrap();
        assert_eq!(initiator.active_dispute_votes, 1);

        let current = Dispute {
            total_voters: Dispute::INITIATOR_OUTCOME_COUNTER_MARKER,
            status: DisputeStatus::Expired,
            ..Dispute::default()
        };
        release_tracked_initiator_outcome(&current, &mut initiator).unwrap();
        assert_eq!(initiator.active_dispute_votes, 0);

        // A tagged dispute with no corresponding unit is corruption, not a
        // saturating no-op that could be marked finalized.
        assert!(release_tracked_initiator_outcome(&current, &mut initiator).is_err());
        assert_eq!(initiator.active_dispute_votes, 0);

        let malformed = Dispute {
            total_voters: 1,
            ..Dispute::default()
        };
        assert!(release_tracked_initiator_outcome(&malformed, &mut initiator).is_err());
    }

    #[test]
    fn legacy_policy_never_revives_an_expired_penalty_or_no_fault_outcome() {
        let in_window = Clock {
            unix_timestamp: 604_900,
            ..Clock::default()
        };
        let after_window = Clock {
            unix_timestamp: 604_901,
            ..Clock::default()
        };
        let legacy_cancelled = Dispute {
            status: DisputeStatus::Cancelled,
            resolved_at: 100,
            total_voters: 0,
            ..Dispute::default()
        };
        assert!(initiator_lost_under_provenance_policy(&legacy_cancelled, 60, &in_window).unwrap());
        assert!(
            initiator_lost_under_provenance_policy(&legacy_cancelled, 60, &after_window).is_err()
        );

        for status in [DisputeStatus::Expired, DisputeStatus::Resolved] {
            let no_fault = Dispute {
                status,
                resolved_at: 100,
                votes_for: u64::from(status == DisputeStatus::Resolved),
                votes_against: 0,
                total_voters: 0,
                ..Dispute::default()
            };
            assert!(initiator_lost_under_provenance_policy(&no_fault, 60, &in_window).is_err());
        }
    }
}
