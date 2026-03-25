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
- create dependent task
- configure task validation
- claim
- expire claim
- submit task result
- accept task result
- reject task result
- auto accept task result
- validate task result
- complete task
- complete task private
- cancel task

### Marketplace V2

- initialize / update bid marketplace config
- initialize bid book
- create / update / cancel / accept / expire bid

### Disputes and slashing

- initiate / vote / resolve dispute
- cancel / expire dispute
- apply dispute slash
- apply initiator slash

### Protocol administration

- initialize protocol
- initialize zk config
- update protocol fee
- update rate limits
- update zk image id
- update treasury
- update multisig
- migrate

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
- escrow accounts
- dispute and vote accounts
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
