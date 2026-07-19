/**
 * `hireAndActivate` — the complete buyer-side service-hire orchestration in
 * the open SDK: hire a listing, host + moderate the buyer-specific job spec,
 * then pin it (`set_task_job_spec`) so provider agents can discover it and
 * attempt claims subject to the transaction-time gates.
 *
 * This is the plain-TS port of the flow `marketplace-react`'s
 * `useHumanlessHireFlow` runs (and the proprietary kit's
 * `listings hire` + `tasks activate-hire` commands wrap): the MIT SDK is the
 * federation substrate, so the only complete hire→activate orchestration must
 * live here, embeddable anywhere.
 *
 * Sequence (each step fails the whole flow — nothing is signed after an
 * error):
 *  1. `hire_from_listing_humanless` — Task + escrow + HireRecord created; the
 *     hire gate consumes the listing attestation of `hire.moderator`.
 *  2. `hostAndModerateJobSpec` callback — the caller hosts the buyer-specific
 *     job-spec content at a shareable URI and requests attestation (the
 *     hosted attestation service by default — e.g. attest.agenc.ag — which
 *     records the on-chain TaskModeration and names its `moderator`).
 *  3. `set_task_job_spec` — pins hash+URI, consuming the task attestation of
 *     the moderator returned by step 2. After this the task is activated for
 *     provider discovery and claim attempts; the claim transaction still
 *     enforces current task, worker, and protocol gates.
 *
 * Moderation-gate mechanics (P1.2 roster PDA / legacy record overrides) are
 * auto-resolved via {@link resolveHireListingModerationAccounts} /
 * {@link resolveActivationModerationAccounts} when an RPC is supplied and the
 * caller has not resolved them explicitly.
 *
 * @module orchestration/hire-and-activate
 */
