# Changelog

Entries below `v0.2.1` are `@tetsuo-ai/protocol` package releases from the
devnet era. Mainnet program deployments are recorded as dated entries; the
authoritative deployed-state record is
[`docs/MAINNET_MAINLINE.md`](./docs/MAINNET_MAINLINE.md).

## 2026-07-18 — revision-5 release hardening candidate (not deployed)

- **Bootstrap validation:** `initialize_protocol` now verifies the exact
  upgradeable-loader `ProgramData` state tag before reading variant-specific
  authority bytes. Compiled coverage exercises the canonical bootstrap, rejects
  every other loader-state tag, binds the PDA/owner/upgrade authority, rejects
  invalid custody and multisig shapes, and confirms replay protection.
- **HIGH — token custody:** task creation and every token transfer/close path now
  require the single canonical classic-SPL ATA for `(TaskEscrow PDA, reward mint)`.
  This closes a preinitialized-account attack that could retain an attacker close
  authority, strand funded custody, or substitute an escrow-owned token account at
  settlement. A compiled-program regression reproduces the exact hostile account
  transition and verifies atomic rejection; the mainnet scan found zero token tasks.
- **Lifecycle/accounting:** dispute liabilities are provenance-tagged and finalized
  exactly once; payout aliases and positive same-account lamport transfers fail
  closed; collaborative rewards cannot produce zero-value shares; token units no
  longer inflate SOL-denominated totals or reputation; canonical bid/job-spec terms,
  live-stake claim gates, and orphan-child rent recovery are enforced on-chain.
  Recovery now covers validator votes with exact submission/reviewer/PDA binding;
  the read-only scanner mirrors those checks and treats a dust-funded empty system
  PDA as absent, matching the program instead of reporting a false blocker. An
  approved `Complete` dispute now records the worker's actual net SOL earnings (or
  token-denominated completion without inflating SOL totals) while preserving the
  dispute path's intentional no-reputation policy.
- **Live-upgrade compatibility:** the revision-5 cutover now fails closed on open
  bids/bid bonds, live completion-bond principal, any revision-4 bond-post-eligible
  Task, malformed or under-backed reputation stakes, and every delegation record.
  Because deployed revision 4 did not pause-gate delegation, the candidate's
  wire-compatible retirement path is permissionless and immediate: it restores no
  slash-sheltered reputation, returns rent only to an identity-continuous recorded
  authority, and routes missing/re-registered identity rent only to the canonical
  treasury. Historical revision-4 Refund/Split dispute states remain finalizable
  without weakening the revision-5 ruling policy, and generic claim cleanup cannot
  consume their finalizer evidence.
- **Authority/release:** governance elections snapshot immutable safety parameters and
  retain multisig dual control; deploy preflights validate upgrade authority, live
  obligations, account layouts, payout bindings, and all supported build surfaces.
  Production is 98 instructions, explicit development `private-zk` is 101, and the
  frozen canary is 25; invalid mixed feature combinations now fail compilation.
  The candidate is 97,152 bytes larger than the live ProgramData payload capacity,
  so upgrade preflight now blocks until a separately reviewed Squads/loader
  `ExtendProgramChecked` action expands it. The rail models the loader's distinct
  45-byte ProgramData and 37-byte Buffer headers, mainnet's active minimum-extension
  rule, and the loader maximum; it pins Solana CLI 3.0.13, reads rent from the
  genesis-checked RPC, disables implicit auto-extension, and rejects concurrent
  capacity drift. Execute-mode step selection also refuses to deploy a needed
  binary while a migration is pending unless `sweep` immediately follows, so a
  partial `--only deploy` run cannot leave legacy accounts in the typed-read
  frozen window. The final release uses `stamp_release_surface`, which locks and
  validates the reviewed ProgramData metadata, canonical IDL, bid/moderation
  singletons, freshness, and Squads custody image in the same transaction that
  writes the revision. The Squads-CPI extension and upgrade must execute in
  different slots. No extension was authorized or executed here.
- **Memory safety/maintainability:** all 11 production lifetime transmutes were
  removed in favor of owned deserialization with explicit persist/close operations.
  Non-test builds deny `unsafe_code`; the remaining two unsafe blocks are confined to
  test fixtures that construct Anchor account headers.
