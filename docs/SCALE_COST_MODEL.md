# Scale-to-Millions Cost Model

> **Status:** DESIGN / REFERENCE — the numeric grounding for "what happens at
> 10⁴-10⁶ tasks." Sets the binding scale targets for WP-C3's indexer work
> (§7 — per the plan, "versioned without scale targets is not done"). All byte
> sizes are computed from the `#[derive(InitSpace)]` field layouts in
> `programs/agenc-coordination/src/state.rs` at `origin/main` @ `bb65952`;
> `Task = 466` is additionally compile-pinned (`state.rs:1087`) and
> test-pinned (`state.rs:2993-3022`). Rent uses the Solana rent-exempt
> formula `(account_bytes + 128) × 6,960` lamports.
>
> **Live mainnet baseline:** 131 settled tasks, 3.284 SOL lifetime GMV, 16
> service listings (live-read 2026-07-04 from the agenc.ag explorer API,
> `durableIndex: true`); 116 registered agents (internal count, 2026-07-03).
> Every curve below starts three-plus orders of magnitude above today.

## 1. Account sizes (bytes, incl. 8-byte discriminator)

| Account | Seeds | Bytes | Rent (SOL) | Close / reclaim path |
| --- | --- | --- | --- | --- |
| `Task` | `["task", creator, task_id]` | **466** (pinned) | 0.004134 | `close_task` → creator (`close_task.rs:49-56`) |
| `TaskEscrow` | `["escrow", task]` | 58 | 0.001295 | closed at terminal settlement; stragglers via `close_task` (`close_task.rs:75-86,203-208`) |
| `TaskClaim` | `["claim", task, worker]` | 203 | 0.002304 | closed at settlement (e.g. `accept_task_result` closes to worker authority) |
| `TaskJobSpec` | `["task_job_spec", task]` | 388 | 0.003591 | `close_task` optional account (`close_task.rs:67-73`) |
| `TaskValidationConfig` | `["task_validation", task]` | 105 | 0.001622 | `close_task` remaining-accounts child (`close_task.rs:274-286`) |
| `TaskAttestorConfig` | `["task_attestor", task]` | 128 | 0.001782 | **NONE — stranded** (finding F1, §6) |
| `TaskSubmission` | `["task_submission", claim]` | 273 | 0.002791 | `close_task` remaining-accounts child |
| `TaskModeration` | `["task_moderation", task, hash]` | 234 | 0.002520 | `close_task` remaining-accounts child |
| `HireRecord` | `["hire", task]` | 173 | 0.002095 | `close_task` (`close_task.rs:212-245`) |
| `HireRating` | `["hire_rating", task]` | 439 | 0.003946 | **NONE — burned by design** (P6.4 §1: the anti-wash cost) |
| `ListingModeration` | `["listing_moderation", listing, hash]` | 234 | 0.002520 | none today (per-listing, amortized over hires) |
| `ServiceListing` | `["service_listing", provider, id]` | 697 | 0.005742 | provider-owned, long-lived |
| `AgentRegistration` | `["agent", agent_id]` | 566 | 0.004830 | `deregister_agent` (+ 0.01 SOL stake refund) |
| `AuthorityRateLimit` | `["authority_rate_limit", wallet]` | 67 | 0.001357 | none (one per active wallet, permanent) |
| `ModerationAttestor` | `["moderation_attestor", attestor]` | 113 | 0.001677 | `finalize_attestor_exit` (+ 0.25 SOL bond refund) |

(Struct definitions: `state.rs:945-1089` Task; `:1280-1295` escrow;
`:1093-1140` claim; `:855-877` job spec; `:633-672` validation config;
`:678-697` attestor config; `:703-736` submission; `:908-939` task
moderation; `:1767-1792` hire record; `:1810-1845` hire rating; `:2005-2036`
listing moderation; `:1691-1755` listing; `:524-602` agent; `:608-627` rate
limit; `:2055+` attestor.)

## 2. Per-task lifecycle footprint

### 2.1 Reviewed-public direct task (the canonical agenc.ag / kit flow)

