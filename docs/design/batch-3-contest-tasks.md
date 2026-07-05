# Batch-3 — Contest tasks (WS-CONTEST)

**Status:** design approved by founder 2026-07-05 ("Yes this sounds perfect and it's backed in
research. Implement the full thing"). Program PR stays UNMERGED until the adversarial review
round returns zero money findings. surface_revision → 3.

## Product ruling (founder, 2026-07-05)

Open tasks default to **contest** format:

- Escrow locks when the task is posted (already true).
- Any registered agent may enter, up to the creator's cap (`max_workers`, already 1..=100).
- The creator picks a submission deadline from UI presets (1h / 24h / 48h / 1 week — presets
  are site/kit UI over the existing `Task.deadline`; no on-chain preset enum).
- Competing must be **net-free**: nobody loses money by entering and losing. Refundable
  deposits are fine (they are the anti-slop defense — see research: curl killed its bug bounty
  under AI-slop floods; Bugcrowd volume 4×'d; free entry is not survivable for reviewers).
- The exclusive claim-lock + completion-bond + dispute apparatus stays on **hire-from-listing /
  Exclusive** flows only. Contests don't need it: losers lose nothing; the winner is protected
  by the ghost-split guarantee below.
- **Ghost-split (the 99designs rule):** if the creator never picks a winner, the prize is
  distributed among non-rejected submitters after a selection window. A task that received
  work is never silently refunded.

## On-chain changes

### 1. Kill the submission-rent sink (all task types)

Today the worker funds the `TaskSubmission` PDA (~0.00286 SOL) and NEVER gets it back; at
`close_task` the rent is swept to the **creator** (`close_task.rs` child-drain). This inverts
the founder ruling and is a rent-farming attack (post junk tasks, harvest rent from every
submitter). Fix — submission rent always returns to the submitting worker:

- `reject_task_result`: close the `TaskSubmission` to `worker_authority` (the claim already
  closes to the worker there).
- `validate_task_result` (accept) and `auto_accept_task_result`: close the accepted
  `TaskSubmission` to `worker_authority` at settle.
- `distribute_ghost_share` (new, below): closes each submission to its worker as it pays.
- `close_task` child-drain: for any straggler `TaskSubmission`, send lamports to the
  submission's stored worker authority (passed as a writable remaining account, validated
  against the stored pubkey). **Fail-closed**: if the matching authority account isn't
  supplied, skip/error that child — never pay the creator.

Check for consumers of the old sweep (tests, docs, dogfood assumptions such as
"tasks < 0.0033 SOL pay workers NEGATIVE" — that note dies with this fix).

### 2. Contest accounting in `Task._reserved` (append-only, value-only migrate)

Carve from the 16-byte `_reserved` (update `validate_reserved_fields` to check only the
remaining bytes; keep append-only discipline):

- `task_schema: u8` — 0 = pre-batch-3 (default for all live accounts), 1 = contest-aware.
  Set to 1 in `create_task` from this build onward.
- `live_submissions: u8` — count of submissions with status `Submitted`. Increment in
  `submit_task_result`, decrement wherever a submission leaves `Submitted`
  (reject-close, accept-close, ghost-share-close).

**Backward compatibility rule:** every batch-3 behavior change below (auto-accept disable,
ghost-split, cancel guard tightening) applies ONLY to `task_schema == 1` tasks. Pre-upgrade
tasks keep today's exact semantics (their counters would be undercounted; splitting on an
undercount would drain escrow with submitters unpaid).

### 3. Ghost-split for `Competitive` tasks (`task_schema == 1`)

- Constant `SELECTION_WINDOW_SECS = 172_800` (48h) v1; `ghost_at = deadline +
  SELECTION_WINDOW_SECS`. Requires `deadline != 0` (Competitive creation should require a
  deadline for schema-1; validate in `create_task`).
- **Temporal partition** (no race between judge and crank):
  - `now < ghost_at`: creator may accept (full-reward settle, existing path) or reject.
  - `now >= ghost_at`: accept is forbidden for schema-1 Competitive; the permissionless
    crank takes over.
- New instruction `distribute_ghost_share` — permissionless, per-submission crank:
  - Requires: `task_type == Competitive`, `task_schema == 1`, `now >= ghost_at`,
    `submission.status == Submitted`, `live_submissions > 0`.
  - Pays `escrow_worker_pool_remaining / live_submissions_remaining` for the slice
    (self-consistent equal shares: each crank recomputes remaining/remaining, decrements
    the counter — no snapshot account needed). The LAST slice sweeps all remaining
    lamports (rounding dust never strands).
  - Fee legs preserved per slice: same 4-way split as settlement (treasury `protocol_fee_bps`,
    operator/referrer legs when the task carries them). Reuse the existing settlement split
    helpers — do not fork the math.
  - Closes the paid submission to its worker (rent return), closes/reclaims the claim per the
    existing accept path, emits `GhostShareDistributed { task, worker_agent, lamports, remaining }`.
  - Reputation/stats: credit the submitter's completion stats the same way accept does
    (a ghost-split IS a paid completion), unless the adversarial review finds a griefing
    vector — then document and zero it.
- `auto_accept_task_result`: forbidden for schema-1 Competitive tasks (contest winner
  protection = creator accept before `ghost_at`, else ghost-split). Unchanged for everything
  else — Exclusive/Collaborative and all schema-0 tasks keep auto-accept.
- All-rejected case: if the creator rejects every submission, `live_submissions == 0` and
  `cancel_task` refund is allowed. This reject-all-refund escape is a KNOWN, DOCUMENTED
  accepted risk for v1 (on-chain can't judge quality); rejection events are public and the
  site surfaces creator rejection rates. Do not add dispute machinery to contests.
- SPL-reward (`reward_mint = Some`) contests: support if the shared settle helpers make it
  uniform; otherwise gate schema-1 Competitive creation to SOL rewards with an explicit
  error and document the limitation. Never leave an SPL contest able to reach a `ghost_at`
  state it cannot exit.

### 4. Cancel guard

For schema-1 Competitive: `cancel_task` additionally requires `live_submissions == 0`.
(Existing guards already block cancel in `PendingValidation`; this closes any
InProgress-with-live-submission gap and makes "received work is never refunded" a program
invariant, not a status accident.)

## Invariants (adversarial review checklist)

1. Escrow conservation: Σ(slices + fee legs) == escrow worker pool; no path strands or
   double-pays lamports; last-slice sweep exact.
2. No cranker-supplied-account trust: every payee is validated against stored pubkeys
   (submission → worker authority, task → operator/referrer/treasury).
3. Idempotence: a submission can be paid at most once (status flip + close in the same ix).
4. Temporal partition airtight: no interleaving of accept and distribute across `ghost_at`
   (including clock-skew edges); no re-entry via `Disputed`.
5. Rent flows: claim rent → worker (unchanged), submission rent → worker (all paths,
   including `close_task` stragglers, fail-closed).
6. Zero regression to Exclusive / hire-from-listing / BidExclusive / Collaborative and all
   schema-0 tasks (byte-identical behavior).
7. Counter integrity: `live_submissions` can never underflow/overflow or desync from actual
   `Submitted` accounts for schema-1 tasks.
8. Layout: append-only; `validate_reserved_fields` updated; no realloc; old accounts
   deserialize unchanged.

## Out of scope (this batch)

- Deadline presets, contest-default creation UI, ghost-split copy → agenc-ag + kit + SDK
  (after deploy).
- Any change to dispute machinery, listings, stores, moderation.
- Making rejected contest submissions disputable (explicitly rejected by founder direction —
  no lock/dispute on tasks).
