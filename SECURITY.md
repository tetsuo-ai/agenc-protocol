# Security Policy

The `agenc-coordination` Solana program is a custodial smart contract: it holds
**task escrow**, **completion bonds**, and **reputation stakes** on behalf of
third parties. A vulnerability here can directly cause loss or lock of user
funds. We take reports seriously and commit to the response process below.

This policy covers the on-chain program, the SDK packages published from this
repository, and the tetsuo-ai hosted rails (indexer, moderation attestation,
artifact storage) that integrators may optionally depend on.

---

## 1. Reporting a vulnerability

**Report privately. Do not open a public GitHub issue, PR, or discussion for a
suspected security vulnerability.**

> **Operational blocker (verified 2026-07-18): there is currently no confirmed
> private vulnerability-intake channel.** `security@agenc.tech` has not been
> confirmed as an active mailbox, GitHub Private Vulnerability Reporting is
> disabled for this repository, and no PGP key is published. Do not send exploit
> details through a public issue. If you already have a trusted private contact
> for a maintainer, ask for a reporting channel without including vulnerability
> details in the initial message.

Before the next release, a maintainer must enable and end-to-end test GitHub
Private Vulnerability Reporting and/or a monitored security mailbox, then update
this section and activate `.well-known/security.txt`. The checked-in
`security.txt` is intentionally an invalid, inactive template until that is done;
it must not be deployed as if it exposed a working contact. For the same reason,
the current program candidate intentionally embeds no explorer-visible security
contact record; add one only after its private endpoint has been verified.
After activation, run `node scripts/enterprise-readiness.mjs`: the read-only gate
requires PVR to be enabled and both public `security.txt` endpoints to advertise
the configured contacts correctly. Mailbox delivery still requires a separate
operator-run end-to-end test. See `docs/ENTERPRISE_READINESS.md`; a green mocked
regression test does not replace live evidence.

- **What to include:** affected component (program instruction / SDK / hosted
  rail), program ID + cluster, a description of the impact (fund loss, fund
  lock, unauthorized state transition, DoS), and a reproduction (a failing test,
  a transaction, or a localnet script — see `docs/LOCALNET.md` and
  `scripts/localnet-up.mjs` for a one-command full-surface validator).

---

## 2. Scope

Severity and reward priority follow the **money-path-first** ordering also used
by the bug bounty (`docs/BUG_BOUNTY.md`).

Scope must distinguish the deployed and candidate contracts. Mainnet currently
runs revision 4 (99 instructions, deployed commit `097ded1`); current production
source is an undeployed revision-5 candidate (98 instructions). The explicit
101-instruction `private-zk` build is development-only and is rejected by the
production deployment rail.

### In scope — TIER 1: program money paths (highest priority)

The on-chain program `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`
(`programs/agenc-coordination/`), specifically:

- **Escrow custody and settlement** — `create_task`, `cancel_task`,
  `accept_task_result` / `auto_accept_task_result`, `reject_task_result`,
  `complete_task`, and the dispute settlement paths. The dormant
  `complete_task_private` ABI remains in deployed revision 4 but cannot run while
  live `ZkConfig` is uninitialized; revision-5 production removes it entirely.
  Any way to drain, double-spend, mis-route, or **permanently lock** escrowed
  SOL or SPL reward tokens.
- **Completion bonds** — `post_completion_bond`, `reclaim_completion_bond`, and
  bond disposition inside cancel / dispute / reject-frozen settlement. The 25%
  symmetric bond must be refunded or forfeited to the correct party.
- **Reputation stakes** — `stake_reputation`, `withdraw_reputation_stake`,
  `delegate_reputation`, `revoke_delegation`, and slashing
  (`apply_dispute_slash`, `apply_initiator_slash`).
- **Fee accounting** — protocol / operator / referrer fee math in
  `completion_helpers.rs`. The combined fee cap
  (`MAX_COMBINED_FEE_BPS = 4000`, i.e. the worker always keeps ≥ 60%) and the
  per-leg caps (`MAX_PROTOCOL_FEE_BPS`, `MAX_OPERATOR_FEE_BPS`,
  `MAX_REFERRER_FEE_BPS`, each 2000) are bytecode invariants; a bypass is in
  scope.
