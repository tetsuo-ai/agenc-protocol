# @tetsuo-ai/marketplace-sdk

## 0.8.3

### Patch Changes (sandbox on-ramp — WP-D4)

- The dead `sandbox.agenc.tech` default is GONE: the sandbox attestor URL now
  resolves option > `AGENC_SANDBOX_ATTESTOR_URL` > null with a fail-fast
  error naming the escape hatches; the moderation default remains the live
  `https://attest.agenc.ag`. Default sandbox cluster is now the documented
  localnet stack (`AGENC_SANDBOX_CLUSTER=devnet` still opts into devnet).
- Fixture seeder fixed for the P1.2 wire (moderator-keyed moderation PDAs) —
  it crashed mid-run before.
- `examples/localnet-first-hire.ts` replaces `devnet-first-hire.ts`: a proven
  zero-env end-to-end hire (hireAndActivate -> submit -> accept) against the
  localnet stack. See docs/LOCALNET.md.

## 0.8.2

### Patch Changes (additive, no wire change)

- New `hireAndActivate(client, input)` orchestration (WP-D6): the complete
  buyer-side service-hire flow — `hire_from_listing_humanless` -> caller's
  host/moderate callback (the attestation-service contract) ->
  `set_task_job_spec` — in the open SDK, so the proprietary kit is no longer
  the only complete hire orchestration. Auto-resolves the P1.2 gate mechanics
  (roster PDA / legacy record override) when an RPC is supplied; fails closed
  before signing activation on any unattested/invalid moderation result.
- New `resolveActivationModerationAccounts` / `resolveHireListingModerationAccounts`
  exports (the SDK home of the gate-account resolution marketplace-react
  introduced).

## 0.8.1

### Patch Changes (additive, no wire change)

- New `settlementReceiptUrl(txSignature, baseUrl?)` export: builds the
  canonical shareable settlement-receipt URL
  (`https://agenc.ag/receipt/<txSig>`) for accept / auto-accept / complete
  settlements. Settle flows should surface it as the final line of the
  settlement handoff; `baseUrl` points at another node's receipt surface.

## 0.8.0

### Minor Changes (breaking — the P1.2 open-roster flag-day cutover)

- P1.2 open-roster client (90-instruction surface), matching the mainnet
  program as upgraded 2026-07-03 through the 2-of-3 Squads upgrade authority.
  Every changed instruction fails CLOSED for 0.7.x-built transactions, and
  0.8.0-built transactions are rejected by pre-P1.2 deployments — all
  first-party consumers move to `^0.8.0` together (runbook §2.6).
- The three consumption gates — `set_task_job_spec`, `hire_from_listing`,
  `hire_from_listing_humanless` — gain a REQUIRED trailing `moderator: Pubkey`
  argument (the pubkey whose attestation the gate consumes) and a REQUIRED
  `moderation_block` BLOCK-floor account (`["moderation_block", hash]`;
  facade-derived from the spec/job hash). Gate account counts: 8→9 / 13→14 /
  12→13. The facades take `moderatorIsAttestor: true` to derive+attach the
  `["moderation_attestor", moderator]` roster entry for registered attestors,
  and default the optional roster slot to None on the global-authority path.
- `record_task_moderation` / `record_listing_moderation` write v2
  moderator-keyed record seeds (`["task_moderation_v2", task, hash,
  moderator]` + the listing mirror) so each attestor owns an exclusive record
  slot; account order changed. Pre-upgrade records stay consumable through a
  grace window via the new `facade.findLegacyTaskModerationPda` /
  `facade.findLegacyListingModerationPda` and the gates' explicit record
  overrides.
- New open-roster surface: permissionless `registerModerationAttestor`
  (fixed refundable bond), `requestAttestorExit`/`finalizeAttestorExit`
  (cooldown + full refund; records rejected from the moment of the request),
  multisig-gated `setModerationBlock`/`clearModerationBlock` (content-hash
  takedown floor) and `setDefaultTrustList` (advisory defaults pointer).
  `revoke_moderation_attestor` is scoped to entries the authority deputized.
- `record_agent_verification` / `revoke_agent_verification` drop their
  optional attestor account (global-authority-only; decoupled from the
  moderation roster).

## 0.7.1

### Patch Changes

- Ship a default hosted moderation endpoint (WP-C1/P1.5). The moderation
  environment seam previously resolved `moderationUrl` to `null` with no
  shipped default, so `requestListingModeration()` threw unless an endpoint
  was configured. It now defaults (mainnet only) to the open, self-hostable
  marketplace moderation API at `https://attest.agenc.ag/v1/moderation/listings`
  (`github.com/tetsuo-ai/agenc-moderation-api`); localnet/devnet still resolve
  to `null` so a sandbox never silently dials the mainnet service, and the
  `AGENC_SANDBOX_MODERATION_URL` env var / `endpoint` option still override on
  any cluster. Exposes `DEFAULT_HOSTED_MODERATION_LISTINGS_URL`.

## 0.7.0

### Minor Changes (breaking against pre-A1 programs)

- WP-A1 roster-gate IDL: the three moderation consumption gates gain an
  optional `moderation_attestor` account — `set_task_job_spec` (7→8 accounts),
  `hire_from_listing` (12→13), `hire_from_listing_humanless` (11→12) — so
  attestations signed by a registered, non-revoked `ModerationAttestor` are
  accepted alongside the global `moderation_authority`. Matches the mainnet
  program as upgraded 2026-07-02 (program
  `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`).
- Breaking: Anchor 0.32 requires optional accounts to be present in the
  account list (as the program ID sentinel when unset), so sdk 0.6.x-built
  instructions are rejected (fail-closed) by the upgraded program, and 0.7.0
  instructions are rejected by pre-A1 deployments. All first-party consumers
  must move to `^0.7.0` together.

## 0.6.1

### Patch Changes

- Publish the current marketplace lifecycle facade surface used by the React
  starter, including the `closeTask` input shape that accepts an explicit
  `creatorCompletionBond` and handles optional hired-task close accounts for
  terminal cleanup.
- Include the current generated protocol surface and SDK lifecycle tests so
  public registry consumers match the merged source used by
  `@tetsuo-ai/marketplace-react@0.2.0`.

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
