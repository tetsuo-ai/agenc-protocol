//! Pause / reactivate / retire a service listing (embeddable marketplace, Batch 1).
//!
//! Pure state flip on the listing — touches NO `Task` accounts, so already-minted
//! hires settle independently and can never be stranded. Retired is terminal.

use crate::errors::CoordinationError;
use crate::events::ServiceListingStateChanged;
use crate::instructions::program_account_helpers::deserialize_program_account;
use crate::state::{AgentRegistration, AgentStatus, ListingState, ProtocolConfig, ServiceListing};
use crate::utils::version::{check_version_compatible, check_version_compatible_for_exit};
use anchor_lang::prelude::*;

/// State changes are part of the listing's buyer-facing compare-and-swap
/// contract. In particular, Paused -> Active must advance `version` so a hire
/// signed before the pause cannot land after reactivation using an old version.
fn next_listing_state_version(
    current_state: ListingState,
    target_state: ListingState,
    current_version: u64,
) -> Result<u64> {
    require!(
        current_state != target_state,
        CoordinationError::ListingInvalidStateTransition
    );
    current_version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow.into())
}

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
    let target = ListingState::from_u8(new_state)?;

    // Pausing/retiring is an exit-control action and must remain available while
    // the global entry pause is active. Reactivation creates fresh market entry,
    // so it retains the strict pause gate. Both paths still enforce the protocol
    // version range and reject incompatible layouts.
    if target == ListingState::Active {
        check_version_compatible(&ctx.accounts.protocol_config)?;
    } else {
        check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    }
    let clock = Clock::get()?;
    let listing = &mut ctx.accounts.listing;

    // Retired is terminal — no further transitions.
    require!(
        listing.state != ListingState::Retired,
        CoordinationError::ListingRetired
    );

    if target == ListingState::Active {
        // Preserve the deployed revision-4 fixed account ABI. Reactivation is
        // fresh market entry and appends exactly one authenticated provider
        // proof. Pause/retire below remain three-meta owner-signed exits even if
        // revision 4 closed the provider PDA during the loader upload.
        require!(
            ctx.remaining_accounts.len() == 1,
            CoordinationError::InvalidInput
        );
        let provider_info = &ctx.remaining_accounts[0];
        require_keys_eq!(
            provider_info.key(),
            listing.provider_agent,
            CoordinationError::InvalidInput
        );
        let provider: AgentRegistration = deserialize_program_account(provider_info)?;
        let (expected_provider, expected_bump) =
            Pubkey::find_program_address(&[b"agent", provider.agent_id.as_ref()], &crate::ID);
        require_keys_eq!(
            expected_provider,
            provider_info.key(),
            CoordinationError::InvalidInput
        );
        require!(
            provider.bump == expected_bump,
            CoordinationError::InvalidInput
        );
        require_keys_eq!(
            provider.authority,
            listing.authority,
            CoordinationError::UnauthorizedAgent
        );
        require!(
            provider.status == AgentStatus::Active && !provider.is_retired_identity(),
            CoordinationError::AgentNotActive
        );
    } else {
        // Exit calls accept no ignored suffix. This keeps their wire contract
        // exact and prevents callers from assuming an unused account influenced
        // authorization or rent routing.
        require!(
            ctx.remaining_accounts.is_empty(),
            CoordinationError::InvalidInput
        );
    }

    listing.version = next_listing_state_version(listing.state, target, listing.version)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_real_state_transition_invalidates_stale_hires() {
        assert_eq!(
            next_listing_state_version(ListingState::Active, ListingState::Paused, 7).unwrap(),
            8
        );
        assert_eq!(
            next_listing_state_version(ListingState::Paused, ListingState::Active, 8).unwrap(),
            9
        );
        assert_eq!(
            next_listing_state_version(ListingState::Paused, ListingState::Retired, 9).unwrap(),
            10
        );
    }

    #[test]
    fn no_op_and_version_exhaustion_are_rejected() {
        assert!(next_listing_state_version(ListingState::Active, ListingState::Active, 7).is_err());
        assert!(
            next_listing_state_version(ListingState::Paused, ListingState::Active, u64::MAX)
                .is_err()
        );
    }
}
