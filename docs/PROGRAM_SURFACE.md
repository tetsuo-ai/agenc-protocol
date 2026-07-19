# Program Surface

This file distinguishes the live on-chain surface from the current production
candidate owned by `programs/agenc-coordination/`.

Mainnet status (verified 2026-07-17): the program
(`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, upgradeable; Squads v4 2-of-3
multisig custody) has run the full **99-instruction** surface since 2026-07-09
(slot 431918664). `ProtocolConfig` is 351B with `surface_revision = 4`
(batch-4 goods). Singleton state: `BidMarketplaceConfig`, `ModerationConfig`,
and `GovernanceConfig` are INITIALIZED (sane params); `ZkConfig` is NOT
initialized, so `complete_task_private` is off and `initialize_zk_config` is
multisig-gated (audit H-5).

Candidate status (verified from `src/lib.rs`, Cargo features, and generated IDL on
2026-07-18): default production is **98 instructions**, explicit `private-zk` is
**101**, and `mainnet-canary` is **25**. `lib.rs` therefore contains 126 raw
`pub fn` declarations across its mutually exclusive modules but 101 unique names;
the canary repeats 25 full-module names. The candidate retires the three private-ZK
entrypoints from production and adds `reclaim_orphan_task_child`; it is not live
until an independently approved upgrade. The canonical candidate IDL contains
**98 instructions / 43 accounts / 99 events / 393 errors**;
`docs/reference/INSTRUCTIONS.md` is its generated instruction reference.

## Core Files

- `src/lib.rs` - exports every callable instruction
- `src/state.rs` - PDA/account structs and version constants
- `src/errors.rs` - program error codes (393 variants in the generated candidate IDL)
- `src/events.rs` - emitted event types
- `src/instructions/*` - implementation by instruction family

## Instruction Families

The families below describe the 98-instruction production candidate. The three
entries explicitly marked `private-zk development build only` are shown for
context and are excluded from that count. The batch-N subsections recall which
milestone introduced instructions already listed under their primary family.
Live revision 4 remains 99 instructions as described above.

### Agent lifecycle

- register
- update
- suspend / unsuspend
- deregister

### Task lifecycle

- create task
- create task humanless (wallet-only, no AgentRegistration)
- create dependent task
- set task job spec
- configure task validation
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
- close task (reclaim terminal-task rent)
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
- hire from listing / hire from listing humanless

### Store identity

- register / update / close store

### Goods market (revision 4)

- create / update goods listing
- purchase good (direct SOL payment + permanent `SaleReceipt`)

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

- moderation heartbeat (deadman for hosted attestor liveness)

### Contest tasks (batch-3)

- distribute ghost share (permissionless post-selection-window crank)
- reclaim terminal claim (permissionless janitor for stranded claims on
  terminal tasks)
- Contest rails are a **schema-1 Competitive + CreatorReview** conjunction on
  an existing task (entry deposit, selection window, cancel guard) — see
  [`design/batch-3-contest-tasks.md`](./design/batch-3-contest-tasks.md).

### Goods market (batch-4)

- create / update goods listing
- purchase good (direct-buy, rivalrous supply; per-unit `SaleReceipt`)
- Handlers require `surface_revision >= 4` (`require_goods_enabled`). See
  [`design/batch-4-goods.md`](./design/batch-4-goods.md).

## Surface revision summary

| `surface_revision` | Approx full-module ix | Milestone |
|--------------------|----------------------:|-----------|
| 0 | 25 (canary) / unstamped | conservative / unstamped |
| 1 (`FULL`) | 84 → 90 (P1.2 kept stamp 1) | Phase 9 full surface; P1.2 open roster |
| 2 (`BATCH2`) | 94 | store + heartbeat + referrer legs |
| 3 (`BATCH3`) | 96 | contest |
| 4 (`BATCH4`) | **99** | goods (revision-gated) |

Generated per-instruction reference: [`reference/INSTRUCTIONS.md`](./reference/INSTRUCTIONS.md).

## Ledger Clear-Signing Commitments

The live mainnet instruction ABI only lets a hardware wallet display values
that are present in signed transaction bytes.

- `create_task` carries reward, task id, deadline, worker caps, reputation gate,
  creator accounts, and a 64-byte description commitment directly. The description
  must contain a non-zero 32-byte digest followed by a zeroed 32-byte tail; human
  title/detail belongs in the pinned job spec.
- `set_task_job_spec` carries `job_spec_hash` and `job_spec_uri` directly.
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

### Disputes and slashing

- initiate / resolve dispute (resolved by the protocol authority or an **assigned single
  resolver** — `vote_dispute` and the old arbiter-vote/quorum model were retired in P6.3;
  the dispute initiator can never resolve their own dispute)
- assign / revoke dispute resolver (authority-curated roster)
- cancel / expire dispute
- apply dispute slash
- apply initiator slash

### Protocol administration

- initialize protocol
- initialize zk config (**private-zk development build only; absent from production**)
- update protocol fee
- update rate limits
- update zk image id (M-of-N multisig gated; **private-zk development build only**)
- update treasury
- update multisig
- update launch controls (pause / task-type disable kill switch)
- atomically stamp the reviewed release surface (ProgramData/IDL/singleton/custody locks)
- update min version
- update state
- migrate protocol / migrate task (Task/ProtocolConfig layout migration; multisig + version gated — the 2026-06-11 mainnet upgrade migrated 169 live tasks 382B→466B)

### Governance

- initialize governance
- create / vote / execute / cancel proposal

### Skills, reputation, and feed surfaces

- register / update skill
- purchase / rate skill
- stake / withdraw / delegate / revoke reputation
- post to feed / upvote post

## PDA And State Families

The complete model lives in `src/state.rs`. Important state families include:

- protocol config (351B; `surface_revision` stamps the enabled surface — goods handlers enforce `surface_revision >= 4`)
- zk config (private-ZK development build only; absent on mainnet and from the
  production candidate IDL)
- agent accounts
- task and claim accounts (Task is 466B since the 2026-06-11 migration of 169 legacy tasks from 382B; batch-3 schema-1 carves `task_schema`/`live_submissions` from `Task._reserved[0..2]`, schema-0 is legacy)
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
- `accept_bid` enforces the stored matching policy by requiring every other canonical open bid as an exact repeating `[TaskBid, AgentRegistration]` pair; a dependency parent, when present, is the first remaining-account prefix. Omitted, duplicate, closed, foreign, identity-substituted, and non-canonical accounts fail closed. Only bidders that still pass the selected bidder's live status, registration-stake floor, capability, current-reputation, and active-task-cap checks participate in ranking.
- `max_active_bids_per_task` is hard-capped at 20 so policy enforcement stays transaction-feasible. At that ceiling, an acceptance with a dependency uses 11 typed accounts + 1 parent + 19 bid/agent pairs = 50 instruction accounts (52 conservative transaction keys including program/compute-budget keys); clients should use a v0 transaction with an address lookup table when needed. Bond, cooldown, lifetime, and daily-bid configuration also have protocol ceilings; governance cannot configure unbounded or operationally bricking values.
- Accepted-bid settlement happens later through `bid_settlement_helpers` in task completion/cancellation/dispute flows, using appended `remaining_accounts`; private proof-dependent completion shifts that settlement suffix by one parent-task account.
- Closing an unaccepted bid returns its remaining lamports to the bidder authority by closing the bid account; accepted bids stay resident until settlement closes the accepted bid and either reopens or closes the bid book.

## Where To Edit

- add or route an instruction: `src/lib.rs` plus the matching file in `src/instructions/`
- add state or version fields: `src/state.rs`
- update emitted events: `src/events.rs`
- update error semantics: `src/errors.rs`

Use the file layout in `src/instructions/` as the real ownership guide instead of older condensed summaries.
