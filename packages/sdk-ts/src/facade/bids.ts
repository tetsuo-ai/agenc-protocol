// Facade: ergonomic, named entry points over the generated bid-marketplace client. Thin by
// design — the generated Async builders already resolve PDAs (bid, bidBook, bidMarketplace,
// bidderMarketState, protocolConfig, taskJobSpec, claim) and encode data; the facade adds
// friendly signatures and defaults. Never import from generated/ internals other than its
// public exports.
import {
  AccountRole,
  getAddressEncoder,
  type Address,
} from "@solana/kit";
import {
  getCreateBidInstructionAsync,
  getCancelBidInstructionAsync,
  getUpdateBidInstructionAsync,
  getExpireBidInstructionAsync,
  getAcceptBidInstructionAsync,
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
  type InitializeBidMarketplaceAsyncInput,
  type InitializeBidBookAsyncInput,
  type UpdateBidMarketplaceConfigAsyncInput,
} from "../generated/index.js";
import { sha256 } from "../values/hash.js";
import {
  concatBytes,
  fixedBytes,
  i64Le,
  u16Le,
  u32Le,
  u64Le,
} from "./wire.js";

// Re-export the bid PDA helpers so callers can derive the same accounts the
// builders resolve under the hood (e.g. to read state before/after a flow).
export { findBidPda, findBidBookPda, findBidMarketplacePda, findBidderMarketStatePda };

/**
 * Place a bid on a task. The bid, bidBook, bidderMarketState, bidMarketplace,
 * and protocolConfig PDAs auto-derive from `task` and `bidder`.
 */
export type CreateBidInput = CreateBidAsyncInput;

export async function createBid(input: CreateBidInput) {
  return getCreateBidInstructionAsync(input);
}

/**
 * Cancel an open bid. bidBook, bid, and bidderMarketState auto-derive from
 * `task` and `bidder`; the bidder's bond is refunded.
 */
export async function cancelBid(input: CancelBidAsyncInput) {
  return getCancelBidInstructionAsync(input);
}

/**
 * Revise an existing bid's terms (reward, ETA, confidence, hashes, expiry).
 * bidBook, bid, bidMarketplace, and protocolConfig auto-derive.
 */
export type UpdateBidInput = UpdateBidAsyncInput;

export async function updateBid(input: UpdateBidInput) {
  return getUpdateBidInstructionAsync(input);
}

/**
 * Permissionlessly close a bid past its expiry (time-gated on-chain). Anyone may
 * sign as `authority`; rent returns to `bidderAuthority`. bidBook, bid,
 * bidderMarketState, and protocolConfig auto-derive from `task`/`bidder`.
 */
export async function expireBid(input: ExpireBidAsyncInput) {
  return getExpireBidInstructionAsync(input);
}

/**
 * Creator accepts a bid, moving the task to InProgress. The claim, bidBook, bid,
 * bidderMarketState, protocolConfig, and the moderation-gated taskJobSpec all
 * auto-derive from `task`/`bidder`. Dependent tasks must pass their exact
 * `parentTask`; the facade appends it as the read-only remaining account required
 * by the on-chain assignment gate.
 */
export type CompetingBidAccountPair = Readonly<{
  /** Canonical open TaskBid PDA. */
  bid: Address;
  /** Canonical AgentRegistration PDA named by that TaskBid. */
  bidder: Address;
}>;

export type AcceptBidInput = Omit<AcceptBidAsyncInput, "moderationBlock"> & {
  /** Locked job-spec hash, used to derive the canonical BLOCK-floor PDA. */
  jobSpecHash?: Uint8Array;
  /** Override for [moderation_block, jobSpecHash]. */
  moderationBlock?: Address;
  /** Required for every dependent task; omit only for independent tasks. */
  parentTask?: Address;
  /**
   * Every other canonical open bid and its matching AgentRegistration, exactly
   * once. Pass `[]` when the selected bid is the only open bid. The program
   * rejects omissions, duplicates, mismatched pairs, closed bids, and
   * non-canonical accounts.
   */
  otherOpenBidPairs: readonly CompetingBidAccountPair[];
};

