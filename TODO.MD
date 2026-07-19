# TODO — Security Fixes (Audit Pass 3, `fix/audit-findings-2026-07-16`)

> **Completed historical remediation record.** All F-1–F-19 items in this
> document are closed. The constraints and branch-relative commands below
> describe that 2026-07-16/17 campaign; they are retained as audit evidence and
> are not the current work queue. Current candidate state and validation live in
> `fixme.md`, `docs/ENTERPRISE_READINESS.md`, and `docs/VALIDATION.md`.

Source: final audit report on `d7f9d40` vs `07c2891`. Every item below was
verified firsthand against executable code. Ordered by priority. Each entry has:
problem, evidence, exploit/failure scenario, the required change, pitfalls,
tests, and a "done when" checklist. Do not mark an item done while any of its
"done when" boxes are unchecked.

## Global constraints (apply to EVERY fix)

- **No account-layout change**: no field add/remove/reorder/retype in any
  `#[account]` struct; no `SIZE`/`space`/discriminator/const-assert changes.
  `git diff main...HEAD -- programs/agenc-coordination/src/state.rs` must stay empty.
- **Error enum append-only**: new `CoordinationError` variants go at the END
  (next codes 6356+). Never reorder/retitle existing variants.
- **Canary freeze**: these 25 instructions have FROZEN account lists/args —
  do not add/remove/flip accounts on them:
  `accept_task_result, cancel_task, claim_task_with_job_spec,
configure_task_moderation, configure_task_validation, create_task,
deregister_agent, expire_claim, initialize_protocol, migrate_protocol,
migrate_task, record_task_moderation, register_agent, reject_task_result,
set_task_job_spec, submit_task_result, suspend_agent, unsuspend_agent,
update_agent, update_launch_controls, update_min_version, update_multisig,
update_protocol_fee, update_rate_limits, update_treasury`.
  Handler-logic changes on these are fine. Account-list changes are only
  allowed on NON-canary instructions (full surface), and the SDK must be
  updated in the same PR.
- `remaining_accounts` additions are always allowed (not in the IDL).
- Regenerate after ANY program change: `anchor build`, `npm run artifacts:refresh`,
  `cd packages/sdk-ts && npm run sdk:generate` (commit `src/generated`).
- Gates that must be green before merging any fix:
  `cargo test --lib --manifest-path programs/agenc-coordination/Cargo.toml`,
  `cargo clippy --lib ... -- -D warnings` (default AND `--features mainnet-canary`),
  `cd tests-integration && node --test` (against a FRESH `.so` — `anchor build` first),
  `cd packages/sdk-ts && npx tsc --noEmit && npm test && npm run sdk:drift`,
  `npm run artifacts:check && npm run canary:check-idl`.
- Tests must be revert-sensitive: mentally (or actually) revert the source hunk
  and confirm the test goes red. Unit tests for predicates; litesvm integration
  tests for handler wiring on money paths.

---

## P0 — Blockers for the revision-5 production (98-ix) deploy

> **ALL P0 ITEMS DONE (2026-07-18)** — F-1 `4b70630`, F-2 `aa6aae5`, F-3
> `cc8870e`, F-5 `b3eb824` (F-6 closed by on-chain verification). The current
> repository gates (Rust profiles, compiled-program integration, SDK/workspace,
> deployment rails, artifacts, canary freeze, and IDL reference drift) must all
> be green at the release commit. Deploy choreography for this upgrade
> package: wire changes are `apply_initiator_slash` (task account removed),
> `cancel_task` / `expire_reject_frozen` (bond accounts optional → required),
> `reclaim_terminal_claim` / `apply_dispute_slash` (writable flags) — all
> non-canary. Deploy = multisig binary upgrade → account sweep/config init →
> publish + fetch-verify the reviewed compact on-chain IDL → final atomic
> `stamp_release_surface` revision-5 boundary → coordinated SDK/package minor
> releases.

### [x] F-1 — `cancel_task` no-show bond forfeit must be bound to the live no-show claimant (HIGH, full-surface)

- **RESOLVED 2026-07-18 (commit `4b70630`)**: the forfeit now requires the bond
  wallet to be one of the live claim triples' rent-recipient wallets (each
  constrained `== worker.authority`); new error 6356 `BondNotTiedToNoShowWorker`.
  litesvm: exploit chain rejected; legit live no-show forfeit still works; the
  rejected worker reclaims on the terminal task (`bond-forfeit-binding.test.mjs`).
- **Problem** (original entry): on a no-show cancel, the forfeited worker bond
  is whichever bond PDA the caller passes — not provably the bond of the worker
  who actually no-showed. A creator can forfeit an honest, already-rejected
  worker's bond.

- **Problem**: on a no-show cancel, the forfeited worker bond is whichever bond
  PDA the caller passes — not provably the bond of the worker who actually
  no-showed. A creator can forfeit an honest, already-rejected worker's bond.
