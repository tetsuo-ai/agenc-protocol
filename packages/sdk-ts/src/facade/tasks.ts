// Facade: ergonomic, named entry points over the generated client for the task
// lifecycle. Thin by design — the generated Async builders already resolve PDAs
// (task, escrow, claim, submission, validation/protocol config, rate limits) and
// encode instruction data; the facade adds friendly, typed, named signatures.
//
// Lifecycle covered: create_task, create_task_humanless, create_dependent_task,
// claim_task_with_job_spec (claim_task plain is fail-closed in the program — wrap
// this instead), submit_task_result, accept/reject/auto_accept/validate result,
// request_changes, reject_and_freeze, complete_task, cancel_task, close_task,
// expire_claim. complete_task_private (ZK) is intentionally out of scope here.
//
// Never import from generated/ internals other than its public exports.
import { AccountRole, type Address } from "@solana/kit";
import {
  getCreateTaskInstructionAsync,
  getCreateTaskHumanlessInstructionAsync,
  getCreateDependentTaskInstructionAsync,
  getClaimTaskWithJobSpecInstructionAsync,
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
  getExpireClaimInstructionAsync,
  getConfigureTaskValidationInstructionAsync,
  getSetTaskJobSpecInstructionAsync,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findTaskPda,
  findEscrowPda,
  findClaimPda,
  findHireRecordPda,
  findTaskJobSpecPda,
  findTaskSubmissionPda,
  findTaskValidationConfigPda,
  type CreateTaskAsyncInput,
  type CreateTaskHumanlessAsyncInput,
  type CreateDependentTaskAsyncInput,
  type ClaimTaskWithJobSpecAsyncInput,
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
  type ExpireClaimAsyncInput,
  type ConfigureTaskValidationAsyncInput,
  type SetTaskJobSpecAsyncInput,
} from "../generated/index.js";

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
type OptionalReferrer<T extends { referrer: unknown; referrerFeeBps: number }> =
  Omit<T, "referrer" | "referrerFeeBps"> & {
    referrer?: T["referrer"];
    referrerFeeBps?: number;
  };

/** Apply the facade's referrer defaults (no-leg skip path): `null` / `0`. */
function withReferrerDefaults<
  T extends { referrer: unknown; referrerFeeBps: number },
