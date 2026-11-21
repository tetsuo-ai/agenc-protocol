// Facade: ergonomic, named entry points over the generated client for the dispute
// lifecycle. Thin by design — the generated client already resolves most PDAs and
// encodes data; the facade adds friendly signatures, defaults, and (for the multi-PDA
// settlement flows) derives the completion-bond accounts so callers cannot omit them.
// Never import from generated/ internals other than its public exports.
import {
  AccountRole,
  type AccountMeta,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  // builders
  getInitiateDisputeInstructionAsync,
  // P6.3: `getVoteDisputeInstructionAsync` retired — the per-case arbiter vote/quorum
  // model is gone; a threshold-approved authority or threshold-seated resolver decides.
  getResolveDisputeInstructionAsync,
  getExpireDisputeInstructionAsync,
  getSettleDisputeClaimInstructionAsync,
  getCancelDisputeInstructionAsync,
  getApplyDisputeSlashInstructionAsync,
  getApplyInitiatorSlashInstructionAsync,
  getResolveRejectFrozenInstructionAsync,
  getExpireRejectFrozenInstructionAsync,
  getDisputeRejectionInstructionAsync,
  getAssignDisputeResolverInstructionAsync,
  getRevokeDisputeResolverInstructionAsync,
  // input types
  type AssignDisputeResolverAsyncInput,
  type RevokeDisputeResolverAsyncInput,
  type InitiateDisputeAsyncInput,
  type ResolveDisputeAsyncInput,
  type ExpireDisputeAsyncInput,
  type SettleDisputeClaimAsyncInput,
  type CancelDisputeAsyncInput,
  type ApplyDisputeSlashAsyncInput,
  type ApplyInitiatorSlashAsyncInput,
  type ResolveRejectFrozenAsyncInput,
  type ExpireRejectFrozenAsyncInput,
  type DisputeRejectionAsyncInput,
  // PDA helpers
  findDisputePda,
  findDisputeResolverPda,
  findCreatorCompletionBondPda,
  findWorkerCompletionBondPda,
  findTaskSubmissionPda,
  findTaskValidationConfigPda,
  findBidBookPda,
  findClaimPda,
  findCreatorStatsPda,
  findWorkerStatsPda,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../generated/index.js";
import { canonicalizeFacadeInputSignerFields } from "../client/signer-identity.js";
import { snapshotFixedBytes } from "../values/fixed-bytes.js";
import { assertCanonicalHash32 } from "../values/hash.js";
import {
  snapshotDenseStructuredArray,
  snapshotStructuredClone,
} from "../values/structured-clone.js";
import {
  appendMultisigSignerMetas,
  snapshotMultisigFacadeInput,
} from "./wire.js";

export {
  findDisputePda,
  findDisputeResolverPda,
  findCreatorCompletionBondPda,
  findWorkerCompletionBondPda,
};

/**
 * Build an initiate_dispute instruction. The dispute, rate-limit, protocol-config,
 * initiator-claim and dispute-bond PDAs all auto-derive from the supplied
 * ids/accounts.
 *
 * Revision 9: the filer posts a bond into `["dispute_bond", dispute]`:
 * `values.disputeBondForTask` (10% of the reward, or of the defendant's share on a
 * Collaborative task, at least 0.01 SOL), plus the bond account's rent, which
 * always comes back. A ruling for the filer, or no ruling in time, returns the
 * bond. A ruling against the filer, or the filer cancelling, sends it to the
 * respondent. Refused on single-worker review tasks
 * (`DisputeRefusedOnReviewTask`, 6425): there the buyer turns work down with
 * `rejectAndFreeze` and the worker disputes that with {@link disputeRejection}.
 */
export async function initiateDispute(input: InitiateDisputeAsyncInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  return getInitiateDisputeInstructionAsync({
    ...stableInput,
    disputeId: snapshotFixedBytes(
      stableInput.disputeId,
      32,
      "initiateDispute: disputeId",
    ),
    taskId: snapshotFixedBytes(
      stableInput.taskId,
      32,
      "initiateDispute: taskId",
    ),
    evidenceHash: snapshotFixedBytes(
      stableInput.evidenceHash,
      32,
      "initiateDispute: evidenceHash",
    ),
  });
}

/** Frozen accepted-bid state appended to every BidExclusive dispute exit. */
export type DisputeBidSettlement = {
  /** Defaults to the canonical [bid_book, task] PDA. */
  bidBook?: Address;
  acceptedBid: Address;
  bidderMarketState: Address;
};

export type DisputeRemainingAccounts = {
  /** Canonical parent prefix; required when the Rust dependency gate applies. */
  dependencyParent?: Address;
  /** Required for every BidExclusive dispute exit. */
  bidSettlement?: DisputeBidSettlement;
};

export type RequiredMultisigApprovals = {
  /** ProtocolConfig owner approvals appended as readonly-signer remaining accounts. */
  readonly multisigSigners: readonly TransactionSigner[];
};

export type ResolveDisputeAuthorization =
  | {
      /** Roster PDA proving the signer is an assigned resolver. */
      resolverAssignment: Address;
      /** Assigned resolvers do not use protocol-owner approvals. */
      readonly multisigSigners?: never;
    }
  | ({
      /** Omit the roster PDA when the protocol authority rules directly. */
      resolverAssignment?: undefined;
    } & RequiredMultisigApprovals);

async function appendDisputeRemainingAccounts<
  TInstruction extends {
    readonly accounts: readonly AccountMeta[];
  },
>(
  instruction: TInstruction,
  task: Address,
  remaining: DisputeRemainingAccounts,
) {
  const accounts: AccountMeta[] = [...instruction.accounts];
  if (remaining.dependencyParent) {
    accounts.push({
      address: remaining.dependencyParent,
      role: AccountRole.READONLY,
    });
  }
  if (remaining.bidSettlement) {
    const bidBook =
      remaining.bidSettlement.bidBook ?? (await findBidBookPda({ task }))[0];
    accounts.push(
      { address: bidBook, role: AccountRole.WRITABLE },
      {
        address: remaining.bidSettlement.acceptedBid,
        role: AccountRole.WRITABLE,
      },
      {
        address: remaining.bidSettlement.bidderMarketState,
        role: AccountRole.WRITABLE,
      },
    );
  }
  return { ...instruction, accounts };
}

// P6.3: the `voteDispute` facade wrapper is removed. `vote_dispute` no longer exists on
// the program — the per-case arbiter vote/quorum model is retired and disputes are
// decided by a threshold-approved authority or threshold-seated assigned resolver.

/**
 * Build a resolve_dispute instruction.
 *
 * The completion-bond accounts are REQUIRED by the program and are NOT auto-derived
 * by the generated builder, so the facade derives the creator/worker completion-bond
 * PDAs here (seeded by [task, creator] and [task, worker-authority]) and passes them
 * — callers cannot accidentally omit them and dodge the bond forfeit. The bond
 * treasury (where forfeited bonds land) must be provided explicitly. Escrow,
 * protocol-config, hire-record, and the token/system programs still auto-derive.
 *
 * Pass the worker's *authority* (wallet) that posted the bond as `workerBondAuthority`;
 * it defaults to `workerWallet` when present, since that is the SOL recipient leg.
 *
 * P6.4 accountable rulings: the program now REQUIRES a reasoned ruling. Supply
 * `rationaleHash` (a 32-byte content hash of the off-chain rationale) and the bounded
 * `rationaleUri` (empty string allowed — the hash may carry the rationale alone, max
 * 256 bytes) — both are part of `ResolveDisputeAsyncInput` and flow straight through
 * to the generated builder. When an ASSIGNED resolver decides (rather than the protocol
 * authority), pass their roster PDA as `resolverAssignment` so their case counters
 * (`resolvedCount`, `lastResolvedAt`) are recorded. A direct ruling omits
 * `resolverAssignment` and supplies the current ProtocolConfig owner threshold
 * through `multisigSigners`; those signer metas are appended after every
 * dependency/peer/bid settlement account so Rust can remove approvals before parsing
 * the economic suffix. Revision 9 (review R4-1): any wallet may propose a direct
 * ruling as `authority`, exactly as for `resolveRejectFrozen`; two unconflicted
 * owners decide, and neither the task's creator nor the worker's wallet counts
 * toward the threshold. The deciding resolver + rationale hash are persisted on the
 * dispute and emitted in `DisputeResolved`.
 *
 * Audit F-9: to sweep the defendant's TaskSubmission on exit (decrement the review
 * counters and return its rent to the worker authority), pass `taskSubmission` and —
 * for manual-validation tasks with a still-live submission — `taskValidationConfig`
 * as optional trailing accounts. When omitted, `close_task` remains the sweep.
 */
export type ResolveDisputeInput = Omit<
  ResolveDisputeAsyncInput,
  | "creatorCompletionBond"
  | "workerCompletionBond"
  | "workerClaim"
  | "worker"
  | "workerWallet"
  | "taskSubmission"
  | "resolverAssignment"
  | "agentStats"
> & {
  /**
   * The defendant's record (revision 9: required). Defaults to the canonical
   * `["agent_stats", worker]` PDA; the program creates it when missing, paid by
   * the ruling authority.
   */
  agentStats?: Address;
  /** Canonical defendant claim; mandatory evidence on the live Rust handler. */
  workerClaim: Address;
  /** Defendant AgentRegistration; mandatory on every dispute exit. */
  worker: Address;
  /** Defendant authority/rent recipient; mandatory on every dispute exit. */
  workerWallet: Address;
  /** Defaults to the canonical [task_submission, workerClaim] PDA. */
  taskSubmission?: Address;
  /** Authority (wallet) that posted the worker completion bond. */
  workerBondAuthority?: Address;
  /** Optional pre-derived overrides; derived from task/creator/worker when omitted. */
  creatorCompletionBond?: Address;
  workerCompletionBond?: Address;
} & DisputeRemainingAccounts &
  ResolveDisputeAuthorization;

export async function resolveDispute(input: ResolveDisputeInput) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["authority"], {
      multisigRequired: false,
    });
  const {
    workerBondAuthority,
    creatorCompletionBond,
    workerCompletionBond,
    taskSubmission,
    dependencyParent,
    bidSettlement,
    ...rest
  } = generatedInput;
  const stableBidSettlement =
    bidSettlement === undefined
      ? undefined
      : snapshotStructuredClone(bidSettlement, "resolveDispute: bidSettlement");
  const stableRationaleHash = snapshotFixedBytes(
    rest.rationaleHash,
    32,
    "resolveDispute: rationaleHash",
  );

  const workerAuthority =
    workerBondAuthority ?? (rest.workerWallet as Address | undefined);
  if (!workerAuthority) {
    throw new Error(
      "resolveDispute: provide workerBondAuthority (or workerWallet) so the worker completion-bond PDA can be derived",
    );
  }

  const creatorBond =
    creatorCompletionBond ??
    (
      await findCreatorCompletionBondPda({
        task: rest.task,
        creator: rest.creator,
      })
    )[0];
  const workerBond =
    workerCompletionBond ??
    (
      await findWorkerCompletionBondPda({
        task: rest.task,
        workerAuthority,
      })
    )[0];

  const submission =
    taskSubmission ??
    (await findTaskSubmissionPda({ claim: rest.workerClaim }))[0];
  const defendantRecord =
    rest.agentStats ?? (await findWorkerStatsPda({ worker: rest.worker }))[0];
  const instruction = await getResolveDisputeInstructionAsync({
    ...rest,
    agentStats: defendantRecord,
    rationaleHash: stableRationaleHash,
    creatorCompletionBond: creatorBond,
    workerCompletionBond: workerBond,
    taskSubmission: submission,
  });
  const withSettlementAccounts = await appendDisputeRemainingAccounts(
    instruction,
    rest.task,
    {
      dependencyParent,
      bidSettlement: stableBidSettlement,
    },
  );
  return appendMultisigSignerMetas(
    withSettlementAccounts,
    stableMultisigSigners,
  );
}

