# Reviewed Design Decisions and Resolved Residuals

Dated 2026-07-18, after the three-pass 2026-07 audit and the full TODO.MD
hardening queue. Entries marked **Resolved** record the implemented invariant
and its regression boundary. The remaining entries are deliberate, reviewed
trade-offs rather than open findings. Read the rationale before proposing a
change: do not re-file a resolved path, and treat a change to an accepted
trade-off as a design decision.

## D1 — Resolved: canary `PendingValidation` has a permissionless timeout exit

The frozen 25-instruction canary still excludes `auto_accept_task_result` and the
dispute apparatus, but `accept_task_result` now has a shape-restricted timeout
branch. Before `review_deadline_at`, only the stored creator may accept. At or
after the deadline, any signer may crank acceptance while the existing writable
`operator` slot carries—and the handler revalidates—the stored creator as the
escrow-rent recipient. The branch is limited to the direct, single-worker,
SOL-only, dependency-free, affiliate-free task shape the canary can create. This
preserves the frozen account and instruction surface without leaving creator
silence as a permanent money lock.

## D2 — Resolved: Collaborative completing accepts have terminal straggler cleanup

Collaborative completing accepts no longer require the creator to reject every
peer submission first. A still-Submitted peer on the resulting Completed task can
be closed permissionlessly through `reclaim_terminal_claim`, which decrements the
validation and task counters and returns the claim and submission balances to the
worker. This prevents timeout acceptance from deadlocking when more workers
submit than the remaining completion slots. The sole-live-submission guard stays
in force for schema-1 non-Collaborative manual tasks; contest tasks retain their
separate temporal settlement rules.

## D3 — Resolved: schema-0 Collaborative stragglers have the same terminal exit

The completing-accept guard remains a no-op for schema-0 (pre-batch-3) tasks
because those accounts never maintained `live_submissions()`. That no longer
creates a permanent orphan: `reclaim_terminal_claim` accepts a canonical
still-Submitted Collaborative straggler after the task becomes Completed,
decrements the legacy validation counter, frees the task and worker slots, and
returns the claim and submission balances to the worker. The cleanup avoids
fabricating `live_submissions()` state on legacy accounts while preserving a
permissionless exit.

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
task with `completions > 0 && current_workers == 0` keeps its escrow funded and
leaves remaining slots available indefinitely for eligible claim attempts — not
a lock, by design. Each attempt must still pass every current task, worker,
config, protocol, dependency/hire, moderation, stake/reputation, prior-claim,
capacity, and funding gate. A deadline-free task is a standing offer; the creator
chose not to bound it. Creators who want an exit set a deadline.

## D6 — F-12 preflight result: zero legacy disputes on mainnet

`scripts/preflight-dispute-scan.mjs` (run 2026-07-18 against mainnet) found
3 Dispute accounts, all with `total_voters == 0` — no pre-P6.3 (arbiter-vote-era)
disputes exist, so no admin resolution path is needed for them. The scanner also
flags any ACTIVE dispute whose defendant claim PDA is closed/missing (the D12
shape) — zero of those exist either. Re-run the scan before any deploy that
touches the dispute lifecycle.

## D7 — Resolved: reclaim slash guard is omission-proof

The former F-2 residual is closed. Dispute resolution records pending worker
slash debt in the Task's existing reserved schema, and
`reclaim_terminal_claim` reads that mandatory task state directly. A caller can
no longer hide the debt by omitting an optional Dispute account. The dedicated
slash finalizer clears the flag only after the bound claim and slash state have
been revalidated.

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

## D9 — Resolved: governance stake stays locked through the election

`vote_proposal` records the proposal's voting deadline in the voter's lifecycle
guard, and deregistration requires that deadline plus the 24-hour cooldown to
elapse before returning registration stake. The same stake therefore cannot be
recycled through fresh wallet/agent pairs during one election. Each proposal
also snapshots its voter eligibility, vote cap, distinct-voter floor, approval
threshold, and hard quorum. Fee and rate-limit mutations additionally require
the current ProtocolConfig M-of-N signers; treasury spends require the treasury
custodian's signature.

## D10 — Resolved: settlement beneficiaries cannot resolve the dispute

