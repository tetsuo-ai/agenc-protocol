//! Batch 4 (docs/design/batch-4-goods.md): purchase one unit of a finite good.
//!
//! THE MONEY INSTRUCTION. The buyer is a BARE WALLET (no agent registration —
//! agent-gating buyers would kill the consumer funnel); the seller is paid via
//! their agent's authority wallet; the protocol takes `protocol_fee_bps` to the
//! treasury on every sale; an optional operator (store/embedder) leg rides the
//! same combined-fee cap as service settlements. Each sold unit mints its own
//! `SaleReceipt` PDA seeded on the sale serial.
//!
//! Money invariants (the adversarial-review targets):
//!   * `seller_share + protocol_fee + operator_fee == price` exactly (each fee
//!     leg floored independently; the seller keeps the rounding dust).
//!   * supply can never over-sell: `sold_count < total_supply` is checked before
//!     payment, `expected_serial == sold_count` pins the receipt PDA, and the
//!     receipt `init` makes a serial unmintable twice.
//!   * purchases NEVER credit reputation/earned counters — `sold_count` is a
//!     seller-influenceable signal and must never feed leaderboards.

use crate::errors::CoordinationError;
use crate::events::GoodPurchased;
use crate::instructions::completion_helpers::calculate_combined_fees;
use crate::instructions::constants::BASIS_POINTS_DIVISOR;
use crate::instructions::launch_controls::require_goods_enabled;
use crate::instructions::moderation_gate_helpers::require_content_not_blocked;
use crate::state::{AgentRegistration, AgentStatus, GoodsListing, ProtocolConfig, SaleReceipt};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
#[instruction(expected_serial: u64)]
pub struct PurchaseGood<'info> {
    #[account(
        mut,
        seeds = [b"good", good.seller.as_ref(), good.good_id.as_ref()],
        bump = good.bump
    )]
    pub good: Box<Account<'info, GoodsListing>>,

    /// One receipt per sold UNIT: seeded on the serial passed as an argument.
    /// The `expected_serial == good.sold_count` gate in the handler is
    /// LOAD-BEARING — without it a buyer could mint a receipt at an arbitrary
    /// future serial and corrupt the provenance namespace.
    #[account(
        init,
        payer = authority,
        space = SaleReceipt::SIZE,
        seeds = [b"goods_sale", good.key().as_ref(), expected_serial.to_le_bytes().as_ref()],
        bump
    )]
    pub sale_receipt: Box<Account<'info, SaleReceipt>>,

    /// Seller's agent registration — carried only to enforce the seller's
    /// agent-level STATUS (a suspended seller stops selling). The PAYEE is NOT
    /// sourced from this account (see AC-2): it is pinned to the listing's
    /// snapshotted `seller_authority`, so re-registering a deregistered agent_id
    /// cannot redirect payouts.
    #[account(
        seeds = [b"agent", seller_agent.agent_id.as_ref()],
        bump = seller_agent.bump,
        constraint = good.seller == seller_agent.key() @ CoordinationError::InvalidInput
    )]
    pub seller_agent: Box<Account<'info, AgentRegistration>>,

    /// CHECK: Validated as the listing's SNAPSHOTTED `seller_authority` (AC-2),
    /// NOT the current `seller_agent.authority`.
    #[account(
        mut,
        constraint = seller_wallet.key() == good.seller_authority @ CoordinationError::InvalidInput
    )]
    pub seller_wallet: UncheckedAccount<'info>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Validated as protocol_config.treasury
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidTreasury
    )]
    pub treasury: UncheckedAccount<'info>,

    /// The moderation BLOCK floor over the listing's CURRENT `metadata_hash` —
    /// checked at every sale, so a post-listing block (or a blocked hash swapped
    /// in via update) stops purchases immediately.
    ///
    /// CHECK: validated in the handler by `require_content_not_blocked`
    pub moderation_block: UncheckedAccount<'info>,

    /// The BUYER — a bare wallet signer; no agent registration required.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: operator payee; REQUIRED and pinned to `good.operator` whenever
    /// the listing carries an operator leg (validated in the handler — Anchor
    /// optional-account constraints don't run when the account is absent).
    #[account(mut)]
    pub operator_wallet: Option<UncheckedAccount<'info>>,

    // === Optional SPL Token accounts (mirror purchase_skill) ===
    pub price_mint: Option<Account<'info, Mint>>,

    #[account(mut)]
    pub buyer_token_account: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub seller_token_account: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub operator_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Option<Program<'info, Token>>,
}

