//! One-time governance repair for an initiator-outcome counter unit lost
//! through the duplicate writable agent account defect.
//!
//! Before the alias guard in `initiate_dispute`, a worker could pass its own
//! AgentRegistration as both `agent` and the optional `worker_agent`. Anchor
//! wrote the unmodified `worker_agent` copy back after `agent`, so the new
//! dispute carried the counter-tracked marker while the initiator's
//! `active_dispute_votes` and `disputes_as_defendant` increments were lost.
//! The guard prevents new cases. This instruction repairs a historical case.
//!
//! The defendant side needs no repair once every affected dispute has
//! exited: expiry and cancellation decrement `disputes_as_defendant` with
//! saturating arithmetic, which absorbed the missing unit. The initiator side
//! cannot heal itself: `apply_initiator_slash` decrements with checked
//! arithmetic and fails with `CorruptedData`, so one tracked outcome of the
//! affected agent can never be finalized. This instruction restores exactly
//! that one unit, then the ordinary permissionless finalizer consumes it.
//!
//! Soundness: in every state the program can produce, an agent's
//! `active_dispute_votes` is at least the number of its counter-tracked
//! disputes whose initiator outcome is not yet finalized. A zero counter while
//! such a finalizable outcome exists therefore proves a lost unit, and adding
//! one unit cannot create a liability the agent does not owe. The repair is
//! threshold-approved by the ProtocolConfig owners, records the historical
//! incident transaction signature, and its receipt PDA is seeded by the
//! incident dispute, so it can apply at most once per incident.

use crate::errors::CoordinationError;
use crate::events::DisputeInitiatorCounterRepaired;
use crate::instructions::apply_initiator_slash::terminal_initiator_lost;
use crate::state::{AgentRegistration, Dispute, DisputeCounterRepair, ProtocolConfig};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RepairDisputeInitiatorCounter<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// The dispute whose initiation lost the counter units. Its address seeds
    /// the one-time receipt. Read-only.
    #[account(
        seeds = [b"dispute", incident_dispute.dispute_id.as_ref()],
        bump = incident_dispute.bump
    )]
    pub incident_dispute: Box<Account<'info, Dispute>>,

    /// The terminal dispute of the same initiator whose outcome cannot be
    /// finalized because the initiator holds no counter unit. This is the
    /// incident itself unless another dispute of the same initiator finalized
    /// first and consumed the only unit. Read-only; may alias `incident_dispute`.
    #[account(
        seeds = [b"dispute", pending_dispute.dispute_id.as_ref()],
        bump = pending_dispute.bump
    )]
    pub pending_dispute: Box<Account<'info, Dispute>>,

    #[account(
        mut,
        seeds = [b"agent", initiator_agent.agent_id.as_ref()],
        bump = initiator_agent.bump
    )]
    pub initiator_agent: Box<Account<'info, AgentRegistration>>,

    /// One-time receipt. `init` fails if this incident was already repaired.
    #[account(
        init,
        payer = authority,
        space = DisputeCounterRepair::SIZE,
        seeds = [b"dispute_counter_repair", incident_dispute.key().as_ref()],
        bump
    )]
    pub repair_receipt: Box<Account<'info, DisputeCounterRepair>>,

    /// Protocol authority proposes and pays; the configured M-of-N
    /// ProtocolConfig owners approve through remaining accounts.
    #[account(
        mut,
        constraint = authority.key() == protocol_config.authority
            @ CoordinationError::UnauthorizedAgent
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Validate the incident shape: a counter-tracked, worker-initiated dispute in
/// which the initiator agent held both the initiator and defendant roles, so
/// both lost increments belonged to `agent_key`.
fn validate_incident(
    incident: &Dispute,
    agent_key: &Pubkey,
    agent_authority: &Pubkey,
) -> Result<()> {
    require!(
        incident.initiator_outcome_counter_tracked()?,
        CoordinationError::DisputeCounterRepairNotApplicable
    );
    require!(
        incident.initiator == *agent_key
            && incident.defendant == *agent_key
            && !incident.initiated_by_creator
            && incident.initiator_authority == *agent_authority,
        CoordinationError::DisputeCounterRepairNotApplicable
    );
    Ok(())
}

/// Validate that `pending` is a counter-tracked outcome of the same initiator
/// that the standard finalizer would accept once a unit exists.
fn validate_pending(pending: &Dispute, agent_key: &Pubkey, agent_authority: &Pubkey) -> Result<()> {
    require!(
        pending.initiator_outcome_counter_tracked()?,
        CoordinationError::DisputeCounterRepairNotApplicable
    );
    require!(
        pending.initiator == *agent_key && pending.initiator_authority == *agent_authority,
        CoordinationError::DisputeCounterRepairNotApplicable
    );
    require!(
        !pending.initiator_slash_applied,
        CoordinationError::DisputeCounterRepairNotApplicable
    );
    require!(
        pending.resolved_at > 0,
        CoordinationError::DisputeNotResolved
    );
    // Same terminal-outcome decoder as `apply_initiator_slash`: Active and
    // SettlementPending are not finalizable yet, and a malformed ruling
    // would strand the restored unit.
    terminal_initiator_lost(pending.status, pending.votes_for, pending.votes_against)?;
    Ok(())
}