- **Off-chain consumers:** worker job specs use a canonical content-addressed envelope
  with bounded, public-only DNS-pinned fetches; SDK, React, tools, MCP, CLI, starter,
  and checkout consumers were updated to carry exact provider/job-spec bindings.
  The SDK drift gate now hashes the generated path/byte tree immediately before and
  after deterministic regeneration, so it detects stale output without treating a
  reviewed uncommitted tree as drift. CI gates all four Rust profiles and every
  downstream workspace.
- **Unreleased coordinated package set:** the workspace candidates are protocol
  **0.4.0**, SDK **0.12.0**, React **0.4.2**, tools/MCP **0.5.0**, worker **0.2.0**,
  and scoped/unscoped CLI **0.3.0**. They are not published/live-version claims:
  protocol 0.3.0, SDK 0.11.0, React 0.4.1, tools/MCP 0.4.0, worker 0.1.1, and
  CLI 0.2.0 remain the published revision-4 set until the coordinated cutover.
- **Release supply chain:** npm publishes require OIDC provenance; GitHub Actions are
  pinned to full commit SHAs; the Agave bootstrap binary is version- and SHA-256-pinned;
  Dependabot tracks action/npm/Cargo updates. Protocol publication now requires the
  reusable verifiable-build job, validates both executable hashes as 64 hexadecimal
  characters, creates a draft, attaches the hash manifest, publishes npm, and only then
  makes the GitHub release public. Tag-derived values reach shell through environment
  variables rather than direct expression interpolation. Every external release
  mutation re-resolves the remote tag to the triggering commit and exact fetched tag
  object (including annotated tags), and a pre-existing npm version fails closed instead
  of being silently endorsed as a successful rerun.
- **Post-audit CodeQL and cold-release hardening:** all ten reported source patterns
  are remediated with bounded structural parsing or linear scans, including public
  error handling, npm identity validation, SDK retry classification, receipt URLs,
  and fail-closed worker URL redaction. Release packing now separates explicit
  prepack output from machine-readable `npm pack --json`, and both IDL drift and
  protocol-tag release jobs install Anchor's native dependencies on a cold cache.
- **Security operations:** GitHub Private Vulnerability Reporting is enabled as the
  verified private intake. The unconfirmed mailbox remains unadvertised, and active
  RFC 9116 metadata names only PVR. Release still requires deploying and verifying the
  exact metadata at both canonical hosts; no unverified contact is embedded in the
  candidate program.
- **Final local evidence (refreshed 2026-07-19):** Rust 524 production / 524
  `validation-timings` / 549 private-ZK / 321 canary; 77 model/property tests;
  408 compiled-program integrations (399 pass and 9 explicit canary-profile
  skips), plus the separate canary compiled suite passing 11/11; SDK 657 pass +
  one skip; 1,444 workspace tests pass + two skips; all 355 script tests pass,
  including the 239-test deployment/preflight subset. Strict Clippy,
  formatting, artifact drift, package smoke, and SBF stack gates are green. The final
  production SBF is 2,280,376 bytes with SHA-256
  `dd8aaf65ea56169459da77ac5e50f22c05d0c128b8fe2a314fc8bf7c4d2ace24`.
  The canonical candidate IDL contains 98 instructions / 43 accounts / 99 events /
  393 errors and has SHA-256
  `5ae986603626d0dfe9024c7dc180f184931622c350c0c32b4abf920a0d918f1b`.
- This is a pending candidate. Mainnet remains the revision-4, 99-instruction binary
  until an independently approved Squads upgrade and revision-5 stamp are complete.

## 2026-07-18 — adversarial-swarm wave complete (S-1–S-9, all items)

- a 13-agent adversarial swarm re-audited the full program after the F-1–F-19
  queue; every confirmed finding landed in a staged, gate-green commit on
  `fix/audit-findings-2026-07-16` — 415 Rust unit tests, 310 litesvm
  integration tests, 520 SDK tests (+e2e); clippy default+canary, artifacts,
  canary freeze, IDL reference, and SBF stack-frame check all green