export async function acceptBid(input: AcceptBidInput) {
  const {
    jobSpecHash,
    moderationBlock,
    parentTask,
    otherOpenBidPairs,
    ...generatedInput
  } = input;
  if (!moderationBlock && !jobSpecHash) {
    throw new Error(
      "acceptBid: provide jobSpecHash (or moderationBlock) for the assignment-time BLOCK check",
    );
  }
  const block =
    moderationBlock ??
    (await findModerationBlockPda({ contentHash: jobSpecHash! }))[0];
  const instruction = await getAcceptBidInstructionAsync({
    ...generatedInput,
    moderationBlock: block,
  });
  if (otherOpenBidPairs.length > 19) {
    throw new Error("acceptBid: at most 19 other open bid pairs are supported");
  }
  const [selectedBid] = await findBidPda({ task: input.task, bidder: input.bidder });
  const seenBids = new Set<string>([selectedBid]);
  const seenBidders = new Set<string>([input.bidder]);
  for (const pair of otherOpenBidPairs) {
    if (seenBids.has(pair.bid)) {
      throw new Error(
        "acceptBid: otherOpenBidPairs contains the selected bid or a duplicate bid",
      );
    }
    if (seenBidders.has(pair.bidder)) {
      throw new Error(
        "acceptBid: otherOpenBidPairs contains the selected bidder or a duplicate bidder",
      );
    }
    seenBids.add(pair.bid);
    seenBidders.add(pair.bidder);
  }
  const accounts = [
    ...instruction.accounts,
    ...(parentTask
      ? [{ address: parentTask, role: AccountRole.READONLY } as const]
      : []),
    ...otherOpenBidPairs.flatMap(({ bid, bidder }) => [
      { address: bid, role: AccountRole.READONLY } as const,
      { address: bidder, role: AccountRole.READONLY } as const,
    ]),
  ];
  return {
    ...instruction,
    accounts,
  };
}

/**
 * Initialize the singleton bid marketplace config account. bidMarketplace and
 * protocolConfig auto-derive.
 */
export async function initializeBidMarketplace(
  input: InitializeBidMarketplaceAsyncInput,
) {
  return getInitializeBidMarketplaceInstructionAsync(input);
}

/**
 * Open the per-task bid book with its selection policy and scoring weights. The
 * bidBook PDA and protocolConfig auto-derive from `task`.
 */
export type InitializeBidBookInput = InitializeBidBookAsyncInput;

export async function initializeBidBook(input: InitializeBidBookInput) {
  return getInitializeBidBookInstructionAsync(input);
}

/**
 * Update the bid marketplace config (bonds, cooldowns, rate limits, slash bps).
 * bidMarketplace and protocolConfig auto-derive.
 */
export async function updateBidMarketplaceConfig(
  input: UpdateBidMarketplaceConfigAsyncInput,
) {
  return getUpdateBidMarketplaceConfigInstructionAsync(input);
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
  const addressEncoder = getAddressEncoder();
  return sha256(
    concatBytes(
      new TextEncoder().encode("agenc:bid-terms:v1"),
      addressEncoder.encode(snapshot.task),
      addressEncoder.encode(snapshot.bid),
      addressEncoder.encode(snapshot.bidTask),
      addressEncoder.encode(snapshot.bidBook),
      addressEncoder.encode(snapshot.bidder),
      addressEncoder.encode(snapshot.bidderAuthority),
      u64Le(snapshot.requestedRewardLamports, "requestedRewardLamports"),
      u32Le(snapshot.etaSeconds, "etaSeconds"),
      u16Le(snapshot.confidenceBps, "confidenceBps"),
      u16Le(snapshot.reputationSnapshotBps, "reputationSnapshotBps"),
      fixedBytes(snapshot.qualityGuaranteeHash, 32, "qualityGuaranteeHash"),
      fixedBytes(snapshot.metadataHash, 32, "metadataHash"),
      i64Le(snapshot.expiresAt, "expiresAt"),
      i64Le(snapshot.createdAt, "createdAt"),
      i64Le(snapshot.updatedAt, "updatedAt"),
      u64Le(snapshot.bondLamports, "bondLamports"),
      u16Le(
        snapshot.acceptedNoShowSlashBps,
        "acceptedNoShowSlashBps",
      ),
      fixedBytes(snapshot.jobSpecHash, 32, "jobSpecHash"),
      i64Le(snapshot.jobSpecUpdatedAt, "jobSpecUpdatedAt"),
    ),
  );
}