The H-2 guard covers the task creator, defendant authority, and every active
operator/referrer leg snapshotted on the Task (with the canonical HireRecord
fallback for legacy hires). A roster member who can receive money from a
Complete/Split ruling cannot adjudicate that task. Unrelated off-chain economic
relationships remain outside the program's knowledge, but every on-chain payout
relationship available to the resolver is now enforced.

## D11 — Quorum accept tombstones same-round revotes (V-2 wedge)

When a ValidatorQuorum vote accepts a submission, the submission closes, so a
validator who double-votes in the same round (vote → vote again after the
accept) finds the vote PDA re-initializable but the submission gone — the second
vote's accounting wedges on the tombstoned round. Accepted: the wedge only
bricks the double-voter's own revote (no funds at risk beyond that vote PDA's
rent), and the recovery path is the dispute apparatus. A per-round vote nonce
would remove it but adds an account to a hot path for no money-safety gain.

## D12 — Resolved: every dispute binds a live claim and exitable task state

`initiate_dispute` now accepts only `InProgress` or `PendingValidation` tasks
with a represented live worker claim. A durable TaskSubmission cannot revive an
Open task or substitute for a closed claim. Worker-initiated disputes also
require a canonical live `Submitted` record, while both terminal exits require
the canonical TaskSubmission PDA as non-skippable evidence (live and swept, or
system-owned and empty). The preflight scanner still rejects any legacy account
with the old unexitable shape; the 2026-07-18 mainnet scan found none.

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

## D14 — Delegation shelter resolved; a depleted stake cannot be slashed twice

Revision 5 disables new reputation delegations before mutation and retains
`revoke_delegation` only as a permissionless retirement path. Retirement never
restores the parked reputation: a slash followed by restoration would recreate
the same shelter/evasion primitive. An identity-continuous record returns its
rent only to the authority stored on the original AgentRegistration; a closed or
re-registered identity returns rent only to the canonical protocol treasury.
The three fixed instruction metas and discriminator remain wire-compatible with
revision 4; the orphan branch appends exact `[ProtocolConfig, treasury]`
remaining accounts.

The mandatory cutover scan found zero ReputationDelegation accounts on mainnet.
Because deployed revision 4 did not pause-gate delegation, the upgrade rail scans
again after the candidate lands and refuses to stamp revision 5 while any raced
record remains. Every such record now has a deterministic, signer-independent
purge, so it can neither preserve slash-sheltered reputation nor permanently
block the cutover.

One arithmetic property remains by design: `calculate_slash_amount` caps the
lamport penalty at the worker's current registration stake. An identity whose
stake was already depleted to zero cannot lose the same principal twice; it
still takes the bounded reputation penalty and dispute bookkeeping. Fresh
registrations and dispute initiators must meet the configured non-zero stake
floors. New direct claims and bid creation/update/acceptance also require the
worker's current registration stake to meet `ProtocolConfig.min_agent_stake`,
so a previously slashed worker must replenish before accepting more work while
all already-open assignments retain their bounded lifecycle exits.

## D15 — Resolved: dispute resolution and expiry windows do not overlap

`resolve_dispute` now fails once the bounded resolution window closes, and
`expire_dispute` opens only after its grace boundary. A late resolver cannot
recreate slash obligations after the initiator's lifecycle guard has elapsed.
The preflight cutover rejects legacy Active disputes that cannot satisfy the
new lifecycle; the 2026-07-18 mainnet scan found zero Active disputes.

## D16 — Resolved: expiry penalizes only an objectively proven no-show

`expire_dispute` still returns all unadjudicated task principal to the creator,
but bond treatment is now evidence-bound. A worker bond is forfeited only when
the claim window has ended, the claim is incomplete, no canonical live
submission exists, and any Proof dependency was available. A live submission,
an unfinished dependency, or an unexpired claim forces a refund. The same
classification controls both accepted-bid and completion bonds, so a true
no-show cannot self-dispute to launder a certain forfeit while an honest worker
is never slashed merely because the resolver disappeared.

## D17 — Resolved: fee settlement cannot count a same-lifecycle transfer

