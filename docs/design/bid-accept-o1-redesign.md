# O(1) Bid Acceptance & Chunked Dispute Settlement — Long-Term Wire-Liveness Redesign

Status: IMPLEMENTED 2026-07-21 (founder-approved; program + SDK landed — see
CHANGELOG "O(1) bid acceptance + chunked dispute settlement")
Date: 2026-07-21
Closes (when implemented): `PROTOCOL-BID-WIRE-LIVENESS-001`, `PROTOCOL-DISPUTE-WIRE-LIVENESS-001` (fixme.md)
Related: `docs/MARKETPLACE_V2_BID_PROTOCOL.md`, `docs/DISPUTE_CHALLENGE_WINDOW.md`, adversarial wire-math audit 2026-07-20

---

## 1. Problem

Solana wire transactions (legacy and v0) are capped at 1,232 bytes. Two protocol
surfaces compose valid states that cannot be serialized:

**Bids.** `accept_bid` requires the creator to enumerate every other live bid as
an exact `[TaskBid, AgentRegistration]` pair in remaining accounts
(`BID_COMPETITOR_ACCOUNT_STRIDE = 2`). Exact serialization measurements
(2026-07-20 independent wire audit, verified against the installed
`@solana/kit` encoder):

| Shape | Accounts | Priced/unpriced bytes | Fits? |
|---|---|---|---|
| Independent task, 9 active bids | A27 | 1,218 / 1,206 | yes |
| Independent task, 10 active bids | A29 | 1,284 / 1,272 | **no** |
| Dependent task, 8 active bids | A26 | 1,185 / 1,173 | yes |
| Dependent task, 9 active bids | A28 | 1,251 / 1,239 | **no** |
| At the on-chain cap (20 active) | A47+ | ~1,944–1,977 | **no** |

`MAX_ACTIVE_BIDS_PER_TASK = 20` therefore permits books whose best bid can never
be accepted: **an on-chain state the protocol allows but cannot service.**

**Disputes.** The "monolithic dispute unwind" carries every other
`(claim, worker)` pair plus fixed settlement metas, dependency evidence,
maximal rationale/evidence URIs, and optional token legs in one transaction:

- `expireDispute`, dependent, 4 workers: A31, 1,318 bytes — **no fit** (the
  `DISPUTE_SAFE_MAX_WORKERS = 4` "safe" claim in `constants.rs` is false;
  dependent max is 3);
- `resolveDispute`, assigned resolver, 4 workers, max URI: A36/D301, 1,777 — **no fit**;
- direct-authority maximal settlement flows: 2,133+ — **no fit**, and any
  Squads outer wrapping makes every number worse.

**Not an option: waiting for bigger transactions.** SIMD-0296 (4,096-byte
limit) is in **Review** status, unactivated, and requires the new v1
transaction format (SIMD-0385) — plus a full wallet/tooling/Squads adoption
tail. It cannot be a dependency; if it lands it simply adds headroom.

---

## 2. Root-cause analysis (what the O(n) is actually for)

Reading `accept_bid_handler` end to end:

1. **Refunds are already pull-based.** Losing bidders reclaim bond + rent
   themselves via `cancel_bid` (allowed on an `Accepted` book) and the
   permissionless `expire_bid`. The competitor enumeration performs **no**
   settlement.
2. The enumeration exists solely for `validate_matching_policy_selection`: an
   on-chain **argmax recomputation** proving the selected bid is the
   deterministic winner under the book's declared policy
   (`BestPrice` / `BestEta` / `WeightedScore`).
3. **Every score input is already snapshotted inside the bid account**:
   `requested_reward_lamports`, `eta_seconds`, `confidence_bps`,
   `reputation_snapshot_bps`. The paired `AgentRegistration` is used only for
   *eligibility filtering* (`bidder_is_currently_eligible`: active status,
   stake, capabilities, reputation floor), never for scoring.
4. One genuine wrinkle: the `WeightedScore` eta component is normalized by
   `remaining_secs = deadline − now`, so the weighted *ordering* drifts with
   the acceptance timestamp. `BestPrice`/`BestEta` orderings are pure
   lexicographic functions of immutable bid fields. (The time drift is itself
   a latent fairness defect: which bid "deterministically wins" today depends
   on *when* the creator calls accept.)

Conclusion: the protocol pays O(n) accounts at accept time to recompute a
maximum it could have maintained incrementally, over scores that are (or can
trivially be made) pure functions of immutable per-bid data.

---

## 3. Options considered

