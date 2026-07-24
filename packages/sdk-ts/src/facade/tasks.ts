// Facade: ergonomic, named entry points over the generated client for the task
// lifecycle. Thin by design — the generated Async builders already resolve PDAs
// (task, escrow, claim, submission, validation/protocol config, rate limits) and
// encode instruction data; the facade adds friendly, typed, named signatures.
//
// Lifecycle covered: create_task, create_task_humanless, create_dependent_task,
// claim_task_with_job_spec (claim_task plain is fail-closed in the program — wrap
// this instead), submit_task_result, accept/reject/auto_accept/validate result,
// request_changes, reject_and_freeze, complete_task, cancel_task, close_task,
// reclaim_orphan_task_child, expire_claim, and the Batch-3 contest lifecycle (create_task[Competitive] +
// configure_task_validation[CreatorReview] via createContestTask,
// distribute_ghost_share, reclaim_terminal_claim). complete_task_private (ZK) is
// intentionally out of scope here.
//
// Never import from generated/ internals other than its public exports.
import {
  AccountRole,
  address,
  type AccountMeta,
  type Address,
} from "@solana/kit";
import {
  findModerationAttestorPda,
  findModerationBlockPda,
  findTaskModerationPda,
  getCreateTaskInstructionAsync,
  getCreateDirectAssignmentTaskInstructionAsync,
  getCreateTaskHumanlessInstructionAsync,
  getCreateDependentTaskInstructionAsync,
  getClaimTaskWithJobSpecInstructionAsync,
  getAcceptDirectAssignmentWithJobSpecInstructionAsync,
  getSubmitTaskResultInstructionAsync,
  getAcceptTaskResultInstructionAsync,
  getRejectTaskResultInstructionAsync,
  getAutoAcceptTaskResultInstructionAsync,
  getValidateTaskResultInstructionAsync,
  getRequestChangesInstructionAsync,
  getRejectAndFreezeInstructionAsync,
  getCompleteTaskInstructionAsync,
  getCancelTaskInstructionAsync,
  getCloseTaskInstructionDataEncoder,
  getReclaimOrphanTaskChildInstruction,
  getExpireClaimInstructionAsync,
  getConfigureTaskValidationInstructionAsync,
  getDistributeGhostShareInstructionAsync,
  getReclaimTerminalClaimInstructionAsync,
  getSetTaskJobSpecInstructionAsync,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findProtocolConfigPda,
  findTaskPda,
  findEscrowPda,
  findClaimPda,
  findHireRecordPda,
  findTaskJobSpecPda,
  findTaskSubmissionPda,
  findTaskValidationConfigPda,
  findCreatorCompletionBondPda,
  findWorkerCompletionBondPda,
  findBidBookPda,
  type CreateTaskAsyncInput,
  type CreateDirectAssignmentTaskAsyncInput,
  type CreateTaskHumanlessAsyncInput,
  type CreateDependentTaskAsyncInput,
  type ClaimTaskWithJobSpecAsyncInput,
  type AcceptDirectAssignmentWithJobSpecAsyncInput,
  type SubmitTaskResultAsyncInput,
  type AcceptTaskResultAsyncInput,
  type RejectTaskResultAsyncInput,
  type AutoAcceptTaskResultAsyncInput,
  type ValidateTaskResultAsyncInput,
  type RequestChangesAsyncInput,
  type RejectAndFreezeAsyncInput,
  type CompleteTaskAsyncInput,
  type CancelTaskAsyncInput,
  type CloseTaskAsyncInput,
  type ReclaimOrphanTaskChildInput,
  type ExpireClaimAsyncInput,
  type ConfigureTaskValidationAsyncInput,
  type DistributeGhostShareAsyncInput,
  type ReclaimTerminalClaimAsyncInput,
  type SetTaskJobSpecAsyncInput,
  DependencyType,
  ValidationMode,
} from "../generated/index.js";
import { DISPUTE_SAFE_MAX_WORKERS } from "../values/protocol-limits.js";
import { assertCanonicalHash32 } from "../values/hash.js";
import {
  snapshotFixedBytes,
  snapshotOptionalFixedBytes,
} from "../values/fixed-bytes.js";
import { snapshotOptionalAddress } from "../values/options.js";
import {
  snapshotDenseStructuredArray,
  snapshotStructuredClone,
} from "../values/structured-clone.js";
import { canonicalizeFacadeInputSignerFields } from "../client/signer-identity.js";

// Re-export the PDA helpers callers most often need to pre-derive task-lifecycle
// addresses (mirrors agents.ts re-exporting findAgentPda).
export {
  findTaskPda,
  findEscrowPda,
  findClaimPda,
  findTaskJobSpecPda,
  findTaskSubmissionPda,
  findTaskValidationConfigPda,
};

/**
 * The demand-side referral leg (P6.2) on a create/hire input. Both fields are
 * OPTIONAL in the facade: omit them (the default) for the exact pre-referrer
 * behavior. The facade defaults `referrer` to `null` (the Option::None the
 * program treats as "no referrer") and `referrerFeeBps` to `0`, which maps to
 * the on-chain no-leg/skip path in `resolve_referrer_snapshot` — no funds are
 * ever routed to a default/wrong address when no referrer is supplied. Pass a
 * real `referrer` address with a non-zero `referrerFeeBps` to opt a demand-side
 * embedder into the 4-way settlement split.
 */
export type OptionalReferrer<
  T extends { referrer: unknown; referrerFeeBps: number },
> = Omit<T, "referrer" | "referrerFeeBps"> & {
  referrer?: T["referrer"];
  referrerFeeBps?: number;
};

/** Apply the facade's referrer defaults (no-leg skip path): `null` / `0`. */
function withReferrerDefaults<
  T extends { referrer: unknown; referrerFeeBps: number },
>(input: OptionalReferrer<T>, label: string): T {
  const normalized = {
    referrer: null,
    referrerFeeBps: 0,
    ...input,
  } as T;
  return {
    ...normalized,
    referrer: snapshotOptionalAddress(
      normalized.referrer as Parameters<typeof snapshotOptionalAddress>[0],
      `${label}: referrer`,
    ),
  } as T;
}

function snapshotOptionalNested<T>(
  value: T | undefined,
  label: string,
): T | undefined {
  return value === undefined
    ? undefined
    : snapshotStructuredClone(value, label);
}

function assertDisputeSafeWorkerLimit(
  operation: string,
  maxWorkers: number,
): void {
  if (
    !Number.isInteger(maxWorkers) ||
    maxWorkers < 1 ||
    maxWorkers > DISPUTE_SAFE_MAX_WORKERS
  ) {
    throw new RangeError(
      `${operation}: maxWorkers must be an integer between 1 and ${DISPUTE_SAFE_MAX_WORKERS}.`,
    );
  }
}

/**
 * Create a task. Auto-derives the task, escrow, protocol-config, and
 * authority-rate-limit PDAs; token accounts default to the SPL/ATA programs.
 * For a plain SOL task, pass `rewardMintArg: null` and omit the token accounts.
 *
 * The P6.2 demand-side referral leg is optional: omit `referrer`/`referrerFeeBps`
 * for the exact pre-referrer behavior (they default to the no-leg skip path —
 * `referrer: null`, `referrerFeeBps: 0`).
 */
export async function createTask(
  input: OptionalReferrer<CreateTaskAsyncInput>,
) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, [
    "authority",
    "creator",
  ] as const);
  assertDisputeSafeWorkerLimit("createTask", stableInput.maxWorkers);
  return getCreateTaskInstructionAsync(
    withReferrerDefaults<CreateTaskAsyncInput>(
      {
        ...stableInput,
        taskId: snapshotFixedBytes(
          stableInput.taskId,
          32,
          "createTask: taskId",
        ),
        description: snapshotFixedBytes(
          stableInput.description,
          64,
          "createTask: description",
        ),
        constraintHash: snapshotOptionalFixedBytes(
          stableInput.constraintHash,
          32,
          "createTask: constraintHash",
        ),
        rewardMintArg: snapshotOptionalAddress(
          stableInput.rewardMintArg,
          "createTask: rewardMintArg",
        ),
      },
      "createTask",
    ),
  );
}

