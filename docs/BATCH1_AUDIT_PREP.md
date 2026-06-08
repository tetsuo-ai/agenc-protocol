# Batch 1 — Audit Prep (embeddable marketplace)

Pre-audit map of the additive, no-migration Batch 1 of the embeddable-marketplace
work, for a professional security review **before any deploy**. Pairs with the full
plan in `docs/MARKETPLACE_EMBED_UPGRADE_SPEC.md`.

- **Program:** `agenc-coordination`, id `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`
  (Anchor 0.32.1). Live mainnet has **149 Task accounts** — so any `Task`/`ProtocolConfig`
  **layout** change is a real migration. **Batch 1 makes no layout change** (all new
  data lives in new PDAs); it is gated `#[cfg(not(feature = "mainnet-canary"))]` where new.
- **Status:** local commits only on branch `fix/bid-self-deal-guard`; nothing pushed.
- **Tests:** 225 Rust unit (`cargo test --lib`) + 35 litesvm integration
  (`cd tests-integration && node --test`). clippy `-D warnings` + `mainnet-canary`
  clippy clean; `anchor build` + `npm run artifacts:check` clean.
- **NOT in Batch 1 (gated by §11.5 human go/no-go + audit #2 + the 149-task migration):**
  symmetric 25/25 bonds, revision split (`request_changes`), RejectFrozen, operator
  fields on `Task`, dispute-path operator split. Do not review these as present.

---

## 1. Change inventory (commit → area)

| Commit | Area | Spec |
|--------|------|------|
| `efd26c5` | `record_listing_moderation` + listing-keyed `ListingModeration` PDA | §6 |
| `0397775` | hire-time moderation gate (fail-closed) | §6 |
| `62adc6e` | `create_task_humanless` (human buyer, pins CreatorReview) | §9 |
| `ffc45c5` | litesvm Auto-settlement harness (test infra) | — |
| `77eb549` | exit allow-list: `check_version_compatible_for_exit` on the 4 unwind paths | §7 |
| `8cea222` | anchor IDL/types artifact sync | — |
| `5227b08` | exit-safety extended to all 8 settle/finalize paths (money-never-locks) | §7 |
| `f916ba7` | 3-way fee split (worker/AgenC/operator) via `HireRecord` | §4 |
| `835cc02` | `accept_bid` requires a moderated `TaskJobSpec` | §6 |
| `9f5ddf1` | `close_task` reclaims child-PDA rent via `remaining_accounts` | §11 |
| `6e915d7` | **audit fix #1:** `complete_task` requires `hire_record` (operator-fee bypass) | §4 |
| `a93eec7` | **audit fix #2:** reject manual-validation reconfig of a hired task | §4 |
| `378075d`,`6753645`,`d17749a`,`0a8a9cc` | test hardening (manual-validation, moderation edges, negatives, dispute) | — |

SDK follow-up (separate repo `agenc-sdk`, branch `fix/hire-record-required-accounts`,
commit `941084b`, local only): `completeTask` + `configureTaskValidation` pass the
now-required `hire_record`; operator auto-resolved from the on-chain `HireRecord`.

---

## 2. Invariants & where they are enforced

- **Money conservation (3-way split).** `execute_completion_rewards`
  (`completion_helpers.rs`): `worker + protocol_fee + operator_fee == base`
  (reward-per-worker); rounding favors the worker; `operator_fee` is added to the SOL
  escrow-balance check and to `escrow.distributed`.
- **Worker floor / fee caps.** `calculate_operator_fee`: operator ≤ `MAX_OPERATOR_FEE_BPS`
  (2000) and worker ≥ `WORKER_FLOOR_BPS` (6000). Structurally, listing creation caps
  operator ≤ 20% and protocol ≤ 10% (`MAX_PROTOCOL_FEE_BPS`), so the worker is always
  ≥ 70%; the explicit floor is defense-in-depth.
- **Operator-fee can't be bypassed.** `complete_task` requires the seeds-fixed
  `["hire", task]` account; a live (program-owned) `HireRecord` forces the operator leg
  (`MissingOperatorAccount` / `InvalidOperatorAccount`). `configure_task_validation`
  rejects a live-hire task (`HiredTaskValidationUnsupported`) so it can't be re-routed
  to the (not-yet-hire-aware) manual path.
- **Moderation, entry-only (§6).** `hire_from_listing`, `accept_bid` (via a required
  moderated `TaskJobSpec`), and `set_task_job_spec` gate on a publishable attestation
  (CLEAN | HUMAN_APPROVED), risk ≤ 100, not expired, correct authority; `enabled=false`
  fails closed. Freshness checks are entry-only (never on settle/exit).
- **Money never locks (§7).** `check_version_compatible_for_exit` drops only the
  `protocol_paused` arm (keeps all version-range checks) and is applied to every
  unwind + settlement/finalize path (`cancel_task`, `expire_claim`, `resolve_dispute`,
  `expire_dispute`, `complete_task`, `complete_task_private`, `submit/accept/reject/
  auto_accept/validate_task_result`, `apply_dispute_slash`). Type-disable is entry-only
  (dropped from these paths). A pause stops only NEW entry; in-flight escrow always settles.
- **Anti-griefing.** `close_task` capacity decrement can't be skipped (required
  `hire_record`); child-PDA close binds each account by `owner == program` +
  recognized discriminator + `.task == task_key`; no-self-hire / no-self-bid; price+
  version compare-and-swap on hire.

---

## 3. Test coverage map (35 litesvm + 225 unit)

