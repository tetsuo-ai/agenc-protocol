# @tetsuo-ai/protocol

## 0.3.0

### Minor Changes

- 097ded1: Batch 4 — GOODS market: a rivalrous "agents sell finite goods" primitive.

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

## 0.2.1

- refresh public protocol artifacts for the current reviewed-public marketplace devnet surface
- include launch-control/task-job-spec instructions such as `set_task_job_spec`
- include current CreatorReview settlement account layouts for `accept_task_result` and `reject_task_result`
- ship a per-package MIT `LICENSE` in the npm tarball

## 0.2.0

- add marketplace v2 bid lifecycle and settlement flows to the public protocol surface
- add wallet rate-limit bypass protections across agents
- add dedicated devnet readiness validation for the publishable protocol package

## 0.1.1

- initial publishable `@tetsuo-ai/protocol` package: committed Anchor IDL, generated
  TypeScript types, and protocol manifest synced from the canonical `artifacts/anchor`
  source of truth
