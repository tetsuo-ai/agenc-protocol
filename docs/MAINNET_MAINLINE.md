# Mainnet Mainline

This document records what `main` means for the live AgenC protocol.

## Policy

`main` is the canonical public development branch. When it contains an
undeployed candidate, this document must name the exact deployed revision and
commit separately and must not describe candidate source or artifacts as live.
The deployed commit remains reproducible even while `main` advances.

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
- Live instruction inventory: 99 entrypoints in the verified revision-4 source
  and deployed bytecode. Candidate artifacts are tracked separately below and
  must not be described as live before an upgrade is confirmed.

## Pending Revision-5 Candidate (not deployed)

The production/default `#[program]` surface contains **98 actual Rust
entrypoints**. That number is derived from the cfg-gated source, not this
document:

- production defaults: 98 (`spl-token-rewards`; `private-zk` off);
- explicit development `private-zk`: 101;
- restricted `mainnet-canary`: 25;
- raw `pub fn` declarations across the mutually exclusive full/canary modules:
  126, representing 101 unique names because the canary's 25 names are repeated.

The three private-proof entrypoints are quarantined because the guest,
verifier/router deployment, and end-to-end proof policy have not been
independently established for mainnet. Production builds and IDLs must exclude
them; `scripts/mainnet-upgrade.mjs` enforces the exact 98/101/25 sets and
refuses stale artifacts.

Revision 5 is a coordinated, paused cutover rather than an in-place client
compatibility promise. It hardens authority and canonical-PDA checks, principal
conservation, disputes and slash finalizers, immutable bid/job-spec terms,
dependency and moderation gates, governance reachability, staking collateral,
service/goods/skill compare-and-swap semantics, token-account validation, and
terminal child cleanup. It also adds the narrowly scoped
`reclaim_orphan_task_child` rent-recovery instruction. `TaskBid` grows
append-only from 250 to 252 bytes to snapshot its accepted-bid no-show policy;
the mainnet inventory currently contains no bid accounts.

The deployment rail is deliberately fail-closed:

- it requires a fresh production binary and matching 98-instruction IDL;
- it verifies the canonical ProgramData and Squads v4 2-of-3 vault/controller
  policy instead of inferring an EOA from account shape;
- it proves the approved binary fits the live ProgramData allocation and forces
  `--no-auto-extend` on direct CLI deployment;
- in execute mode, it refuses a needed deploy while migration is pending unless
  `sweep` is the immediately following selected step, preventing a partial
  `--only deploy` run from abandoning the typed-read frozen window;
- it requires the protocol to be explicitly paused by a separately approved
  governance/multisig action;
- it repeats account inventories before deployment and immediately before the
  revision stamp;
- it blocks active disputes/proposals, delegation state, unsafe task children,
  token escrow, dependency obligations, RejectFrozen principal, hired-provider
  drift, job-spec/BLOCK drift, accepted/ambiguous bid contracts, collaborative
  reward insolvency, or active marketplace-payee aliases;
- it never pauses, unpauses, signs, deploys, stamps, or publishes an IDL on its
  own.

**Current ProgramData capacity blocker:** read-only mainnet RPC resolved the
canonical ProgramData account as
`E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw`, with data length 2,183,269
bytes (45 loader metadata + 2,183,224 executable payload). The current
2,277,664-byte candidate needs a 2,277,709-byte account, so it is 94,440 payload
bytes too large. The loader maximum is 10,485,760 account-data bytes, or
10,485,715 executable bytes after ProgramData metadata. Mainnet's active
SIMD-0431 rule normally requires an extension of at least 10,240 bytes (except
when consuming all remaining loader headroom); the exact 94,440-byte extension
is valid without rounding.

The existing ProgramData account held its exact 15,196,443,120-lamport rent
floor. Extending it to the candidate's exact capacity requires
15,853,745,520 lamports, a 657,302,400-lamport (0.6573024 SOL) top-up. Agave
CLI 3.0.13 allocates the candidate upgrade Buffer at 2,277,701 bytes (37-byte
Buffer header), whose rent floor is 15,853,689,840 lamports, but funds it on the
2,277,709-byte ProgramData basis: 15,853,745,520 lamports, 55,680 lamports more.
Those are different accounting surfaces; do not substitute the Buffer allocation
size for ProgramData capacity.

