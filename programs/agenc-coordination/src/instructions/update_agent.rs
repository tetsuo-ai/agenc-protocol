//! Update an existing agent's registration
//!
//! Note: Suspending an agent does not automatically cancel their active tasks.
//! Tasks may become frozen if workers cannot complete them.
//! Consider canceling or reassigning tasks before suspension.

use crate::errors::CoordinationError;
use crate::events::AgentUpdated;
use crate::instructions::validation::validate_endpoint;
use crate::state::{AgentRegistration, AgentStatus};
use crate::utils::validation::validate_string_input;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    #[account(
        mut,
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub agent: Account<'info, AgentRegistration>,

    pub authority: Signer<'info>,
}

/// Cooldown period between agent updates (1 minute)
const UPDATE_COOLDOWN: i64 = 60;

/// Maximum length for agent metadata URI
const MAX_METADATA_URI_LEN: usize = 128;

pub fn handler(
    ctx: Context<UpdateAgent>,
    capabilities: Option<u64>,
    endpoint: Option<String>,
    metadata_uri: Option<String>,
    status: Option<u8>,
) -> Result<()> {
    let agent = &mut ctx.accounts.agent;
    let clock = Clock::get()?;

    // Deregistration leaves a permanent identity tombstone so durable child PDAs
    // cannot be inherited by an agent_id squatter. The former authority must not be
    // able to reactivate that tombstone without paying a fresh registration stake or
    // restoring ProtocolConfig.total_agents.
    require!(
        !agent.is_retired_identity(),
        CoordinationError::AgentNotActive
    );

    // Rate limit: enforce cooldown between updates
    let next_update_at = agent
        .last_state_update
        .checked_add(UPDATE_COOLDOWN)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        clock.unix_timestamp >= next_update_at,
        CoordinationError::UpdateTooFrequent
    );

    if let Some(caps) = capabilities {
        // Registration rejects a zero capability mask. Preserve that identity
        // invariant on update as well; an agent that wants to stop advertising
        // work can set its status to Inactive without publishing malformed state.
        require!(caps != 0, CoordinationError::InvalidCapabilities);
        agent.capabilities = caps;
    }

    if let Some(ep) = endpoint {
        require!(!ep.is_empty(), CoordinationError::InvalidInput);
        require!(validate_string_input(&ep), CoordinationError::InvalidInput);
        validate_endpoint(&ep)?;
        agent.endpoint = ep;
    }

    if let Some(uri) = metadata_uri {
        require!(
            uri.len() <= MAX_METADATA_URI_LEN,
            CoordinationError::StringTooLong
        );
        require!(validate_string_input(&uri), CoordinationError::InvalidInput);
        agent.metadata_uri = uri;
    }

    if let Some(s) = status {
        // Prevent suspended agents from changing their own status (only protocol authority can unsuspend)
        if s != AgentStatus::Suspended as u8 && agent.status == AgentStatus::Suspended {
            return Err(CoordinationError::AgentSuspended.into());
        }

        // Prevent setting status to Active while agent has active tasks
        // Agents with pending work should remain Busy, not advertise as available
        if s == AgentStatus::Active as u8 && agent.active_tasks > 0 {
            return Err(CoordinationError::AgentBusyWithTasks.into());
        }

        agent.status = match s {
            0 => AgentStatus::Inactive,
            1 => AgentStatus::Active,
            2 => AgentStatus::Busy,
            // Suspension is now handled by dedicated suspend_agent instruction (fix #819)
            3 => return Err(CoordinationError::InvalidInput.into()),
            _ => return Err(CoordinationError::InvalidInput.into()),
        };
    }

    agent.last_active = clock.unix_timestamp;
    agent.last_state_update = clock.unix_timestamp;

    emit!(AgentUpdated {
        agent_id: agent.agent_id,
        capabilities: agent.capabilities,
        status: agent.status as u8,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
