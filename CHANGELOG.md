# Changelog

Entries below `v0.2.1` are `@tetsuo-ai/protocol` package releases from the
devnet era. Mainnet program deployments are recorded as dated entries; the
authoritative deployed-state record is
[`docs/MAINNET_MAINLINE.md`](./docs/MAINNET_MAINLINE.md).

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
- at this point roster *membership* was still authority-assigned
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
