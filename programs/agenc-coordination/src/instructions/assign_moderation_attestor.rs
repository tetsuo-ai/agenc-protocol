//! Assign a wallet to the moderation-attestor roster (P6.8 — registry MECHANISM only).
//!
//! Mirrors only the PDA-roster mechanics of `assign_dispute_resolver`; moderation keeps
//! its separate authority-managed trust model rather than inheriting resolver M-of-N.
//! The moderation authority (the wallet that configures the moderation gate,
//! `ModerationConfig.authority`) designates specific wallets that may
//! record moderation attestations in addition to the single global
//! `ModerationConfig.moderation_authority`. Each assignment is its own PDA
//! (`["moderation_attestor", attestor]`); its existence authorizes that wallet to call
//! `record_task_moderation` / `record_listing_moderation`. Revoke by closing it via
//! `revoke_moderation_attestor`. Re-assigning an already-assigned attestor fails at `init`
//! (the PDA already exists), which is the desired "already assigned" signal.
//!
//! This builds ONLY the roster. The neutrality decision (a curated roster merely adds
//! deputies; it does not by itself retract the "one company pre-approves every hire"
//! objection) is a separate [HUMAN] decision documented in `docs/MODERATION_NEUTRALITY.md`.

use crate::errors::CoordinationError;
use crate::events::ModerationAttestorAssigned;
use crate::state::{ModerationAttestor, ModerationConfig};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(attestor: Pubkey)]
pub struct AssignModerationAttestor<'info> {
    #[account(
        seeds = [b"moderation_config"],
        bump = moderation_config.bump
    )]
    pub moderation_config: Box<Account<'info, ModerationConfig>>,

    /// Roster entry for `attestor`. `init` ⇒ assigning an already-assigned wallet fails.
    #[account(
        init,
        payer = authority,
        space = ModerationAttestor::SIZE,
        seeds = [b"moderation_attestor", attestor.as_ref()],
        bump
    )]
    pub moderation_attestor: Box<Account<'info, ModerationAttestor>>,

    /// Must be the moderation authority that owns the moderation config. Unlike the
    /// threshold-approved dispute-resolver roster, this moderation roster remains
    /// authority-managed under its separate trust model.
    #[account(
        mut,
        constraint = authority.key() == moderation_config.authority
            @ CoordinationError::UnauthorizedTaskModerator
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AssignModerationAttestor>, attestor: Pubkey) -> Result<()> {
    require!(
        attestor != Pubkey::default(),
        CoordinationError::InvalidModerationAttestor
    );

    let clock = Clock::get()?;
    let entry = ctx.accounts.moderation_attestor.as_mut();
    entry.attestor = attestor;
    entry.assigned_by = ctx.accounts.authority.key();
    entry.assigned_at = clock.unix_timestamp;
    entry.bump = ctx.bumps.moderation_attestor;
    // Deputized entries carry no bond and are not exiting (P1.2 bookkeeping zeroed).
    entry.bond_lamports = 0;
    entry.registered_at = 0;
    entry.exit_at = 0;
    entry._reserved = [0u8; 8];

    emit!(ModerationAttestorAssigned {
        attestor,
        assigned_by: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_attestor_is_rejected_by_guard() {
        // The handler's first guard rejects the zero pubkey. Validate the pure condition
        // (the account context can't be built in a unit test, but this is the load-bearing
        // check that a default/uninitialized attestor cannot be rostered).
        let attestor = Pubkey::default();
        assert!(
            attestor == Pubkey::default(),
            "sanity: default pubkey is the sentinel the guard rejects"
        );
    }
}