/**
 * Create an Exclusive task that is assignable only through the bilateral
 * creator-and-worker acceptance rail. The caller cannot select a public task
 * type, more than one worker, or a referrer leg: ExternalAttestation settlement
 * intentionally has no referrer payout path.
 *
 * Before building this instruction against a live cluster, read its surface and
 * require `directAssignment`; an upgraded-but-unstamped program rejects the
 * instruction on-chain as well.
 */
export type CreateDirectAssignmentTaskInput = Omit<
  CreateDirectAssignmentTaskAsyncInput,
  "maxWorkers" | "taskType" | "referrer" | "referrerFeeBps"
>;

export async function createDirectAssignmentTask(
  input: CreateDirectAssignmentTaskInput,
) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, [
    "authority",
    "creator",
  ] as const);
  return getCreateDirectAssignmentTaskInstructionAsync({
    ...stableInput,
    taskId: snapshotFixedBytes(
      stableInput.taskId,
      32,
      "createDirectAssignmentTask: taskId",
    ),
    description: snapshotFixedBytes(
      stableInput.description,
      64,
      "createDirectAssignmentTask: description",
    ),
    constraintHash: snapshotOptionalFixedBytes(
      stableInput.constraintHash,
      32,
      "createDirectAssignmentTask: constraintHash",
    ),
    rewardMintArg: snapshotOptionalAddress(
      stableInput.rewardMintArg,
      "createDirectAssignmentTask: rewardMintArg",
    ),
    maxWorkers: 1,
    taskType: 0,
    referrer: null,
    referrerFeeBps: 0,
  });
}

/**
 * Create a "humanless" task owned by a plain buyer wallet (no AgentRegistration).
 * Forces a CreatorReview validation config so it can never settle on the auto-pay
 * path. Auto-derives task, escrow, validation config, protocol config, and the
 * wallet-scoped rate limit.
 *
 * The P6.2 demand-side referral leg is optional and defaults to the no-leg skip
 * path (`referrer: null`, `referrerFeeBps: 0`).
 */
export async function createTaskHumanless(
  input: OptionalReferrer<CreateTaskHumanlessAsyncInput>,
) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["creator"]);
  return getCreateTaskHumanlessInstructionAsync(
    withReferrerDefaults<CreateTaskHumanlessAsyncInput>(
      {
        ...stableInput,
        taskId: snapshotFixedBytes(
          stableInput.taskId,
          32,
          "createTaskHumanless: taskId",
        ),
        description: snapshotFixedBytes(
          stableInput.description,
          64,
          "createTaskHumanless: description",
        ),
      },
      "createTaskHumanless",
    ),
  );
}

/**
 * Create a task that depends on a parent task. Caller supplies `parentTask`;
 * the rest of the task/escrow/config/rate-limit PDAs auto-derive.
 */
export async function createDependentTask(
  input: CreateDependentTaskAsyncInput,
) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, [
    "authority",
    "creator",
  ] as const);
  assertDisputeSafeWorkerLimit("createDependentTask", stableInput.maxWorkers);
  return getCreateDependentTaskInstructionAsync({
    ...stableInput,
    taskId: snapshotFixedBytes(
      stableInput.taskId,
      32,
      "createDependentTask: taskId",
    ),
    description: snapshotFixedBytes(
      stableInput.description,
      64,
      "createDependentTask: description",
    ),
    constraintHash: snapshotOptionalFixedBytes(
      stableInput.constraintHash,
      32,
      "createDependentTask: constraintHash",
    ),
    rewardMintArg: snapshotOptionalAddress(
      stableInput.rewardMintArg,
      "createDependentTask: rewardMintArg",
    ),
  });
}

/**
 * Claim a task against its pre-existing pinned job-spec pointer. Wraps claim_task_with_job_spec
 * (plain claim_task is fail-closed in the program). Auto-derives the task-job-spec
 * pointer, the claim PDA, and protocol config from `task`/`worker`. Proof-dependent
 * tasks must pass their exact `parentTask`; the facade appends it as the read-only
 * remaining account required by the on-chain assignment gate.
 */
export type ClaimTaskWithJobSpecInput = Omit<
  ClaimTaskWithJobSpecAsyncInput,
  "moderationBlock"
> & {
  /** Job-spec hash used to derive the mandatory assignment-time BLOCK floor. */
  jobSpecHash?: Uint8Array;
  /** Override for the canonical [moderation_block, jobSpecHash] PDA. */
  moderationBlock?: Address;
  /** Required for every dependent task; omit only for independent tasks. */
  parentTask?: Address;
};

export async function claimTaskWithJobSpec(input: ClaimTaskWithJobSpecInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  const { jobSpecHash, moderationBlock, parentTask, ...generatedInput } =
    stableInput;
  const stableJobSpecHash =
    jobSpecHash === undefined
      ? undefined
      : snapshotFixedBytes(
          jobSpecHash,
          32,
          "claimTaskWithJobSpec: jobSpecHash",
        );
  if (!moderationBlock && !stableJobSpecHash) {
    throw new Error(
      "claimTaskWithJobSpec: provide jobSpecHash (or moderationBlock) for the assignment-time BLOCK check",
    );
  }
  const block =
    moderationBlock ??
    (await findModerationBlockPda({ contentHash: stableJobSpecHash! }))[0];
  const instruction = await getClaimTaskWithJobSpecInstructionAsync({
    ...generatedInput,
    moderationBlock: block,
  });
  return {
    ...instruction,
    accounts: [
      ...instruction.accounts,
      ...(parentTask
        ? [{ address: parentTask, role: AccountRole.READONLY } as const]
        : []),
    ],
  };
}

/**
 * Bind a direct-assignment task to one worker. Both the creator and the worker
 * must sign the same transaction, and the signed data pins the job-spec hash,
 * its exact update timestamp, and the external attestor. The moderation block
 * PDA derives from that exact hash unless explicitly supplied.
 */
export type AcceptDirectAssignmentWithJobSpecInput = Omit<
  AcceptDirectAssignmentWithJobSpecAsyncInput,
  "moderationBlock" | "expectedJobSpecHash"
> & {
  /** SHA-256 of the pinned job specification to which both parties consent. */
  expectedJobSpecHash: Uint8Array;
  /** Override for the canonical [moderation_block, expectedJobSpecHash] PDA. */
  moderationBlock?: Address;
};

export async function acceptDirectAssignmentWithJobSpec(
  input: AcceptDirectAssignmentWithJobSpecInput,
) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, [
    "creator",
    "workerAuthority",
  ] as const);
  const stableJobSpecHash = snapshotFixedBytes(
    stableInput.expectedJobSpecHash,
    32,
    "acceptDirectAssignmentWithJobSpec: expectedJobSpecHash",
  );
  assertCanonicalHash32(
    stableJobSpecHash,
    "acceptDirectAssignmentWithJobSpec: expectedJobSpecHash",
  );
  const { moderationBlock, ...generatedInput } = stableInput;
  const block =
    moderationBlock ??
    (await findModerationBlockPda({ contentHash: stableJobSpecHash }))[0];
  return getAcceptDirectAssignmentWithJobSpecInstructionAsync({
    ...generatedInput,
    expectedJobSpecHash: stableJobSpecHash,
    expectedAttestor: address(stableInput.expectedAttestor),
    moderationBlock: block,
  });
}

/**
 * Submit a worker result for a claimed task. Auto-derives claim, validation
 * config, submission, and protocol-config PDAs from `task`/`worker`.
 */
