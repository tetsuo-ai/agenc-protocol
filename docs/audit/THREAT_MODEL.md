# Protocol Threat Model

This is the lightweight threat-model reference for the public protocol repo.

## Scope

It exists as the security reference that the fuzz harness points to. It is a
living reference — update it when the deployed surface, custody, or trust model
changes. Last reconciled with the deployed revision and candidate artifacts on
2026-07-18.

## Current deployment state (2026-07-18)

- Program `agenc-coordination` (Anchor 0.32.1 / Solana 3.0.13), program id
  `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, upgradeable. Upgrade authority
  is a Squads v4 2-of-3 multisig (custody since 2026-07-03); the OtterSec
  verified-build badge is live.
- Live mainnet surface: the FULL 99-instruction build (since 2026-07-09, slot
  431918664), `surface_revision = 4` (batch-4 goods); `ProtocolConfig` is 351B.
  Its deployed source artifact at commit `097ded1` contains 99 instructions / 46
  accounts / 104 events / 354 errors.
  The 25-instruction `mainnet-canary` build is a restricted rehearsal/fallback
  build, CI-frozen, NOT live — do not threat-model it as the production surface.
- Pending revision-5 candidate: the default production artifact contains 98
  instructions / 43 accounts / 99 events / 393 errors. Explicit development
  `private-zk` has 101 instructions and the frozen canary has 25. The candidate
  is not live until a separately reviewed Squads upgrade and revision stamp.
- Singletons: `BidMarketplaceConfig`, `ModerationConfig`, and `GovernanceConfig`
  INITIALIZED (sane params); `ZkConfig` NOT initialized — ZK private completion
  is deferred and `complete_task_private` stays off until it is.
- Disputes: single-assigned-resolver. The protocol authority or an assigned
  `DisputeResolver` resolves directly with a mandatory reasoned ruling
  (`rationale_hash` + bounded `rationale_uri`). Arbiter voting / `vote_dispute`
  is retired (P6.3) and absent from the IDL — no quorum/vote path exists to
  attack.
- Errors are append-only by policy: 354 variants in deployed revision 4 and 393
  in the candidate artifact. Existing numeric codes are not reordered.
- Legacy state: the 169 pre-upgrade Task accounts were migrated 2026-06-11
  (schema-0 vs schema-1); migrations are done, not pending.

## Audit state

Batch 1–3 internal adversarial audits are closed — 0 open findings **at that
time** (historical, not a current cleanliness claim). The 2026-07-16/17 audit
and subsequent adversarial runs found issues those passes missed. The resulting
F-1–F-19 queue and later hardening are implemented in the pending revision-5
candidate; `TODO.MD` is the detailed historical/remediation record, not a list
of still-unimplemented blockers. Treat `CHANGELOG.md` and
`docs/MAINNET_MAINLINE.md` as the current candidate/deployment split. Passing
the present gates is evidence, not a guarantee that no unknown vulnerability
exists.

Security operations are not yet enterprise-ready: as verified 2026-07-18, the
documented email intake is unconfirmed, GitHub Private Vulnerability Reporting is
disabled, and `.well-known/security.txt` is therefore an inactive template. A
working, tested private intake is a release blocker, not an on-chain invariant.

## Core Invariants

- only valid state transitions should mutate protocol-owned accounts
- versioned protocol state must remain forward-migratable under explicit migration control
- private-completion payload fields must stay structurally consistent with the published journal model
- committed artifacts must match the built program surface; stale or hand-edited artifacts are a supply-chain risk
- rent recovery must bind the exact canonical child, parent, and stored payer; a cranker must never choose the recipient
- non-test builds must contain no unsafe Rust; account deserialization/persistence/close operations stay explicit

## Fuzz Harness Relationship

`programs/agenc-coordination/fuzz/` is an active 76-test model/property suite and
a required CI/release gate. It treats this file as the human-readable statement
of the invariants it is trying to protect. The retired `vote_dispute` target is
gone; current scenarios cover the single-resolver dispute lifecycle alongside
tasks, bids, dependencies, completions, timing, and reputation.