- **Authorization / state-machine integrity** — any unauthorized state
  transition, PDA-substitution, account-confusion, missing-signer, or
  arithmetic bug that lets a non-owner move funds or escape a guard.
- **Migration safety** — `migrate_task` / `migrate_protocol` correctness against
  the live account layout (the live program has real Task accounts; a bad
  migration is irreversible).

### In scope — TIER 2: hosted rails (tetsuo-ai-operated, optional dependencies)

- **Moderation attestation** — the marketplace-managed attestor used by the
  fail-closed moderation gate (`record_task_moderation` /
  `record_listing_moderation`). Forged or replayed attestations, or a bypass of
  the fail-closed property.
- **Indexer / query API** — the hosted read path. Note the SDK can read **without**
  the hosted indexer via the on-chain gPA path (`listActiveListings`); a hosted
  read-path issue that returns wrong data influencing a signed transaction is in
  scope.
- **Artifact storage** — the hosted job-spec / artifact pipeline
  (`docs/ARTIFACT_PIPELINE.md`).

> These are operated on hosted domains **[HUMAN: enumerate the exact hostnames]**.
> Test only against your own tasks/listings; do not attack other users' data.

### In scope — TIER 3: SDK

- `@tetsuo-ai/protocol` and `@tetsuo-ai/marketplace-sdk` (`packages/`). Client
  bugs that assemble an unsafe transaction, mis-decode on-chain state in a way
  that misleads a signer, or leak secrets.

### Out of scope

- The hosted **web UIs / landing pages** unless a finding leads to fund loss,
  signed-transaction tampering, or attestation forgery.
- Findings that require a **compromised upgrade authority**, a malicious
  protocol authority/multisig, or a malicious assigned dispute resolver — those
  are trusted roles (see §5.3). Report governance-design concerns separately;
  they are not paid as vulnerabilities.
- Spam / rate-limiting of public RPC, third-party RPC providers, denial of
  service requiring unrealistic transaction volume or fees, and clickjacking on
  pages with no sensitive action.
- Anything already documented as a known limitation in `docs/audit/` or the
  bug-bounty exclusions.

---

## 3. Disclosure SLA

We aim to meet the following timelines once a report reaches a verified private
channel. No professional external-audit report is currently published; internal
adversarial work and green gates are evidence, not a substitute. The inactive
intake described in §1 must be fixed before these targets are operationally
credible.

| Stage                                                                   | Target                                                                                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Acknowledge** receipt of your report                                  | **2 business days**                                                                                                                                                  |
| **Triage** — confirm/deny, assign severity                              | **5 business days**                                                                                                                                                  |
| **Fix** developed for a confirmed **Critical/High** (fund loss or lock) | **target 14 days**; coordinated if a deploy + a task-layout migration choreography is required (the live Task corpus was 169 at the 2026-06-11 full-surface upgrade) |
| **Fix** for Medium/Low                                                  | next release window                                                                                                                                                  |
| **Public disclosure**                                                   | coordinated, after a fix is deployed; default embargo up to **90 days**, extendable by mutual agreement for an on-chain fix that needs a gated upgrade               |

We will keep you updated through triage and remediation, and we credit reporters
who want credit (opt-out available).

---

## 4. Safe harbor

We will not pursue or support legal action against, and we consider authorized,
**good-faith security research** that:

- makes a genuine effort to avoid privacy violations, data destruction, and
  interruption or degradation of services;
- **uses only your own accounts, tasks, listings, and funds** for testing, and
  prefers **localnet/devnet** over mainnet (use `scripts/localnet-up.mjs` for a
  full-surface local validator);
- does **not** exploit a finding beyond the minimum needed to prove it, does not
  move or withhold other users' funds, and does not run mainnet exploits for
  profit;
- gives us reasonable time to remediate before public disclosure (see §3); and
- does not violate any other applicable law.

If you make a good-faith effort to comply with this policy during your research,
we will consider your research authorized, work with you to understand and
resolve the issue quickly, and will not recommend or pursue legal action related
to your report. This safe harbor does not extend to actions taken against third
parties (e.g. RPC providers, hosting vendors), and it does not waive their
terms. **This is a good-faith statement, not legal advice; [HUMAN: have counsel
review before publication].**

