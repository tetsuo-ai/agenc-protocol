# P3.6 — The Referrer Leg Beyond CreatorReview: Extend or Bound?

> **Status:** DESIGN / DECISION RECORD — draft for founder review. No code.
> Examines the deliberate lockout that keeps referred tasks out of the
> ValidatorQuorum / ExternalAttestation / ZK validation modes, decides whether
> to extend the referrer leg to those settlement paths or ratify
> CreatorReview-only as a product boundary, and covers the one place the
> CreatorReview story itself is still incomplete: disputes (the batch-2
> P3.4/A3 work). Companion to `P5_3_REFERRAL_ATTRIBUTION_SPEC.md`.

## 1. The lockout, verified in current source

Line numbers verified against `origin/main` @ `bb65952` (the plan's
`configure_task_validation.rs:109-120` citation is still accurate — comment at
`:109-114`, enforcement at `:115-120`):

```rust
// configure_task_validation.rs:115-120
if parsed_mode != ValidationMode::CreatorReview {
    require!(
        ctx.accounts.task.referrer_fee_bps == 0,
        CoordinationError::InvalidInput
    );
}
```

A task that carries a referrer fee can only ever be configured for
CreatorReview. The fail-closed rationale in the source comment
(`configure_task_validation.rs:109-114`) is the audit finding that the
Quorum/External settlement path pays no referrer leg, so switching a referred
task into those modes "would silently stiff the referrer and over-pay the
worker the referrer's share."

The lockout has three siblings, all fail-closed for the same reason:

- **ZK private tasks:** `create_task` rejects a referrer fee on any task with
  a `constraint_hash` (`create_task.rs:240-250`), because
  `complete_task_private` hardcodes `referrer_leg = None`
  (`complete_task_private.rs:767`).
- **Token tasks:** `create_task.rs:236-239` — the leg is SOL-only, mirroring
  the operator leg.
- **Hired tasks and non-CreatorReview generally:** a live `HireRecord` task is
  rejected by `configure_task_validation` outright
  (`configure_task_validation.rs:81-89`,
  `HiredTaskValidationUnsupported`) — so an *operator*-bearing task can't
  reach Quorum/External either. The referrer gate at `:115-120` extends the
  same protection to referred `create_task` tasks, which have no HireRecord.

## 2. Fee-leg settlement matrix (where each leg pays today)

Every claim below is a current-source citation, not a design intention:

| Settlement path | Mode(s) | Protocol fee | Operator leg | Referrer leg |
| --- | --- | --- | --- | --- |
| `complete_task` | Auto (incl. all listing hires) | yes | yes (`complete_task.rs:322-345`) | yes (`complete_task.rs:366-369`) |
| `accept_task_result` | CreatorReview | yes | yes (`accept_task_result.rs:324-350`) | yes (`accept_task_result.rs:374-377`) |
| `auto_accept_task_result` | CreatorReview (window expiry) | yes | yes (`auto_accept_task_result.rs:302-327`) | yes (`auto_accept_task_result.rs:352-355`) |
| `validate_task_result` | ValidatorQuorum, ExternalAttestation | yes | **None** (`validate_task_result.rs:421`, unreachable for hired tasks by the `:81-89` gate) | **None** (`validate_task_result.rs:425`, unreachable for referred tasks by the `:115-120` gate) |
| `complete_task_private` | ZK | yes | n/a on this path | **None** (`complete_task_private.rs:767`, unreachable — rejected at create) |
| `resolve_dispute` → Complete | any (dispute overrides) | **no** (`resolve_dispute.rs:583-604`: worker gets `remaining − operator`) | **yes** (`pay_dispute_operator_fee`, `resolve_dispute.rs:377-380,585-593`) | **NO — and reachable. This is the gap.** |
| `resolve_dispute` → Split | any | no | yes, carved from worker half (`resolve_dispute.rs:701-707`) | **NO — reachable** |
| `resolve_dispute` → Refund / cancel / expire paths | any | no | n/a (escrow back to creator) | n/a (correct — no completed work, no referral fee) |
| `reject_frozen_exits` (freeze overturned → worker paid) | CreatorReview | yes | None (`reject_frozen_exits.rs:173,389` — unreachable for hired tasks per its header comment) | **None at `:173,389` — but referred `create_task` tasks CAN reach this path. Same gap class as disputes.** |

