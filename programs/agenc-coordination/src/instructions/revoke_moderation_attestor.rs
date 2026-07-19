//! Revoke a wallet from the moderation-attestor roster (P6.8 — registry MECHANISM only).
//!
//! Mirrors only the PDA-roster mechanics of `revoke_dispute_resolver`; moderation keeps
//! its separate authority-managed trust model rather than inheriting resolver M-of-N.
//! Closes the `["moderation_attestor", attestor]` PDA, refunding its rent to the
//! moderation authority. Once closed, that wallet can no longer record moderation
//! attestations via the registered-attestor path (the closed account fails to load when
//! passed to `record_*_moderation`).
//!
//! P1.2 §4.7 (non-confiscatory revoke): scoped to `assigned_by == authority` — the
//! authority may remove ONLY entries it itself deputized. A self-registered attestor
//! (`assigned_by == attestor`, carrying a bond) can be removed from chain by no one
//! but itself, through the two-step exit that refunds its bond in full. The
//! "authority revoke confiscates the deposit" variant is exactly the
//! stake-confiscation lever this design exists to remove.

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
    /// P1.2 §4.7: `assigned_by` must be the revoking authority — a self-registered
    /// entry (`assigned_by == attestor`) can never be closed by the authority, so its
    /// bond can never be confiscated through this path.
    #[account(
        mut,
        close = authority,
        seeds = [b"moderation_attestor", moderation_attestor.attestor.as_ref()],
        bump = moderation_attestor.bump,
        constraint = moderation_attestor.assigned_by == authority.key()
            @ CoordinationError::UnauthorizedAttestorRevocation
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