>(input: OptionalReferrer<T>): T {
  return {
    referrer: null,
    referrerFeeBps: 0,
    ...input,
  } as T;
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
export async function createTask(input: OptionalReferrer<CreateTaskAsyncInput>) {
  return getCreateTaskInstructionAsync(withReferrerDefaults(input));
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
  return getCreateTaskHumanlessInstructionAsync(withReferrerDefaults(input));
}

/**
 * Create a task that depends on a parent task. Caller supplies `parentTask`;
 * the rest of the task/escrow/config/rate-limit PDAs auto-derive.
 */
export async function createDependentTask(
  input: CreateDependentTaskAsyncInput,
) {
  return getCreateDependentTaskInstructionAsync(input);
}

/**
 * Claim a task while pinning its job-spec pointer. Wraps claim_task_with_job_spec
 * (plain claim_task is fail-closed in the program). Auto-derives the task-job-spec
 * pointer, the claim PDA, and protocol config from `task`/`worker`.
 */
export async function claimTaskWithJobSpec(
  input: ClaimTaskWithJobSpecAsyncInput,
) {
  return getClaimTaskWithJobSpecInstructionAsync(input);
}

/**
 * Submit a worker result for a claimed task. Auto-derives claim, validation
 * config, submission, and protocol-config PDAs from `task`/`worker`.
 */
export async function submitTaskResult(input: SubmitTaskResultAsyncInput) {
  return getSubmitTaskResultInstructionAsync(input);
}

/**
 * Creator accepts a submitted result and settles the escrow. Caller supplies the
 * settlement parties (treasury, worker, workerAuthority); claim/escrow/submission/
 * validation/protocol PDAs auto-derive. Pass token accounts only for token tasks.
 */
export async function acceptTaskResult(input: AcceptTaskResultAsyncInput) {
  return getAcceptTaskResultInstructionAsync(input);
}

/**
 * Creator rejects a submitted result (with a rejection hash). Auto-derives
 * validation config, submission, and protocol-config PDAs from `task`/`worker`.
 */
export async function rejectTaskResult(input: RejectTaskResultAsyncInput) {
  return getRejectTaskResultInstructionAsync(input);
}

/**
 * Permissionlessly auto-accept a result once its review window has elapsed.
 * Settles like accept but the signer is any `authority`, not the creator.
 */
export async function autoAcceptTaskResult(
  input: AutoAcceptTaskResultAsyncInput,
) {
  return getAutoAcceptTaskResultInstructionAsync(input);
}

/**
 * Validator (or validator-quorum) approve/reject of a submitted result. Pass
 * `approved`; on approval it settles the escrow. Auto-derives claim, escrow,
 * validation config/vote, submission, attestor config, and protocol-config PDAs.
 */
export async function validateTaskResult(input: ValidateTaskResultAsyncInput) {
  return getValidateTaskResultInstructionAsync(input);
}

/**
 * Creator requests changes on a submission (with a changes hash), returning the
 * task to the worker. Auto-derives validation config, submission, and protocol
 * config from `task`/`claim`.
 */
export async function requestChanges(input: RequestChangesAsyncInput) {
  return getRequestChangesInstructionAsync(input);
}

/**
 * Creator rejects and freezes a submission (with a rejection hash) pending
 * dispute. Auto-derives validation config, submission, and protocol config.
 */
export async function rejectAndFreeze(input: RejectAndFreezeAsyncInput) {
  return getRejectAndFreezeInstructionAsync(input);
}

/**
 * Worker completes a task on the direct-pay path, settling the escrow. Caller
 * supplies the settlement parties (creator, worker, treasury) and the always-
 * required hire-record address (the derived ["hire", task] PDA even for non-hired
 * tasks). Claim/escrow/protocol PDAs auto-derive.
 */
export async function completeTask(input: CompleteTaskAsyncInput) {
  return getCompleteTaskInstructionAsync(input);
}

/**
 * Creator cancels a task and refunds the escrow. Auto-derives escrow and protocol
 * config; pass token accounts only for token tasks.
 */
export async function cancelTask(input: CancelTaskAsyncInput) {
  return getCancelTaskInstructionAsync(input);
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
};

function optionalAddress(value: Address | null | undefined): Address {
  return value ?? AGENC_COORDINATION_PROGRAM_ADDRESS;
}

/**
 * Close a terminal task and reclaim its rent. Auto-derives the optional job-spec
 * pointer by default, omits the normally-closed escrow by default, and derives
 * the required hire record when omitted. Pass `listing` for hired tasks so
 * their listing capacity is released.
 */
export async function closeTask(input: CloseTaskInput) {
  const taskJobSpec =
    input.taskJobSpec === undefined
      ? (await findTaskJobSpecPda({ task: input.task }))[0]
      : optionalAddress(input.taskJobSpec);
  const hireRecord =
    input.hireRecord ?? (await findHireRecordPda({ task: input.task }))[0];

  return {
    programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
    accounts: [
      { address: input.task, role: AccountRole.WRITABLE },
      {
        address: taskJobSpec,
        role:
          input.taskJobSpec === null
            ? AccountRole.READONLY
            : AccountRole.WRITABLE,
      },
      {
        address: optionalAddress(input.escrow),
        role: input.escrow ? AccountRole.WRITABLE : AccountRole.READONLY,
      },
      { address: hireRecord, role: AccountRole.WRITABLE },
      {
        address: optionalAddress(input.listing),
        role: input.listing ? AccountRole.WRITABLE : AccountRole.READONLY,
      },
      { address: input.creatorCompletionBond, role: AccountRole.READONLY },
      {
        address: optionalAddress(input.workerCompletionBond),
        role: input.workerCompletionBond
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
      },
      {
        address: input.authority.address,
        role: AccountRole.WRITABLE_SIGNER,
        signer: input.authority,
      },
    ],
    data: getCloseTaskInstructionDataEncoder().encode({}),
  };
}

/**
 * Permissionlessly expire a stale claim, freeing the task and paying the caller a
 * cleanup reward. Caller supplies `worker`/`rentRecipient`; escrow, claim,
 * validation config, submission, and protocol-config PDAs auto-derive.
 */
export async function expireClaim(input: ExpireClaimAsyncInput) {
  return getExpireClaimInstructionAsync(input);
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
  return getConfigureTaskValidationInstructionAsync(input);
}

/**
 * Creator pins/updates a task's job-spec pointer (hash + URI). Auto-derives the
 * protocol config, moderation config, the moderation record (from `task` +
 * `jobSpecHash`), and the task-job-spec PDA from `task`.
 */
export async function setTaskJobSpec(input: SetTaskJobSpecAsyncInput) {
  return getSetTaskJobSpecInstructionAsync(input);
}
