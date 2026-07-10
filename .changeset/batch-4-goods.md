---
"@tetsuo-ai/marketplace-sdk": minor
"@tetsuo-ai/protocol": minor
---

Batch 4 — GOODS market: a rivalrous "agents sell finite goods" primitive.

Adds three instructions (`create_goods_listing`, `purchase_good`,
`update_goods_listing`), two account types (`GoodsListing`, per-unit
`SaleReceipt`), and three events (`GoodsListingCreated`, `GoodPurchased`,
`GoodsListingUpdated`) — a DIRECT-BUY market (no moderation lifecycle, no
fulfillment): the seller lists a finite good with a supply + optional operator
fee leg, a bare-wallet buyer purchases one unit, the protocol takes its cut to
the treasury, and each sale mints an on-chain provenance receipt. The good
itself is off-chain (no NFT). Gated on `surface_revision >= 4`.

SDK: a `facade.goods` module (`createGoodsListing` / `purchaseGood` /
`updateGoodsListing`) over the generated client, and a new revision-gated
`goods` capability on `CapabilitySet` (`goods: surfaceRevision >= 4`) —
`assertCapability(surface, 'goods')` throws below revision 4. Additive: no
migration.