/**
 * Build an expire_dispute instruction.
 *
 * Like resolve_dispute, the completion-bond accounts are REQUIRED and NOT
 * auto-derived, so the facade derives the creator/worker completion-bond PDAs and
 * passes them. Escrow, protocol-config, hire-record, and token program auto-derive.
 *
 * Pass the worker's *authority* (wallet) that posted the bond as `workerBondAuthority`;
 * it defaults to `workerWallet` when present.
 */
export type ExpireDisputeInput = Omit<
  ExpireDisputeAsyncInput,
  | "creatorCompletionBond"
  | "workerCompletionBond"
  | "workerClaim"
  | "worker"
  | "workerWallet"
  | "taskSubmission"
  | "workerStats"
> & {
  /**
   * The defendant's record (revision 9: required). Defaults to the canonical
   * `["agent_stats", worker]` PDA; created when missing, paid by `authority`.
   */
  workerStats?: Address;
  workerClaim: Address;
  worker: Address;
  workerWallet: Address;
  /** Defaults to the canonical [task_submission, workerClaim] PDA. */
  taskSubmission?: Address;
  /** Authority (wallet) that posted the worker completion bond. */
  workerBondAuthority?: Address;
  /** Optional pre-derived overrides; derived from task/creator/worker when omitted. */
  creatorCompletionBond?: Address;
  workerCompletionBond?: Address;
} & DisputeRemainingAccounts;

