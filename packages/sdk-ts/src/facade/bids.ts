// Facade: ergonomic, named entry points over the generated bid-marketplace client. Thin by
// design — the generated Async builders already resolve PDAs (bid, bidBook, bidMarketplace,
// bidderMarketState, protocolConfig, taskJobSpec, claim) and encode data; the facade adds
// friendly signatures and defaults. Never import from generated/ internals other than its
// public exports.
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
  type CreateBidAsyncInput,
  type CancelBidAsyncInput,
  type UpdateBidAsyncInput,
  type ExpireBidAsyncInput,
  type AcceptBidAsyncInput,
  type InitializeBidMarketplaceAsyncInput,
  type InitializeBidBookAsyncInput,
  type UpdateBidMarketplaceConfigAsyncInput,
} from "../generated/index.js";

// Re-export the bid PDA helpers so callers can derive the same accounts the
// builders resolve under the hood (e.g. to read state before/after a flow).
export { findBidPda, findBidBookPda, findBidMarketplacePda, findBidderMarketStatePda };

/**
 * Place a bid on a task. The bid, bidBook, bidderMarketState, bidMarketplace,
 * and protocolConfig PDAs auto-derive from `task` and `bidder`.
 */
export async function createBid(input: CreateBidAsyncInput) {
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
export async function updateBid(input: UpdateBidAsyncInput) {
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
 * auto-derive from `task`/`bidder`.
 */
export async function acceptBid(input: AcceptBidAsyncInput) {
  return getAcceptBidInstructionAsync(input);
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
export async function initializeBidBook(input: InitializeBidBookAsyncInput) {
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
