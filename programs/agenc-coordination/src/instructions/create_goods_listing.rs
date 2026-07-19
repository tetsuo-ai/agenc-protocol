//! Batch 4 (docs/design/batch-4-goods.md): list a FINITE, transferable good.
//!
//! The good itself is OFF-CHAIN (no NFT — e.g. a row in an app's item ledger);
//! this account is the payment + provenance + protocol-cut rail for selling it.
//! Modeled on `register_skill`, plus the rivalrous supply fields and the
//! optional operator (embedding-site/store) fee leg from `ServiceListing`.
//!
//! There is deliberately NO close instruction (see the `GoodsListing` doc):
//! soft-delist via `update_goods_listing { is_active: false }`.

use crate::errors::CoordinationError;
use crate::events::GoodsListingCreated;
use crate::instructions::constants::{MAX_OPERATOR_FEE_BPS, MIN_GOOD_PRICE};
use crate::instructions::launch_controls::require_goods_enabled;
use crate::instructions::moderation_gate_helpers::require_content_not_blocked;
use crate::state::{AgentRegistration, AgentStatus, GoodsListing, ProtocolConfig};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

pub const GOODS_METADATA_URI_MAX_LEN: usize = 256;

#[derive(Accounts)]
#[instruction(good_id: [u8; 32])]
pub struct CreateGoodsListing<'info> {
    #[account(
        init,
        payer = authority,
        space = GoodsListing::SIZE,
        seeds = [b"good", seller.key().as_ref(), good_id.as_ref()],
        bump
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

    /// The moderation BLOCK floor over `metadata_hash` (§5.2). The handler
    /// derives `["moderation_block", metadata_hash]` itself and rejects a
    /// mismatched address, so it can be neither omitted nor substituted; a
    /// multisig-BLOCKED hash cannot be listed.
    ///
    /// CHECK: validated in the handler by `require_content_not_blocked`
    pub moderation_block: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Validate the operator fee leg pairing (shared with `update_goods_listing`):
/// operator set ⟺ fee > 0; per-leg cap; the operator may not be the seller's
/// wallet (self-dealing would let a seller dodge the combined-fee cap math by
/// routing "fees" back to themselves while looking like a third-party leg); and
/// the operator may not be the listing's own PDA (a program-owned non-signer
/// address that can never sweep its lamports — the fee would be locked forever
/// in the uncloseable listing account; batch-4 review GOODS-OP-PDA-02).
/// NOTE: a program-owned operator (e.g. a multisig vault PDA) is otherwise
/// allowed — only the listing's own address is rejected.
pub(crate) fn validate_operator_terms(
    operator: Pubkey,
    operator_fee_bps: u16,
    seller_authority: Pubkey,
    good_key: Pubkey,
) -> Result<()> {
    let has_operator = operator != Pubkey::default();
    require!(
        has_operator == (operator_fee_bps > 0),
        CoordinationError::GoodsInvalidOperatorTerms
    );
    require!(
        operator_fee_bps <= MAX_OPERATOR_FEE_BPS,
        CoordinationError::GoodsInvalidOperatorTerms
    );
    require!(
        operator != seller_authority,
        CoordinationError::GoodsInvalidOperatorTerms
    );
    require!(
        operator != good_key,
        CoordinationError::GoodsInvalidOperatorTerms
    );
    Ok(())
}

