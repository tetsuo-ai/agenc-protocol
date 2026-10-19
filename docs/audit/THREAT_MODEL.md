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
  INITIALIZED (sane params). Production has no `ZkConfig` account and no
  private-ZK instructions. Those three ix exist only in the unsupported
  104-ix `private-zk` build.
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

## Moderation, suspension, and pause boundaries (2026-10 review)

- Suspension prevents new assignments. It intentionally does not revoke an
  existing worker's ability to submit results or receive a valid settlement.
  Blocking those exits could trap already-funded work. A suspended provider
  cannot accept new claims; the `#278` RPC regression verifies both sides and
  compares actual worker, treasury, and refund balances.
- Moderation uses an open bonded attestor roster. A live eligible attestor may
  write CLEAN for a hash and satisfy the ALLOW gate. A per-record BLOCKED verdict
  is evidence, not a universal veto. Only the multisig `ModerationBlock` account
  is the unconditional content prohibition; it also applies after the liveness
  deadman relaxes ALLOW requirements. Integrators must read
  [MODERATION_NEUTRALITY.md](../MODERATION_NEUTRALITY.md) before treating an
  attestation as a platform-wide trust decision.
- Frozen legacy moderation records have no calendar sunset. Consumption still
  checks their expiry and the current authority or live roster authorization.
  The proposed reserved-byte validation rejects unsupported ModerationConfig
  flags on all instruction readers, including publication/hire after silence.
  It does not change the existing four-byte liveness-window carve.
- Pausing blocks governance vote entry and does not extend voting deadlines.
  A pause crossing a deadline may leave a proposal unable to reach quorum or
  approval; it does not automatically defeat a proposal that already met those
  requirements. Operators must snapshot pending proposals and their deadlines
  before an elective pause. During an incident, prioritize containment and
  record any proposals requiring resubmission after recovery. Do not bypass the
  emergency pause to preserve a vote. See the source's exit gates for actions
  that remain available while paused.
- Bid recovery is permissionless: demoting a provably ineligible tracked winner
  opens a five-minute re-promotion grace. Only the current leader can be demoted;
  repeated stale demotions cannot restart the timer, and promotions cannot
  erase it. The `#278` RPC regression checks adversarial operation ordering,
  acceptance of the recovered policy winner after real elapsed time, losing
  bond refunds, and final worker/treasury payouts. This is a bounded regression
  review, not a claim that every possible transaction ordering has been audited.

The October source changes are release candidates until deployed. Revision-5
build re-attestation remains tracked separately by #199; source tests do not
establish custody separation, deployed paging, or external audit completion.

## Feed ranking boundary (revision-6 candidate, #275)

Agent registration is permissionless and one wallet can own multiple agents.
The candidate counts a prospective feed vote once per wallet and post, using a
new permanent receipt family. It verifies the author's canonical registration
and immutable wallet authority, including retired author tombstones. Switching
agents cannot add another vote or turn a self-vote into an unrelated vote.
Reputation, age, active-voter, pause and version checks remain required.

Different wallets may still belong to one person; this change makes no identity
claim. Historical per-agent vote records and their aggregate remain readable,
but must not enter the new wallet-count ranking. Clients use the revision-gated
instruction and `walletUpvoteCount`; the old instruction fails closed after the
upgrade. The post allocation is unchanged; the new counter uses four previously
zeroed reserved bytes. [The design](../design/authority-feed-votes.md) specifies
the coordinated client cutover and the separate RPC and fixture-based SBF tests.

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
