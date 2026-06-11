# Mainnet Mainline

This document records what `main` means for the live AgenC protocol.

## Policy

`main` is the canonical public branch for the currently deployed mainnet
program source. It should not drift away from the live canary program.

When the on-chain mainnet program changes, update `main` in the same release
window or before the deploy is announced publicly.

## Current Mainnet Deployment

- Program ID: `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`
- Program source path: `programs/agenc-coordination/`
- `declare_id!` location: `programs/agenc-coordination/src/lib.rs`
- Launch scope: minimal mainnet canary with reviewed public task flow
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
   `anchor idl upgrade` thereafter) so the deployed IDL is fetchable truth — for the
   mainnet canary cluster publish the 25-instruction
   `target/idl/agenc_coordination.canary.json`, never the full IDL. See
   [./VERSIONS.md](./VERSIONS.md) for the full surface-versioning release runbook
   (config/task migration choreography + `surface_revision` stamping).

## Why This Exists

Auditors, SDK consumers, operators, and AI agents need one obvious public
answer to the question "which code is live on mainnet?" This document makes the
answer explicit: start with `main`.