/// Shared metadata validation: hash non-zero, URI non-empty and bounded.
pub(crate) fn validate_goods_metadata(metadata_hash: &[u8; 32], metadata_uri: &str) -> Result<()> {
    require!(
        *metadata_hash != [0u8; 32],
        CoordinationError::GoodsInvalidMetadata
    );
    require!(
        !metadata_uri.trim().is_empty() && metadata_uri.len() <= GOODS_METADATA_URI_MAX_LEN,
        CoordinationError::GoodsInvalidMetadata
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateGoodsListing>,
    good_id: [u8; 32],
    name: [u8; 32],
    metadata_hash: [u8; 32],
    metadata_uri: String,
    price: u64,
    price_mint: Option<Pubkey>,
    tags: [u8; 64],
    total_supply: u64,
    operator: Pubkey,
    operator_fee_bps: u16,
) -> Result<()> {
    let config = &ctx.accounts.protocol_config;
    check_version_compatible(config)?;
    require_goods_enabled(config)?;

    let seller = &ctx.accounts.seller;
    require!(
        seller.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    require!(good_id != [0u8; 32], CoordinationError::GoodsInvalidId);
    require!(name != [0u8; 32], CoordinationError::GoodsInvalidName);
    validate_goods_metadata(&metadata_hash, &metadata_uri)?;
    require!(
        price >= MIN_GOOD_PRICE,
        CoordinationError::GoodsPriceBelowMinimum
    );
    require!(total_supply > 0, CoordinationError::GoodsInvalidSupply);
    validate_operator_terms(
        operator,
        operator_fee_bps,
        seller.authority,
        ctx.accounts.good.key(),
    )?;

    // The BLOCK floor: a multisig-blocked content hash cannot be listed.
    require_content_not_blocked(
        &ctx.accounts.moderation_block.to_account_info(),
        &metadata_hash,
    )?;

    let clock = Clock::get()?;
    let good = &mut ctx.accounts.good;

    good.seller = ctx.accounts.seller.key();
    good.seller_authority = ctx.accounts.seller.authority;
    good.good_id = good_id;
    good.name = name;
    good.metadata_hash = metadata_hash;
    good.metadata_uri = metadata_uri;
    good.price = price;
    good.price_mint = price_mint;
    good.tags = tags;
    good.initial_supply = total_supply;
    good.total_supply = total_supply;
    good.sold_count = 0;
    good.restock_count = 0;
    good.operator = operator;
    good.operator_fee_bps = operator_fee_bps;
    good.is_active = true;
    good.created_at = clock.unix_timestamp;
    good.updated_at = clock.unix_timestamp;
    good.bump = ctx.bumps.good;
    good._reserved = [0u8; 16];

    emit!(GoodsListingCreated {
        listing: good.key(),
        seller: seller.key(),
        good_id,
        name,
        metadata_hash,
        price,
        price_mint,
        total_supply,
        operator,
        operator_fee_bps,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operator_terms_pairing_is_enforced() {
        let seller = Pubkey::new_unique();
        let good = Pubkey::new_unique();
        let op = Pubkey::new_unique();
        // no operator, no fee: ok
        assert!(validate_operator_terms(Pubkey::default(), 0, seller, good).is_ok());
        // operator with fee: ok
        assert!(validate_operator_terms(op, 500, seller, good).is_ok());
        // operator without fee: reject (dangling payee)
        assert!(validate_operator_terms(op, 0, seller, good).is_err());
        // fee without operator: reject (fee to nowhere)
        assert!(validate_operator_terms(Pubkey::default(), 500, seller, good).is_err());
        // per-leg cap
        assert!(validate_operator_terms(op, MAX_OPERATOR_FEE_BPS, seller, good).is_ok());
        assert!(validate_operator_terms(op, MAX_OPERATOR_FEE_BPS + 1, seller, good).is_err());
        // operator == seller wallet: reject (self-dealing leg)
        assert!(validate_operator_terms(seller, 500, seller, good).is_err());
        // operator == the listing's own PDA: reject (GOODS-OP-PDA-02 — the fee
        // would be locked forever in the uncloseable listing account)
        assert!(validate_operator_terms(good, 500, seller, good).is_err());
    }

    #[test]
    fn metadata_validation_requires_hash_and_bounded_uri() {
        let hash = [7u8; 32];
        assert!(validate_goods_metadata(&hash, "https://x/y.json").is_ok());
        assert!(validate_goods_metadata(&[0u8; 32], "https://x/y.json").is_err());
        assert!(validate_goods_metadata(&hash, "").is_err());
        assert!(validate_goods_metadata(&hash, " \t ").is_err());
        let long = "u".repeat(GOODS_METADATA_URI_MAX_LEN + 1);
        assert!(validate_goods_metadata(&hash, &long).is_err());
        let max = "u".repeat(GOODS_METADATA_URI_MAX_LEN);
        assert!(validate_goods_metadata(&hash, &max).is_ok());
    }
}