Two structural observations fall out:

1. **The lockouts are mutually consistent and complete for the *entry* gates**
   — every mode that cannot pay the leg is unreachable by a referred task.
   The audit's fail-closed work was done properly.
2. **The exits are where the story leaks.** A referred CreatorReview task that
   ends in a dispute (`ResolutionType::Complete` or `Split`) settles without
   the referrer leg — and unlike Quorum/External, **nothing prevents a
   referred task from being disputed.** Likewise a referred task whose
   rejection is overturned through `reject_frozen_exits` pays the worker via
   `execute_completion_rewards` with `referrer_leg = None`. In both cases the
   worker (or worker+creator split) silently absorbs the referrer's share —
   the exact bug-shape the entry gates were built to prevent, surviving on the
   exit paths.

Materiality check: mainnet has settled 2 referred hires to date (explorer
revenue endpoint, live-read 2026-07-04) and disputes are rare; nothing has
been mis-paid yet. This is a correctness debt, not an incident.

## 3. Option A — extend the referrer leg to the other modes

What full extension would actually cost, per mode:

### 3.1 ValidatorQuorum / ExternalAttestation (`validate_task_result`)

- Add optional `referrer` payee account + Task-first/HireRecord-fallback
  resolution + `build_referrer_leg` — mechanical mirroring of
  `accept_task_result.rs:324-395`. S/M-sized in isolation.
- **But referrers ride with operators.** The same instruction hardcodes the
  operator leg to `None` and relies on the hired-task lockout
  (`configure_task_validation.rs:81-89`) for correctness. Extending referrer
  alone leaves an asymmetric gate ("referred OK, hired not") with no product
  logic behind it; extending both means making `validate_task_result` fully
  hire-aware — new optional accounts on a settlement gate, the change class
  the P1.2 review graded as M-sized money risk (P1.2 §5.2 lesson, cited by
  `P6_4_SPAM_SYBIL_DESIGN.md` §4.2).
- **Demand evidence: none.** The quorum/external modes are exercised by the
  reviewed-public direct-task flow; every live referred settlement to date is
  a storefront flow (CreatorReview or Auto-complete hire). No surface today
  even builds "referred + quorum" transactions.

### 3.2 ZK (`complete_task_private`)

- Mechanically possible (the private path already pays worker + protocol from
  the same escrow helper), but referred-private is a contradictory product: a
  storefront attribution leg on a task whose content and outcome are
  deliberately opaque. The privacy path also deliberately minimizes its
  account surface. **No extension.** Keep the create-time rejection
  (`create_task.rs:247-250`).

### 3.3 Disputes and freeze-overturns (the actual gap, = batch-2 P3.4/A3)

- `resolve_dispute` already contains the exact pattern to copy: the operator
  leg was retrofitted with `pay_dispute_operator_fee` "so dispute resolution
  can't bypass the operator fee" (`resolve_dispute.rs:583-585`). The referrer
  leg needs the same treatment in the `Complete` branch and the `Split`
  worker-half carve (`:701-707`), plus one optional `dispute_referrer` payee
  account validated against the Task-first/HireRecord-fallback snapshot —
  precisely mirroring `dispute_operator`
  (`resolve_dispute.rs:199-202`).
- `reject_frozen_exits`' approve branch passes `referrer_leg = None` at
  `:173`/`:389`; the fix is the same optional-account + `build_referrer_leg`
  mirroring as accept, restricted to the branch that pays the worker.
- **Policy question the implementation must answer:** dispute completions pay
  **no protocol fee** (`resolve_dispute.rs:595-604` — the worker receives
  `remaining − operator`). The coherent rule already implicitly in the code
  is: *dispute settlements honor the marketplace legs (operator, referrer) —
  the parties whose terms were snapshotted at mint — but waive the protocol's
  own fee.* Adding the referrer leg completes that rule; it does not touch
  protocol-fee behavior.
