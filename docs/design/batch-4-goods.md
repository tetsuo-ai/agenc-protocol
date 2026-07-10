# Batch 4 — GOODS: a rivalrous goods market primitive

> **Status: IMPLEMENTED and live on mainnet since 2026-07-09** at
> `surface_revision = 4` (99-instruction surface). This document preserves the
> design and adversarial-review invariants used for the shipped implementation.

## 1. What & why

Agents can sell **labor** (service listings → hire → task lifecycle) and
**reproducible digital products** (`skills`: infinite copies, protocol fee on
purchase). They cannot sell a **finite, transferable good** — "I own one, I sell
it, now you own it." The agenc-mmo economy proved agents produce and hold
inventory; item sales forced through the services/hire rail need moderation
authority keys + a fake fulfillment lifecycle, and exposed a bearer-redeemable
item-lock hole (mmo gap-hunt G1 — retired when the game migrates onto this
primitive, tracked as a follow-on).

**The primitive is a payment + provenance rail.** A good is OFF-CHAIN (no NFT —
e.g. a row in the game's item ledger). On-chain: the buyer pays, the protocol
takes its cut, the optional operator (store/embedder) takes its leg, and a
per-unit `SaleReceipt` records the sale. Delivery of the off-chain good is the
seller/app's responsibility, witnessed by the receipt — the exact `skills` trust
model, extended with rivalrous supply. **No moderation lifecycle, no fulfillment
lifecycle, no escrow, no refunds in v1.**

## 2. Surface

Two new account types (additive — **no migration**), three new instructions
(full module only, `#[cfg(not(feature = "mainnet-canary"))]`):

| Instruction | Signer | Effect |
|---|---|---|
| `create_goods_listing` | seller agent authority | init `GoodsListing` PDA `["good", seller_agent, good_id]` |
| `purchase_good` | **bare buyer wallet** (no agent) | pay seller/treasury/operator, init `SaleReceipt` PDA `["goods_sale", listing, serial_le]`, `sold_count += 1` |
| `update_goods_listing` | seller agent authority | mutate price / active / metadata / operator terms; **restock via additive delta only** |

**Deliberately absent:** `close_goods_listing`. Closing + re-creating the same
`good_id` would reset `sold_count` while the old buyers' receipt PDAs survive at
serials `0..N-1` — the first re-listed purchase's `init` collides and every
purchase fails (bricked listing), and old-run receipts alias new-run provenance.
Soft-delist (`is_active = false`) is the lifecycle, exactly like skills. Any
future close/rent-reclaim MUST first add a per-listing-lifetime `generation`
discriminator to the receipt seeds. Same reasoning defers `rate_good` (design
note §8).

## 3. Accounts

`GoodsListing` (from `SkillRegistration`, minus dead rating fields, plus):
`metadata_uri: String(≤256)` (site rendering; `metadata_hash` pins it),
`initial_supply: u64` (immutable), `total_supply: u64`, `sold_count: u64`
(monotonic; the next serial), `restock_count: u16`, `operator: Pubkey`
(`Pubkey::default()` = none — ServiceListing convention), `operator_fee_bps: u16`.

`SaleReceipt`: `listing, buyer (WALLET, bare signer), serial, metadata_hash
(SNAPSHOT at sale — receipts stay valid provenance even if the listing mutates),
price_paid, protocol_fee, operator_fee, timestamp, bump`. Seeded on the serial
passed as an **instruction argument** `expected_serial`, gated
`require!(expected_serial == sold_count)` — the gate is LOAD-BEARING (without it
a buyer could mint a receipt at an arbitrary future serial and corrupt the
namespace). Under contention the second buyer fails cleanly (`init` collision or
stale-serial) and retries; supply can never over-sell.

## 4. Money invariants (the review targets)

1. `seller_share + protocol_fee + operator_fee == price` exactly; each leg
   floored independently; seller keeps rounding dust.
2. Protocol cut = `ProtocolConfig.protocol_fee_bps` (500 bps live) → `treasury`
   — always, both rails (SOL + SPL), `purchase_skill` math verbatim.
3. Operator leg via `calculate_combined_fees` (completion_helpers): per-leg cap
   `MAX_OPERATOR_FEE_BPS`, combined cap `MAX_COMBINED_FEE_BPS`, seller floor —
   binding at PURCHASE time (config fee may drift after create).
4. Checked arithmetic everywhere; `overflow-checks = true` as the second layer.
5. Payee pinning: `seller_wallet == seller_agent.authority`, `treasury ==
   config.treasury`, `operator_wallet == listing.operator` (required account when
   the leg is live; `MissingOperatorAccount`).
6. Self-purchase blocked (`buyer wallet != seller authority`); purchases NEVER
   credit `AgentRegistration.total_earned` or any reputation counter —
   `sold_count` is a seller-influenceable signal and must never feed
   leaderboards.
7. Supply: `sold_count < total_supply` before payment; restock is
   `checked_add(additional_supply)` — an absolute set would permit a scarcity
   rug and a `sold_count` underflow.
8. SOL fee-leg payees must be rent-exempt or the transfer fails (WP-B2 lesson) —
   documented + SDK-preflighted, no on-chain skip logic.
9. The moderation BLOCK floor (`require_content_not_blocked` over
   `metadata_hash`) gates create AND purchase — the purchase-time check is the
   binding one (an updated hash is re-checked at every sale).
10. **Payout identity is SNAPSHOTTED (AC-2 review fix):** `GoodsListing.
    seller_authority` is captured at create; `purchase_good` pays that wallet
    and `update_goods_listing` authorizes against it — NOT the live
    `seller_agent.authority`. So deregistering the seller's agent_id and having
    an attacker re-register the same id (same agent PDA) cannot redirect payouts
    or seize control. A **suspended** seller stops selling on all pre-existing
    listings immediately (`purchase_good` requires `seller_agent.status !=
    Suspended`; Busy/Inactive are self-managed and still sell). The operator may
    not be the seller wallet nor the listing's own PDA (GOODS-OP-PDA-02).

### Rent-exempt payees (SOL rail, fail-closed)
Every SOL fee-leg payee (the snapshotted seller wallet, the treasury, and the
operator) must be **rent-exempt** (~890,880 lamports) when it receives its leg,
or Solana's runtime rent-state check reverts the whole purchase atomically
(`InsufficientFundsForRent` — no funds move or mis-split; the buyer loses only
the tx fee). This is the known WP-B2 settlement class. It cannot be validated at
listing time (the payee balance is a purchase-time property), so there is NO
on-chain skip/redirect logic (that would fork the split math). Mitigation is
client-side: the SDK exports `MIN_RENT_EXEMPT_PAYEE_LAMPORTS` and the storefront
must preflight the seller + operator balances and refuse to render a listing as
purchasable when any nonzero projected leg would leave a payee below the floor.

## 5. Versioning / gating

- `SURFACE_REVISION_BATCH4 = 4`; `ProtocolConfig::default()` stamps 4 for
  test/config fixtures. Mainnet was stamped to 4 in the 2026-07-09 ceremony.
- Every goods handler gates `check_version_compatible(config)` +
  `require_goods_enabled(config)` (= `surface_revision >= 4`,
  `GoodsSurfaceNotEnabled`). **This is the first ENFORCING use of
  `surface_revision`** (previously advisory/SDK-only). Ship-dark = deploy binary,
  stamp 4 last; **rollback-to-3 is the coarse kill switch** (disables goods
  without touching other surfaces).
- `is_valid_surface_revision` (migrate.rs) extended to accept 4; the
  update_launch_controls doc comment lists 4; pinned tests move 4 out of the
  rejected set.
- **Ceremony hazard (standing):** `update_launch_controls` rewrites ALL THREE
  fields (`protocol_paused`, `disabled_task_type_mask`, `surface_revision`) —
  every stamp call must fetch the live config and re-pass the live pause+mask
  (rehearsal asserts they survive byte-identical).

## 6. Errors / events

Errors appended (never reorder): `GoodsSurfaceNotEnabled, GoodsInvalidId,
GoodsInvalidName, GoodsInvalidMetadata, GoodsPriceBelowMinimum,
GoodsInvalidSupply, GoodsSoldOut, GoodsNotActive, GoodsPriceChanged,
GoodsSerialStale, GoodsSelfPurchase, GoodsUnauthorizedUpdate,
GoodsInvalidOperatorTerms, MissingOperatorAccount`.

Events: `GoodsListingCreated`, `GoodPurchased{serial, price_paid, protocol_fee,
operator_fee, remaining_supply}`, `GoodsListingUpdated`.

## 7. Test plan

Rust unit (validation + size asserts + revision tests) · litesvm
`tests-integration/goods.test.mjs`: create → purchase → decrement →
receipt-uniqueness → exact 3-leg fee split → sold-out → SPL rail → slippage →
additive restock (revert-test the set-style) → serial-stale → two concurrent
buyers (no over-sell) → wrong-operator-account reject → self-purchase block →
future-serial reject → takedown block → stamp-4 accepted · fuzz target
`purchase_good` (legs sum to price; supply never negative; unique receipt per
serial) · SDK structural + e2e.

## 8. Deferred (recorded, not built)

- `rate_good` (receipt-gated, `["good_rating", listing, rater]`, rater != seller,
  reputation-weighted like `rate_skill`) — needs sybil design under cheap
  bare-wallet purchases first.
- `close_goods_listing` / receipt rent reclaim — needs the `generation` seed.
- Event-only provenance mode for sub-rent-priced goods (v2 candidate; receipt
  rent ~0.0017 SOL/unit is disclosed in SDK preview + site docs).
- "My purchases" wallet index (site can already render per-listing receipts via
  dense-serial `getMultipleAccounts`).
