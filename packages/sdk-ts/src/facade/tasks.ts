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
  getCloseTaskInstructionAsync,
  getExpireClaimInstructionAsync,
  getConfigureTaskValidationInstructionAsync,
  getSetTaskJobSpecInstructionAsync,
  findTaskPda,
  findEscrowPda,
  findClaimPda,
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
 * Create a task. Auto-derives the task, escrow, protocol-config, and
 * authority-rate-limit PDAs; token accounts default to the SPL/ATA programs.
 * For a plain SOL task, pass `rewardMintArg: null` and omit the token accounts.
 */
export async function createTask(input: CreateTaskAsyncInput) {
  return getCreateTaskInstructionAsync(input);
}

/**
 * Create a "humanless" task owned by a plain buyer wallet (no AgentRegistration).
 * Forces a CreatorReview validation config so it can never settle on the auto-pay
 * path. Auto-derives task, escrow, validation config, protocol config, and the
 * wallet-scoped rate limit.
 */
export async function createTaskHumanless(
  input: CreateTaskHumanlessAsyncInput,
) {
  return getCreateTaskHumanlessInstructionAsync(input);
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

/**
 * Close a terminal task and reclaim its rent. Auto-derives the optional job-spec
 * pointer and escrow; pass `hireRecord`/`listing` for hired tasks.
 */
export async function closeTask(input: CloseTaskAsyncInput) {
  return getCloseTaskInstructionAsync(input);
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