- **Evidence**: `post_completion_bond.rs:76-80` (any non-creator can post a
  worker bond; keyed `["completion_bond", task, wallet]`; survives claim
  closure); `cancel_task.rs:96-102` (bond + wallet are optional, seedless
  `UncheckedAccount`s, no signer); forfeit at `cancel_task.rs:591-611` keyed
  only on `is_no_show_cancel`. `reclaim_completion_bond` needs a terminal task,
  so the victim cannot self-rescue beforehand.
- **Exploit**: W claims, posts 25% bond, submits → creator rejects (claim
  closed, task reopens, bond hostage) → creator sybil V claims, never delivers →
  past deadline `cancel_task` (`completions == 0` ⇒ `is_no_show_cancel`) with
  W's bond PDA + W's wallet → W's bond to the creator.
- **Required change** (handler-logic only — `cancel_task` is on the frozen
  canary 25, NO account-list change): mirror the `expire_claim.rs:463-484`
  pattern. When `is_no_show_cancel` and a worker bond is to be forfeited, derive
  the expected bond PDA from the LIVE no-show claim's worker authority (already
  available: the claim triples in `remaining_accounts` — `rent_recipient` is
  constrained `== worker.authority`), and `require!` the passed
  `worker_completion_bond == that PDA` and `worker_bond_authority == that
worker's authority`. Multi-worker (Collaborative) no-shows: forfeit is only
  valid for a bond owned by one of the drained live claims; otherwise refund.
- **Pitfalls**: do NOT add required accounts (canary freeze). Do not bind to
  `claim.worker` (agent PDA) — bind the wallet authority. Keep the Open-cancel
  and C-1 zero-worker refund paths byte-identical (bonds refund there).
- **Tests**: unit — forfeit-binding predicate (matching/mismatched authority).
  Integration — the full F-1 exploit chain must now fail at the forfeit; honest
  no-show forfeit still works; rejected-worker's bond still refundable via
  `reclaim_completion_bond` after cancel.
- **Done when**: [ ] binding implemented [ ] exploit test red [ ] legit forfeit
  test green [ ] canary IDL unchanged [ ] all gates green.

### [x] F-2 — `close_task` must not brick slash finalizers (HIGH, full-surface)

- **RESOLVED 2026-07-18 (commit `aa6aae5`)**: (1) `apply_initiator_slash` no
  longer loads the Task account (IDL account removal, backward-compatible);
  (2) `resolve_dispute` keeps `current_workers == 1` while a worker slash is
  pending, so `close_task`'s guard blocks the brick atomically;
  (3) `apply_dispute_slash` frees the slot when it closes the claim (task now
  `mut` — the decrement was silently discarded without it);
  (4) `reclaim_terminal_claim` refuses a slash-pending deferred claim when the
  bound dispute is supplied (new error 6357 `ClaimSlashPending`).
  litesvm: `slash-finalizer-close-race.test.mjs`.
  **FOLLOW-UP RESOLVED 2026-07-18 (commit `8ca868d`)**: the Task now records a
  durable pending-worker-slash bit in its reserved schema. Because the Task is a
  required `reclaim_terminal_claim` account, the reclaim guard reads that bit
  directly and is omission-proof; callers can no longer hide slash debt by
  omitting a Dispute remaining account. The dedicated slash finalizer clears the
  bit only after revalidating and settling the bound claim.
- **Problem** (original entry): immediately after `resolve_dispute`, the task
  meets every `close_task` precondition. Destroying the Task PDA permanently
  bricks `apply_dispute_slash` and `apply_initiator_slash`.

- **Problem**: immediately after `resolve_dispute`, the task meets every
  `close_task` precondition (terminal, `current_workers == 0`, bonds settled).
  Destroying the Task PDA permanently bricks `apply_dispute_slash` and
  `apply_initiator_slash` (both hard-require it): (a) worker's
  `disputes_as_defendant` never clears → entire reputation stake locks
  (`withdraw_reputation_stake` requires `== 0`, no fallback); deferred token
  reserve strands too; (b) a creator whose frivolous dispute was rejected closes
  the task to evade their own initiator slash.
- **Evidence**: `close_task.rs:36-45` (no dispute guard);
  `apply_dispute_slash.rs:36-41` and `apply_initiator_slash` accounts struct
  (seeds-bound Task); `resolve_dispute.rs:880-882, 971-972` (pending-slash
  deferral state); `close_task.rs:214-219` (optional escrow omittable).
