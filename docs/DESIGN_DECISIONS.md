# Accepted Design Decisions (do not re-file)

Dated 2026-07-18, after the three-pass 2026-07 audit and the full TODO.MD
hardening queue. Each entry is a deliberate, reviewed trade-off — not an open
finding. Before filing any of these as a bug, read the rationale; changing one
requires a design discussion, not a fix PR.

## D1 — Canary surface has no timeout exit from `PendingValidation`

`auto_accept_task_result` and the dispute apparatus are compiled out of the
frozen 25-instruction canary build, and `PendingValidation → Cancelled` is not a
legal transition. A creator who ghosts after a submission therefore locks the
escrow AND the worker's claim until they return. This is a **mutual** lock
(creator's funds are equally hostage), accepted as frozen-surface design: the
canary's conservative envelope trades a griefing creator's upside for a smaller
audited surface. Recovery is the creator returning, or a program upgrade.

## D2 — M-2 completing-accept trade-off: the creator must reject stragglers first

`validate_completing_accept_sole_submission` blocks ANY completing accept while
another submission is live (on schema-1 manual tasks, both accept paths and the
quorum path). The intended flow is: reject the stragglers first, then accept.
The alternative (accept-and-orphan) permanently stranded the peer's claim,
submission rent, and `active_tasks` slot with no exit. Deliberate fail-closed:
an absent creator then locks everyone (previously: one orphan). Documented in
TODO.MD F-3.

## D3 — Schema-0 completing-accept orphan is accepted for legacy tasks

The M-2 guard no-ops for schema-0 (pre-batch-3) tasks because `live_submissions()`
is unmaintained there (always reads 0). A schema-0 Collaborative CreatorReview
completing accept can therefore still orphan a peer submission. The conservative
choice stands: fabricating a counter on 169+ live legacy accounts risks
counter-drift against their existing state, which is worse than the bounded
orphan set. New tasks are all schema-1.

## D4 — `accept_task_result`'s optional `hire_record` stays as-is on the canary

`accept_task_result` is on the frozen 25-ix canary surface, so its account list
cannot change. The optionality (omitting `hire_record` skips operator/referrer
legs on pre-stamp hired tasks) is moot on canary because `hire_from_listing` is
not on the canary surface — no HireRecords exist there. On the full surface,
`auto_accept_task_result` was pinned (F-10) and this instruction keeps the
Task-first semantics: current hires read the legs from the Task itself, so the
optional record only matters for pre-Batch-2 tasks, of which none remain
unsettled. Revisit only if the canary surface is ever expanded.

## D5 — No-deadline underfilled Collaborative tasks have no creator refund path (F-17)

C-1's widened cancel requires a PAST deadline. A `deadline == 0` Collaborative
task with `completions > 0 && current_workers == 0` keeps its escrow claimable
by future workers forever — not a lock, by design: any worker may still claim
and complete the remaining slots. A deadline-free task is a standing offer;
the creator chose not to bound it. Creators who want an exit set a deadline.

## D6 — F-12 preflight result: zero legacy disputes on mainnet

`scripts/preflight-dispute-scan.mjs` (run 2026-07-18 against mainnet) found
3 Dispute accounts, all with `total_voters == 0` — no pre-P6.3 (arbiter-vote-era)
disputes exist, so no admin resolution path is needed for them. Re-run the scan
before any deploy that touches the dispute lifecycle.

## D7 — F-2 reclaim-guard omission residual

`reclaim_terminal_claim`'s slash-pending guard fires when the bound dispute is
supplied as a remaining account. A griefer can OMIT it, reclaim an
InProgress-originated deferred claim, drive `current_workers` to 0, and
`close_task` → brick `apply_dispute_slash`. Accepted because: the reclaim pays
only the worker/treasury (no profit for the griefer), the worker can front-run
the finalizer themselves at any time in the 7-day window, and the omission-proof
alternative (carving a pending-slash flag from `Task._reserved`) would create a
third schema generation — rejected under the schema-retirement decision.