- **CRITICAL** (`1b562b4`): `expire_dispute` no longer pays a self-disputing
  no-show 50% of escrow — expiry refunds the funder in full (post-P6.3 every
  expired dispute is unresolved); accepted-bid bond on expiry always refunds
- **HIGH** (`96fa6bd`): `initiate_dispute` stamps `last_dispute_initiated`, so
  the deregistration cooldown that guards `apply_initiator_slash` actually
  binds (it read a never-written field — dead code)
- **MED**: `validate_task_result` settles completion bonds on accept
  (`ab5b297`); `close_task` requires the canonical bid book and refuses while
  bids are live (`3e7a364`); ValidatorQuorum votes require the
  min-stake-for-dispute floor (`81d3be2`); delegation closed as a slash-vault
  for dispute defendants and the deregister→re-register reputation inflation
  loop killed via identity continuity (`ed0752a`, errors 6359/6360)
- **LOW batches** (`0b34a81`, `89779cf`): legacy-parent zero-pad load for
  `create_dependent_task`; u128 fee math in purchases; saturating dispute
  counters; slash-settlement rent to the creator; governance snap-vote floor;
  contest cancel deposit forfeit; deregister bid gate (error 6361) +
  verification-badge sweep; `TaskBidBook` rent sweep; `cancel_task` SBF stack
  fix (`task` boxed)
- **Docs**: D8–D13 added to `docs/DESIGN_DECISIONS.md` — quorum-is-friction,
  governance vote-weight redesign note, resolver leg conflict bound, V-2
  revote wedge, durable-dispute preflight, and the deliberate rejection of the
  dependency gate on ghost/frozen exits (money-never-locks)

## 2026-07-18 — full audit hardening queue complete (F-1–F-19, all items)

- the ENTIRE 2026-07 audit hardening queue is implemented and gated on branch
  `fix/audit-findings-2026-07-16` — 414 Rust unit tests, 296 litesvm
  integration tests, 520 SDK tests; clippy default+canary, artifacts, canary
  freeze, and IDL reference all green
- **P1** (`56f2451`): F-7 `reject_and_freeze` SOL-only guard (new error 6358)
  and F-4 `expire_claim` cleanup-reward skip on token tasks (was
  InsufficientFundsForRent on every token task)
- **P2**: F-8 (`b72ff99`) MCP tool-error + crash-handler sanitization with a
  shared redact module and rebuilt dist; F-9 (`53e2c4b`) dispute exits sweep
  the defendant's live submission (counters + worker rent) via optional
  trailing accounts; F-10 (`e89e525`) `auto_accept_task_result`'s hire_record
  is required + seeds-pinned (permissionless leg-skip closed)
- **P3**: F-11 expire_claim live-submission evidence guard + F-15 saturating
  recovery counters (`631a10f`); F-14 uniform bid-settlement offset on
  reject/expire paths + F-16 u128 fee math (`0c8f1a0`); F-18 multisig
  hardening — authority-membership rotation guard, KEEP sentinels for
  launch-control stale reads, dead helper removed, model documented
  (`dd519ad`); F-19 off-chain lows — template-name sanitization, URL
  redaction in credible-exit, genesis-hash cluster check, release-gate canary
  check, workflow permissions (`3285675`)
- **F-12**: `scripts/preflight-dispute-scan.mjs` — mainnet scan found 3
  Dispute accounts, all `total_voters == 0` (no legacy-dispute action needed)
- **F-17 + informational**: accepted trade-offs recorded in
  `docs/DESIGN_DECISIONS.md` (D1–D7 — do not re-file)
- remaining: deploy choreography for the whole upgrade package (human-run
  Squads ceremony, `surface_revision` 5 stamp, SDK/protocol minor releases)

## 2026-07-18 — audit P0 hardening queue complete (F-1, F-2, F-3, F-5)

- the full P0 queue from the 2026-07 audit's pass-3 report (TODO.MD) is
  implemented and gated on branch `fix/audit-findings-2026-07-16` — 409 Rust
  unit tests, 290 litesvm integration tests, 520 SDK tests; clippy
  default+canary, artifacts, canary freeze, and IDL reference all green