- **Required change** (all three instructions are NON-canary — account changes
  allowed, full-surface IDL + SDK updates in same PR):
  1. `apply_initiator_slash`: drop the `task` account entirely; use
     `dispute.task` for any binding (verify the handler reads no other Task
     field first — if it does, source it elsewhere). Then Task destruction
     cannot brick the initiator finalizer.
  2. `apply_dispute_slash` needs `task.reward_mint`, so keep Task; instead make
     the Task unclosable while a worker slash is pending: in `resolve_dispute`,
     when `defer_worker_claim_close` set `task.current_workers = 1` (the
     defendant's claim IS still open) instead of `0`, and decrement it in
     `apply_dispute_slash` when the claim closes. `close_task`'s
     `current_workers == 0` guard then blocks the brick atomically.
  3. Defense-in-depth: `close_task` also refuses when a bound dispute passed as
     an optional remaining account is `Resolved && (!slash_applied ||
!initiator_slash_applied)` (not omission-proof on its own — item 2 is the
     load-bearing fix for the worker side, item 1 for the initiator side).
- **Pitfalls**: `expected_worker_pairs`/`current_workers` accounting in
  `resolve_dispute` must stay consistent for multi-worker disputes (only the
  DEFERRED defendant claim keeps a count). Token-settlement lapsed path must
  also clear the count. Don't break `claim_task` gating that reads
  `current_workers` on non-terminal tasks (this change only touches terminal
  transitions).
- **Tests**: integration — resolve with slash pending → `close_task` fails →
  `apply_dispute_slash` succeeds → `close_task` succeeds. Rejected dispute →
  `close_task` → `apply_initiator_slash` STILL succeeds (Task dropped).
  Token-deferred-reserve variant of the first flow.
- **Done when**: [ ] initiator finalizer Task-free [ ] resolve keeps
  `current_workers == 1` while deferred [ ] finalizer decrements it [ ] the two
  integration scenarios pass [ ] SDK callers updated [ ] gates green.

### [x] F-3 — Close the completing-accept orphan gaps (MEDIUM, full-surface)

- **FOLLOW-UP RESOLVED 2026-07-18 (current candidate)**: completing
  Collaborative accepts are intentionally exempt from the sole-live-submission
  guard. A still-Submitted peer now exits through `reclaim_terminal_claim`,
  which settles both validation counters and returns the full claim/submission
  balance. The guard and its fail-first test remain for completing
  **non-Collaborative** manual/quorum tasks; Collaborative coverage now asserts
  successful completion followed by terminal peer cleanup.
- **RESOLVED 2026-07-18 (commit `cc8870e`)**: (a) `validate_task_result`'s accept
  branch now calls `validate_completing_accept_sole_submission` before the
  counter decrements, mirroring the CreatorReview accept paths; (b)
  `reclaim_terminal_claim` accepts a REJECTED submission as no-live-submission
  evidence (counters untouched — already decremented at bounce) and returns the
  bounced submission's rent to the worker (`task_submission` marked `mut`,
  non-canary). litesvm: `completing-accept-orphan.test.mjs` covers both
  scenarios (incl. the litesvm AlreadyProcessed blockhash gotcha on retries).
- **Problem (a) (original entry)**: `validate_task_result`'s accept branch had no
  `validate_completing_accept_sole_submission` — a quorum/attestation completing
  accept flips the task to Completed while peer submissions/claims are live,
  stranding them with no exit (validate/reject/expire need non-terminal;
  `reclaim_terminal_claim` needs an absent submission PDA; `close_task` needs
  `current_workers == 0`).
- **Problem (b)**: the M-2 guard counts live `Submitted` submissions only, not
  open bounced claims: A bounced via `request_changes` (claim open, submission
  Rejected), B submits and is accepted → Completed → A's claim is stranded.
- **Evidence**: `validate_task_result.rs:303-311` (no guard);
  `task_init_helpers.rs:99-103` (only BidExclusive forces `max_workers == 1`);
  exit guards at `expire_claim.rs:275-279`, `reclaim_terminal_claim.rs:52-63`,
  `close_task.rs:36-45`; per-settler decrement at `completion_helpers.rs:259-280`.
- **Required change**:
  1. Call `validate_completing_accept_sole_submission` in
     `validate_task_result`'s accept branch BEFORE
     `note_submission_left_review`, mirroring `accept_task_result.rs:213` and
     `auto_accept_task_result.rs:211`. (Logic-only; `validate_task_result` is
     non-canary.)
  2. Bounced-claim orphan: extend `reclaim_terminal_claim`'s evidence rule to
     accept a program-owned `TaskSubmission` with `status == Rejected` as
     no-live-submission proof (close it to the worker, then close the claim) —
     this un-bricks (b) without blocking legitimate completing accepts. Consider
     additionally requiring `current_workers == 1` on completing accepts as
     defense-in-depth ONLY IF it does not block legitimate Collaborative finals
     (check the math: on the final accept of a Collaborative task the other
     claims are already closed, so `current_workers == 1` holds).
- **Pitfalls**: keep contest paths on their own guard; keep schema-gating
  (schema-0 no-op); don't break single-worker quorum flows.
- **Tests**: unit — guard matrix unchanged. Integration — (a) two-worker quorum
  task: second completing accept with a live peer fails; settle after rejecting
  the peer works. (b) bounced-claim chain: completing accept succeeds AND the
  bounced worker's `reclaim_terminal_claim` (Rejected evidence) succeeds after;
  revert the evidence change → the reclaim fails.
- **Done when**: [ ] quorum guard wired [ ] reclaim accepts Rejected evidence
  [ ] both integration scenarios pass [ ] gates green.

### [x] F-5 — Required+pinned worker completion bonds on `cancel_task` / `expire_reject_frozen` (MEDIUM, full-surface)

