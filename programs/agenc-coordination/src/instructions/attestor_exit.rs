//! Two-step attestor exit (P1.2 §4.2): `request_attestor_exit` starts the clock,
//! `finalize_attestor_exit` closes the roster PDA after the cooldown, refunding
//! bond + rent to the attestor IN FULL (never confiscatable).
//!
//! The exit window closes at REQUEST, not finalize (Open Question 6, strict variant):
//! from the moment `exit_at` is set, the attestor is rejected at the record gates and
//! its attestations no longer unlock the consumption gates — there is no ≤7-day
//! scam-then-exit window. The request is MONOTONIC: a running clock cannot be reset
//! (re-requesting fails), so an attestor cannot bounce its own window to dodge the
//! cooldown. Finalize asserts `exit_at != 0` explicitly — without that guard a fresh
//! or grandfathered entry (zeroed reserved bytes) would satisfy `0 + COOLDOWN <= now`
//! and finalize instantly, nullifying the cooldown (review finding 5).

use crate::errors::CoordinationError;
use crate::events::{AttestorExitFinalized, AttestorExitRequested};
use crate::instructions::constants::ATTESTOR_EXIT_COOLDOWN;
use crate::state::ModerationAttestor;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RequestAttestorExit<'info> {
    /// Roster entry to exit. Seeded by its own stored `attestor` (canonical PDA).
    #[account(
        mut,
        seeds = [b"moderation_attestor", moderation_attestor.attestor.as_ref()],
        bump = moderation_attestor.bump,
        constraint = moderation_attestor.attestor == attestor.key()
            @ CoordinationError::ModerationAttestorMismatch
    )]
    pub moderation_attestor: Box<Account<'info, ModerationAttestor>>,

    /// Only the attestor itself may start its exit.
    pub attestor: Signer<'info>,
}

pub fn handler_request(ctx: Context<RequestAttestorExit>) -> Result<()> {
    let clock = Clock::get()?;
    let entry = ctx.accounts.moderation_attestor.as_mut();

    // Monotonic: a running exit clock cannot be reset.
    require!(
        entry.exit_at == 0,
        CoordinationError::AttestorExitAlreadyRequested
    );
    entry.exit_at = clock.unix_timestamp;

    emit!(AttestorExitRequested {
        attestor: entry.attestor,
        exit_at: entry.exit_at,
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeAttestorExit<'info> {
    /// Roster entry to close. `close = attestor` refunds ALL lamports on the PDA
    /// (rent + registration bond) to the attestor — the full, non-confiscatable refund.
    #[account(
        mut,
        close = attestor,
        seeds = [b"moderation_attestor", moderation_attestor.attestor.as_ref()],
        bump = moderation_attestor.bump,
        constraint = moderation_attestor.attestor == attestor.key()
            @ CoordinationError::ModerationAttestorMismatch
    )]
    pub moderation_attestor: Box<Account<'info, ModerationAttestor>>,

    /// Only the attestor itself may finalize; it receives the refund.
    #[account(mut)]
    pub attestor: Signer<'info>,
}

pub fn handler_finalize(ctx: Context<FinalizeAttestorExit>) -> Result<()> {
    let clock = Clock::get()?;
    let entry = &ctx.accounts.moderation_attestor;

    // Review finding 5: without this guard, exit_at == 0 (fresh/grandfathered entry)
    // satisfies the cooldown arithmetic and finalizes instantly with zero cooldown.
    require!(
        entry.exit_at != 0,
        CoordinationError::AttestorExitNotRequested
    );
    let unlock_at = entry
        .exit_at
        .checked_add(ATTESTOR_EXIT_COOLDOWN)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        clock.unix_timestamp >= unlock_at,
        CoordinationError::AttestorExitCooldownActive
    );

    let refunded = ctx.accounts.moderation_attestor.to_account_info().lamports();
    emit!(AttestorExitFinalized {
        attestor: entry.attestor,
        refunded_lamports: refunded,
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}
