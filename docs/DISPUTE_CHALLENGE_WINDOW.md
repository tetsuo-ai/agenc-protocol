# Dispute challenge window + resolver stake (P6.4 step 3)

> **Historical design record (banner added 2026-07-17).** Dated design document, not current state — see `./MAINNET_MAINLINE.md` for what is live and `../TODO.MD` for remaining work.

> Status: **DESIGN ONLY — [HUMAN: approve challenge-window + resolver-stake design before build]**.
> Nothing in this document is implemented. P6.4 steps (1)+(2) — the required reasoned
> ruling (`rationale_hash` / `rationale_uri` / `resolved_by` on `Dispute`, emitted in
> `DisputeResolved`) and the resolver case counters (`resolved_count`,
> `overturned_count`, `last_resolved_at` on `DisputeResolver`) — **are built**. This
> document specifies the third, larger step (a settlement-delaying challenge window and
> resolver stake) and the two already-allocated hooks it would activate. Do not build any
> of it until the human approves the parameters below.

## TL;DR

- **Built now (P6.4 steps 1+2):** every `resolve_dispute` carries a reasoned ruling and
  records who decided it; an assigned resolver's `resolved_count` / `last_resolved_at`
  move on each ruling. `overturned_count` is allocated but **has no on-chain
  incrementer** — by design, it is the hook this document would wire up.
- **Proposed here (step 3, NOT built):** `resolve_dispute` stops settling immediately.
  It records a *pending* outcome; a new `execute_resolution` instruction settles it
  only after an `N`-hour **challenge window** elapses, unless the ruling is **vacated**
  first (by the protocol authority, or via a future appeal path). A vacated ruling bumps
  the deciding resolver's `overturned_count`. Resolvers post a **stake at assignment**
  that is slashable in proportion to their overturned rate — coupling accountability
  (counters) to a real economic cost.
- **Why deferred:** this changes the dispute *settlement timing* on the money path and
  introduces a new staked actor. It is a deploy-gated protocol change of materially
  larger blast radius than steps 1+2, and the economic parameters (`N`, stake size,
  slash curve) are policy the human must set. Steps 1+2 ship the accountability
  *record* now; step 3 adds the *enforcement* later, without a second layout change
  (the hooks already exist).

---

## Why steps 1+2 are not enough on their own

Steps 1+2 make a ruling **legible and attributable**: you can read what the resolver
decided, why (the rationale hash), who they are, and how many cases they have decided.
That is necessary but not sufficient for trust-minimization:

- A resolver can still rule **instantly and irreversibly**. The loser has no on-chain
  window to surface "the resolver ignored the evidence" before the escrow is gone.
- `resolved_count` grows whether the rulings are good or bad. There is no on-chain
  signal of ruling *quality* and no cost to a bad ruling beyond reputation a client must
  notice off-chain.

The challenge window adds a **time buffer** before money moves, and the resolver stake +
`overturned_count` add a **cost** to rulings that get vacated. Together they convert the
passive accountability record into active accountability.

---

## Mechanism (proposed)

### 1. Pending outcome on `resolve_dispute`

`resolve_dispute` no longer transfers escrow. Instead it:

- validates authorization + the reasoned ruling exactly as today (steps 1+2 unchanged);
- writes the decided outcome (`approve`, `resolution_type`) and a
  `challenge_deadline = now + protocol_config.dispute_challenge_window_secs` onto the
  dispute, transitions `DisputeStatus::Active -> PendingExecution` (a NEW status), and
  emits a `DisputeRulingPending` event;
- does **not** touch escrow, bonds, slashing, or claim/escrow closure.

This is the invasive part: today `resolve_dispute` is also the *exit path* that releases
locked funds ("money never locks", spec §7). Splitting decide-from-settle means the exit
guarantee now lives on `execute_resolution`, which **must** remain callable while the
protocol is paused (same `check_version_compatible_for_exit` treatment) and **must** be
permissionlessly callable after the deadline so a stalled resolver cannot freeze funds.

### 2. `execute_resolution` settles after the window

A new instruction, callable by **anyone** once `now >= challenge_deadline`, performs the
exact settlement that `resolve_dispute` does today (the escrow split, slashing, bond
disposition, claim/escrow closure) from the pending outcome. It requires the same money
accounts `resolve_dispute` requires now. Transitions `PendingExecution -> Resolved`.

### 3. Vacating a ruling (within the window)

Before the deadline, a ruling can be **vacated**:

- **v1 (authority-only):** the protocol authority calls `vacate_resolution`, which
  transitions `PendingExecution -> Active` (re-openable for a fresh ruling) and bumps the
  deciding resolver's `overturned_count` via the already-allocated field (no layout
  change). Emits `DisputeRulingVacated { dispute, resolver, vacated_by }`.
