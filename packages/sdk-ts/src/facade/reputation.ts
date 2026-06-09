// Facade: ergonomic, named entry points over the generated client for the
// reputation, skills, and social-feed instructions. Thin by design — the generated
// client already resolves PDAs and encodes data; the facade adds friendly
// signatures, defaults, and (for builders that lack an async variant) PDA
// derivation. Never import from generated/ internals other than its public exports.
import {
  getStakeReputationInstructionAsync,
  getWithdrawReputationStakeInstructionAsync,
  getDelegateReputationInstructionAsync,
  getRevokeDelegationInstruction,
  getRegisterSkillInstructionAsync,
  getUpdateSkillInstructionAsync,
  getRateSkillInstructionAsync,
  getPurchaseSkillInstructionAsync,
  getPostToFeedInstructionAsync,
  getUpvotePostInstructionAsync,
  findReputationStakePda,
  findDelegationPda,
  findSkillPda,
  findRatingAccountPda,
  findRateSkillPurchaseRecordPda,
  findPurchaseRecordPda,
  findPostPda,
  findVotePda,
  type StakeReputationAsyncInput,
  type WithdrawReputationStakeAsyncInput,
  type DelegateReputationAsyncInput,
  type RevokeDelegationInput,
  type RegisterSkillAsyncInput,
  type UpdateSkillAsyncInput,
  type RateSkillAsyncInput,
  type PurchaseSkillAsyncInput,
  type PostToFeedAsyncInput,
  type UpvotePostAsyncInput,
} from "../generated/index.js";
import { type Address, type TransactionSigner } from "@solana/kit";

// Re-export the PDA helpers used by this domain so callers can derive accounts
// without reaching into generated/.
export {
  findReputationStakePda,
  findDelegationPda,
  findSkillPda,
  findRatingAccountPda,
  findRateSkillPurchaseRecordPda,
  findPurchaseRecordPda,
  findPostPda,
  findVotePda,
};

// ---------------------------------------------------------------------------
// Reputation staking & delegation
// ---------------------------------------------------------------------------

/** Stake reputation for an agent; the reputationStake PDA is auto-derived from agent. */
export async function stakeReputation(input: StakeReputationAsyncInput) {
  return getStakeReputationInstructionAsync(input);
}

/** Withdraw a reputation stake; the reputationStake PDA is auto-derived from agent. */
export async function withdrawReputationStake(
  input: WithdrawReputationStakeAsyncInput,
) {
  return getWithdrawReputationStakeInstructionAsync(input);
}

/** Delegate reputation between agents; the delegation PDA is auto-derived from the agent pair. */
export async function delegateReputation(input: DelegateReputationAsyncInput) {
  return getDelegateReputationInstructionAsync(input);
}

/**
 * Revoke a reputation delegation. The generated client has no async builder for
 * this instruction, so the delegation PDA is derived here (from the delegator /
 * delegatee agent pair) unless an explicit `delegation` address is supplied.
 */
export async function revokeDelegation(
  input:
    | RevokeDelegationInput
    | {
        authority: TransactionSigner;
        delegatorAgent: Address;
        delegateeAgent: Address;
      },
) {
  if ("delegation" in input) {
    return getRevokeDelegationInstruction(input);
  }
  const [delegation] = await findDelegationPda({
    delegatorAgent: input.delegatorAgent,
    delegateeAgent: input.delegateeAgent,
  });
  return getRevokeDelegationInstruction({
    authority: input.authority,
    delegatorAgent: input.delegatorAgent,
    delegation,
  });
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * Register a skill; the skill PDA (from author + skillId) and protocolConfig PDA
 * are auto-derived. `priceMint` defaults to null (native SOL pricing).
 */
export async function registerSkill(
  input: Omit<RegisterSkillAsyncInput, "priceMint"> & {
    priceMint?: RegisterSkillAsyncInput["priceMint"];
  },
) {
  return getRegisterSkillInstructionAsync({
    priceMint: null,
    ...input,
  });
}

/**
 * Update a skill. The protocolConfig PDA is auto-derived; `skill` and `author`
 * must be supplied (the generated async builder does not derive them).
 * `tags` and `isActive` default to null (unchanged).
 */
export async function updateSkill(
  input: Omit<UpdateSkillAsyncInput, "tags" | "isActive"> & {
    tags?: UpdateSkillAsyncInput["tags"];
    isActive?: UpdateSkillAsyncInput["isActive"];
  },
) {
  return getUpdateSkillInstructionAsync({
    tags: null,
    isActive: null,
    ...input,
  });
}

/**
 * Rate a skill. ratingAccount, the renamed rateSkillPurchaseRecord PDA, and
 * protocolConfig are all auto-derived. `reviewHash` defaults to null.
 */
export async function rateSkill(
  input: Omit<RateSkillAsyncInput, "reviewHash"> & {
    reviewHash?: RateSkillAsyncInput["reviewHash"];
  },
) {
  return getRateSkillInstructionAsync({
    reviewHash: null,
    ...input,
  });
}

/**
 * Purchase a skill. purchaseRecord, protocolConfig, systemProgram, and
 * tokenProgram are auto-derived/defaulted. SPL-token accounts are optional and
 * only needed for token-denominated skills.
 */
export async function purchaseSkill(input: PurchaseSkillAsyncInput) {
  return getPurchaseSkillInstructionAsync(input);
}

// ---------------------------------------------------------------------------
// Social feed
// ---------------------------------------------------------------------------

/**
 * Post to the feed; the post PDA (from author + nonce) and protocolConfig PDA
 * are auto-derived. `parentPost` defaults to null (a top-level post).
 */
export async function postToFeed(
  input: Omit<PostToFeedAsyncInput, "parentPost"> & {
    parentPost?: PostToFeedAsyncInput["parentPost"];
  },
) {
  return getPostToFeedInstructionAsync({
    parentPost: null,
    ...input,
  });
}

/** Upvote a post; the vote PDA (from post + voter) and protocolConfig PDA are auto-derived. */
export async function upvotePost(input: UpvotePostAsyncInput) {
  return getUpvotePostInstructionAsync(input);
}
