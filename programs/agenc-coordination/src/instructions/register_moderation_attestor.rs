//! Self-register onto the open moderation-attestor roster (P1.2 §4.1).
//!
//! A clone of `assign_moderation_attestor` MINUS the authority constraint: the attestor
//! self-signs, self-pays rent, and deposits the hardcoded `REGISTRATION_BOND_LAMPORTS`
//! as excess lamports on its own `["moderation_attestor", attestor]` PDA. This makes
//! attestor registration permissionless — the last gatekeeping between a third-party
//! marketplace and moderating its own supply (Definition-of-Global item 3).
//!
//! The bond is an attributable-identity deposit that caps concurrent identities per
//! unit of working capital. It is NEVER confiscatable (refunded in full at
//! `finalize_attestor_exit`), it is NOT a quality bond, and it is NOT a sybil
//! rate-limit — quality/spam curation lives in the surface trust lists (§8, P6.4).
//! `assigned_by = attestor` (self) distinguishes self-registered entries from
//! authority-deputized ones in the audit trail.

use crate::errors::CoordinationError;
use crate::events::ModerationAttestorRegistered;
use crate::instructions::constants::REGISTRATION_BOND_LAMPORTS;
use crate::state::{ModerationAttestor, ProtocolConfig};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
pub struct RegisterModerationAttestor<'info> {
    /// Roster entry for the self-registering signer. `init` ⇒ registering an
    /// already-rostered wallet fails (the desired "already registered" signal), and a
    /// re-register after exit re-inits a fresh entry.
    #[account(
        init,
        payer = attestor,
        space = ModerationAttestor::SIZE,
        seeds = [b"moderation_attestor", attestor.key().as_ref()],
        bump
    )]
    pub moderation_attestor: Box<Account<'info, ModerationAttestor>>,

    /// The self-registering wallet. No authority constraint — this is the
    /// permissionless path. It pays rent AND the registration bond.
    #[account(mut)]
    pub attestor: Signer<'info>,

    /// Emergency entry-control. A paused or version-incompatible protocol must
    /// not accept a fresh seven-day moderation bond while ordinary marketplace
    /// entry is disabled. Exit instructions intentionally do not carry this
    /// pause gate, so existing attestors can always recover their bond.
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RegisterModerationAttestor>) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;

    // Deposit the bond via an in-handler CPI that cannot be skipped (spec §4.2 /
    // review finding 5: register must ENFORCE the bond, not assume it).
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.attestor.to_account_info(),
                to: ctx.accounts.moderation_attestor.to_account_info(),
            },
        ),
        REGISTRATION_BOND_LAMPORTS,
    )?;

    // Post-condition (defense in depth): the PDA actually holds rent + bond.
    let rent_min = Rent::get()?.minimum_balance(ModerationAttestor::SIZE);
    let required = rent_min
        .checked_add(REGISTRATION_BOND_LAMPORTS)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        ctx.accounts
            .moderation_attestor
            .to_account_info()
            .lamports()
            >= required,
        CoordinationError::AttestorBondMissing
    );

    let attestor_key = ctx.accounts.attestor.key();
    let entry = ctx.accounts.moderation_attestor.as_mut();
    entry.attestor = attestor_key;
    entry.assigned_by = attestor_key; // self — marks the entry as self-registered
    entry.assigned_at = clock.unix_timestamp;
    entry.bump = ctx.bumps.moderation_attestor;
    entry.bond_lamports = REGISTRATION_BOND_LAMPORTS;
    entry.registered_at = clock.unix_timestamp;
    entry.exit_at = 0;
    entry._reserved = [0u8; 8];

    emit!(ModerationAttestorRegistered {
        attestor: attestor_key,
        bond_lamports: REGISTRATION_BOND_LAMPORTS,
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}