export async function expireDispute(input: ExpireDisputeInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  const {
    workerBondAuthority,
    creatorCompletionBond,
    workerCompletionBond,
    taskSubmission,
    dependencyParent,
    bidSettlement,
    ...rest
  } = stableInput;
  const stableBidSettlement =
    bidSettlement === undefined
      ? undefined
      : snapshotStructuredClone(bidSettlement, "expireDispute: bidSettlement");

  const workerAuthority =
    workerBondAuthority ?? (rest.workerWallet as Address | undefined);
  if (!workerAuthority) {
    throw new Error(
      "expireDispute: provide workerBondAuthority (or workerWallet) so the worker completion-bond PDA can be derived",
    );
  }

  const creatorBond =
    creatorCompletionBond ??
    (
      await findCreatorCompletionBondPda({
        task: rest.task,
        creator: rest.creator,
      })
    )[0];
  const workerBond =
    workerCompletionBond ??
    (
      await findWorkerCompletionBondPda({
        task: rest.task,
        workerAuthority,
      })
    )[0];

  const submission =
    taskSubmission ??
    (await findTaskSubmissionPda({ claim: rest.workerClaim }))[0];
  const defendantRecord =
    rest.workerStats ?? (await findWorkerStatsPda({ worker: rest.worker }))[0];
  const instruction = await getExpireDisputeInstructionAsync({
    ...rest,
    workerStats: defendantRecord,
    creatorCompletionBond: creatorBond,
    workerCompletionBond: workerBond,
    taskSubmission: submission,
  });
  return appendDisputeRemainingAccounts(instruction, rest.task, {
    dependencyParent,
    bidSettlement: stableBidSettlement,
  });
}

