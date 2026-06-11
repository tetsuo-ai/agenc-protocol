# Batch 1–4 — Audit Prep (embeddable marketplace)

> **Filename note.** This file is retained at the historical path
> `docs/BATCH_1_3_AUDIT_PREP.md` (it is cross-linked from `README.md`, `CLAUDE.md`,
> and `PLAN.md`) but its scope is now **Batch 1 through Batch 4 (Phase 6)**. The
> Batch 4 section is at the end (["Batch 4 — Phase 6"](#batch-4--phase-6-embeddable-economics--trust-2026-06-10)).
> For the consolidated auditor entry point, see
> [`docs/audit/AUDITOR_HANDOFF.md`](audit/AUDITOR_HANDOFF.md).

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
| `bf1222f` | final hardening: required + canonical-pinned completion bonds in `resolve_dispute`/`expire_dispute` (closes the optional-bond omission + its permissionless-stranding twin) |

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
| `w494fwy0p` | RejectFrozen lifecycle | 3 confirmed — MEDIUM + 1 LOW **fixed** (`a638ee1`); 1 LOW fixed in new code + twin (`89cc77d`) |
| dispute-bond follow-up | `resolve_dispute` / `expire_dispute` bond disposition | 1 LOW + 1 same-class twin — **both fixed** (`bf1222f`); 0 open |
| `wltxprh2y` | **docs-grounded** Solana/Anchor correctness (8 dims, each read the official docs first) | 6 dims clean; 2 LOW — **both fixed** (`8e00f67`); 0 open |

## Final hardening — dispute completion bonds (commit `bf1222f`, RESOLVED)

The last open finding and its twin are now **fixed** (no open findings remain):

- **`resolve_dispute` optional-bond omission (was LOW, trusted-resolver).** On the
  Complete branch (worker wins) the creator bond is forfeited to treasury, but the bond
  accounts were `Option`, so a resolver could omit the forfeit-due bond; the creator
  could then `reclaim_completion_bond` it on the now-Completed task (forfeit inverted →
  treasury revenue leak). **Fixed:** the bond accounts (creator/worker bond + `bond_treasury`)
  are now **required**, and each is **pinned to its canonical PDA in-handler**.
- **`expire_dispute` optional-bond stranding (same class).** `expire_dispute` is
  **permissionless** and always Cancels the task, and a posted bond is recoverable only
  here (`reclaim_completion_bond` needs `Completed`). With `Option` bonds, any caller could
  omit a bond and **strand it forever** on the Cancelled task. **Fixed:** both bonds are now
  required + canonical-pinned (both always refunded; no treasury needed — there is no
  forfeit branch).
- **Why "required" alone was not enough.** `settle_completion_bond` no-ops on any
  non-program-owned account, so a required-but-seedless `UncheckedAccount` could still be
  defeated by passing a junk (system-owned) account to skip the settle. `worker_wallet` is
  `Option` on these paths (anchor `seeds` can't cleanly reference it), so the canonical-PDA
  pin is a handler `require!` rather than an anchor `seeds=` constraint — equivalent guarantee.
  Un-bonded tasks still pass (canonical address, no account → settle no-ops).
- **Regression test (revert-sensitive):** `resolve_dispute rejects a non-canonical (junk)
  forfeit-due bond account` — proven red with the creator pin neutralized (the junk-account
  resolve succeeded and skipped the forfeit), green with the pin restored. The 4 dispute
  litesvm call sites now pass the seeds-derived bond PDAs.

## Solana/Anchor docs-grounded correctness audit (`wltxprh2y`, commit `8e00f67`)

8 dimensions, each agent first read the **current official Solana/Anchor docs** for its
topic (verified against Anchor 0.32.1) then audited the code; every finding was adversarially
verified against docs + code. **6 dimensions clean** (account resize/rent on the migration,
close/revival tombstone, PDA + bump canonicalization, owner/type-cosplay on UncheckedAccounts,
signer auth/multisig, optional-account resolution). **2 LOW findings — both fixed:**

- **`execute_proposal` TreasurySpend rent floor (program-owned treasury).** The direct
  lamport debit only checked `balance >= amount`; a partial spend landing in `(0, rent_min)`
  is a disallowed RentExempt→RentPaying transition the runtime rejects (`InsufficientFundsForRent`),
  so a governance-approved spend was silently unexecutable. **Fixed:** require post-balance
  `== 0` (runtime-permitted full-drain close) **or** `>= rent_floor`, clear
  `TreasuryInsufficientBalance` error; logic in a pure `treasury_spend_preserves_rent()` with a
  **revert-sensitive unit test** (red when the full-drain arm is dropped).
- **Release `overflow-checks` disabled.** No `[profile.release] overflow-checks = true`, so the
  Rust default (false) applied to the deployed SBF program — any non-checked integer op would
  silently wrap. All money paths already use checked arithmetic; this adds the doc-recommended
  second layer. **Fixed** in `Cargo.toml` (verified honored: full rebuild, no "profiles ignored"
  warning).

## Instruction coverage audit + closure (`wwbj8t0s0` matrix → `wjci30gsx` build)

A per-instruction coverage matrix (every one of the 77 IDL instructions: implemented?
+ tested by what?) found the program **100% implemented** (zero stubs) but only 37/77
meaningfully tested — 40 instructions had no automated test, including critical
settlement paths (`validate_task_result`, `auto_accept_task_result`, `create_dependent_task`,
`apply_initiator_slash`). That gap is now **closed**: 94 new litesvm tests across 8
subsystem files (admin-config, reputation, skills, governance, bid-extra, agent-social,
task-extra, listing-mod-dispute), each with a real-effect positive assertion and a
guard negative; authored by an orchestrated workflow, each file self-verified green and
independently reviewed for meaningfulness (revert-sensitivity probed).

Coverage now: **72/77 instructions exercised directly in litesvm.** The remaining 5 are
covered otherwise or are structurally not litesvm-testable: `complete_task_private` (needs
a ZK prover), `execute_proposal` / `migrate_protocol` / `update_launch_controls` (Rust unit
tests), and `initialize_protocol` (runs in every harness setup; its real initializer needs
the upgradeable ProgramData account litesvm does not model — hence the inject helper).

## Test counts (final)

- **232 Rust unit** (`cargo test --lib`) + **149 litesvm integration** (`cd tests-integration && node --test`) — was 55; +94 closing the coverage gap.
- clippy `--lib -D warnings` + `--features mainnet-canary` clean; `anchor build` +
  `npm run artifacts:check` clean at every commit.

## Gates STILL required before any mainnet deploy (unchanged)

1. **§11.5 human go/no-go** (demand thesis + SDK slice + success signal) — owns Batch 2/3.
2. **Professional external audit** of the full Batch 1–3 surface. All findings from the
   internal adversarial audits are fixed (0 open); this is independent confirmation, not
   a fix-list.
3. **The 149-task migration choreography** (binary-first → migrate → version-bump),
   irreversible — multisig/upgrade-authority gated.
4. **SDK update** so clients pass the new required accounts. `hire_record` is wired
   (`agenc-sdk` `941084b`). **Still TODO on `agenc-sdk` (branch `fix/hire-record-required-accounts`):**
   `resolveDispute`/`expireDispute` must sync the new IDL and pass the now-required
   completion-bond accounts — `creatorCompletionBond` = PDA`["completion_bond", task, creator]`,
   `workerCompletionBond` = PDA`["completion_bond", task, workerAuthority]`, and (resolve only)
   `bondTreasury` = `protocolConfig.treasury`. The SDK currently has **no** completion-bond
   support at all, so these calls will fail against the hardened program until wired.

---

# Batch 4 — Phase 6 (embeddable economics + trust, 2026-06-10)

> Local only — nothing pushed/deployed. Phase 6 is **two layout migrations** (a
> per-`Task` realloc 382/432→466B AND a `ProtocolConfig` realloc 349→351B), so it is
> **§11.5-gated** exactly like Batch 2/3 and requires the external audit + the migration
> choreography below before any mainnet deploy. The full surface is **82 IDL
> instructions** (the spec's "80-instruction surface" plus the two `bid_book` /
> `bid_marketplace` initializers and `update_min_version`; `vote_dispute` was **retired**,
> P6.3); the live **mainnet-canary surface stays at 25** (enforced by
> `scripts/check-canary-idl.mjs`), and the referrer 4th leg is **fail-closed on canary**
> (see the canary referrer guard below).

## 1. Change inventory (Phase 6)

| ID | Commit | Area | Layout? |
|----|--------|------|---------|
| **P6.1** | `f7f42bf` | `rate_hire` + `HireRating` PDA (`["hire_rating", task]`): makes the dead `ServiceListing.total_rating`/`rating_count` live; buyer-only, terminal-`Completed`-only, one-per-hire (`init`), score `1..=5`, bounded `review_uri`. Listing aggregate updated; provider rollup emitted via `ListingRated` for the P6.6 backfill. | No (new PDA + writes pre-allocated `ServiceListing` fields) |
| **P6.2** | `0d927f6` | Referrer (demand-side embedder) **4th settlement leg** + the `Task`/`HireRecord` realloc that snapshots `referrer`/`referrer_fee_bps`. Shared `calculate_combined_fees` carves operator+referrer in ONE combined-cap calc; SOL-only; rejected on token tasks. | **YES — `Task` 382/432 → 466B; `HireRecord` append-only** |
| **P6.3** | `f7f42bf` | **Retire `vote_dispute`**: instruction removed; `resolve_dispute`/`expire_dispute` no longer take `(vote, arbiter)` pairs; `MAX_DISPUTE_VOTERS` left unreferenced for API stability. | No |
| **P6.4** | `f7f42bf`, `1ed851a` | **Accountable disputes**: `resolve_dispute` requires a reasoned ruling (`rationale_hash: [u8;32]` mandatory by type + bounded `rationale_uri`); the deciding resolver + hash are persisted and emitted in `DisputeResolved`. Assigned-resolver case counters (`resolved_count`/`last_resolved_at`) bumped on `DisputeResolver`. (Challenge-window design approved; BUILD DEFERRED until real dispute volume — `docs/DISPUTE_CHALLENGE_WINDOW.md`.) | No |
| **P6.5** | `0d927f6` | `ProtocolConfig.surface_revision: u16` (append-only, after `multisig_owners`) + the `migrate_protocol` realloc 349→351B; `SURFACE_REVISION_FULL = 1`; SDK `getDeployedSurface`. | **YES — `ProtocolConfig` 349 → 351B** |
| **P6.6** | `f7f42bf` | `AgentStats` PDA (`["agent_stats", agent]`): negative/non-success counters (`tasks_rejected`, `disputes_won`, `disputes_lost`, `claims_expired`, `total_cancelled`) that don't fit `AgentRegistration`'s reserved bytes. **Telemetry, never gates settlement** — passed OPTIONALLY, `init_if_needed` on first write, no-op when absent. | No (new optional PDA) |
| **P6.7** | `1ed851a` | **Sybil / reputation-reset deterrent**: fresh-agent reputation `5000 → 3000` (`PROBATIONARY_REPUTATION`); `min_agent_stake` default `0 → 1_000_000` lamports (`MIN_REASONABLE_STAKE`, fresh inits only). | No (new-`init` value change) |
| **P6.8** | `f7f42bf` | **Attestor registry** (`assign_moderation_attestor`/`revoke_moderation_attestor` + `ModerationAttestor` PDA `["moderation_attestor", attestor]`): the moderation authority deputizes additional attestors; mirrors the dispute-resolver roster. **Registry mechanism only** — the neutrality posture decision is `docs/MODERATION_NEUTRALITY.md`. | No (new PDA) |
| **review fix** | `d1b4b82` | Phase-6 money-path/migration review fixes (the 2 majors below): `migrate_task` decoupled from `migrate_protocol` ordering + the canary referrer guard. | No |
| **SDK** | `d4f7d7f` | `@tetsuo-ai/marketplace-sdk 0.5.0` — Phase 6 client surfaces (`rateHire`, referrer-aware settlement accounts, `getDeployedSurface`, agent-stats/attestor/resolver helpers). | — |

PR #47 (2026-06-09, `708e67f`) — the **assignable dispute-resolver roster**
(`assign_dispute_resolver`/`revoke_dispute_resolver`) + `hire_from_listing_humanless` —
is the substrate P6.4 builds on; the single-resolver model **replaced** the
vote+quorum design (see `docs/audit/THREAT_MODEL.md` and `CLAUDE.md`).

## 2. NEW invariants (Phase 6) & where they are enforced

- **4-way split conserves exactly.** `execute_completion_rewards` +
  `calculate_combined_fees` (`completion_helpers.rs`): for a SOL settlement,
  `worker + protocol_fee + operator_fee + referrer_fee == base` to the lamport; each
  fee leg is floored independently so the **worker keeps all rounding dust**; operator
  and referrer legs are added to the escrow-balance check and to `escrow.distributed`.
  Both legs are gated `operator_active || referrer_active`, so a non-referred,
  non-hired task is **byte-for-byte the 2-way path** (zero behavioral change for the
  149 live tasks). Runtime-proven: `referral-fee.test.mjs` —
  `"4-way split … paid to the lamport"` asserts
  `protocol + operator + referrer + worker == reward`, and
  `"REFERRER-ONLY … protocol + referrer + worker conserves exactly"` the 3-way subset.
- **The 4000-bps combined cap (binding worker floor).** `MAX_COMBINED_FEE_BPS = 4000`
  and `WORKER_FLOOR_BPS = 6000` (`4000 + 6000 == 10000`). `calculate_combined_fees`
  rejects `protocol + operator + referrer > 4000 bps` (`CombinedFeeAboveCap`) in **bps,
  before any lamport math**, so the worker ALWAYS keeps ≥ 60%. The SAME cap is enforced
  at snapshot time (`resolve_referrer_snapshot`, at hire/create) so a bad referral
  fails at task creation, not only at settlement. Per-leg ceilings
  (`MAX_OPERATOR_FEE_BPS`/`MAX_REFERRER_FEE_BPS = 2000`) are defense-in-depth; the
  combined cap is the binding invariant. Runtime: `"COMBINED CAP … exceeds 4000 bps is
  rejected"`, `"REFERRER OVER PER-LEG CAP"`.
- **Referrer no-self-deal + SOL-only + no-silent-drop.** `resolve_referrer_snapshot`:
  `referrer != creator` (`ReferrerIsCreator`); a non-zero fee with a default/absent
  payee is rejected (`MissingReferrerAccount`) so args can't silently drop the fee; a
  referrer fee on a token-denominated task is rejected at creation (`create_task`,
  SOL-only). Settlement re-binds the supplied payee to the snapshot
  (`build_referrer_leg`: `InvalidReferrerAccount`), so a worker cannot dodge or redirect
  the leg. Runtime: `"REFERRER SELF-DEAL"`, `"REFERRER PROTECTION … cannot be completed
  without paying the referrer"`, `"SPL path … referrer fee is rejected"`.
- **Migration old-size preconditions + append-only layouts.**
  - `classify_task_migration` (`migrate.rs`) accepts **only** `Task::OLD_TASK_SIZE`
    (382, the 149 live tasks) **or** `Task::BATCH2_TASK_SIZE` (432) as a realloc
    precondition; `>= Task::SIZE` (466) is idempotent no-op; **everything else
    (incl. the 433–465 gap) is rejected** (`TaskNotMigratable`) so a corrupt/unexpected
    account is never grown. `const_assert(Task::SIZE == 466)`; the appended tail is
    **explicitly zero-filled** (operator/referrer payees → default, fees → 0) regardless
    of `resize`'s zero-init semantics. Append-only: the legacy 382B prefix is unchanged,
    so the migrated account deserializes the new fields as defaults.
  - `classify_config_migration` accepts **only** `OLD_CONFIG_SIZE` (349) or
    `>= SIZE` (351, idempotent); `350` (the in-between byte) is **rejected** so
    `surface_revision` can't be corrupted; `const_assert` the size; the appended 2 bytes
    are zero-filled (`surface_revision` reads `0` = unstamped until an operator declares
    it).
  - `is_valid_surface_revision` accepts only `0` or `SURFACE_REVISION_FULL` (1) — an
    operator cannot stamp a surface the SDK doesn't understand. Unit-tested
    (`migrate.rs` tests: old-size→realloc, new-size→idempotent, `350`/`433..465`/`348`
    rejected, surface-revision bounds).
- **Canary referrer guard (fail-closed on the live surface).**
  `require_canary_referrer_disabled` (`task_init_helpers.rs`) under
  `#[cfg(feature = "mainnet-canary")]` requires `referrer.is_none() &&
  referrer_fee_bps == 0` in `create_task` (a canary instruction), mirroring the existing
  canary `reward_mint`/`constraint_hash` rejections. Guarantees **every canary task has
  `referrer == default`**, so the unaudited 4th leg can never route money on the live
  mainnet surface until Phase 9 / audit. Unit-tested under the `mainnet-canary` cfg
  (`create_rejects_nondefault_referrer_on_canary`, revert-proven; canary unit count
  212 → 214).
- **Probationary-reputation / min-stake sybil invariant.** `register_agent.rs`:
  `PROBATIONARY_REPUTATION = 3000`, and a **compile-time** `const_assert(
  PROBATIONARY_REPUTATION < INITIAL_REPUTATION − REPUTATION_SLASH_LOSS)` — i.e. a fresh
  agent (3000) sits strictly below what a once-slashed veteran retains (5000 − 300 =
  4700), killing the wipe-and-re-register inversion. `min_agent_stake` default raised to
  `MIN_REASONABLE_STAKE` (1_000_000 lamports) so a fresh identity costs slashable stake.
  3000 ≥ the `min_reputation == 0` that essentially all real tasks use, so honest new
  agents are **not** locked out (supply isn't starved). Revert-sensitive unit tests in
  `register_agent.rs`. **Scope caveat:** these apply to **fresh `initialize_protocol`**
  (devnet/localnet/new deploys); there is currently **no on-chain path to raise
  `min_agent_stake` on the already-live mainnet config** (only `initialize_protocol`
  sets it; `update_launch_controls` can't) — a deliberate governance follow-up. The
  reputation fix DOES apply to mainnet on the next deploy. See P6.7 in `PLAN.md`.

## 3. Adversarial reviews run (Phase 6) + resolution

| Review | Surface | Result |
|--------|---------|--------|
| Phase-6 money-path / migration review (`d1b4b82`) | the P6.1–P6.8 money paths + the two migrations | **2 confirmed majors — both fixed** (0 fund-loss; 8 findings refuted) |
| P6.7/P6.8/P6.4 decision pass (`1ed851a`) | sybil deterrent + neutrality/challenge-window posture | sybil deterrent BUILT (revert-sensitive tests); two posture decisions recorded as docs (1 finding reported, see below) |

**The two confirmed majors (`d1b4b82`), both fixed:**

1. **`migrate_task` was hard-coupled to `migrate_protocol` ordering.** Its typed
   `Account<ProtocolConfig>` could not deserialize the **live 349B** config (the struct
   is now 351B) until `migrate_protocol` grew it — so a tasks-first sweep would fail
   **opaquely** (`AccountDidNotDeserialize`) on the *irreversible* mainnet migration.
   **Fix:** `MigrateTask.protocol_config` is now `UncheckedAccount` + size-tolerant
   hand-validation (owner, canonical `["protocol"]` PDA, zero-pad-to-`SIZE` deserialize)
   mirroring `migrate_protocol`, so the two migrations are **order-independent**. A
   litesvm test runs `migrate_task` against a 349B config (revert-proven:
   `AccountDidNotDeserialize` against the old typed account). `docs/VERSIONS.md`
   documents `migrate_protocol` as the mandatory **first** post-deploy call.
2. **The referrer 4th leg leaked onto the live mainnet-canary surface.** `create_task`
   (a canary instruction) accepted referrer args and would pay the 4th leg on the
   restricted live surface — **unaudited money-routing**. **Fix:**
   `require_canary_referrer_disabled` fails it closed on the canary build (see the
   canary referrer guard invariant above). Canary unit 212 → 214 (revert-proven).

**Reported-not-built (deliberate, tracked):** no on-chain instruction raises
`min_agent_stake` on the *already-live* config (the stake deterrent applies to fresh
deploys only until a governance follow-up adds the setter). Authority-scoped slash
history (sybil option 3) and the dispute challenge-window (`docs/DISPUTE_CHALLENGE_WINDOW.md`)
are **design-approved, build-deferred** until there is real dispute/abuse volume.

## 4. Test counts (Phase 6, HEAD)

- **300 Rust unit** (`cargo test --lib` — verified green this pass) + **219** under the
  `--features mainnet-canary` build (both re-run green this pass; the `d1b4b82` commit's
  295/214 grew with the P6.7 tests in `1ed851a`); **198 litesvm** (`cd tests-integration && node
  --test`, incl. `referral-fee`, `rate-hire`, `agent-track-record`,
  `surface-versioning`, `moderation-attestor`/`security-attestor`,
  `dispute-accountable-ruling`, `dispute-vote-retired`); **~390 SDK** (`marketplace-sdk
  0.5.0`).
- clippy `--lib -D warnings` + `--features mainnet-canary` clean; `anchor build` +
  `npm run artifacts:check` clean; `npm run canary:check-idl` confirms the live surface
  is **exactly 25 instructions**; full IDL is **82**.

## 5. Residual deploy gates (Phase 6, unchanged in spirit from Batch 2/3)

1. **§11.5 human go/no-go** — owns the whole embeddable track incl. Phase 6.
2. **Professional external audit** of the **full 82-instruction surface + both
   migrations** (`migrate_protocol` realloc + the per-`Task` `migrate_task` realloc).
   All internal adversarial findings are fixed (0 open); this is independent
   confirmation. **[HUMAN: commissions]** — see `docs/audit/AUDITOR_HANDOFF.md`.
3. **The migration choreography (now TWO reallocs), irreversible, multisig-gated:**
   **binary-first → `migrate_protocol` (config 349→351B) FIRST → `migrate_task` sweep
   over all 149 tasks (382/432→466B), `dry_run` across all 149 first → version-bump
   LAST.** Reverse order bricks in-flight paths via the version gate; both migrations
   are version-ungated and idempotent for this reason. `migrate_protocol` is the
   mandatory first post-deploy call (`docs/VERSIONS.md`).
4. **SDK + client updates** for the new required/optional accounts (referrer payee on
   settlement; `migrate_task` no longer needs the config pre-grown). `marketplace-sdk
   0.5.0` carries the Phase-6 surfaces; confirm the referrer-aware settlement accounts
   are threaded by integrators.
5. **Canary stays at 25 + referrer fail-closed.** Do not widen the canary surface or
   lift `require_canary_referrer_disabled` without the audit + explicit intent
   (Phase 9).
6. **Sybil min-stake governance follow-up** — add an on-chain setter for
   `min_agent_stake` so the stake deterrent reaches the *live* mainnet config (the
   reputation half already applies on deploy).