- **F-1** (`4b70630`): `cancel_task`'s no-show worker-bond forfeit is bound to
  a live no-show claimant — a creator can no longer sybil-claim, no-show, and
  forfeit an honest rejected worker's bond (new error 6356)
- **F-2** (`aa6aae5`): `close_task` can no longer brick the slash finalizers —
  `apply_initiator_slash` drops the Task account entirely, `resolve_dispute`
  keeps `current_workers == 1` while a worker slash is pending,
  `apply_dispute_slash` frees it, and `reclaim_terminal_claim` refuses a
  slash-pending deferred claim (new error 6357)
- **F-3** (`cc8870e`): the completing-accept sole-submission guard now covers
  the quorum/attestation path, and `reclaim_terminal_claim` accepts a
  REJECTED submission as evidence (un-bricking bounced claims)
- **F-5** (`b3eb824`): completion-bond accounts on `cancel_task` and
  `expire_reject_frozen` are required + seeds-pinned — a live bond can never
  be omitted into a terminal task; SDK facade and downstream callers updated
- F-6 is closed by on-chain verification: governance was already initialized
  on mainnet with sane params (2026-07-17)
- deploy choreography for this package (separate human-run step): multisig
  binary upgrade, then a `surface_revision` 5 stamp and coordinated
  SDK/package minor releases — wire changes are confined to non-canary
  instructions (`apply_initiator_slash`, `cancel_task`,
  `expire_reject_frozen`, writable flags on `reclaim_terminal_claim` /
  `apply_dispute_slash`)

## 2026-07-17 — 2026-07 adversarial-audit fixes land (`fix/audit-findings-2026-07-16`)

- the 2026-07-16/17 adversarial audit (three passes) is closed out on branch
  `fix/audit-findings-2026-07-16` (HEAD `d7f9d40`): all blocker fixes landed
  and every gate is green — 408 Rust unit tests, 284 litesvm integration
  tests, 520 SDK tests
- **pass 1 — 12 fixes:** C-1, H-1, H-2, H-3, H-5, M-1, M-2, M-3, M-5, L-2,
  L-3, L-4
- **pass 2 — 4 blocker fixes:** the M-2 schema gate, the H-1 legacy-record
  restore, the M-3 reserve-liveness check, and the L-4
  sanitize + dist + release wiring
- SDK regenerated from the refreshed program artifacts (`packages/sdk-ts`
  generated client committed alongside)
- remaining full-surface / SPL hardening is tracked in `TODO.MD` (F-1..F-19;
  F-6 closed by on-chain verification 2026-07-17) — no canary-reachable
  finding remains open

## 2026-07-09 — Batch-4 goods mainnet surface (99 instructions, `surface_revision = 4`)

- live mainnet binary is the full **99-instruction** surface; last deployed slot
  **431918664** (verified 2026-07-10 via `solana program show`)
- on-chain `ProtocolConfig.surface_revision = 4` (`SURFACE_REVISION_BATCH4`);
  SDK `getDeployedSurface` reports `goods: true`
- goods market live and revision-gated: `create_goods_listing` /
  `purchase_good` / `update_goods_listing` (`GoodsListing` + per-unit
  `SaleReceipt`)
- client cutover: `@tetsuo-ai/marketplace-sdk` **0.11.0**,
  `@tetsuo-ai/protocol` **0.3.0** — see `docs/VERSIONING.md` §1.1 and
  `docs/design/batch-4-goods.md`

## 2026-07-05 — Batch-2 store + batch-3 contest (additive, 94 → 96 ix)

- **batch-2** (`surface_revision = 2`, 94 ix): store identity
  (`register_store` / `update_store` / `close_store`),
  `moderation_heartbeat`, dispute/freeze-exit referrer legs, `rate_hire`
  rollup — sdk **0.9.0**
- **batch-3** (`surface_revision = 3`, 96 ix): contest rails —
  `distribute_ghost_share`, `reclaim_terminal_claim`, submission-rent return
  — sdk **0.10.0** / **0.10.1**
- both batches are additive (no flag-day wire cutover); P1.2-wire clients
  keep working. Design: `docs/design/batch-3-contest-tasks.md`,
  `docs/P5_2_STORE_IDENTITY_SPEC.md`, `docs/MODERATION_LIVENESS.md`

