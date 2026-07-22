// Facade: ergonomic, named entry points over the generated bid-marketplace client. Thin by
// design — the generated Async builders already resolve PDAs (bid, bidBook, bidMarketplace,
// bidderMarketState, protocolConfig, taskJobSpec, claim) and encode data; the facade adds
// friendly signatures and defaults. Never import from generated/ internals other than its
// public exports.
import {
  AccountRole,
  address,
  getAddressEncoder,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  getCreateBidInstructionAsync,
  getCancelBidInstructionAsync,
  getUpdateBidInstructionAsync,
  getExpireBidInstructionAsync,
  getAcceptBidInstructionAsync,
  getPromoteBidInstructionAsync,
  getDemoteIneligibleBestInstructionAsync,
  getInitializeBidMarketplaceInstructionAsync,
  getInitializeBidBookInstructionAsync,
  getUpdateBidMarketplaceConfigInstructionAsync,
  findBidPda,
  findBidBookPda,
  findBidMarketplacePda,
  findBidderMarketStatePda,
  findModerationBlockPda,
  type CreateBidAsyncInput,
  type CancelBidAsyncInput,
  type UpdateBidAsyncInput,
  type ExpireBidAsyncInput,
  type AcceptBidAsyncInput,
  type PromoteBidAsyncInput,
  type DemoteIneligibleBestAsyncInput,
  type InitializeBidMarketplaceAsyncInput,
  type InitializeBidBookAsyncInput,
  type UpdateBidMarketplaceConfigAsyncInput,
} from "../generated/index.js";
import { canonicalizeFacadeInputSignerFields } from "../client/signer-identity.js";
import { snapshotFixedBytes } from "../values/fixed-bytes.js";
import {
  snapshotDenseStructuredArray,
  snapshotStructuredClone,
} from "../values/structured-clone.js";
import { sha256 } from "../values/hash.js";
import {
  appendMultisigSignerMetas,
  concatBytes,
  fixedBytes,
  i64Le,
  snapshotMultisigFacadeInput,
  u16Le,
  u32Le,
  u64Le,
} from "./wire.js";

// Re-export the bid PDA helpers so callers can derive the same accounts the
// builders resolve under the hood (e.g. to read state before/after a flow).
export {
  findBidPda,
  findBidBookPda,
  findBidMarketplacePda,
  findBidderMarketStatePda,
};

/**
 * Place a bid on a task. The bid, bidBook, bidderMarketState, bidMarketplace,
 * and protocolConfig PDAs auto-derive from `task` and `bidder`.
 */
export type CreateBidInput = CreateBidAsyncInput;

export async function createBid(input: CreateBidInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  return getCreateBidInstructionAsync({
    ...stableInput,
    qualityGuaranteeHash: snapshotFixedBytes(
      stableInput.qualityGuaranteeHash,
      32,
      "createBid: qualityGuaranteeHash",
    ),
    metadataHash: snapshotFixedBytes(
      stableInput.metadataHash,
      32,
      "createBid: metadataHash",
    ),
    expectedJobSpecHash: snapshotFixedBytes(
      stableInput.expectedJobSpecHash,
      32,
      "createBid: expectedJobSpecHash",
    ),
  });
}

/**
 * Cancel an open bid. bidBook, bid, and bidderMarketState auto-derive from
 * `task` and `bidder`; the bidder's bond is refunded.
 */
export async function cancelBid(input: CancelBidAsyncInput) {
  return getCancelBidInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
}

/**
 * Revise an existing bid's terms (reward, ETA, confidence, hashes, expiry).
 * bidBook, bid, bidMarketplace, and protocolConfig auto-derive.
 */
export type UpdateBidInput = UpdateBidAsyncInput;

export async function updateBid(input: UpdateBidInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  return getUpdateBidInstructionAsync({
    ...stableInput,
    qualityGuaranteeHash: snapshotFixedBytes(
      stableInput.qualityGuaranteeHash,
      32,
      "updateBid: qualityGuaranteeHash",
    ),
    metadataHash: snapshotFixedBytes(
      stableInput.metadataHash,
      32,
      "updateBid: metadataHash",
    ),
    expectedJobSpecHash: snapshotFixedBytes(
      stableInput.expectedJobSpecHash,
      32,
      "updateBid: expectedJobSpecHash",
    ),
  });
}

