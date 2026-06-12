# Pre-mainnet audit — fixes applied & remaining human-owned items (2026-06-11)

> **Post-deploy status (2026-06-11):** the full-surface upgrade this audit gated has since
> been executed — the full 84-instruction surface is live on mainnet
> (`surface_revision = FULL`), the 169 live Task accounts were migrated (382B → 466B, 0
> failures), `ProtocolConfig` migrated (349B → 351B), and `BidMarketplaceConfig` was
> initialized (bid marketplace live). The "Remaining" deploy-day items below that were
> completed by the upgrade are now done; **`ZkConfig` remains DEFERRED**
> (`complete_task_private` stays off until `initialize_zk_config` runs with the audited
> agenc-prover image id). The "149 live tasks" figures in the text were 149 when written;
> the live count was 169 at the upgrade. See `docs/MAINNET_ROLLOUT_RUNBOOK.md`.

Source: the multi-agent pre-deploy completeness audit (workflow `mainnet-predeploy-audit`,
161 agents) surfaced ~94 findings across the full ~84-instruction surface. Its adversarial
verification phase was cut short by a billing limit, so each item below was **re-verified by
hand against live code** before any change. Branch: `fix/predeploy-audit-batch`.

Scope rule followed (per `CLAUDE.md` golden rules): only **logic-only, ABI-safe** changes were
applied autonomously — `require!` guards, control-flow fixes, exit-gate swaps, emitting an
already-declared event, and doc/script corrections. Anything needing an **account-signature
change, an account-layout/IDL change, npm publish, on-chain deploy, or a product decision** is
documented under "Remaining" for the human to apply with the deploy choreography. Nothing was
committed, pushed, published, or deployed.

---

## UPDATE — second pass (direction: "every flagged item is legit; verify and implement")

Now implementing the previously-human-owned items as separate **verified** increments (each lands with
the full gate green, to avoid a broken tree or rushed money-path code). Done so far in the second pass,
all verified (clippy default + canary, **321 unit**, **215 litesvm integration**, **459 SDK** tests;
artifacts + SDK regenerated and checked):

1. **`deregister_agent` stake strand/theft (HIGH)** — required, seeds-pinned `reputation_stake` account;
   reverts with `ReputationStakeNotWithdrawn` while staked. Revert-sensitive test added.
2. **`apply_dispute_slash` deferred-claim rent strand** — `worker_authority` recipient + `close` on the
   worker claim; rent returned, not stranded.
3. **Content-hash gate (HIGH)** — `validate_description_is_content_hash` now enforced on all surfaces in
   the three task-creation instructions (verified all tests already use content-hash descriptions).
4. **`cancel_task` #70 honest-worker-bond theft (HIGH)** — the worker-bond forfeit is now gated on a
   genuine no-show (`InProgress` past deadline); an `Open` cancel (incl. a task reopened by
   `reject_task_result` after the worker delivered) refunds the worker's bond instead of letting the
   creator seize it. Revert-sensitive test added.

Still queued (each its own verified increment): the `close_task`/`cancel_task` bond-strand hardening —
the **#70 theft is fixed**; the residual is the *omit-on-terminal-exit strand* (settled at completion
paths since `close_task` can't pin the worker-bond PDA),
service-listing provider-Active gate, `post_completion_bond`/`stake_reputation` pause gate,
`cancel_dispute` PendingValidation restore, the missing money events, dead-code removal, the
`delegate_reputation` rework, the attestor-roster fix, the collaborative-dispute fairness cap, the
live-config `state_update_cooldown` migration, and the ops items (sweep script, e2e tests, react gate,
npm republish). Sections B–F below give the exact patch for each.

---

## A. Fixed in this branch (verified: `cargo clippy` default + `mainnet-canary` clean; 321 unit tests pass)

Each money/state-machine fix that could be expressed as a pure guard got a **revert-sensitive**
test (proven to go red without the fix).

### Money / fund-safety
1. **`resolve_reject_frozen` uphold branch never released the worker's claim slot** (HIGH).
   Added `release_claim_slot` in the rejection-upheld branch — previously `task.current_workers`
   stayed > 0 (task permanently unclosable) and `worker.active_tasks` stayed inflated (worker
   could never claim again or deregister, locking their registration stake). Test:
   `tests-integration/marketplace.test.mjs` "resolve_reject_frozen (reject)" now asserts both
   counters drop to 0.
