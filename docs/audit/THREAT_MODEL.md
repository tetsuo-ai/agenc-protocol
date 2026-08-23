# Protocol Threat Model

This is the lightweight threat-model reference for the public protocol repo.

## Scope

It exists as the security reference that the fuzz harness points to. It is a
living reference. Update it when the deployed surface, custody, or trust model
changes. Last reconciled with the deployed revision on 2026-08-23.

## Current deployment state (2026-07-22, checked 2026-08-23)

- Program `agenc-coordination` (Anchor 0.32.1 / Solana 3.0.13), program id
  `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, upgradeable. Upgrade authority
  is a Squads v4 2-of-3 multisig (custody since 2026-07-03). The OtterSec
  verified-build badge attested revision 4 at commit `097ded1`; revision 5 still
  needs re-attest.
- Live mainnet surface: the 101-instruction revision-5 build (since 2026-07-22),
  `surface_revision = 5` (AUDIT_HARDENING); `ProtocolConfig` is 351B. Deployed
  executable SHA-256
  `049a66e30da166c1e02ee379993425c32386f774fd9ff8861153e21900b496f2`
  (2,303,608 bytes). Canonical IDL: 101 instructions / 43 accounts / 102 events
  / 405 errors. The 25-instruction `mainnet-canary` build is a restricted
  rehearsal/fallback, CI-frozen, not live.
- Explicit development `private-zk` has 104 instructions and is rejected by the
  production deployment rail. Prior revision 4 (99 instructions / 46 accounts /
  104 events / 354 errors, slot 431918664, commit `097ded1`) is superseded.
- Singletons: `BidMarketplaceConfig`, `ModerationConfig`, and `GovernanceConfig`
  INITIALIZED (sane params); `ZkConfig` NOT initialized, so ZK private
  completion stays off.
- Disputes: single-assigned-resolver. The protocol authority resolves only with
  configured M-of-N approval; a previously threshold-approved assigned
  `DisputeResolver` resolves directly without a per-case vote. Both paths require
  a reasoned ruling (`rationale_hash` + bounded `rationale_uri`). Arbiter voting /
  `vote_dispute` is retired (P6.3) and absent from the IDL. Collaborative peers
  after a recorded ruling are swept by permissionless `settle_dispute_claim`.
- Errors are append-only by policy: 405 variants in deployed revision 5
  (codes 6000-6404). Existing numeric codes are not reordered.
- Legacy state: the 169 pre-upgrade Task accounts were migrated 2026-06-11
  (schema-0 vs schema-1); migrations are done, not pending.

## Audit state

Batch 1–3 internal adversarial audits are closed — 0 open findings **at that
time** (historical, not a current cleanliness claim). The 2026-07-16/17 audit
and subsequent adversarial runs found issues those passes missed. The resulting
F-1–F-19 queue and later hardening shipped in the live revision-5 binary;
`ENTERPRISE_REMEDIATION_2026-07.md` is the detailed historical/remediation
record, not a list of still-unimplemented blockers. Treat `CHANGELOG.md` and
`docs/MAINNET_MAINLINE.md` as the current deployment record. Passing
the present gates is evidence, not a guarantee that no unknown vulnerability
exists.

GitHub Private Vulnerability Reporting is enabled and is the verified private
intake. The unconfirmed email mailbox is intentionally not advertised, and the
checked-in `.well-known/security.txt` actively names only PVR. Enterprise
readiness still requires deploying and verifying that exact metadata at both
canonical hosts; hosted delivery is a release blocker, not an on-chain
invariant.

## Core Invariants

- only valid state transitions should mutate protocol-owned accounts
- versioned protocol state must remain forward-migratable under explicit migration control
- private-completion payload fields must stay structurally consistent with the published journal model
- committed artifacts must match the built program surface; stale or hand-edited artifacts are a supply-chain risk
- rent recovery must bind the exact canonical child, parent, and stored payer; a cranker must never choose the recipient
- non-test builds must contain no unsafe Rust; account deserialization/persistence/close operations stay explicit

## Fuzz Harness Relationship

`programs/agenc-coordination/fuzz/` is an active 77-test model/property suite and
a required CI/release gate. It treats this file as the human-readable statement
of the invariants it is trying to protect. The retired `vote_dispute` target is
gone; current scenarios cover the single-resolver dispute lifecycle alongside
tasks, bids, dependencies, completions, timing, and reputation.
