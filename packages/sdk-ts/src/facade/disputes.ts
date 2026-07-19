// Facade: ergonomic, named entry points over the generated client for the dispute
// lifecycle. Thin by design — the generated client already resolves most PDAs and
// encodes data; the facade adds friendly signatures, defaults, and (for the multi-PDA
// settlement flows) derives the completion-bond accounts so callers cannot omit them.
// Never import from generated/ internals other than its public exports.
import { AccountRole, type Address } from "@solana/kit";
import {
  // builders
  getInitiateDisputeInstructionAsync,
  // P6.3: `getVoteDisputeInstructionAsync` retired — the arbiter vote/quorum model is
  // gone; disputes are decided by an assigned resolver (the dispute-resolver roster).
  getResolveDisputeInstructionAsync,
  getExpireDisputeInstructionAsync,
  getCancelDisputeInstructionAsync,
  getApplyDisputeSlashInstructionAsync,
  getApplyInitiatorSlashInstructionAsync,
  getResolveRejectFrozenInstructionAsync,
  getExpireRejectFrozenInstructionAsync,
  getAssignDisputeResolverInstructionAsync,
  getRevokeDisputeResolverInstructionAsync,
  // input types
  type AssignDisputeResolverAsyncInput,
  type RevokeDisputeResolverAsyncInput,
  type InitiateDisputeAsyncInput,
  type ResolveDisputeAsyncInput,
  type ExpireDisputeAsyncInput,
  type CancelDisputeAsyncInput,
  type ApplyDisputeSlashAsyncInput,
  type ApplyInitiatorSlashAsyncInput,
  type ResolveRejectFrozenAsyncInput,
  type ExpireRejectFrozenAsyncInput,
  // PDA helpers
  findDisputePda,
  findDisputeResolverPda,
  findCreatorCompletionBondPda,
  findWorkerCompletionBondPda,
  findTaskSubmissionPda,
  findBidBookPda,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../generated/index.js";

export {
  findDisputePda,
  findDisputeResolverPda,
  findCreatorCompletionBondPda,
  findWorkerCompletionBondPda,
};

/**
 * Build an initiate_dispute instruction. The dispute, rate-limit, protocol-config,
 * and initiator-claim PDAs all auto-derive from the supplied ids/accounts.
 */
export async function initiateDispute(input: InitiateDisputeAsyncInput) {
  return getInitiateDisputeInstructionAsync(input);
}

/** One exact additional-worker bundle consumed by both dispute exit handlers. */
export type DisputePeerWorkerAccounts = {
  claim: Address;
  worker: Address;
  /** Defaults to the canonical [task_submission, claim] PDA. */
  taskSubmission?: Address;
};

/** Frozen accepted-bid state appended to every BidExclusive dispute exit. */
export type DisputeBidSettlement = {
  /** Defaults to the canonical [bid_book, task] PDA. */
  bidBook?: Address;
  acceptedBid: Address;
  bidderMarketState: Address;
};

type DisputeRemainingAccounts = {
  /** Canonical parent prefix; required when the Rust dependency gate applies. */
  dependencyParent?: Address;
  /** Exactly current_workers - 1 peer bundles, in deterministic worker order. */
  peerWorkers?: readonly DisputePeerWorkerAccounts[];
  /** Required for every BidExclusive dispute exit. */
  bidSettlement?: DisputeBidSettlement;
};

async function appendDisputeRemainingAccounts<
  TInstruction extends {
    readonly accounts: readonly { address: Address; role: AccountRole }[];
  },
>(
  instruction: TInstruction,
  task: Address,
  remaining: DisputeRemainingAccounts,
) {
  const accounts: { address: Address; role: AccountRole }[] = [
    ...instruction.accounts,
  ];
  if (remaining.dependencyParent) {
    accounts.push({
      address: remaining.dependencyParent,
      role: AccountRole.READONLY,
    });
  }
  for (const peer of remaining.peerWorkers ?? []) {
    const submission =
      peer.taskSubmission ??
      (await findTaskSubmissionPda({ claim: peer.claim }))[0];
    accounts.push(
      { address: peer.claim, role: AccountRole.WRITABLE },
      { address: peer.worker, role: AccountRole.WRITABLE },
      { address: submission, role: AccountRole.WRITABLE },
    );
  }
  if (remaining.bidSettlement) {
    const bidBook =
      remaining.bidSettlement.bidBook ??
      (await findBidBookPda({ task }))[0];
    accounts.push(
      { address: bidBook, role: AccountRole.WRITABLE },
      { address: remaining.bidSettlement.acceptedBid, role: AccountRole.WRITABLE },
      {
        address: remaining.bidSettlement.bidderMarketState,
        role: AccountRole.WRITABLE,
      },
    );
  }
  return { ...instruction, accounts };
}

// P6.3: the `voteDispute` facade wrapper is removed. `vote_dispute` no longer exists on
// the program — the arbiter vote/quorum model is retired and disputes are decided by an
// assigned resolver via `resolveDispute` (see `assignDisputeResolver`).

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
 * (`resolvedCount`, `lastResolvedAt`) are recorded; the protocol authority resolving
 * directly passes `resolverAssignment: null`. The deciding resolver + rationale hash
 * are persisted on the dispute and emitted in `DisputeResolved`.
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
  > & {
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
  } & DisputeRemainingAccounts;

export async function resolveDispute(input: ResolveDisputeInput) {
  const {
    workerBondAuthority,
    creatorCompletionBond,
    workerCompletionBond,
    taskSubmission,
    dependencyParent,
    peerWorkers,
    bidSettlement,
    ...rest
  } = input;

  const workerAuthority =
    workerBondAuthority ?? (rest.workerWallet as Address | undefined);
  if (!workerAuthority) {
    throw new Error(
      "resolveDispute: provide workerBondAuthority (or workerWallet) so the worker completion-bond PDA can be derived",
    );
  }

  const creatorBond =
    creatorCompletionBond ??
    (await findCreatorCompletionBondPda({
      task: rest.task,
      creator: rest.creator,
    }))[0];
  const workerBond =
    workerCompletionBond ??
    (await findWorkerCompletionBondPda({
      task: rest.task,
      workerAuthority,
    }))[0];

  const submission =
    taskSubmission ??
    (await findTaskSubmissionPda({ claim: rest.workerClaim }))[0];
  const instruction = await getResolveDisputeInstructionAsync({
    ...rest,
    creatorCompletionBond: creatorBond,
    workerCompletionBond: workerBond,
    taskSubmission: submission,
  });
  return appendDisputeRemainingAccounts(instruction, input.task, {
    dependencyParent,
    peerWorkers,
    bidSettlement,
  });
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
  > & {
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
  const {
    workerBondAuthority,
    creatorCompletionBond,
    workerCompletionBond,
    taskSubmission,
    dependencyParent,
    peerWorkers,
    bidSettlement,
    ...rest
  } = input;

  const workerAuthority =
    workerBondAuthority ?? (rest.workerWallet as Address | undefined);
  if (!workerAuthority) {
    throw new Error(
      "expireDispute: provide workerBondAuthority (or workerWallet) so the worker completion-bond PDA can be derived",
    );
  }

  const creatorBond =
    creatorCompletionBond ??
    (await findCreatorCompletionBondPda({
      task: rest.task,
      creator: rest.creator,
    }))[0];
  const workerBond =
    workerCompletionBond ??
    (await findWorkerCompletionBondPda({
      task: rest.task,
      workerAuthority,
    }))[0];

  const submission =
    taskSubmission ??
    (await findTaskSubmissionPda({ claim: rest.workerClaim }))[0];
  const instruction = await getExpireDisputeInstructionAsync({
    ...rest,
    creatorCompletionBond: creatorBond,
    workerCompletionBond: workerBond,
    taskSubmission: submission,
  });
  return appendDisputeRemainingAccounts(instruction, input.task, {
    dependencyParent,
    peerWorkers,
    bidSettlement,
  });
}

/**
 * Build a cancel_dispute instruction (initiator-only). protocol-config auto-derives.
 *
 * The facade appends the required remaining accounts in their frozen order:
 * - `[0]` `defendant`, the dispute defendant's writable AgentRegistration.
 * - `[1]` `taskValidationConfig` — REQUIRED when the task is a schema-0
 *   (pre-batch-3) manual-validation task (audit H-1 follow-up): the program derives
 *   the restore status from its pending-submission counter for legacy tasks and fails
 *   closed with TaskValidationConfigRequired when it is missing. Schema-1 and
 *   non-manual tasks do not need it.
 */
export type CancelDisputeInput = CancelDisputeAsyncInput & {
  /** The dispute's defendant AgentRegistration; always writable and required. */
  defendant: Address;
  /** Required only for schema-0 manual-validation tasks. */
  taskValidationConfig?: Address;
};

export async function cancelDispute(input: CancelDisputeInput) {
  const { defendant, taskValidationConfig, ...generatedInput } = input;
  const instruction = await getCancelDisputeInstructionAsync(generatedInput);
  return {
    ...instruction,
    accounts: [
      ...instruction.accounts,
      { address: defendant, role: AccountRole.WRITABLE },
      ...(taskValidationConfig
        ? [{ address: taskValidationConfig, role: AccountRole.READONLY } as const]
        : []),
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
type ApplyDisputeSlashBase = Omit<
  ApplyDisputeSlashAsyncInput,
  | "escrow"
  | "tokenEscrowAta"
  | "treasuryTokenAccount"
  | "rewardMint"
  | "tokenProgram"
  | "creator"
>;

type ApplyDisputeSlashWithoutTokenSettlement = {
  /** Required for every token task, even when its reserve is already closed. */
  escrow?: Address;
  tokenEscrowAta?: never;
  treasuryTokenAccount?: never;
  rewardMint?: never;
  tokenProgram?: never;
  creator?: never;
};

type ApplyDisputeSlashWithTokenSettlement = {
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
  const settlementValues = [
    input.tokenEscrowAta,
    input.treasuryTokenAccount,
    input.rewardMint,
    input.tokenProgram,
    input.creator,
  ];
  const settlementRequested = settlementValues.some((value) => value !== undefined);
  if (
    settlementRequested &&
    (!input.escrow ||
      !input.tokenEscrowAta ||
      !input.treasuryTokenAccount ||
      !input.rewardMint ||
      !input.creator)
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
    ...input,
    tokenProgram: settlementRequested
      ? input.tokenProgram
      : AGENC_COORDINATION_PROGRAM_ADDRESS,
  });
}

/** Build an apply_initiator_slash instruction. protocol-config auto-derives. */
export async function applyInitiatorSlash(input: ApplyInitiatorSlashAsyncInput) {
  return getApplyInitiatorSlashInstructionAsync(input);
}

/**
 * Build a resolve_reject_frozen instruction. The completion-bond PDAs here ARE
 * auto-derived by the generated builder (from task/creator and task/worker-authority),
 * along with escrow, the task submission, and protocol-config.
 */
export type ResolveRejectFrozenInput = ResolveRejectFrozenAsyncInput;

export async function resolveRejectFrozen(input: ResolveRejectFrozenInput) {
  return getResolveRejectFrozenInstructionAsync(input);
}

/**
 * Build an expire_reject_frozen instruction. Escrow, task submission, protocol config,
 * hire record, and both completion-bond PDAs auto-derive in the generated builder.
 */
export type ExpireRejectFrozenInput = ExpireRejectFrozenAsyncInput;

export async function expireRejectFrozen(input: ExpireRejectFrozenInput) {
  return getExpireRejectFrozenInstructionAsync(input);
}

/**
 * Build an assign_dispute_resolver instruction (authority-only).
 *
 * Adds `resolver` to the dispute-resolver roster so that wallet can resolve disputes
 * directly (no vote tally, no quorum). The `disputeResolver` roster PDA (seeded by
 * `resolver`), `protocolConfig`, and `systemProgram` all auto-derive in the generated
 * builder — the caller supplies only the `authority` signer and the `resolver` pubkey.
 */
export async function assignDisputeResolver(
  input: AssignDisputeResolverAsyncInput,
) {
  return getAssignDisputeResolverInstructionAsync(input);
}

/**
 * Build a revoke_dispute_resolver instruction (authority-only).
 *
 * Removes a wallet from the dispute-resolver roster, closing its assignment PDA. The
 * generated builder does NOT derive the roster PDA (its on-chain seed reads the stored
 * `resolver`), so the facade derives it from the `resolver` pubkey when `disputeResolver`
 * is not passed explicitly. protocolConfig still auto-derives.
 */
export async function revokeDisputeResolver(
  input: Omit<RevokeDisputeResolverAsyncInput, "disputeResolver"> & {
    /** The roster member being removed. Used to derive the assignment PDA. */
    resolver?: Address;
    /** Optional pre-derived override for the assignment PDA. */
    disputeResolver?: Address;
  },
) {
  const { resolver, disputeResolver, ...rest } = input;
  let roster = disputeResolver;
  if (!roster) {
    if (!resolver) {
      throw new Error(
        "revokeDisputeResolver: provide resolver (or disputeResolver) so the roster PDA can be derived",
      );
    }
    roster = (await findDisputeResolverPda({ resolver }))[0];
  }
  return getRevokeDisputeResolverInstructionAsync({
    ...rest,
    disputeResolver: roster,
  });
}