| Option | Verdict | Why |
|---|---|---|
| **Cap active bids at 8** | rejected (stopgap) | Product ceiling on a marketplace's core competition mechanic; buys a second breaking change + live-state migration later, exactly when books hold money. |
| **Per-task address lookup tables** | rejected | Keeps O(n) semantics; adds a per-task table lifecycle (create + extend transactions, rent, one-slot warmup, deactivation cooldown, authority custody) for the life of the protocol; dynamic bid addresses force a table extension per bid. The SDK's verified ALT client support (landed 2026-07-21) stays as generic v0 infrastructure, not as the fix. |
| **Multi-transaction batch verification** (verify competitors in chunks pinned to `book.version`) | rejected | Any bid mutation bumps the version and invalidates all batches → a hostile bidder can grief acceptance forever with penny updates. |
| **Optimistic accept + challenge window** | rejected | Adds mandatory assignment latency to every bid task; slashing/undo machinery is heavier than preventing the bad accept in the first place. |
| **Drop on-chain policy enforcement** (creator picks freely) | rejected as default | O(1) and simple, but bidders bond funds under advertised deterministic-policy rules; silently converting the policy to advisory changes marketplace trust semantics. (Note: a creator-choice `MatchingPolicy` variant could be added *explicitly* later.) |
| **Incremental winner tracking in the book** | **chosen** | O(1) accounts at accept, unbounded competition, preserves exact policy semantics once scores are frozen to a fixed reference window. This is the ecosystem-standard auction pattern (Metaplex: the leading bid is locked / cannot cancel; losers withdraw their own escrow afterward). |

---

## 4. Part A — incremental winner tracking (`TaskBidBook` argmax cache)

### 4.1 Score freezing (prerequisite)

Replace the `WeightedScore` eta normalization base `deadline − now` with a
**frozen reference window** `R₀ = task.deadline − bid_book.created_at`,
recorded once at `initialize_bid_book`. All three policies' orderings become
pure functions of immutable bid fields — so pairwise comparisons at insert
time are exactly equivalent to a full rescan at accept time, and the winner no
longer depends on when accept is called. Per-bid *validity* (expiry,
`now + eta ≤ deadline`) remains evaluated at `now` wherever a bid is used.

### 4.2 State (append-only; migration-gated)

Append to `TaskBidBook` (layout rule: append-only, `const_assert` size,
`migrate` coverage; the 2026-07 mainnet scan found **zero** live books —
re-verify with a fresh two-provider inventory immediately before cutover):

```rust
// Cached deterministic winner under the frozen-score policy.
pub best_bid: Pubkey,               // default = none
pub best_reward_lamports: u64,      // cached score components of best_bid,
pub best_eta_seconds: u32,          //   refreshed on any best-bid change so
pub best_confidence_bps: u16,       //   comparisons never need to load the
pub best_reputation_bps: u16,       //   incumbent's account
pub winner_stale_since: i64,        // 0 = fresh; set on best removal
pub score_window_secs: u32,         // frozen R₀ for WeightedScore
```

Caching the components (not just the key) means `create_bid`/`update_bid`
compare against book-resident scalars — no extra account dependencies, no
races against a concurrently closing best-bid account.

### 4.3 Instruction changes

- **`create_bid` / `update_bid`** (O(1), unchanged account lists): compute the
  candidate with frozen R₀; if the cache is empty or the candidate beats it
  under `candidate_is_better` + existing tie-breaks, install it.
  **Leader-retreat rule:** the tracked best may update only to equal-or-better
  terms under the policy comparator (it may sweeten, not retreat — retreating
  would silently invalidate the cache against unseen bids). A leader that
  wants out cancels instead, taking the staleness path.
- **`cancel_bid` / `expire_bid`** of the tracked best: clear the cache, set
  `winner_stale_since = now`. (All bids remain freely cancellable — "money
  never locks" §7 is preserved; unlike Metaplex we do not lock the leader,
  we make leader-exit observable.)
- **New: `promote_bid(book, bid, bidder_agent)`** — permissionless. Presents
  any live, currently-eligible bid; installs it if it beats the cache (or the
  cache is empty). Rational bidders re-promote themselves immediately;
  indexer/worker bots can crank it for anyone.
- **New: `demote_ineligible_best(book, bid, bidder_agent)`** — permissionless.
  Proves the cached best is no longer eligible/valid (suspended, stake below
  floor, expired, terms no longer deadline-feasible) → clears cache, marks
  stale. Prevents a dead leader from blocking the book.
- **`accept_bid`** (now O(1) accounts): drop the competitor enumeration
  entirely; keep the dependency-parent prefix. New requirements:
  `bid.key() == book.best_bid`; the winner passes the existing full named-
  account eligibility + validity checks (already present); and the
  **staleness grace**: if `winner_stale_since > 0`, require
  `now ≥ winner_stale_since + BID_REPROMOTION_GRACE` (proposed 300 s;
  `validation-timings` short value for tests) *and* a repromoted best — so
  when a leader exits, every remaining bidder has a fair window to re-promote
  before the creator can accept, closing the "collude, cancel the best,
  instantly accept a worse bid" race.
- **Delete**: `BID_COMPETITOR_ACCOUNT_STRIDE`, the enumeration arm of
  `validate_matching_policy_selection`, `accept_bid_account_key_budget`'s
  wire coupling. `MAX_ACTIVE_BIDS_PER_TASK = 20` survives purely as a
  state/spam bound — raising it later is a constant change with **no wire
  consequence**.