---

## 5. Emergency procedures integrators inherit

Integrators building on the program inherit three operational properties. Each
is grounded in the actual on-chain code.

### 5.1 Pause semantics — `update_launch_controls`

The protocol authority (a multisig — see §5.3) can pause the protocol and/or
disable specific task types via `update_launch_controls`
(`programs/agenc-coordination/src/instructions/update_launch_controls.rs`):

- `protocol_paused = true` sets `ProtocolConfig.protocol_paused`.
- `disabled_task_type_mask` disables individual task types.
- The call is **multisig-threshold gated** (`require_multisig_threshold`); a
  single key cannot pause.

**Pause is an ENTRY control, not a fund trap.** `check_version_compatible`
(entry paths) rejects when paused; `check_version_compatible_for_exit`
(`programs/agenc-coordination/src/utils/version.rs`) deliberately does **not**
consider `protocol_paused`. So a pause stops _new_ work (task creation, claims,
bids) but **never** blocks the exit/settlement paths in §5.2. This is the
encoded "money never locks" invariant (spec §7, Decision #4), and it is
revert-sensitively unit-tested in `version.rs`. Tests establish intended
behavior for covered cases; they are not a guarantee that no unknown bug exists.

### 5.2 Money-never-locks exit guarantees

The intended invariant is that every escrowed task has at least one path that
releases funds even while the protocol is paused. The paths below were inspected
against program source — each exit calls `check_version_compatible_for_exit` —
but this inventory is not a claim of formal verification:

**Exit paths present in the 25-instruction canary build (allowlist —
`scripts/check-canary-idl.mjs`) and live on the full mainnet surface
(revision 4 is 99 instructions; the first 84-instruction full build went live
on 2026-06-11):**

- **`cancel_task`** — creator refund. Refunds `escrow.amount - escrow.distributed`
  to the creator (SOL or SPL), closes the escrow PDA, closes worker claim
  accounts (returning claim rent to the worker authority), and on the full
  surface refunds the creator's completion bond / forfeits a no-show worker bond.
  Allowed on `Open` tasks and on `InProgress` tasks past deadline with no
  completion.
- **`expire_claim`** — permissionless stale-claim cleanup after the claim
  deadline (with a 60s grace window where only the worker can self-expire, to
  block expiry-racing griefing — issue #421). Lets an abandoned claim be cleared
  so the task can be re-worked or cancelled.
- **`reject_task_result`** — routes a `PendingValidation` (CreatorReview)
  submission to rejection / review / refund; works while paused.
- **`accept_task_result`** — settle a completed submission to the worker (with
  capped fees). (`auto_accept_task_result` is the full-surface variant.)

**Full-surface exits — live on mainnet since the 2026-06-11 full-surface upgrade
(not present in the 25-instruction canary build):**

- **`auto_accept_task_result`** — auto-settles a submission to the worker after
  the review window, so a non-responsive creator cannot strand a completed task.

- **`close_task`** — reclaims the terminal `Task` (+ leftover `TaskJobSpec` /
  drained escrow / hire link) rent to the creator once `Completed` or
  `Cancelled`. Refuses to touch an escrow still holding undistributed funds.
- **`reclaim_completion_bond`** — **permissionless** refund of a still-live bond
  to its poster once the task is `Completed`, so a counterparty cannot strand a
  bond by omitting it during settlement (Batch 3 audit fix).
- **`expire_dispute`** — applies the stale assigned-resolver expiry policy and
  releases escrow; the retired arbiter-vote/quorum path is no longer involved.
- **`resolve_dispute`** — settles a dispute to the winning party; bonds of the
  losing side are forfeited inside this instruction.
- **`resolve_reject_frozen`** / **`expire_reject_frozen`** — the only exits for a
  `RejectFrozen` task; without them its escrow + claim + bonds would strand.

Money-safety substrate, also verified: **checked arithmetic** on all money paths
(`checked_add/sub/mul`, `ArithmeticOverflow`) **plus** `overflow-checks = true`
in the release profile (`programs/agenc-coordination/Cargo.toml`) as a second
layer; **fee caps in bytecode** (combined ≤ 4000 bps, worker keeps ≥ 60%);
**fail-closed moderation**; and dispute rulings by either the protocol authority
with configured M-of-N approval or a threshold-seated assigned resolver, with no
per-case arbiter vote/quorum.

### 5.3 Upgrade-authority custody

The program is **upgradeable** (BPFLoaderUpgradeable). As of **2026-07-03** the
mainnet upgrade authority is a **2-of-3 Squads v4 multisig** (migrated from the
former single key — P0.3):

```
Program:      HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK
ProgramData:  E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw
Authority:    Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf   (Squads v4 2-of-3 vault)
Multisig:     7VNP3JwLede86xgfG13pzyTKhTiuZkirJPxULrTce5DY   (program SQDS4ep65T869…)
```

(Verify live with `solana program show HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`.)

No individual key can now unilaterally push an upgrade — the escrow-custodying
program requires 2-of-3 signatures for any bytecode change. The migration runbook
and full record are in `docs/UPGRADE_AUTHORITY.md`. Revision 5 is also blocked
on a separately reviewed 97,152-byte `ExtendProgramChecked` action through
Squads CPI; extension and upgrade must execute in different slots, and the
deployment rail refuses implicit auto-extension. **Residual (tracked, not yet
done):** the three member keys are currently co-located on one operator host;
distributing at least one onto separate hardware (a Ledger) is the remaining
hardening — a Squads config change, no program-authority re-transfer required.

> The **protocol/config authority** (which pauses via `update_launch_controls`,
> updates fees, proposes dispute-resolver roster changes, and may propose a
> direct ruling) is governed by the on-chain multisig in `ProtocolConfig`; each
> such resolver change or direct ruling requires configured M-of-N approval. It
> is a distinct concept from the
> **program upgrade authority** above. Both are trusted roles; bugs requiring a
> malicious trusted role are out of scope (§2).

---

## 6. Verifiable builds — status

A reproducible / verifiable build (`solana-verify`, on-chain verification PDA
via osec.io) proves the deployed bytecode matches the source **at a public tag**.
**This repository is public.** The deployed program is OtterSec-verified against
this repo (`is_verified: true` at
[verify.osec.io/status/HJsZ…](https://verify.osec.io/status/HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK)).
That badge attests deployed revision 4 at commit `097ded1`; it does not attest the
different revision-5 candidate at current HEAD before an approved upgrade and
new verification.
Every `protocol-v*` release also records a reproducible SHA-256 of the program
built in a pinned Docker image (`.github/workflows/verify.yml`); reproduce it
with `solana-verify verify-from-repo` — see `docs/VERIFIABLE_BUILDS.md`.

> Historical note: older drafts of this section described a private-repo gate.
> That gate is closed; do not reintroduce “repo is private / verify-from-repo
> unavailable” language without checking the current GitHub visibility and the
> OtterSec badge.

---

## 7. References

- Bug bounty scope & rewards: `docs/BUG_BOUNTY.md`
- Upgrade-authority and pending capacity runbook: `docs/UPGRADE_AUTHORITY.md`
- Threat model: `docs/audit/THREAT_MODEL.md`
- Audit prep / invariants / coverage: `docs/BATCH_1_3_AUDIT_PREP.md`
- Program surface & PDAs: `docs/PROGRAM_SURFACE.md`
- Mainnet source of truth: `docs/MAINNET_MAINLINE.md`
- Local full-surface validator for reproduction: `scripts/localnet-up.mjs` (`docs/LOCALNET.md`)
- Machine-readable contact template: `.well-known/security.txt` (**inactive and
  intentionally invalid until a working private channel is configured**)
- Read-only GitHub, intake, and hosted-schema readiness gate:
  `docs/ENTERPRISE_READINESS.md`

---

_Licensing note: the repository is GPL-3.0 (root `LICENSE`); the published npm
packages `@tetsuo-ai/protocol` and `@tetsuo-ai/marketplace-sdk` are MIT.
Licensing does not change the security commitments above._
