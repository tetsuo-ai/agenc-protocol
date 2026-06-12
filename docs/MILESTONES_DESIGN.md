# Milestones & Partial Settlement — Design

**Status: DESIGN ONLY. [HUMAN: approve design.]**
Audit finding #33, PLAN.md P7.4. Deploy-gated protocol design; nothing here is
implemented. Build only after Batch 4, with full migration discipline and
litesvm lamport-exact split tests per milestone.

## Problem

Escrow is **all-or-nothing**. A `Task` holds one `reward_amount` in one
`TaskEscrow` (`programs/agenc-coordination/src/state.rs`), settled in a single
`accept_task_result` through the 3-way (4-way after P6.2) split. Partial
payment exists *only* as a dispute outcome (`resolution_type = 2 = split`).
There is no way to fund a long engagement and release it in tranches as stages
land, and no way for a buyer to send an ad-hoc partial or tip mid-task.

## Design

### 1. Bounded milestone schedule on a child PDA (NOT a Task realloc)

A milestone schedule is **≤8** stages of `{ amount: u64, spec_hash: [u8;32],
status: MilestoneStatus }`.

It MUST NOT live on `Task`. `Task` is already a **466-byte, migrated** account
with **169 live mainnet instances** (as of the 2026-06-11 full-surface upgrade) and only a **16-byte `_reserved`**
(`Task._reserved: [u8; 16]`, partially the staging ground for the P6.2 referral
fields). Eight stages × (8 + 32 + 1) bytes = 328 bytes — an order of magnitude
past `_reserved`. Putting the schedule on `Task` would force *another*
realloc-all sweep over all 169 tasks (irreversible, multisig-gated). So:

**Recommendation: a child `TaskMilestone` PDA per stage.**
`["task_milestone", task, index_le_u8]` holding
`{ task, index: u8, amount: u64, spec_hash: [u8;32], status, submitted_at,
accepted_at, bump, _reserved }`. A new account type + new PDA is **NOT a
migration** (per CLAUDE.md golden rule 3): existing `Task`/`TaskEscrow` layouts
are untouched, the 169 live tasks are untouched, and milestones are `init`-ed
only for engagements that opt in. This mirrors `HireRecord` and the
`SubmissionKeyEscrow` of the P7.2 design — additive child accounts instead of
parent reallocs.

A small **`MilestoneSchedule`** header PDA (`["milestone_schedule", task]`)
holds the invariant counters: `{ task, count: u8 (≤8), total_amount: u64,
released_amount: u64, bump, _reserved }`. `total_amount` MUST equal the funded
`TaskEscrow.amount`; each stage's `amount` sums to `total_amount` (checked at
creation). This gives the program one place to enforce "tranches never exceed
escrow" without iterating PDAs on every release.

`MilestoneStatus`: `Pending → Submitted → Accepted` (plus `Rejected` looping
back to `Pending` for rework, bounded by the existing submission-count limits).

### 2. `submit_milestone` / `accept_milestone` releasing tranches

- `submit_milestone(index)` — the worker marks stage `index` ready, anchoring
  the per-stage `spec_hash` (the deliverable content commitment, same
  `json-stable-v1` hashing as job specs). Bounded by `count`; `index` must be
  `Pending` and the prior stage `Accepted` (sequential by default — see
  DECISION).
- `accept_milestone(index)` — the creator releases **that stage's `amount`**
  through the **existing** split helpers. It calls the SAME
  `calculate_combined_fees(base = stage.amount, protocol_fee_bps,
  operator_fee_bps, referrer_fee_bps)` from `completion_helpers.rs` — the
  worker floor (≥60%) and combined-fee cap (≤40%) hold **per tranche**, not just
  per task, so no milestone can be structured to dodge the worker floor.
  `MilestoneSchedule.released_amount += stage.amount` (checked, ≤ `total_amount`);
  `TaskEscrow.distributed += stage.amount`. The task transitions to `Completed`
  only when the **last** stage is accepted (or via the bounded exit below).

Reusing the existing split keeps the money math in one audited place — the
litesvm lamport-exact split tests just run once per tranche.

### 3. Creator-signed `release_partial(amount)` for ad-hoc partials / tips

Independent of the milestone schedule: a creator-signed
`release_partial(amount)` releases `amount` from `TaskEscrow` to the worker
(through the split) at any time before final settlement. Use cases: a tip on top
of the agreed reward, or an unscheduled partial for a task without a formal
milestone schedule. Guards:

