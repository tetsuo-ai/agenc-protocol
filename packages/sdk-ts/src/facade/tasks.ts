// Facade: ergonomic, named entry points over the generated client for the task
// lifecycle. Thin by design — the generated Async builders already resolve PDAs
// (task, escrow, claim, submission, validation/protocol config, rate limits) and
// encode instruction data; the facade adds friendly, typed, named signatures.
//
// Lifecycle covered: create_task, create_task_humanless, create_dependent_task,
// claim_task_with_job_spec (claim_task plain is fail-closed in the program — wrap
// this instead), submit_task_result, accept/reject/auto_accept/validate result,
// request_changes, reject_and_freeze, complete_task, cancel_task, close_task,
// expire_claim, and the Batch-3 contest lifecycle (create_task[Competitive] +
// configure_task_validation[CreatorReview] via createContestTask,
// distribute_ghost_share, reclaim_terminal_claim). complete_task_private (ZK) is
// intentionally out of scope here.
//
// Never import from generated/ internals other than its public exports.
import { AccountRole, type Address } from "@solana/kit";
import {
  findModerationAttestorPda,
  findModerationBlockPda,
  findTaskModerationPda,
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
  type DistributeGhostShareAsyncInput,
  type ReclaimTerminalClaimAsyncInput,
  type SetTaskJobSpecAsyncInput,
  ValidationMode,
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
 *
 * Since audit F-10 the hire-record account is REQUIRED + seeds-pinned (the
 * permissionless path can no longer skip operator/referrer legs by omitting it):
 * the facade derives it from [hire, task] when not supplied — for non-hired
 * tasks that is the empty system-owned PDA, which settles with no legs, exactly
 * as before.
 */
export async function autoAcceptTaskResult(
  input: AutoAcceptTaskResultInput,
) {
  const hireRecord =
    input.hireRecord ?? (await findHireRecordPda({ task: input.task }))[0];
  return getAutoAcceptTaskResultInstructionAsync({ ...input, hireRecord });
}

export type AutoAcceptTaskResultInput = Omit<
  AutoAcceptTaskResultAsyncInput,
  "hireRecord"
> & {
  /** Defaults to the derived [hire, task] PDA (audit F-10). */
  hireRecord?: Address;
};

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
};

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
 */
export async function cancelTask(input: CancelTaskInput) {
  const creatorCompletionBond =
    input.creatorCompletionBond ??
    (await findCreatorCompletionBondPda({
      task: input.task,
      creator: input.authority.address,
    }))[0];
  const workerCompletionBond =
    input.workerCompletionBond ??
    (await findWorkerCompletionBondPda({
      task: input.task,
      workerAuthority: input.workerBondAuthority,
    }))[0];
  return getCancelTaskInstructionAsync({
    ...input,
    creatorCompletionBond,
    workerCompletionBond,
  });
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
  const [protocolConfig] = await findProtocolConfigPda();

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
      // Fix round (FIX 5): optional protocol_config, always supplied by the
      // facade (const-seed PDA). It validates the treasury payee when a
      // straggler submission's worker agent has been deregistered; harmless
      // (readonly) otherwise.
      { address: protocolConfig, role: AccountRole.READONLY },
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
 * `jobSpecHash`), and the task-job-spec PDA from `task`.
 */
export async function setTaskJobSpec(input: SetTaskJobSpecInput) {
  const { moderatorIsAttestor, ...rest } = input;
  const taskModeration =
    rest.taskModeration ??
    (
      await findTaskModerationPda({
        task: rest.task,
        jobSpecHash: rest.jobSpecHash,
        moderator: rest.moderator,
      })
    )[0];
  const moderationBlock =
    rest.moderationBlock ??
    (await findModerationBlockPda({ contentHash: rest.jobSpecHash }))[0];
  // The generated async builder unconditionally resolves the OPTIONAL roster
  // account from `moderator`, but on the global-authority path that PDA does not
  // exist on-chain (Anchor would fail to load it). Default it to the program-id
  // placeholder (= None) unless the caller opts into the roster path.
  const moderationAttestor =
    rest.moderationAttestor ??
    (moderatorIsAttestor
      ? (await findModerationAttestorPda({ attestor: rest.moderator }))[0]
      : AGENC_COORDINATION_PROGRAM_ADDRESS);
  return getSetTaskJobSpecInstructionAsync({
    ...rest,
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
 * task (Competitive + CreatorReview). Refunded in full on every exit where the
 * worker SUBMITTED (accept / reject / ghost-split); FORFEITED to the protocol
 * treasury (never the creator) on no-show exits (`expire_claim` with a
 * provably-absent submission, and `reclaim_terminal_claim`). Mirrors the
 * on-chain `CONTEST_ENTRY_DEPOSIT_LAMPORTS`.
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
  const { reviewWindowSecs, ...rest } = input;
  if (BigInt(rest.deadline) <= 0n) {
    throw new Error(
      "createContestTask: contests are deadline-bearing — pass a deadline > 0 (ghost_at anchors on it).",
    );
  }
  const createIx = await getCreateTaskInstructionAsync(
    withReferrerDefaults({
      ...rest,
      taskType: 2, // TaskType::Competitive
      rewardMintArg: null, // contests are SOL-only (ContestSolRewardOnly)
    } as OptionalReferrer<CreateTaskAsyncInput>),
  );
  const [task] = await findTaskPda({
    creator: rest.creator.address,
    taskId: rest.taskId as Parameters<typeof findTaskPda>[0]["taskId"],
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
  return getDistributeGhostShareInstructionAsync(input);
}

/**
 * Permissionlessly reclaim a claim stranded on an already-terminal task (the
 * Batch-3 janitor): requires a provably-absent submission (the derived
 * submission PDA must be an empty system account — a live submission means the
 * normal settlement paths still apply). Returns claim rent to the worker
 * authority and forfeits any contest entry-deposit surplus to the protocol
 * `treasury` (never the creator). Claim, submission, and protocol-config PDAs
 * auto-derive from `task`/`worker`.
 */
export async function reclaimTerminalClaim(
  input: ReclaimTerminalClaimAsyncInput,
) {
  return getReclaimTerminalClaimInstructionAsync(input);
}