- **v2 (appeal path, later):** a bonded appeal by the losing party that escalates to a
  second resolver / panel. Out of scope here; the `overturned_count` hook supports it.

`vacate_resolution` is the **only** writer of `overturned_count`. That is why
`bump_resolver_case_counters` in `resolve_dispute` deliberately leaves it untouched, and
why the unit test `bump_resolver_does_not_touch_overturned_count` pins that invariant —
so wiring this step later cannot silently double-count.

### 4. Resolver stake at assignment

`assign_dispute_resolver` would take a `stake_lamports` deposit (held in a PDA escrow
seeded by the resolver) and record it on `DisputeResolver` (in its remaining reserved
bytes — **measure first**: after step 2, `DisputeResolver` keeps only `_reserved: [u8; 8]`,
which holds a single `u64` stake amount but **not** a separate stake-escrow bump; a
stake-escrow PDA can derive its bump on the fly, so 8 bytes is plausibly enough — but this
MUST be re-derived against the live `InitSpace` before relying on it, and if it does not
fit it becomes a `DisputeResolver` size-extending migration, NOT a value write). On
`revoke_dispute_resolver` the remaining stake is returned. The stake is **slashable** in
proportion to the resolver's overturned rate (see parameters).

---

## Parameters to approve [HUMAN]

| Parameter | Proposed default | Notes |
|---|---|---|
| `dispute_challenge_window_secs` | 48h (172800) | Long enough for the loser to react; short enough not to freeze funds. New `ProtocolConfig` field → **size-extending migration of the live config** (same constraint as P6.5's `surface_revision`); piggy-back on that realloc. |
| Permissionless `execute_resolution` | yes, after deadline | Required so a stalled resolver cannot brick the escrow. |
| `vacate_resolution` authorizer (v1) | protocol authority only | Appeal path (v2) deferred. |
| Resolver `stake_lamports` at assignment | TBD | Must dominate the expected gain from a single biased ruling. Policy. |
| Slash curve vs `overturned_count` | TBD | E.g. slash `stake * min(overturned/resolved, cap)` on revoke; or per-vacate fixed slash. Policy — do not hardcode without approval. |
| Stake recipient on slash | treasury | Mirrors bond forfeits. |

## Layout / migration impact (must be re-verified before build)

- **`DisputeResolver`:** `overturned_count` + `resolved_count` + `last_resolved_at`
  already exist (step 2, no migration). A resolver **stake amount** field would consume
  the remaining `_reserved: [u8; 8]` (one `u64`) — verify against `InitSpace` first; if it
  needs more, it is a size-extending migration. `DisputeResolver` has **no live mainnet
  accounts** (disputes are out of the canary), so even a migration here is devnet-only.
- **`Dispute`:** needs a new `PendingExecution` status and a `challenge_deadline: i64`.
  This is another **append** to `Dispute` (same no-live-mainnet-accounts rationale as
  steps 1+2 — append-only on devnet, no migration).
- **`ProtocolConfig`:** `dispute_challenge_window_secs` is a new field on the **live**
  config account → a real size-extending migration. Sequence it with P6.5's
  `surface_revision` realloc so the task-layout-style config migration happens once
  (the live ProtocolConfig was migrated 349B → 351B in the 2026-06-11 upgrade).
- **Exit-safety invariant:** moving settlement to `execute_resolution` relocates the
  "money never locks" guarantee. `execute_resolution` MUST be paused-tolerant and
  permissionless-after-deadline, or the split *weakens* the exit guarantee instead of
  strengthening accountability. This is the single highest-risk part of step 3 and the
  main reason it is gated behind explicit human approval.

## Decision

**[HUMAN: approve challenge-window + resolver-stake design before build]** — approve (a)
the challenge-window split of decide-vs-settle, (b) the `execute_resolution` /
`vacate_resolution` instruction pair and their authorizers, and (c) the resolver-stake
economics (stake size + slash curve) before any of step 3 is implemented. Until then,
P6.4 ships steps 1+2 only; `overturned_count` and the resolver stake remain reserved
hooks.

---

## DECISION (2026-06-10) — recorded: DESIGN APPROVED, BUILD DEFERRED

The challenge-window + resolver-stake mechanism is the correct end-state (it closes the
"a colluding resolver can rug a dispute with zero recourse" hole and gives roster
resolvers skin in the game). But disputes are the rare exception path with **zero live
volume**, and the accountable-disputes 80% (rationale on-chain, deciding resolver
recorded, resolver counters — P6.4 steps 1+2) already shipped. Building a pending-outcome
+ vacate + stake-slash-on-overturn machine, and calibrating N, before any dispute has
occurred is premature. BUILD TRIGGER: real dispute volume, or a single adversarial-resolver
incident/credible threat — at which point N can be calibrated against observed timing.
This design doc is build-ready when that trigger fires.
