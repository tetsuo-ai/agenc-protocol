//! Publish a standing service listing (embeddable marketplace, Batch 1).
//!
//! Purely additive: a new `ServiceListing` account modeled on `register_skill`.
//! Touches no existing account layout, so it needs no migration.

use crate::errors::CoordinationError;
use crate::events::ServiceListingCreated;
use crate::instructions::constants::{MAX_DEADLINE_SECONDS, MAX_OPERATOR_FEE_BPS, MIN_SKILL_PRICE};
use crate::state::{AgentRegistration, AgentStatus, ListingState, ProtocolConfig, ServiceListing};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

/// A non-zero operator fee must name a payee (else it would settle to nobody once
/// the Batch-2 split lands) and must not exceed the cap. Single source for the
/// create and update paths so both enforce the identical invariant.
pub(crate) fn validate_operator_fee_invariant(
    operator: Pubkey,
    operator_fee_bps: u16,
) -> Result<()> {
    require!(
        operator_fee_bps <= MAX_OPERATOR_FEE_BPS,
        CoordinationError::ListingOperatorFeeTooHigh
    );
    require!(
        operator_fee_bps == 0 || operator != Pubkey::default(),
        CoordinationError::ListingOperatorRequired
    );
    Ok(())
}

/// `default_deadline_secs` is a relative duration (0 = protocol default) that a
/// future hire turns into an absolute deadline. Bound it to the protocol cap so a
/// stored default can never yield an unsatisfiable hire deadline at settlement.
pub(crate) fn validate_listing_deadline(default_deadline_secs: i64) -> Result<()> {
    require!(
        (0..=MAX_DEADLINE_SECONDS).contains(&default_deadline_secs),
        CoordinationError::InvalidInput
    );
    Ok(())
}

/// Service-listing hires are currently SOL-only in both buyer flows. Accepting a
/// token mint here would create a permanently unhireable listing because the
/// immutable `price_mint` cannot be cleared by `update_service_listing` and both
/// hire handlers reject it. Fail at publication instead of minting dead state.
pub(crate) fn validate_service_listing_price_mint(price_mint: Option<Pubkey>) -> Result<()> {
    require!(price_mint.is_none(), CoordinationError::InvalidTokenMint);
    Ok(())
}

#[derive(Accounts)]
#[instruction(listing_id: [u8; 32])]
pub struct CreateServiceListing<'info> {
    #[account(
        init,
        payer = authority,
        space = ServiceListing::SIZE,
        seeds = [b"service_listing", provider_agent.key().as_ref(), listing_id.as_ref()],
        bump
    )]
    pub listing: Account<'info, ServiceListing>,

    #[account(
        seeds = [b"agent", provider_agent.agent_id.as_ref()],
        bump = provider_agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent,
        constraint = provider_agent.key() != listing.key() @ CoordinationError::InvalidInput
    )]
    pub provider_agent: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateServiceListing>,
    listing_id: [u8; 32],
    name: [u8; 32],
    category: [u8; 32],
    tags: [u8; 64],
    spec_hash: [u8; 32],
    spec_uri: String,
    price: u64,
    price_mint: Option<Pubkey>,
    required_capabilities: u64,
    default_deadline_secs: i64,
    max_open_jobs: u16,
    operator: Option<Pubkey>,
    operator_fee_bps: u16,
) -> Result<()> {
    let config = &ctx.accounts.protocol_config;
    check_version_compatible(config)?;

    let provider = &ctx.accounts.provider_agent;
    require!(
        provider.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    require!(listing_id != [0u8; 32], CoordinationError::ListingInvalidId);
    require!(name != [0u8; 32], CoordinationError::ListingInvalidName);
    require!(
        spec_hash != [0u8; 32],
        CoordinationError::ListingInvalidSpec
    );
    require!(
        !spec_uri.trim().is_empty() && spec_uri.len() <= 256,
        CoordinationError::ListingInvalidSpec
    );
    require!(
        price >= MIN_SKILL_PRICE,
        CoordinationError::ListingPriceTooLow
    );
    validate_service_listing_price_mint(price_mint)?;
    require!(
        required_capabilities != 0,
        CoordinationError::ListingCapabilitiesRequired
    );
    validate_listing_deadline(default_deadline_secs)?;
    let operator_key = operator.unwrap_or_default();
    validate_operator_fee_invariant(operator_key, operator_fee_bps)?;

    let clock = Clock::get()?;
    let provider_key = provider.key();
    let authority_key = ctx.accounts.authority.key();
    let listing = &mut ctx.accounts.listing;

    listing.provider_agent = provider_key;
    listing.authority = authority_key;
    listing.listing_id = listing_id;
    listing.name = name;
    listing.category = category;
    listing.tags = tags;
    listing.spec_hash = spec_hash;
    listing.spec_uri = spec_uri;
    listing.price = price;
    listing.price_mint = price_mint;
    listing.required_capabilities = required_capabilities;
    listing.default_deadline_secs = default_deadline_secs;
    listing.operator = operator_key;
    listing.operator_fee_bps = operator_fee_bps;
    listing.state = ListingState::Active;
    listing.max_open_jobs = max_open_jobs;
    listing.open_jobs = 0;
    listing.total_hires = 0;
    listing.total_rating = 0;
    listing.rating_count = 0;
    listing.version = 1;
    listing.created_at = clock.unix_timestamp;
    listing.updated_at = clock.unix_timestamp;
    listing.bump = ctx.bumps.listing;
    listing._reserved = [0u8; 32];

    emit!(ServiceListingCreated {
        listing: listing.key(),
        provider_agent: provider_key,
        authority: authority_key,
        listing_id,
        price,
        price_mint,
        operator: operator_key,
        operator_fee_bps,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Revert-sensitive: the operator-fee invariant is the most error-prone branch
    // (both create and the update operator-clearing path route through it).
    // Removing either require! in validate_operator_fee_invariant turns one red.
    #[test]
    fn operator_invariant_rejects_fee_without_payee() {
        assert!(validate_operator_fee_invariant(Pubkey::default(), 100).is_err());
    }

    #[test]
    fn operator_invariant_rejects_fee_over_cap() {
        assert!(
            validate_operator_fee_invariant(Pubkey::new_unique(), MAX_OPERATOR_FEE_BPS + 1)
                .is_err()
        );
    }

    #[test]
    fn operator_invariant_allows_fee_with_payee() {
        assert!(
            validate_operator_fee_invariant(Pubkey::new_unique(), MAX_OPERATOR_FEE_BPS).is_ok()
        );
    }

    #[test]
    fn operator_invariant_allows_zero_fee_no_payee() {
        assert!(validate_operator_fee_invariant(Pubkey::default(), 0).is_ok());
    }

    #[test]
    fn deadline_rejects_negative_and_overcap() {
        assert!(validate_listing_deadline(-1).is_err());
        assert!(validate_listing_deadline(MAX_DEADLINE_SECONDS + 1).is_err());
    }

    #[test]
    fn deadline_allows_zero_and_cap() {
        assert!(validate_listing_deadline(0).is_ok());
        assert!(validate_listing_deadline(MAX_DEADLINE_SECONDS).is_ok());
    }

    #[test]
    fn rejects_permanently_unhireable_token_pricing_at_publication() {
        assert!(validate_service_listing_price_mint(None).is_ok());
        assert!(validate_service_listing_price_mint(Some(Pubkey::new_unique())).is_err());
    }
}