/**
 * Permissionlessly settle one deferred collaborative peer claim after a
 * dispute ruling (chunked settlement). One worker per transaction; the
 * dispute reaches its recorded terminal status when the last peer settles.
 * The defendant is excluded: its claim settles through the ruling and the
 * slash finalizers. `taskSubmission` defaults to the canonical
 * [task_submission, claim] PDA.
 *
 * Revision 9: `workerAuthority` is required. It must be the `authority`
 * stored in the peer's AgentRegistration (`worker`), else `UnauthorizedAgent`.
 * The peer claim's whole balance (rent and any deposit) and the peer's
 * submission rent close to that wallet; the AgentRegistration gets nothing.
 */
export type SettleDisputeClaimInput = Omit<
  SettleDisputeClaimAsyncInput,
  "taskSubmission"
> & {
  taskSubmission?: Address;
};

export async function settleDisputeClaim(input: SettleDisputeClaimInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  const { taskSubmission, ...rest } = stableInput;
  const submission =
    taskSubmission ??
    (await findTaskSubmissionPda({ claim: rest.claim as Address }))[0];
  return getSettleDisputeClaimInstructionAsync({
    ...rest,
    taskSubmission: submission,
  });
}

/**
 * Build a cancel_dispute instruction (initiator-only). protocol-config and the
 * dispute bond auto-derive.
 *
 * Revision 9 named accounts: the bond `["dispute_bond", dispute]`, the bond's
 * `respondent` (the task creator when a worker filed, the defendant worker's
 * wallet when the creator filed), the defendant's record (derived from
 * `defendant`) and the creator's record (derived from `creator`, the task's
 * creator wallet). Cancelling sends the bond principal to the respondent and its
 * rent back to the filer, and counts the filer's `disputesLost`. Records missing
 * on chain are created, paid by the cancelling filer. A dispute filed before
 * revision 9 has no bond: any writable `respondent` is accepted and nothing moves.
 *
 * The facade appends the required remaining accounts in their frozen order:
 * - `[0]` `defendant`, the dispute defendant's writable AgentRegistration.
 * - `[1]` writable `taskValidationConfig`, derived from `task` unless supplied.
 *   Required when cancellation restores PendingValidation (review-clock debt),
 *   and for schema-0 manual-validation tasks (pending-submission count).
 *   Non-review tasks may supply the empty canonical PDA; it is not read.
 */
