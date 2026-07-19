//! Update a standing service listing's terms (embeddable marketplace, Batch 1).
//!
//! Provider-only (has_one = authority). Bumps `version` so an in-flight
//! `hire_from_listing` can compare-and-swap against the terms it expects.
//! Retired listings are immutable.

use crate::errors::CoordinationError;
use crate::events::ServiceListingUpdated;
use crate::instructions::constants::MIN_SKILL_PRICE;
use crate::instructions::create_service_listing::{
    validate_listing_deadline, validate_operator_fee_invariant,
};
use crate::state::{AgentRegistration, AgentStatus, ListingState, ProtocolConfig, ServiceListing};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

fn validate_listing_spec_update(
    spec_hash: Option<[u8; 32]>,
    spec_uri: Option<String>,
) -> Result<Option<([u8; 32], String)>> {
    match (spec_hash, spec_uri) {
        (Some(hash), Some(uri)) => {
            require!(hash != [0u8; 32], CoordinationError::ListingInvalidSpec);
            require!(
                !uri.trim().is_empty() && uri.len() <= 256,
                CoordinationError::ListingInvalidSpec
            );
            Ok(Some((hash, uri)))
        }
        (None, None) => Ok(None),
        // The URI names the bytes committed by the hash. Updating just one side
        // would publish an internally inconsistent contract to buyers/workers.
        _ => err!(CoordinationError::ListingInvalidSpec),
    }
}

#[derive(Accounts)]
pub struct UpdateServiceListing<'info> {
    #[account(
        mut,
        seeds = [b"service_listing", listing.provider_agent.as_ref(), listing.listing_id.as_ref()],
        bump = listing.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub listing: Account<'info, ServiceListing>,

    #[account(
        seeds = [b"agent", provider_agent.agent_id.as_ref()],
        bump = provider_agent.bump,
        constraint = provider_agent.key() == listing.provider_agent @ CoordinationError::InvalidInput,
        constraint = provider_agent.authority == authority.key() @ CoordinationError::UnauthorizedAgent
    )]
    pub provider_agent: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<UpdateServiceListing>,
    price: Option<u64>,
    spec_hash: Option<[u8; 32]>,
    spec_uri: Option<String>,
    tags: Option<[u8; 64]>,
    required_capabilities: Option<u64>,
    default_deadline_secs: Option<i64>,
    max_open_jobs: Option<u16>,
    operator: Option<Pubkey>,
    operator_fee_bps: Option<u16>,
) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;
    let listing = &mut ctx.accounts.listing;

    require!(
        ctx.accounts.provider_agent.status == AgentStatus::Active
            && !ctx.accounts.provider_agent.is_retired_identity(),
        CoordinationError::AgentNotActive
    );

    require!(
        listing.state != ListingState::Retired,
        CoordinationError::ListingRetired
    );

    if let Some(p) = price {
        require!(p >= MIN_SKILL_PRICE, CoordinationError::ListingPriceTooLow);
        listing.price = p;
    }
    if let Some((hash, uri)) = validate_listing_spec_update(spec_hash, spec_uri)? {
        listing.spec_hash = hash;
        listing.spec_uri = uri;
    }
    if let Some(t) = tags {
        listing.tags = t;
    }
    if let Some(c) = required_capabilities {
        require!(c != 0, CoordinationError::ListingCapabilitiesRequired);
        listing.required_capabilities = c;
    }
    if let Some(d) = default_deadline_secs {
        validate_listing_deadline(d)?;
        listing.default_deadline_secs = d;
    }
    if let Some(m) = max_open_jobs {
        listing.max_open_jobs = m;
    }
    if let Some(fee) = operator_fee_bps {
        listing.operator_fee_bps = fee;
    }
    if let Some(op) = operator {
        listing.operator = op;
    }

    // Re-validate the operator/fee invariant (cap + payee) on the final values.
    validate_operator_fee_invariant(listing.operator, listing.operator_fee_bps)?;

    // `hire_from_listing` uses this value as a compare-and-swap guard. Reusing
    // u64::MAX after saturation would let terms change without invalidating a
    // stale signed hire. Preserve strict monotonicity and fail on exhaustion.
    listing.version = listing
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    listing.updated_at = clock.unix_timestamp;

    emit!(ServiceListingUpdated {
        listing: listing.key(),
        authority: listing.authority,
        price: listing.price,
        operator_fee_bps: listing.operator_fee_bps,
        version: listing.version,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_spec_hash_and_uri_update_atomically() {
        let hash = [7u8; 32];
        let uri = "agenc://job-spec/sha256/07".to_string();
        assert!(validate_listing_spec_update(Some(hash), Some(uri)).is_ok());
        assert!(validate_listing_spec_update(None, None).is_ok());
        assert!(validate_listing_spec_update(Some(hash), None).is_err());
        assert!(
            validate_listing_spec_update(None, Some("https://example.test/spec".into())).is_err()
        );
        assert!(validate_listing_spec_update(Some([0u8; 32]), Some("x".into())).is_err());
    }
}
