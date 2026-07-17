# Protocol Threat Model

This is the lightweight threat-model reference for the public protocol repo.

## Scope

It exists as the security reference that the fuzz harness points to. It is a
living reference — update it when the deployed surface, custody, or trust model
changes. Last reconciled with on-chain state 2026-07-17.

## Current deployment state (2026-07-17)

- Program `agenc-coordination` (Anchor 0.32.1 / Solana 3.0.13), program id
  `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, upgradeable. Upgrade authority
  is a Squads v4 2-of-3 multisig (custody since 2026-07-03); the OtterSec
  verified-build badge is live.
- Live mainnet surface: the FULL 99-instruction build (since 2026-07-09, slot
  431918664), `surface_revision = 4` (batch-4 goods); `ProtocolConfig` is 351B.
  The 25-instruction `mainnet-canary` build is a restricted rehearsal/fallback
  build, CI-frozen, NOT live — do not threat-model it as the production surface.
- Singletons: `BidMarketplaceConfig`, `ModerationConfig`, and `GovernanceConfig`
  INITIALIZED (sane params); `ZkConfig` NOT initialized — ZK private completion
  is deferred and `complete_task_private` stays off until it is.
- Disputes: single-assigned-resolver. The protocol authority or an assigned
  `DisputeResolver` resolves directly with a mandatory reasoned ruling
  (`rationale_hash` + bounded `rationale_uri`). Arbiter voting / `vote_dispute`
  is retired (P6.3) and absent from the IDL — no quorum/vote path exists to
  attack.
- Errors: 356 variants (codes 6000–6355), append-only by policy.
- Legacy state: the 169 pre-upgrade Task accounts were migrated 2026-06-11
  (schema-0 vs schema-1); migrations are done, not pending.

## Audit state

Batch 1–3 internal adversarial audits are closed — 0 open findings **at that
time** (historical, not a current cleanliness claim). The 2026-07-16/17
adversarial audit (3 passes, branch `fix/audit-findings-2026-07-16`, HEAD
`d7f9d40`) landed all blocker fixes and found new issues the earlier audits
missed (e.g. F-1 bond-forfeit binding, F-2 `close_task`/finalizer brick). The
remaining full-surface/SPL hardening queue is `TODO.MD` (F-1..F-19; F-6 closed
by on-chain verification) — treat it as the current findings queue.

## Core Invariants

- only valid state transitions should mutate protocol-owned accounts
- versioned protocol state must remain forward-migratable under explicit migration control
- private-completion payload fields must stay structurally consistent with the published journal model
- committed artifacts must match the built program surface; stale or hand-edited artifacts are a supply-chain risk

## Fuzz Harness Relationship

`programs/agenc-coordination/fuzz/` should treat this file as the human-readable statement of the invariants it is trying to protect.