Before the binary upgrade, a separate reviewed Squads proposal must execute
loader `ExtendProgramChecked` for at least 94,440 additional bytes through
Squads CPI; 94,440 is the exact minimum for this candidate. The vault PDA is the
loader authority and cannot be supplied as a
CLI keypair. Extension stamps the ProgramData slot, so the extension and
`Upgrade` cannot execute in the same slot; wait for a later slot, then rerun the
entire preflight. The rail pins Solana CLI 3.0.13, queries rent through the
genesis-checked RPC, forces `--no-auto-extend`, and rejects pre/post capacity
drift. Re-query size, rent, authority, balance, feature activation, and slot at
the ceremony. This audit did **not** authorize, sign, or execute the extension.

Read-only mainnet inventory on 2026-07-18 found no Active disputes, no Active
governance proposals, no bid accounts, no token-denominated tasks, no
reputation delegations, no completion bonds, and no private/ZK tasks. Historical
terminal accounts and rent-only orphan children are inventory, not authority to
delete them; the recovery instruction validates every canonical parent/child/
worker binding before returning rent.

This candidate is **not live**. Until a separately reviewed Squads upgrade and
revision-5 stamp occur, mainnet remains the verified 99-instruction revision-4
binary described above. The three Squads member key files are currently
documented as co-located on one host, so host-level quorum compromise remains an
operational custody risk even though on-chain control is genuinely 2-of-3.

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
the branch of record once `main` matches the deployed tree. At current HEAD,
`main` is the pending revision-5 candidate; released packages and operators must
continue to target deployed revision 4 until the coordinated upgrade is
confirmed.

## Release Discipline

Before or during any future mainnet upgrade:

1. Confirm the live `programId` and upgrade target.
2. For the revision-5 audit-hardening cutover, submit a **separate, explicit
   in-program multisig** `update_launch_controls` action that sets
   `protocol_paused = true` while preserving the live task-type mask and surface
   revision. Verify the paused byte from mainnet before running any cutover scan.
   The deployment tooling deliberately does not create this governance action.
3. Require zero `ReputationDelegation` accounts, zero Active disputes, and zero
   `ValidatorQuorum` `TaskValidationConfig` accounts. Require every
   AgentRegistration initiator and defendant liability counter to be zero. The
   dispute scanner distinguishes new `0xff` provenance-tagged outcomes from
   grandfathered zero-marker records; an expired legacy loss is inventory, not a
   retroactively revived penalty. The canonical upgrade rail
   also inventories every legacy Task with `max_workers > 4` and hard-blocks any
   nonterminal (including Disputed/RejectFrozen) Task whose `current_workers > 4`:
   a maximum-size `resolve_dispute` rationale plus more than four fixed worker
   account groups cannot fit the legacy Solana transaction packet.
   The canonical upgrade rail
   repeats this snapshot immediately before a direct deploy. Because legacy
   delegation was not pause-gated, deploy the disabling binary first and repeat
   the zero-delegation scan after deploy, before stamping revision 5. A raced
   delegation has a deterministic permissionless retirement path, but blocks the
   stamp until purged. Retirement never restores reputation: identity-continuous
   records return rent to the recorded authority; absent or discontinuous
   identities return rent only to the canonical protocol treasury.
   The same predeploy and postdeploy/prestamp snapshots must run the canonical
   ReputationStake custody, skill-rating cutover, task-child, task-dependency,
   token-task escrow, hired-provider, active job-spec BLOCK, bid contract, and
   task-settlement scanners. Malformed account
   ownership/layout/PDA bindings are hard blockers. A valid multisig
   `ModerationBlock::BLOCKED` record is containment
   inventory, not a deploy blocker: the new binary must prevent new assignment
   while preserving already-assigned workers' settlement and exit paths.
4. Keep the protocol paused through binary verification, migrations, config init,
   the postdeploy cutover rescan, IDL publication/verification, and the final
   revision stamp. Unpause only
   through a **later, separately reviewed multisig action** after postdeploy canary
   checks; the upgrade rail preserves `paused=true` and never unpauses itself.
5. Confirm `main` contains the exact program source tree being deployed.
6. Refresh this file if the live scope or rollout rules changed (slot,
   `surface_revision`, instruction count, upgrade authority).
7. Keep committed artifacts and downstream protocol consumers aligned.
8. Before the final surface stamp, publish/upgrade and fetch-verify the **on-chain
   IDL per cluster**. The canonical rail derives a deterministic docs-free projection
   from the hash-approved full `target/idl/agenc_coordination.json`, checks Anchor
   0.32.1 authority/capacity/rent, publishes that ABI-complete projection, and verifies
   every non-`docs` value from chain. Do not pass the oversized documented source IDL
   directly to `anchor idl upgrade`. The 25-instruction
   `agenc_coordination.canary.json` remains the IDL of the restricted
   rehearsal/fallback `--features mainnet-canary` build kept frozen in CI via
   `scripts/canary-idl-baseline.json`. See [./VERSIONS.md](./VERSIONS.md) for the full
   surface-versioning release runbook (config/task migration choreography +
   `surface_revision` stamping).

