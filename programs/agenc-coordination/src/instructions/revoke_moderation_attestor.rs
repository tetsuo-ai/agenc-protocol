//! Revoke a wallet from the moderation-attestor roster (P6.8 — registry MECHANISM only).
//!
//! Mirrors the PDA-roster mechanics of `revoke_dispute_resolver`. Closes the
//! `["moderation_attestor", attestor]` PDA, refunding its rent to the proposer.
//! Once closed, that wallet can no longer record moderation
//! attestations via the registered-attestor path (the closed account fails to load when
//! passed to `record_*_moderation`).
//!
//! P1.2 §4.7 (non-confiscatory revoke): only deputized entries can be revoked. A
//! self-registered attestor (bonded, with a registration time) can be removed from
//! chain by no one but itself, through the two-step exit that refunds its bond in
//! full. The "authority revoke confiscates the deposit" variant is exactly the
//! stake-confiscation lever this design exists to remove.
//!
//! Revision 9 (G, design open question 13): no single key over the roster. A
//! revoke needs the `ProtocolConfig` multisig threshold over remaining accounts,
//! exactly like `set_moderation_block`; the signer is the fee payer and proposer
//! and receives the entry's rent. A deputized entry is recognized by its own
//! state (no bond, no registration time), since its assigner may differ from the
//! revoking proposer.

use crate::errors::CoordinationError;
use crate::events::ModerationAttestorRevoked;
use crate::state::{ModerationAttestor, ModerationConfig, ProtocolConfig};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RevokeModerationAttestor<'info> {
    #[account(
        seeds = [b"moderation_config"],
        bump = moderation_config.bump,
        constraint = moderation_config.validate_reserved_fields() @ CoordinationError::InvalidModerationConfig
    )]
    pub moderation_config: Box<Account<'info, ModerationConfig>>,

    /// Roster entry to remove. Seeded by its own stored `attestor`, so the canonical PDA
    /// is enforced; `close = authority` returns the rent to the proposer. P1.2 §4.7:
    /// only a deputized entry (no bond, no registration time) can be closed here,
    /// so a self-registered attestor's bond can never be confiscated through this
    /// path.
    #[account(
        mut,
        close = authority,
        seeds = [b"moderation_attestor", moderation_attestor.attestor.as_ref()],
        bump = moderation_attestor.bump,
        constraint = moderation_attestor.bond_lamports == 0
            && moderation_attestor.registered_at == 0
            @ CoordinationError::UnauthorizedAttestorRevocation
    )]
    pub moderation_attestor: Box<Account<'info, ModerationAttestor>>,

    /// Fee payer and proposer; receives the entry's rent. The approval is the
    /// multisig threshold over `remaining_accounts` (revision 9).
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Revision 9 (G), appended: the protocol config whose multisig owners must
    /// approve the revoke.
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
}

pub fn handler(ctx: Context<RevokeModerationAttestor>) -> Result<()> {
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;
    let clock = Clock::get()?;
    emit!(ModerationAttestorRevoked {
        attestor: ctx.accounts.moderation_attestor.attestor,
        revoked_by: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}