export async function submitTaskResult(input: SubmitTaskResultAsyncInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  return getSubmitTaskResultInstructionAsync({
    ...stableInput,
    proofHash: snapshotFixedBytes(
      stableInput.proofHash,
      32,
      "submitTaskResult: proofHash",
    ),
    resultData: snapshotOptionalFixedBytes(
      stableInput.resultData,
      64,
      "submitTaskResult: resultData",
    ),
  });
}

/**
 * Creator accepts a submitted result and settles the escrow. Caller supplies the
 * settlement parties (treasury, worker, workerAuthority); claim/escrow/submission/
 * validation/protocol PDAs auto-derive. Pass token accounts only for token tasks.
 */
export type BidCompletionSettlement = {
  /** Defaults to the canonical [bid_book, task] PDA. */
  bidBook?: Address;
  acceptedBid: Address;
  bidderMarketState: Address;
  /** Bidder wallet receiving accepted-bid rent/bond. */
  bidderAuthority?: Address;
};

/**
 * BidExclusive rejection reopens the book and refunds the accepted bidder to
 * the generated instruction's named `workerAuthority`. Rust therefore consumes
 * exactly three settlement metas and no caller-selected fourth recipient.
 */
export type BidRejectionSettlement = Omit<
  BidCompletionSettlement,
  "bidderAuthority"
> & {
  bidderAuthority?: never;
};

export type BidRejectionRemainingAccounts = {
  /** Required only for a Proof-dependent BidExclusive rejection. */
  dependencyParent?: Address;
  /** Required whenever `bidSettlement` is supplied so its prefix is unambiguous. */
  dependencyType?: DependencyType;
  /** Exact three-account suffix consumed by the on-chain rejection path. */
  bidSettlement?: BidRejectionSettlement;
};

export type CompletionRemainingAccounts = {
  /** Required for every dependent task and always occupies remaining slot 0. */
  dependencyParent?: Address;
  /** Required for BidExclusive completion/accept settlement. */
  bidSettlement?: BidCompletionSettlement;
};

async function appendCompletionRemainingAccounts<
  TInstruction extends { readonly accounts: readonly AccountMeta[] },
>(
  instruction: TInstruction,
  task: Address,
  remaining: CompletionRemainingAccounts,
  defaultBidderAuthority?: Address,
) {
  const accounts: AccountMeta[] = [...instruction.accounts];
  if (remaining.dependencyParent) {
    accounts.push({
      address: remaining.dependencyParent,
      role: AccountRole.READONLY,
    });
  }
  if (remaining.bidSettlement) {
    const bidderAuthority =
      remaining.bidSettlement.bidderAuthority ?? defaultBidderAuthority;
    if (!bidderAuthority) {
      throw new Error(
        "BidExclusive settlement requires bidderAuthority (the accepted bidder wallet)",
      );
    }
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
      { address: bidderAuthority, role: AccountRole.WRITABLE },
    );
  }
  return { ...instruction, accounts };
}

function snapshotBidRejectionSettlement(
  value: BidRejectionSettlement | undefined,
  label: string,
): BidRejectionSettlement | undefined {
  const snapshot = snapshotOptionalNested(value, label);
  if (snapshot === undefined) return undefined;
  if (Object.hasOwn(snapshot, "bidderAuthority")) {
    throw new TypeError(
      `${label}: bidderAuthority must be omitted; rejection refunds the named workerAuthority`,
    );
  }
  return Object.freeze({
    ...(snapshot.bidBook === undefined
      ? {}
      : { bidBook: address(snapshot.bidBook) }),
    acceptedBid: address(snapshot.acceptedBid),
    bidderMarketState: address(snapshot.bidderMarketState),
  });
}

function bidRejectionDependencyParent(
  label: string,
  remaining: BidRejectionRemainingAccounts,
): Address | undefined {
  const { bidSettlement, dependencyParent, dependencyType } = remaining;
  if (bidSettlement === undefined) {
    if (dependencyParent !== undefined) {
      throw new Error(
        `${label}: dependencyParent is only consumed with BidExclusive rejection settlement`,
      );
    }
    return undefined;
  }
  if (dependencyType === undefined) {
    throw new Error(
      `${label}: dependencyType is required for BidExclusive rejection settlement`,
    );
  }
  if (
    dependencyType !== DependencyType.None &&
    dependencyType !== DependencyType.Data &&
    dependencyType !== DependencyType.Ordering &&
    dependencyType !== DependencyType.Proof
  ) {
    throw new RangeError(`${label}: dependencyType is invalid`);
  }
  if (dependencyType === DependencyType.Proof) {
    if (dependencyParent === undefined) {
      throw new Error(
        `${label}: dependencyParent is required for a Proof-dependent BidExclusive rejection`,
      );
    }
    return address(dependencyParent);
  }
  if (dependencyParent !== undefined) {
    throw new Error(
      `${label}: dependencyParent must be omitted unless dependencyType is Proof`,
    );
  }
  return undefined;
}

async function appendBidRejectionRemainingAccounts<
  TInstruction extends { readonly accounts: readonly AccountMeta[] },
>(
  instruction: TInstruction,
  task: Address,
  remaining: BidRejectionRemainingAccounts,
  label: string,
) {
  const dependencyParent = bidRejectionDependencyParent(label, remaining);
  if (remaining.bidSettlement === undefined) return instruction;
  const bidBook =
    remaining.bidSettlement.bidBook ?? (await findBidBookPda({ task }))[0];
  return {
    ...instruction,
    accounts: [
      ...instruction.accounts,
      ...(dependencyParent === undefined
        ? []
        : [{ address: dependencyParent, role: AccountRole.READONLY } as const]),
      { address: bidBook, role: AccountRole.WRITABLE } as const,
      {
        address: remaining.bidSettlement.acceptedBid,
        role: AccountRole.WRITABLE,
      } as const,
      {
        address: remaining.bidSettlement.bidderMarketState,
        role: AccountRole.WRITABLE,
      } as const,
    ],
  };
}

export type AcceptTaskResultInput = AcceptTaskResultAsyncInput &
  CompletionRemainingAccounts;

export async function acceptTaskResult(input: AcceptTaskResultInput) {
  const signerStableInput = canonicalizeFacadeInputSignerFields(input, [
    "creator",
  ]);
  const stableInput = {
    ...signerStableInput,
    bidSettlement: snapshotOptionalNested(
      signerStableInput.bidSettlement,
      "acceptTaskResult: bidSettlement",
    ),
  };
  const { dependencyParent, bidSettlement, ...generatedInput } = stableInput;
  const hireRecord =
    stableInput.hireRecord ??
    (await findHireRecordPda({ task: stableInput.task }))[0];
  const instruction = await getAcceptTaskResultInstructionAsync({
    ...generatedInput,
    hireRecord,
  });
  return appendCompletionRemainingAccounts(
    instruction,
    stableInput.task,
    { dependencyParent, bidSettlement },
    stableInput.workerAuthority,
  );
}

/**
 * Creator rejects a submitted result (with a rejection hash). Auto-derives
 * validation config, submission, and protocol-config PDAs from `task`/`worker`.
 */
export type RejectTaskResultInput = RejectTaskResultAsyncInput &
  BidRejectionRemainingAccounts;

export async function rejectTaskResult(input: RejectTaskResultInput) {
  const signerStableInput = canonicalizeFacadeInputSignerFields(input, [
    "creator",
  ]);
  const stableInput = {
    ...signerStableInput,
    bidSettlement: snapshotBidRejectionSettlement(
      signerStableInput.bidSettlement,
      "rejectTaskResult: bidSettlement",
    ),
  };
  const { dependencyParent, dependencyType, bidSettlement, ...generatedInput } =
    stableInput;
  const parentForWire = bidRejectionDependencyParent("rejectTaskResult", {
    dependencyParent,
    dependencyType,
    bidSettlement,
  });
  const instruction = await getRejectTaskResultInstructionAsync({
    ...generatedInput,
    rejectionHash: snapshotFixedBytes(
      stableInput.rejectionHash,
      32,
      "rejectTaskResult: rejectionHash",
    ),
  });
  return appendBidRejectionRemainingAccounts(
    instruction,
    stableInput.task,
    {
      dependencyParent: parentForWire,
      dependencyType,
      bidSettlement,
    },
    "rejectTaskResult",
  );
}