2. **`validate_task_result` / `complete_task_private` silently dropped the referrer fee leg**
   (HIGH). Fail-closed at the source: `configure_task_validation` now rejects a referrer-bearing
   task for `ValidatorQuorum`/`ExternalAttestation`, and `create_task` rejects a referrer fee on a
   private (`constraint_hash`) task. Prevents the referrer being stiffed and the worker getting an
   unauthorized windfall on those settlement paths.
3. **`initiate_dispute` durable path allowed multiple concurrent disputes per task** (HIGH).
   `validate_disputable_task_state` now rejects an already-`Disputed` task on **both** the normal
   and durable-submission paths — closes the permanent worker-stake lock. Two revert-sensitive
   unit tests added.

### Access control
4. **`update_zk_image_id` was single-authority-key gated** (HIGH). The active ZK image ID is the
   root of trust for `complete_task_private` escrow payout; a single compromised key could rotate
   it to an attacker guest and drain every ZK task. Now **M-of-N multisig** gated like
   `update_treasury` (co-signers via `remaining_accounts`). `admin-config.test.mjs` rewritten to
   the multisig convention (single signer now rejected with `MultisigNotEnoughSigners`).
5. **`resolve_dispute` had no self-resolution guard** (HIGH). Wired the declared-but-unused
   `InitiatorCannotResolve`: the dispute initiator can no longer resolve their own dispute (a roster
   member could otherwise initiate on their own task and rule in their favor).
6. **`create_task` + `create_dependent_task` skipped the creator-agent suspension gate** (medium).
   Both now require `creator_agent.status == Active`, matching every sibling — a suspended creator
   can no longer post funded tasks and lure workers.
7. **`register_agent` skipped the pause/version gate** (medium). Added `check_version_compatible`
   — registrations no longer succeed (and bump `total_agents`) while the protocol is paused.

### Exit-safety ("money never locks")
8. **`cancel_dispute`, `expire_bid`, `apply_initiator_slash`** used the entry gate (rejects while
   paused) on settlement/restoration/finalizer paths. Switched to `check_version_compatible_for_exit`
   and dropped entry-only `require_task_type_enabled`, matching the established convention. Fixes the
   case where a pause longer than the 7-day slash window let a frivolous-dispute initiator dodge the
   slash permanently.

### State-machine / counters / governance
9. **`reject_and_freeze` leaked `pending_submission_count`** (low). Now decrements it (account made
   `mut`), restoring the "pending == #Submitted" invariant every sibling maintains.
10. **`create_proposal` RateLimitChange omitted the `min_stake_for_dispute` floor** that
    `execute_proposal` enforces (low) — a passable proposal would revert at execution and strand
    permanently Active. Now validated at creation.
11. **`initialize_protocol` never set `state_update_cooldown`** (low) — landed at 0 (= disabled) on
    every fresh deploy. Now set to 60. **NOTE:** the live mainnet config already exists with this at
    0; enabling it there needs a migration (see C-3).
12. **`update_rate_limits` emitted no event** (low). Now emits the declared `RateLimitsUpdated`
    (additive, no IDL change) so indexers see anti-spam/dispute-stake-floor changes.
13. **`UnauthorizedResolver` error message inverted the actual rule** (low). Corrected to "protocol
    authority or assigned resolver, never the initiator".

### Docs / deploy tooling
14. **`scripts/validation-deploy-preflight.mjs`** — `knownSharedProgramId` was a stale value
    (`6UcJ…`) so the "don't deploy a validation build over the shared program" guard could never
    fire. Set to the canonical `HJsZ…`.
15. **`MAINNET_ROLLOUT_RUNBOOK.md`** — added the missing one-time config-account init step
    (`initialize_bid_marketplace`, `initialize_zk_config` with the audited image ID, verify
    `ModerationConfig`) **before** stamping `surface_revision`; otherwise bid-flow and
    private-completion instructions fail `AccountNotInitialized` while the surface advertises them.
16. **`PROGRAM_SURFACE.md`** — removed retired `vote_dispute`, added the 27 missing instruction
    families (completion bonds, RejectFrozen exits, hire/listing, moderation, verification,
    launch-controls, migrate_task…), corrected the fail-closed `claim` note and the PDA families.
