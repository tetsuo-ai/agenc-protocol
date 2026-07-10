# Batch-3 — Contest tasks (WS-CONTEST)

**Status:** **IMPLEMENTED + LIVE on mainnet** (`surface_revision = 3`, 96-ix surface;
see `docs/MAINNET_MAINLINE.md`). Design approved by founder 2026-07-05 ("Yes this
sounds perfect and it's backed in research. Implement the full thing"). Originally
held UNMERGED until the adversarial review round returned zero money findings —
that gate is closed; the program surface is in-tree and deployed.

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
- **Gate scope (fix round):** the validation mode is unknown at creation, so the
  creation-time gates (SOL-only rewards + deadline required) are TYPE-WIDE — they apply to
  every schema-1 `Competitive` task, including ones that later stay Auto-validation. The
  LIFECYCLE gates that remove recourse (`initiate_dispute` / `request_changes` blocks) are
  narrower: they key on contest-CONFIGURED tasks (`is_contest_task && is_manual_validation_task`,
  the same conjunction the claim/accept/ghost paths use), so an Auto-validation
  schema-1 Competitive task — which never enters the contest lifecycle — keeps its
  pre-batch-3 dispute recourse.

### 4. Cancel guard

For schema-1 Competitive: `cancel_task` additionally requires `live_submissions == 0`.
(Existing guards already block cancel in `PendingValidation`; this closes any
InProgress-with-live-submission gap and makes "received work is never refunded" a program
invariant, not a status accident.)

### 5. Contest entry deposit (fix round — the anti-slop deposit, concretely)

The original framing ("the deposit = the refundable claim rent") was wrong: claim rent is
refundable EVEN TO NO-SHOWS, so slot-squatting a contest (claim all `max_workers` slots,
never submit) was economically FREE — a cheap DoS that also stranded the creator's prize
behind `expire_claim` cranking. The implemented design:

- `CONTEST_ENTRY_DEPOSIT_LAMPORTS = 10_000_000` (0.01 SOL), carried as **surplus lamports
  on the claim PDA** — no `TaskClaim` layout change, no new account.
- Charged in `claim_task` ONLY for contest-configured tasks (schema-1 `Competitive` +
  CreatorReview). All other task types and schema-0 tasks are unchanged.
- **Refund rule: anyone who SUBMITS is made whole.** Every submitted exit closes the claim
  with ALL its lamports (rent + deposit) to the worker — accept, reject (losers lose
  nothing), and the ghost-split. Net-free competition is preserved.
- **Forfeit rule: no-shows lose the deposit.** On the no-show exits — `expire_claim` with a
  provably-absent submission PDA (both the InProgress arm and the PendingValidation arm)
  and `reclaim_terminal_claim` — the claim's rent-exempt minimum returns to the worker and
  the surplus above it is forfeited to the protocol **treasury** (validated against
  `protocol_config`; NEVER the creator, who could otherwise farm forfeits with junk
  contests). The forfeit is non-skippable (absence proof + treasury account required).
- The existing 1000-lamport `expire_claim` cleanup reward is unrelated (it comes from the
  escrow) and is kept.

### 6. Terminal no-show reclaim (fix round)

`reclaim_terminal_claim` (full module only): permissionlessly reclaim a
claimed-but-never-submitted claim on an already-terminal (Completed/Cancelled) task.
Requires the derived `["task_submission", claim]` PDA to be system-owned + zero-data (the
unfakeable no-submission proof); closes the claim (rent → worker, deposit surplus →
treasury), decrements `task.current_workers` and the worker's `active_tasks`. This is what
un-bricks `close_task` after a contest settles with a no-show entrant still holding a slot.
No escrow account (closed by then), no cleanup reward.

### 7. Reject window (fix round — symmetric temporal partition)

`reject_task_result` on a contest requires `now < ghost_at`, exactly like accept. Without
it a creator could front-run the ghost cranks after `ghost_at`, reject every entry, drive
the task to Open, cancel, and claw back the prize. From `ghost_at` onward the crank owns
every live submission.

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