/// Pure fee-leg math (unit-tested + fuzzed): protocol leg exactly as
/// `purchase_skill`; operator leg via the settlement-rail `calculate_combined_fees`
/// (per-leg + combined caps, seller floor). Returns
/// `(seller_share, protocol_fee, operator_fee)` with
/// `seller_share + protocol_fee + operator_fee == price` exactly.
pub(crate) fn split_good_price(
    price: u64,
    protocol_fee_bps: u16,
    operator_fee_bps: u16,
) -> Result<(u64, u64, u64)> {
    // u128 intermediates (audit F-16): price.checked_mul(bps) overflows u64 for
    // prices above ~9.2e15, DoS-ing the purchase; the post-division fee always fits.
    let protocol_fee = (price as u128)
        .checked_mul(protocol_fee_bps as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS_DIVISOR as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)? as u64;
    // calculate_combined_fees enforces: operator leg cap, combined cap
    // (protocol + operator ≤ MAX_COMBINED_FEE_BPS) and the payout floor —
    // binding at PURCHASE time so a post-create protocol-fee change can never
    // push the seller share below the floor. Referrer leg unused for goods.
    let (operator_fee, _referrer_fee) =
        calculate_combined_fees(price, protocol_fee_bps, operator_fee_bps, 0)?;
    let seller_share = price
        .checked_sub(protocol_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_sub(operator_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok((seller_share, protocol_fee, operator_fee))
}

pub fn handler(
    ctx: Context<PurchaseGood>,
    expected_serial: u64,
    expected_price: u64,
    expected_metadata_hash: [u8; 32],
) -> Result<()> {
    let config = &ctx.accounts.protocol_config;
    check_version_compatible(config)?;
    require_goods_enabled(config)?;

    // A SUSPENDED seller stops selling on all their pre-existing listings
    // immediately (batch-4 review AC-1/GOODS-SUB-2). Gate on Suspended
    // specifically — Busy/Inactive are self-managed operational states, not a
    // protocol-enforced ban, so requiring Active would break sales for a seller
    // legitimately marked Busy while working other tasks.
    require!(
        ctx.accounts.seller_agent.status != AgentStatus::Suspended
            && !ctx.accounts.seller_agent.is_retired_identity(),
        CoordinationError::AgentNotActive
    );

    let good = &ctx.accounts.good;
    require!(good.is_active, CoordinationError::GoodsNotActive);
    require!(
        good.sold_count < good.total_supply,
        CoordinationError::GoodsSoldOut
    );
    // LOAD-BEARING serial gate (see the accounts doc): the receipt PDA is
    // seeded on the caller-supplied serial; only the CURRENT sold_count is a
    // legal serial. A raced purchase fails here (or on the receipt `init`
    // collision) — cleanly, before any transfer.
    require!(
        expected_serial == good.sold_count,
        CoordinationError::GoodsSerialStale
    );

    // Slippage guard: the price the buyer previewed is the most they pay.
    let price = good.price;
    require!(
        price <= expected_price,
        CoordinationError::GoodsPriceChanged
    );
    require!(
        good.metadata_hash == expected_metadata_hash,
        CoordinationError::GoodsMetadataChanged
    );

    // Self-purchase block: wash-trading sold_count is not free. (Alt-wallet
    // sybil remains possible at the cost of the protocol fee — sold_count must
    // therefore never feed reputation; see the module doc.)
    require!(
        ctx.accounts.authority.key() != ctx.accounts.good.seller_authority,
        CoordinationError::GoodsSelfPurchase
    );

    // The BLOCK floor over the CURRENT metadata hash.
    require_content_not_blocked(
        &ctx.accounts.moderation_block.to_account_info(),
        &good.metadata_hash,
    )?;

    let (seller_share, protocol_fee, operator_fee) =
        split_good_price(price, config.protocol_fee_bps, good.operator_fee_bps)?;

    // Operator payee: required + pinned whenever the leg is live. Validated
    // in-handler because Anchor account constraints on an Option account do
    // not run when the account is omitted.
    let operator_wallet_info = if good.has_operator() {
        let operator_wallet = ctx
            .accounts
            .operator_wallet
            .as_ref()
            .ok_or(CoordinationError::MissingOperatorAccount)?;
        require!(
            operator_wallet.key() == good.operator,
            CoordinationError::MissingOperatorAccount
        );
        Some(operator_wallet.to_account_info())
    } else {
        None
    };

    let clock = Clock::get()?;

    if good.price_mint.is_some() {
        // === SPL token payment path ===
        require!(
            ctx.accounts.price_mint.is_some()
                && ctx.accounts.buyer_token_account.is_some()
                && ctx.accounts.seller_token_account.is_some()
                && ctx.accounts.treasury_token_account.is_some()
                && ctx.accounts.token_program.is_some(),
            CoordinationError::MissingTokenAccounts
        );

        let mint = ctx
            .accounts
            .price_mint
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let expected_mint = good.price_mint.ok_or(CoordinationError::InvalidTokenMint)?;
        require!(
            mint.key() == expected_mint,
            CoordinationError::InvalidTokenMint
        );

        let buyer_ta = ctx
            .accounts
            .buyer_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let seller_ta = ctx
            .accounts
            .seller_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let treasury_ta = ctx
            .accounts
            .treasury_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;

        // Mint checks
        let mint_key = mint.key();
        require!(
            buyer_ta.mint == mint_key,
            CoordinationError::InvalidTokenMint
        );
        require!(
            seller_ta.mint == mint_key,
            CoordinationError::InvalidTokenMint
        );
        require!(
            treasury_ta.mint == mint_key,
            CoordinationError::InvalidTokenMint
        );

        // Ownership checks
        require!(
            buyer_ta.owner == ctx.accounts.authority.key(),
            CoordinationError::InvalidInput
        );
        require!(
            seller_ta.owner == ctx.accounts.seller_wallet.key(),
            CoordinationError::InvalidInput
        );
        require!(
            treasury_ta.owner == ctx.accounts.treasury.key(),
            CoordinationError::InvalidInput
        );

        if seller_share > 0 {
            token::transfer(
                CpiContext::new(
                    token_program.to_account_info(),
                    Transfer {
                        from: buyer_ta.to_account_info(),
                        to: seller_ta.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                ),
                seller_share,
            )?;
        }
        if protocol_fee > 0 {
            token::transfer(
                CpiContext::new(
                    token_program.to_account_info(),
                    Transfer {
                        from: buyer_ta.to_account_info(),
                        to: treasury_ta.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                ),
                protocol_fee,
            )?;
        }
        if operator_fee > 0 {
            let operator_ta = ctx
                .accounts
                .operator_token_account
                .as_ref()
                .ok_or(CoordinationError::MissingOperatorAccount)?;
            require!(
                operator_ta.mint == mint_key,
                CoordinationError::InvalidTokenMint
            );
            require!(
                operator_ta.owner == good.operator,
                CoordinationError::MissingOperatorAccount
            );
            token::transfer(
                CpiContext::new(
                    token_program.to_account_info(),
                    Transfer {
                        from: buyer_ta.to_account_info(),
                        to: operator_ta.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                ),
                operator_fee,
            )?;
        }
    } else {
        // === SOL payment path ===
        if seller_share > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: ctx.accounts.seller_wallet.to_account_info(),
                    },
                ),
                seller_share,
            )?;
        }
        if protocol_fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                ),
                protocol_fee,
            )?;
        }
        if operator_fee > 0 {
            let operator_info =
                operator_wallet_info.ok_or(CoordinationError::MissingOperatorAccount)?;
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: operator_info,
                    },
                ),
                operator_fee,
            )?;
        }
    }

    // Burn a unit of supply (bounded by the sold-out gate above).
    let good = &mut ctx.accounts.good;
    good.sold_count = good
        .sold_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let remaining_supply = good
        .total_supply
        .checked_sub(good.sold_count)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Mint the per-unit provenance receipt (metadata_hash SNAPSHOTTED so the
    // receipt stays valid even if the listing's metadata is later updated).
    let receipt = &mut ctx.accounts.sale_receipt;
    receipt.listing = good.key();
    receipt.buyer = ctx.accounts.authority.key();
    receipt.serial = expected_serial;
    receipt.metadata_hash = good.metadata_hash;
    receipt.price_paid = price;
    receipt.protocol_fee = protocol_fee;
    receipt.operator_fee = operator_fee;
    receipt.timestamp = clock.unix_timestamp;
    receipt.bump = ctx.bumps.sale_receipt;
    receipt._reserved = [0u8; 8];

    emit!(GoodPurchased {
        listing: good.key(),
        buyer: ctx.accounts.authority.key(),
        seller: good.seller,
        serial: expected_serial,
        metadata_hash: good.metadata_hash,
        price_paid: price,
        protocol_fee,
        operator_fee,
        remaining_supply,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instructions::constants::{
        MAX_COMBINED_FEE_BPS, MAX_OPERATOR_FEE_BPS, MAX_PROTOCOL_FEE_BPS,
    };

    #[test]
    fn split_legs_sum_to_price_exactly() {
        // The core money invariant across a sweep of prices and fee configs.
        for price in [1_000u64, 5_000_000, 999_999_999, 1, 3] {
            for protocol_bps in [0u16, 100, 500, MAX_PROTOCOL_FEE_BPS] {
                for operator_bps in [0u16, 1, 500, MAX_OPERATOR_FEE_BPS] {
                    let (seller, protocol, operator) =
                        split_good_price(price, protocol_bps, operator_bps).unwrap();
                    assert_eq!(
                        seller + protocol + operator,
                        price,
                        "legs must sum exactly (price={price} p={protocol_bps} o={operator_bps})"
                    );
                }
            }
        }
    }

    #[test]
    fn split_dust_rounds_to_seller() {
        // 5% of 3 lamports floors to 0 — the dust stays with the seller and no
        // 0-lamport transfer is attempted (transfers are gated on > 0).
        let (seller, protocol, operator) = split_good_price(3, 500, 0).unwrap();
        assert_eq!((seller, protocol, operator), (3, 0, 0));
    }

    #[test]
    fn split_rejects_over_cap_operator() {
        assert!(split_good_price(1_000_000, 500, MAX_OPERATOR_FEE_BPS + 1).is_err());
        // Combined cap binds at purchase time: protocol 2000 + operator 2000 is
        // exactly the cap; one more bp on either leg must fail.
        assert!(split_good_price(1_000_000, MAX_PROTOCOL_FEE_BPS, MAX_OPERATOR_FEE_BPS).is_ok());
        assert!(
            MAX_PROTOCOL_FEE_BPS as u32 + MAX_OPERATOR_FEE_BPS as u32
                == MAX_COMBINED_FEE_BPS as u32
        );
    }

    #[test]
    fn split_max_fees_leave_seller_floor() {
        // At both caps the seller keeps exactly 60% (the settlement floor).
        let (seller, protocol, operator) =
            split_good_price(1_000_000, MAX_PROTOCOL_FEE_BPS, MAX_OPERATOR_FEE_BPS).unwrap();
        assert_eq!(protocol, 200_000);
        assert_eq!(operator, 200_000);
        assert_eq!(seller, 600_000);
    }

    #[test]
    fn split_handles_prices_above_the_u64_mul_overflow_threshold() {
        // Audit F-16 parity (revert-sensitive): price.checked_mul(bps) overflows u64
        // for prices above u64::MAX / 10_000, which used to DoS the purchase with
        // ArithmeticOverflow. The u128-intermediate math must return Ok AND still
        // conserve exactly at those prices.
        for price in [u64::MAX / 1000, u64::MAX - 7] {
            for (p_bps, o_bps) in [
                (500u16, 100u16),
                (MAX_PROTOCOL_FEE_BPS, MAX_OPERATOR_FEE_BPS),
            ] {
                let (seller, protocol, operator) = split_good_price(price, p_bps, o_bps)
                    .expect("huge prices must not overflow the fee multiply");
                assert_eq!(
                    (seller as u128) + (protocol as u128) + (operator as u128),
                    price as u128,
                    "legs must sum exactly (price={price} p={p_bps} o={o_bps})"
                );
            }
        }
    }
}