/**
 * Permissionlessly close a bid past its expiry (time-gated on-chain). Anyone may
 * sign as `authority`; rent returns to `bidderAuthority`. bidBook, bid,
 * bidderMarketState, and protocolConfig auto-derive from `task`/`bidder`.
 */
export async function expireBid(input: ExpireBidAsyncInput) {
  return getExpireBidInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
}

/**
 * Creator accepts a bid, moving the task to InProgress. The claim, bidBook, bid,
 * bidderMarketState, protocolConfig, and the moderation-gated taskJobSpec all
 * auto-derive from `task`/`bidder`. Dependent tasks must pass their exact
 * `parentTask`; the facade appends it as the read-only remaining account required
 * by the on-chain assignment gate.
 */
export type AcceptBidInput = Omit<AcceptBidAsyncInput, "moderationBlock"> & {
  /** Locked job-spec hash, used to derive the canonical BLOCK-floor PDA. */
  jobSpecHash?: Uint8Array;
  /** Override for [moderation_block, jobSpecHash]. */
  moderationBlock?: Address;
  /** Required for every dependent task; omit only for independent tasks. */
  parentTask?: Address;
};

export async function acceptBid(input: AcceptBidInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["creator"]);
  const { jobSpecHash, moderationBlock, parentTask, ...generatedInput } =
    stableInput;
  const stableExpectedBidTermsHash = snapshotFixedBytes(
    generatedInput.expectedBidTermsHash,
    32,
    "acceptBid: expectedBidTermsHash",
  );
  const stableJobSpecHash =
    jobSpecHash === undefined
      ? undefined
      : snapshotFixedBytes(jobSpecHash, 32, "acceptBid: jobSpecHash");
  if (!moderationBlock && !jobSpecHash) {
    throw new Error(
      "acceptBid: provide jobSpecHash (or moderationBlock) for the assignment-time BLOCK check",
    );
  }
  const block =
    moderationBlock ??
    (await findModerationBlockPda({ contentHash: stableJobSpecHash! }))[0];
  const instruction = await getAcceptBidInstructionAsync({
    ...generatedInput,
    moderationBlock: block,
    expectedBidTermsHash: stableExpectedBidTermsHash,
  });
  // Acceptance is O(1): the book tracks its policy winner incrementally, so
  // no competitor enumeration exists. The only remaining account is the
  // dependency parent for dependent tasks; the program rejects extras.
  if (!parentTask) {
    return instruction;
  }
  return {
    ...instruction,
    accounts: [
      ...instruction.accounts,
      { address: parentTask, role: AccountRole.READONLY },
    ],
  };
}

/**
 * Permissionlessly promote a live, eligible, bond-backed bid to the book's
 * tracked policy winner. Succeeds only when the presented bid beats the cached
 * incumbent (or the book tracks none) — rational bidders promote themselves
 * the moment a leader exits; indexer bots can crank it for anyone. bidBook,
 * bid, and protocolConfig auto-derive from `task`/`bidder`.
 */
export async function promoteBid(input: PromoteBidAsyncInput) {
  return getPromoteBidInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
}

/**
 * Permissionlessly demote a provably dead tracked winner (expired, withdrawn,
 * deadline-infeasible, bond-drained, or ineligible bidder), opening the
 * re-promotion grace window so the book cannot stay blocked behind an
 * unacceptable leader.
 */
export async function demoteIneligibleBest(
  input: DemoteIneligibleBestAsyncInput,
) {
  return getDemoteIneligibleBestInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
}

/**
 * Initialize the singleton bid marketplace config account. bidMarketplace and
 * protocolConfig auto-derive. The on-chain initializer is ProtocolConfig
 * M-of-N gated, so every approval must be supplied explicitly in
 * `multisigSigners` (including the named authority again when it is an owner).
 */
export type InitializeBidMarketplaceInput =
  InitializeBidMarketplaceAsyncInput & {
    readonly multisigSigners: readonly TransactionSigner[];
  };

export async function initializeBidMarketplace(
  input: InitializeBidMarketplaceInput,
) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["authority"]);
  const instruction =
    await getInitializeBidMarketplaceInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
}

