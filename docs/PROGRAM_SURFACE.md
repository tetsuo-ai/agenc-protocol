# Program Surface

This file describes the live on-chain surface owned by
`programs/agenc-coordination/`.

Mainnet status (verified 2026-07-22): the program
(`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, upgradeable; Squads v4 2-of-3
multisig custody) has run the full **101-instruction** revision-5 surface since
2026-07-22 (deployed executable SHA-256
`049a66e30da166c1e02ee379993425c32386f774fd9ff8861153e21900b496f2`).
`ProtocolConfig` is 351B with `surface_revision = 5`
(audit hardening). Singleton state: `BidMarketplaceConfig`, `ModerationConfig`,
and `GovernanceConfig` are INITIALIZED (sane params). Production has no
`ZkConfig` account and no private-ZK instructions. `complete_task_private`,
`initialize_zk_config`, and `update_zk_image_id` exist only in the explicit
`private-zk` development build.

Build breakdown (verified from `src/lib.rs`, Cargo features, and generated IDL):
default production (`spl-token-rewards`) is **101 instructions**, explicit
`private-zk` is **104**, and `mainnet-canary` is **25**. `validation-timings`
only shortens constants. `mainnet-canary` cannot combine with rewards or ZK. `lib.rs` therefore contains 129 raw `pub fn`
declarations across its mutually exclusive modules but 104 unique names; the
canary repeats 25 full-module names. Revision 5 retired the three private-ZK
entrypoints from production and added `reclaim_orphan_task_child` and the O(1)
bid-accept cranks. The canonical live IDL contains **101 instructions / 43
accounts / 102 events / 405 errors**; `docs/reference/INSTRUCTIONS.md` is its
generated instruction reference.

## Core Files

- `src/lib.rs` - exports every callable instruction
- `src/state.rs` - PDA/account structs and version constants
- `src/errors.rs` - program error codes (405 variants in the generated IDL)
- `src/events.rs` - emitted event types
- `src/instructions/*` - implementation by instruction family

## Instruction Families

The families below describe the 101-instruction live revision-5 production surface (the O(1) bid-accept redesign added `promote_bid`, `demote_ineligible_best`, and `settle_dispute_claim`; see docs/design/bid-accept-o1-redesign.md). The three
entries explicitly marked `private-zk development build only` are shown for
context and are excluded from that count. The batch-N subsections recall which
milestone introduced instructions already listed under their primary family.
Revision 5 has been live at 101 instructions since 2026-07-22 (superseding the
99-instruction revision 4).

### Agent lifecycle

- register
- update
- suspend / unsuspend
- deregister

### Task lifecycle

- create task
- create task humanless (wallet-only, no AgentRegistration; pins CreatorReview in the same tx)
- create dependent task
- set task job spec
- configure task validation (new `ValidatorQuorum` configs fail closed; `validate_task_result` remains for legacy quorum accounts)
- claim (legacy `claim_task` is permanently **fail-closed** — returns `TaskJobSpecRequired`; use `claim_task_with_job_spec`)
- expire claim
- submit task result
- request changes
- accept task result
- reject task result
- reject and freeze / resolve reject frozen / expire reject frozen (RejectFrozen exits)
- auto accept task result
- validate task result
- complete task
- complete task private (**private-zk development build only; absent from production**)
- cancel task
- close task (keep the Task PDA as a rent-exempt tombstone; refund surplus, children, and listing capacity)
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

### Store identity

- register / update / close store

### Goods market (revision 4)

- create / update goods listing
- purchase good (direct SOL or SPL token payment + permanent `SaleReceipt`)

### Moderation

- configure task moderation
- record task moderation
- record listing moderation
- assign / revoke moderation attestor (P6.8 roster; revoke scoped to `assigned_by` since P1.2)
- register moderation attestor (P1.2 — permissionless, bonded self-registration)
- request / finalize attestor exit (P1.2 — two-step, cooldown-gated, full bond refund)
- set / clear moderation block (P1.2 — multisig-gated BLOCK-only takedown floor, content-hash-keyed)
- set default trust list (P1.2 — multisig-gated pointer to the forkable default trusted-attestor list)
- moderation heartbeat (retunes/refreshes the liveness window)

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
| 5 (`AUDIT_HARDENING`) |                  **101** | audit hardening + O(1) bid-accept (LIVE 2026-07-22) |

Generated per-instruction reference: [`reference/INSTRUCTIONS.md`](./reference/INSTRUCTIONS.md).

## Ledger Clear-Signing Commitments

The live mainnet instruction ABI only lets a hardware wallet display values
that are present in signed transaction bytes.

- `create_task` carries reward, task id, deadline, worker caps, reputation gate,
  creator accounts, and a 64-byte description commitment directly. A direct task
  must contain a non-zero 32-byte digest followed by a zeroed 32-byte tail; human
  title/detail belongs in the pinned job spec. A revision-5 listing hire uses both
  halves: the advertised listing-spec hash followed by the buyer-specific task
  job-spec hash.
- Revision-5 `hire_from_listing` and `hire_from_listing_humanless` carry the
  required non-zero `task_job_spec_hash` directly and snapshot it before escrow
  funding.
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

- initiate / resolve dispute (resolved by the protocol authority with configured
  M-of-N approval or by an **assigned single resolver** — `vote_dispute` and the
  old arbiter-vote/quorum model were retired in P6.3; the dispute initiator can
  never resolve their own dispute)
- assign / revoke dispute resolver (authority-proposed, configured
  M-of-N-approved roster changes; an assigned resolver's later rulings do not
  require a per-case vote)
- cancel / expire dispute
- apply dispute slash
- apply initiator slash
- settle dispute claim (permissionless chunked collaborative-peer crank after a recorded ruling)

### Protocol administration

- initialize protocol
- initialize zk config (**private-zk development build only; absent from production**)
- update protocol fee
- update rate limits
- update zk image id (M-of-N multisig gated; **private-zk development build only**)
- update treasury
- update multisig
- update launch controls (pause / task-type disable kill switch)
- `stamp_release_surface` (atomically stamp the reviewed ProgramData/IDL/singleton/custody locks; this is how `surface_revision = 5` is written)
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
  (reputation >= 5200, account age >= 900s)

## PDA And State Families

The complete model lives in `src/state.rs`. Important state families include:

- protocol config (351B; `surface_revision` stamps the enabled surface — goods handlers enforce `surface_revision >= 4`)
- zk config (private-ZK development build only; absent on mainnet and from the
  production IDL)
- agent accounts
- task and claim accounts (Task remains 466B; `_reserved[0]`/`[1]` hold batch-3 `task_schema`/`live_submissions`, `[2]` is the deferred-slash flag, and `[3..11]` is the monotonic little-endian `claim_generation` used by watchers; zero generation preserves legacy fallback behavior)
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
