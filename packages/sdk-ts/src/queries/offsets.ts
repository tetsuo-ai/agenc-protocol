// Byte offsets of the account fields the query layer memcmp-filters on.
//
// Every offset is 8 (the Anchor account discriminator) plus the cumulative widths
// of the preceding fields IN GENERATED-ENCODER ORDER (see src/generated/accounts/*).
// These constants are drift-proofed by tests/queries.test.ts, which encodes a
// fixture for each account through the generated encoder with sentinel values and
// asserts the bytes at each offset decode back to exactly the sentinel — any
// layout change in the program/IDL breaks that test loudly.

/** Width of the Anchor account discriminator that prefixes every account. */
export const ANCHOR_DISCRIMINATOR_SIZE = 8;

// ---------------------------------------------------------------------------
// ServiceListing (src/generated/accounts/serviceListing.ts)
//   disc(8) | providerAgent(32) | authority(32) | listingId(32) | name(32) |
//   category(32) | tags(64) | specHash(32) | specUri(4+len) | ...
// ---------------------------------------------------------------------------

/** `ServiceListing.providerAgent` (the provider's AgentRegistration PDA): 8. */
export const SERVICE_LISTING_PROVIDER_AGENT_OFFSET = 8;

/** `ServiceListing.authority` (the provider's signing wallet): 8 + 32 = 40. */
export const SERVICE_LISTING_AUTHORITY_OFFSET = 40;

/** `ServiceListing.category` (32-byte client-encoded tag): 8 + 32*4 = 136. */
export const SERVICE_LISTING_CATEGORY_OFFSET = 136;

// NOTE: `ServiceListing.state` has NO fixed offset and therefore NO constant
// here. It is laid out AFTER `specUri` (a u32-length-prefixed string) and
// `priceMint` (a Borsh Option), both variable-width, so its byte position
// differs per listing and cannot be matched with a memcmp filter. The query
// layer filters listing state CLIENT-SIDE after decoding (see
// `listActiveListings`). tests/queries.test.ts proves this by encoding two
// fixtures with different `specUri` lengths and showing the state byte moves.

// ---------------------------------------------------------------------------
// Task (src/generated/accounts/task.ts)
//   disc(8) | taskId(32) | creator(32) | requiredCapabilities(8) |
//   description(64) | constraintHash(32) | rewardAmount(8) | maxWorkers(1) |
//   currentWorkers(1) | status(1) | ...
// ---------------------------------------------------------------------------

/** `Task.creator` (paying wallet): 8 + 32 = 40. */
export const TASK_CREATOR_OFFSET = 40;

/** `Task.status` (TaskStatus u8): 8 + 32 + 32 + 8 + 64 + 32 + 8 + 1 + 1 = 186. */
export const TASK_STATUS_OFFSET = 186;

// ---------------------------------------------------------------------------
// TaskClaim (src/generated/accounts/taskClaim.ts)
//   disc(8) | task(32) | worker(32) | ...
// ---------------------------------------------------------------------------

/** `TaskClaim.task` (the claimed Task PDA): 8. */
export const TASK_CLAIM_TASK_OFFSET = 8;

/**
 * `TaskClaim.worker`: 8 + 32 = 40. This is the worker's **AgentRegistration
 * PDA** (the agent identity that claimed), NOT the worker's wallet authority.
 */
export const TASK_CLAIM_WORKER_OFFSET = 40;

// ---------------------------------------------------------------------------
// TaskBid (src/generated/accounts/taskBid.ts)
//   disc(8) | task(32) | bidBook(32) | bidder(32) | bidderAuthority(32) | ...
// ---------------------------------------------------------------------------

/** `TaskBid.task` (the Task PDA the bid targets): 8. */
export const TASK_BID_TASK_OFFSET = 8;

// ---------------------------------------------------------------------------
// HireRecord (src/generated/accounts/hireRecord.ts)
//   disc(8) | task(32) | listing(32) | operator(32) | ...
// ---------------------------------------------------------------------------

/**
 * `HireRecord.task` (the one-shot Task minted by the hire): 8.
 *
 * NOTE: HireRecord stores NO buyer field — the buyer's identity lives on the
 * minted Task (`Task.creator`). `listHireRecordsForBuyer` therefore joins
 * HireRecords against the buyer's Tasks client-side.
 */
export const HIRE_RECORD_TASK_OFFSET = 8;

// ---------------------------------------------------------------------------
// CompletionBond (src/generated/accounts/completionBond.ts)
//   disc(8) | task(32) | party(32) | role(1) | amount(8) | bondMint(Option) | ...
// ---------------------------------------------------------------------------

/**
 * `CompletionBond.task` (the Task PDA the bond backs): 8.
 *
 * A task has AT MOST two bonds (one creator, one worker — `init` enforces one
 * per wallet per task), so a memcmp at this offset narrows the fetch to those
 * one or two accounts; the `role` split (0 = creator, 1 = worker) is refined
 * client-side after decoding.
 */
export const COMPLETION_BOND_TASK_OFFSET = 8;

// ---------------------------------------------------------------------------
// TaskJobSpec (src/generated/accounts/taskJobSpec.ts)
//   disc(8) | task(32) | creator(32) | jobSpecHash(32) | jobSpecUri(4+len) | ...
// ---------------------------------------------------------------------------

/**
 * `TaskJobSpec.task` (the Task PDA this job spec pins): 8.
 *
 * A `TaskJobSpec` account existing for a task is the on-chain
 * "job-spec pinned" signal `claim_task_with_job_spec` requires (the claim
 * instruction takes the `["task_job_spec", task]` PDA as a plain
 * `Account<TaskJobSpec>` — absent ⇒ `AccountNotInitialized`).
 */
export const TASK_JOB_SPEC_TASK_OFFSET = 8;

/**
 * `TaskJobSpec.jobSpecHash` (the SHA-256 commitment): 8 + 32 + 32 = 72.
 *
 * The on-chain `validate_job_spec_pointer` additionally requires this hash to
 * have at least one non-zero byte, so the claimable predicate checks both PDA
 * existence AND a non-zero hash to mirror the program exactly.
 */
export const TASK_JOB_SPEC_HASH_OFFSET = 72;