export type CancelDisputeInput = Omit<
  CancelDisputeAsyncInput,
  "workerStats" | "creatorStats"
> & {
  /** The dispute's defendant AgentRegistration; always writable and required. */
  defendant: Address;
  /** The task's creator wallet (`task.creator`); derives its record. */
  creator?: Address;
  /** Override for the defendant's record; derived from `defendant`. */
  workerStats?: Address;
  /** Override for the creator's record; derived from `creator`. */
  creatorStats?: Address;
  /** Defaults to the canonical task validation PDA; always writable. */
  taskValidationConfig?: Address;
};

export async function cancelDispute(input: CancelDisputeInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  const {
    defendant,
    creator,
    workerStats,
    creatorStats,
    taskValidationConfig,
    ...generatedInput
  } = stableInput;
  if (creator === undefined && creatorStats === undefined) {
    throw new Error(
      "cancelDispute: provide the task's creator wallet as `creator` (or `creatorStats`) so the required creator record can be derived",
    );
  }
  const validation =
    taskValidationConfig ??
    (await findTaskValidationConfigPda({ task: generatedInput.task }))[0];
  const instruction = await getCancelDisputeInstructionAsync({
    ...generatedInput,
    workerStats:
      workerStats ?? (await findWorkerStatsPda({ worker: defendant }))[0],
    creatorStats:
      creatorStats ??
      (await findCreatorStatsPda({ authority: creator! }))[0],
  });
  return {
    ...instruction,
    accounts: [
      ...instruction.accounts,
      { address: defendant, role: AccountRole.WRITABLE },
      { address: validation, role: AccountRole.WRITABLE },
    ],
  };
}

/**
 * Build an apply_dispute_slash instruction. protocol-config + token program auto-derive.
 *
 * For TOKEN-denominated tasks the TaskEscrow account is always required. When a
 * deferred reserve may be live, TypeScript and the runtime both require the full
 * settlement set: escrow, token escrow ATA, treasury token ATA, mint, token program,
 * and creator (the escrow-rent recipient). On the no-settlement path the facade forces
 * the optional token-program slot to Anchor's None placeholder; Codama's SPL default
 * would otherwise signal a partial settlement and fail on-chain.
 */