### 4.4 Result

Worst-case `accept_bid` (dependent task, all fixed accounts, priced) drops
from A28+/1,251+ bytes to roughly A12–14 / ~700 bytes — hundreds of bytes of
headroom, Squads-wrappable, independent of bid count. Twenty, fifty, or two
hundred active bids serialize identically.

### 4.5 Adversarial notes

- Creator cannot bypass the policy: accept hard-requires the cached best.
- Leader cannot retreat in place; exiting sets an observable stale window.
- Cancel-churn griefing (leader repeatedly canceling/rebidding to delay
  accept) is bounded per cycle by the grace constant and costs the griefer
  their winning position each time; existing per-bidder rate limits apply.
- Sybil sets are unchanged: one live bid per (task, bidder) PDA is structural.
- Equivalence obligation: a property test must prove
  `incremental cache == full rescan argmax` over random bid
  create/update/cancel/expire sequences under frozen R₀ (both tie-break
  chains), plus litesvm E2E for promote/demote/stale/grace and exact
  compiled-size regressions at 20 active bids.

---

## 5. Part B — chunked (pull) dispute settlement

Replace the monolithic unwind with ruling-then-settle, mirroring the pull
pattern the protocol already uses everywhere else (`cancel_bid`,
`expire_bid`, `reclaim_terminal_claim`, `reclaim_completion_bond`):

1. **`resolve_dispute` / `expire_dispute`** record the ruling and mutate only
   the dispute + named principal accounts (initiator, resolver, escrow legs).
   Append to `Dispute`: `workers_total: u8`, `workers_settled: u8`, and a
   settled bitmask (u8 covers the collaborative cap). The dispute enters a
   new `SettlementPending` state; conflicting task/claim paths already gate
   on dispute state and stay blocked until terminal.
2. **New: `settle_dispute_claim(dispute, claim, worker_agent, …)`** —
   permissionless, one worker per transaction. Applies that worker's
   reputation/track-record/slash/payout effects exactly once (bitmask), then
   increments `workers_settled`. When `workers_settled == workers_total` the
   dispute transitions to its terminal state and existing closure/rent paths
   apply. Exit-gated (`check_version_compatible_for_exit`) like every
   settlement path — money never locks under pause.
3. **Rationale/evidence payloads**: store 32-byte content hashes on-chain and
   move full URIs to events/indexer resolution (product decision — flagged,
   not assumed). This alone removes ~240 bytes from worst-case
   `resolveDispute` and is what makes direct-authority + Squads outer flows
   fit comfortably.
4. `DISPUTE_SAFE_MAX_WORKERS` stops being a wire constant; the collaborative
   cap becomes a state-size decision. The false "four workers preserve room"
   comment is deleted with the mechanism it described. (This is exactly the
   "chunked settlement state" the constant's own comment anticipates.)

Atomicity note: the ruling remains atomic; only per-worker *effects* are
deferred, each idempotent and permissionless. No ordering between workers
matters; nothing observable to a worker changes except that their settlement
lands in its own transaction.

---

## 6. Sequencing, compatibility, gates

- **Timing**: this is revision-5-candidate work — before external audit,
  while mainnet holds **zero** bid books and the candidate is undeployed.
  This is the cheapest this change will ever be; shipping cap-8 instead
  means a second breaking ABI change + live-money migration after adoption.
- **Compatibility**: `TaskBidBook`/`Dispute` changes are append-only with
  `const_assert` + `migrate_task`-style coverage; new instructions and error
  codes append after the current ends; `accept_bid`'s remaining-accounts
  contract changes (non-canary instruction — allowed, SDK updated in the
  same change); full artifact/SDK/facade/React/CLI regeneration and the
  standard drift gates.
- **Order of work**: Phase A bid book (state → score freeze → transitions →
  new instructions → property/litesvm/size tests) → Phase B disputes →
  regenerate + docs (`MARKETPLACE_V2_BID_PROTOCOL.md`, `PROGRAM_SURFACE.md`,
  `ERRORS.md`, `INSTRUCTIONS.md`) → ledger closure for both wire-liveness
  rows per their stated criteria (including the fresh two-provider live
  inventory immediately before any cutover).
- **Deploy** remains human-gated per the standing mainnet gates; nothing in
  this plan signs, broadcasts, or deploys.

## 7. Decisions needed from the founder

1. Approve the incremental-argmax redesign (Part A) over cap-8/ALT stopgaps.
2. Approve score freezing (`R₀` window) — a deliberate, documented semantic
   change to `WeightedScore` (and the reason exact equivalence is possible).
3. Approve pull settlement for disputes (Part B).
4. Rationale/evidence hash-only on-chain (5.3) — yes/no (UX: explorers
   resolve content via indexer).
5. `BID_REPROMOTION_GRACE` value (proposed 300 s).