/**
 * Permissionlessly auto-accept a result once its review window has elapsed.
 * Settles like accept but the signer is any `authority`, not the creator.
 *
 * Since audit F-10 the hire-record account is REQUIRED + seeds-pinned (the
 * permissionless path can no longer skip operator/referrer legs by omitting it):
 * the facade derives it from [hire, task] when not supplied — for non-hired
 * tasks that is the empty system-owned PDA, which settles with no legs, exactly
 * as before.
 */
export async function autoAcceptTaskResult(input: AutoAcceptTaskResultInput) {
  const signerStableInput = canonicalizeFacadeInputSignerFields(input, [
    "authority",
  ]);
  const stableInput = {
    ...signerStableInput,
    bidSettlement: snapshotOptionalNested(
      signerStableInput.bidSettlement,
      "autoAcceptTaskResult: bidSettlement",
    ),
  };
  const { dependencyParent, bidSettlement, ...generatedInput } = stableInput;
  const hireRecord =
    stableInput.hireRecord ??
    (await findHireRecordPda({ task: stableInput.task }))[0];
  const instruction = await getAutoAcceptTaskResultInstructionAsync({
    ...generatedInput,
    hireRecord,
  });
  return appendCompletionRemainingAccounts(
    instruction,
    stableInput.task,
    { dependencyParent, bidSettlement },
    stableInput.workerAuthority,
  );
}

export type AutoAcceptTaskResultInput = Omit<
  AutoAcceptTaskResultAsyncInput,
  "hireRecord"
> & {
  /** Defaults to the derived [hire, task] PDA (audit F-10). */
  hireRecord?: Address;
} & CompletionRemainingAccounts;

/**
 * Validator (or validator-quorum) approve/reject of a submitted result. Pass
 * `approved`; on approval it settles the escrow. Auto-derives claim, escrow,
 * validation config/vote, submission, attestor config, and protocol-config PDAs.
 */
export type ValidateTaskResultInput = ValidateTaskResultAsyncInput &
  CompletionRemainingAccounts & {
    /**
     * The task's on-chain dependency type. Required when a BidExclusive
     * rejection also supplies `dependencyParent`, because Rust reserves slot 0
     * for that parent only for Proof dependencies. On acceptance, declaring a
     * dependent type also lets the facade fail before signing if the canonical
     * parent is missing.
     */
    dependencyType?: DependencyType;
  };

function validationAcceptanceDependencyParent(
  input: ValidateTaskResultInput,
): Address | undefined {
  const { dependencyParent, dependencyType } = input;
  const declaredDependent =
    dependencyType !== undefined && dependencyType !== DependencyType.None;

  if (declaredDependent && dependencyParent === undefined) {
    throw new Error(
      "validateTaskResult: dependencyParent is required when accepting a declared dependent task",
    );
  }
  if (
    dependencyType === DependencyType.None &&
    dependencyParent !== undefined
  ) {
    throw new Error(
      "validateTaskResult: dependencyParent must be omitted for an independent task",
    );
  }
  return dependencyParent;
}

export async function validateTaskResult(input: ValidateTaskResultInput) {
  const signerStableInput = canonicalizeFacadeInputSignerFields(input, [
    "reviewer",
  ]);
  const stableInput = signerStableInput.approved
    ? {
        ...signerStableInput,
        bidSettlement: snapshotOptionalNested(
          signerStableInput.bidSettlement,
          "validateTaskResult: bidSettlement",
        ),
      }
    : {
        ...signerStableInput,
        bidSettlement: snapshotBidRejectionSettlement(
          signerStableInput.bidSettlement as BidRejectionSettlement | undefined,
          "validateTaskResult: bidSettlement",
        ),
      };
  const { dependencyParent, dependencyType, bidSettlement, ...generatedInput } =
    stableInput;
  const parentForWire = stableInput.approved
    ? validationAcceptanceDependencyParent(stableInput)
    : bidRejectionDependencyParent("validateTaskResult", {
        dependencyParent,
        dependencyType,
        bidSettlement: bidSettlement as BidRejectionSettlement | undefined,
      });
  const instruction =
    await getValidateTaskResultInstructionAsync(generatedInput);
  if (!stableInput.approved) {
    return appendBidRejectionRemainingAccounts(
      instruction,
      stableInput.task,
      {
        dependencyParent: parentForWire,
        dependencyType,
        bidSettlement: bidSettlement as BidRejectionSettlement | undefined,
      },
      "validateTaskResult",
    );
  }
  return appendCompletionRemainingAccounts(
    instruction,
    stableInput.task,
    { dependencyParent: parentForWire, bidSettlement },
    stableInput.workerAuthority,
  );
}

/**
 * Creator requests changes on a submission (with a changes hash), returning the
 * task to the worker. Auto-derives validation config, submission, and protocol
 * config from `task`/`claim`.
 */
export async function requestChanges(input: RequestChangesAsyncInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["creator"]);
  return getRequestChangesInstructionAsync({
    ...stableInput,
    changesHash: snapshotFixedBytes(
      stableInput.changesHash,
      32,
      "requestChanges: changesHash",
    ),
  });
}

/**
 * Creator rejects and freezes a submission (with a rejection hash) pending
 * dispute. Auto-derives validation config, submission, and protocol config.
 */
export async function rejectAndFreeze(input: RejectAndFreezeAsyncInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["creator"]);
  return getRejectAndFreezeInstructionAsync({
    ...stableInput,
    rejectionHash: snapshotFixedBytes(
      stableInput.rejectionHash,
      32,
      "rejectAndFreeze: rejectionHash",
    ),
  });
}

/**
 * Worker completes a task on the direct-pay path, settling the escrow. Caller
 * supplies the settlement parties (creator, worker, treasury) and the always-
 * required hire-record address (the derived ["hire", task] PDA even for non-hired
 * tasks). Claim/escrow/protocol PDAs auto-derive.
 */
export type CompleteTaskInput = CompleteTaskAsyncInput &
  CompletionRemainingAccounts;

export async function completeTask(input: CompleteTaskInput) {
  const signerStableInput = canonicalizeFacadeInputSignerFields(input, [
    "authority",
  ]);
  const stableInput = {
    ...signerStableInput,
    bidSettlement: snapshotOptionalNested(
      signerStableInput.bidSettlement,
      "completeTask: bidSettlement",
    ),
  };
  const { dependencyParent, bidSettlement, ...generatedInput } = stableInput;
  const instruction = await getCompleteTaskInstructionAsync({
    ...generatedInput,
    proofHash: snapshotFixedBytes(
      generatedInput.proofHash,
      32,
      "completeTask: proofHash",
    ),
    resultData: snapshotOptionalFixedBytes(
      generatedInput.resultData,
      64,
      "completeTask: resultData",
    ),
  });
  return appendCompletionRemainingAccounts(
    instruction,
    stableInput.task,
    { dependencyParent, bidSettlement },
    stableInput.authority.address,
  );
}

export type CancelTaskWorkerAccounts = {
  /** Canonical TaskClaim PDA; closed by cancel_task. */
  claim: Address;
  /** Claimed worker AgentRegistration; active_tasks is decremented. */
  workerAgent: Address;
  /** Worker authority receiving claim rent; must match workerAgent.authority. */
  workerAuthority: Address;
};

export type CancelTaskBidSettlement =
  | {
      /** BidExclusive task with no accepted worker. */
      kind: "open";
      /** Defaults to the canonical [bid_book, task] PDA. */
      bidBook?: Address;
    }
  | {
      /** BidExclusive task with one accepted/no-show worker. */
      kind: "accepted";
      /** Defaults to the canonical [bid_book, task] PDA. */
      bidBook?: Address;
      acceptedBid: Address;
      bidderMarketState: Address;
    };

