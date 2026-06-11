//! Assign a wallet to the dispute-resolver roster (assignable arbiter model).
//!
//! The protocol authority designates specific people who may resolve disputes. Each
//! assignment is its own PDA (`["dispute_resolver", resolver]`); its existence authorizes
//! that wallet to call `resolve_dispute` directly — no vote tally, no quorum. Revoke by
//! closing it via `revoke_dispute_resolver`. Re-assigning an already-assigned resolver
//! fails at `init` (the PDA already exists), which is the desired "already assigned" signal.

use crate::errors::CoordinationError;
use crate::events::DisputeResolverAssigned;
use crate::state::{DisputeResolver, ProtocolConfig};
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

    /// Must be the protocol authority (the roster is authority-managed).
    #[account(
        mut,
        constraint = authority.key() == protocol_config.authority
            @ CoordinationError::UnauthorizedAgent
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AssignDisputeResolver>, resolver: Pubkey) -> Result<()> {
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