import {
  address,
  createSolanaRpc,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import { AgencError, type MarketplaceClient } from "../client/index.js";
import {
  fetchMaybeHireRecord,
  fetchMaybeTask,
  fetchMaybeTaskJobSpec,
  fetchMaybeTaskValidationConfig,
  findEscrowPda,
  findHireRecordPda,
  findTaskJobSpecPda,
  findTaskValidationConfigPda,
  TaskStatus,
  TaskType,
  ValidationMode,
} from "../generated/index.js";
import * as facade from "../facade/index.js";
import {
  resolveActivationModerationAccounts,
  resolveHireListingModerationAccounts,
  type ModerationAccountReadRpc,
} from "./moderation-accounts.js";

type HumanlessHireFacadeInput = Parameters<
  typeof facade.hireFromListingHumanless
>[0];
type SetTaskJobSpecFacadeInput = Parameters<typeof facade.setTaskJobSpec>[0];

/** The hire step's parameters; `creator` comes from the orchestration input. */
export type HireAndActivateHireInput = Omit<
  HumanlessHireFacadeInput,
  "creator"
>;

/** Optional activation-step overrides (gate mechanics + moderator). */
export type HireAndActivateActivationInput = Omit<
  SetTaskJobSpecFacadeInput,
  "task" | "creator" | "jobSpecHash" | "jobSpecUri" | "moderator"
> & {
  /**
   * Override the activation `moderator` (P1.2). Defaults to the `moderator`
   * returned by `hostAndModerateJobSpec` — the attestation service that
   * signed the task moderation is whose record the publish gate consumes.
   */
  moderator?: Address;
};

/** What the host/moderate callback must return for activation to be signed. */
export interface HireAndActivateModerationResult {
  jobSpecHash: SetTaskJobSpecFacadeInput["jobSpecHash"];
  jobSpecUri: string;
  moderationAttested: boolean;
  /**
   * The pubkey that signed/recorded the task attestation (P1.2) — e.g. the
   * attestation service's `moderator` from `GET /v1/info`. Names whose record
   * the publish gate consumes.
   */
  moderator: Address;
  /** Raw moderation response, passed through to the result untouched. */
  moderation?: unknown;
}

export interface HireAndActivateHostInput<TJobSpec> {
  taskPda: Address;
  taskId: HireAndActivateHireInput["taskId"];
  listing: HireAndActivateHireInput["listing"];
  jobSpec: TJobSpec;
  hireSignature: string;
  /** True when finalized Task state proved the hire but no signature was attributable. */
  hireReconciled?: boolean;
}

export type HireAndActivateHost<TJobSpec> = (
  input: HireAndActivateHostInput<TJobSpec>,
) => Promise<HireAndActivateModerationResult>;

export type HireAndActivatePhase = "hiring" | "moderating" | "activating";

export interface HireAndActivateInput<TJobSpec = unknown> {
  hire: HireAndActivateHireInput;
  /** The buyer-specific job spec, handed verbatim to the host callback. */
  jobSpec: TJobSpec;
  hostAndModerateJobSpec: HireAndActivateHost<TJobSpec>;
  activation?: HireAndActivateActivationInput;
  /** Buyer signer; defaults to the client's signer. */
  creator?: TransactionSigner;
  /**
   * Account-read RPC for auto-resolving the P1.2 gate mechanics (roster PDA /
   * legacy record overrides). Omit both and resolution is skipped — callers
   * can always pass the overrides explicitly instead.
   */
  rpc?: ModerationAccountReadRpc;
  rpcUrl?: string | null;
  /** Progress callback — fires as each phase begins. */
  onPhase?: (phase: HireAndActivatePhase) => void;
}

export interface HireAndActivateResult {
  taskPda: Address;
  /**
   * Transaction signature, or the empty string when exact finalized Task state
   * proves an ambiguous hire landed but no signature can be attributed safely.
   */
  hireSignature: string;
  /** True when `hireSignature` is the empty finalized-state sentinel. */
  hireReconciled?: boolean;
  /**
   * Transaction signature, or the empty string when exact finalized account
   * state proves an ambiguous send landed but no signature can be attributed
   * safely. Check `activationReconciled` before building a receipt link.
   */
  activationSignature: string;
  /** True when success was reconciled from finalized on-chain state. */
  activationReconciled?: boolean;
  jobSpecHash: SetTaskJobSpecFacadeInput["jobSpecHash"];
  jobSpecUri: string;
  moderation?: unknown;
}

interface HireAndActivateCommittedHire {
  taskPda: Address;
  hireSignature: string;
  /** Must be true exactly when `hireSignature` is the empty reconciliation sentinel. */
  hireReconciled?: true;
}

export interface HireAndActivateModeratingProgress extends HireAndActivateCommittedHire {
  phase: "moderating";
}

export interface HireAndActivateActivatingProgress extends HireAndActivateCommittedHire {
  phase: "activating";
  jobSpecHash: SetTaskJobSpecFacadeInput["jobSpecHash"];
  jobSpecUri: string;
  moderator: Address;
  moderation?: unknown;
}

/**
 * A submitted hire whose finalized account outcome is not known yet. Resuming
 * this token only reconciles; it never submits another funded hire.
 */
export interface HireAndActivateHiringProgress {
  phase: "hiring";
  taskPda: Address;
  /** Locally attributable wire signature when the client error exposed one. */
  candidateSignature: string | null;
}

/** Machine-readable state sufficient to resume without repeating the funded hire. */
export type HireAndActivateProgress =
  | HireAndActivateHiringProgress
  | HireAndActivateModeratingProgress
  | HireAndActivateActivatingProgress;

/** Failure after submission/commit, carrying an exact non-resubmitting resume point. */
export class HireAndActivateError extends Error {
  readonly progress: HireAndActivateProgress;

  constructor(
    message: string,
    options: { progress: HireAndActivateProgress; cause: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "HireAndActivateError";
    this.progress = options.progress;
  }
}

function validateModerationResult(result: HireAndActivateModerationResult): {
  jobSpecHash: SetTaskJobSpecFacadeInput["jobSpecHash"];
  jobSpecUri: string;
  moderator: Address;
} {
  if (result.moderationAttested !== true) {
    throw new Error(
      "Task moderation was not attested; activation was not signed.",
    );
  }
  if (
    !(result.jobSpecHash instanceof Uint8Array) ||
    result.jobSpecHash.byteLength !== 32
  ) {
    throw new Error(
      "Task moderation returned an invalid jobSpecHash; activation was not signed.",
    );
  }
  const jobSpecUri = result.jobSpecUri.trim();
  if (!jobSpecUri) {
    throw new Error(
      "Task moderation returned an empty jobSpecUri; activation was not signed.",
    );
  }
  if (typeof result.moderator !== "string" || !result.moderator.trim()) {
    throw new Error(
      "Task moderation returned no moderator pubkey; activation was not signed.",
    );
  }
  let moderator: Address;
  try {
    moderator = address(result.moderator);
  } catch {
    throw new Error(
      "Task moderation returned an invalid moderator pubkey; activation was not signed.",
    );
  }
  return {
    jobSpecHash: result.jobSpecHash,
    jobSpecUri,
    moderator,
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

type TaskJobSpecReadRpc = Parameters<typeof fetchMaybeTaskJobSpec>[0];
const DEFAULT_ADDRESS = address("11111111111111111111111111111111");

function resolveOptionalAddress(value: unknown, label: string): Address {
  if (value === undefined || value === null) return DEFAULT_ADDRESS;
  if (typeof value === "string") return address(value);
  if (typeof value === "object" && value !== null && "__option" in value) {
    const option = value as { __option?: unknown; value?: unknown };
    if (option.__option === "None") return DEFAULT_ADDRESS;
    if (option.__option === "Some" && typeof option.value === "string") {
      return address(option.value);
    }
  }
  throw new TypeError(`${label} is not a valid optional Solana address`);
}

function expectedReferral<TJobSpec>(
  client: MarketplaceClient,
  input: HireAndActivateInput<TJobSpec>,
): { referrer: Address; feeBps: number } {
  if (
    input.hire.referrer === undefined &&
    client.defaultReferrer !== undefined
  ) {
    return {
      referrer: address(client.defaultReferrer.address),
      feeBps: client.defaultReferrer.feeBps,
    };
  }
  return {
    referrer: resolveOptionalAddress(input.hire.referrer, "hire.referrer"),
    feeBps: input.hire.referrerFeeBps ?? 0,
  };
}

function candidateSignature(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "signature" in error &&
    typeof error.signature === "string" &&
    error.signature.length > 0
  ) {
    return error.signature;
  }
  return null;
}

function taskJobSpecReadRpc<TJobSpec>(
  input: HireAndActivateInput<TJobSpec>,
): TaskJobSpecReadRpc | null {
  return (
    (input.rpc as TaskJobSpecReadRpc | undefined) ??
    (input.rpcUrl
      ? (createSolanaRpc(input.rpcUrl) as unknown as TaskJobSpecReadRpc)
      : null)
  );
}

/**
 * Prove that the atomic funded-hire instruction committed the complete durable
 * outcome this orchestration requested. A Task PDA alone is not sufficient:
 * the immutable hire record, referral terms, spec hash (when supplied), and
 * forced CreatorReview configuration must also match at finalized commitment.
 * `expectedVersion` is an execution-time listing CAS and is not persisted in
 * Task/HireRecord, so reconciliation can prove its resulting stored terms but
 * cannot reconstruct that historical counter after the transaction.
 */
async function reconcileHire<TJobSpec>(
  client: MarketplaceClient,
  input: HireAndActivateInput<TJobSpec>,
  creator: TransactionSigner,
  taskPda: Address,
): Promise<HireAndActivateCommittedHire | null> {
  const rpc = taskJobSpecReadRpc(input);
  if (rpc === null) return null;
  const [[escrowPda], [hireRecordPda], [validationConfigPda]] =
    await Promise.all([
      findEscrowPda({ task: taskPda }),
      findHireRecordPda({ task: taskPda }),
      findTaskValidationConfigPda({ task: taskPda }),
    ]);
  const [task, hireRecord, validationConfig] = await Promise.all([
    fetchMaybeTask(rpc, taskPda, { commitment: "finalized" }),
    fetchMaybeHireRecord(rpc, hireRecordPda, { commitment: "finalized" }),
    fetchMaybeTaskValidationConfig(rpc, validationConfigPda, {
      commitment: "finalized",
    }),
  ]);
  const present = [task.exists, hireRecord.exists, validationConfig.exists];
  if (present.every((exists) => !exists)) return null;
  if (!task.exists || !hireRecord.exists || !validationConfig.exists) {
    throw new Error(
      `Finalized hire state for ${taskPda} is incomplete; refusing to resend a potentially funded hire`,
    );
  }

  const expectedPrice = BigInt(input.hire.expectedPrice);
  const expectedReviewWindow = BigInt(input.hire.reviewWindowSecs);
  const referral = expectedReferral(client, input);
  const expectedDescriptionPrefix = input.hire.listingSpecHash;
  const descriptionMatches =
    expectedDescriptionPrefix === undefined ||
    (expectedDescriptionPrefix instanceof Uint8Array &&
      expectedDescriptionPrefix.byteLength === 32 &&
      bytesEqual(
        new Uint8Array(task.data.description).slice(0, 32),
        new Uint8Array(expectedDescriptionPrefix),
      ));
  const matches =
    bytesEqual(
      new Uint8Array(task.data.taskId),
      new Uint8Array(input.hire.taskId),
    ) &&
    task.data.creator === creator.address &&
    task.data.rewardAmount === expectedPrice &&
    task.data.maxWorkers === 1 &&
    task.data.currentWorkers === 0 &&
    task.data.status === TaskStatus.Open &&
    task.data.taskType === TaskType.Exclusive &&
    task.data.escrow === escrowPda &&
    task.data.referrer === referral.referrer &&
    task.data.referrerFeeBps === referral.feeBps &&
    descriptionMatches &&
    hireRecord.data.task === taskPda &&
    hireRecord.data.listing === input.hire.listing &&
    hireRecord.data.designatedProvider === input.hire.providerAgent &&
    hireRecord.data.referrer === referral.referrer &&
    hireRecord.data.referrerFeeBps === referral.feeBps &&
    validationConfig.data.task === taskPda &&
    validationConfig.data.creator === creator.address &&
    validationConfig.data.mode === ValidationMode.CreatorReview &&
    validationConfig.data.reviewWindowSecs === expectedReviewWindow;
  if (!matches) {
    throw new Error(
      `Finalized state at ${taskPda} does not match the funded hire intent; refusing to treat it as committed or resend`,
    );
  }
  return { taskPda, hireSignature: "", hireReconciled: true };
}

async function reconcileActivation<TJobSpec>(
  input: HireAndActivateInput<TJobSpec>,
  creator: TransactionSigner,
  progress: HireAndActivateActivatingProgress,
): Promise<HireAndActivateResult | null> {
  const rpc = taskJobSpecReadRpc(input);
  if (rpc === null) return null;
  const [jobSpecPda] = await findTaskJobSpecPda({ task: progress.taskPda });
  const account = await fetchMaybeTaskJobSpec(rpc, jobSpecPda, {
    commitment: "finalized",
  });
  if (!account.exists) return null;
  const matches =
    account.data.task === progress.taskPda &&
    account.data.creator === creator.address &&
    bytesEqual(
      new Uint8Array(account.data.jobSpecHash),
      new Uint8Array(progress.jobSpecHash),
    ) &&
    account.data.jobSpecUri === progress.jobSpecUri;
  if (!matches) {
    throw new Error(
      `TaskJobSpec ${jobSpecPda} exists but does not match the funded activation intent; refusing to overwrite or resend`,
    );
  }
  return {
    taskPda: progress.taskPda,
    hireSignature: progress.hireSignature,
    hireReconciled: progress.hireReconciled,
    activationSignature: "",
    activationReconciled: true,
    jobSpecHash: progress.jobSpecHash,
    jobSpecUri: progress.jobSpecUri,
    moderation: progress.moderation,
  };
}

async function activateCommittedHire<TJobSpec>(
  client: MarketplaceClient,
  input: HireAndActivateInput<TJobSpec>,
  creator: TransactionSigner,
  progress: HireAndActivateActivatingProgress,
): Promise<HireAndActivateResult> {
  const readSeam = { rpc: input.rpc, rpcUrl: input.rpcUrl ?? null };
  const canResolve = input.rpc !== undefined || Boolean(input.rpcUrl);
  const activationModerator = progress.moderator;
  try {
    input.onPhase?.("activating");
    const alreadyCommitted = await reconcileActivation(
      input,
      creator,
      progress,
    );
    if (alreadyCommitted !== null) return alreadyCommitted;
    const activationCallerResolved =
      input.activation?.moderationAttestor !== undefined ||
      input.activation?.moderatorIsAttestor !== undefined ||
      input.activation?.taskModeration !== undefined;
    const activationModerationArgs =
      !activationCallerResolved && canResolve
        ? await resolveActivationModerationAccounts({
            ...readSeam,
            task: progress.taskPda,
            jobSpecHash: progress.jobSpecHash,
            moderator: activationModerator,
          })
        : {};
    let activationResult: Awaited<
      ReturnType<MarketplaceClient["setTaskJobSpec"]>
    >;
    try {
      activationResult = await client.setTaskJobSpec({
        ...(input.activation ?? {}),
        ...activationModerationArgs,
        task: progress.taskPda,
        creator,
        jobSpecHash: progress.jobSpecHash,
        jobSpecUri: progress.jobSpecUri,
        moderator: activationModerator,
      } as SetTaskJobSpecFacadeInput);
    } catch (sendCause) {
      try {
        const committed = await reconcileActivation(input, creator, progress);
        if (committed !== null) return committed;
      } catch (reconcileCause) {
        throw new Error(
          `activation send failed (${sendCause instanceof Error ? sendCause.message : String(sendCause)}) and finalized reconciliation failed (${reconcileCause instanceof Error ? reconcileCause.message : String(reconcileCause)})`,
          { cause: sendCause },
        );
      }
      throw sendCause;
    }
    return {
      taskPda: progress.taskPda,
      hireSignature: progress.hireSignature,
      hireReconciled: progress.hireReconciled,
      activationSignature: activationResult.signature,
      activationReconciled: false,
      jobSpecHash: progress.jobSpecHash,
      jobSpecUri: progress.jobSpecUri,
      moderation: progress.moderation,
    };
  } catch (cause) {
    throw new HireAndActivateError(
      `Hire committed, but activation failed: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        "Resume from error.progress instead of hiring again.",
      { progress, cause },
    );
  }
}

async function moderateCommittedHire<TJobSpec>(
  client: MarketplaceClient,
  input: HireAndActivateInput<TJobSpec>,
  creator: TransactionSigner,
  committed: HireAndActivateCommittedHire,
): Promise<HireAndActivateResult> {
  let moderation: HireAndActivateModerationResult;
  try {
    input.onPhase?.("moderating");
    moderation = await input.hostAndModerateJobSpec({
      taskPda: committed.taskPda,
      taskId: input.hire.taskId,
      listing: input.hire.listing,
      jobSpec: input.jobSpec,
      hireSignature: committed.hireSignature,
      hireReconciled: committed.hireReconciled,
    });
    const validated = validateModerationResult(moderation);
    let activationModerator = validated.moderator;
    if (input.activation?.moderator !== undefined) {
      try {
        activationModerator = address(input.activation.moderator);
      } catch {
        throw new Error(
          "Activation override contains an invalid moderator pubkey; activation was not signed.",
        );
      }
    }
    return activateCommittedHire(client, input, creator, {
      phase: "activating",
      ...committed,
      ...validated,
      moderator: activationModerator,
      moderation: moderation.moderation,
    });
  } catch (cause) {
    if (cause instanceof HireAndActivateError) throw cause;
    throw new HireAndActivateError(
      `Hire committed, but hosting/moderation failed: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        "Resume from error.progress instead of hiring again.",
      { progress: { phase: "moderating", ...committed }, cause },
    );
  }
}

/**
 * Run the full hire → host/moderate → activate flow through a
 * {@link MarketplaceClient}. Returns only after activation is signed and the
 * task is eligible for provider discovery/claim attempts; throws on the first
 * failed step. A later claim remains subject to transaction-time gates.
 */
export async function hireAndActivate<TJobSpec = unknown>(
  client: MarketplaceClient,
  input: HireAndActivateInput<TJobSpec>,
): Promise<HireAndActivateResult> {
  const creator = input.creator ?? client.signer;
  const readSeam = { rpc: input.rpc, rpcUrl: input.rpcUrl ?? null };
  const canResolve = input.rpc !== undefined || Boolean(input.rpcUrl);

  input.onPhase?.("hiring");
  const [taskPda] = await facade.findTaskPda({
    creator: creator.address,
    taskId: input.hire.taskId,
  });
  const alreadyCommitted = await reconcileHire(client, input, creator, taskPda);
  if (alreadyCommitted !== null) {
    return moderateCommittedHire(client, input, creator, alreadyCommitted);
  }
  // P1.2: resolve the hire gate's moderation mechanics (roster PDA / legacy
  // record override) unless the caller supplied any of them.
  const hireCallerResolved =
    input.hire.moderationAttestor !== undefined ||
    input.hire.moderatorIsAttestor !== undefined ||
    input.hire.listingModeration !== undefined;
  const hireModerationArgs =
    !hireCallerResolved &&
    canResolve &&
    input.hire.listingSpecHash !== undefined
      ? await resolveHireListingModerationAccounts({
          ...readSeam,
          listing: input.hire.listing,
          listingSpecHash: input.hire.listingSpecHash,
          moderator: input.hire.moderator,
        })
      : {};
  let hireResult: Awaited<
    ReturnType<MarketplaceClient["hireFromListingHumanless"]>
  >;
  try {
    hireResult = await client.hireFromListingHumanless({
      ...input.hire,
      ...hireModerationArgs,
      creator,
    } as HumanlessHireFacadeInput);
  } catch (sendCause) {
    // The SDK uses signature=null only when it proved the failure occurred
    // before broadcast. Reconciliation-only recovery would wedge that safe,
    // retryable case forever, so preserve the original retry-safe error.
    if (sendCause instanceof AgencError && sendCause.signature === null) {
      throw sendCause;
    }
    try {
      const committed = await reconcileHire(client, input, creator, taskPda);
      if (committed !== null) {
        return moderateCommittedHire(client, input, creator, committed);
      }
    } catch (reconcileCause) {
      throw new Error(
        `hire send failed (${sendCause instanceof Error ? sendCause.message : String(sendCause)}) and finalized reconciliation failed (${reconcileCause instanceof Error ? reconcileCause.message : String(reconcileCause)})`,
        { cause: sendCause },
      );
    }
    throw new HireAndActivateError(
      `Hire submission outcome is not finalized: ${sendCause instanceof Error ? sendCause.message : String(sendCause)}. ` +
        "Resume from error.progress to reconcile; do not submit another funded hire.",
      {
        progress: {
          phase: "hiring",
          taskPda,
          candidateSignature: candidateSignature(sendCause),
        },
        cause: sendCause,
      },
    );
  }

  return moderateCommittedHire(client, input, creator, {
    taskPda,
    hireSignature: hireResult.signature,
  });
}

/**
 * Resume a failed hire flow. Validates that the recovery task matches the
 * supplied hire intent. An ambiguous `hiring` token performs finalized
 * reconciliation only; committed tokens start at moderation or activation.
 * This function never calls `hireFromListingHumanless`.
 */
export async function resumeHireAndActivate<TJobSpec = unknown>(
  client: MarketplaceClient,
  input: HireAndActivateInput<TJobSpec>,
  progress: HireAndActivateProgress,
): Promise<HireAndActivateResult> {
  if (
    typeof progress !== "object" ||
    progress === null ||
    (progress.phase !== "hiring" &&
      progress.phase !== "moderating" &&
      progress.phase !== "activating")
  ) {
    throw new TypeError("resumeHireAndActivate: invalid recovery progress");
  }
  const creator = input.creator ?? client.signer;
  const [expectedTask] = await facade.findTaskPda({
    creator: creator.address,
    taskId: input.hire.taskId,
  });
  if (expectedTask !== progress.taskPda) {
    throw new TypeError(
      "resumeHireAndActivate: recovery task does not match the supplied creator/taskId intent",
    );
  }
  try {
    address(progress.taskPda);
  } catch {
    throw new TypeError("resumeHireAndActivate: recovery task is invalid");
  }
  if (progress.phase === "hiring") {
    if (
      !(
        progress.candidateSignature === null ||
        (typeof progress.candidateSignature === "string" &&
          progress.candidateSignature.length > 0)
      )
    ) {
      throw new TypeError(
        "resumeHireAndActivate: invalid ambiguous-hire recovery payload",
      );
    }
    const committed = await reconcileHire(
      client,
      input,
      creator,
      progress.taskPda,
    );
    if (committed === null) {
      throw new HireAndActivateError(
        "Hire submission is still absent at finalized commitment; retry this reconciliation token later and do not submit another funded hire.",
        { progress, cause: new Error("finalized hire state is not present") },
      );
    }
    return moderateCommittedHire(client, input, creator, committed);
  }
  if (
    typeof progress.hireSignature !== "string" ||
    (progress.hireSignature.length === 0) !== (progress.hireReconciled === true)
  ) {
    throw new TypeError("resumeHireAndActivate: invalid recovery progress");
  }
  if (progress.phase === "activating") {
    if (
      !(progress.jobSpecHash instanceof Uint8Array) ||
      progress.jobSpecHash.byteLength !== 32 ||
      typeof progress.jobSpecUri !== "string" ||
      progress.jobSpecUri === "" ||
      progress.jobSpecUri !== progress.jobSpecUri.trim()
    ) {
      throw new TypeError(
        "resumeHireAndActivate: invalid activation recovery payload",
      );
    }
    try {
      address(progress.moderator);
    } catch {
      throw new TypeError(
        "resumeHireAndActivate: invalid activation recovery moderator",
      );
    }
    if (
      input.activation?.moderator !== undefined &&
      input.activation.moderator !== progress.moderator
    ) {
      throw new TypeError(
        "resumeHireAndActivate: activation moderator no longer matches recovery intent",
      );
    }
  }
  return progress.phase === "moderating"
    ? moderateCommittedHire(client, input, creator, progress)
    : activateCommittedHire(client, input, creator, progress);
}