export type CancelTaskInput = Omit<
  CancelTaskAsyncInput,
  "creatorCompletionBond" | "workerCompletionBond" | "workerBondAuthority"
> & {
  /** Any wallet; the no-show forfeit binds it to a live claim worker (audit F-1). */
  workerBondAuthority: Address;
  /** Defaults to the derived [completion_bond, task, authority] PDA (audit F5/F12). */
  creatorCompletionBond?: Address;
  /** Defaults to the derived [completion_bond, task, workerBondAuthority] PDA. */
  workerCompletionBond?: Address;
  /** One complete claim/agent/wallet triple for every live worker. */
  workerAccounts?: readonly CancelTaskWorkerAccounts[];
  /**
   * Optional canonical parent prefix for dependent-task cancellation. Supplying
   * a Completed parent proves worker fault; omission keeps the exit live but
   * forces dependency-related bond disposition to refund/no-slash.
   */
  dependencyParent?: Address;
  /** Required for BidExclusive cancellation; fixes the remaining-account wire. */
  bidSettlement?: CancelTaskBidSettlement;
};

function snapshotCancelTaskWorkerAccounts(
  value: readonly CancelTaskWorkerAccounts[] | undefined,
): readonly CancelTaskWorkerAccounts[] {
  const snapshot = snapshotDenseStructuredArray(
    value ?? [],
    "cancelTask: workerAccounts",
    DISPUTE_SAFE_MAX_WORKERS,
  );
  const normalized: CancelTaskWorkerAccounts[] = [];
  for (let index = 0; index < snapshot.length; index += 1) {
    const entry = snapshot[index];
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError(
        `cancelTask: workerAccounts[${index}] must be an account record`,
      );
    }
    normalized[index] = Object.freeze({
      claim: address(entry.claim),
      workerAgent: address(entry.workerAgent),
      workerAuthority: address(entry.workerAuthority),
    });
  }
  return Object.freeze(normalized);
}

/**
 * Creator cancels a task and refunds the escrow. Auto-derives escrow and protocol
 * config; pass token accounts only for token tasks.
 *
 * Since audit F5/F12 the completion-bond accounts are REQUIRED + seeds-pinned on the
 * full surface: the facade derives them — the creator bond from [task, authority]
 * and the worker bond from [task, workerBondAuthority] — so callers pass only
 * `workerBondAuthority` (any wallet; the no-show forfeit binds it to a live claim
 * worker, audit F-1). settle no-ops when only the empty PDA exists.
 *
 * Audit C8: cancelling a CONTEST task whose drained claims carry entry deposits
 * forfeits those deposits to the protocol treasury — pass `treasury` (the
 * `ProtocolConfig.treasury` pubkey) on that path or the call fails closed with
 * ContestForfeitTreasuryRequired. Every other task can omit it.
 *
 * Pass one `workerAccounts` triple per live claim. For BidExclusive tasks also
 * select `bidSettlement`: `open` derives and closes the empty bid book, while
 * `accepted` appends the book, accepted bid, and bidder market state after the
 * single worker triple in the exact order required by the program.
 */
export async function cancelTask(input: CancelTaskInput) {
  const signerStableInput = canonicalizeFacadeInputSignerFields(input, [
    "authority",
  ]);
  const stableInput = {
    ...signerStableInput,
    workerAccounts: snapshotCancelTaskWorkerAccounts(
      signerStableInput.workerAccounts,
    ),
    bidSettlement: snapshotOptionalNested(
      signerStableInput.bidSettlement,
      "cancelTask: bidSettlement",
    ),
  };
  const {
    workerAccounts = [],
    dependencyParent,
    bidSettlement,
    ...generatedInput
  } = stableInput;
  const creatorCompletionBond =
    stableInput.creatorCompletionBond ??
    (
      await findCreatorCompletionBondPda({
        task: stableInput.task,
        creator: stableInput.authority.address,
      })
    )[0];
  const workerCompletionBond =
    stableInput.workerCompletionBond ??
    (
      await findWorkerCompletionBondPda({
        task: stableInput.task,
        workerAuthority: stableInput.workerBondAuthority,
      })
    )[0];
  if (bidSettlement?.kind === "open" && workerAccounts.length !== 0) {
    throw new Error(
      "cancelTask: BidExclusive open-book cancellation cannot include worker accounts",
    );
  }
  if (bidSettlement?.kind === "accepted" && workerAccounts.length !== 1) {
    throw new Error(
      "cancelTask: accepted BidExclusive cancellation requires exactly one worker account triple",
    );
  }

  const instruction = await getCancelTaskInstructionAsync({
    ...generatedInput,
    creatorCompletionBond,
    workerCompletionBond,
  });
  const workerMetas = workerAccounts.flatMap((worker) => [
    { address: worker.claim, role: AccountRole.WRITABLE } as const,
    { address: worker.workerAgent, role: AccountRole.WRITABLE } as const,
    { address: worker.workerAuthority, role: AccountRole.WRITABLE } as const,
  ]);
  let bidMetas: { address: Address; role: AccountRole }[] = [];
  if (bidSettlement) {
    const bidBook =
      bidSettlement.bidBook ??
      (await findBidBookPda({ task: stableInput.task }))[0];
    bidMetas = [{ address: bidBook, role: AccountRole.WRITABLE }];
    if (bidSettlement.kind === "accepted") {
      bidMetas.push(
        { address: bidSettlement.acceptedBid, role: AccountRole.WRITABLE },
        {
          address: bidSettlement.bidderMarketState,
          role: AccountRole.WRITABLE,
        },
      );
    }
  }
  return {
    ...instruction,
    accounts: [
      ...instruction.accounts,
      ...(dependencyParent
        ? [{ address: dependencyParent, role: AccountRole.READONLY } as const]
        : []),
      ...workerMetas,
      ...bidMetas,
    ],
  };
}

export type CloseTaskInput = Omit<
  CloseTaskAsyncInput,
  "taskJobSpec" | "escrow" | "listing" | "workerCompletionBond"
> & {
  /**
   * Defaults to the derived task-job-spec PDA because activated tasks should
   * reclaim that pointer on close. Pass `null` for terminal tasks that never
   * pinned a job spec.
   */
  taskJobSpec?: Address | null;
  /**
   * Defaults to `None`: normal terminal settlement paths close escrow before
   * the task becomes closable. Pass a still-alive, already-drained escrow only
   * for dispute-expiry cleanup.
   */
  escrow?: Address | null;
  /** Source listing for hired tasks; pass `null` for non-hired tasks. */
  listing?: Address | null;
  /** Optional live worker bond to liveness-check before close. */
  workerCompletionBond?: Address | null;
  /**
   * Set for BidExclusive tasks. The canonical bid book is derived when `true`,
   * or use an address to supply an explicit pre-derived account.
   */
  bidExclusive?: boolean | Address;
  /** Auxiliary child PDAs to sweep after the optional bid book. */
  children?: readonly CloseTaskChild[];
};

export type CloseTaskChild =
  | {
      kind: "creatorFunded";
      account: Address;
    }
  | {
      /** A TaskModeration record; rent returns to its stored moderator. */
      kind: "namedRecipient";
      account: Address;
      recipient: Address;
    }
  | ({
      kind: "workerSubmission";
      submission: Address;
      workerAgent: Address;
    } & (
      | {
          /**
           * Authenticated rent destination: the original worker authority for a
           * continuous identity, or the canonical treasury for a closed or
           * discontinuous revision-4 identity.
           */
          rentRecipient: Address;
          workerAuthority?: never;
        }
      | {
          /** @deprecated Use `rentRecipient`; recovery may pay the treasury. */
          workerAuthority: Address;
          rentRecipient?: never;
        }
    ));

