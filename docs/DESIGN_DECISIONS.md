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
disputes exist, so no admin resolution path is needed for them. The scanner also
flags any ACTIVE dispute whose defendant claim PDA is closed/missing (the D12
shape) — zero of those exist either. Re-run the scan before any deploy that
touches the dispute lifecycle.

## D7 — F-2 reclaim-guard omission residual

`reclaim_terminal_claim`'s slash-pending guard fires when the bound dispute is
supplied as a remaining account. A griefer can OMIT it, reclaim an
InProgress-originated deferred claim, drive `current_workers` to 0, and
`close_task` → brick `apply_dispute_slash`. Accepted because: the reclaim pays
only the worker/treasury (no profit for the griefer), the worker can front-run
the finalizer themselves at any time in the 7-day window, and the omission-proof
alternative (carving a pending-slash flag from `Task._reserved`) would create a
third schema generation — rejected under the schema-retirement decision.

## D8 — ValidatorQuorum is friction, not Byzantine resistance

The VALIDATOR capabilities bit is self-asserted at registration, so a quorum of
"validators" is a quorum of sybils unless an operator curates off-chain. That is
accepted: the quorum's purpose in v1 is to add review friction for unattended
tasks, not to survive an adversarial validator set. What the code DOES enforce
(after the 2026-07 swarm, `81d3be2`): every vote requires
`validator_agent.stake >= protocol_config.min_stake_for_dispute`, so sybil
voting costs real stake per identity. An on-chain validator allowlist is a
future design, not a bug fix — do not file "quorum members are self-asserted"
as a finding.

## D9 — Governance vote weight is refundable and recyclable

`vote_proposal` weights votes by the voter's CURRENT stake, and the stake is
withdrawable after voting — so one stake can be recycled across proposals (and
across sybil agents) within the same voting period. The
`last_vote_timestamp` deregistration cooldown was meant to blunt this but is
effectively dead code (24h vs multi-day voting windows). Accepted for v1:
governance is not yet the money path (treasury spends still require the multisig
roster in practice), and the correct fix is a redesign (vote-escrowed stake or
snapshot weights), not another timestamp patch. File redesign proposals, not
bugs, against this entry.

## D10 — Resolver leg conflict is bounded, not eliminated

H-2 blocks a dispute resolver who equals the task creator or the defendant
wallet. A resolver can still be the beneficiary of an operator/referrer leg on
the disputed task's settlement and is not blocked. Accepted: the leg fees are
capped (`MAX_OPERATOR_FEE_BPS` / `MAX_REFERRER_FEE_BPS`, plus the combined cap),
so the conflict is worth at most a few percent of one escrow — below the
deterrence floor the slash system already prices. Enumerating every economic
relationship a resolver might hold is not tractable on-chain in v1.

## D11 — Quorum accept tombstones same-round revotes (V-2 wedge)

When a ValidatorQuorum vote accepts a submission, the submission closes, so a
validator who double-votes in the same round (vote → vote again after the
accept) finds the vote PDA re-initializable but the submission gone — the second
vote's accounting wedges on the tombstoned round. Accepted: the wedge only
bricks the double-voter's own revote (no funds at risk beyond that vote PDA's
rent), and the recovery path is the dispute apparatus. A per-round vote nonce
would remove it but adds an account to a hot path for no money-safety gain.

## D12 — Durable-submission dispute on an Open task with a closed claim has no exit

A dispute initiated against a durable submission (initiator supplies
`taskSubmission` but no live claim) on an Open task whose claim was already
closed is unexitable by both `resolve_dispute` and `expire_dispute` (they load
the claim). The F-12 preflight scanner (`scripts/preflight-dispute-scan.mjs`)
was extended to flag this shape; zero exist on mainnet. Any future dispute-lifecycle
change must re-run the scan first. Accepted because creation requires the
initiator to pay the dispute rent for a dispute that cannot settle — griefing
with negative yield and no victim.

## D13 — Proof-dependency gate is NOT added to the ghost/frozen exits

`complete_task` / `accept_task_result` / `auto_accept_task_result` /
`validate_task_result` all enforce `validate_task_dependency` (a Proof-dependent
task cannot settle before its parent completes). `distribute_ghost_share`,
`resolve_reject_frozen`, and `expire_reject_frozen` deliberately do NOT: they
are the SOLE exits for a ghosted contest or frozen task (`cancel_task` is
blocked by live submissions / the RejectFrozen status), so gating them on
parent completion could lock escrow permanently when a parent stalls —
violating money-never-locks (spec §7). The premature-payout risk is adjudicated
instead: the multisig resolver (frozen) can weigh the parent off-chain, and the
ghost crank only fires after the creator has already failed to act.

## D14 — The reputation side of a slash is partially dodgeable

Three accepted residuals from the 2026-07 re-review, all bounded and none newly
introduced:

- **Standing delegations survive a slash.** The C6 defendant gate stops
  *reactive* delegation during a dispute, but a delegation created BEFORE the
  dispute already moved the amount out of `agent.reputation` — and the
  delegation itself survives the slash and can be revoked back afterwards.
  Closing this requires revoking delegations at dispute initiation (an
  enumeration the program cannot do), so the deterrent is necessarily
  best-effort for pre-positioned adversaries.
- **Zero-stake defendants take no stake slash.** `calculate_slash_amount` caps
  at the current stake, so a defendant with 0 stake and no token reserve takes
  no lamport penalty — only the (fixed, saturating) reputation penalty and the
  defendant bookkeeping. The stake requirement at task/dispute entry is the
  real gate; the slash cannot retroactively create one.
- **The delegated reputation itself is unaffected by the slash.** A sybil
  delegatee keeps the bonus. Reputation is a friction signal (fee discounts,
  task gates), not custody — the bounded value at risk does not justify a
  global delegation-registry redesign in v1.

## D15 — resolve_dispute has no expiry bound (C2 deterrent is lifecycle-anchored)

The C2 initiator-slash guard holds deregistration for
`max(dispute_duration, voting_period) + SLASH_WINDOW` after initiation, but
`resolve_dispute` itself accepts a resolution for any still-`Active` dispute
with no deadline. A stale `Active` dispute resolved long after the guard window
lapses re-opens the initiator-slash brick (the initiator has already
deregistered). Accepted: it needs BOTH an unexpired-but-stale dispute (nobody
cranked the permissionless expiry) AND a late resolver, expiry by design never
slashes the initiator (full refund — an unadjudicated dispute cannot establish
fault), and the correct fix is a resolver-liveness policy, not another
timestamp patch. Related: disputes initiated before the C2 deploy have
`last_dispute_initiated == 0` and skip the guard entirely (no migration).

## D16 — Dispute expiry refunds a no-show's bonds (C1 trade)

`expire_dispute` refunds the creator's escrow in full AND refunds the no-show
worker's accepted-bid/completion bonds, because expiry cannot adjudicate
fault. A no-show can therefore self-dispute and, if the resolver never acts,
launder a certain forfeit (expire_claim would have slashed) into a refund.
Accepted: the alternative — slashing on expiry — victimized every
provably-submitted worker whenever the resolver ghosted, and resolver
inaction is the *expected* failure mode expiry exists for. The resolver is the
adjudicator; expiry is the escape hatch, and escape hatches must not
confiscate. A future refinement (forfeit the bond iff no live `Submitted`
submission exists at expiry) is possible but was deliberately not taken in v1.


