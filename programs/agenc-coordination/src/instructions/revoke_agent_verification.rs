//! Revoke an agent's domain-verification attestation (P7.3 step 2, completeness).
//!
//! Marks an existing `AgentVerification` as `revoked = true` rather than closing it, so the
//! record stays trustlessly readable (consumers see `verified == false` via the revoked
//! flag / expiry). Authorization (P1.2 §4.6, DECOUPLED — mirrors
//! `record_agent_verification`): the signer must be the GLOBAL moderation authority only;
//! the open roster no longer authorizes domain verification.
//!
//! Full-surface only (`#[cfg(not(feature = "mainnet-canary"))]`).

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::AgentVerificationRevoked;
use crate::state::{AgentVerification, ModerationConfig};

#[derive(Accounts)]
pub struct RevokeAgentVerification<'info> {
    #[account(seeds = [b"moderation_config"], bump = moderation_config.bump)]
    pub moderation_config: Account<'info, ModerationConfig>,

    /// The verification to revoke, pinned to its canonical PDA (seeded by the stored agent).
    #[account(
        mut,
        seeds = [b"agent_verification", agent_verification.agent.as_ref()],
        bump = agent_verification.bump
    )]
    pub agent_verification: Account<'info, AgentVerification>,

    /// The revoking signer. P1.2 §4.6: must be the GLOBAL moderation authority
    /// (checked in the handler; the roster no longer authorizes this).
    #[account(mut)]
    pub attestor: Signer<'info>,
}

pub fn handler(ctx: Context<RevokeAgentVerification>) -> Result<()> {
    // P1.2 §4.6 (decoupled): the GLOBAL moderation authority only — an open-roster
    // key must not be able to revoke another attestor's legitimate verification.
    require!(
        ctx.accounts.attestor.key() == ctx.accounts.moderation_config.moderation_authority,
        CoordinationError::UnauthorizedModerationAttestor
    );

    let clock = Clock::get()?;
    let agent = ctx.accounts.agent_verification.agent;
    let v = &mut ctx.accounts.agent_verification;
    v.revoked = true;

    emit!(AgentVerificationRevoked {
        agent,
        revoked_by: ctx.accounts.attestor.key(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
