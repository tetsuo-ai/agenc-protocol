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
import {
  AccountRole,
  address,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  canonicalizeFacadeInputSignerFields,
  stabilizeTransactionSigner,
} from "../client/signer-identity.js";
import {
  snapshotFixedBytes,
  snapshotOptionalFixedBytes,
} from "../values/fixed-bytes.js";
import {
  snapshotOptionOrNullable,
  snapshotOptionalAddress,
} from "../values/options.js";

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
  return getStakeReputationInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
}

/** Withdraw a reputation stake; the reputationStake PDA is auto-derived from agent. */
export async function withdrawReputationStake(
  input: WithdrawReputationStakeAsyncInput,
) {
  return getWithdrawReputationStakeInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
}

/** Delegate reputation between agents; the delegation PDA is auto-derived from the agent pair. */
export async function delegateReputation(input: DelegateReputationAsyncInput) {
  return getDelegateReputationInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
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
} & (
  | { delegation: Address; delegateeAgent?: never }
  | { delegation?: never; delegateeAgent: Address }
);

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

function ownDataField<T extends object, K extends keyof T>(
  input: T,
  key: K,
  label: string,
  optional = false,
): T[K] | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = getOwnPropertyDescriptor(input, key);
  } catch (cause) {
    throw new TypeError(`${label} must be safely inspectable`, { cause });
  }
  if (descriptor === undefined) {
    if (optional) return undefined;
    throw new TypeError(`${label} must be an own data property`);
  }
  if (!("value" in descriptor)) {
    throw new TypeError(`${label} must be an own data property`);
  }
  return descriptor.value as T[K];
}

function snapshotRevokeDelegationRecovery(
  recovery: RevokeDelegationFacadeInput["recovery"],
): RevokeDelegationFacadeInput["recovery"] {
  if (recovery === undefined) return undefined;
  if (typeof recovery !== "object" || recovery === null) {
    throw new TypeError("revokeDelegation: recovery must be an object");
  }
  const treasury = ownDataField(
    recovery,
    "treasury",
    "revokeDelegation: recovery.treasury",
  );
  const protocolConfig = ownDataField(
    recovery,
    "protocolConfig",
    "revokeDelegation: recovery.protocolConfig",
    true,
  );
  return Object.freeze({
    treasury: address(treasury!),
    ...(protocolConfig === undefined
      ? {}
      : { protocolConfig: address(protocolConfig) }),
  });
}

/**
 * Permanently retire a legacy reputation delegation. This never restores the
 * delegated reputation: restoration after a dispute slash would recreate the
 * retired slash-shelter primitive. The exit is permissionless, while rent can
 * only reach the recorded authority (continuous identity) or canonical treasury
 * (closed/re-registered identity).
 */
export async function revokeDelegation(input: RevokeDelegationFacadeInput) {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("revokeDelegation: input must be an object");
  }
  const rawAuthority = ownDataField(
    input,
    "authority",
    "revokeDelegation: authority",
  )!;
  const authority =
    typeof rawAuthority === "string"
      ? address(rawAuthority)
      : stabilizeTransactionSigner(rawAuthority).address;
  const delegatorAgent = address(
    ownDataField(input, "delegatorAgent", "revokeDelegation: delegatorAgent")!,
  );
  const explicitDelegation = ownDataField(
    input,
    "delegation",
    "revokeDelegation: delegation",
    true,
  );
  const delegateeAgent = ownDataField(
    input,
    "delegateeAgent",
    "revokeDelegation: delegateeAgent",
    true,
  );
  const recovery = snapshotRevokeDelegationRecovery(
    ownDataField(input, "recovery", "revokeDelegation: recovery", true),
  );
  if (explicitDelegation === undefined && delegateeAgent === undefined) {
    throw new TypeError(
      "revokeDelegation: provide delegation or delegateeAgent as an own data property",
    );
  }
  const delegation =
    explicitDelegation === undefined
      ? (
          await findDelegationPda({
            delegatorAgent,
            delegateeAgent: address(delegateeAgent!),
          })
        )[0]
      : address(explicitDelegation);
  const instruction = getRevokeDelegationInstruction({
    authority,
    delegatorAgent,
    delegation,
  });

  if (!recovery) return instruction;

  const protocolConfig =
    recovery.protocolConfig ?? (await findProtocolConfigPda())[0];
  return Object.freeze({
    ...instruction,
    accounts: [
      ...instruction.accounts,
      { address: protocolConfig, role: AccountRole.READONLY },
      { address: recovery.treasury, role: AccountRole.WRITABLE },
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
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  return getRegisterSkillInstructionAsync({
    ...stableInput,
    skillId: snapshotFixedBytes(
      stableInput.skillId,
      32,
      "registerSkill: skillId",
    ),
    name: snapshotFixedBytes(stableInput.name, 32, "registerSkill: name"),
    contentHash: snapshotFixedBytes(
      stableInput.contentHash,
      32,
      "registerSkill: contentHash",
    ),
    priceMint: snapshotOptionalAddress(
      stableInput.priceMint ?? null,
      "registerSkill: priceMint",
    ),
    tags: snapshotFixedBytes(stableInput.tags, 64, "registerSkill: tags"),
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
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  return getUpdateSkillInstructionAsync({
    ...stableInput,
    contentHash: snapshotFixedBytes(
      stableInput.contentHash,
      32,
      "updateSkill: contentHash",
    ),
    tags: snapshotOptionalFixedBytes(
      stableInput.tags ?? null,
      64,
      "updateSkill: tags",
    ),
    isActive: snapshotOptionOrNullable(
      stableInput.isActive ?? null,
      "updateSkill: isActive",
    ),
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
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  return getRateSkillInstructionAsync({
    ...stableInput,
    reviewHash: snapshotOptionalFixedBytes(
      stableInput.reviewHash ?? null,
      32,
      "rateSkill: reviewHash",
    ),
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
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  return getPurchaseSkillInstructionAsync({
    ...stableInput,
    expectedContentHash: snapshotFixedBytes(
      stableInput.expectedContentHash,
      32,
      "purchaseSkill: expectedContentHash",
    ),
  });
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
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  return getPostToFeedInstructionAsync({
    ...stableInput,
    contentHash: snapshotFixedBytes(
      stableInput.contentHash,
      32,
      "postToFeed: contentHash",
    ),
    nonce: snapshotFixedBytes(stableInput.nonce, 32, "postToFeed: nonce"),
    topic: snapshotFixedBytes(stableInput.topic, 32, "postToFeed: topic"),
    parentPost: snapshotOptionalAddress(
      stableInput.parentPost ?? null,
      "postToFeed: parentPost",
    ),
  });
}

/** Upvote a post; the vote PDA (from post + voter) and protocolConfig PDA are auto-derived. */
export async function upvotePost(input: UpvotePostAsyncInput) {
  return getUpvotePostInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
}
