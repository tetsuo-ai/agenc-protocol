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
use crate::utils::version::check_version_compatible;
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
    check_version_compatible(config)?;
    require_goods_enabled(config)?;

    let seller = &ctx.accounts.seller;
    require!(
        seller.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

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