17. **Instruction-count drift** corrected (84 full / 25 canary) in `CLAUDE.md` and
    `scripts/devnet-deploy.md`; canary `migrate_task` doc-comment corrected (432B → actual 466B).

---

## B. Remaining program fixes — need an ACCOUNT-SIGNATURE change (SDK regen + test updates; human-owned)

These are real findings, but each requires adding/modifying accounts on an instruction (changes the
IDL + SDK builders, and several touch instructions shared with the live 25-ix canary). They are
deploy-gated by the repo's golden rules. Recommended patch for each:

- **`close_task` strands live completion bonds** (HIGH). On a `Completed` task whose creator omitted
  the optional bonds at accept time, `close_task` closes the `Task` PDA → `reclaim_completion_bond`
  (which needs a live `Task`) can never run → both bonds frozen. **Fix:** add `creator_completion_bond`
  + `worker_completion_bond` as **required, seeds-pinned** accounts to `CloseTask` and `Refund` them
  (no-op if absent), exactly like `ResolveRejectFrozen`. Worker principal is at risk → prioritize.
- **`cancel_task` takes bonds as Optional on a terminal exit** (medium) + **#70 forfeit is ungated**
  (HIGH). A malformed cancel strands the bonds; and `reject_task_result → cancel_task` lets a creator
  forfeit a delivered-work worker's bond with no no-show check. **Fix:** make the bond accounts
  required + seeds-pinned (matching `resolve_dispute`), and gate the worker-bond forfeit on a genuine
  no-show (load `TaskSubmission`; only forfeit if no live Submitted submission).
- **`deregister_agent` ignores the persistent `ReputationStake` PDA** (HIGH — strand + theft). After
  deregister the `agent_id` is re-registerable by anyone, who can then withdraw the original staker's
  stake. **Fix:** add the `ReputationStake` account and `require!` it is zero/withdrawn before
  deregistration (or close it to the staker in the same ix). Also retire/close the provider's
  `ServiceListing`s (or have `hire_from_listing` verify the provider agent is live) to stop orphan
  listings minting dead-end hires.
- **`apply_dispute_slash` never closes the deferred `worker_claim`** (low — ~0.0012 SOL rent strand
  on the losing party). **Fix:** add a `worker_authority` recipient account and `mut` + `close =
  worker_authority` on `worker_claim`.
- **`post_completion_bond` + `stake_reputation` have no pause/version gate** (low/medium). Neither
  takes `ProtocolConfig`. **Fix:** add the `protocol_config` account + `check_version_compatible`.
- **`set_service_listing_state` + `update_service_listing` skip the provider-Active gate** (medium) —
  agent suspension does not reach the listing/hire surface. **Fix:** load the provider
  `AgentRegistration` and require `Active` on transitions into `Active` (and/or check it in
  `hire_from_listing`).
- **`cancel_dispute` hardcodes restore to `InProgress`** (medium), losing `PendingValidation` and
  breaking the accept flow for a dispute opened from a manual/durable-submission task. **Fix:** take
  the `TaskSubmission` account and restore to `PendingValidation` when a live `Submitted` submission
  exists.

## C. Remaining — need an ACCOUNT-LAYOUT / IDL change (migration + regen; human-owned)

- **Missing money/observability events** (medium/low): `DisputeResolved` lacks payout amounts (vs
  `DisputeExpired`); `ProposalExecuted` is emitted for both Defeated and Executed with no outcome
  field; no `ClaimExpired` event; bid-bond slash/refund and `update_bid_marketplace_config` emit
  nothing; stake slashing has no amount-bearing event; `AgentDeregistered` carries no stake amount.
  Each needs a new event type or a new event field (IDL append) → regenerate artifacts + SDK.
  (Do **not** repurpose the declared `BondSlashed` — it belongs to the dead speculation-bond
  subsystem.)
- **`state_update_cooldown` on the LIVE config is 0** (C-3): the init fix only covers fresh deploys.
  To enable it on mainnet, have `migrate_protocol` (v2 arm, currently a documented no-op) set it, or
  add it to an `update_rate_limits`-class setter.
- **Dead code shipping in the mainnet IDL**: the speculation-bond subsystem (2 accounts, 5 events, 4
  errors, 1 enum), 2 speculative-execution accounts, and 36 unreferenced error variants. **Do NOT
  delete error variants** — Anchor numbers errors by position, so deletion renumbers every later code
  and breaks deployed clients. Deprecate in docs; strip dead accounts/events only with a deliberate
  IDL regen.

