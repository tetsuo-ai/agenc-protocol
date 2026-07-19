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
  findProtocolConfigPda,
  findSkillPda,
  findRatingAccountPda,
  findRateSkillPurchaseRecordPda,
  findPurchaseRecordPda,
  findPostPda,
  findVotePda,
  type StakeReputationAsyncInput,
  type WithdrawReputationStakeAsyncInput,
  type DelegateReputationAsyncInput,
  type RegisterSkillAsyncInput,
  type UpdateSkillAsyncInput,
  type RateSkillAsyncInput,
  type PurchaseSkillAsyncInput,
  type PostToFeedAsyncInput,
  type UpvotePostAsyncInput,
} from "../generated/index.js";
import { AccountRole, type Address, type TransactionSigner } from "@solana/kit";

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

export type StakeReputationInput = StakeReputationAsyncInput;

/** Stake reputation for an agent; canonical stake/config PDAs auto-derive. */
export async function stakeReputation(input: StakeReputationInput) {
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

export type RevokeDelegationFacadeInput = {
  /**
   * Recorded authority address used only as the authenticated rent recipient.
   * A TransactionSigner remains accepted for source compatibility, but revision
   * 5 deliberately does not require this account to sign.
   */
  authority: Address | TransactionSigner;
  delegatorAgent: Address;
  /**
   * Supply this pair when the original AgentRegistration may have been closed or
   * re-registered by revision 4. The facade appends the frozen remaining-account
   * ABI `[protocolConfig, treasury]`; the program uses it only for the orphan path.
   */
  recovery?: {
    protocolConfig?: Address;
    treasury: Address;
  };
} &
  (
    | { delegation: Address; delegateeAgent?: never }
    | { delegation?: never; delegateeAgent: Address }
  );

/**
 * Permanently retire a legacy reputation delegation. This never restores the
 * delegated reputation: restoration after a dispute slash would recreate the
 * retired slash-shelter primitive. The exit is permissionless, while rent can
 * only reach the recorded authority (continuous identity) or canonical treasury
 * (closed/re-registered identity).
 */
export async function revokeDelegation(
  input: RevokeDelegationFacadeInput,
) {
  const authority =
    typeof input.authority === "string"
      ? input.authority
      : input.authority.address;
  const delegation =
    input.delegation ??
    (
      await findDelegationPda({
        delegatorAgent: input.delegatorAgent,
        delegateeAgent: input.delegateeAgent,
      })
    )[0];
  const instruction = getRevokeDelegationInstruction({
    authority,
    delegatorAgent: input.delegatorAgent,
    delegation,
  });

  if (!input.recovery) return instruction;

  const protocolConfig =
    input.recovery.protocolConfig ?? (await findProtocolConfigPda())[0];
  return Object.freeze({
    ...instruction,
    accounts: [
      ...instruction.accounts,
      { address: protocolConfig, role: AccountRole.READONLY },
      { address: input.recovery.treasury, role: AccountRole.WRITABLE },
    ],
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
 * only needed for token-denominated skills. The price, version, and content hash
 * form one compare-and-swap snapshot; any intervening skill edit fails before
 * payment.
 */
export type PurchaseSkillInput = PurchaseSkillAsyncInput;

export async function purchaseSkill(input: PurchaseSkillInput) {
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
