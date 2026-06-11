//! Revoke a wallet from the moderation-attestor roster (P6.8 — registry MECHANISM only).
//!
//! Mirrors `revoke_dispute_resolver`. Closes the `["moderation_attestor", attestor]` PDA,
//! refunding its rent to the moderation authority. Once closed, that wallet can no longer
//! record moderation attestations via the registered-attestor path (the closed account
//! fails to load when passed to `record_*_moderation`). Authority-only.

use crate::errors::CoordinationError;
use crate::events::ModerationAttestorRevoked;
use crate::state::{ModerationAttestor, ModerationConfig};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RevokeModerationAttestor<'info> {
    #[account(
        seeds = [b"moderation_config"],
        bump = moderation_config.bump
    )]
    pub moderation_config: Box<Account<'info, ModerationConfig>>,

    /// Roster entry to remove. Seeded by its own stored `attestor`, so the canonical PDA
    /// is enforced; `close = authority` returns the rent to the moderation authority.
    #[account(
        mut,
        close = authority,
        seeds = [b"moderation_attestor", moderation_attestor.attestor.as_ref()],
        bump = moderation_attestor.bump
    )]
    pub moderation_attestor: Box<Account<'info, ModerationAttestor>>,

    /// Must be the moderation authority that owns the moderation config.
    #[account(
        mut,
        constraint = authority.key() == moderation_config.authority
            @ CoordinationError::UnauthorizedTaskModerator
    )]
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<RevokeModerationAttestor>) -> Result<()> {
    let clock = Clock::get()?;
    emit!(ModerationAttestorRevoked {
        attestor: ctx.accounts.moderation_attestor.attestor,
        revoked_by: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}
