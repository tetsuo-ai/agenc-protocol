//! Revoke a wallet from the dispute-resolver roster (assignable arbiter model).
//!
//! Closes the `["dispute_resolver", resolver]` PDA, refunding its rent to the protocol
//! authority. Once closed, that wallet can no longer call `resolve_dispute`. The
//! authority proposes the change and configured ProtocolConfig M-of-N owners approve it,
//! mirroring `assign_dispute_resolver`.

use crate::errors::CoordinationError;
use crate::events::DisputeResolverRevoked;
use crate::state::{DisputeResolver, ProtocolConfig};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RevokeDisputeResolver<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// Roster entry to remove. Seeded by its own stored `resolver`, so the canonical PDA
    /// is enforced; `close = authority` returns the rent to the protocol authority.
    #[account(
        mut,
        close = authority,
        seeds = [b"dispute_resolver", dispute_resolver.resolver.as_ref()],
        bump = dispute_resolver.bump
    )]
    pub dispute_resolver: Box<Account<'info, DisputeResolver>>,

    /// Must be the protocol authority; configured M-of-N approval arrives through
    /// remaining accounts.
    #[account(
        mut,
        constraint = authority.key() == protocol_config.authority
            @ CoordinationError::UnauthorizedAgent
    )]
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<RevokeDisputeResolver>) -> Result<()> {
    // Revocation changes the same outcome-authority boundary as assignment and
    // therefore requires the same configured M-of-N approval.
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;

    let clock = Clock::get()?;
    emit!(DisputeResolverRevoked {
        resolver: ctx.accounts.dispute_resolver.resolver,
        revoked_by: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}
