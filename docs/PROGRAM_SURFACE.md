# Program Surface

This file records the deployed surface owned by
`programs/agenc-coordination/`.

Mainnet status (verified 2026-11-21): the program
(`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, upgradeable; Squads v4 2-of-3
multisig custody) has run the full **106-instruction** revision-9 surface since
2026-11-21 (deployment slot 472177819 at 14:47:17 UTC, normalized executable
hash `baf5be55c86f0a5c79eb52229a3412121a1a3c5f2a5699f4b24d75c7e8dc3608`). The
atomic revision stamp landed at 14:55:39 UTC while the protocol was paused, and
the protocol reopened at 19:19:26 UTC. `ProtocolConfig` is 351B with
`surface_revision = 9` (accountable review). Singleton state:
`BidMarketplaceConfig`, `ModerationConfig`, and `GovernanceConfig` are
INITIALIZED (sane params). Production has no `ZkConfig` account and no
private-ZK instructions. `complete_task_private`, `initialize_zk_config`, and
`update_zk_image_id` exist only in the explicit `private-zk` development build.
The deployment record is [`MAINNET_MAINLINE.md`](./MAINNET_MAINLINE.md).

Earlier mainnet surfaces, kept as history: the 104-instruction revision 8
(`surface_revision = 8`, normalized executable hash `ffb8f3cb…`) was live from
2026-10-28 to 2026-11-21, the 101-instruction revision 5 (`surface_revision = 5`,
executable SHA-256 `049a66e3…`) from 2026-07-22 to 2026-10-28, and the
99-instruction revision 4 from 2026-07-09 to 2026-07-22. Revisions 6 and 7 were
never stamped on mainnet on their own; their surfaces are part of revision 8.

Build breakdown (revision 9, live): default production (`spl-token-rewards`)
is **106 instructions**, explicit `private-zk` is **109**, and `mainnet-canary`
remains **25**. The committed IDL (`artifacts/anchor/idl/agenc_coordination.json`,
SHA-256 `89ed7a9219bffc71178c7111497162efddff4e2bfc6cb2ed43a162bc64bebd8a`) has
**106 instructions / 49 accounts / 117 events / 435 errors** (the `TaskMarker`
account entry is added by the artifacts sync, see
`scripts/anchor-idl-task-marker.mjs`). The on-chain IDL was published from it,
and the generated reference describes it. `validation-timings` only shortens
constants; `mainnet-canary` cannot combine with rewards or ZK.

Revision 6 adds `upvote_post_by_authority`, a receipt keyed by
wallet authority and post, and the SDK capability `feedAuthorityVotes`. It
retires legacy `upvote_post` writes while retaining historical reads. Only the
new `wallet_upvote_count` participates in prospective wallet ranking; the
legacy count is preserved separately. The [design](design/authority-feed-votes.md)
and [release contract](VERSIONING.md) describe compatibility and deployment gates.
It reached mainnet as part of revision 8 on 2026-10-28.

Revision 7 additionally exposes `configure_task_creation_quota`
and optional per-wallet u32 task capacity on all five creation paths. The
legacy account layouts and default cap remain unchanged; extra capacity needs
M-of-N approval and the `taskCreationQuotas` capability. See the
[quota design and adversarial review](design/authority-task-quotas.md). It also
reached mainnet as part of revision 8.

Revision 8 (live on mainnet from 2026-10-28 to 2026-11-21) requires evidence of
at least 100,000 SOL protocol-fee lamports for new listing/skill ratings. It
consumes one previously zero reserved byte each in Task and PurchaseRecord,
preserving allocation and wire shape. The
`feeQualifiedRatings` capability describes the new semantics; historical
aggregates are not retrospectively filtered. See [rating policy](design/fee-qualified-ratings.md).

Revision 9 (accountable review, `surface_revision = 9`) is live on mainnet since
2026-11-21. It adds `dispute_rejection` and `release_claim`,
replaces `hire_from_listing` v2 with v3, and changes account lists on existing
instructions; [Revision 9 notes](#revision-9-notes) below list what it does and
its known limits.

## Core Files

- `src/lib.rs` - exports every callable instruction
- `src/state.rs` - PDA/account structs and version constants
- `src/errors.rs` - program error codes (435 variants in the committed IDL)
- `src/events.rs` - emitted event types
- `src/instructions/*` - implementation by instruction family

## Instruction Families

The families below describe the 106-instruction revision-9 production surface,
live on mainnet since 2026-11-21: the 101 revision-5 instructions (the O(1)
bid-accept redesign added `promote_bid`, `demote_ineligible_best`, and
`settle_dispute_claim`; see docs/design/bid-accept-o1-redesign.md), plus
`upvote_post_by_authority` (revision 6), `configure_task_creation_quota`
(revision 7), `repair_dispute_initiator_counter` (revision 8), and
`dispute_rejection` and `release_claim` (revision 9). The three
entries explicitly marked `private-zk development build only` are shown for
context and are excluded from that count. The batch-N subsections recall which
milestone introduced instructions already listed under their primary family.
Revision 5 was live at 101 instructions from 2026-07-22 to 2026-10-28
(superseding the 99-instruction revision 4), and revision 8 at 104 from
2026-10-28 to 2026-11-21.

### Agent lifecycle

- register
- update
- suspend / unsuspend (2 of the 3 owners since revision 9)
- deregister

### Task lifecycle

- create task
- create task humanless (wallet-only, no AgentRegistration; pins CreatorReview in the same tx)
- create dependent task
- set task job spec
- configure task validation (new `ValidatorQuorum` configs fail closed; `validate_task_result` remains for legacy quorum accounts)
- claim (legacy `claim_task` is permanently **fail-closed** — returns `TaskJobSpecRequired`; use `claim_task_with_job_spec`)
- expire claim
- release claim (revision 9: the worker gives back an undelivered claim; within
  one hour of the claim its deposit comes back)
- submit task result
- request changes
- accept task result
- reject task result
- reject and freeze / dispute rejection (revision 9: the worker disputes the
  freeze once, with a bond) / resolve reject frozen / expire reject frozen
  (RejectFrozen exits)
- auto accept task result
- validate task result
- complete task
- complete task private (**private-zk development build only; absent from production**)
- cancel task
- close task (close supplied children, free hired-listing capacity, and compact
  the terminal Task into a 56-byte `TaskMarker` at the same address, refunding
  the rest of its rent to the creator; before revision 9 the Task PDA stayed as
  a rent-exempt tombstone)
- distribute ghost share (permissionless contest fallback after the selection window)
- reclaim terminal claim (return residual claim rent after a contest/task terminates)
- reclaim orphan task child (return rent for a canonically bound abandoned child,
  including `TaskValidationVote`, to its stored payer only after the exact parent is absent)

### Completion bonds (Exclusive + SOL, v1)

- post completion bond
- reclaim completion bond

### Service listings & hiring (embeddable marketplace)

- create / update service listing
- set service listing state
- hire from listing / hire from listing humanless (humanless pins CreatorReview in the same tx)

AGNC-02 follow-up (live on mainnet since revision 8, 2026-10-28):
settlement no longer reverts on a marketplace payee it can address but cannot
credit. The runtime rejects a transaction that leaves a credited account below
`Rent::minimum_balance(data_len)`, so a fee smaller than that floor (650,240
lamports for a 0-byte wallet at mainnet rent), owed to an unfunded or
rent-paying payee, made every payout fail with `InsufficientFundsForRent` until
someone funded the payee. Every settlement path (complete/accept/auto-accept,
frozen-rejection exits, dispute Complete/Split, contest ghost shares) now pays
such a leg to the worker instead and emits `MarketplaceFeeForfeited` in place of
`OperatorFeePaid` / `ReferrerFeePaid`. Both legs are carved from the worker's
share, so creator refunds, the protocol fee and escrow totals are unchanged.
Only the payee can lower its own balance, so nobody else can force a forfeit,
and anyone can fund the payee before settlement to have it paid. The payee
account is still required and bound to the snapshot. Operators and referrers
must keep their payout address rent-exempt. No instruction, account or error
changes; the IDL gains one event.

Dispute counter repair (revision 8; used once on mainnet on 2026-10-28):
`repair_dispute_initiator_counter` restores one initiator-outcome counter unit
that a historical `initiate_dispute` lost when the same AgentRegistration was
passed as both `agent` and `worker_agent` (now rejected at initiation). It
applies only when the initiator's counter is zero while a finalizable,
counter-tracked outcome of that initiator is still pending, so it cannot create
a liability the agent does not owe. The protocol authority proposes, the
ProtocolConfig M-of-N owners approve, and a `DisputeCounterRepair` receipt PDA
seeded by the incident dispute makes it one-time. The ordinary permissionless
`apply_initiator_slash` then finalizes the outcome. The known mainnet incident
and the release order are recorded in
[the remediation record](../artifacts/remediation/2026-10-21-dispute-counter-repair.json)
and [the design note](design/dispute-counter-repair.md). The revision-8 ceremony
repaired that incident (receipt `3aDqSrQjpR68Jt5ksCb239DXtTFMjLGZSZJPh5s8vL6G`).
The repair rail is revision 8 only and refuses the revision-9 IDL.

### Store identity

- register / update / close store

### Goods market (revision 4)

- create / update goods listing
- purchase good (direct SOL or SPL token payment + permanent `SaleReceipt`)

### Moderation

- configure task moderation (2 of the 3 owners since revision 9)
- record task moderation
- record listing moderation
- assign / revoke moderation attestor (P6.8 roster; revoke scoped to `assigned_by` since P1.2; 2 of the 3 owners since revision 9)
- register moderation attestor (P1.2 — permissionless, bonded self-registration)
- request / finalize attestor exit (P1.2 — two-step, cooldown-gated, full bond refund)
- set / clear moderation block (P1.2 — multisig-gated BLOCK-only takedown floor, content-hash-keyed)
- set default trust list (P1.2 — multisig-gated pointer to the forkable default trusted-attestor list)
- moderation heartbeat (retunes/refreshes the liveness window; window changes need 2 of the 3 owners since revision 9)

Since P1.2 the moderation records are **moderator-keyed** (`["task_moderation_v2",
task, hash, moderator]` + the listing mirror), the three consumption gates
(`set_task_job_spec`, `hire_from_listing`, `hire_from_listing_humanless`) take an
explicit `moderator` argument and a required handler-derived
`["moderation_block", hash]` account, and agent verification is gated on the
global moderation authority only. Task/listing consumption accepts the configured
authority or an active, non-revoked/non-exiting bonded roster attestor. If the
moderation heartbeat goes stale, the ALLOW-record requirement relaxes; the BLOCK
floor remains unconditional. See `P1_2_OPEN_ROSTER_SPEC.md` and
`MODERATION_LIVENESS.md`.

While the liveness gate is strict, `ModerationConfig.enabled = false` rejects
both listing-hire instructions before funding, just as it rejects job-spec
publication. Existing deposits remain cancellable and existing claims remain
settleable. After the liveness window elapses, hire and publication both relax
their ALLOW gate regardless of `enabled`; the BLOCK floor always applies and
an authority heartbeat re-arms the strict path.

### Agent verification & ratings

- record / revoke agent verification
- rate hire

### Store identity (batch-2)

- register / update / close store (`Store` PDA, address-keyed display handle)

### Moderation liveness (batch-2)

- moderation heartbeat (deadman on protocol/moderation-authority silence; not a per-attestor heartbeat)

### Contest tasks (batch-3)

- distribute ghost share (permissionless post-selection-window crank)
- reclaim terminal claim (permissionless janitor for stranded claims on
  terminal tasks)
- Contest rails are a **schema-1 Competitive + CreatorReview** conjunction on
  an existing task (entry deposit, selection window, cancel guard). There is no
  on-chain `create_contest_task`; the SDK `createContestTask` facade composes
  `create_task` + `configure_task_validation`. See
  [`design/batch-3-contest-tasks.md`](./design/batch-3-contest-tasks.md).

### Goods market (batch-4)

- create / update goods listing
- purchase good (direct-buy, rivalrous supply; per-unit `SaleReceipt`)
- Handlers require `surface_revision >= 4` (`require_goods_enabled`). See
  [`design/batch-4-goods.md`](./design/batch-4-goods.md).

## Surface revision summary

| `surface_revision` |       Approx full-module ix | Milestone                              |
| ------------------ | --------------------------: | -------------------------------------- |
| 0                  |     25 (canary) / unstamped | conservative / unstamped               |
| 1 (`FULL`)         | 84 → 90 (P1.2 kept stamp 1) | Phase 9 full surface; P1.2 open roster |
| 2 (`BATCH2`)       |                          94 | store + heartbeat + referrer legs      |
| 3 (`BATCH3`)       |                          96 | contest                                |
| 4 (`BATCH4`)       |                          99 | goods (revision-gated)                 |
| 5 (`AUDIT_HARDENING`) |                      101 | audit hardening + O(1) bid-accept (live 2026-07-22 to 2026-10-28) |
| 6 (`AUTHORITY_FEED`) |                       102 | wallet feed votes (never stamped on its own; part of revision 8) |
| 7 (`TASK_QUOTAS`)  |                         103 | opt-in task quotas (never stamped on its own; part of revision 8) |
| 8 (`FEE_QUALIFIED_RATINGS`) |                104 | fee-qualified ratings (live 2026-10-28 to 2026-11-21) |
| 9 (`ACCOUNTABLE_REVIEW`) |                **106** | accountable review (LIVE since 2026-11-21) |

Generated per-instruction reference: [`reference/INSTRUCTIONS.md`](./reference/INSTRUCTIONS.md).

## Ledger Clear-Signing Commitments

The live mainnet instruction ABI only lets a hardware wallet display values
that are present in signed transaction bytes.

- `create_task` carries reward, task id, deadline, worker caps, reputation gate,
  creator accounts, and a 64-byte description commitment directly. A direct task
  must contain a non-zero 32-byte digest followed by a zeroed 32-byte tail; human
  title/detail belongs in the pinned job spec. Since revision 5, a listing hire
  uses both halves: the advertised listing-spec hash followed by the
  buyer-specific task job-spec hash.
- Since revision 5, `hire_from_listing` (v3 since revision 9) and
  `hire_from_listing_humanless` carry the required non-zero
  `task_job_spec_hash` directly and snapshot it before escrow funding.
- `set_task_job_spec` carries `job_spec_hash` and `job_spec_uri` directly and,
  for a listing hire, requires the hash to equal the immutable second-half
  commitment. Direct tasks retain the canonical zero-tail convention.
- `submit_task_result` carries `proof_hash` and optional `result_data`; the kit
  artifact encoder commits artifact results as `artifact:sha256:*`.
- `claim_task_with_job_spec` verifies the on-chain `TaskJobSpec` account, but
  does not carry `job_spec_hash` or `job_spec_uri` in instruction data.
- `accept_task_result` and `cancel_task` settle from task/escrow account state,
  but do not carry reward/refund amounts in instruction data.

If Ledger must display claim job-spec hashes or settlement reward/refund amounts
as trusted device fields, add a protocol-level commitment to those instructions
or introduce a new signed settlement evidence instruction. Do not have the kit
or Ledger app infer those values from off-chain state and present them as if
they were signed instruction data.

### Marketplace V2

- initialize / update bid marketplace config
- initialize bid book
- create / update / cancel / accept / expire bid
- promote bid / demote ineligible best (permissionless O(1) winner-cache cranks)

### Disputes and slashing

- initiate / resolve dispute (resolved by an **assigned single resolver** who
  holds no stake in the dispute, or by a direct ruling that 2 of the 3 owners
  approve; since revision 9 any wallet may propose the direct ruling, and every
  filing posts a `DisputeBond`. `vote_dispute` and the old arbiter-vote/quorum
  model were retired in P6.3; the dispute initiator can never resolve their own
  dispute)
- assign / revoke dispute resolver (authority-proposed, configured
  M-of-N-approved roster changes; an assigned resolver's later rulings do not
  require a per-case vote)
- cancel / expire dispute
- apply dispute slash
- apply initiator slash
- settle dispute claim (permissionless chunked collaborative-peer crank after a recorded ruling)
- repair dispute initiator counter (revision 8; one-time per incident, see the
  dispute counter repair note above)

AGNC-01 terminal claim reservation (live on mainnet since revision 8,
2026-10-28): when a ruling
or expiry defers peers, `Task._reserved[11]` reserves their claims for
`settle_dispute_claim`. Generic `reclaim_terminal_claim` rejects them with
`ClaimSettlementPending` until the last peer settles and clears the reservation.
The existing worker-slash reservation is independent. This uses existing padding;
Task remains 466 bytes and instruction accounts/arguments are unchanged. See
[`VALIDATION.md`](./VALIDATION.md#agnc-01-terminal-claim-reservation) for cutover
requirements, including disputes created before the reservation existed.

### Protocol administration

- initialize protocol
- initialize zk config (**private-zk development build only; absent from production**)
- update protocol fee
- update rate limits
- update zk image id (M-of-N multisig gated; **private-zk development build only**)
- update treasury
- update multisig
- update launch controls (pause / task-type disable kill switch)
- configure task creation quota (revision 7; multisig-approved per-wallet u32 task capacity)
- `stamp_release_surface` (atomically stamp the reviewed ProgramData/IDL/singleton/custody locks; this is how the current revision is written: `surface_revision = 9` on 2026-11-21, after 8 on 2026-10-28 and 5 on 2026-07-22)
- update min version
- update state
- migrate protocol (349B→351B, multisig; realloc-only when `target_version` equals current) / migrate task (382B or 432B→466B, multisig, version-ungated). The 2026-06-11 upgrade migrated 169 live tasks.

### Governance

- initialize governance
- create / vote / execute / cancel proposal

### Skills, reputation, and feed surfaces

- register / update skill
- purchase / rate skill (`rate_skill` requires `author_agent` and rejects
  wallet-level self-rating)
- stake / withdraw reputation
- `delegate_reputation` always returns `ReputationDelegationDisabled`
- `revoke_delegation` is a permissionless rent reclaim and does not restore reputation
- post to feed (reputation >= 5500, account age >= 3600s) / upvote post
  (reputation >= 5200, account age >= 900s; legacy `upvote_post` writes fail
  closed since revision 8)
- upvote post by authority (revision 6: one vote per wallet authority, excluding
  every agent of the author's wallet)

## PDA And State Families

The complete model lives in `src/state.rs`. Important state families include:

- protocol config (351B; `surface_revision` stamps the enabled surface — goods handlers enforce `surface_revision >= 4`)
- zk config (private-ZK development build only; absent on mainnet and from the
  production IDL)
- agent accounts
- task and claim accounts (Task remains 466B; `_reserved[0]`/`[1]` hold batch-3 `task_schema`/`live_submissions`, `[2]` is the deferred-slash flag, and `[3..11]` is the monotonic little-endian `claim_generation` used by watchers; zero generation preserves legacy fallback behavior; since revision 9 `close_task` compacts a terminal Task into a 56-byte `TaskMarker` at the same address)
- creator and worker records (`CreatorStats`, new in revision 9, and `AgentStats`), dispute bonds (`DisputeBond`, revision 9), wallet feed vote receipts (`FeedAuthorityVote`, revision 6), per-wallet task quotas (`AuthorityTaskQuota`, revision 7), and the one-time `DisputeCounterRepair` receipt (revision 8)
- task validation config, attestor config, submissions, and validation votes
- Marketplace V2 bid marketplace config, bidder market state, bid books, and bids
- escrow accounts and completion bonds
- dispute accounts and the dispute-resolver roster (the old DisputeVote / AuthorityDisputeVote PDAs were dropped with `vote_dispute` in P6.3)
- moderation config, task/listing moderation records (v2 moderator-keyed since P1.2), the moderation-attestor roster (bonded since P1.2), the `ModerationBlock` takedown floor, and the `DefaultTrustList` pointer
- service listings and hire records
- store identity accounts
- goods listings and permanent sale receipts
- agent verification and hire-rating accounts
- store identity (`Store` PDA)
- goods listings and per-unit sale receipts
- governance config and proposals
- reputation and skill-related accounts

## Marketplace V2 Rent / Compute Notes

- `initialize_bid_book` allocates a `TaskBidBook`; `create_bid` allocates a `TaskBid` and, on a bidder's first bid, a `BidderMarketState`.
- `create_bid` also transfers the minimum bid bond into the `TaskBid` PDA, so rent + bond funding are both part of bidder-side cost.
- `accept_bid` is O(1): the book tracks its policy winner incrementally, and acceptance requires that tracked winner with exact cached-component equality. It does not enumerate competing bids. The only remaining account is an optional dependency parent; extra remaining accounts fail closed. Winner exits open a re-promotion grace window served by permissionless `promote_bid` / `demote_ineligible_best`. See [design/bid-accept-o1-redesign.md](./design/bid-accept-o1-redesign.md).
- `max_active_bids_per_task` is a state/spam cap (hard-capped at 20). It is not a wire-size bound for `accept_bid`. Bond, cooldown, lifetime, and daily-bid configuration also have protocol ceilings; governance cannot configure unbounded values.
- Accepted-bid settlement happens later through `bid_settlement_helpers` in task completion/cancellation/dispute flows, using appended `remaining_accounts`. In the `private-zk` development build only, private proof-dependent completion shifts that settlement suffix by one parent-task account.
- Closing an unaccepted bid returns its remaining lamports to the bidder authority by closing the bid account; accepted bids stay resident until settlement closes the accepted bid and either reopens or closes the bid book.

## Where To Edit

- add or route an instruction: `src/lib.rs` plus the matching file in `src/instructions/`
- add state or version fields: `src/state.rs`
- update emitted events: `src/events.rs`
- update error semantics: `src/errors.rs`

Use the file layout in `src/instructions/` as the real ownership guide instead of older condensed summaries.

## Revision 9 notes

What revision 9 changes, in brief:

- **Turn-downs.** A single-worker review task (Exclusive, one worker,
  CreatorReview) is refused only with `reject_and_freeze`; `reject_task_result`
  refuses it (`SingleWorkerRejectMustFreeze`). The freeze opens a fixed 72-hour
  dispute window. The worker may dispute once with `dispute_rejection`, posting a
  bond of max(10% of the price, 0.01 SOL); the 2-of-3 multisig then has 72 hours
  to rule with `resolve_reject_frozen` (new discriminator). Without a dispute the
  buyer is refunded after the window; a dispute left unruled refunds the buyer
  and returns the bond. A suspended worker cannot dispute; a Busy or Inactive one
  can. Freezes made before revision 9 keep their revision 8 rules.
- **Task disputes.** Every filing posts a bond (`DisputeBond`). A ruling against
  the filer, or the filer's own cancel, sends the principal to the other side;
  otherwise it comes back. The bond's rent always goes back to the filer. A
  ruling comes from a seated resolver, who must hold no stake in it, or from 2
  of the 3 owners: any wallet may propose that direct ruling, and owners who
  are the creator or the worker wallet do not count toward its threshold. The
  initiator never rules. Once any dispute has been filed on the task, by either
  side, the creator cannot file against any lapsed claim, whenever it lapsed
  (`ClaimExpired`). The creator still has `cancel_task` after the deadline and
  `expire_claim`, and both refund the deposit after a filing. When the direct
  ruling's proposer is not an owner, list only the approving owners in
  remaining accounts: any other signer reaches the payout parser and the
  ruling fails closed (`DisputePeerBundlesRetired` or `InvalidInput`).
  `initiate_dispute` refuses a dispute on a single-worker review task from
  either side (`DisputeRefusedOnReviewTask`): the buyer freezes and the worker
  disputes the freeze. The program reads only the Task there (Exclusive, one
  worker, manual validation), so the refusal also covers single-worker tasks in
  the closed legacy modes (ValidatorQuorum, ExternalAttestation); none is in a
  disputable state on mainnet.
- **Records.** Each creator wallet has a `CreatorStats` record and each worker
  an `AgentStats` record. A dispute counts as won or lost by its ruling, not by
  who filed it. An approved Split, a worker's approved Refund filing and a
  creator's approved Complete filing move no record.
- **Claim deposits.** A non-contest, non-bid claim posts max(10% of the worker
  share, 0.005 SOL). It comes back at the first delivery, or with
  `release_claim` within one hour of the claim. A later release, or a no-show
  (`expire_claim`, the cancel drain, an unruled dispute filed after the claim
  lapsed), forfeits it to the buyer, with these exceptions: once a dispute was
  filed on the task it always comes back; a no-show on a task whose parent does
  not prove Completed keeps it; the cancel drain returns it while the claim is
  inside its one-hour grace; and a Competitive claim that lost the race on a
  completed task gets it back. A settled dispute peer's claim, rent and deposit,
  closes to its own wallet.
- **Agent buyers.** `hire_from_listing` v3 gives agent-door hires creator review.
- **Kept cost.** `close_task` compacts a finished (Completed or Cancelled) task
  into a 56-byte `TaskMarker` at the same address and refunds the rest of its
  rent to the creator; children of a compacted parent keep working. A settled
  escrow left out of that call is closed to the creator by `close_task` on the
  marker.
- **One key.** Turning moderation on or off, choosing the moderator, suspending
  and unsuspending an agent, the moderation attestor roster and heartbeat window
  changes need 2 of the 3 owners. A task creator cannot moderate its own task,
  and a provider cannot moderate its own listing.
- **Closed for new tasks.** ExternalAttestation validation, and CreatorReview on
  token-reward and bid tasks.

Known limits, carried to revision 10 or left to clients:

- **Squatting is not priced.** A worker can release inside the one-hour grace
  and claim again, keeping a slot for transaction fees only; the deposit prices
  abandonment past the grace, not squatting. On a task with a deadline the hold
  ends at the deadline (revision 8: one hour after it). A dependent task created
  without a deadline can be held indefinitely, in revision 8 too, because an
  InProgress task without a deadline cannot be cancelled. Listed for revision 10.
- **A worker's filing also protects a lapsed peer.** Peer settlement after a
  dispute always returns a peer's claim, deposit included, to the peer, even
  when the peer's claim had lapsed before anyone filed. So a worker that files
  (it needs a delivery under review) keeps the deposit of a peer whose claim
  lapsed just before, for example another agent of the same operator. It costs
  the filer the Dispute rent, and its bond if the ruling goes against it.
  Listed for revision 10: pass the creator to peer settlement and apply the
  no-show rule to peers.
- **Resolver roster changes still need the protocol authority as proposer.**
  `assign_dispute_resolver` and `revoke_dispute_resolver` need 2 of the 3
  owners, and only `ProtocolConfig.authority` may propose them. Rulings no
  longer depend on that key (any wallet may propose a direct ruling), and no
  resolver is seated on mainnet. Listed for revision 10.
- **Events name the proposer.** `TaskModerationConfigUpdated.authority`,
  `AgentSuspended.authority`, `AgentUnsuspended.authority`,
  `ModerationAttestorAssigned.assigned_by` and `ModerationAttestorRevoked.revoked_by`
  now hold the wallet that sent the 2-of-3 transaction, which can be any wallet.
  So do `Dispute.resolved_by` and `DisputeResolved.resolved_by` on a direct
  ruling; their IDL docs still say "the wallet that decided" until the next
  IDL change.
  The approving owners appear in no event: indexers and the audit trail read
  them from the transaction's signers.
- **Appended optional accounts need the placeholder.** On the revision 9 wire a
  plain `moderation_heartbeat` with the two revision 8 accounts fails
  `AccountNotEnoughKeys` (3005): the appended optional `protocol_config` must be
  passed, as the program ID placeholder when it is not used. The revision 9 SDK
  does this; every heartbeat sender must move to it. The same holds for the
  appended optional `creator_stats` of `expire_claim`.
- **An overturned freeze still counts as a rejection.** `tasks_rejected` (worker)
  and `rejections` (creator) count every freeze, including one a ruling later
  overturned; `disputes_won` and `disputes_lost` show the outcome. Clients should
  not read `tasks_rejected` alone as a bad mark.
- **First records are paid first.** A creator's first freeze or cancel pays its
  `CreatorStats` rent (1,305,560 lamports at mainnet rent) before the escrow
  refund, a worker's first claim pays its `AgentStats` (1,264,920), and a
  cranker of `expire_reject_frozen`, `expire_dispute` or `expire_claim` pays for
  a missing record. A wallet that cannot cover it plus fees must add SOL first;
  clients show the cost.
- **Deposit events.** `ClaimDepositSettled` reports every claim deposit that
  moves (forfeited or refunded, the recipient and the amount). Rent left on an
  old-rate claim above today's minimum is not a deposit and emits none.
  `TerminalClaimReclaimed.forfeited` reports lamports sent to the creator or the
  treasury; indexers read `ClaimDepositSettled` for deposits.
- **Collaborative review tasks** keep reject, then cancel.
