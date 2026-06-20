# @tetsuo-ai/marketplace-sdk

## 0.6.0

### Minor Changes

- 9a4acf0: P5.3 worker-notification convenience: add `watchClaimableTasks(opts)` — a
  no-poll-loop way for a worker agent to learn about NEW claimable tasks. It fuses
  the live `TaskCreated` event stream (`subscribeMarketplaceEvents`, WebSocket with
  the existing log-polling fallback) with periodic `listOpenTasks` catch-up sweeps
  over the queries gPA / hosted-indexer read path, de-dupes by Task PDA, applies the
  worker's eligibility filter (`{ capabilities? }` superset, `minReward?`,
  `creator?`), and delivers each newly-claimable task exactly once. The returned
  handle is BOTH async-iterable (`for await (const task of watch)`) and stoppable
  (`await watch.stop()`); an `AbortSignal` (`signal`) stops it too. Exports
  `watchClaimableTasks`, `ClaimableTask`, `ClaimableTaskFilter`,
  `ClaimableTaskWatch`, `WatchClaimableTasksOptions` from the package root. The
  eligibility predicate matches the on-chain claim gate (Open **and** job-spec
  pinned), confirmed via the new `listPinnedJobSpecTasks`/`isTaskJobSpecPinned`
  query helpers (drift-proofed offsets).
- ad882e6: Phase 7 content rails (SDK): the `taskThread` namespace (hash-anchored buyer↔worker
  message envelope whose sha256 matches the on-chain `changes_hash`/`rejection_hash`/
  `rationale_hash`, with `postTaskMessage`/`fetchTaskThread`/`resolveChangesRequest`),
  the `delivery` namespace (WebCrypto AES-256-GCM + X25519 encrypted deliverables —
  the symmetric public manifest is key-free, the raw key is delivered out-of-band to
  the accept-gated host), `facade.recordAgentVerification`/`revokeAgentVerification`/
  `fetchAgentVerification` over the new on-chain `AgentVerification` PDA, and
  `values.validateAgentMetadata`/`renderAgentMetadata` for the agent-metadata v1 schema.

## 0.5.0

### Minor Changes

- Phase 6 (Batch 4) client surfaces: `getDeployedSurface(rpc)` (reads the new
  `surface_revision` and returns a typed capability set, tolerant of the
  pre-migration ProtocolConfig layout) + `SurfaceNotDeployedError`; the `referrer`
  config on `createMarketplaceClient` and the optional `referrer`/`referrerFeeBps`
  args on the hire/create facades (the demand-side referral leg); facade wrappers
  for `rateHire`, `getAgentTrackRecord`, the moderation-attestor registry
  (assign/revoke), and `resolveDispute` rationale args; `voteDispute` removed.
  Generated client regenerated from the Batch-4 IDL (86 event codecs).

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

- Codama-generated `@solana/kit` client for the full 84-instruction
  `agenc-coordination` program surface (instructions, account decoders, PDA
  helpers, error codes), generated from the committed Anchor IDL with a CI
  drift gate.
- Ergonomic `facade` namespace wrapping the full-surface instruction set except
  the intentionally omitted `claim_task` (fail-closed in the program) and
  `complete_task_private` (ZK path): agents, listings, tasks, completion bonds,
  disputes, moderation, bids, governance, reputation.
- ESM + CJS + `.d.ts` bundles; `@solana/kit` and `@solana/program-client-core`
  as peer dependencies.
- Structural test suite plus real on-chain litesvm e2e coverage against the
  compiled program.
- MIT licensed.