// MarketplaceClient emits a v0 transaction without address lookup tables and
// prepends a compute-unit-limit instruction (plus an optional unit-price
// instruction). With a fee payer distinct from the authority, the nine fixed
// close_task metas, two signatures, and worst-case distinct keys, 28 total
// close_task metas serialize to at most 1,219 bytes. With 29 metas, the normal
// default-limit path is already 1,240 bytes (1,252 with a unit-price
// instruction), above Solana's 1,232-byte packet limit. Keep this facade's
// normal standalone send path constructible. Additional transaction composition
// still requires callers to size/preflight the complete message.
const CLOSE_TASK_FIXED_ACCOUNT_META_COUNT = 9;
const CLOSE_TASK_MAX_STANDALONE_ACCOUNT_META_COUNT = 28;
const CLOSE_TASK_MAX_REMAINING_ACCOUNT_META_COUNT =
  CLOSE_TASK_MAX_STANDALONE_ACCOUNT_META_COUNT -
  CLOSE_TASK_FIXED_ACCOUNT_META_COUNT;

function closeTaskChildAccountMetaCount(
  children: readonly CloseTaskChild[],
): number {
  let count = 0;
  for (const child of children) {
    count +=
      child.kind === "creatorFunded"
        ? 1
        : child.kind === "namedRecipient"
          ? 2
          : 3;
  }
  return count;
}

function snapshotCloseTaskChildren(
  value: readonly CloseTaskChild[] | undefined,
): readonly CloseTaskChild[] {
  const snapshot = snapshotDenseStructuredArray(
    value ?? [],
    "closeTask: children",
  );
  const normalized: CloseTaskChild[] = [];
  for (let index = 0; index < snapshot.length; index += 1) {
    const child = snapshot[index];
    if (typeof child !== "object" || child === null) {
      throw new TypeError(
        `closeTask: children[${index}] must be an account record`,
      );
    }
    if (child.kind === "creatorFunded") {
      normalized[index] = Object.freeze({
        kind: "creatorFunded",
        account: address(child.account),
      });
      continue;
    }
    if (child.kind === "namedRecipient") {
      normalized[index] = Object.freeze({
        kind: "namedRecipient",
        account: address(child.account),
        recipient: address(child.recipient),
      });
      continue;
    }
    if (child.kind === "workerSubmission") {
      const hasRentRecipient = child.rentRecipient !== undefined;
      const hasWorkerAuthority = child.workerAuthority !== undefined;
      if (hasRentRecipient === hasWorkerAuthority) {
        throw new TypeError(
          `closeTask: children[${index}] worker submission requires exactly one rent recipient`,
        );
      }
      const rentRecipient = address(
        (child.rentRecipient ?? child.workerAuthority)!,
      );
      normalized[index] = Object.freeze({
        kind: "workerSubmission",
        submission: address(child.submission),
        workerAgent: address(child.workerAgent),
        rentRecipient,
      });
      continue;
    }
    throw new TypeError(
      `closeTask: children[${index}] has an invalid child kind`,
    );
  }
  return Object.freeze(normalized);
}

function optionalAddress(value: Address | null | undefined): Address {
  return value ?? AGENC_COORDINATION_PROGRAM_ADDRESS;
}

/**
 * Sweep a terminal task while retaining its rent-exempt Task as the durable
 * liveness anchor for children that cannot be enumerated on-chain. Auto-derives
 * the optional job-spec pointer on the first pass, omits the normally-closed
 * escrow by default, and derives the required hire-record address when omitted.
 * Pass `listing` while a live hired-task record still needs its capacity slot
 * released.
 *
 * One standalone client transaction supports at most 19 remaining metas: the
 * optional bid book plus weighted `children` (creator-funded=1,
 * named-recipient=2, worker-submission=3). Split larger cleanup sets across
 * repeat calls. On later passes, use `taskJobSpec: null` after that pointer was
 * swept and omit every already-closed optional account. A BidExclusive task
 * must continue to pass `bidExclusive` on every pass, even after the canonical
 * book was swept, because Rust reserves that PDA as remaining-account slot 0.
 * `reclaimOrphanTaskChild` is only for a destroyed historical parent and cannot
 * replace this live-parent batching flow.
 */
export async function closeTask(input: CloseTaskInput) {
  const signerStableInput = canonicalizeFacadeInputSignerFields(input, [
    "authority",
  ]);
  const stableInput = {
    ...signerStableInput,
    children: snapshotCloseTaskChildren(signerStableInput.children),
  };
  const remainingAccountMetaCount =
    closeTaskChildAccountMetaCount(stableInput.children) +
    (stableInput.bidExclusive ? 1 : 0);
  if (remainingAccountMetaCount > CLOSE_TASK_MAX_REMAINING_ACCOUNT_META_COUNT) {
    throw new RangeError(
      `closeTask: bid book and children expand to ${remainingAccountMetaCount} remaining account metas; at most ${CLOSE_TASK_MAX_REMAINING_ACCOUNT_META_COUNT} are supported (${CLOSE_TASK_MAX_STANDALONE_ACCOUNT_META_COUNT} total) by the standalone client transaction`,
    );
  }
  const taskJobSpec =
    stableInput.taskJobSpec === undefined
      ? (await findTaskJobSpecPda({ task: stableInput.task }))[0]
      : optionalAddress(stableInput.taskJobSpec);
  const hireRecord =
    stableInput.hireRecord ??
    (await findHireRecordPda({ task: stableInput.task }))[0];
  const [protocolConfig] = await findProtocolConfigPda();

  const remainingAccounts: { address: Address; role: AccountRole }[] = [];
  if (stableInput.bidExclusive) {
    const bidBook =
      typeof stableInput.bidExclusive === "string"
        ? stableInput.bidExclusive
        : (await findBidBookPda({ task: stableInput.task }))[0];
    remainingAccounts.push({ address: bidBook, role: AccountRole.WRITABLE });
  }
  for (const child of stableInput.children ?? []) {
    if (child.kind === "creatorFunded") {
      remainingAccounts.push({
        address: child.account,
        role: AccountRole.WRITABLE,
      });
    } else if (child.kind === "namedRecipient") {
      remainingAccounts.push(
        { address: child.account, role: AccountRole.WRITABLE },
        { address: child.recipient, role: AccountRole.WRITABLE },
      );
    } else {
      const rentRecipient = child.rentRecipient ?? child.workerAuthority;
      remainingAccounts.push(
        { address: child.submission, role: AccountRole.WRITABLE },
        { address: child.workerAgent, role: AccountRole.READONLY },
        { address: rentRecipient, role: AccountRole.WRITABLE },
      );
    }
  }

  return {
    programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
    accounts: [
      { address: stableInput.task, role: AccountRole.WRITABLE },
      {
        address: taskJobSpec,
        role:
          stableInput.taskJobSpec === null
            ? AccountRole.READONLY
            : AccountRole.WRITABLE,
      },
      {
        address: optionalAddress(stableInput.escrow),
        role: stableInput.escrow ? AccountRole.WRITABLE : AccountRole.READONLY,
      },
      { address: hireRecord, role: AccountRole.WRITABLE },
      {
        address: optionalAddress(stableInput.listing),
        role: stableInput.listing ? AccountRole.WRITABLE : AccountRole.READONLY,
      },
      {
        address: stableInput.creatorCompletionBond,
        role: AccountRole.READONLY,
      },
      {
        address: optionalAddress(stableInput.workerCompletionBond),
        role: stableInput.workerCompletionBond
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
      },
      {
        address: stableInput.authority.address,
        role: AccountRole.WRITABLE_SIGNER,
        signer: stableInput.authority,
      },
      // Fix round (FIX 5): optional protocol_config, always supplied by the
      // facade (const-seed PDA). It validates the treasury payee when a
      // straggler submission's worker agent has been deregistered; harmless
      // (readonly) otherwise.
      { address: protocolConfig, role: AccountRole.READONLY },
      ...remainingAccounts,
    ],
    data: getCloseTaskInstructionDataEncoder().encode({}),
  };
}