export type ApplyDisputeSlashBase = Omit<
  ApplyDisputeSlashAsyncInput,
  | "escrow"
  | "tokenEscrowAta"
  | "treasuryTokenAccount"
  | "rewardMint"
  | "tokenProgram"
  | "creator"
>;

export type ApplyDisputeSlashWithoutTokenSettlement = {
  /** Required for every token task, even when its reserve is already closed. */
  escrow?: Address;
  tokenEscrowAta?: never;
  treasuryTokenAccount?: never;
  rewardMint?: never;
  tokenProgram?: never;
  creator?: never;
};

export type ApplyDisputeSlashWithTokenSettlement = {
  escrow: Address;
  tokenEscrowAta: Address;
  treasuryTokenAccount: Address;
  rewardMint: Address;
  /** Defaults to the canonical SPL Token program. */
  tokenProgram?: Address;
  /** Task creator; receives escrow/ATA rent and is validated on-chain. */
  creator: Address;
};

export type ApplyDisputeSlashInput = ApplyDisputeSlashBase &
  (
    | ApplyDisputeSlashWithoutTokenSettlement
    | ApplyDisputeSlashWithTokenSettlement
  );

export async function applyDisputeSlash(input: ApplyDisputeSlashInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  const settlementValues = [
    stableInput.tokenEscrowAta,
    stableInput.treasuryTokenAccount,
    stableInput.rewardMint,
    stableInput.tokenProgram,
    stableInput.creator,
  ];
  const settlementRequested = settlementValues.some(
    (value) => value !== undefined,
  );
  if (
    settlementRequested &&
    (!stableInput.escrow ||
      !stableInput.tokenEscrowAta ||
      !stableInput.treasuryTokenAccount ||
      !stableInput.rewardMint ||
      !stableInput.creator)
  ) {
    throw new Error(
      "applyDisputeSlash: token settlement requires escrow, tokenEscrowAta, treasuryTokenAccount, rewardMint, and creator",
    );
  }

  // Codama gives the optional token program its SPL default even when every
  // settlement account is absent. On-chain that non-None account signals a token
  // settlement attempt. Force Anchor's program-id placeholder on the no-settlement
  // path so SOL/finalize-only calls do not spuriously fail MissingTokenAccounts.
  return getApplyDisputeSlashInstructionAsync({
    ...stableInput,
    tokenProgram: settlementRequested
      ? stableInput.tokenProgram
      : AGENC_COORDINATION_PROGRAM_ADDRESS,
  });
}

/** Build an apply_initiator_slash instruction. protocol-config auto-derives. */
export async function applyInitiatorSlash(
  input: ApplyInitiatorSlashAsyncInput,
) {
  return getApplyInitiatorSlashInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
}

/** Longest `rationaleUri` a frozen-task ruling takes (keeps the v2 wire small). */
export const MAX_FROZEN_RATIONALE_URI_BYTES = 128;

/** Longest `evidenceUri` a dispute of a turn-down takes. */
export const MAX_REJECTION_EVIDENCE_URI_BYTES = 256;

function assertUtf8Within(value: string, max: number, label: string): void {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  const length = new TextEncoder().encode(value).length;
  if (length > max) {
    throw new RangeError(
      `${label} must be at most ${max} UTF-8 bytes (got ${length})`,
    );
  }
}

/**
 * Build a resolve_reject_frozen (v2) instruction: the 2-of-3 multisig rules on a
 * turned-down task. The completion-bond PDAs, escrow, task submission,
 * protocol-config, the turn-down's dispute bond `["dispute_bond", task]` and both
 * records (worker from `worker`, creator from `creator`) auto-derive.
 *
 * Revision 9 (new discriminator): a reasoned ruling. `rationaleHash` must be a
 * non-zero 32-byte hash of the off-chain rationale and `rationaleUri` at most 128
 * bytes (empty allowed). On a revision 9 turn-down the worker must have disputed
 * it (`RejectionDisputeRequired`, 6421) and the ruling must land by the bond's
 * `rulingDeadline` (`RulingWindowClosed`, 6423). Approve pays the worker as on
 * accept and returns its bond; uphold refunds the buyer and gives it the bond.
 * Owners who are the creator, the worker wallet, or a live operator or referrer
 * payee do not count toward the threshold.
 */