## D. Intentional-design decisions (confirm before flipping — NOT auto-changed)

- **Content-hash gate (`validate_description_is_content_hash`) is `#[cfg(mainnet-canary)]`-only** (HIGH
  per one agent, low per another). On the full surface a hand-rolled tx can write 64 bytes of readable
  un-moderated prose into `Task.description`. It is a *deliberate* cfg gate and wiring it unconditionally
  would break ~10 tests that pass non-hash descriptions and change the validation contract. **Decision
  needed:** enforce on the full surface (and update tests/SDK) or keep it canary-only by design.
- **`delegate_reputation` is inert** (medium): debits the delegator, never credits the delegatee,
  `expires_at` never enforced. Fixing it requires the delegatee account + a reputation aggregation model
  — a feature design decision, not a one-line fix.
- **Moderation-attestor roster equality** (medium): consumers (`set_task_job_spec`, `hire_from_listing`)
  require `moderation.moderator == moderation_authority`, so roster-attestor (P6.8) attestations are
  unusable and a deputy can grief by re-recording. Fix needs consumers to accept
  `moderator ∈ {authority} ∪ registered roster` (load the `ModerationAttestor` account) — a signature +
  semantics decision.
- **`execute_proposal` can move treasury / change fees via a stake-weighted vote**, bypassing the
  multisig that gates the direct setters (medium). This is a governance-model trade-off, not a bug.
- **Collaborative-dispute single-defendant over-payment** (low) — distribution-fairness design choice.

## E. Human / ops items (no code)

- **Republish `@tetsuo-ai/protocol` (→ 0.2.2)**: the published 0.2.1 ships a stale 80-instruction IDL
  (has retired `vote_dispute`; missing 5 instructions, 4 accounts, and the `referrer`/`rationale`/
  `surface_revision` layout fields). Regenerate from current `src/generated` and publish at/before the
  full-surface deploy. (The primary `@tetsuo-ai/marketplace-sdk@0.6.0` tarball is NOT affected.)
- **`marketplace-react` referrer gate** is hardcoded `live:false` with TODOs — flip to the
  `getDeployedSurface` check and republish after the deploy.
- **`SECURITY.md`** has a placeholder `security@agenc.tech` and unpublished PGP fingerprint;
  **`BUG_BOUNTY.md`** reward bands/budget/platform are all TBD. Decide before publishing.
- **No `migrate_task` sweep script exists** for the 149 live tasks, though the runbook requires one
  "scripted and ready to fire". Author it (default dry-run, enumerate Task PDAs via `getProgramAccounts`
  with the Task discriminator, multisig-sign, verify count == 149) and **rehearse on devnet** before
  mainnet — do not improvise it by hand against real escrow.
- **Zero e2e coverage** for `complete_task_private`, `execute_proposal`, `initialize_protocol`
  (the latter two are also money/access-control critical). Add litesvm integration tests.
- **zkVM image-ID provenance**: the in-repo `zkvm/guest` is a serialization shim only; the real guest
  + image ID live in `agenc-prover`. Pin only an **audited** mainnet image ID in `initialize_zk_config`;
  a permissive/test image is a fund-drain vector on `complete_task_private`.
- **Demand gates (D1–D3)** and the §11.5 go/no-go remain open per `PLAN.md` — these are business gates,
  not code.

---

## F. MANDATORY before deploy (do not skip)

1. `anchor build && npm run artifacts:refresh && npm run artifacts:check` — the program source changed
   (new guards, the `update_zk_image_id` account change, `reject_and_freeze` writable flag, the
   `UnauthorizedResolver` message), so the committed IDL/artifacts are now stale.
2. `cd packages/sdk-ts && npm run sdk:generate && npm run sdk:drift && npx tsc --noEmit && npm test` —
   regenerate the client; the `update_zk_image_id` facade must accept multisig co-signers (like
   `updateTreasury`).
3. `npm run canary:build && npm run canary:idl && npm run canary:check-idl`.
4. `cd tests-integration && node --test` against the **rebuilt** `.so`.
5. Devnet/localnet 149-task rehearsal per the runbook §4.
