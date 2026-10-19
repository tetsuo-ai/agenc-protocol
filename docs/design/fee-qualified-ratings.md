# Fee-qualified storefront ratings — revision 8 candidate

Issue #276 demonstrates that two wallets controlled by one actor can recycle
the hire or skill purchase principal and cheaply increase storefront ratings.
The candidate requires each new rating to be backed by at least **100,000
lamports of SOL protocol fee actually paid** (0.0001 SOL). This reuses the
existing `REPUTATION_FEE_LAMPORTS_PER_POINT` economic unit. It is a reviewable
protocol policy, not proof that two wallets represent different people.

At the 100-bps fee and a worker without a fee discount, the boundary is a
10,000,000-lamport payment. A 1,001-lamport cycle pays just 10 fee lamports and
cannot change either rating aggregate. Fee discounts apply before qualification:
the actual fee, not a nominal price, must reach the floor. Protocol rent and
principal are not counted. A zero-fee policy makes new purchases/completions
ineligible. A treasury identical to the known buyer or payee does not qualify.

Successful completion records a canonical boolean in `Task._reserved[12]`
after the fee transfer. Successful purchase records it in
`PurchaseRecord._reserved[1]`, after the content-version snapshot and transfer.
`rate_hire` and `rate_skill` require this evidence before updating their
aggregates. Invalid flags/tail padding fail closed. All existing buyer,
completion, self-rating, score and one-rating checks remain enforced. Failed
transactions roll back rating-account rent and aggregate writes.

Both account allocations and every existing instruction account list remain
unchanged. `Task` remains 466 bytes and `PurchaseRecord` 93 bytes. These reserved
bytes must be zero on the pre-upgrade state; old receipts are **unproven and
ineligible** for a new rating. There is no backfill based on current prices,
current fee configuration, `price_paid`, or a `Completed` status alone.
Dispute payouts do not pay protocol fees and cannot create this evidence.
SPL purchases continue to settle, but arbitrary token amounts do not qualify
as SOL costs without a separately reviewed valuation policy.

Changing or deactivating a skill after purchase cannot change a receipt's
eligibility. Qualified buyers retain the right to rate a delisted skill.
The SDK advertises `feeQualifiedRatings` only on reviewed revision 8, exposes
the fee floor, and provides `facade.isHireRatingFeeQualified` and
`facade.isSkillRatingFeeQualified`. These readers answer only the fee-evidence
question; the remaining on-chain rating checks still apply.

## Historical and economic limits

Existing `total_rating` and `rating_count` are preserved and include historical
unqualified entries. Neither the SDK nor a storefront may describe the whole
existing aggregate as fee-qualified. An indexer needing a clean prospective
score must start at the recorded upgrade/stamp slot and use subsequent rating
events; no historical-score reset is part of this change.

A funded actor can still buy ratings by paying the fee on every cycle. This
sets a minimum independent protocol cost; it does not identify common ownership
or guarantee truthful reviews. The treasury and its governance remain trusted:
off-chain reimbursement or control of another treasury wallet cannot be detected
by this program. Skill ratings remain weighted by buyer reputation. Nothing in
this change turns storefront ratings into protocol reputation.

## Acceptance evidence

The compiled-program tests execute paid hire and skill lifecycles at 10,
99,999 and 100,000 fee lamports. They also cover legacy/corrupt evidence,
mutable skill prices, a large actual SPL payment and atomic rejection.
Existing rating authorization, duplicate and delisting regressions remain.
Native serialization tests preserve allocation, content version and every
unrelated reserved field while checking the fee and denomination boundaries.

`packages/sdk-ts/tests-e2e/fee-qualified-ratings.rpc.test.ts` repeats the minimum
cycle and both fee boundaries through real SDK transactions on a disposable
Agave validator. It checks actual treasury balances, completed tasks, persisted
receipts, exact aggregate changes and confirmed failed-transaction rollback.
The dedicated Rating Fee RPC E2E workflow retains transaction signatures and
program/IDL hashes. Its documented genesis fixture is ProtocolConfig; lifecycle
state is created by transactions, without clock warps or injected receipts.

This is an unreleased candidate. Follow the coordinated release and paused
upgrade/stamp gates in [VERSIONING](../VERSIONING.md) before advertising the
new semantics on mainnet.
