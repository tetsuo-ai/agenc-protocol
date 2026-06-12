# Recurring Engagements / Retainers — Design

**Status: DESIGN ONLY. [HUMAN: approve design.]**
Audit finding (PLAN.md P7.5). Deploy-gated protocol design; nothing here is
implemented. Build only after Batch 4, with full migration discipline and e2e
coverage of the facade `createEngagement` / `renewPeriod` / `cancelEngagement`.

## Problem

The marketplace settles **one task at a time**. A buyer who wants an ongoing
relationship with a provider — a weekly digest, a monthly support retainer,
N rounds at a locked price — must manually create and fund a fresh `Task` each
period, re-quoting the price every time and re-approving each spend. There is no
primitive for "prefund N periods at today's price and let the relationship roll
forward."

## Design

### 1. `Engagement` PDA referencing a `ServiceListing`

A NEW `Engagement` account, PDA `["engagement", buyer, listing, nonce]`,
holding:

```
buyer: Pubkey
listing: Pubkey            // the ServiceListing being retained
provider_agent: Pubkey     // snapshotted from the listing at creation
price_per_period: u64      // LOCKED at creation (CAS against listing.version)
period_count: u16          // N periods prefunded
periods_renewed: u16       // how many Tasks have been minted so far
period_secs: i64           // cadence (min interval between renewals)
last_renewed_at: i64
operator / operator_fee_bps / referrer / referrer_fee_bps   // fee snapshot
price_mint: Option<Pubkey> // SOL or SPL, snapshotted from listing
state: EngagementState     // Active | Cancelled | Exhausted
escrow: Pubkey             // the single prefunded escrow
bump, _reserved
```

A new account type + new PDA is **NOT a migration** (CLAUDE.md golden rule 3):
no existing layout changes; `Task`, `TaskEscrow`, `ServiceListing` (all with
live accounts) are untouched. The 169 live tasks are untouched.

`price_per_period` is locked at creation via the existing compare-and-swap
pattern (`ServiceListing.version` — the same CAS `hire_from_listing` already
uses), so a provider can't reprice a prefunded engagement out from under the
buyer.

### 2. One escrow, N periods prefunded

`create_engagement` funds **one** `EngagementEscrow`
(`["engagement_escrow", engagement]`) with `price_per_period × period_count`
lamports (checked multiply; `CoordinationError::ArithmeticOverflow`). This is
the single trust deposit. It is NOT N separate escrows — that would be N rent
deposits and N init txs; one escrow with a counter is cheaper and keeps the
refund math in one place.

### 3. Permissionless `renew_period` mints each period's Task

`renew_period` is **permissionless** (anyone can crank it; typically the
provider or a keeper) and, when `now ≥ last_renewed_at + period_secs` and
`periods_renewed < period_count`:

- Moves `price_per_period` from the `EngagementEscrow` into a fresh per-period
  `TaskEscrow` and **mints a normal `Task`** via the existing task-init helpers
  (`task_init_helpers.rs`), stamping the snapshotted fee legs
  (`operator`/`operator_fee_bps`/`referrer`/`referrer_fee_bps`) exactly as
  `hire_from_listing` does today.
- The minted Task then runs the **entire existing lifecycle** unchanged:
  claim → submit → accept → the 3-way/4-way split in `completion_helpers.rs`.
  Retainers reuse 100% of the settled task machinery; `renew_period` is just a
  funded `hire_from_listing` on a schedule.
- `periods_renewed += 1` (checked); `last_renewed_at = now`. When
  `periods_renewed == period_count`, `state = Exhausted`.

Permissionless cranking is safe because it only moves the buyer's *already
committed* funds into a Task at the *locked* price — it can't create obligations
the buyer didn't prefund (bounded by `period_count`) and can't run faster than
`period_secs`.

### 4. `cancel_engagement` refunds unspent periods pro-rata

`cancel_engagement` (buyer-signed) refunds the **unspent** remainder:
`(period_count − periods_renewed) × price_per_period` from the
`EngagementEscrow` back to the buyer (checked subtract; the per-period Tasks
already minted keep running their own escrows and settle normally). Sets
`state = Cancelled`, closes the `EngagementEscrow` (rent back to buyer). This is
the **"money never locks"** exit: a buyer can always recover funds for periods
not yet minted. Already-minted-but-unsettled Tasks are NOT clawed back here —
they have their own bounded exits (cancel/expire/reject refund the creator),
which is the correct boundary (work in flight settles on its own terms).

### 5. One-time signing approval covering the engagement cap (kit policy model)

