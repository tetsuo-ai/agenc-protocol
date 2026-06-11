//! Revoke an agent's domain-verification attestation (P7.3 step 2, completeness).
//!
//! Marks an existing `AgentVerification` as `revoked = true` rather than closing it, so the
//! record stays trustlessly readable (consumers see `verified == false` via the revoked
//! flag / expiry). Authorization mirrors `record_agent_verification` EXACTLY: the signer
//! must be the global moderation authority OR a registered (non-revoked) `ModerationAttestor`.
//!
//! Full-surface only (`#[cfg(not(feature = "mainnet-canary"))]`).

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::AgentVerificationRevoked;
use crate::instructions::record_task_moderation::require_moderation_authorized;
use crate::state::{AgentVerification, ModerationAttestor, ModerationConfig};

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

    /// The recording signer. Authorization (global moderation authority OR a registered
    /// attestor) is checked in the handler, mirroring `record_*_moderation`.
    #[account(mut)]
    pub attestor: Signer<'info>,

    /// OPTIONAL: a registered moderation-attestor roster entry (same semantics as
    /// `record_agent_verification`). Canonical-PDA + `attestor == signer` bound; a revoked
    /// attestor's PDA is closed and fails to load.
    #[account(
        seeds = [b"moderation_attestor", attestor.key().as_ref()],
        bump = moderation_attestor.bump,
        constraint = moderation_attestor.attestor == attestor.key()
            @ CoordinationError::ModerationAttestorMismatch
    )]
    pub moderation_attestor: Option<Box<Account<'info, ModerationAttestor>>>,
}

pub fn handler(ctx: Context<RevokeAgentVerification>) -> Result<()> {
    require_moderation_authorized(
        ctx.accounts.attestor.key(),
        ctx.accounts.moderation_config.moderation_authority,
        ctx.accounts.moderation_attestor.is_some(),
    )?;

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
