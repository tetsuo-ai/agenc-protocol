# Mainnet Mainline

This document records what `main` means for the live AgenC protocol.

## Policy

`main` is the canonical public branch for the currently deployed mainnet
program source. It should not drift away from the live full-surface program.

When the on-chain mainnet program changes, update `main` in the same release
window or before the deploy is announced publicly.

## Current Mainnet Deployment

> **As of 2026-07-09 the full 99-instruction surface is live on mainnet**
> (`surface_revision = 4` / `SURFACE_REVISION_BATCH4`, last deployed slot
> **431918664**). Growth path: 25-ix canary → 84-ix full surface (2026-06-11) →
> 90-ix P1.2 open roster (2026-07-03, slot 430491216) → additive batches 2–4
> (store + moderation heartbeat → contest → goods) culminating in the current
> binary. Verified live on 2026-07-10: on-chain `ProtocolConfig.surface_revision
> = 4` and SDK `getDeployedSurface` reports `goods: true`.

- Program ID: `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`
- Program source path: `programs/agenc-coordination/`
- `declare_id!` location: `programs/agenc-coordination/src/lib.rs`
- Live surface: **full 99-instruction surface** (default features),
  `surface_revision = 4` (BATCH4)
- Last deployed in slot: **431918664** (batch-4 / goods-enabled binary; verified
  2026-07-10 via `solana program show`)
- Instruction inventory: committed IDL +

## Pending Next Upgrade (2026-07-18 — implemented, not yet deployed)

The 2026-07 audit P0 hardening queue is implemented and gated on
`fix/audit-findings-2026-07-16` (commits `4b70630` F-1, `aa6aae5` F-2,
`cc8870e` F-3, `b3eb824` F-5; F-6 closed by on-chain verification). All wire
changes are confined to **non-canary** instructions:

- `apply_initiator_slash`: `task` account REMOVED (old callers' extra account
  becomes an ignored remaining account — backward-compatible);
- `cancel_task`: completion-bond accounts optional → required + seeds-pinned
  (full-surface only — they are `#[cfg(not(feature = "mainnet-canary"))]`, so
  the frozen canary IDL is untouched);
- `expire_reject_frozen`: both bond accounts optional → required + seeds-pinned;
- `reclaim_terminal_claim` / `apply_dispute_slash`: writable-flag flips only.

Deploy choreography (human-run, Squads multisig): binary upgrade → stamp
`surface_revision = 5` via `update_launch_controls` → coordinated
`@tetsuo-ai/marketplace-sdk` minor release (facade `cancelTask` now derives the
bond PDAs; `applyInitiatorSlash` loses the `task` input) and
`@tetsuo-ai/protocol` regen. New error codes are tail-appended (6356/6357) —
no existing code shifts; no account-layout change (`state.rs` diff is empty).
  [`reference/INSTRUCTIONS.md`](./reference/INSTRUCTIONS.md) (**99** instructions)