export type ReclaimOrphanTaskChildFacadeInput = Omit<
  ReclaimOrphanTaskChildInput,
  "rentRecipient"
> &
  (
    | {
        /** Stored creator, moderator, reviewer, or continuous worker authority. */
        rentRecipient: Address;
        recovery?: never;
      }
    | {
        rentRecipient?: never;
        /**
         * Required only for a terminal submission whose revision-4 worker
         * identity was closed or re-registered. The facade uses `treasury` for
         * both the fixed rent-recipient meta and the exact recovery suffix.
         */
        recovery: {
          protocolConfig?: Address;
          treasury: Address;
        };
      }
  );

/**
 * Reclaim a historical rent-only child whose Task (or, for a validation vote,
 * TaskSubmission) was destroyed by an older program. Direct recipients use the
 * frozen five-meta wire. Closed/discontinuous worker identities append exactly
 * `[protocolConfig readonly, treasury writable]`; no caller-selected wallet can
 * receive that rent.
 */
export async function reclaimOrphanTaskChild(
  input: ReclaimOrphanTaskChildFacadeInput,
) {
  const signerStableInput = canonicalizeFacadeInputSignerFields(input, [
    "authority",
  ]);
  const stableInput = {
    ...signerStableInput,
    recovery: snapshotOptionalNested(
      signerStableInput.recovery,
      "reclaimOrphanTaskChild: recovery",
    ),
  };
  const rentRecipient = stableInput.recovery
    ? stableInput.recovery.treasury
    : stableInput.rentRecipient;
  if (rentRecipient === undefined) {
    throw new TypeError(
      "reclaimOrphanTaskChild: rentRecipient is required without recovery",
    );
  }
  const instruction = getReclaimOrphanTaskChildInstruction({
    child: stableInput.child,
    parentTask: stableInput.parentTask,
    workerAgent: stableInput.workerAgent,
    rentRecipient,
    authority: stableInput.authority,
  });
  if (!stableInput.recovery) return instruction;

  const protocolConfig =
    stableInput.recovery.protocolConfig ?? (await findProtocolConfigPda())[0];
  return Object.freeze({
    ...instruction,
    accounts: [
      ...instruction.accounts,
      { address: protocolConfig, role: AccountRole.READONLY },
      { address: stableInput.recovery.treasury, role: AccountRole.WRITABLE },
    ],
  });
}

/**
 * Permissionlessly expire a stale claim, freeing the task and paying the caller a
 * cleanup reward. Caller supplies `worker`/`rentRecipient`; escrow, claim,
 * validation config, submission, and protocol-config PDAs auto-derive. Dependent
 * Exclusive no-shows must pass their canonical parent. BidExclusive expiry also
 * supplies the accepted-bid settlement suffix in exact Rust order.
 */
export type ExpireClaimBidSettlement = {
  bidBook?: Address;
  acceptedBid: Address;
  bidderMarketState: Address;
  creator: Address;
};

export type ExpireClaimInput = ExpireClaimAsyncInput & {
  /** Parent prefix when the Rust exit path requires dependency evidence. */
  dependencyParent?: Address;
  /** Required for BidExclusive claim expiry. */
  bidSettlement?: ExpireClaimBidSettlement;
};

export async function expireClaim(input: ExpireClaimInput) {
  const signerStableInput = canonicalizeFacadeInputSignerFields(input, [
    "authority",
  ]);
  const stableInput = {
    ...signerStableInput,
    bidSettlement: snapshotOptionalNested(
      signerStableInput.bidSettlement,
      "expireClaim: bidSettlement",
    ),
  };
  const { dependencyParent, bidSettlement, ...generatedInput } = stableInput;
  const instruction = await getExpireClaimInstructionAsync(generatedInput);
  const remainingAccounts: { address: Address; role: AccountRole }[] = [];
  if (dependencyParent) {
    remainingAccounts.push({
      address: dependencyParent,
      role: AccountRole.READONLY,
    });
  }
  if (bidSettlement) {
    const bidBook =
      bidSettlement.bidBook ??
      (await findBidBookPda({ task: stableInput.task }))[0];
    remainingAccounts.push(
      { address: bidBook, role: AccountRole.WRITABLE },
      { address: bidSettlement.acceptedBid, role: AccountRole.WRITABLE },
      { address: bidSettlement.bidderMarketState, role: AccountRole.WRITABLE },
      { address: bidSettlement.creator, role: AccountRole.WRITABLE },
    );
  }
  return {
    ...instruction,
    accounts: [...instruction.accounts, ...remainingAccounts],
  };
}

/**
 * Creator (re)configures a task's validation mode (e.g. CreatorReview vs validator
 * quorum), review window, quorum size, and optional attestor. Auto-derives the
 * validation config, attestor config, protocol config, and the always-required
 * hire-record address (the derived ["hire", task] PDA even for non-hired tasks).
 */
export async function configureTaskValidation(
  input: ConfigureTaskValidationAsyncInput,
) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["creator"]);
  return getConfigureTaskValidationInstructionAsync({
    ...stableInput,
    attestor: snapshotOptionalAddress(
      stableInput.attestor,
      "configureTaskValidation: attestor",
    ),
  });
}

/**
 * Friendly input for {@link setTaskJobSpec}. Mirrors the generated async input,
 * but the P1.2 moderation accounts become derivable:
 *
 * - `taskModeration` — defaults to the v2 moderator-keyed record PDA
 *   `["task_moderation_v2", task, jobSpecHash, moderator]` (what
 *   `recordTaskModeration` writes post-P1.2). To consume a pre-upgrade record
 *   during the grace window, pass the legacy PDA explicitly (derivable via the
 *   moderation facade's `findLegacyTaskModerationPda`).
 * - `moderationBlock` — defaults to the BLOCK-floor PDA
 *   `["moderation_block", jobSpecHash]` (required on-chain; an empty/system
 *   account at the canonical address means "not blocked" and passes).
 * - `moderationAttestor` — see {@link SetTaskJobSpecInput.moderatorIsAttestor}.
 */
export type SetTaskJobSpecInput = Omit<
  SetTaskJobSpecAsyncInput,
  "taskModeration" | "moderationBlock"
> & {
  /** Override for the moderation-record slot (e.g. a legacy grace-window PDA). */
  taskModeration?: SetTaskJobSpecAsyncInput["taskModeration"];
  /** Override for the BLOCK-floor PDA (rarely needed — it derives from `jobSpecHash`). */
  moderationBlock?: SetTaskJobSpecAsyncInput["moderationBlock"];
  /**
   * P1.2 roster path switch. Set `true` when `moderator` is a REGISTERED
   * moderation attestor (not the global moderation authority): the facade then
   * derives and attaches the `["moderation_attestor", moderator]` roster entry
   * the publish gate requires. Leave unset/false for the global-authority path —
   * the roster account is then passed as `None` (the program-id placeholder),
   * matching the on-chain `moderator == moderation_authority` branch. Ignored
   * when `moderationAttestor` is passed explicitly.
   */
  moderatorIsAttestor?: boolean;
};

/**
 * Creator pins/updates a task's job-spec pointer (hash + URI) and names the
 * `moderator` whose attestation the publish gate consumes (P1.2): pass the
 * global moderation authority's pubkey for the authority path, or a registered
 * attestor's pubkey WITH `moderatorIsAttestor: true` for the roster path.
 * Auto-derives the protocol config, moderation config, the v2 moderation record
 * (from `task` + `jobSpecHash` + `moderator`), the BLOCK-floor PDA (from
 * `jobSpecHash`), the task-job-spec PDA, and the canonical hire-record PDA from
 * `task`. For revision-5 hires, the program also requires `jobSpecHash` to equal
 * the buyer-specific hash committed atomically by the hire instruction.
 */