### Revision-5 read-only inventory (2026-07-18)

The canonical scanners decode the actual account layouts and PDA bindings from
program state; they do not use the prose instruction inventory as an authority.
The latest mainnet snapshot found:

- 208 AgentRegistration accounts, all with zero pending initiator outcomes and
  zero defendant-dispute counters. There are three zero-marker Cancelled
  disputes and zero Active disputes. Two unapplied initiator losses are more
  than 35 days old and therefore expired under the deployed seven-day policy;
  they remain immutable inventory and are not cutover blockers. There are zero
  tagged pending outcomes and zero dispute-lifecycle blockers.

- 357 Tasks total; 92 nonterminal. Of those, 69 have canonical job specs and 23
  legacy, unassigned Tasks have no job spec. The 23 cannot accept a new worker
  under the hardened claim path until their creator publishes a moderated job
  spec; none has an existing worker. There are zero active job-spec BLOCKs and
  zero malformed moderation-block conditions.
- 62 exact-layout HireRecords. All 62 use the legacy default-provider carve-out,
  but every one retains a canonical immutable ServiceListing provider proof: 16
  are nonterminal and 46 terminal. They use the explicit `legacy_listing`
  compatibility account; a missing, malformed, or mismatched listing blocks the
  upgrade.
- Zero TaskBid and zero TaskBidBook accounts. The immediate predeploy rescan now
  requires explicit `openBidCount=0` and `openBidBondPrincipal=0`; paused legacy
  exit paths can otherwise mutate or orphan a bid while loader transactions are
  in flight. Accepted bids remain independent hard blockers.
- Zero live CompletionBond principal across all Tasks, enforced by explicit
  `liveCompletionBondCount=0` and `liveCompletionBondPrincipal=0` aggregates at
  the immediate predeploy rescan. This is required even while the parent Task is
  live because the paused legacy binary still permits terminal exits and closure
  during a multi-transaction loader upload.
- Zero Tasks eligible for deployed revision-4 `post_completion_bond`: Exclusive,
  SOL-denominated, Open/InProgress/PendingValidation Tasks using either automatic
  or manual-review completion. Revision 4 does not pause-gate that custody entry,
  so this stricter aggregate is what keeps the zero-bond snapshot stable until
  the new binary lands. The operator must use the scanner's exact Task inventory;
  the earlier 2026-07-18 snapshot did not compute this aggregate.
- Zero SkillRegistration, PurchaseRecord, and SkillRating accounts. The live
  mainnet counts are all zero. Revision 4 pause-gates register, purchase, and
  rating, and none of these account types has a close/retype path, so the empty
  snapshot is stable throughout the loader upload. This deliberately avoids an
  unsafe missing-author recovery: legacy skill and purchase state does not store
  the original author wallet, so after revision 4 closes the author's
  AgentRegistration the program cannot distinguish an honest purchaser from the
  original author rating through a second agent.
- Every 74-byte ReputationStake account is enumerated by exact size, then checked
  for its discriminator, complete layout and zero reserved bytes, canonical
  stake/AgentRegistration PDA relationship, and independent rent-plus-principal
  backing. Healthy nonzero `staked_amount` is compatible and does not block the
  cutover. Malformed identity, principal without an AgentRegistration, or any
  per-account backing deficit is a hard blocker; aggregate surplus in another
  stake cannot mask a deficit.
- Zero nonterminal dependent children of any dependency type (Data, Ordering, or
  Proof), enforced by explicit total and per-type aggregates, plus zero
  CompletionBonds on dependent children. Revision 4 can close a Completed parent
  during the paused loader upload, while the candidate requires that live parent
  for Data/Ordering settlement as well as Proof validation. Revision 4
  pause-gates dependent-task creation, so the zero-child snapshot is stable; even
  an Open/unassigned/no-principal legacy child now blocks the loader.
- Zero RejectFrozen Tasks and therefore zero RejectFrozen escrow or CompletionBond
  principal. Future snapshots resolve each frozen task's immutable fee source
  (task-stamped terms first, exact canonical HireRecord fallback second), validate
  payee/fee presence and combined caps, and block an exit whose SOL escrow or fee
  accounts cannot be constructed exactly.