## 2026-07-03 — P1.2 open-roster mainnet deploy (90-instruction surface)

- deploy the P1.2 batch to mainnet (slot 430491216, commit `aad4c0d`), executed
  through the new Squads v4 2-of-3 upgrade-authority vault (`Cj9dWtov…`) — the
  same day the upgrade authority moved off the single key (P0.3, see
  `docs/UPGRADE_AUTHORITY.md`)
- make moderation-attestor registration **permissionless**:
  `register_moderation_attestor` (self-signed, 0.25 SOL refundable bond) +
  `request_attestor_exit` / `finalize_attestor_exit` (7-day cooldown, full
  refund; records rejected from the moment exit is requested)
- move `record_task_moderation` / `record_listing_moderation` to v2
  moderator-keyed PDAs (multiple attestors can attest the same content without
  clobbering); legacy-record grace path via `findLegacy*ModerationPda`
- add the multisig-gated `set_moderation_block` / `clear_moderation_block`
  BLOCK floor and the `set_default_trust_list` surface trust list
- decouple agent domain verification from the roster:
  `record_agent_verification` / `revoke_agent_verification` are global
  moderation-authority-only (P1.2 §4.6)
- **breaking (flag-day wire cutover):** `set_task_job_spec`,
  `hire_from_listing`, and `hire_from_listing_humanless` take a trailing
  `moderator` arg + a required `moderation_block` account; old-wire clients
  fail closed. Client cutover shipped the same day (sdk 0.8.0,
  react/tools/mcp 0.4.0). See `docs/MAINNET_ROLLOUT_RUNBOOK.md` §2.6
- restore the OtterSec verified-build badge for the new bytecode via a
  Squads vault transaction (`is_verified: true` at verify.osec.io; procedure
  recorded in `docs/MAINNET_ROLLOUT_RUNBOOK.md` §2.5)

## 2026-07-02 — WP-A1 roster-honored moderation gates mainnet deploy

- the three moderation consumption gates (`set_task_job_spec`,
  `hire_from_listing`, `hire_from_listing_humanless`) now accept attestations
  authored by a registered, non-revoked `ModerationAttestor` roster entry, not
  only the single global `moderation_authority` (PR #93, commit `254078a`;
  additive optional account, no layout change, no migration)
- at this point roster _membership_ was still authority-assigned
  (`assign_moderation_attestor`); registration went permissionless with P1.2
  the next day. Verification record: `docs/WP-A1-DEPLOY-READINESS.md`

## 2026-06-11 — Phase 9 full-surface mainnet upgrade (84 instructions)

- swap the mainnet binary from the 25-instruction `mainnet-canary` build to the
  full default-features surface (`surface_revision = FULL (1)`); mainnet is no
  longer the canary
- migrate the 169 live `Task` accounts (382B → 466B, 0 failures) and
  `ProtocolConfig` (349B → 351B)
- enable all task types and the bid marketplace; private (zk) completion stays
  deferred (`ZkConfig` uninitialized)
- rollout choreography recorded in `docs/MAINNET_ROLLOUT_RUNBOOK.md`

## v0.2.1

- refresh public protocol artifacts for the current reviewed-public marketplace devnet surface
- include launch-control/task-job-spec instructions such as `set_task_job_spec`
- include current CreatorReview settlement account layouts for `accept_task_result` and `reject_task_result`

## v0.2.0

- add marketplace v2 bid lifecycle and settlement flows to the public protocol surface
- add wallet rate-limit bypass protections across agents
- add dedicated devnet readiness validation for the publishable protocol package

## v0.1.1

- add the publishable `@tetsuo-ai/protocol` package under `packages/protocol`
- sync package-generated protocol assets from the committed canonical artifacts
- add build, typecheck, and pack-smoke validation for the public package in CI

## v0.1.0

- bootstrap the public `agenc-protocol` repository as the canonical protocol source of truth
- commit the Anchor IDL, generated TypeScript types, and protocol manifest under `artifacts/anchor`
- document the repository as the public trust-surface owner for AgenC