export async function setTaskJobSpec(input: SetTaskJobSpecInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, [
    "creator",
  ] as const);
  const { moderatorIsAttestor, ...rest } = stableInput;
  const jobSpecHash = snapshotFixedBytes(
    rest.jobSpecHash,
    32,
    "setTaskJobSpec: jobSpecHash",
  );
  assertCanonicalHash32(jobSpecHash, "setTaskJobSpec: jobSpecHash");
  const stableRest = { ...rest, jobSpecHash };
  const taskModeration =
    stableRest.taskModeration ??
    (
      await findTaskModerationPda({
        task: stableRest.task,
        jobSpecHash,
        moderator: stableRest.moderator,
      })
    )[0];
  const moderationBlock =
    stableRest.moderationBlock ??
    (await findModerationBlockPda({ contentHash: jobSpecHash }))[0];
  // The generated async builder unconditionally resolves the OPTIONAL roster
  // account from `moderator`, but on the global-authority path that PDA does not
  // exist on-chain (Anchor would fail to load it). Default it to the program-id
  // placeholder (= None) unless the caller opts into the roster path.
  const moderationAttestor =
    stableRest.moderationAttestor ??
    (moderatorIsAttestor
      ? (await findModerationAttestorPda({ attestor: stableRest.moderator }))[0]
      : AGENC_COORDINATION_PROGRAM_ADDRESS);
  return getSetTaskJobSpecInstructionAsync({
    ...stableRest,
    taskModeration,
    moderationBlock,
    moderationAttestor,
  });
}

// ---------------------------------------------------------------------------
// Batch 3 WS-CONTEST: contest tasks (schema-1 Competitive + CreatorReview).
// ---------------------------------------------------------------------------

/**
 * The refundable anti-slop contest entry deposit (0.01 SOL), carried as surplus
 * lamports on a contest claim PDA. Charged when claiming a contest-configured
 * task (Competitive + CreatorReview). Refunded by normal contest settlement
 * (accept / reject / ghost-split) and for a still-Submitted Collaborative
 * terminal straggler; FORFEITED to the protocol treasury (never the creator)
 * on no-show expiry and terminal cleanup of an empty or Rejected abandoned
 * claim. Mirrors the on-chain `CONTEST_ENTRY_DEPOSIT_LAMPORTS`.
 */
export const CONTEST_ENTRY_DEPOSIT_LAMPORTS = 10_000_000n;

/**
 * The creator's post-deadline selection window (48h). A contest task's
 * `ghost_at = deadline + CONTEST_SELECTION_WINDOW_SECS`; strictly before it only
 * the creator may settle (accept/reject), at/after it the permissionless
 * {@link distributeGhostShare} crank takes over. Mirrors the on-chain
 * `SELECTION_WINDOW_SECS`.
 */
export const CONTEST_SELECTION_WINDOW_SECS = 172_800n;

/**
 * Friendly input for {@link createContestTask}. Mirrors {@link createTask}'s
 * input, minus the fields the contest rails pin on-chain: `taskType` is forced
 * to `Competitive` and contests are SOL-only (`rewardMintArg: null`, no token
 * accounts). Adds `reviewWindowSecs` for the bundled CreatorReview validation
 * config. `deadline` must be > 0 (the program rejects deadlineless contests —
 * `ghost_at` anchors on it).
 */
export type CreateContestTaskInput = Omit<
  OptionalReferrer<CreateTaskAsyncInput>,
  | "taskType"
  | "rewardMintArg"
  | "rewardMint"
  | "creatorTokenAccount"
  | "tokenEscrowAta"
  | "tokenProgram"
  | "associatedTokenProgram"
> & {
  /**
   * The creator's per-submission review window in seconds for the CreatorReview
   * config (must be > 0). Distinct from the post-deadline selection window,
   * which is fixed on-chain at {@link CONTEST_SELECTION_WINDOW_SECS}.
   */
  reviewWindowSecs: number | bigint;
};

/**
 * Create a contest task: a schema-1 `Competitive` task actually configured for
 * CreatorReview — the conjunction that enters the Batch-3 contest lifecycle
 * (entry deposits, the 48h selection window, and the permissionless ghost-split
 * crank after `ghost_at`). Returns the derived `task` address plus TWO
 * instructions to land atomically in one transaction:
 *
 * 1. `create_task` — forced `taskType: Competitive`, SOL-only
 *    (`rewardMintArg: null`; the program rejects SPL contests), deadline-bearing.
 * 2. `configure_task_validation` — CreatorReview with `reviewWindowSecs`
 *    (quorum 0, no attestor), signed by the same `creator`.
 *
 * The P6.2 demand-side referral leg is optional and defaults to the no-leg skip
 * path (`referrer: null`, `referrerFeeBps: 0`).
 */
export async function createContestTask(input: CreateContestTaskInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, [
    "authority",
    "creator",
  ] as const);
  const { reviewWindowSecs, ...rest } = stableInput;
  assertDisputeSafeWorkerLimit("createContestTask", rest.maxWorkers);
  if (BigInt(rest.deadline) <= 0n) {
    throw new Error(
      "createContestTask: contests are deadline-bearing — pass a deadline > 0 (ghost_at anchors on it).",
    );
  }
  const taskId = snapshotFixedBytes(
    rest.taskId,
    32,
    "createContestTask: taskId",
  );
  const description = snapshotFixedBytes(
    rest.description,
    64,
    "createContestTask: description",
  );
  const constraintHash = snapshotOptionalFixedBytes(
    rest.constraintHash,
    32,
    "createContestTask: constraintHash",
  );
  const createIx = await getCreateTaskInstructionAsync(
    withReferrerDefaults(
      {
        ...rest,
        taskId,
        description,
        constraintHash,
        taskType: 2, // TaskType::Competitive
        rewardMintArg: null, // contests are SOL-only (ContestSolRewardOnly)
      } as OptionalReferrer<CreateTaskAsyncInput>,
      "createContestTask",
    ),
  );
  const [task] = await findTaskPda({
    creator: rest.creator.address,
    taskId: taskId as Parameters<typeof findTaskPda>[0]["taskId"],
  });
  const configureIx = await getConfigureTaskValidationInstructionAsync({
    task,
    creator: rest.creator,
    mode: ValidationMode.CreatorReview,
    reviewWindowSecs,
    validatorQuorum: 0,
    attestor: null,
  });
  return { task, instructions: [createIx, configureIx] as const };
}

/**
 * Permissionlessly crank one live contest submission's ghost share once the
 * selection window has elapsed (`now >= ghost_at = deadline + 48h`): pays the
 * worker their equal share of the prize pool (plus the refunded entry deposit
 * and claim/submission rent), settles the fee legs, and closes the claim +
 * submission. Run once per live submission. The `cranker` signer pays only the
 * transaction fee. Caller supplies the settlement parties (`treasury`,
 * `creator`, `workerAuthority`, and `operator`/`referrer` only when the task
 * carries those fee legs); claim/escrow/validation/submission/protocol PDAs
 * auto-derive from `task`/`worker`.
 */
export async function distributeGhostShare(
  input: DistributeGhostShareAsyncInput,
) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["cranker"]);
  return getDistributeGhostShareInstructionAsync(stableInput);
}

/**
 * Permissionlessly reclaim a claim stranded on an already-terminal task (the
 * Batch-3 janitor). The canonical submission PDA must be empty, Rejected, or a
 * still-Submitted Collaborative straggler after completion; the last form also
 * requires the canonical validation config. Empty/Rejected cleanup returns the
 * claim rent minimum and forfeits eligible contest surplus to the protocol
 * `treasury`; a Submitted Collaborative straggler receives the full claim and
 * submission balances. Claim, submission, and protocol-config PDAs auto-derive
 * from `task`/`worker`.
 */
export async function reclaimTerminalClaim(
  input: ReclaimTerminalClaimAsyncInput,
) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  return getReclaimTerminalClaimInstructionAsync(stableInput);
}