- The settlement-solvency scan decoded all 357 Tasks and 62 HireRecords. The one
  Collaborative Task satisfies `reward_amount >= required_completions`; there
  are zero underfunded Collaborative Tasks for either SOL or SPL reward units.
  Forty-five Tasks carry active Task-stamped marketplace fee terms; eight of
  those Tasks are nonterminal. Seventeen Tasks use the exact canonical
  HireRecord fee-term fallback (eight nonterminal), but none of those fallbacks
  currently carries an active fee. Across both sources there are zero active
  operator/referrer aliases to creator, Task, or escrow, zero shared active
  operator/referrer wallets, and zero deployment blockers.
- 1,991 decoded task-child accounts and 370 missing-parent, rent-only orphans,
  holding 613,224,720 lamports of rent. There are no active/principal or malformed
  blockers. The supported recovery inventory is 353 TaskValidationConfigs, five
  TaskAttestorConfigs, six terminal TaskSubmissions, and six TaskModeration
  records. All six submission workers have a canonical live or retired-identity
  AgentRegistration, so all six rent recipients are recoverable; zero worker
  identities are unavailable. This snapshot predates support for the
  `TaskValidationVote` family and therefore is not a complete vote-orphan
  inventory. A final expanded scan was attempted on 2026-07-18 but the official
  public RPC repeatedly returned HTTP 429 and the alternate public RPC returned
  HTTP 504; that is an unavailable scan, not a clean or adverse chain finding.

### Reviewed orphan-rent recovery plan (do not execute during deployment)

`reclaim_orphan_task_child` is a deliberately narrow, permissionless recovery
instruction. It closes a supported child only after proving its stored parent
Task is absent and derives the rent destination from the child's program state.
The upgrade orchestrator never invokes it. Recovery is a separate, reviewed
operation after the new binary is verified and while the protocol remains
paused.

1. Re-run `scripts/preflight-task-children-scan.mjs` at a recorded confirmed
   slot. Persist the exact child/parent/recipient/lamport inventory and restrict the
   batch allowlist to `TaskJobSpec`, zero-pending `TaskValidationConfig`,
   `TaskAttestorConfig`, `TaskModeration`, non-Submitted `TaskSubmission`, and
   `TaskValidationVote` whose exact `TaskSubmission` parent is absent.
   Never feed TaskClaim, TaskEscrow, HireRecord, CompletionBond, TaskBidBook, or
   TaskBid to this instruction.
2. For each allowlisted child, construct the account set from decoded state:
   `child` (writable), its stored absent `parent_task`, `rent_recipient`
   (writable), a fee-paying `authority` signer, and `worker_agent`. For the first
   four non-submission families, use a harmless read-only sentinel for the unused
   `worker_agent`. For TaskSubmission, pass the exact stored AgentRegistration;
   its canonical PDA/bump is rechecked on-chain and rent goes to that account's
   stored authority. Both live registrations and permanent `RETD` tombstones are
   valid identities. For `TaskValidationVote`, the ABI-stable `parent_task` slot
   carries the exact stored TaskSubmission, `worker_agent` is an unused harmless
   sentinel, and rent goes to the vote's stored reviewer.
3. Simulate every instruction against the same snapshot. Start with one reclaim
   per transaction; pack multiple instructions only after measuring serialized
   transaction size and compute use, and remain below Solana's transaction packet
   and compute limits. A simulation failure, changed parent, changed child, or
   changed recipient invalidates that item rather than triggering a fallback
   recipient.
4. Obtain explicit operator approval for the final child allowlist, transaction
   messages, recipient mapping, and expected recovered-lamport total. Broadcast
   in small batches and record signatures. This closes program accounts and is
   intentionally not an automatic deployment step.
5. After each batch, re-fetch every target and recipient, reconcile exact child
   lamports transferred (transaction fees are paid separately by the cranker),
   then re-run the scanner. Stop on any mismatch. The final report must show the
   reclaimed children absent, no newly unavailable submission identity, no
   principal-bearing orphan, and the remaining orphan-lamport total reduced by
   exactly the successfully reclaimed amount.

## Why This Exists

Auditors, SDK consumers, operators, and AI agents need one obvious public
answer to the question "which code is live on mainnet?" This document makes the
answer explicit: start with the live revision/commit recorded above, then treat
the current `main` tree as a separate candidate when this document says it is
undeployed. Re-verify the slot, executable hash, and `surface_revision` with
`solana program show` + `getDeployedSurface` when in doubt.
