# @tetsuo-ai/marketplace-sdk

## 0.4.0

### Minor Changes

- Phase 3 data-plane client surfaces: `createIndexerClient()` (hosted-indexer read
  transport with decode-parity against the `queries` gPA module),
  `verifyAgencWebhookSignature()` (WebCrypto HMAC verification of the storefront's
  `X-Agenc-Signature` deliveries), and `requestListingModeration()` at the package
  root (the production moderation helper, resolved through the
  `AGENC_SANDBOX_MODERATION_URL` environment seam). Adds the README RPC-strategy
  section.

## 0.3.0

### Minor Changes

- 2711422: Phase 2 test-mode: the `@tetsuo-ai/marketplace-sdk/testing` subpath
  (`startLocalMarketplace()` — full marketplace flows against the real compiled
  program in-process via litesvm, program binary shipped in the tarball, moderator
  attest helpers, per-actor clients) and the `@tetsuo-ai/marketplace-sdk/sandbox`
  subpath (`createSandboxClient()` devnet wiring with airdrop + devnet guard,
  seeded-fixture constants, `requestSandboxAttestation`), plus the devnet
  deploy runbook, the seeding script, and the nightly sandbox canary workflow.
  litesvm becomes an optional peer dependency (required only for `./testing`).

## 0.2.0

### Minor Changes

- 8bcb9a7: Phase 1 SDK runtime core: `createMarketplaceClient` transaction runtime (transport
  seam, compute-budget defaults, blockhash-expiry retry, typed `AgencError`), typed
  `queries` getProgramAccounts read path with drift-proofed offsets, event codecs for
  all 82 program events plus log parsing/subscriptions/`waitForTaskStatus`, the
  `values` module (ids, sha256/descriptionHash, listing-metadata codecs, clean-room
  canonical job-spec hash with kit cross-implementation vectors), and the
  LISTING_METADATA v1 standard (string inputs on `createServiceListing`, published
  JSON Schema).

## 0.1.0

Initial release.

- Codama-generated `@solana/kit` client for the full 80-instruction
  `agenc-coordination` program surface (instructions, account decoders, PDA
  helpers, error codes), generated from the committed Anchor IDL with a CI
  drift gate.
- Ergonomic `facade` namespace wrapping 78/80 instructions (`claim_task` is
  fail-closed in the program and `complete_task_private` is the ZK path —
  intentional skips): agents, listings, tasks, completion bonds, disputes,
  moderation, bids, governance, reputation.
- ESM + CJS + `.d.ts` bundles; `@solana/kit` and `@solana/program-client-core`
  as peer dependencies.
- Structural test suite plus real on-chain litesvm e2e coverage against the
  compiled program.
- MIT licensed.