export type ResolveRejectFrozenInput = ResolveRejectFrozenAsyncInput & {
  /** Current ProtocolConfig M-of-N owner approvals, in remaining-account order. */
  readonly multisigSigners: readonly TransactionSigner[];
};

export async function resolveRejectFrozen(input: ResolveRejectFrozenInput) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["authority"]);
  const rationaleHash = snapshotFixedBytes(
    generatedInput.rationaleHash,
    32,
    "resolveRejectFrozen: rationaleHash",
  );
  assertCanonicalHash32(rationaleHash, "resolveRejectFrozen: rationaleHash");
  assertUtf8Within(
    generatedInput.rationaleUri,
    MAX_FROZEN_RATIONALE_URI_BYTES,
    "resolveRejectFrozen: rationaleUri",
  );
  const instruction = await getResolveRejectFrozenInstructionAsync({
    ...generatedInput,
    rationaleHash,
  });
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
}

/**
 * Build an expire_reject_frozen instruction. Escrow, task submission, protocol
 * config, hire record, both completion-bond PDAs, the turn-down's dispute bond and
 * both records (worker from `worker`, creator from `creator`) auto-derive. Anyone
 * may send it; a record missing on chain is created, paid by `authority`.
 *
 * What it does depends on the freeze:
 * - Revision 8 freeze (`freeze_kind` 0): after `reviewDeadlineAt`, the worker is
 *   paid as on accept.
 * - Revision 9 freeze, not disputed: after the dispute window
 *   (`reviewDeadlineAt`), the buyer gets the price and escrow rent back and the
 *   worker gets its claim and submission rent back. The worker is not paid.
 * - Revision 9 freeze, disputed and not ruled: after the bond's `rulingDeadline`,
 *   the buyer is refunded and the worker's bond (principal and rent) comes back.
 *
 * Read the outcome with `values.isDisputableFreeze` on the frozen submission and
 * the bond account before reporting it: a refund is never a payment.
 */
export type ExpireRejectFrozenInput = ExpireRejectFrozenAsyncInput;

export async function expireRejectFrozen(input: ExpireRejectFrozenInput) {
  return getExpireRejectFrozenInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
}

/**
 * Friendly input for {@link disputeRejection}. `worker` is the claim's worker
 * agent; `authority` is that agent's wallet, which signs and posts the bond.
 */
export type DisputeRejectionInput = Omit<
  DisputeRejectionAsyncInput,
  "claim" | "creatorStats"
> & {
  /** Defaults to the canonical `["claim", task, worker]` PDA. */
  claim?: Address;
  /** The task's creator wallet (`task.creator`); derives its record. */
  creator?: Address;
  /** Override for the creator's record; derived from `creator`. */
  creatorStats?: Address;
};

/**
 * Revision 9: the worker disputes a turn-down (a revision 9 `rejectAndFreeze`)
 * by posting a bond: `values.disputeBondForTask(task)` (10% of the price, at
 * least 0.01 SOL) into `["dispute_bond", task]`, plus that account's rent. The
 * 2-of-3 multisig then has the ruling window (72 hours on the production build;
 * the bond's `rulingDeadline` holds the exact end) to rule with
 * {@link resolveRejectFrozen}:
 * - for the worker: it is paid as on accept, and the bond comes back;
 * - for the buyer: the buyer is refunded and receives the bond principal;
 * - no ruling in time: the buyer is refunded and the bond comes back.
 *
 * One dispute per turn-down, filed while `now <= reviewDeadlineAt` of the frozen
 * submission (`RejectionDisputeWindowClosed`, 6419). A revision 8 freeze cannot be
 * disputed (`RejectionNotDisputable`, 6420). A suspended worker agent cannot
 * dispute.
 * `evidenceHash` must be non-zero; `evidenceUri` is at most 256 bytes (empty
 * allowed). Nothing here ever disputes on its own: the bond is at risk, so a
 * person (or an operator policy that is off by default) must choose to.
 */