- Verified build: **LIVE** — the OtterSec/osec.io registry reports
  `is_verified: true` for the deployed bytecode against this repo (check
  <https://verify.osec.io/status/HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK>);
  keeping the badge across upgrades is a deploy invariant — see
  [`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) §2.5 and
  [`VERIFIABLE_BUILDS.md`](./VERIFIABLE_BUILDS.md)
- Task types: **all enabled** (`disabled_task_type_mask = 0`: Exclusive,
  Collaborative, Competitive, BidExclusive)
- Bid marketplace: **LIVE** (`BidMarketplaceConfig` initialized)
- Store identity: **LIVE** (`register_store` / `update_store` / `close_store`)
- Contest tasks: **LIVE** (`distribute_ghost_share`, `reclaim_terminal_claim`,
  contest rails on schema-1 Competitive + CreatorReview)
- Goods market: **LIVE** and revision-gated (`surface_revision >= 4`;
  `create_goods_listing` / `purchase_good` / `update_goods_listing`)
- Private completion: **OFF / deferred** — `ZkConfig` not initialized, so
  `complete_task_private` is unavailable until `initialize_zk_config` runs with
  the audited agenc-prover image id (its init is multisig-gated per audit H-5)
- Upgrade authority: **Squads v4 2-of-3 multisig vault**
  `Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf` (since 2026-07-03; distinct from
  the on-chain `ProtocolConfig` config multisig that gates fees/launch
  controls/the BLOCK floor) — see [`UPGRADE_AUTHORITY.md`](./UPGRADE_AUTHORITY.md).
  Verify live with `solana program show HJsZ…` (`Authority:` = the vault)
- Moderation: **permissionless attestor roster** (`ModerationConfig`
  initialized) — any wallet may self-register
  via `register_moderation_attestor` (0.25 SOL refundable bond) and its CLEAN
  records satisfy the publish/hire gates; the hosted attestor at
  `attest.agenc.ag` is one roster member, not a privileged one
- Governance: **LIVE** (`GovernanceConfig` initialized — authority = the
  protocol authority, min proposal stake 0.01 SOL, voting period 86400s,
  execution delay 3600s, quorum 300 bps, approval threshold 5000 bps; 1
  proposal to date)
- Launch controls are configured on-chain and may disable task types or flows
  without changing the source branch identity

### Prior deployment history

- **2026-07-05…09 — Additive batches 2–4 (94 → 96 → 99 ix, revisions 2 → 3 → 4).**
  Batch-2: store identity + `moderation_heartbeat` + dispute/freeze-exit referrer
  legs + `rate_hire` rollup. Batch-3: contest surface (`distribute_ghost_share`,
  `reclaim_terminal_claim`, submission-rent return). Batch-4: goods market
  (revision-gated; stamping 4 turns goods on). Client packages:
  marketplace-sdk 0.9.0 / 0.10.0 / 0.11.0. See
  [`VERSIONING.md`](./VERSIONING.md) §1.1 and
  [`design/batch-3-contest-tasks.md`](./design/batch-3-contest-tasks.md) /
  [`design/batch-4-goods.md`](./design/batch-4-goods.md).
- **2026-07-03 — P1.2 open-roster (90 instructions), slot 430491216, commit
  `aad4c0d`.** Flag-day wire cutover: `set_task_job_spec` / `hire_from_listing` /
  `hire_from_listing_humanless` gained a trailing `moderator` arg + required
  `moderation_block` account; moderation records moved to v2 moderator-keyed
  seeds; attestor registration became permissionless. Upgrade executed through
  the Squads vault the same day the upgrade authority moved off the single key.
  See [`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) §2.6 and
  [`P1_2_OPEN_ROSTER_SPEC.md`](./P1_2_OPEN_ROSTER_SPEC.md).
- **2026-07-02 — WP-A1 roster-consumption gates.** The three moderation
  consumption gates began honoring registered roster attestors' attestations
  (previously only the single global `moderation_authority` unlocked a
  publish/hire). Additive account only; no layout change. See
  [`WP-A1-DEPLOY-READINESS.md`](./WP-A1-DEPLOY-READINESS.md).
- **2026-06-11 — Phase 9 full-surface upgrade (84 instructions).** The binary
  was swapped from the 25-instruction canary build to the full default-features
  build, the 169 live Task accounts were migrated (382B → 466B, 0 failures), and
  `ProtocolConfig` was migrated (349B → 351B, `surface_revision = FULL (1)`).
  Mainnet stopped being the canary. See
  [`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md).

## Branch History Note

The rollout work was staged on `mainnet/hjs-program-id`. At the time this
document was added, the deployed mainnet source tree matched `main`, so `main`
remains the only branch downstream integrators should treat as canonical.

Historical branches may remain in the repo for auditability, but they are not
the branch of record once `main` matches the deployed tree.

## Release Discipline

Before or during any future mainnet upgrade:

1. Confirm the live `programId` and upgrade target.
2. Confirm `main` contains the exact program source tree being deployed.
3. Refresh this file if the live scope or rollout rules changed (slot,
   `surface_revision`, instruction count, upgrade authority).
4. Keep committed artifacts and downstream protocol consumers aligned.
5. Publish/upgrade the **on-chain IDL per cluster** (`anchor idl init` first time,
   `anchor idl upgrade` thereafter) so the deployed IDL is fetchable truth. Mainnet
   now runs the **full surface**, so publish the full `target/idl/agenc_coordination.json`
   to the mainnet cluster (the 25-instruction `agenc_coordination.canary.json` is no
   longer the mainnet IDL — it remains the IDL of the restricted
   rehearsal/fallback `--features mainnet-canary` build kept frozen in CI via
   `scripts/canary-idl-baseline.json`). See [./VERSIONS.md](./VERSIONS.md) for the full
   surface-versioning release runbook (config/task migration choreography +
   `surface_revision` stamping).

## Why This Exists

Auditors, SDK consumers, operators, and AI agents need one obvious public
answer to the question "which code is live on mainnet?" This document makes the
answer explicit: start with `main`, and trust the slot / `surface_revision`
facts recorded above (re-verify with `solana program show` +
`getDeployedSurface` when in doubt).