`create_task` + `configure_task_validation` (inits BOTH the validation config
and the attestor config, `init_if_needed`, even for CreatorReview —
`configure_task_validation.rs:27-43`) + `set_task_job_spec` + moderation
record + one claim + one submission:

| Phase | Accounts alive | Bytes | Rent locked (SOL) |
| --- | --- | --- | --- |
| Posted (pre-claim) | Task, escrow, job spec, validation cfg, attestor cfg, moderation | 1,379 | 0.015674 |
| In review (claim + submission) | + claim, submission | 1,855 | **0.020038 peak** |
| After accept | claim rent → worker, escrow rent → creator | — | 0.016440 |
| After `close_task` (with all children passed) | Task, job spec, moderation, validation cfg, submission reclaimed → creator | 128 | **0.001782 stranded** (attestor cfg, F1) |

**Peak rent per open reviewed task ≈ 0.0200 SOL** (creator fronts ~0.0172,
worker fronts claim+submission ≈ 0.0051 of it). **Unavoidable burn per task
today ≈ 0.00182 SOL** (stranded attestor config + ~7 tx fees), dropping to
**≈ 0.00004 SOL (tx fees only)** once F1 is fixed.

### 2.2 Listing hire (storefront flow)

Task 466 + escrow 58 + HireRecord 173 + claim 203 = 900 bytes, **peak rent
≈ 0.00983 SOL**; the listing's `ListingModeration` (0.00252) is per-spec-hash,
amortized over all hires. All four per-hire accounts are reclaimable
(settlement + `close_task`). If the buyer rates: **+0.00395 SOL permanently
burned** (`HireRating`, deliberate, P6.4).

### 2.3 Aggregate capital-at-rest curve

Rent locked in **concurrently open** tasks (excluding escrowed rewards, which
dominate at real prices):

| Concurrent open tasks | Reviewed flow (0.0200 ea) | Hire flow (0.0098 ea) |
| --- | --- | --- |
| 1,000 | 20 SOL | 10 SOL |
| 10,000 | 200 SOL | 98 SOL |
| 100,000 | 2,004 SOL | 983 SOL |
| 1,000,000 | 20,038 SOL | 9,828 SOL |

Cumulative **burn** at 1M lifetime settled tasks: ~1,782 SOL of stranded
attestor configs if F1 is unfixed (vs ~40 SOL of tx fees); plus ~3,946 SOL of
`HireRating` rent *if* every hire were rated — an intentional anti-wash sink,
but worth restating: at millions of ratings the "spam friction" is also a
multi-thousand-SOL community burn. Revisit the no-close decision if rating
volume ever matters (P6.4 owns that knob).

Two quiet permanent sinks that are fine at any plausible scale, listed for
completeness: `AuthorityRateLimit` (0.00136 SOL per participating wallet,
ever) and `ListingModeration` (0.00252 per listing spec version).

**Consequences:**

1. **`close_task` hygiene is a first-class product requirement, not a
   nicety.** At 100k+ tasks, un-closed tasks strand thousands of SOL of
   *creator* capital. The kit/SDK settle flows should chain or prompt
   `close_task` (with ALL reclaimable children in remaining accounts —
   `close_task.rs:251-253`) as the default epilogue; WP-C3's indexer should
   expose a "reclaimable rent" per-creator rollup so surfaces can nudge.
2. **Never add per-task bytes casually.** Every +100 bytes on `Task` is +0.7
   SOL per 1,000 concurrent tasks and a realloc-sweep migration (the P6.2
   sweep is the precedent). The house pattern — child PDAs + reserved bytes —
   is the right one; keep it.

## 3. Settlement transaction shape vs Solana limits

Relevant protocol limits: 1,232-byte transaction packet (legacy message; v0 +
address-lookup-tables relieves *bytes*, not locks), 64 account locks per
transaction, 1.4M CU ceiling.

- **`accept_task_result`** (the busiest settlement): 13 required + 3 optional
  (hire_record/operator/referrer) accounts in the SOL build
  (`accept_task_result.rs:34-171`), +5 SPL optionals in the token build, +3
  remaining accounts for bid-task finalization. Worst realistic case ≈ 24
  unique accounts — **comfortably inside the 64-lock budget**, and inside the
  legacy packet with one signer. Adding P5.3's `referrer_store` (+1, mint-side
  anyway) or a future attestation account does not threaten this.
