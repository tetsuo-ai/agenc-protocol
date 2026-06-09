# Batch 1 — Audit Prep (embeddable marketplace)

Pre-audit map of the additive, no-migration Batch 1 of the embeddable-marketplace
work, for a professional security review **before any deploy**. Pairs with the full
plan in `docs/MARKETPLACE_EMBED_UPGRADE_SPEC.md`.

- **Program:** `agenc-coordination`, id `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`
  (Anchor 0.32.1). Live mainnet has **149 Task accounts** — so any `Task`/`ProtocolConfig`
  **layout** change is a real migration. **Batch 1 makes no layout change** (all new
  data lives in new PDAs); it is gated `#[cfg(not(feature = "mainnet-canary"))]` where new.
- **Status:** local commits only on branch `fix/bid-self-deal-guard`; nothing pushed.
- **Tests:** 225 Rust unit (`cargo test --lib`) + 36 litesvm integration
  (`cd tests-integration && node --test`). clippy `-D warnings` + `mainnet-canary`
  clippy clean; `anchor build` + `npm run artifacts:check` clean.
- **NOT in Batch 1 (gated by §11.5 human go/no-go + audit #2 + the 149-task migration):**
  symmetric 25/25 bonds, revision split (`request_changes`), RejectFrozen, operator
  fields on `Task`. Do not review these as present. (The operator leg on the dispute
  payout paths IS in Batch 1 — see audit fix #3 below; it is additive, no layout change,
  carved from the worker's gross via the existing `HireRecord` PDA.)

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
| _(this commit)_ | **audit fix #3:** carve the operator leg on the dispute payout paths (`resolve_dispute` Complete/Split, `expire_dispute` worker-payment) so a dispute can't bypass the §4 split | §4 |

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
  to the (not-yet-hire-aware) manual path. **The dispute payout paths** (`resolve_dispute`
  Complete/Split, `expire_dispute` worker-payment branches) also require the `["hire", task]`
  account and carve the operator leg from the worker's gross via the shared
  `pay_dispute_operator_fee` helper — so settling a hired task through a dispute cannot
  dodge the §4 split. Hires are SOL-only, so this is a lamport-only carve; the operator
  payee is validated against `hire.operator`, and a non-hired task (empty system-owned PDA)
  takes no operator leg.
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

## 3. Test coverage map (36 litesvm + 225 unit)

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
- **Operator-fee protection (dispute path):** a hired task resolved via `resolve_dispute`
  **Complete** pays the operator its exact cut and the worker the remainder (revert-sensitive:
  disabling the carve drops the operator to 0). The three pre-existing dispute tests
  (resolve-quorum, expire, apply_dispute_slash) thread the now-required `hire_record`.
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
3. **Operator fee bypassed via dispute settlement** (this commit): a hired task settled
   through `resolve_dispute` (Complete/Split) or `expire_dispute` paid the worker without
   carving the operator leg — only `complete_task` enforced it. Now all dispute payout
   paths require the `["hire", task]` account and carve the operator via the shared
   `pay_dispute_operator_fee` helper. Regression test added (operator paid on dispute
   Complete, revert-sensitive). Additive — no `Task`/`ProtocolConfig` layout change.

Findings #1–2 were surfaced by a 5-dimension / 7-confirmed pre-audit and verified by
independent review. Finding #3 was surfaced by a follow-up security-audit workflow; the
fix then passed a fresh 5-lens → independent-verifier adversarial audit with **0 findings**.

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

---

# Batch 2 & 3 — added by the autonomous build (2026-06-08)

> Local only — branch `fix/bid-self-deal-guard`, nothing pushed/deployed. Batch 2 is a
> Task LAYOUT change + a 149-task migration: it is **§11.5-gated** and requires audit #2
> + the migration choreography before any mainnet deploy.

## Batch 2 — operator economics on `Task` + migration

| Commit | Area |
|--------|------|
| `133a4c5` | `Task` append-only +`operator`/`operator_fee_bps`/`_reserved[16]` (382→432B); `OLD_TASK_SIZE`=382, `const_assert(SIZE==432)`, `validate_reserved_fields` |
| `4880eb4` | operator stamped onto `Task` at hire; settlement readers Task-first w/ HireRecord fallback; brick-safe parent-task prefix read; `operator!=creator` guard |
| `da3e858` | `migrate_task(dry_run)` — multisig-gated, version-ungated, raw account, realloc+zero-fill, rent top-up, idempotent |

- **No `ProtocolConfig` layout change** (deliberately deferred — it's loaded as a typed
  account by every instruction, so growing it would deadlock the deploy/migration).
- Deploy/migration order is **binary-first → migrate all 149 → version-bump last**
  (reverse bricks via the version gate). `migrate_task` is version-ungated for this.

## Batch 3 — completion bonds + revisions + RejectFrozen

| Commit | Area |
|--------|------|
| `a4016ff` | `CompletionBond` PDA + `post_completion_bond` (25%, Exclusive+SOL v1, init dup-prevent) |
| `d822ed7` | `settle_completion_bond` helper + `expire_claim` no-show forfeit (worker→creator) |
| `6ad4d7c`,`a06386d`,`4f14e03`,`2f39d53` | bond refund/forfeit wired into complete / accept / auto-accept / cancel / resolve_dispute / expire_dispute |
| `be698f1` | audit: `post_completion_bond` rejects ZK-private tasks (would strand on complete_task_private) |
| `efbe7dd` | audit: permissionless `reclaim_completion_bond` for bonds stranded by an omitted exit account |
| `a6a5f6f`..`9235fad` | `RejectFrozen`: status+transitions, sticky-freeze sync, `request_changes`/`reject_and_freeze`, `resolve_reject_frozen`(multisig)/`expire_reject_frozen`(timeout) exits, dispute mutual-exclusion, gate negatives |
| `a638ee1`,`89cc77d` | final-audit fixes: freeze is Exclusive-only (no Collaborative escrow stranding); accurate expire payout event; required seeds-fixed bonds in `resolve_reject_frozen` |

- All Batch-3 code is `#[cfg(not(feature = "mainnet-canary"))]` (the conservative
  mainnet-canary build does not expose bonds / RejectFrozen, so a canary task can never
  reach a state without an exit).
- Bonds are **single-worker (Exclusive) SOL-only v1**; operator-leg + SPL bonds deferred.

## Adversarial audits run (all multi-lens → independent verifiers)

| Audit | Surface | Result |
|-------|---------|--------|
| pre-audit + dispute fix | Batch 1 + operator-fee dispute bypass | findings fixed; re-audit 0 |
| `wy4dkre1z` | Batch 2 (layout + readers + migration) | **0 confirmed** |
| `w51bg7quf` | full bond lifecycle | 3 confirmed (HIGH/MEDIUM/LOW) — **all fixed** (`be698f1`,`efbe7dd`) |
| `w494fwy0p` | RejectFrozen lifecycle | 3 confirmed — MEDIUM + 1 LOW **fixed** (`a638ee1`); 1 LOW fixed in new code + twin documented (`89cc77d`) |

## Known residual (for the external audit / follow-up hardening)

- **`resolve_dispute` optional-bond omission (LOW, trusted-resolver).** Same shape as the
  `resolve_reject_frozen` issue fixed in `89cc77d`: on the Complete branch (worker wins)
  the creator bond is forfeited to treasury, but the bond account is `Option`, so a
  resolver that omits it lets the creator later `reclaim_completion_bond` it (treasury
  revenue leak). Trigger requires the trusted dispute resolver to omit the account; the
  SDK passes it. Fix path: make `resolve_dispute`'s creator bond required+seeds-fixed
  (anchor `accountsPartial` auto-derives it) + a required `bond_treasury`, mirroring
  `resolve_reject_frozen`. Not user-exploitable; deferred with this note.

## Test counts (final)

- **231 Rust unit** (`cargo test --lib`) + **54 litesvm integration** (`cd tests-integration && node --test`).
- clippy `--lib -D warnings` + `--features mainnet-canary` clean; `anchor build` +
  `npm run artifacts:check` clean at every commit.

## Gates STILL required before any mainnet deploy (unchanged)

1. **§11.5 human go/no-go** (demand thesis + SDK slice + success signal) — owns Batch 2/3.
2. **Professional external audit** of the full Batch 1–3 surface (+ the `resolve_dispute`
   residual above).
3. **The 149-task migration choreography** (binary-first → migrate → version-bump),
   irreversible — multisig/upgrade-authority gated.
4. SDK update so clients pass the new required accounts (`hire_record` already; the
   completion-bond accounts on settlement paths).