- `amount + escrow.distributed ≤ escrow.amount` (checked; can't over-release).
- Creator signature required (it's the buyer's money; this is not permissionless).
- Goes through the SAME split helper, so fees/floor apply to partials too.
- Emits `PartialReleased { task, worker, amount }`.

### 4. Default milestone template on `create_service_listing`

`create_service_listing` gains an OPTIONAL default milestone template — a
compact encoding (e.g. an array of `{ pct_bps, label_hash }` summing to 10000
bps) the provider advertises. `ServiceListing` has a **32-byte `_reserved`**
(`ServiceListing._reserved: [u8; 32]`) but ServiceListing has live accounts, so
a template wider than 32 bytes is a layout change. Two storable options:

- Store only a **pointer** (a 32-byte `template_hash` into the listing's job-spec
  envelope, where the full template lives off-chain under the existing
  `spec_hash` commitment) — fits in `_reserved`, **zero migration**.
  Recommended.
- Add an inline `Vec<MilestoneTemplateEntry>` — append-only `ServiceListing`
  layout change + migration sweep. Heavier; only if on-chain template
  enforcement is required.

At hire time, `hire_from_listing` reads the template and `init`s the
`MilestoneSchedule` + `TaskMilestone` PDAs with the per-stage amounts derived
from `price × pct_bps`. The template is advisory metadata when stored as a
pointer (the binding schedule is the on-chain PDAs created at hire).

### 5. Facade `Engagement` object

The SDK facade exposes ONE `Engagement` view assembling the `Task`,
`MilestoneSchedule`, and the `TaskMilestone[]` into
`{ task, milestones: [{ index, amount, specHash, status }], releasedAmount,
totalAmount }`, with `submitMilestone(index)`, `acceptMilestone(index)`, and
`releasePartial(amount)` builders. (Note: P7.5 also names an `Engagement` — see
DECISION-NEEDED #6 on whether these are the same facade type or two.)

### Bounds & invariants (carry into the build)

- `count ≤ 8` (`MAX_MILESTONES`), enforced at schedule creation.
- `Σ stage.amount == total_amount == TaskEscrow.amount` (checked at creation).
- `released_amount ≤ total_amount`; `escrow.distributed ≤ escrow.amount` — every
  release uses `checked_add`/`checked_sub` (`CoordinationError::ArithmeticOverflow`).
- Per-tranche worker floor + combined-fee cap via the existing
  `calculate_combined_fees` — no new fee math.
- **Money never locks:** task cancel/expire/reject must refund the *unreleased*
  remainder (`total_amount − released_amount`) to the creator and close the
  schedule + milestone PDAs (rent back). No exit may strand escrow.
- `const_assert` sizes of `MilestoneSchedule` + `TaskMilestone` (`test_size_constant!`);
  `_reserved` zeroed + `validate_reserved_fields`.
- **Surface gating:** ALL new instructions (`submit_milestone`,
  `accept_milestone`, `release_partial`, schedule/milestone init+close) are
  `#[cfg(not(feature = "mainnet-canary"))]` and dispatched only in the full
  module. The **25-instruction canary surface stays unchanged**
  (`scripts/check-canary-idl.mjs`). `create_service_listing`/`hire_from_listing`
  gaining OPTIONAL template handling must not change their canary behaviour.
- Errors (`TooManyMilestones`, `MilestoneAmountMismatch`, `MilestoneOutOfOrder`,
  `OverRelease`) in `errors.rs`; events in `events.rs`.

## DECISION-NEEDED

1. **Child PDA per stage (recommended) vs `Task` realloc.** Confirm the child
   `TaskMilestone` + `MilestoneSchedule` header (zero migration) over extending
   `Task` (another 169-task realloc).
2. **Sequential vs out-of-order acceptance.** Default sequential (stage N+1
   requires stage N accepted) is simplest and matches "phased delivery."
   Out-of-order needs no prior-stage check but complicates the "final stage →
   Completed" transition. Recommendation: sequential for v1.
3. **`release_partial` outside a schedule.** Allow ad-hoc partials/tips on ANY
   task (recommended) or only on tasks with a milestone schedule? Allowing it
   broadly is the tip use-case; confirm.
4. **Template storage:** pointer-in-`_reserved` (zero migration, recommended) vs
   inline `Vec` on `ServiceListing` (migration). Confirm pointer.
5. **Per-tranche vs per-task fee snapshot.** Fees are snapshotted on `Task` at
   create/hire and applied per tranche (recommended — one fee policy for the
   whole engagement). Confirm we do NOT want per-milestone fee overrides.
6. **One `Engagement` facade or two.** P7.4 (milestones, one funded task split
   into stages) and P7.5 (retainers, N periods each minting a Task) both want an
   `Engagement` object. Decide whether the facade exposes a single unified
   `Engagement` type or two distinct ones (`MilestoneEngagement` vs
   `RetainerEngagement`). Recommendation: two named types to avoid conflating a
   single-task tranche schedule with a multi-task retainer.
7. **Auto-accept per milestone.** Does each stage get its own review deadline /
   auto-accept (like `TaskSubmission.review_deadline_at`), or only the final
   stage? Recommendation: per-stage review deadline so a stalled buyer can't
   freeze the whole engagement.
