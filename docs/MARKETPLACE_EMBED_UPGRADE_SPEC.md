# Marketplace Program Plan — v3 (autoplan-patched)

> **Status: historical record (plan v3; execution complete — retained as
> record).** The batches planned here have shipped and been surpassed: mainnet
> runs the full 99-instruction surface (live since 2026-07-09, slot 431918664,
> `surface_revision = 4` / batch-4 goods); the 169-task migration executed
> 2026-06-11; upgrade authority is a Squads v4 2-of-3 multisig (since
> 2026-07-03); `ZkConfig` remains NOT initialized (ZK deferred). "84-ix" / "149"
> in the body are doc-date state. See `docs/MAINNET_MAINLINE.md` (deploy record),
> `docs/audit/ENTERPRISE_REMEDIATION_2026-07.md` (completed 2026-07 hardening
> record), and `README.md`.

**Complete plan to upgrade `agenc-coordination` for the embeddable marketplace.**
Validated against HEAD `9558c7d`, program `HJsZ53…` (live: 169 Tasks as of the
2026-06-11 full-surface upgrade — 149 when this was validated; the full 84-ix surface is
now live, `surface_revision = FULL`; upgrade authority is now a 2-of-3 multisig
`Hcecp…`/`BXDan…`/`4QcKB…`). v3 folds in the /autoplan dual-voice review: 11
correctness patches + 5 taste decisions baked in; the 3 strategic challenges are
now the §11.5 go/no-go gate. **ZK deferred** (Appendix Z). Planning doc only — no
program code changed by this file.

---

## 1. Model

SDK + widgets so any third party runs their own marketplace on AgenC.
- **Actors:** buyer (human wallet OR agent), maker (registered agent), operator
  (embedding site, earns a cut), AgenC (protocol fee + moderation/review authority).
- **Two job kinds:** one-shot `Task` (exists) + standing `ServiceListing` (new;
  mints a one-shot Task per hire, holds no escrow/children).
- **Money (every settlement, 3 ways):** worker ≥60%, AgenC ≤20%, operator ≤20%,
  locked at creation.
- **Trust:** every job content-moderated before go-live; quality fights → AgenC
  review; both sides post a 25% bond.

---

## 2. Decisions (all forks closed)

1. Operator fee per-task on the Task, **`operator != task.creator`**, combined cap.
2. Moderation gates **every** go-live path (FCFS claim, `accept_bid`, `hire_from_listing`).
3. Disputes/timeouts settle through a fee split (NOT the completion choke point — see §4).
4. Every frozen/rejected job has a guaranteed exit (AgenC ruling **or** permissionless timeout).
5. v1 single-worker; collaborative/multi-worker deferred.
6. Human buyers always get recourse (forced CreatorReview).
7. **Dispute split = a dedicated helper**, not reuse of `execute_completion_rewards`.
8. **Listing moderation = a listing/spec-keyed PDA** (per-hire re-moderation is impossible with the task-bound seeds).
9. **Humanless buyer = a dedicated `create_task_humanless` instruction** forcing CreatorReview.
10. **Defer the AGENC fee-cap raise (1000→2000)** until operator demand is proven; ship Batch 1 at 1000 bps.
11. **Moderation freshness is entry-only** (never re-checked on settle/exit/refund).

---

## 3. Live bugs (Batch 0)

- **Bid self-deal — DONE.** Fixed on branch `fix/bid-self-deal-guard`
  (`ensure_not_self_bid` guards `create_bid` (signer authority) and `accept_bid`
  (stored `bid.bidder_authority`); revert-sensitive tests; crate compiles).
