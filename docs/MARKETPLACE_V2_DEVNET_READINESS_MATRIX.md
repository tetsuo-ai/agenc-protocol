# Marketplace V2 Devnet Readiness Matrix

Status: In progress (`17` pass, `0` fail, `1` remaining)

Issue: [agenc-protocol#17](https://github.com/tetsuo-ai/agenc-protocol/issues/17)

Related docs:
- [./MARKETPLACE_V2_BID_PROTOCOL.md](./MARKETPLACE_V2_BID_PROTOCOL.md)
- [./PROGRAM_SURFACE.md](./PROGRAM_SURFACE.md)
- [./VALIDATION.md](./VALIDATION.md)
- [../artifacts/devnet-readiness/readiness-report.json](../artifacts/devnet-readiness/readiness-report.json)
- [../artifacts/devnet-readiness/VALIDATION_DEPLOYMENT_SPEC_20260327.md](../artifacts/devnet-readiness/VALIDATION_DEPLOYMENT_SPEC_20260327.md)

## Current Status

As of `2026-03-27`, the validation effort is no longer in draft state.

- Shared-devnet green evidence remains the baseline for `DV-01`, `DV-02`, `DV-03A/B/C/D`, `DV-04A/B`, `DV-06A/B`, and `DV-09`.
- The dedicated validation deployment cleared the previously red timing-sensitive scenarios `DV-05`, `DV-07A`, `DV-07B`, `DV-07C`, `DV-08A`, and `DV-08B`.
- The only remaining open scenario is `DV-03E`, which still needs a proof fixture or live prover aligned to the validation deployment's active zk image ID.
- The current source of truth is [../artifacts/devnet-readiness/readiness-report.json](../artifacts/devnet-readiness/readiness-report.json), which records `17` pass and `1` not-run scenario.

## Purpose

This document is the protocol-owned Phase 1 output for issue #17. It freezes the minimum devnet
test matrix for Marketplace V2 `BidExclusive` readiness before mainnet.

The main risk is not whether local unit tests exist. The main risk is whether the accepted-bid
settlement paths can be executed on-chain, with the correct appended `remaining_accounts`, across
completion, rejection, expiry, cancellation, and dispute outcomes.

## What This Matrix Must Prove

- every path that calls `settle_accepted_bid` or `finalize_bid_task_completion` can run on devnet
- appended `remaining_accounts` ordering is unambiguous in live transactions
- `TaskBidBook`, `TaskBid`, `TaskClaim`, and bidder counters reconcile after terminal actions
- bid bonds are refunded or slashed to the correct destination
- no scenario leaves stale accepted-bid pointers, dangling claims, or unrecoverable lamports

## Recommended First Slice

Start with `DV-03A`: `accept_bid -> accept_task_result` on a non-proof task.

Why this comes first:

- it uses the canonical accepted-bid settlement suffix
- it does not prepend arbiter or worker-account groups
- it verifies accepted-bid price override, bid close, bid-book close, and claim close together
- it becomes the template for account snapshots, balance deltas, and transaction evidence capture

Build `DV-01` and `DV-02` setup helpers first, but make `DV-03A` the first full green scenario.

## Execution Order

1. Shared setup primitives from `DV-01` and `DV-02`
2. `DV-03A` successful settlement on a non-proof task
3. `DV-03B` successful settlement on a proof-dependent task
4. `DV-04` rejection and rework reopening
5. `DV-05` claim expiry / no-show slash
6. `DV-07` dispute resolution outcomes
7. `DV-08` expired dispute outcomes
8. `DV-06` cancellation paths
9. `DV-09` residual non-accepted bid cleanup

## Settlement Account Registry

This registry is the source of truth for the harness. If live devnet execution disagrees with any
entry below, treat that as a protocol-readiness failure and update the matrix with the observed
constraint.

| Path | `remaining_accounts` layout | Book disposition | Bond disposition | Notes |
| --- | --- | --- | --- | --- |
| `complete_task` | `[bid_book, accepted_bid, bidder_market_state, bidder_authority]` | `Closed` | `Refund` | Canonical success suffix. |
| `complete_task` with `DependencyType::Proof` | `[parent_task, bid_book, accepted_bid, bidder_market_state, bidder_authority]` | `Closed` | `Refund` | `bid_settlement_offset()` shifts the suffix by one parent-task account. |
| `accept_task_result` | same as `complete_task` | `Closed` | `Refund` | Uses `finalize_bid_task_completion()`. |
| `auto_accept_task_result` | same as `complete_task` | `Closed` | `Refund` | Creator-review timeout path uses the same settlement helper. |
| `validate_task_result(approved)` | same as `complete_task` | `Closed` | `Refund` | Uses `finalize_bid_task_completion()`. |
| `complete_task_private` | same as `complete_task` | `Closed` | `Refund` | Same offset rules as public completion. |
| `reject_task_result` | `[bid_book, accepted_bid, bidder_market_state]` | `Open` | `Refund` | Bidder authority is not appended; the instruction uses `worker_authority`. |
| `validate_task_result(rejected)` | `[bid_book, accepted_bid, bidder_market_state]` | `Open` | `Refund` | Same reopen semantics as direct rejection. |
| `expire_claim` | `[bid_marketplace, bid_book, accepted_bid, bidder_market_state, creator]` | `Open` | `SlashByBpsToCreator(accepted_no_show_slash_bps)` | Bidder authority comes from `rent_recipient`, not from the suffix. |
| `cancel_task` with accepted bid | `[(claim, worker, rent_recipient) x current_workers] + [bid_book, accepted_bid, bidder_market_state]` | `Closed` | `FullSlashToCreator` | Harness must verify the accepted-bid suffix is taken from the tail after worker triples. |
| `resolve_dispute` | `[(vote, arbiter) x total_voters] + [(claim, worker) x (current_workers - 1)] + [bid_book, accepted_bid, bidder_market_state]` | `Closed` | `Refund` or `FullSlashToCreator` | Bidder authority comes from `worker_wallet`. |
| `expire_dispute` | same prefix and suffix as `resolve_dispute` | `Closed` | `Refund` if `no_votes && worker_completed`, else `FullSlashToCreator` | Harness must verify the final 3 accounts are the settlement suffix. |

## Scenario Matrix

### DV-01: Bid lifecycle roundtrip

Path:

- `initialize_bid_book`
- `create_bid`
- `update_bid`
- `cancel_bid`

Verify:

- `TaskBid` is created and funded with the minimum bond
- `TaskBidBook.total_bids` increments
- `TaskBidBook.active_bids` increments and then decrements
- `BidderMarketState.active_bid_count` increments and then decrements
- bid close returns bond and rent to `bidder_authority`

Harness notes:

- this scenario is a setup primitive for all later scenarios
- persist bidder-state snapshots because later scenarios compare against the same counters

### DV-02: Accept bid transitions task and book correctly

Path:

- `create_bid`
- `accept_bid`

Verify:

- `Task.status: Open -> InProgress`
- `Task.current_workers = 1`
- `TaskClaim` is created for the accepted bidder
- `TaskBid.state: Active -> Accepted`
- `TaskBidBook.state: Open -> Accepted`
- `TaskBidBook.accepted_bid` points to the accepted bid
- `AgentRegistration.active_tasks` increments
- `BidderMarketState.total_bids_accepted` increments

Harness notes:

- this scenario is a setup primitive for all deferred settlement paths

### DV-03: Successful settlement after accepted bid

Paths:

- `accept_bid -> complete_task`
- `accept_bid -> accept_task_result`
- `accept_bid -> auto_accept_task_result`
- `accept_bid -> validate_task_result(approved)`
- `accept_bid -> complete_task_private`

Verify:

- reward amount uses `accepted_bid.requested_reward_lamports`
- accepted bid closes successfully
- bid book transitions to `Closed`
- `BidderMarketState.active_bid_count` decrements
- accepted bid bond is refunded to bidder authority
- `TaskClaim` closes successfully
- no residual active counters remain

Ordering to validate:

- non-proof: `[bid_book, accepted_bid, bidder_market_state, bidder_authority]`
- proof-dependent: `[parent_task, bid_book, accepted_bid, bidder_market_state, bidder_authority]`

### DV-04: Rejection / rework reopens the bid book correctly

Paths:

- `accept_bid -> reject_task_result`
- `accept_bid -> validate_task_result(rejected)`

Verify:

- accepted bid closes
- bid book reopens
- `TaskBidBook.accepted_bid` is cleared
- bidder active bid count decrements
- bond is refunded
- worker claim slot is released
- task can accept a new bid afterward

Ordering to validate:

- `[bid_book, accepted_bid, bidder_market_state]`

### DV-05: Claim expiry / no-show slashes bond correctly

Path:

- `accept_bid -> expire_claim`

Verify:

- task worker slot is released or task is reopened when appropriate
- accepted bid closes
- bid book reopens
- slash amount equals `BidMarketplaceConfig.accepted_no_show_slash_bps`
- creator receives only the configured slash amount
- bidder authority receives the remaining bond value
- bidder active bid count decrements

Ordering to validate:

- `[bid_marketplace, bid_book, accepted_bid, bidder_market_state, creator]`

### DV-06: Task cancellation with and without accepted bid

Paths:

- `cancel_task` with open book and no accepted bid
- `cancel_task` with accepted bid

Verify, no accepted bid:

- bid book closes cleanly

Verify, accepted bid:

- creator receives task refund
- accepted bid bond is fully slashed to creator
- accepted bid closes
- bid book closes
- all claims close
- worker active task counters decrement
- task worker count resets to zero

Ordering to validate:

- no accepted bid: `[bid_book]`
- accepted bid: `[(claim, worker, rent_recipient) x current_workers] + [bid_book, accepted_bid, bidder_market_state]`

### DV-07: Dispute resolution settles accepted bid correctly

Paths:

- `resolve_dispute` with `Refund`
- `resolve_dispute` with `Complete`
- `resolve_dispute` with `Split`

Verify:

- outcome-specific reward distribution is correct
- accepted bid bond is refunded only when expected
- accepted bid bond is fully slashed to creator when expected
- accepted bid closes
- bid book closes
- worker active task count decrements
- no residual escrow or bid inconsistencies remain

Ordering to validate:

- `[(vote, arbiter) x total_voters]`
- then `[(claim, worker) x (current_workers - 1)]`
- final settlement suffix `[bid_book, accepted_bid, bidder_market_state]`

### DV-08: Expired dispute settles accepted bid correctly

Path:

- `expire_dispute`

Verify:

- if `no_votes && worker_completed`, bond is refunded
- otherwise bond is fully slashed to creator
- accepted bid closes
- bid book closes
- worker counters decrement
- fund distribution matches dispute-expiry rules

Ordering to validate:

- same prefix split as `resolve_dispute`
- final settlement suffix `[bid_book, accepted_bid, bidder_market_state]`

### DV-09: Residual non-accepted bids can be cleaned up after book close

Path:

- close the book via completion, cancellation, or dispute outcome
- then call `expire_bid` for remaining non-accepted bids

Verify:

- each residual bid can be closed once book is closed or expiry passes
- bidder authority recovers bond and rent for non-accepted bids
- `TaskBidBook.active_bids` drains to zero without underflow

## Evidence Bundle Required For Every Scenario

Each scenario run must capture:

- transaction signatures
- ordered instruction list
- all appended `remaining_accounts`
- terminal-instruction ordering check against the observed transaction account suffix
- pre-state snapshots for every touched account
- post-state snapshots for every touched account
- balance delta summary
- event summary, when emitted
- final pass or fail verdict

Suggested bundle files:

- `manifest.json`
- `scenario-plan.json`
- `remaining-accounts.json`
- `pre-state.json`
- `post-state.json`
- `balance-delta.json`
- `transactions.json` when signatures are available
- `ordering-check.json` when signatures are available
- `event-summary.json` when signatures are available
- `verdict.json`

At minimum, snapshots should cover:

- `Task`
- `TaskClaim`
- `TaskBidBook`
- `TaskBid`
- `BidderMarketState`
- `AgentRegistration` for worker and bidder
- `TaskEscrow`
- creator authority account
- bidder or worker authority account
- treasury account

## Exit Criteria

This matrix is green only when:

- every required devnet scenario has been executed successfully
- all settlement suffix orderings have been validated on-chain
- no scenario leaves dangling counters or stale accepted-bid pointers
- no scenario leaks lamports or leaves unrecoverable bond custody
- a readiness report records pass/fail status and open blockers

The harness-level aggregate report should be written to:

- `artifacts/devnet-readiness/readiness-report.json`

## Code Anchors

The harness should stay aligned with these code points:

- `programs/agenc-coordination/src/instructions/bid_settlement_helpers.rs`
- `programs/agenc-coordination/src/instructions/complete_task.rs`
- `programs/agenc-coordination/src/instructions/complete_task_private.rs`
- `programs/agenc-coordination/src/instructions/accept_task_result.rs`
- `programs/agenc-coordination/src/instructions/auto_accept_task_result.rs`
- `programs/agenc-coordination/src/instructions/validate_task_result.rs`
- `programs/agenc-coordination/src/instructions/reject_task_result.rs`
- `programs/agenc-coordination/src/instructions/expire_claim.rs`
- `programs/agenc-coordination/src/instructions/cancel_task.rs`
- `programs/agenc-coordination/src/instructions/resolve_dispute.rs`
- `programs/agenc-coordination/src/instructions/expire_dispute.rs`
