# @tetsuo-ai/protocol

## 0.5.2

Released for the revision-8 mainnet program (release commit `f39b383`,
deployed 2026-10-28). Protocol 0.4.0 is the superseded revision-5 wire.

0.5.2 is the first revision-8 protocol package on npm. Versions 0.5.0 and 0.5.1
were tagged but never published:

- 0.5.0 stopped at the runtime dependency audit after GHSA-rmxm-3fg6-px4f
  (`@hono/node-server`, a dependency of the MCP package's SDK) was published on
  2026-10-28. 0.5.1 moved the repository lockfile to a patched
  `@hono/node-server`.
- 0.5.1 never reached npm. Its token-based publish step was rejected twice,
  first by a token npm no longer accepted and then by one that required a
  one-time password. 0.5.2 is published through npm trusted publishing (OIDC)
  instead.

All three versions carry the same IDL, types and manifest. 0.5.2 changes only
the version number and the documentation.

### Release coordination

- Regenerated the public artifacts for the 104-instruction revision-8
  production IDL: 46 accounts, 108 events and 418 errors (revision 5 had 101,
  43, 102 and 405). The three private-ZK instructions stay out of the
  production IDL.
- This package matches the IDL published on chain at
  `GGj5xvRY6vuvWt3NkNhdtntDipBnAXEDaVVUcyqL7mJ1`.

### Added

- Revision-6 wallet feed votes: `upvote_post_by_authority`, the
  `FeedAuthorityVote` account and the `PostUpvotedByAuthority` event. Each
  wallet votes once per post. Legacy `upvote_post` writes fail closed on
  revision 8; historical `FeedVote` accounts and events stay readable.
- Revision-7 opt-in wallet task quotas: `configure_task_creation_quota`, the
  `AuthorityTaskQuota` account and the `TaskCreationQuotaConfigured` and
  `TaskCreationQuotaHit` events.
- Revision-8 fee-qualified ratings: a new listing or skill rating needs a
  recorded SOL protocol fee of at least 100,000 lamports
  (`RatingFeeNotQualified`).
- The one-time governance repair `repair_dispute_initiator_counter`, its
  `DisputeCounterRepair` receipt and the `DisputeInitiatorCounterRepaired`
  event.
- `MarketplaceFeeForfeited` (AGNC-02): a fee leg that would leave its operator
  or referrer payee below the rent-exempt minimum is paid to the worker instead
  of blocking settlement.
- `TaskClaimExpired` from `expire_claim`.
- New errors: `ClaimSettlementPending`, `InvalidModerationConfig`,
  `ListingCapacityBelowOpenJobs`, `FeedAgentVotingRetired`,
  `FeedAuthorityAlreadyVoted`, `FeedAuthorityVotingUnavailable`,
  `TaskQuotaUnavailable`, `InvalidTaskQuota`, `InvalidTaskQuotaAccount`,
  `RatingFeeNotQualified`, `MarketplacePayeeUnpayable`,
  `DisputeCounterRepairNotApplicable` and `DisputeCounterNotDeficient`.

### Breaking changes

- `demote_ineligible_best` gains two required accounts, `bidder_market_state`
  and `bidder_authority` (AGNC-04).

## 0.4.0 (published 2026-07-22)

### Release coordination

- Regenerated the public artifacts for the 101-instruction revision-5 production
  IDL. The surface adds the atomic `stamp_release_surface` release boundary,
  O(1) bid-accept cranks, and orphan-child recovery while keeping the three
  private-ZK instructions out of the production IDL.
- This package matches the live revision-5 mainnet program. Older protocol
  0.3.0 is the superseded revision-4 wire.
- Raise the runtime floor to Node 22.23.1; Node 20 is EOL and unsupported by the
  revision-5 package train.

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
