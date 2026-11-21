//! Suspend an agent (protocol multisig; protocol authority in the canary)
//!
//! Separates suspension from `update_agent` so that only the protocol can
//! suspend agents, not the agent's own authority (fix #819). Revision 9 (G):
//! the full surface requires the `ProtocolConfig` multisig threshold.

use crate::errors::CoordinationError;
use crate::events::AgentSuspended;
use crate::state::{AgentRegistration, AgentStatus, ProtocolConfig};
#[cfg(not(feature = "mainnet-canary"))]
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SuspendAgent<'info> {
    #[account(
        mut,
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump
    )]
    pub agent: Account<'info, AgentRegistration>,

    /// Revision 9 (G): on the full surface the approval is the multisig threshold
    /// over `remaining_accounts` (2 of 3 on mainnet); the canary keeps the single
    /// protocol-authority signer.
    #[cfg_attr(
        feature = "mainnet-canary",
        account(
            seeds = [b"protocol"],
            bump = protocol_config.bump,
            has_one = authority @ CoordinationError::UnauthorizedUpgrade,
            constraint = protocol_config.key() != agent.key() @ CoordinationError::InvalidInput
        )
    )]
    #[cfg_attr(
        not(feature = "mainnet-canary"),
        account(
            seeds = [b"protocol"],
            bump = protocol_config.bump,
            constraint = protocol_config.key() != agent.key() @ CoordinationError::InvalidInput
        )
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Fee payer and proposer (the protocol authority in the canary build).
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<SuspendAgent>) -> Result<()> {
    #[cfg(not(feature = "mainnet-canary"))]
    {
        let unique_signers = unique_account_infos(ctx.remaining_accounts);
        require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;
    }
    let agent = &mut ctx.accounts.agent;

    require!(
        !agent.is_retired_identity(),
        CoordinationError::AgentNotActive
    );

    require!(
        agent.status != AgentStatus::Suspended,
        CoordinationError::AgentSuspended
    );

    agent.status = AgentStatus::Suspended;

    let clock = Clock::get()?;
    agent.last_state_update = clock.unix_timestamp;

    emit!(AgentSuspended {
        agent_id: agent.agent_id,
        authority: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