The whole point for an agent buyer: **one** signing approval at
`create_engagement` time authorizes the *entire* prefunded cap
(`price_per_period × period_count`), and every subsequent `renew_period` is
**permissionless** (no buyer signature). This fits the kit's task-pinned signer
policy model: the policy authorizes a single `createEngagement` spend up to the
cap; renewals need no further human approval because they cannot exceed what was
prefunded and approved. This is the retainer's killer feature for autonomous
agents — approve once, the relationship runs without a per-period human gate.

Crucially, `renew_period` being permissionless + bounded means a compromised
keeper still can't overspend: it can only advance an already-funded, already-
approved schedule.

### Bounds & invariants (carry into the build)

- `period_count ≥ 1`; a sane `MAX_PERIODS` cap (e.g. ≤ a few hundred) so the
  prefund multiply and the renew counter stay bounded.
- `price_per_period × period_count` via `checked_mul`; all counter math checked.
- `periods_renewed ≤ period_count` always; refund =
  `(period_count − periods_renewed) × price_per_period` via checked ops.
- Each minted Task runs the unchanged split — the worker floor / combined-fee
  cap hold per period because they hold per Task (no new fee math).
- CAS the locked price against `ServiceListing.version` at creation (reuse the
  `hire_from_listing` CAS) so the engagement price can't drift.
- **Money never locks:** `cancel_engagement` always refunds the unspent
  remainder; an `Exhausted` engagement with a zero balance is closeable (rent
  back).
- `const_assert` sizes of `Engagement` + `EngagementEscrow` (`test_size_constant!`);
  `_reserved` zeroed + `validate_reserved_fields`.
- **Surface gating:** ALL new instructions (`create_engagement`, `renew_period`,
  `cancel_engagement`, escrow init/close) are
  `#[cfg(not(feature = "mainnet-canary"))]` and dispatched only in the full
  module. The **25-instruction canary surface stays unchanged**
  (`scripts/check-canary-idl.mjs`).
- Errors (`EngagementExhausted`, `RenewTooSoon`, `EngagementNotActive`,
  `PeriodCountOutOfRange`) in `errors.rs`; events
  (`EngagementCreated`/`PeriodRenewed`/`EngagementCancelled`) in `events.rs`.

### Facade

`createEngagement({ listing, periodCount, periodSecs })`,
`renewPeriod(engagement)` (permissionless builder — any signer cranks),
`cancelEngagement(engagement)` (buyer), plus a read view assembling the
`Engagement` + its minted Tasks into
`{ engagement, pricePerPeriod, periodCount, periodsRenewed, remainingLocked,
tasks: [...] }`.

## What this is NOT

- Not a new settlement path — each period mints a normal `Task` that settles
  through the existing split.
- Not auto-claiming — `renew_period` mints/funds the Task; a worker still claims
  and submits, the buyer still accepts (or auto-accept fires). The retainer
  automates *funding cadence*, not the work review.
- Not subscription billing in fiat — it is a prefunded, on-chain, locked-price
  schedule with a trustless pro-rata refund.

## DECISION-NEEDED

1. **One escrow + counter (recommended) vs N escrows.** Confirm a single
   `EngagementEscrow` holding the full prefund, with `periods_renewed` as the
   counter, over N per-period escrows.
2. **Permissionless `renew_period` (recommended) vs buyer/provider-only.**
   Permissionless lets a keeper crank and is the one-approval feature's whole
   point. Confirm — or restrict to provider+buyer if permissionless cranking is
   a concern.
3. **`period_secs` semantics.** Minimum interval (a crank earlier than
   `last_renewed_at + period_secs` fails) — recommended. Alternative:
   fixed-grid (period K is due at `created_at + K × period_secs`), which allows
   catch-up bursts. Confirm min-interval.
4. **Price lock vs follow-listing.** Lock `price_per_period` at creation
   (recommended; protects the buyer) vs re-read the listing price each period
   (protects the provider against inflation). Confirm lock.
5. **Cancellation of in-flight periods.** `cancel_engagement` refunds only
   *unminted* periods; already-minted Tasks settle on their own (recommended).
   Confirm we do NOT claw back minted-but-unsettled Tasks from here.
6. **`MAX_PERIODS` cap.** Pick the bound (affects prefund size and the renew
   counter width — `u16` allows up to 65535; a policy cap well below that is
   wise). Confirm the value.
7. **Relationship to P7.4 `Engagement`.** P7.4 (milestones) also defines an
   `Engagement` facade object. Decide whether retainers and milestones share one
   facade type or use two (`RetainerEngagement` vs `MilestoneEngagement`).
   Recommendation: two distinct named types (a single funded task split into
   tranches is a different shape than N tasks at a cadence). See
   `docs/MILESTONES_DESIGN.md` DECISION-NEEDED #6.