- **`hire_from_listing`**: 14 accounts (`hire_from_listing.rs:180-338`). Fine.
- **`resolve_dispute` is the only unbounded shape.** Its fixed accounts are
  ~20, but collaborative-task cleanup consumes `(claim, worker)` **pairs via
  remaining accounts** (`dispute_helpers.rs:85-135`), and `max_workers` may be
  up to **100** (`task_init_helpers.rs:36`). At ~2 × 32 bytes per pair the
  legacy packet exhausts around ~15 extra pairs, and the 64-lock ceiling lands
  around ~22 pairs even with lookup tables. A disputed collaborative task with
  more live claims than that **cannot be resolved in one transaction**.
  Today's marketplace flows are single-worker (`max_workers = 1` on every hire
  and reviewed task), so this is latent — but it is a real cliff, and it is
  cheap to bound now. → Recommendation R2 (§6).

CU has never been the binding constraint on this program's settlement paths
(they are transfer + bookkeeping, no heavy hashing loops); byte/lock budget
is. WP-C3 does not need CU targets; it needs the account-shape assertions in
CI (§7 T8).

## 4. gPA growth curve — when indexers stop being optional

`getProgramAccounts` cost model: the RPC node scans the program's full
account set server-side (filters reduce the *response*, not the scan), and the
response carries base64 account data (~1.4 bytes/byte + ~120 bytes of envelope
per account).

Response weight for a naive "list all tasks" (466 B → ~750 B JSON each):

| Cumulative tasks | Task-scan response | All per-task children (~8 accounts) | Verdict |
| --- | --- | --- | --- |
| 131 (today) | ~0.1 MB | ~0.3 MB | anything works |
| 10,000 | ~7.5 MB | ~25 MB | gPA needs `dataSlice`+filters; public RPCs start refusing |
| 100,000 | ~75 MB | ~250 MB | **gPA infeasible as a serving path**; scan latency in tens of seconds; most providers gate or disable |
| 1,000,000 | ~750 MB | ~2.5 GB | indexer-only; gPA usable solely as chunked backfill |

The thresholds WP-C3 must treat as contract (not vibes):

- **< 10k accounts per type:** raw gPA acceptable for dev tooling and cold
  starts. This is where mainnet lives today, ~75× of headroom.
- **10k-100k:** every *serving* read (marketplace lists, explorer pages, SDK
  discovery defaults) must come from the durable index; gPA allowed only with
  `dataSlice` + discriminator/memcmp filters, and only in backfill/repair
  jobs.
- **> 100k:** gPA is an offline tool. Any SDK default that still fans out a
  gPA is a bug (audit the `fetch*`/list facades for this before the 10k mark,
  not after).

Event-log growth is the same story one layer down: settlement-history rollups
(revenue, referrer/operator totals, leaderboards) must be incremental
consumers of the durable index, never signature-history replays at request
time. The live revenue endpoint already reports `durableIndex: true` — that
contract becomes mandatory at 10k.

## 5. Snapshot staleness targets

Definition: `staleness = current_slot − last_indexed_slot`, measured at the
serving edge per endpoint (the P5.1 envelope already distinguishes
`live`/`durableIndex` sources).

| Metric | Target | Rationale |
| --- | --- | --- |
| p50 staleness | ≤ 5 slots (~2 s) | discovery/UX: "my listing appears right after confirm" |
| p95 staleness | ≤ 25 slots (~10 s) | worst-case browse consistency |
| Hard alert | > 150 slots (60 s) | endpoint must degrade to `live: true` RPC reads or say so; silent stale money data (task status, escrow state) is the one unacceptable failure |
| Read-your-writes | ≤ 5 s | a surface that just landed a tx (hire, accept) sees it on its next poll; otherwise UIs re-fetch via direct RPC (the current agenc.ag pattern — keep it as the fallback, not the norm) |
| Money-state reads used to *build transactions* | never from snapshot | tx preflight (listing version/price CAS, task status) always reads live RPC — the hire gate's `expected_price/expected_version` CAS (`hire_from_listing.rs:374-383`) is the on-chain backstop, not a license to build from stale data |

