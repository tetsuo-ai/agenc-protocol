//! Batch 4 (docs/design/batch-4-goods.md): update a goods listing.
//!
//! Seller-only mutation of price / active flag / metadata / operator terms,
//! plus RESTOCK — which is ADDITIVE-DELTA ONLY (`additional_supply` is
//! `checked_add`ed onto `total_supply`; there is deliberately no absolute
//! setter: a set-style restock would permit a scarcity rug — quietly re-raising
//! a "limited run" — and a `total_supply < sold_count` underflow). The
//! immutable `initial_supply` + `restock_count` keep restocks honest on-chain.
//!
//! `is_active = false` is the soft delist; there is NO close instruction (see
//! the `GoodsListing` doc for the receipt-collision reasoning).

use crate::errors::CoordinationError;
use crate::events::GoodsListingUpdated;
use crate::instructions::constants::MIN_GOOD_PRICE;
use crate::instructions::create_goods_listing::{validate_goods_metadata, validate_operator_terms};
use crate::instructions::launch_controls::require_goods_enabled;
use crate::state::{AgentRegistration, AgentStatus, GoodsListing, ProtocolConfig};
use crate::utils::version::{check_version_compatible, check_version_compatible_for_exit};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateGoodsListing<'info> {
    #[account(
        mut,
        seeds = [b"good", seller.key().as_ref(), good.good_id.as_ref()],
        bump = good.bump,
        constraint = good.seller == seller.key() @ CoordinationError::GoodsUnauthorizedUpdate,
        // AC-2: control is pinned to the SNAPSHOTTED seller_authority, so an
        // attacker who re-registers a deregistered agent_id (same PDA) cannot
        // reprice/restock/redirect the listing.
        constraint = good.seller_authority == authority.key() @ CoordinationError::GoodsUnauthorizedUpdate
    )]
    pub good: Account<'info, GoodsListing>,

    #[account(
        seeds = [b"agent", seller.agent_id.as_ref()],
        bump = seller.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub seller: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

#[allow(clippy::too_many_arguments)]
fn is_pure_goods_deactivation(
    price: &Option<u64>,
    is_active: Option<bool>,
    metadata_hash: &Option<[u8; 32]>,
    metadata_uri: &Option<String>,
    tags: &Option<[u8; 64]>,
    additional_supply: &Option<u64>,
    operator: &Option<Pubkey>,
    operator_fee_bps: &Option<u16>,
) -> bool {
    is_active == Some(false)
        && price.is_none()
        && metadata_hash.is_none()
        && metadata_uri.is_none()
        && tags.is_none()
        && additional_supply.is_none()
        && operator.is_none()
        && operator_fee_bps.is_none()
}

fn check_goods_update_version(config: &ProtocolConfig, pure_deactivation: bool) -> Result<()> {
    if pure_deactivation {
        check_version_compatible_for_exit(config)
    } else {
        check_version_compatible(config)
    }
}

fn validate_goods_update_seller(seller: &AgentRegistration, pure_deactivation: bool) -> Result<()> {
    if pure_deactivation {
        return Ok(());
    }
    require!(
        seller.status == AgentStatus::Active && !seller.is_retired_identity(),
        CoordinationError::AgentNotActive
    );
    Ok(())
}