pub fn handler(
    ctx: Context<RepairDisputeInitiatorCounter>,
    incident_signature: [u8; 64],
) -> Result<()> {
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;

    require!(
        incident_signature != [0u8; 64],
        CoordinationError::InvalidInput
    );

    let agent_key = ctx.accounts.initiator_agent.key();
    let agent_authority = ctx.accounts.initiator_agent.authority;
    let incident_key = ctx.accounts.incident_dispute.key();
    let pending_key = ctx.accounts.pending_dispute.key();

    validate_incident(
        ctx.accounts.incident_dispute.as_ref(),
        &agent_key,
        &agent_authority,
    )?;
    validate_pending(
        ctx.accounts.pending_dispute.as_ref(),
        &agent_key,
        &agent_authority,
    )?;
    // A distinct pending dispute is accepted only after the incident itself
    // finalized: that finalization consumed the unit owned by the pending
    // dispute, which moved the single-unit deficit onto it.
    if pending_key != incident_key {
        require!(
            ctx.accounts.incident_dispute.initiator_slash_applied,
            CoordinationError::DisputeCounterRepairNotApplicable
        );
    }

    let agent = ctx.accounts.initiator_agent.as_mut();
    // Proven deficit: a finalizable tracked outcome is pending while the
    // counter holds no unit. Any nonzero counter fails closed; finalize the
    // outcomes that do own a unit first.
    require!(
        agent.active_dispute_votes == 0,
        CoordinationError::DisputeCounterNotDeficient
    );
    agent.note_dispute_initiated()?;
    let pending_initiator_outcomes = agent.active_dispute_votes;

    let clock = Clock::get()?;
    let receipt = ctx.accounts.repair_receipt.as_mut();
    receipt.incident_dispute = incident_key;
    receipt.pending_dispute = pending_key;
    receipt.initiator_agent = agent_key;
    receipt.incident_signature = incident_signature;
    receipt.repaired_by = ctx.accounts.authority.key();
    receipt.repaired_at = clock.unix_timestamp;
    receipt.initiator_units_restored = 1;
    receipt.bump = ctx.bumps.repair_receipt;

    emit!(DisputeInitiatorCounterRepaired {
        incident_dispute: incident_key,
        pending_dispute: pending_key,
        initiator_agent: agent_key,
        incident_signature,
        pending_initiator_outcomes,
        repaired_by: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::DisputeStatus;

    fn tracked_worker_dispute(agent: Pubkey, authority: Pubkey) -> Dispute {
        Dispute {
            initiator: agent,
            defendant: agent,
            initiator_authority: authority,
            initiated_by_creator: false,
            total_voters: Dispute::INITIATOR_OUTCOME_COUNTER_MARKER,
            status: DisputeStatus::Expired,
            resolved_at: 100,
            ..Dispute::default()
        }
    }

    #[test]
    fn incident_must_be_a_tracked_worker_path_dispute_of_the_agent() {
        let agent = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let incident = tracked_worker_dispute(agent, authority);
        assert!(validate_incident(&incident, &agent, &authority).is_ok());

        let legacy = Dispute {
            total_voters: 0,
            ..incident.clone()
        };
        assert!(validate_incident(&legacy, &agent, &authority).is_err());

        let malformed_marker = Dispute {
            total_voters: 1,
            ..incident.clone()
        };
        assert!(validate_incident(&malformed_marker, &agent, &authority).is_err());

        let creator_path = Dispute {
            initiated_by_creator: true,
            ..incident.clone()
        };
        assert!(validate_incident(&creator_path, &agent, &authority).is_err());

        let other_defendant = Dispute {
            defendant: Pubkey::new_unique(),
            ..incident.clone()
        };
        assert!(validate_incident(&other_defendant, &agent, &authority).is_err());

        let other_initiator = Dispute {
            initiator: Pubkey::new_unique(),
            ..incident.clone()
        };
        assert!(validate_incident(&other_initiator, &agent, &authority).is_err());

        assert!(validate_incident(&incident, &agent, &Pubkey::new_unique()).is_err());
    }

    #[test]
    fn pending_must_be_an_unfinalized_finalizable_tracked_outcome() {
        let agent = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let pending = tracked_worker_dispute(agent, authority);
        assert!(validate_pending(&pending, &agent, &authority).is_ok());

        let cancelled = Dispute {
            status: DisputeStatus::Cancelled,
            ..pending.clone()
        };
        assert!(validate_pending(&cancelled, &agent, &authority).is_ok());

        for ruling in [(1, 0), (0, 1)] {
            let resolved = Dispute {
                status: DisputeStatus::Resolved,
                votes_for: ruling.0,
                votes_against: ruling.1,
                ..pending.clone()
            };
            assert!(validate_pending(&resolved, &agent, &authority).is_ok());
        }
        for ruling in [(0, 0), (1, 1), (2, 0)] {
            let malformed = Dispute {
                status: DisputeStatus::Resolved,
                votes_for: ruling.0,
                votes_against: ruling.1,
                ..pending.clone()
            };
            assert!(validate_pending(&malformed, &agent, &authority).is_err());
        }

        for status in [DisputeStatus::Active, DisputeStatus::SettlementPending] {
            let open = Dispute {
                status,
                ..pending.clone()
            };
            assert!(validate_pending(&open, &agent, &authority).is_err());
        }

        let finalized = Dispute {
            initiator_slash_applied: true,
            ..pending.clone()
        };
        assert!(validate_pending(&finalized, &agent, &authority).is_err());

        let unresolved_timestamp = Dispute {
            resolved_at: 0,
            ..pending.clone()
        };
        assert!(validate_pending(&unresolved_timestamp, &agent, &authority).is_err());

        let legacy = Dispute {
            total_voters: 0,
            ..pending.clone()
        };
        assert!(validate_pending(&legacy, &agent, &authority).is_err());

        let other_initiator = Dispute {
            initiator: Pubkey::new_unique(),
            ..pending.clone()
        };
        assert!(validate_pending(&other_initiator, &agent, &authority).is_err());

        assert!(validate_pending(&pending, &agent, &Pubkey::new_unique()).is_err());
    }
}