/**
 * Open the per-task bid book with its selection policy and scoring weights. The
 * bidBook PDA and protocolConfig auto-derive from `task`.
 */
export type InitializeBidBookInput = InitializeBidBookAsyncInput;

export async function initializeBidBook(input: InitializeBidBookInput) {
  return getInitializeBidBookInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["creator"]),
  );
}

/**
 * Update the bid marketplace config (bonds, cooldowns, rate limits, slash bps).
 * bidMarketplace and protocolConfig auto-derive. Rust applies the same current
 * ProtocolConfig M-of-N gate as initialization, so approvals are required and
 * appended as readonly-signer remaining accounts.
 */
export type UpdateBidMarketplaceConfigInput =
  UpdateBidMarketplaceConfigAsyncInput & {
    readonly multisigSigners: readonly TransactionSigner[];
  };

export async function updateBidMarketplaceConfig(
  input: UpdateBidMarketplaceConfigInput,
) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["authority"]);
  const instruction =
    await getUpdateBidMarketplaceConfigInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
}

/** Fields hashed by Rust's `calculate_bid_terms_hash` (domain v1). */
export type BidTermsSnapshot = {
  task: Address;
  bid: Address;
  bidTask: Address;
  bidBook: Address;
  bidder: Address;
  bidderAuthority: Address;
  requestedRewardLamports: number | bigint;
  etaSeconds: number;
  confidenceBps: number;
  reputationSnapshotBps: number;
  qualityGuaranteeHash: Uint8Array;
  metadataHash: Uint8Array;
  expiresAt: number | bigint;
  createdAt: number | bigint;
  updatedAt: number | bigint;
  bondLamports: number | bigint;
  /** Slash policy frozen onto the bid when it was created. */
  acceptedNoShowSlashBps: number;
  jobSpecHash: Uint8Array;
  jobSpecUpdatedAt: number | bigint;
};

/**
 * Compute the exact `agenc:bid-terms:v1` CAS digest accepted by `accept_bid`.
 * Callers should decode the selected bid and TaskJobSpec in one fresh read,
 * hash that snapshot, then pass this digest. Competing bids are independently
 * enumerated for deterministic policy enforcement.
 */
export async function calculateBidTermsHash(
  snapshot: BidTermsSnapshot,
): Promise<Uint8Array> {
  const stableSnapshot = snapshotStructuredClone(
    snapshot,
    "calculateBidTermsHash: snapshot",
  );
  const addressEncoder = getAddressEncoder();
  return sha256(
    concatBytes(
      new TextEncoder().encode("agenc:bid-terms:v1"),
      addressEncoder.encode(stableSnapshot.task),
      addressEncoder.encode(stableSnapshot.bid),
      addressEncoder.encode(stableSnapshot.bidTask),
      addressEncoder.encode(stableSnapshot.bidBook),
      addressEncoder.encode(stableSnapshot.bidder),
      addressEncoder.encode(stableSnapshot.bidderAuthority),
      u64Le(stableSnapshot.requestedRewardLamports, "requestedRewardLamports"),
      u32Le(stableSnapshot.etaSeconds, "etaSeconds"),
      u16Le(stableSnapshot.confidenceBps, "confidenceBps"),
      u16Le(stableSnapshot.reputationSnapshotBps, "reputationSnapshotBps"),
      fixedBytes(
        stableSnapshot.qualityGuaranteeHash,
        32,
        "qualityGuaranteeHash",
      ),
      fixedBytes(stableSnapshot.metadataHash, 32, "metadataHash"),
      i64Le(stableSnapshot.expiresAt, "expiresAt"),
      i64Le(stableSnapshot.createdAt, "createdAt"),
      i64Le(stableSnapshot.updatedAt, "updatedAt"),
      u64Le(stableSnapshot.bondLamports, "bondLamports"),
      u16Le(stableSnapshot.acceptedNoShowSlashBps, "acceptedNoShowSlashBps"),
      fixedBytes(stableSnapshot.jobSpecHash, 32, "jobSpecHash"),
      i64Le(stableSnapshot.jobSpecUpdatedAt, "jobSpecUpdatedAt"),
    ),
  );
}