export async function disputeRejection(input: DisputeRejectionInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  const { claim, creator, creatorStats, ...generatedInput } = stableInput;
  if (creator === undefined && creatorStats === undefined) {
    throw new Error(
      "disputeRejection: provide the task's creator wallet as `creator` (or `creatorStats`) so its record can be derived",
    );
  }
  const evidenceHash = snapshotFixedBytes(
    generatedInput.evidenceHash,
    32,
    "disputeRejection: evidenceHash",
  );
  assertCanonicalHash32(evidenceHash, "disputeRejection: evidenceHash");
  assertUtf8Within(
    generatedInput.evidenceUri,
    MAX_REJECTION_EVIDENCE_URI_BYTES,
    "disputeRejection: evidenceUri",
  );
  const [canonicalClaim] = await findClaimPda({
    task: generatedInput.task,
    bidder: generatedInput.worker,
  });
  if (claim !== undefined && claim !== canonicalClaim) {
    throw new Error(
      "disputeRejection: `claim` is not the canonical claim of `worker` on this task",
    );
  }
  return getDisputeRejectionInstructionAsync({
    ...generatedInput,
    claim: canonicalClaim,
    creatorStats:
      creatorStats ??
      (await findCreatorStatsPda({ authority: creator! }))[0],
    evidenceHash,
  });
}

/**
 * Build an assign_dispute_resolver instruction (authority-proposed, multisig-approved).
 *
 * Adds `resolver` to the dispute-resolver roster so that wallet can resolve disputes
 * directly (no vote tally, no quorum). The `disputeResolver` roster PDA (seeded by
 * `resolver`), `protocolConfig`, and `systemProgram` all auto-derive in the generated
 * builder. Pass the current ProtocolConfig threshold owners in `multisigSigners`;
 * they are appended as deterministic readonly-signer remaining accounts. The field is
 * required at the TypeScript boundary because the on-chain roster mutation always
 * fails unless the configured threshold actually signs.
 */
export type AssignDisputeResolverInput = AssignDisputeResolverAsyncInput &
  RequiredMultisigApprovals;

export async function assignDisputeResolver(input: AssignDisputeResolverInput) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["authority"]);
  const instruction =
    await getAssignDisputeResolverInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
}

/**
 * Build a revoke_dispute_resolver instruction (authority-proposed, multisig-approved).
 *
 * Removes a wallet from the dispute-resolver roster, closing its assignment PDA. The
 * generated builder does NOT derive the roster PDA (its on-chain seed reads the stored
 * `resolver`), so the facade derives it from the `resolver` pubkey when `disputeResolver`
 * is not passed explicitly. protocolConfig still auto-derives. Current ProtocolConfig
 * owner approvals are appended from `multisigSigners` in caller-provided order.
 */
export type RevokeDisputeResolverInput = Omit<
  RevokeDisputeResolverAsyncInput,
  "disputeResolver"
> & {
  /** The roster member being removed. Used to derive the assignment PDA. */
  resolver?: Address;
  /** Optional pre-derived override for the assignment PDA. */
  disputeResolver?: Address;
} & RequiredMultisigApprovals;

export async function revokeDisputeResolver(input: RevokeDisputeResolverInput) {
  const {
    generatedInput: stableInput,
    multisigSigners: stableMultisigSigners,
  } = snapshotMultisigFacadeInput(input, ["authority"]);
  const { resolver, disputeResolver, ...generatedInput } = stableInput;
  let roster = disputeResolver;
  if (!roster) {
    if (!resolver) {
      throw new Error(
        "revokeDisputeResolver: provide resolver (or disputeResolver) so the roster PDA can be derived",
      );
    }
    roster = (await findDisputeResolverPda({ resolver }))[0];
  }
  const instruction = await getRevokeDisputeResolverInstructionAsync({
    ...generatedInput,
    disputeResolver: roster,
  });
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
}
