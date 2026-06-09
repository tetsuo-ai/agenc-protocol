//! Pause / reactivate / retire a service listing (embeddable marketplace, Batch 1).
//!
//! Pure state flip on the listing — touches NO `Task` accounts, so already-minted
//! hires settle independently and can never be stranded. Retired is terminal.

use crate::errors::CoordinationError;
use crate::events::ServiceListingStateChanged;
use crate::state::{ListingState, ProtocolConfig, ServiceListing};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetServiceListingState<'info> {
    #[account(
        mut,
        seeds = [b"service_listing", listing.provider_agent.as_ref(), listing.listing_id.as_ref()],
        bump = listing.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub listing: Account<'info, ServiceListing>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

/// `new_state`: 0 = Active, 1 = Paused, 2 = Retired (terminal).
pub fn handler(ctx: Context<SetServiceListingState>, new_state: u8) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;
    let listing = &mut ctx.accounts.listing;

    // Retired is terminal — no further transitions.
    require!(
        listing.state != ListingState::Retired,
        CoordinationError::ListingRetired
    );

    let target = ListingState::from_u8(new_state)?;

    listing.state = target;
    listing.updated_at = clock.unix_timestamp;

    emit!(ServiceListingStateChanged {
        listing: listing.key(),
        authority: listing.authority,
        new_state,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
