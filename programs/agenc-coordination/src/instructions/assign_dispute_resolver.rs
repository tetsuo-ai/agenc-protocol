//! Assign a wallet to the dispute-resolver roster (assignable arbiter model).
//!
//! The protocol authority proposes specific people who may resolve disputes, and the
//! configured ProtocolConfig M-of-N owners approve the change. Each
//! assignment is its own PDA (`["dispute_resolver", resolver]`); its existence authorizes
//! that wallet to call `resolve_dispute` directly — no per-case arbiter vote tally or
//! quorum (the roster assignment itself required M-of-N approval). Revoke by closing it
//! via `revoke_dispute_resolver`. Re-assigning an already-assigned resolver
//! fails at `init` (the PDA already exists), which is the desired "already assigned" signal.

use crate::errors::CoordinationError;
use crate::events::DisputeResolverAssigned;
use crate::state::{DisputeResolver, ProtocolConfig};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(resolver: Pubkey)]
pub struct AssignDisputeResolver<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// Roster entry for `resolver`. `init` ⇒ assigning an already-assigned wallet fails.
    #[account(
        init,
        payer = authority,
        space = DisputeResolver::SIZE,
        seeds = [b"dispute_resolver", resolver.as_ref()],
        bump
    )]
    pub dispute_resolver: Box<Account<'info, DisputeResolver>>,

    /// Must be the protocol authority (the roster proposal is authority-bound;
    /// configured M-of-N approval arrives through remaining accounts).
    #[account(
        mut,
        constraint = authority.key() == protocol_config.authority
            @ CoordinationError::UnauthorizedAgent
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AssignDisputeResolver>, resolver: Pubkey) -> Result<()> {
    // Resolver appointment controls who may choose canonical dispute outcomes.
    // The authority assembles/pays for the instruction, while the configured
    // M-of-N owners explicitly approve through existing remaining accounts.
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;

    require!(
        resolver != Pubkey::default(),
        CoordinationError::InvalidDisputeResolver
    );

    let clock = Clock::get()?;
    let entry = ctx.accounts.dispute_resolver.as_mut();
    entry.resolver = resolver;
    entry.assigned_by = ctx.accounts.authority.key();
    entry.assigned_at = clock.unix_timestamp;
    entry.bump = ctx.bumps.dispute_resolver;
    // P6.4 case counters start at zero; the challenge-window-coupled `overturned_count`
    // has no incrementer yet (design-doc only).
    entry.resolved_count = 0;
    entry.overturned_count = 0;
    entry.last_resolved_at = 0;
    entry._reserved = [0u8; 8];

    emit!(DisputeResolverAssigned {
        resolver,
        assigned_by: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}