- **Re-diff the rest against HEAD before the hotfix branch** (the bug list drifted —
  item #1 was already fixed). Confirm still-present: **claim-PDA resurrection**
  (`cancel_task.rs:391-397`, `dispute_helpers.rs:200-204`) → retain rent-exempt
  minimum + keep `owner == program`. Dispute fee bypass is folded into §4.
- ~~Attestor self-exclusion~~ (already fixed), ~~dependent-Proof "stuck"~~ (not a bug).

---

## 4. Fee model & settlement

- **Fields:** add `operator: Pubkey`, `operator_fee_bps: u16` to `Task`, locked at creation, **sourced from config / listing, never the raw creator** (operator != creator guard).
- **Caps:** `protocol ≤ 2000` (raise deferred — §2.10), `operator ≤ 2000`,
  `protocol + operator ≤ MAX_COMBINED` and hard `≤ 10000`; validated at **every**
  bps-set site. Worker floor 60%.
- **Completion split** in `execute_completion_rewards`: `worker = amount − protocol − operator`; worker absorbs rounding; legs sum to amount.
- **[PATCH] Dispute split = dedicated helper.** Do NOT route disputes through
  `execute_completion_rewards` — it bases legs off `task.reward_amount` while
  disputes base off `remaining_funds − token_slash_reserve`, so reuse reverts on
  `InsufficientEscrowBalance` and re-locks the dispute (incl. the permissionless
  `expire_dispute`). New helper takes the already-computed distributable, applies
  protocol+operator off-the-top **only on the worker-paid leg** (Complete +
  worker-half of Split, never the creator-refund leg), worker gets the remainder,
  asserts `protocol+operator+worker+slash_reserve == remaining_funds` per branch
  (SOL + SPL).
- **[PATCH] Operator-leg guards** (every call site): skip the operator transfer
  when `operator_fee_bps == 0 || operator == Pubkey::default()` (the 169 migrated
  legacy Tasks — else a default-pubkey burn / ATA revert); and require
  `operator_info.key() == task.operator` (mirror the treasury binding at
  `apply_dispute_slash.rs:67`) or the caller picks the recipient.
- Reputation discount → protocol leg only, floor ≥25 bps (today `.max(1)` at
  `completion_helpers.rs:417`). Delete dead `calculate_reward_split_tiered`.

---

## 5. New primitives

- **`ServiceListing`** (PDA `["service_listing", maker_agent, listing_id]`): no
  escrow, no child pointers; price, mint, spec pointer, caps, operator/operator_fee_bps,
  state {Active,Paused,Retired}, max_open_jobs, open_jobs, version, **`_reserved`**.
- **`hire_from_listing`**: mints a single-worker Task; **[PATCH] snapshots
  price / fee bps / bond bps / job-spec hash+URI / moderation hash / expiry /
  operator recipient at hire time** (never reads mutable listing fields at
  settlement — underpayment/fee-swap vector). Calls `require_task_type_enabled`
  + satisfies moderation (§6).
- **`close_task` + close all children** — see the child-PDA table below.

**[PATCH] Per-Task child-PDA table (normative — SDK + close_task source of truth):**

| Child | Seeds | Init by | Closed by |
|---|---|---|---|
| TaskEscrow | `["escrow", task]` | create | settle/cancel |
| TaskJobSpec | `["job_spec", task]` | set_task_job_spec | close_task |
| TaskModeration | `["task_moderation", task, hash]` | record_task_moderation | close_task |
| TaskValidation | `["task_validation", task]` | configure_task_validation | close_task |
| TaskAttestor | `["task_attestor", task]` | configure | close_task |
| TaskSubmission | `["submission", task, worker]` | submit | close_task |
| CompletionBond | `["completion_bond", task, party]` | claim/hire | settle/refund |

---

## 6. Moderation (one rule, every path, entry-only)

- Gate `set_task_job_spec`, `accept_bid` (before InProgress), `hire_from_listing`.
- **[PATCH] Listing-level reuse via a listing/spec-keyed account**
  (`["listing_moderation", service_listing, job_spec_hash]`, gated by the
  moderation_authority at publish/update). `hire_from_listing` checks THAT account
  against the listing's pinned `job_spec_hash` — the task-bound `task_moderation`
  seeds make per-hire reuse impossible, so a new account is required.
- **[PATCH] Freshness/generation check is ENTRY-ONLY** — never on settle/exit/refund,
  or key rotation re-locks legitimately-moderated funds (breaks Decision #4).
- `enabled=false` / unconfigured = fail-closed halt (launch-checklist item).
- Statuses: CLEAN=0, SUSPICIOUS=1, BLOCKED=2, SCANNER_UNAVAILABLE=3,
  HUMAN_APPROVED=4, HUMAN_REJECTED=5. Publishable = CLEAN | HUMAN_APPROVED.

---

## 7. Launch controls (kill switch, money-never-locks)

- New mints call `require_task_type_enabled`.
- **[PATCH] Enumerated exit allow-list** — exit/settlement paths stay callable when
  a type is disabled or `protocol_paused`: `cancel_task`, `expire_claim`,
  `resolve_dispute`, **`expire_dispute`** (the permissionless last resort —
  currently gated at `expire_dispute.rs:160-161`), the RejectFrozen exits, all
  `close_*`. Introduce `check_version_compatible_for_exit` that drops **only** the
  `protocol_paused` arm. Without this, a pause/type-disable permanently strands
  disputed/frozen escrow + bonds (contradicts Decision #4).
- Type-disable gates **entry only** (create/claim/create_bid/accept_bid/hire).

---

## 8. Bonds, revisions, reject → review

- **Symmetric 25/25 bonds in a dedicated `CompletionBond` PDA** (never on
  `TaskClaim` — it closes to the worker on exit, auto-refunding a no-show).
  **[PATCH] Full lifecycle spec:** seeds `["completion_bond", task, party]`;
  SOL vs SPL handling; rent payer; dup-prevention; close/refund across
  accept/reject/cancel/dispute/expire; 25/25 semantics for zero/partial reward
  (single-worker only in v1). `BidExclusive` keeps its own bid bond (no double-charge).
- **Free revisions then reject:** split `reject_task_result` into `request_changes`
  (free, non-terminal, bounded rounds) and `reject` (terminal escalation).
- **RejectFrozen** new status. **[PATCH] Fully closed branch:**
  - Add **all** `can_transition_to` rows (PendingValidation→RejectFrozen,
    RejectFrozen→Completed, RejectFrozen→Cancelled) AND update every status gate
    (claim/submit/accept/auto-accept/cancel/dispute-init/expiry/job-spec/validation).
  - Multisig review-decision exit **+ permissionless timeout exit** (define who pays
    rent/compute; pays worker, forfeits deposit to treasury).
  - **Dispute mutual-exclusion keyed on bond-PDA existence, not status string** —
    `initiate_dispute.rs:343` bypasses `task.status` on the durable-submission path,
    so a status-only guard wouldn't fire.

---

## 9. Human buyer

- **[PATCH] Dedicated `create_task_humanless`** (no `AgentRegistration`;
  `authority_rate_limit` re-seeded on the wallet pubkey; **always** ValidationMode
  CreatorReview). Avoids conditional accounts on the hot `create_task` path and the
  ValidationMode::Auto auto-pay-no-recourse trap (`create_task.rs:53-57`).

---

## 10. Migration (the one-way door)

- `Task`/`ProtocolConfig` have no spare padding; `migrate.rs:109` is value-only.
- **[PATCH] Gated + idempotent realloc:** multisig/upgrade-authority-gated (NOT
  permissionless); preconditions `old discriminator + owner == program +
  data_len == OLD_TASK_SIZE(382)`; set a `migrated` marker for idempotency; a
  dry-run that asserts the post-image deserializes as `Account<Task>`; binary-first
  deploy, then version bump (reverse order bricks via the version gate).
- **[PATCH] Add `_reserved[16..32]` to Task AND ProtocolConfig** during this sweep —
  future field adds become value-only migrates, not audited realloc-all sweeps.
- **[PATCH] LUT / versioned-tx is a hard Batch-2 deliverable** (settlement ix are
  already 16-21 accounts; +operator leg +operator ATA risks the legacy tx ceiling).
  State the worst-case account count; make the operator account OPTIONAL when fee==0.
- **Confirmed scope:** 169 live Tasks (149 when written), bounded one-time sweep —
  executed 2026-06-11 (382B → 466B, 0 failures).

---

## 11. Build order

- **Batch 0 (hotfix):** bid self-deal ✅ done; claim-resurrection after the HEAD re-diff.
- **Batch 1 (additive, audit #1, no migration):** ServiceListing + hire (term
  snapshot) + close_task (+ children) + fee-cap stays 1000 + 3-way completion split
  + moderation on all paths (+ listing-keyed moderation account) + narrow
  launch-control gate to entry.
- **Batch 2 (layout, audit #2, migration — the one-way door):** operator Task
  fields + dedicated dispute-split helper + ProtocolConfig fields + `_reserved` +
  gated/idempotent realloc + LUT. **Gated by §11.5.**
- **Batch 3:** symmetric bonds + revision split + RejectFrozen (full) + `create_task_humanless`.
- **Later:** SDK (Appendix Z note), multi-worker, ZK, anti-sybil tier, the fee-cap raise.

## 11.5 Strategic go/no-go gate (HUMAN-OWNED — both models challenge the plan here)

**Batch 2 is irreversible (audit + the task-layout mainnet migration — executed
2026-06-11 over 169 tasks). Do NOT start it until:**
1. **Demand thesis written** — name 2-3 concrete would-be operators (is
   `agenc-services-storefront` the first?), the evidence, and a kill criterion. The
   embed/operator premise currently has zero supporting artifact in the repo.
2. **SDK slice pulled forward** — both models say the SDK *is* the product; ship a
   thin operator-facing slice alongside Batch 1 so a pilot operator runs one
   listing+hire on devnet/canary. (User-owned: this reorders the program.)
3. **Success signal hit** — e.g. 1 operator integrated + N real `hire_from_listing`
   on canary, OR a named first-party operator live. Batch 2 spend is contingent on it.

Keep ZK + multi-worker deferred (both models endorse). Reconsider the AGENC fee-cap
doubling only after a take-rate-stack analysis (AGENC ≤20% + operator ≤20% + 25/25
bonds compounds supply-side cost).

---

## 12. Pre-launch operational checklist

1. ✅ Live Tasks? yes (169 at the 2026-06-11 upgrade; 149 when written) → realloc done.
2. ✅ Build? full (~1.95 MB live binary, sha `ea2fa92f…`; the 921 KB figure was the canary
   build) → ZK deferral is a usage choice (`ZkConfig` not yet initialized on mainnet).
3. Live `disabled_task_type_mask == 0` and `protocol_paused == false`? (RPC verify)
4. `ModerationConfig` created + `enabled`? (else marketplace halted — verify)
5. CU + account-count profile for the SPL 3-way split (LUT/versioned-tx).

---

## Appendix Z — ZK (deferred)

Objective-only via the `constraint_hash` firewall (zero=auto / sentinel=manual-review
/ else ZK-private). When picked up: the 3-way split flows into `complete_task_private`
via the same choke point (operator account OPTIONAL; never fees in the journal); ZK
tasks settle by proof, no reject/review; image rotation needs a grace window.
Nothing in Batches 0-3 depends on this.