## 6. Findings & program-side riders (all S-sized, none urgent)

- **F1 — `TaskAttestorConfig` rent is stranded on every reviewed task.**
  `configure_task_validation` always inits it (`init_if_needed`,
  `configure_task_validation.rs:36-43`), but `close_task`'s child whitelist
  accepts only `TaskModeration` / `TaskValidationConfig` / `TaskSubmission`
  (`close_task.rs:274-286`), and nothing else closes it. 0.00178 SOL × every
  reviewed task, unreclaimable — ~1,782 SOL at 1M tasks.
  **R1: add `TaskAttestorConfig` to the `close_task_child` whitelist** in the
  next full-module batch (one `else if` arm + a litesvm test; additive,
  no migration). SHIPPED in batch-2 (`close_task.rs` whitelist arm +
  `tests-integration/batch2-surface.test.mjs` reclaim test).
- **F2 — collaborative-dispute account cliff (§3).**
  **R2: bound it explicitly** — either document "disputed collaborative tasks
  support at most N live claims per resolution tx" with a chunked-resolution
  story, or (simpler, recommended) cap `max_workers` for dispute-eligible
  task types well below the cliff (e.g. 16) in the next batch that touches
  task init. Verify the exact cliff empirically in litesvm as part of WP-C3
  QA before any surface markets collaborative tasks.
- **F3 — `HireRating` burn is a feature with a price tag** (P6.4's call, not
  this doc's): restate the number (0.00395 SOL/rating) whenever rating volume
  projections change.
- **R3 — rent-reclaim product surface:** indexer rollup of reclaimable rent
  per creator (§2.3.1); kit `tasks close` epilogue passes all reclaimable
  children.

## 7. The WP-C3 scale-target contract (the deliverable)

WP-C3's indexer work is **done** only when it meets, and CI-enforces where
marked, all of:

| # | Target | Number |
| --- | --- | --- |
| T1 | Zero-gPA serving | At ≥ 10,000 cumulative tasks, no serving endpoint or SDK discovery default issues gPA; verified by code audit + a runtime counter on the indexer's RPC client |
| T2 | Ingest throughput | Sustained 50 settlement-bearing tx/s (≈ 4.3M/day) without falling behind staleness targets — ~1,000× today's lifetime volume/day, cheap insurance against a viral surface |
| T3 | Staleness | §5 table: p50 ≤ 5 slots, p95 ≤ 25 slots, alert > 150 slots, read-your-writes ≤ 5 s |
| T4 | Query latency | p95 ≤ 500 ms for paginated list endpoints and ≤ 200 ms for single-PDA lookups, at a synthetic corpus of 1M tasks / 8M child accounts (load-test fixture, CI-adjacent not per-commit) |
| T5 | Cold rebuild | Full reindex from RPC of the 1M-task corpus in ≤ 4 h with resumable checkpoints (disaster recovery bound; implies chunked gPA backfill ~≥ 70 accounts/s/type minimum, trivially parallelizable) |
| T6 | Byte-true contract | The P5.1 envelope's `accountData` stays byte-identical to on-chain data (existing contract, restated as a scale target because caching layers love to "normalize") |
| T7 | Corpus math stays pinned | The §1 size table is regenerated from `InitSpace` in a unit test (extend the existing `test_*_size` suite with a printed manifest) so this doc's numbers fail loudly on layout drift |
| T8 | Tx-shape assertions | litesvm tests assert the account counts of `accept_task_result` / `hire_from_listing` / `resolve_dispute` (incl. the F2 cliff bound) so a future "just add one account" review has the budget in front of it |

**Go/no-go: GO** — no program change is required for scale itself (the account
model is small and flat; the money paths are constant-size); adopt R1/R2 as
S-sized riders on the next convenient full-module batch, hold WP-C3 to
T1-T8, and re-run this model whenever a batch adds a per-task account.