/// All-`Option` update surface: `None` = leave unchanged. Metadata hash + URI
/// must be updated TOGETHER (the hash pins the URI's content — changing one
/// without the other would desynchronize them). NOTE: a swapped-in metadata
/// hash is re-checked against the moderation BLOCK floor at every purchase
/// (`purchase_good`), which is the binding gate.
#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<UpdateGoodsListing>,
    price: Option<u64>,
    is_active: Option<bool>,
    metadata_hash: Option<[u8; 32]>,
    metadata_uri: Option<String>,
    tags: Option<[u8; 64]>,
    additional_supply: Option<u64>,
    operator: Option<Pubkey>,
    operator_fee_bps: Option<u16>,
) -> Result<()> {
    let config = &ctx.accounts.protocol_config;
    // A pause stops repricing, reactivation, metadata/operator changes, and
    // restocks, but must not prevent the seller's one close-equivalent action.
    // Mixed updates cannot smuggle mutations through the exit path.
    let pure_deactivation = is_pure_goods_deactivation(
        &price,
        is_active,
        &metadata_hash,
        &metadata_uri,
        &tags,
        &additional_supply,
        &operator,
        &operator_fee_bps,
    );
    check_goods_update_version(config, pure_deactivation)?;
    require_goods_enabled(config)?;

    let seller = &ctx.accounts.seller;
    // Delisting is the inventory/rent-safe exit and remains available to a
    // suspended, inactive, busy, or retired seller. Every other mutation still
    // requires a live Active registration.
    validate_goods_update_seller(seller, pure_deactivation)?;

    let good = &mut ctx.accounts.good;

    if let Some(new_price) = price {
        require!(
            new_price >= MIN_GOOD_PRICE,
            CoordinationError::GoodsPriceBelowMinimum
        );
        good.price = new_price;
    }

    if let Some(active) = is_active {
        good.is_active = active;
    }

    // Metadata: both-or-neither (the hash pins the URI content).
    match (metadata_hash, metadata_uri) {
        (Some(hash), Some(uri)) => {
            validate_goods_metadata(&hash, &uri)?;
            good.metadata_hash = hash;
            good.metadata_uri = uri;
        }
        (None, None) => {}
        _ => return Err(CoordinationError::GoodsInvalidMetadata.into()),
    }

    if let Some(new_tags) = tags {
        good.tags = new_tags;
    }

    // RESTOCK — additive delta only (see module doc).
    if let Some(delta) = additional_supply {
        require!(delta > 0, CoordinationError::GoodsInvalidSupply);
        good.total_supply = good
            .total_supply
            .checked_add(delta)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        // The counter is part of the listing's scarcity/provenance record. Do
        // not mutate supply once that record can no longer advance: saturating
        // here would make later restocks indistinguishable on-chain.
        good.restock_count = good
            .restock_count
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    // Operator terms: apply whichever side(s) were provided, then validate the
    // RESULTING pair as a unit (pairing rule + per-leg cap + not-the-seller).
    if operator.is_some() || operator_fee_bps.is_some() {
        let next_operator = operator.unwrap_or(good.operator);
        let next_fee_bps = operator_fee_bps.unwrap_or(good.operator_fee_bps);
        validate_operator_terms(next_operator, next_fee_bps, seller.authority, good.key())?;
        good.operator = next_operator;
        good.operator_fee_bps = next_fee_bps;
    }

    let clock = Clock::get()?;
    good.updated_at = clock.unix_timestamp;

    emit!(GoodsListingUpdated {
        listing: good.key(),
        seller: seller.key(),
        price: good.price,
        is_active: good.is_active,
        total_supply: good.total_supply,
        sold_count: good.sold_count,
        restock_count: good.restock_count,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pure(
        price: Option<u64>,
        is_active: Option<bool>,
        metadata_hash: Option<[u8; 32]>,
        metadata_uri: Option<String>,
        tags: Option<[u8; 64]>,
        additional_supply: Option<u64>,
        operator: Option<Pubkey>,
        operator_fee_bps: Option<u16>,
    ) -> bool {
        is_pure_goods_deactivation(
            &price,
            is_active,
            &metadata_hash,
            &metadata_uri,
            &tags,
            &additional_supply,
            &operator,
            &operator_fee_bps,
        )
    }

    #[test]
    fn only_a_bare_false_active_update_is_an_exit() {
        assert!(pure(None, Some(false), None, None, None, None, None, None));
        assert!(!pure(None, None, None, None, None, None, None, None));
        assert!(!pure(None, Some(true), None, None, None, None, None, None));
        assert!(!pure(
            Some(1),
            Some(false),
            None,
            None,
            None,
            None,
            None,
            None
        ));
        assert!(!pure(
            None,
            Some(false),
            Some([1; 32]),
            None,
            None,
            None,
            None,
            None
        ));
        assert!(!pure(
            None,
            Some(false),
            None,
            Some("https://example.com".into()),
            None,
            None,
            None,
            None
        ));
        assert!(!pure(
            None,
            Some(false),
            None,
            None,
            Some([1; 64]),
            None,
            None,
            None
        ));
        assert!(!pure(
            None,
            Some(false),
            None,
            None,
            None,
            Some(1),
            None,
            None
        ));
        assert!(!pure(
            None,
            Some(false),
            None,
            None,
            None,
            None,
            Some(Pubkey::new_unique()),
            None
        ));
        assert!(!pure(
            None,
            Some(false),
            None,
            None,
            None,
            None,
            None,
            Some(1)
        ));
    }

    #[test]
    fn paused_protocol_allows_only_pure_deactivation() {
        let config = ProtocolConfig {
            protocol_version: 1,
            min_supported_version: 1,
            protocol_paused: true,
            ..ProtocolConfig::default()
        };
        assert!(check_goods_update_version(&config, true).is_ok());
        assert!(check_goods_update_version(&config, false).is_err());
    }

    #[test]
    fn every_seller_state_can_exit_but_only_live_active_can_mutate() {
        for status in [
            AgentStatus::Active,
            AgentStatus::Busy,
            AgentStatus::Inactive,
            AgentStatus::Suspended,
        ] {
            let seller = AgentRegistration {
                status,
                ..AgentRegistration::default()
            };
            assert!(validate_goods_update_seller(&seller, true).is_ok());
            assert_eq!(
                validate_goods_update_seller(&seller, false).is_ok(),
                status == AgentStatus::Active
            );
        }

        let mut retired = AgentRegistration {
            status: AgentStatus::Active,
            ..AgentRegistration::default()
        };
        retired._reserved = AgentRegistration::RETIRED_IDENTITY_MARKER;
        assert!(validate_goods_update_seller(&retired, true).is_ok());
        assert!(validate_goods_update_seller(&retired, false).is_err());
    }
}
