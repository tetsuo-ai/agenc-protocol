# Mainnet Mainline

This document records what `main` means for the live AgenC protocol.

## Policy

`main` is the canonical public branch for the currently deployed mainnet
program source. It should not drift away from the live full-surface program.

When the on-chain mainnet program changes, update `main` in the same release
window or before the deploy is announced publicly.

## Current Mainnet Deployment

> **As of 2026-06-11 the full 84-instruction surface is live on mainnet**
> (`surface_revision = FULL (1)`). The Phase 9 full-surface upgrade completed:
> the binary was swapped from the 25-instruction canary build to the full
> default-features build, the 169 live Task accounts were migrated (382B → 466B,
> 0 failures), and `ProtocolConfig` was migrated (349B → 351B). Mainnet is **no
> longer the canary**. See [`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md)
> for the historical rollout choreography.

- Program ID: `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`
- Program source path: `programs/agenc-coordination/`
- `declare_id!` location: `programs/agenc-coordination/src/lib.rs`
- Live surface: **full 84-instruction surface** (default features), `surface_revision = FULL (1)`
- Task types: **all enabled** (`disabled_task_type_mask = 0`: Exclusive, Collaborative, Competitive, BidExclusive)
- Bid marketplace: **LIVE** (`BidMarketplaceConfig` initialized)
- Private completion: **OFF / deferred** — `ZkConfig` not yet initialized, so `complete_task_private` is unavailable until `initialize_zk_config` runs with the audited agenc-prover image id
- Upgrade authority: **2-of-3 multisig** (`Hcecp…` / `BXDan…` / `4QcKB…`)
- Launch controls are configured on-chain and may disable task types or flows
  without changing the source branch identity

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
