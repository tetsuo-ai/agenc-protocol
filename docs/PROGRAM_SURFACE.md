# Program Surface

This file summarizes the live on-chain surface owned by `programs/agenc-coordination/`.

## Core Files

- `src/lib.rs` - exports every callable instruction
- `src/state.rs` - PDA/account structs and version constants
- `src/errors.rs` - program error codes
- `src/events.rs` - emitted event types
- `src/instructions/*` - implementation by instruction family

## Instruction Families

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
- complete task private
- cancel task
- close task (reclaim terminal-task rent)

### Completion bonds (Exclusive + SOL, v1)

- post completion bond
- reclaim completion bond

### Service listings & hiring (embeddable marketplace)

- create / update service listing
- set service listing state
- hire from listing / hire from listing humanless

### Moderation

- configure task moderation
- record task moderation
- record listing moderation
- assign / revoke moderation attestor (P6.8 roster)

### Agent verification & ratings

- record / revoke agent verification
- rate hire

## Ledger Clear-Signing Commitments

The live mainnet instruction ABI only lets a hardware wallet display values
that are present in signed transaction bytes.

- `create_task` carries reward, task id, deadline, worker caps, reputation gate,
  and creator accounts directly.
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
- initialize zk config
- update protocol fee
- update rate limits
- update zk image id (M-of-N multisig gated)
- update treasury
- update multisig
- update launch controls (pause / task-type disable kill switch)
- update min version
- update state
- migrate protocol / migrate task (149-task layout migration; multisig + version gated)

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

- protocol config
- zk config
- agent accounts
- task and claim accounts
- task validation config, attestor config, submissions, and validation votes
- Marketplace V2 bid marketplace config, bidder market state, bid books, and bids
- escrow accounts and completion bonds
- dispute accounts and the dispute-resolver roster (the old DisputeVote / AuthorityDisputeVote PDAs were dropped with `vote_dispute` in P6.3)
- moderation config, task/listing moderation records, and the moderation-attestor roster
- service listings and hire records
- agent verification and hire-rating accounts
- governance config and proposals
- reputation and skill-related accounts

## Marketplace V2 Rent / Compute Notes

- `initialize_bid_book` allocates a `TaskBidBook`; `create_bid` allocates a `TaskBid` and, on a bidder's first bid, a `BidderMarketState`.
- `create_bid` also transfers the minimum bid bond into the `TaskBid` PDA, so rent + bond funding are both part of bidder-side cost.
- Matching policy and weighted-score config are stored on-chain for indexers and auditability, but `accept_bid` stays creator-driven and O(1): the instruction does not scan or rank competing bids on-chain.
- `max_active_bids_per_task`, bidder cooldown, and the 24-hour rate limit intentionally cap hot-task fanout and keep create/expire paths bounded in compute and account churn.
- Accepted-bid settlement happens later through `bid_settlement_helpers` in task completion/cancellation/dispute flows, using appended `remaining_accounts`; private proof-dependent completion shifts that settlement suffix by one parent-task account.
- Closing an unaccepted bid returns its remaining lamports to the bidder authority by closing the bid account; accepted bids stay resident until settlement closes the accepted bid and either reopens or closes the bid book.

## Where To Edit

- add or route an instruction: `src/lib.rs` plus the matching file in `src/instructions/`
- add state or version fields: `src/state.rs`
- update emitted events: `src/events.rs`
- update error semantics: `src/errors.rs`

Use the file layout in `src/instructions/` as the real ownership guide instead of older condensed summaries.