- Sizing: S/M, two instructions, no layout change, no migration, no new PDA.
  Revert-sensitive litesvm coverage: a referred task disputed to `Complete`
  pays `referrer_fee` and the worker gets `remaining − operator − referrer`;
  a `Split` carves it from the worker half; an unreferred dispute is
  byte-identical to today.

## 4. Option B — ratify CreatorReview-only as a product boundary

Keep the entry-gate lockouts exactly as shipped, and document them as the
product contract:

> A referral leg attaches to *storefront commerce* — listing hires and
> reviewed direct tasks — where a human-or-agent creator accepts the work.
> Machine-validated modes (quorum, external attestation, ZK) are
> referral-free surfaces.

- **Cost of the boundary today: ~zero.** No surface builds referred
  quorum/external/ZK tasks; the modes serve a different flow (programmatic
  validation of direct tasks). A store that wants referral revenue uses the
  storefront flow it already uses.
- **The boundary is NOT tenable for disputes** (§3.3): disputes are not a
  validation mode a creator chooses at mint — they are an exit any referred
  task can reach. "Referred tasks lose their referral fee if disputed" is not
  a boundary, it is a leak; and it creates a perverse incentive (a buyer who
  wants the referrer's 20% back can route settlement through an uncontested
  dispute-Complete instead of accepting).
- Documentation deliverables: this doc in `DOCS_INDEX.md`; SDK/kit docs state
  the rule; `create-reviewed-public` and store flows unaffected.

## 5. Recommendation

**Option B for validation modes; the §3.3 dispute/freeze-exit fix ships in
batch 2 as part of P3.4. Do not extend `validate_task_result` or the ZK path.**

Concretely:

1. **GO (batch 2, rides P3.4):** referrer leg in `resolve_dispute`
   (`Complete` + `Split` branches, mirroring the operator retrofit) and in
   `reject_frozen_exits`' worker-paying branch. This is not "beyond
   CreatorReview" — it is finishing CreatorReview's own money story on its
   exit paths, and P3.4 (dispute-referrer) is already slated for batch 2.
2. **NO-GO (bounded, revisit on tripwire):** extending
   ValidatorQuorum/ExternalAttestation. Tripwire to reopen: a real surface
   asks to mint referred tasks under those modes (i.e. demand for
   "storefront-attributed, machine-validated work"), at which point the
   extension must take operator + referrer together and be costed as an
   M-sized settlement-gate change.
3. **NO-GO permanently (absent a redesign):** referred ZK-private tasks.
4. **Keep all entry gates byte-identical** — including
   `configure_task_validation.rs:115-120` — until (1) lands; they are what
   makes the current state safe.

### Interaction with the P5.3 registered-referrer work

`P5_3_REFERRAL_ATTRIBUTION_SPEC.md` §6.2 (the `referrer_store` gate) touches
only **mint** gates; this doc's item (1) touches only **exit** paths that read
the already-snapshotted payee. They are independent and can land in different
batches without coordination — the snapshot fields on `Task`/`HireRecord`
(`state.rs:1017-1020`, `:1785-1787`) are the stable interface between them.

## 6. Open questions for the founder

1. **Ratify the boundary (Option B)?** "Referral legs are a storefront-
   commerce feature; quorum/external/ZK are referral-free" — confirm as the
   documented product contract.
2. **Dispute fee policy (§3.3):** confirm the rule "dispute settlements honor
   snapshotted marketplace legs (operator + referrer), waive the protocol
   fee" — i.e. we fix the referrer leg to match the operator precedent and do
   NOT also start taking protocol fees on dispute completions.
3. **Batch placement:** confirm the dispute/freeze-exit referrer legs ride
   batch 2 with P3.4 (same instructions being edited), keeping batch 2's
   settlement-gate blast radius to the paths it already touches.
4. **Split-branch semantics:** on `ResolutionType::Split`, the operator leg is
   carved from the **worker half** (`resolve_dispute.rs:701-707`). Recommend
   the referrer leg do the same (the creator's refund half stays whole).
   Confirm, or argue for carving both legs off the top before the 50/50.