Every active operator/referrer snapshot is now rejected if its payee aliases the
creator, Task PDA, or escrow PDA. The guard runs when terms are snapshotted and
again at normal, frozen, and dispute settlement, after applying the exact
Task-first/canonical-HireRecord fallback. The shared lamport primitive separately
rejects every positive same-account transfer before touching either balance, so
future call sites cannot count a net-zero withdrawal as distribution.

Operator and referrer may equal each other or a worker: those are potentially
legitimate overlapping marketplace roles, and each fee is still debited exactly
once from escrow. Zero-bps legacy payee values are also inert and remain valid.
Silently redirecting an immutable fee was rejected in favor of fail-closed
settlement. The 2026-07-18 mainnet scan decoded all 357 Tasks and their 62
HireRecords and found zero active creator/Task/escrow payee aliases, so the
hardened exit does not strand current state.

## D18 — Resolved: every Collaborative completion has a payable gross share

The shared Task initializer enforces the exact settlement precondition
`reward_amount >= required_completions` for Collaborative tasks. This applies in
the reward mint's native smallest unit and therefore covers both SOL and SPL
creation, including dependent tasks. The condition follows the actual quotient
and remainder share formula: equality gives every required worker one unit;
one unit below equality deterministically gives a later worker zero and is
rejected before escrow funding.

The revision-5 deployment rail repeats the same invariant against current state
and fails closed on malformed cardinality/PDA/layout bindings. The 2026-07-18
mainnet scan found one Collaborative Task, zero underfunded Collaborative Tasks,
and zero settlement blockers.

## D19 — Dispute liabilities are provenance-tagged and cannot age out

New disputes reuse the retired `Dispute.total_voters` byte as a `0xff`
provenance marker and the retired `AgentRegistration.active_dispute_votes` byte
as a checked pending-initiator-outcome counter. Initiation increments exactly
once; the permissionless finalizer decrements exactly once and fails closed if a
tagged dispute has no corresponding unit. Tagged rejected/cancelled outcomes are
slashable without expiry, while approved/expired outcomes finalize as financial
no-ops. This prevents cancel/deregister and historical cross-consumption races
without changing either account layout.

Historical zero-marker disputes retain their deployed behavior: only a rejected
or cancelled loss is finalizable, only inside the original seven-day window,
and it never decrements the new counter. No-fault or already-expired historical
records cannot be marked or penalized retroactively. Defendant registration
stake is likewise held by an exact `disputes_as_defendant == 0` deregistration
gate; the former `last_active + 7d` bypass was unsafe because dispute initiation
does not refresh the defendant's activity timestamp. The initiator's old finite
timestamp gate was removed once the checked provenance counter became
authoritative, so a fully finalized winner is not needlessly locked for 14 days.

The 2026-07-18 cutover scan decoded 208 AgentRegistration accounts: both
liability counters are zero on all of them. It found three zero-marker Cancelled
disputes and zero Active disputes. Two cancelled initiator flags remain unapplied
more than 35 days after resolution; they are expired under the deployed policy,
are inventoried rather than blocked, and the provenance split guarantees the
new binary cannot revive them. The resulting dispute cutover has zero blockers.

## D20 — Token task custody is the canonical classic-SPL ATA only

Checking only an SPL account's mint and token owner is insufficient. An attacker
can initialize an arbitrary token account, retain its close authority, and then
transfer token ownership to the TaskEscrow PDA. Accepting that account at task
creation makes custody undiscoverable to ATA-deriving clients and can block or
substitute terminal settlement.

Every token-task ingress, transfer, sweep, and close therefore derives and requires
the classic Token Program ATA for `(TaskEscrow PDA, reward mint)`. Validation also
runs inside the lowest-level transfer and close primitives, so a future caller
cannot bypass the binding by omitting a handler-level check. The mint must have no
freeze authority and the custody account must remain initialized and unfrozen.

This deliberately fails closed for any historical task funded into a noncanonical
account. The 2026-07-18 mainnet scan decoded all 357 Tasks and found zero token tasks,
so revision-5 introduces no live migration blocker. Unit tests cover ingress and
terminal substitution, and a LiteSVM regression constructs the attacker-retained
close-authority account and verifies task creation reverts without moving principal
or leaving task/escrow state behind.
