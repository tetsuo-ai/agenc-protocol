# Mainnet Mainline

This document records what `main` means for the live AgenC protocol.

## Policy

`main` is the canonical public branch for the currently deployed mainnet
program source. It should not drift away from the live full-surface program.

When the on-chain mainnet program changes, update `main` in the same release
window or before the deploy is announced publicly.

## Current Mainnet Deployment

> **As of 2026-07-09 the revision-4 99-instruction surface is live on mainnet.**
> It includes the P1.2 open roster, batch-2 store/liveness additions, batch-3
> contests, and batch-4 goods. The P1.2 base was deployed in slot **430491216**
> from source commit `aad4c0d` through the Squads 2-of-3 upgrade-authority vault.
> That P1.2 batch was a **flag-day wire cutover**, not a compatible upgrade:
> `set_task_job_spec` /
> `hire_from_listing` / `hire_from_listing_humanless` gained a trailing
> `moderator` arg + a required `moderation_block` account, the `record_*_moderation`
> records moved to v2 moderator-keyed seeds, and moderation-attestor registration
> became **permissionless** (`register_moderation_attestor`, 0.25 SOL refundable
> bond, 7-day exit cooldown). Old-wire clients fail closed. See
> [`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) §2.6 for the
> cutover choreography and [`P1_2_OPEN_ROSTER_SPEC.md`](./P1_2_OPEN_ROSTER_SPEC.md)
> for the design. Revisions 2–4 were additive; the current source lineage is
> recorded in [`VERSIONING.md`](./VERSIONING.md).

- Program ID: `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`
- Program source path: `programs/agenc-coordination/`
- `declare_id!` location: `programs/agenc-coordination/src/lib.rs`
- Live surface: **revision-4 99-instruction surface** (default features), `surface_revision = 4`
- Last breaking-wire deployment: slot **430491216** (2026-07-03, P1.2), commit `aad4c0def4b092311ae228d83a2ffb0f72ccb40e`; revisions 2–4 were additive upgrades
- Verified build: **LIVE** — the OtterSec/osec.io registry reports
  `is_verified: true` for the deployed bytecode against this repo at the deployed
  commit (check <https://verify.osec.io/status/HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK>);
  keeping the badge across upgrades is a deploy invariant — see
  [`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) §2.5 and
  [`VERIFIABLE_BUILDS.md`](./VERIFIABLE_BUILDS.md)
- Task types: **all enabled** (`disabled_task_type_mask = 0`: Exclusive, Collaborative, Competitive, BidExclusive)
- Bid marketplace: **LIVE** (`BidMarketplaceConfig` initialized)
- Private completion: **OFF / deferred** — `ZkConfig` not yet initialized, so `complete_task_private` is unavailable until `initialize_zk_config` runs with the audited agenc-prover image id
- Upgrade authority: **Squads v4 2-of-3 multisig vault**
  `Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf` (since 2026-07-03; distinct from
  the on-chain `ProtocolConfig` config multisig `Hcecp…`/`BXDan…`/`4QcKB…` that
  gates fees/launch controls/the BLOCK floor) — see
  [`UPGRADE_AUTHORITY.md`](./UPGRADE_AUTHORITY.md). Verify live with
  `solana program show HJsZ…` (`Authority:` = the vault)
- Moderation: **permissionless attestor roster** — any wallet may self-register
  via `register_moderation_attestor` (0.25 SOL refundable bond) and its CLEAN
  records satisfy the publish/hire gates; the hosted attestor at
  `attest.agenc.ag` is one roster member, not a privileged one
- Launch controls are configured on-chain and may disable task types or flows
  without changing the source branch identity

### Prior deployment history

- **2026-07-09 — Batch 4 goods (revision 4, 99 instructions).** Added finite
  goods listings, direct purchase, and permanent `SaleReceipt` provenance.
- **2026-07-05 — Batch 3 contests (revision 3, 96 instructions).** Added
  contest entry deposits, creator selection/ghost split, and terminal-claim reclaim.
- **2026-07-05 — Batch 2 (revision 2, 94 instructions).** Added Store identity,
  moderation heartbeat/liveness, dispute/freeze-exit referrer legs, and `rate_hire`.
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
3. Refresh this file if the live scope or rollout rules changed.
4. Keep committed artifacts and downstream protocol consumers aligned.
5. Publish/upgrade the **on-chain IDL per cluster** (`anchor idl init` first time,
   `anchor idl upgrade` thereafter) so the deployed IDL is fetchable truth. Mainnet
   now runs the **full surface**, so publish the full `target/idl/agenc_coordination.json`
   to the mainnet cluster (the 25-instruction `agenc_coordination.canary.json` is no
   longer the mainnet IDL — it remains the IDL for any cluster still running the
   `--features mainnet-canary` build). See [./VERSIONS.md](./VERSIONS.md) for the full
   surface-versioning release runbook (config/task migration choreography +
   `surface_revision` stamping).

## Why This Exists

Auditors, SDK consumers, operators, and AI agents need one obvious public
answer to the question "which code is live on mainnet?" This document makes the
answer explicit: start with `main`.