**Covered at runtime (litesvm):**
- Hire lifecycle: mint/escrow/HireRecord/capacity; hire→cancel→close; capacity cap;
  self-hire / price / version rejections. (#1-4)
- Moderation: record (authority vs not); hire gate (enabled, CLEAN, BLOCKED);
  publishable set CLEAN+HUMAN_APPROVED only (SUSPICIOUS/SCANNER_UNAVAILABLE/HUMAN_REJECTED
  rejected); risk-cap boundary; record validation (disabled/invalid-status/past-expiry);
  `set_task_job_spec` refuses non-publishable. (#5-11)
- Auto settlement (SOL 2-way) full flow. (#12)
- 3-way split: exact operator cut; 2-way fallback when no operator fee; max operator
  fee (20%) with worker ≥ 60%; settles while paused. (#14-16, #25)
- **Operator-fee protection:** can't complete a hired task without paying the operator
  (omit/forge → reject); can't re-route a hired task to manual validation. (#13, #20)
- Exit-safety while paused: complete, cancel, and the dispute paths all settle; new
  hires blocked.
- **SPL-token Auto settlement:** worker + treasury paid in tokens (conservation:
  worker + treasury == reward); token escrow ATA + escrow PDA closed.
- **Disputes (all paths, exit-safe while paused):** initiate; `expire_dispute`
  (permissionless last-resort); `resolve_dispute` (3-arbiter quorum, voting period
  elapsed); and `apply_dispute_slash` (creator-Refund dispute, staked arbiters approve
  → the losing worker's stake is slashed). Each settles/finalizes **while paused**.
- `accept_bid` moderation gate (with/without job spec). (#18-19)
- Manual validation (CreatorReview): submit→accept pays; reject doesn't settle;
  accept while paused. (#22-24)
- `create_task_humanless` creation + CreatorReview pin. (#21, #28)
- `close_task` children: reclaim moderation child; reject cross-task child; reject
  non-child program account; reject non-terminal. (#26, #30-32)

**Covered by unit tests only:** `calculate_operator_fee` math/cap/floor/rounding;
`check_version_compatible_for_exit` (paused-allowed, range still enforced, revert-sensitive);
`close_task` terminal-only guard; listing operator-fee invariant; version checks.

---

## 4. Residual test gaps (recommended before deploy)

| Gap | Risk | Why it's still open | Notes |
|-----|------|---------------------|-------|
| **`complete_task_private` (ZK)** | Low | Needs a remote prover; not litesvm-testable. | Exit-variant verified by unit test; same shared `execute_completion_rewards` exercised by the Auto + token tests. |
| **Collaborative multi-worker 3-way** | Low (unreachable) | Hire mints single-worker Exclusive tasks; the operator leg never applies to Collaborative. | Per-worker math is unit-tested. |
| **Token slash *reserve* leg** | Low | `apply_dispute_slash`'s SOL stake-slash path is tested (§3); the optional token-reserve settlement leg (token task + deferred token reserve) is not separately exercised. | Same instruction + guards; only the optional token accounts differ. A pre-audit note flagged the collaborative-token residual calc (`completion_helpers.rs`) - pre-existing, not Batch 1, worth a reviewer's eye. |

Resolved since the first draft (now have runtime tests, see §3): SPL-token settlement;
`resolve_dispute` (vote quorum); `apply_dispute_slash` (stake slash). What remains is
either un-litesvm-testable (ZK prover), structurally unreachable (collaborative operator
split), or a minor optional leg (token slash reserve).

Structurally-unreachable negatives (documented, not tested): wrong-task `hire_record`
(blocked by anchor seeds); worker-floor violation (caps keep worker ≥ 70%);
operator+token co-occurrence (operator legs are SOL-only hires).

---

## 5. Audit findings already fixed in this pass

1. **Operator fee dodge on `complete_task`** (fix `6e915d7`): `hire_record` was optional;
   a worker could omit it so the operator leg silently became `None`. Now required +
   live-detected; operator must be paid. Regression test #13.
2. **Operator fee dropped via manual re-route** (fix `a93eec7`): a hired task could be
   moved to manual validation (not hire-aware → operator unpaid). Now rejected. Test #20.

Both were surfaced by a 5-dimension / 7-confirmed pre-audit and verified by independent
review; each fix passed a 3-lens → 2-verifier adversarial review with 0 findings.

---

## 6. Design decisions an auditor should know

- **Pause = entry-control, not a settlement circuit-breaker.** A paused protocol still
  lets all in-flight escrow settle/unwind (so honest workers can't lose earned funds);
  it only blocks new entry. If a full settlement freeze is ever desired (e.g. an active
  exploit in payout code), it is a one-line-per-path revert (`_for_exit` → entry check);
  the program is upgradeable, so a payout-code exploit is better handled by a targeted
  upgrade. (Noted in `5227b08`.)
- **Batch 2/3 are §11.5-gated** (human go/no-go + audit #2 + 149-task migration) and are
  intentionally absent here.

---

## 7. Pre-deploy checklist

- [ ] Audit this Batch-1 surface (§1 commits).
- [ ] Note the remaining un-testable/unreachable items (§4: ZK prover, collaborative
      operator split, token slash-reserve leg). All primary money paths — settlement
      (SOL + token), the full 3-way split, and every dispute path
      (initiate/expire/resolve/slash) — are runtime-tested, including while paused.
- [ ] Land the SDK update (`agenc-sdk` branch `fix/hire-record-required-accounts`) so
      clients pass the now-required `hire_record`.
- [ ] Regenerate + verify artifacts (`npm run artifacts:refresh && npm run artifacts:check`).
- [ ] Confirm live `disabled_task_type_mask == 0`, `protocol_paused == false`, and a
      `ModerationConfig` exists + `enabled` (else marketplace halts).
- [ ] CU / account-count profile for the SPL 3-way path (LUT / versioned-tx) — Batch 2.