- **RESOLVED 2026-07-18 (commit `b3eb824`)**: both bond accounts (and
  `worker_bond_authority`) are now REQUIRED + seeds-pinned on `cancel_task`
  (full-surface only — cfg'd out of canary) and `expire_reject_frozen`; settle
  no-ops on the empty PDA of an un-bonded task, so no live bond can be omitted
  into a terminal task. SDK facade `cancelTask` derives the PDAs;
  marketplace-react/-tools default the worker wallet to the task PDA. The
  marketplace F12 test was reworked for the settled-at-cancel semantics.
- **Problem** (original entry): both paths settle the worker bond only when the
  caller passes it; `close_task` refuses only when a SUPPLIED bond is live.

- **Problem**: both paths settle the worker bond only when the caller passes it;
  `close_task` refuses only when a SUPPLIED bond is live. Atomic chain:
  `cancel_task` (omit bond) + `close_task` (omit bond) → Task PDA destroyed →
  `reclaim_completion_bond` (needs the live Task) dead → 25%-of-reward principal
  locked forever (grief/accident).
- **Evidence**: `cancel_task.rs:96-102`, `reject_frozen_exits.rs:329-335`,
  `close_task.rs:184-189`. F12 precedent (required + seeds-pinned, settle
  no-ops on the empty PDA): `accept_task_result.rs:127-149`,
  `resolve_dispute.rs:238-253` and its handler pinning at ~1024-1059.
- **Required change**: apply the F12 pattern to both instructions — make the
  worker (and creator, where applicable) bond accounts REQUIRED + seeds-pinned
  on the FULL surface. Canary note: the bond accounts are
  `#[cfg(not(feature = "mainnet-canary"))]` so the frozen canary wire shape is
  untouched; the full-surface IDL changes (optional → required) — update the
  SDK builders + callers in the same PR.
- **Pitfalls**: pin the worker bond to the wallet authority validated in-handler
  (F-1 binding), not to caller-chosen seeds. Keep "empty system PDA on
  un-bonded task → settle no-ops" semantics so un-bonded flows keep working.
  Residual (NOT solved here — needs a product decision, see P3/F-18 note):
  bonds of workers whose claims already closed on a still-open task stay
  hostage to `reclaim_completion_bond` until the Task closes; document that
  `close_task` must only run after such reclaims.
- **Tests**: integration — omit-the-bond chain now fails account loading;
  supplied-bond path refunds the worker; un-bonded task still cancels/closes.
- **Done when**: [ ] both instructions required+pinned [ ] SDK updated [ ]
  integration scenarios pass [ ] canary IDL unchanged [ ] gates green.

### [x] F-6 — `initialize_governance` single-key gate (MEDIUM→CLOSED: init already executed with sane params)

- **Status (verified on-chain 2026-07-17): CLOSED by verification.** The finding's code
  reading was correct (the one-shot init is gated only by
  `authority == protocol_config.authority`, no multisig), but its exploitation window
  analysis was stale: **governance is ALREADY initialized on mainnet** — PDA
  `6fwuSxq98VA6eEexQk6gfcfjyLCjgEmoUsZ8RZ2qvGR2`, 141 bytes — with **sane** params:
  `authority == protocol_config.authority`, `min_proposal_stake = 0.01 SOL`,
  `voting_period = 86400s`, `execution_delay = 3600s`, `quorum_bps = 300`,
  `approval_threshold_bps = 5000`, `total_proposals = 1`. The one-shot guard
  (`authority == Pubkey::default() && total_proposals == 0`) can never pass again, so the
  rogue-init → adversarial-quorum → `TreasurySpend` drain path is **closed on mainnet**.
- **Original evidence**: `initialize_governance.rs` handler gates (~lines 53-63, no
  multisig); quorum math `create_proposal.rs:176-189`; treasury transfer
  `execute_proposal.rs:134-140`.
- **Remaining (optional, defense-in-depth — NOT a deploy blocker)**: wiring
  `require_multisig_threshold` into `initialize_governance` (H-5 pattern,
  `initialize_zk_config.rs:65-66`) is harmless hygiene for any FUTURE program instance
  (devnet/new deploys); on mainnet it changes nothing. Do it only if a full-surface
  redeploy ever requires re-initializing governance.
- **Done when**: [x] on-chain init state + params verified and recorded (this entry,
  2026-07-17) [ ] optional: multisig hygiene wiring IF governance is ever re-initialized.

---

## P1 — Required before SPL/token rewards are enabled anywhere

> **ALL P1 ITEMS DONE (2026-07-18, commit `56f2451`)** — F-7 SOL-only freeze guard
>
> - F-4 token-task expire_claim reward skip, with litesvm SPL coverage.

(No token tasks exist on mainnet today; these are hard locks the moment the SPL
surface is used. Cheap guards; do them in the same PR.)

### [x] F-7 — `reject_and_freeze` must reject SPL tasks (MEDIUM, SPL-only)

- **RESOLVED 2026-07-18 (`56f2451`)**: `require!(task.reward_mint.is_none(),
CoordinationError::RejectFrozenSolOnly)` right after the task-type guard (new
  error 6358, appended). litesvm: the freeze is rejected on a token task with
  the token escrow untouched; SOL tasks unaffected.
- **Problem** (original entry): freezing an SPL CreatorReview task locks 100% of the token
  escrow — both frozen exits settle SOL-only (`execute_completion_rewards(...,
None, ...)`), which can never succeed against a rent-only PDA with
  token-denominated accounting.
- **Evidence**: `reject_and_freeze.rs:85-115` (no mint guard). Existing
  precedent guards: `post_completion_bond.rs:86-89`,
  `task_init_helpers.rs:205-208`, `distribute_ghost_share.rs:192-195`.
- **Required change**: `require!(ctx.accounts.task.reward_mint.is_none(),
CoordinationError::<SOL-only variant>)` next to the task-type guard. Reuse an
  existing error (e.g. `BondUnsupportedTaskType`-style) or append a new one at
  the enum END.
- **Tests**: unit revert-sensitive (SPL → err; SOL → ok) + one integration call.
- **Done when**: [ ] guard added [ ] test red on revert [ ] gates green.

### [x] F-4 — `expire_claim` cleanup reward must skip (or SOL-fund) on token tasks (MEDIUM, SPL-only)

- **RESOLVED 2026-07-18 (`56f2451`)**: `cleanup_reward_for_task` returns 0 for
  token tasks — no lamport debit, no `distributed` pollution; SOL path
  byte-identical. litesvm: token expire_claim succeeds with zero lamports
  leaving the rent-only escrow PDA and `distributed == 0`.
- **Problem** (original entry): `CLEANUP_REWARD` (1000 lamports) is debited from the escrow PDA,
  which on token tasks holds only rent (tokens sit in the ATA) →
  `InsufficientFundsForRent` → `expire_claim` uncallable on token tasks;
  reachable permanent locks (e.g. Collaborative token task, one completer + one
  no-show, `cancel_task` blocked). Secondary: `escrow.distributed += reward`
  pollutes a token-denominated counter with lamports.
- **Evidence**: `expire_claim.rs:296-312`; `init_escrow_fields` sets
  `escrow.amount = reward_amount` for token tasks too
  (`task_init_helpers.rs:214-216`); token branch `create_task.rs:341-357`.
- **Required change** (logic-only; `expire_claim` is on the frozen canary 25 —
  no account changes): when `task.reward_mint.is_some()`, skip the lamport
  reward entirely (no transfer, no `distributed` bump). SOL path unchanged.
  (Alternative: fund the reward from the treasury — do NOT choose this without a
  product decision; skipping matches "crank pays for itself with fees".)
- **Tests**: integration (litesvm SPL): expire_claim on a token task succeeds,
  no lamports move, `distributed` untouched; SOL cleanup reward unchanged.
- **Done when**: [ ] skip implemented [ ] token expire integration passes [ ]
  SOL path byte-identical [ ] canary IDL unchanged [ ] gates green.

---

## P2 — Recommended now (non-blocking for the canary upgrade)

> **ALL P2 ITEMS DONE (2026-07-18)** — F-8 `b72ff99`, F-9 `53e2c4b`, F-10 `e89e525`.

### [x] F-8 — Close the MCP tool-error credential channel (MEDIUM, off-chain)

- **RESOLVED 2026-07-18 (`b72ff99`)**: shared `src/redact.ts` used by `bin.ts`
  (fatal handler + new `uncaughtException`/`unhandledRejection` handlers) and
  `server.ts` `toErrorResult`; scrub covers raw AND `.trim()`ed forms plus
  `AGENC_INDEXER_API_KEY`; `dist/` rebuilt; 6 new vitest tests.
- **Problem** (original entry): `toErrorResult` returns raw `error.message` to the MCP client;
  SDK errors embed the configured endpoint verbatim
  (`sdk-ts/src/indexer/client.ts:492,511,525,538,558`). Credential-bearing
  `AGENC_INDEXER_URL`/`AGENC_RPC_URL` (userinfo, `?api-key=`) leaks to the
  client and its logs. Also: no `uncaughtException`/`unhandledRejection`
  handlers (Node's default crash print bypasses sanitization), and exact-match
  scrubbing misses trimmed/normalized URL forms (`config.ts:102` trims).
- **Evidence**: `packages/marketplace-mcp/src/server.ts:205-217`;
  `bin.ts:44-48` (sanitize covers only the fatal handler).
- **Required change**:
  1. Extract `redactUrl` + `sanitizeDiagnostic` into
     `packages/marketplace-mcp/src/redact.ts`; use in `bin.ts` AND in
     `toErrorResult` (`server.ts`).
  2. Scrub BOTH the raw env value and its `.trim()`ed form.
  3. Add `process.on('uncaughtException')` / `process.on('unhandledRejection')`
     handlers that sanitize before printing and exit non-zero.
  4. `npm run build` in `packages/marketplace-mcp` and commit the rebuilt
     `dist/` (it's committed).
- **Tests**: vitest — feed a tool error containing a credential-bearing URL,
  assert the tool result contains only the origin; assert crash handler output
  is sanitized. Rebuild + grep `dist/` for the sanitizer.
- **Done when**: [ ] shared redact module used in both files [ ] crash handlers
  added [ ] dist rebuilt [ ] tests pass.

### [x] F-9 — Sweep submission state on dispute exits (LOW, full-surface)

- **RESOLVED 2026-07-18 (`53e2c4b`)**: `resolve_dispute` / `expire_dispute`
  accept the defendant's `TaskSubmission` (+ `TaskValidationConfig` for manual
  tasks) as optional trailing accounts; when supplied and bound, the exit
  decrements both counters IFF still `Submitted` and closes the submission to
  the worker authority. Omission keeps the `close_task` fallback.
- **Problem** (original entry): `resolve_dispute`/`expire_dispute` never decrement
  `live_submissions`/`pending_submission_count` and never close the live
  `TaskSubmission` — counters stick at 1 on the terminal task; the worker's
  submission rent is recoverable only via creator-gated `close_task`.
- **Required change**: accept the defendant's `TaskSubmission` as an optional
  remaining account on both instructions; when present and bound
  (`["task_submission", worker_claim]` + `submission.task == task.key()`),
  decrement both counters (schema-1 via `note_submission_left_review`,
  config via `decrement_pending_submission_count`) and close it to the worker
  authority. When absent, leave as today (document `close_task` as the sweep).
- **Tests**: integration — dispute exit with supplied submission: counters
  reach 0 and rent returns to the worker; omitted-submission path unchanged.
- **Done when**: [ ] sweep wired on both exits [ ] integration passes [ ] gates
  green.

### [x] F-10 — Leg-skip via omitted `hire_record` on `auto_accept_task_result` (LOW, full-surface; document canary)

- **RESOLVED 2026-07-18 (`e89e525`)**: `hire_record` is REQUIRED + seeds-pinned
  on `auto_accept_task_result` (mirroring `resolve_dispute`); SDK facade derives
  the PDA when omitted so downstream callers keep working. `accept_task_result`
  deliberately unchanged (canary-frozen, moot — recorded as decision D4).
- **Problem** (original entry): `accept_task_result`/`auto_accept_task_result` take
  `hire_record` as `Option`; omission silently skips operator/referrer legs on
  pre-stamp hired tasks. Permissionless `auto_accept` lets the worker
  self-crank the legs away. (`accept_task_result` is on the frozen canary 25,
  but canary has no `hire_from_listing`, so no HireRecords exist there — moot
  on canary; document, do NOT change its account list.)
- **Required change**: on `auto_accept_task_result` (non-canary) make
  `hire_record` REQUIRED + seeds-pinned `["hire", task]`, mirroring
  `resolve_dispute.rs:193-197` (empty system PDA for non-hired tasks; handler
  already falls back correctly). Update SDK callers.
- **Tests**: integration — auto-accept on a hired legacy task with omitted
  `hire_record` now fails; with the PDA passed, the operator/referrer legs pay
  out exactly.
- **Done when**: [ ] auto_accept pinned [ ] SDK updated [ ] integration passes
  [ ] `accept_task_result` limitation documented in docs/ [ ] gates green.

---

## P3 — Low / hardening

> **ALL P3 ITEMS DONE (2026-07-18)** — F-11/F-15 `631a10f`, F-14/F-16 `0c8f1a0`,
> F-18 `dd519ad`, F-19 `3285675`; F-12 preflight script + on-chain result and
> F-17 decision recorded in `docs/DESIGN_DECISIONS.md` (D5/D6).

### [x] F-11 — `expire_claim` InProgress+live-Submitted evidence guard (LOW, defense-in-depth)

- **RESOLVED 2026-07-18 (`631a10f`)**: the guard now rejects any expirable-status
  task whose claim carries a live (Submitted) submission, via the pure
  `claim_is_expirable` helper + a revert-sensitive unit matrix (InProgress and
  PendingValidation × live/not-live).

### [x] F-12 — Pre-P6.3 disputes with `total_voters > 0` are unexitable (LOW, deploy preflight)

- **RESOLVED 2026-07-18**: `scripts/preflight-dispute-scan.mjs` scans the on-chain
  Dispute set for `total_voters > 0` (offset 202) and hard-fails on any hit. Run
  against mainnet today: **3 Dispute accounts, all `total_voters == 0`** — no
  legacy-dispute action needed. Re-run before any deploy that touches the dispute
  lifecycle; result recorded in `docs/DESIGN_DECISIONS.md` (D6).

### [x] F-14 — Bid-settlement remaining-accounts offset on reject/expire paths (LOW)

- **RESOLVED 2026-07-18 (`0c8f1a0`)**: `reject_task_result`, `validate_task_result`'s
  reject branch, and `expire_claim` now compute the bid-settlement offset via the
  shared `bid_settlement_offset(task)` (Proof-dependency ⇒ 1) exactly like the
  accept paths; revert-sensitive unit test on the offset.

### [x] F-15 — `checked_sub` → `saturating_sub` on counter decrements in `reclaim_terminal_claim` / `expire_claim` (LOW)

- **RESOLVED 2026-07-18 (`631a10f`)**: both recovery paths now decrement
  `current_workers`/`active_tasks` via the shared `saturating_dec_counter`
  (u8/u16) — the un-brickers can no longer brick on drifted legacy counters;
  drift unit test covers 0/1/N/MAX for both widths.

### [x] F-16 — Fee math overflow in `completion_helpers` (LOW)

- **RESOLVED 2026-07-18 (`0c8f1a0`)**: all three fee-multiply sites
  (`calculate_reward_split_for_amount`, `calculate_combined_fees` operator +
  referrer legs) use u128 intermediates; a u64-scale unit test (~4.6e18
  lamports) proves no overflow.

### [x] F-17 — Document: no-deadline underfilled Collaborative has no creator refund (INFO→doc)

- **RESOLVED 2026-07-18**: recorded as accepted design decision D5 in
  `docs/DESIGN_DECISIONS.md` — a deadline-free task is a standing offer (escrow
  remains funded for future eligible claim attempts, subject to all execution-time
  gates; not a lock, by design).

### [x] F-18 — Multisig hardening cluster (LOW)

- **RESOLVED 2026-07-18 (`dd519ad` + adversarial-review follow-up)**:
  - `update_multisig`: the "owner set must retain authority" require was
    **REVERTED** after on-chain verification showed the mainnet authority is a
    Squads vault PDA — it can never satisfy `require_multisig_threshold`
    (owner-signers must be system-owned), so the require forced a dead PDA into
    every future owner set and broke the operators' existing rotation
    construction. It also protected nothing: the authority field is immutable by
    design, so its power never depended on owner membership. Integration now
    pins that exclusion rotations stay ALLOWED.
  - `update_launch_controls`: wire-compatible KEEP sentinels (0xFF mask /
    0xFFFF revision) close the stale-read reset hazard — per-field/compare-and-swap
    was impossible without changing the canary-frozen args; explicit values
    validate + apply exactly as before (integration: KEEP preserves, explicit resets).
  - Dead `require_multisig` helper deleted (`require_multisig_threshold` is the
    only enforcer).
  - The single authority model is documented in `utils/multisig.rs` (multisig-gated
    vs authority-bound admin paths).

### [x] F-19 — Off-chain lows

- **RESOLVED 2026-07-18 (`3285675`)**:
  - `templates.ts`: `commentSafeName` sanitizes `config.name` at every comment
    interpolation site (both router templates + worker template).
  - `credible-exit.mjs`: RPC/indexer/attestor URLs redacted to origin in stdout
    AND the persisted proof JSON (+ the fail-path message).
  - `mainnet-init-and-stamp.mjs`: genesis-hash check — refuses any non-mainnet
    hash unless `CLUSTER=devnet` is passed explicitly.
  - `release.yml`: protocol gate now runs `canary:idl` + `canary:check-idl`.
  - `idl-drift.yml`: least-privilege `permissions: contents: read`.

---

## 2026-07 adversarial swarm (second wave) — ALL RESOLVED

A 13-agent adversarial swarm re-audited the full program after the F-1–F-19
queue landed. Every confirmed finding was fixed in a staged commit with
revert-sensitive tests; each commit is independently gate-green.

### [x] S-1 — CRITICAL: `expire_dispute` paid a self-disputing no-show 50% of escrow

- **RESOLVED (`1b562b4`)**: post-P6.3 every expired dispute is UNRESOLVED (arbiter
  voting is retired), so expiry now refunds the funder in full and the accepted
  bid bond is always Refunded (was FullSlashToCreator). Test:
  `expire-refund-default.test.mjs`.

### [x] S-2 — HIGH: initiator-slash guard was dead code

- **RESOLVED (`96fa6bd`)**: `initiate_dispute` now stamps
  `agent.last_dispute_initiated`, so the `deregister_agent` cooldown (which read
  the never-written field) actually binds — a frivolous-dispute creator can no
  longer deregister instantly to brick `apply_initiator_slash`. Test:
  `initiator-slash-guard.test.mjs`.

### [x] S-3 — MED: `validate_task_result` settled no completion bonds

- **RESOLVED (`ab5b297`)**: both bonds are now REQUIRED + seeds-pinned and
  refunded on accept (the only Completed path that skipped settlement).

### [x] S-4 — MED: `close_task` bricked live bids

- **RESOLVED (`3e7a364`)**: requires the canonical bid book for BidExclusive
  tasks (fail-closed on omission) and refuses while `active_bids > 0`. Test:
  `close-task-bid-guard.test.mjs`.

### [x] S-5 — MED: ValidatorQuorum sybil voting was free

- **RESOLVED (`81d3be2`)**: votes now require
  `validator_agent.stake >= protocol_config.min_stake_for_dispute`. Design
  context recorded as D8.

### [x] S-6 — MED: delegation slash-vault + re-registration inflation loop

- **RESOLVED (`ed0752a`)**: `delegate_reputation` rejects active dispute
  defendants (the delegated pot was slash-exempt); `revoke_delegation` requires
  `registered_at <= delegation.created_at` so a deregister→re-register cycle
  (same agent PDA) cannot replay a delegation into unbounded reputation.
  Errors 6359/6360 (appended). Test: `delegation-guards.test.mjs`.

### [x] S-7 — LOW batch (`0b34a81`)

- `create_dependent_task` hard-failed on legacy 382B parents (typed
  `Account<Task>` load) → owner-check + zero-pad deserialize in-handler.
- `purchase_good` / `purchase_skill` fee math → u128 intermediates (F-16 class).
- `resolve_dispute` / `expire_dispute` defendant `active_tasks` → saturating
  (the un-brickers could themselves brick on legacy counter drift).
- `apply_dispute_slash` token-settlement rent (escrow PDA + ATA) → the CREATOR
  who funded it, not the treasury (every other close path already did this).
- `create_proposal` custom `voting_period` floored at the governance default
  (a mainnet proposal already ran a 600s snap vote).

### [x] S-8 — LOW batch (`89779cf`)

- `cancel_task` claim drain refunded a no-show squatter's contest entry
  deposit → now forfeited to the treasury like every other no-show exit
  (cfg-gated optional treasury account, required when a deposit is drained).
- `deregister_agent` was bid-blind → required remaining account pins the
  `["bidder_market", agent]` PDA and refuses while `active_bid_count > 0`
  (new error 6361); it also sweeps the `["agent_verification", agent]` badge
  so a re-registered agent_id cannot inherit it.
- `close_task` now sweeps the creator-funded `TaskBidBook` (proved
  `active_bids == 0` by the C4 guard) instead of stranding its rent.
- `cancel_task` trampoline: `task` boxed — the treasury field tipped the 4KB
  SBF frame (caught by e2e + `check-stack-frames.mjs`).
- Dependency gate on ghost/frozen exits: considered and REJECTED — recorded
  as D13 (gating the sole exits could lock escrow when a parent stalls).

### [x] S-9 — Documentation-only residuals

Recorded in `docs/DESIGN_DECISIONS.md`: D8 (quorum is friction, not Byzantine
resistance), D9 (governance stake remains locked through an election), D10
(settlement beneficiaries cannot resolve), D11 (V-2 same-round revote tombstone
wedge), D12 (every dispute binds a live claim and exitable task state), and D13
(proof dependencies deliberately do not gate the sole ghost/frozen exits).

---

## Informational — reviewed decision index

The current D1–D4 status is recorded in
[docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) (with D5 onward covering
later findings and reviewed trade-offs). Kept here as the short index:

- **D1** — Canary `PendingValidation` timeout resolved through the frozen
  `accept_task_result` surface with strict task-shape and recipient checks.
- **D2** — Collaborative completing accepts may leave Submitted peers because
  `reclaim_terminal_claim` now provides their permissionless full-refund exit.
- **D3** — The same terminal straggler cleanup covers schema-0 Collaborative
  tasks without fabricating legacy `live_submissions` counters.
- **D4** — `accept_task_result` `hire_record` optionality stays on the frozen
  canary surface; moot there (no hires exist on canary).

---

## Tracking

| ID                   | Priority                                                                                                                                        | Owner | Status |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| F-1                  | ~~P0~~ DONE (4b70630)                                                                                                                           |       | ☒      |
| F-2                  | ~~P0~~ DONE (aa6aae5; omission-proof follow-up 8ca868d)                                                                                         |       | ☒      |
| F-3                  | ~~P0~~ DONE (cc8870e)                                                                                                                           |       | ☒      |
| F-5                  | ~~P0~~ DONE (b3eb824)                                                                                                                           |       | ☒      |
| F-6                  | ~~P0~~ CLOSED — init already executed with sane params (verified on-chain 2026-07-17)                                                           |       | ☒      |
| F-7                  | ~~P1~~ DONE (56f2451)                                                                                                                           |       | ☒      |
| F-4                  | ~~P1~~ DONE (56f2451)                                                                                                                           |       | ☒      |
| F-8                  | ~~P2~~ DONE (b72ff99)                                                                                                                           |       | ☒      |
| F-9                  | ~~P2~~ DONE (53e2c4b)                                                                                                                           |       | ☒      |
| F-10                 | ~~P2~~ DONE (e89e525)                                                                                                                           |       | ☒      |
| F-11–F-19            | ~~P3~~ DONE (631a10f F-11/15, 0c8f1a0 F-14/16, dd519ad F-18, 3285675 F-19; F-12/17 docs)                                                        |       | ☒      |
| S-1–S-9 (swarm wave) | ~~CRITICAL–LOW~~ DONE (1b562b4 S-1, 96fa6bd S-2, ab5b297 S-3, 3e7a364 S-4, 81d3be2 S-5, ed0752a S-6, 0b34a81 S-7, 89779cf S-8; S-9 docs D8–D13) |       | ☒      |
