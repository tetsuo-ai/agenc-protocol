/**
 * `hireAndActivate` — the complete buyer-side service-hire orchestration in
 * the open SDK: commit and hire a listing, host + moderate the buyer-specific job spec,
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
 *     hire gate consumes the listing attestation of `hire.moderator` and
 *     atomically commits `hire.taskJobSpecHash` before funds move.
 *  2. `hostAndModerateJobSpec` callback — the caller hosts the buyer-specific
 *     job-spec content at a shareable URI and requests attestation (the
 *     hosted attestation service by default — e.g. attest.agenc.ag — which
 *     records the on-chain TaskModeration and names its `moderator`).
 *  3. `set_task_job_spec` — pins the same committed hash plus its URI,
 *     consuming the task attestation of the moderator returned by step 2.
 *     A callback returning a different hash is rejected before signing. After this the task is activated for
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
  getBase58Decoder,
  getBase58Encoder,
  isNone,
  type Address,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import { stabilizeTransactionSigner } from "../client/signer-identity.js";
import { AgencError, type MarketplaceClient } from "../client/index.js";
import type { HireFromListingHumanlessInput } from "../facade/listings.js";
import type { SetTaskJobSpecInput } from "../facade/tasks.js";
import {
  fetchMaybeHireRecord,
  fetchMaybeTask,
  fetchMaybeTaskEscrow,
  fetchMaybeTaskJobSpec,
  fetchMaybeTaskValidationConfig,
  findCreateTaskHumanlessAuthorityRateLimitPda,
  findEscrowPda,
  findHireRecordPda,
  findListingModerationPda,
  findModerationAttestorPda,
  findModerationBlockPda,
  findModerationConfigPda,
  findProtocolConfigPda,
  findTaskJobSpecPda,
  findTaskValidationConfigPda,
  getHireFromListingHumanlessInstructionDataEncoder,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  TaskStatus,
  TaskType,
  ValidationMode,
} from "../generated/index.js";
import * as facade from "../facade/index.js";
import { snapshotFixedBytes } from "../values/fixed-bytes.js";
import { bytesToHex, sha256 } from "../values/hash.js";
import { snapshotStructuredClone } from "../values/structured-clone.js";
import {
  resolveActivationModerationAccounts,
  resolveHireListingModerationAccounts,
  type ModerationAccountReadRpc,
} from "./moderation-accounts.js";

/**
 * The hire step's parameters; `creator` comes from the orchestration input.
 * `taskJobSpecHash` is required by revision 5 and is the immutable buyer-work
 * commitment checked again before activation.
 */
export type HireAndActivateHireInput = Omit<
  HireFromListingHumanlessInput,
  "creator" | "listingSpecHash"
> & {
  /** Exact non-zero listing content hash required for safe ambiguous recovery. */
  listingSpecHash: NonNullable<
    HireFromListingHumanlessInput["listingSpecHash"]
  >;
};

/** Optional activation-step overrides (gate mechanics + moderator). */
export type HireAndActivateActivationInput = Omit<
  SetTaskJobSpecInput,
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
  jobSpecHash: SetTaskJobSpecInput["jobSpecHash"];
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
  /** Stable digest binding every durable recovery phase to the funded intent. */
  hireIntentDigest: string;
  /** True when finalized Task state proved the hire but no signature was attributable. */
  hireReconciled?: boolean;
}

export type HireAndActivateHost<TJobSpec> = (
  input: HireAndActivateHostInput<TJobSpec>,
) => Promise<HireAndActivateModerationResult>;

export type HireAndActivatePhase = "hiring" | "moderating" | "activating";

export interface HireAndActivateInput<TJobSpec = unknown> {
  hire: HireAndActivateHireInput;
  /**
   * Structured-cloneable buyer job spec. The callback receives an owned deep
   * snapshot taken synchronously when orchestration starts.
   */
  jobSpec: TJobSpec;
  hostAndModerateJobSpec: HireAndActivateHost<TJobSpec>;
  activation?: HireAndActivateActivationInput;
  /** Buyer signer; defaults to the client's signer. */
  creator?: TransactionSigner;
  /**
   * Account-read RPC for auto-resolving the P1.2 gate mechanics (roster PDA /
   * legacy record overrides). Omit both and resolution is skipped — callers
   * can always pass the overrides explicitly instead. Safe ambiguous-hire
   * recovery additionally requires this handle to support finalized
   * `getTransaction`, as a normal `createSolanaRpc` client does.
   */
  rpc?: ModerationAccountReadRpc;
  rpcUrl?: string | null;
  /** Progress callback — fires as each phase begins. */
  onPhase?: (phase: HireAndActivatePhase) => void;
}

export interface HireAndActivateResult {
  taskPda: Address;
  /**
   * Exact transaction signature. Ambiguous-hire recovery returns its verified
   * candidate signature after the finalized transaction and account outcome
   * both match; it never invents an empty receipt signature.
   */
  hireSignature: string;
  /** Legacy empty-signature recovery marker retained for token compatibility. */
  hireReconciled?: boolean;
  /**
   * Transaction signature, or the empty string when exact finalized account
   * state proves an ambiguous send landed but no signature can be attributed
   * safely. Check `activationReconciled` before building a receipt link.
   */
  activationSignature: string;
  /** True when success was reconciled from finalized on-chain state. */
  activationReconciled?: boolean;
  jobSpecHash: SetTaskJobSpecInput["jobSpecHash"];
  jobSpecUri: string;
  moderation?: unknown;
}

interface HireAndActivateCommittedHire {
  taskPda: Address;
  hireSignature: string;
  /** Opaque SHA-256 binding this recovery token to the complete hire request. */
  hireIntentDigest: string;
  /** Legacy marker; new reconciliations preserve the attributable signature. */
  hireReconciled?: true;
}

type BoundHireAndActivateCommittedHire = HireAndActivateCommittedHire;

export interface HireAndActivateModeratingProgress extends HireAndActivateCommittedHire {
  phase: "moderating";
}

export interface HireAndActivateActivatingProgress extends HireAndActivateCommittedHire {
  phase: "activating";
  jobSpecHash: SetTaskJobSpecInput["jobSpecHash"];
  jobSpecUri: string;
  moderator: Address;
}

/**
 * A submitted hire whose finalized account outcome is not known yet. Resuming
 * this token only reconciles; it never submits another funded hire.
 */
export interface HireAndActivateHiringProgress {
  phase: "hiring";
  taskPda: Address;
  /** Locally attributable wire signature; required before state can be adopted. */
  candidateSignature: string | null;
  /**
   * Opaque SHA-256 binding this token to the exact logical hire intent. New
   * tokens always carry it; optional typing lets old serialized tokens fail
   * closed at runtime with an actionable error rather than failing to parse.
   */
  hireIntentDigest: string;
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
    this.progress = snapshotProgress(options.progress);
  }
}

function snapshotProgress(
  progress: HireAndActivateProgress,
): HireAndActivateProgress {
  if (progress.phase === "activating") {
    return {
      ...progress,
      jobSpecHash: snapshotFixedBytes(
        progress.jobSpecHash,
        32,
        "resumeHireAndActivate: recovery.jobSpecHash",
      ),
    };
  }
  return { ...progress };
}

function snapshotJobSpec<TJobSpec>(jobSpec: TJobSpec): TJobSpec {
  try {
    return snapshotStructuredClone(jobSpec, "hireAndActivate: jobSpec");
  } catch (cause) {
    throw new TypeError(
      "hireAndActivate: jobSpec must be structured-cloneable so its post-funding host input cannot change during awaits",
      { cause },
    );
  }
}

/**
 * Keep one immutable public key for PDA derivation, wire construction, and
 * reconciliation even when a wallet adapter mutates its live account object.
 * Signer methods remain bound to the original signer implementation.
 *
 * Do not proxy or copy the signer. Solana Kit signers are commonly frozen, a
 * Proxy cannot substitute their non-configurable capabilities, and a copy
 * creates two signer identities for one address. The client stabilizer locks
 * mutable signers in place and therefore preserves fee-payer identity.
 */
function snapshotTransactionSigner(
  signer: TransactionSigner,
  clientSigner: TransactionSigner,
): TransactionSigner {
  const stableClientSigner = stabilizeTransactionSigner(clientSigner);
  if (
    signer === stableClientSigner ||
    address(signer.address) === stableClientSigner.address
  ) {
    return stableClientSigner;
  }
  const stableSigner = stabilizeTransactionSigner(signer);
  return stableSigner.address === stableClientSigner.address
    ? stableClientSigner
    : stableSigner;
}

function snapshotInput<TJobSpec>(
  client: MarketplaceClient,
  input: HireAndActivateInput<TJobSpec>,
): HireAndActivateInput<TJobSpec> {
  const hire: HireAndActivateHireInput = {
    ...input.hire,
    taskId: snapshotFixedBytes(
      input.hire.taskId,
      32,
      "hireAndActivate: hire.taskId",
    ),
    taskJobSpecHash: snapshotFixedBytes(
      input.hire.taskJobSpecHash,
      32,
      "hireAndActivate: hire.taskJobSpecHash",
    ),
    listingSpecHash: snapshotFixedBytes(
      input.hire.listingSpecHash,
      32,
      "hireAndActivate: hire.listingSpecHash",
    ),
  };
  if (hire.referrer === undefined && client.defaultReferrer !== undefined) {
    hire.referrer = client.defaultReferrer.address;
    hire.referrerFeeBps = client.defaultReferrer.feeBps;
  } else if (typeof hire.referrer === "object" && hire.referrer !== null) {
    hire.referrer = { ...hire.referrer };
  }
  return {
    ...input,
    hire,
    jobSpec: snapshotJobSpec(input.jobSpec),
    creator: snapshotTransactionSigner(
      input.creator ?? client.signer,
      client.signer,
    ),
    ...(input.activation === undefined
      ? {}
      : { activation: { ...input.activation } }),
  };
}

/**
 * The attributable hire transaction reached finalized commitment with an
 * execution error. Solana transaction execution is atomic, so no hire state or
 * escrow funding committed; callers may discard the recovery token and submit
 * a fresh hire after addressing the reported failure.
 */
export class HireAndActivateFinalizedFailure extends Error {
  readonly signature: string;
  readonly retrySafe = true as const;

  constructor(signature: string, transactionError: unknown) {
    super(
      `Hire transaction ${signature} finalized with an execution error; no hire state committed and a corrected hire may be submitted safely.`,
      { cause: transactionError },
    );
    this.name = "HireAndActivateFinalizedFailure";
    this.signature = signature;
  }
}

function validateHireCommitment(hash: ReadonlyUint8Array): void {
  if (!hash.some((byte) => byte !== 0)) {
    throw new TypeError(
      "hireAndActivate: hire.taskJobSpecHash must not be all zeroes",
    );
  }
}

function validateListingCommitment(hash: ReadonlyUint8Array): void {
  if (!hash.some((byte) => byte !== 0)) {
    throw new TypeError(
      "hireAndActivate: hire.listingSpecHash must not be all zeroes",
    );
  }
}

function validateActivationOverrides(
  activation: HireAndActivateActivationInput | undefined,
): void {
  if (activation === undefined) return;
  for (const field of [
    "protocolConfig",
    "moderationConfig",
    "taskModeration",
    "moderationAttestor",
    "moderationBlock",
    "taskJobSpec",
    "systemProgram",
    "hireRecord",
    "moderator",
  ] as const) {
    const value = activation[field];
    if (value === undefined) continue;
    try {
      address(value as string);
    } catch (cause) {
      throw new TypeError(
        `hireAndActivate: activation.${field} must be a valid Solana address before a funded hire is submitted`,
        { cause },
      );
    }
  }
  if (
    activation.moderatorIsAttestor !== undefined &&
    typeof activation.moderatorIsAttestor !== "boolean"
  ) {
    throw new TypeError(
      "hireAndActivate: activation.moderatorIsAttestor must be boolean before a funded hire is submitted",
    );
  }
}

function validateHireOverrides(hire: HireAndActivateHireInput): void {
  if (
    hire.moderatorIsAttestor !== undefined &&
    typeof hire.moderatorIsAttestor !== "boolean"
  ) {
    throw new TypeError(
      "hireAndActivate: hire.moderatorIsAttestor must be boolean before a funded hire is submitted",
    );
  }
}

function validateModerationResult(
  result: HireAndActivateModerationResult,
  committedHash: ReadonlyUint8Array,
): {
  jobSpecHash: SetTaskJobSpecInput["jobSpecHash"];
  jobSpecUri: string;
  moderator: Address;
} {
  if (result.moderationAttested !== true) {
    throw new Error(
      "Task moderation was not attested; activation was not signed.",
    );
  }
  let jobSpecHash: Uint8Array;
  try {
    jobSpecHash = snapshotFixedBytes(
      result.jobSpecHash,
      32,
      "hireAndActivate: moderation.jobSpecHash",
    );
  } catch {
    throw new Error(
      "Task moderation returned an invalid jobSpecHash; activation was not signed.",
    );
  }
  if (!bytesEqual(jobSpecHash, committedHash)) {
    throw new Error(
      "Task moderation returned a jobSpecHash different from the hash committed at hire; activation was not signed.",
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
    jobSpecHash,
    jobSpecUri,
    moderator,
  };
}

function bytesEqual(
  left: ReadonlyUint8Array,
  right: ReadonlyUint8Array,
): boolean {
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

function expectedReferral<TJobSpec>(input: HireAndActivateInput<TJobSpec>): {
  referrer: Address;
  feeBps: number;
} {
  const feeBps = input.hire.referrerFeeBps ?? 0;
  if (feeBps === 0) {
    return { referrer: DEFAULT_ADDRESS, feeBps: 0 };
  }
  return {
    referrer: resolveOptionalAddress(input.hire.referrer, "hire.referrer"),
    feeBps,
  };
}

function isCanonicalTransactionSignature(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) {
    return false;
  }
  try {
    const bytes = new Uint8Array(getBase58Encoder().encode(value));
    return (
      bytes.byteLength === 64 && getBase58Decoder().decode(bytes) === value
    );
  } catch {
    return false;
  }
}

function candidateSignature(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "signature" in error &&
    isCanonicalTransactionSignature(error.signature)
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

const COMPUTE_BUDGET_PROGRAM_ADDRESS =
  "ComputeBudget111111111111111111111111111111";
const MANUAL_VALIDATION_SENTINEL = new TextEncoder().encode(
  "agenc-manual-validation-v2-seed!",
);
const INTENT_DIGEST_DOMAIN = "agenc:hire-and-activate:intent:v1";

type HireProofInstruction = {
  readonly accounts: readonly number[];
  readonly data: string;
  readonly programIdIndex: number;
};

type HireProofTransaction = {
  readonly meta: { readonly err: unknown } | null;
  readonly transaction: {
    readonly signatures: readonly string[];
    readonly message: {
      readonly accountKeys: readonly string[];
      readonly instructions: readonly HireProofInstruction[];
      readonly addressTableLookups?: readonly unknown[];
    };
  };
};

type HireProofRpc = {
  getTransaction(
    signature: string,
    config: {
      readonly commitment: "finalized";
      readonly encoding: "json";
      readonly maxSupportedTransactionVersion: 0;
    },
  ): { send(): Promise<HireProofTransaction | null> };
};

function hireProofRpc<TJobSpec>(
  input: HireAndActivateInput<TJobSpec>,
): HireProofRpc | null {
  const rpc = taskJobSpecReadRpc(input);
  if (
    rpc === null ||
    typeof (rpc as unknown as { getTransaction?: unknown }).getTransaction !==
      "function"
  ) {
    return null;
  }
  return rpc as unknown as HireProofRpc;
}

function effectiveHireInstructionData<TJobSpec>(
  input: HireAndActivateInput<TJobSpec>,
): Uint8Array {
  return new Uint8Array(
    getHireFromListingHumanlessInstructionDataEncoder().encode({
      taskId: input.hire.taskId,
      expectedPrice: input.hire.expectedPrice,
      expectedVersion: input.hire.expectedVersion,
      reviewWindowSecs: input.hire.reviewWindowSecs,
      referrer: input.hire.referrer ?? null,
      referrerFeeBps: input.hire.referrerFeeBps ?? 0,
      moderator: input.hire.moderator,
      taskJobSpecHash: input.hire.taskJobSpecHash,
    }),
  );
}

function optionalIntentField(value: unknown): string {
  if (value === undefined) return "<undefined>";
  if (value === null) return "<null>";
  return String(value);
}

async function hireIntentDigest<TJobSpec>(
  input: HireAndActivateInput<TJobSpec>,
  creator: TransactionSigner,
): Promise<string> {
  const listingSpecHash = input.hire.listingSpecHash;
  const logicalFields = [
    INTENT_DIGEST_DOMAIN,
    creator.address,
    input.hire.listing,
    input.hire.providerAgent,
    bytesToHex(new Uint8Array(listingSpecHash)),
    optionalIntentField(input.hire.task),
    optionalIntentField(input.hire.escrow),
    optionalIntentField(input.hire.hireRecord),
    optionalIntentField(input.hire.taskValidationConfig),
    optionalIntentField(input.hire.protocolConfig),
    optionalIntentField(input.hire.moderationConfig),
    optionalIntentField(input.hire.listingModeration),
    optionalIntentField(input.hire.moderationAttestor),
    optionalIntentField(input.hire.moderationBlock),
    optionalIntentField(input.hire.authorityRateLimit),
    optionalIntentField(input.hire.systemProgram),
    input.hire.moderatorIsAttestor === undefined
      ? "auto"
      : input.hire.moderatorIsAttestor
        ? "attestor"
        : "authority",
  ];
  const prefix = new TextEncoder().encode(
    `${logicalFields.join("\u001f")}\u001e`,
  );
  const instructionData = effectiveHireInstructionData(input);
  const digestInput = new Uint8Array(
    prefix.byteLength + instructionData.byteLength,
  );
  digestInput.set(prefix);
  digestInput.set(instructionData, prefix.byteLength);
  return bytesToHex(await sha256(digestInput));
}

function requiredListingSpecHash<TJobSpec>(
  input: HireAndActivateInput<TJobSpec>,
): Uint8Array {
  const hash = input.hire.listingSpecHash;
  if (!hash.some((byte) => byte !== 0)) {
    throw new Error(
      "Finalized hire recovery requires the exact non-zero 32-byte hire.listingSpecHash; refusing to infer listing intent",
    );
  }
  return new Uint8Array(hash);
}

async function proveFinalizedHireTransaction<TJobSpec>(
  input: HireAndActivateInput<TJobSpec>,
  creator: TransactionSigner,
  taskPda: Address,
  candidateSignature: string,
): Promise<
  { status: "succeeded" } | { status: "failed"; transactionError: unknown }
> {
  if (!isCanonicalTransactionSignature(candidateSignature)) {
    throw new Error("candidate hire transaction signature is not canonical");
  }
  const rpc = hireProofRpc(input);
  if (rpc === null) {
    throw new Error(
      "the reconciliation RPC does not support finalized getTransaction proof",
    );
  }
  const transaction = await rpc
    .getTransaction(candidateSignature, {
      commitment: "finalized",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  if (transaction === null) {
    throw new Error(
      `candidate hire transaction ${candidateSignature} is not available at finalized commitment`,
    );
  }
  if (transaction.meta === null) {
    throw new Error(
      `candidate hire transaction ${candidateSignature} has no finalized execution metadata`,
    );
  }
  if (!("err" in transaction.meta)) {
    throw new Error(
      `candidate hire transaction ${candidateSignature} has malformed execution metadata`,
    );
  }
  const transactionError = transaction.meta.err;
  if (transaction.transaction.signatures[0] !== candidateSignature) {
    throw new Error(
      "finalized transaction does not carry the candidate signature",
    );
  }

  const message = transaction.transaction.message;
  if (
    message.addressTableLookups !== undefined &&
    message.addressTableLookups.length !== 0
  ) {
    throw new Error(
      "candidate hire transaction uses address lookup tables; refusing ambiguous account resolution",
    );
  }
  const programInstructions: HireProofInstruction[] = [];
  for (const instruction of message.instructions) {
    const program = message.accountKeys[instruction.programIdIndex];
    if (program === AGENC_COORDINATION_PROGRAM_ADDRESS) {
      programInstructions.push(instruction);
    } else if (program !== COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      throw new Error(
        `candidate hire transaction contains unexpected program ${program ?? "<out-of-bounds>"}`,
      );
    }
  }
  if (programInstructions.length !== 1) {
    throw new Error(
      "candidate hire transaction must contain exactly one AgenC instruction",
    );
  }
  const instruction = programInstructions[0]!;
  let instructionData: Uint8Array;
  try {
    instructionData = new Uint8Array(
      getBase58Encoder().encode(instruction.data),
    );
  } catch (cause) {
    throw new Error("candidate hire transaction has invalid instruction data", {
      cause,
    });
  }
  if (!bytesEqual(instructionData, effectiveHireInstructionData(input))) {
    throw new Error(
      "candidate hire transaction arguments do not match the requested hire intent",
    );
  }

  const listingSpecHash = requiredListingSpecHash(input);
  const [
    [escrowPda],
    [hireRecordPda],
    [validationConfigPda],
    [protocolConfigPda],
    [moderationConfigPda],
    [moderationBlockPda],
    [authorityRateLimitPda],
    [v2ModerationPda],
    [legacyModerationPda],
    [moderationAttestorPda],
  ] = await Promise.all([
    findEscrowPda({ task: taskPda }),
    findHireRecordPda({ task: taskPda }),
    findTaskValidationConfigPda({ task: taskPda }),
    findProtocolConfigPda(),
    findModerationConfigPda(),
    findModerationBlockPda({ contentHash: listingSpecHash }),
    findCreateTaskHumanlessAuthorityRateLimitPda({ creator: creator.address }),
    findListingModerationPda({
      listing: input.hire.listing,
      jobSpecHash: listingSpecHash,
      moderator: input.hire.moderator,
    }),
    facade.findLegacyListingModerationPda({
      listing: input.hire.listing,
      jobSpecHash: listingSpecHash,
    }),
    findModerationAttestorPda({ attestor: input.hire.moderator }),
  ]);
  if (instruction.accounts.length !== 14) {
    throw new Error(
      "candidate hire transaction does not use the revision-5 humanless-hire account surface",
    );
  }
  const accounts = instruction.accounts.map((index) => {
    const account = message.accountKeys[index];
    if (account === undefined) {
      throw new Error(
        "candidate hire transaction account index is out of bounds",
      );
    }
    return account;
  });
  const exactAccounts: ReadonlyArray<readonly [number, Address]> = [
    [0, taskPda],
    [1, escrowPda],
    [2, hireRecordPda],
    [3, validationConfigPda],
    [4, input.hire.listing],
    [5, input.hire.providerAgent],
    [6, protocolConfigPda],
    [7, moderationConfigPda],
    [10, moderationBlockPda],
    [11, authorityRateLimitPda],
    [12, creator.address],
    [13, DEFAULT_ADDRESS],
  ];
  for (const [index, expected] of exactAccounts) {
    if (accounts[index] !== expected) {
      throw new Error(
        `candidate hire transaction account ${index} does not match the requested hire intent`,
      );
    }
  }
  const listingModerationMatches =
    input.hire.listingModeration !== undefined
      ? accounts[8] === input.hire.listingModeration
      : accounts[8] === v2ModerationPda || accounts[8] === legacyModerationPda;
  if (!listingModerationMatches) {
    throw new Error(
      "candidate hire transaction uses a non-canonical listing moderation account",
    );
  }
  const moderationAttestorMatches =
    input.hire.moderationAttestor !== undefined
      ? accounts[9] === input.hire.moderationAttestor
      : input.hire.moderatorIsAttestor === true
        ? accounts[9] === moderationAttestorPda
        : input.hire.moderatorIsAttestor === false
          ? accounts[9] === AGENC_COORDINATION_PROGRAM_ADDRESS
          : accounts[9] === moderationAttestorPda ||
            accounts[9] === AGENC_COORDINATION_PROGRAM_ADDRESS;
  if (!moderationAttestorMatches) {
    throw new Error(
      "candidate hire transaction uses a non-canonical moderation attestor account",
    );
  }
  return transactionError === null
    ? { status: "succeeded" }
    : { status: "failed", transactionError };
}

type HireReconciliationProof = {
  candidateSignature: string;
  hireIntentDigest: string;
};

/**
 * Prove that the exact ambiguous transaction committed the complete durable
 * hire requested by this orchestration. Account coincidence is intentionally
 * insufficient: the finalized transaction supplies execution-time evidence
 * for `expectedVersion` and `moderator`, while the Task, escrow, HireRecord,
 * validation config prove every caller-selected or internally linked persisted
 * term. Current Listing/ProtocolConfig state is deliberately not consulted:
 * both may validly change after the exact transaction finalizes, and treating
 * those mutable accounts as historical evidence permanently wedges recovery.
 * Execution-time listing version/provider/moderator/arguments come from the
 * finalized transaction; execution-snapshotted operator/fee fields are checked
 * for consistency between the immutable Task and HireRecord.
 */
async function reconcileHire<TJobSpec>(
  input: HireAndActivateInput<TJobSpec>,
  creator: TransactionSigner,
  taskPda: Address,
  proof: HireReconciliationProof | null,
): Promise<BoundHireAndActivateCommittedHire | null> {
  const rpc = taskJobSpecReadRpc(input);
  if (rpc === null) return null;
  let transactionOutcome:
    | { status: "succeeded" }
    | { status: "failed"; transactionError: unknown }
    | null = null;
  if (proof !== null) {
    const expectedIntentDigest = await hireIntentDigest(input, creator);
    if (proof.hireIntentDigest !== expectedIntentDigest) {
      throw new Error(
        "Hire recovery token does not match the supplied hire intent; refusing to adopt finalized state",
      );
    }
    // Transaction finality must be examined before account presence. A
    // finalized execution error proves atomic non-commit and is retry-safe;
    // waiting for accounts first would wedge that terminal outcome forever.
    transactionOutcome = await proveFinalizedHireTransaction(
      input,
      creator,
      taskPda,
      proof.candidateSignature,
    );
  }
  const [[escrowPda], [hireRecordPda], [validationConfigPda]] =
    await Promise.all([
      findEscrowPda({ task: taskPda }),
      findHireRecordPda({ task: taskPda }),
      findTaskValidationConfigPda({ task: taskPda }),
    ]);
  const [task, escrow, hireRecord, validationConfig] = await Promise.all([
    fetchMaybeTask(rpc, taskPda, { commitment: "finalized" }),
    fetchMaybeTaskEscrow(rpc, escrowPda, { commitment: "finalized" }),
    fetchMaybeHireRecord(rpc, hireRecordPda, { commitment: "finalized" }),
    fetchMaybeTaskValidationConfig(rpc, validationConfigPda, {
      commitment: "finalized",
    }),
  ]);
  const present = [
    task.exists,
    escrow.exists,
    hireRecord.exists,
    validationConfig.exists,
  ];
  if (transactionOutcome?.status === "failed") {
    if (present.every((exists) => !exists)) {
      throw new HireAndActivateFinalizedFailure(
        proof!.candidateSignature,
        transactionOutcome.transactionError,
      );
    }
    throw new Error(
      `Candidate hire transaction ${proof!.candidateSignature} failed, but finalized hire state exists at ${taskPda}; refusing to classify the recovery token as retry-safe`,
    );
  }
  if (present.every((exists) => !exists)) {
    if (proof === null) return null;
    throw new Error(
      `Candidate hire transaction finalized successfully, but finalized account state for ${taskPda} is absent`,
    );
  }
  if (
    !task.exists ||
    !escrow.exists ||
    !hireRecord.exists ||
    !validationConfig.exists
  ) {
    throw new Error(
      `Finalized hire state for ${taskPda} is incomplete; refusing to resend a potentially funded hire`,
    );
  }
  if (proof === null) {
    throw new Error(
      `Finalized state already exists at ${taskPda}, but no attributable ambiguous hire transaction was supplied; refusing to adopt or resend`,
    );
  }
  const expectedPrice = BigInt(input.hire.expectedPrice);
  const expectedReviewWindow = BigInt(input.hire.reviewWindowSecs);
  const referral = expectedReferral(input);
  const listingSpecHash = requiredListingSpecHash(input);
  const expectedDescription = new Uint8Array(64);
  expectedDescription.set(listingSpecHash);
  expectedDescription.set(new Uint8Array(input.hire.taskJobSpecHash), 32);
  const matches =
    bytesEqual(
      new Uint8Array(task.data.taskId),
      new Uint8Array(input.hire.taskId),
    ) &&
    task.data.creator === creator.address &&
    bytesEqual(new Uint8Array(task.data.description), expectedDescription) &&
    bytesEqual(
      new Uint8Array(task.data.constraintHash),
      MANUAL_VALIDATION_SENTINEL,
    ) &&
    task.data.rewardAmount === expectedPrice &&
    task.data.maxWorkers === 1 &&
    task.data.currentWorkers === 0 &&
    task.data.status === TaskStatus.Open &&
    task.data.taskType === TaskType.Exclusive &&
    task.data.deadline > task.data.createdAt &&
    task.data.completedAt === 0n &&
    task.data.escrow === escrowPda &&
    task.data.completions === 0 &&
    task.data.requiredCompletions === 1 &&
    task.data.minReputation === 0 &&
    isNone(task.data.rewardMint) &&
    task.data.operator === hireRecord.data.operator &&
    task.data.operatorFeeBps === hireRecord.data.operatorFeeBps &&
    task.data.referrer === referral.referrer &&
    task.data.referrerFeeBps === referral.feeBps &&
    escrow.data.task === taskPda &&
    escrow.data.amount === expectedPrice &&
    escrow.data.distributed === 0n &&
    escrow.data.isClosed === false &&
    hireRecord.data.task === taskPda &&
    hireRecord.data.listing === input.hire.listing &&
    hireRecord.data.designatedProvider === input.hire.providerAgent &&
    hireRecord.data.referrer === referral.referrer &&
    hireRecord.data.referrerFeeBps === referral.feeBps &&
    validationConfig.data.task === taskPda &&
    validationConfig.data.creator === creator.address &&
    validationConfig.data.mode === ValidationMode.CreatorReview &&
    validationConfig.data.reviewWindowSecs === expectedReviewWindow &&
    validationConfig.data.createdAt === task.data.createdAt &&
    validationConfig.data.updatedAt === task.data.createdAt;
  if (!matches) {
    throw new Error(
      `Finalized state at ${taskPda} does not match the funded hire intent; refusing to treat it as committed or resend`,
    );
  }
  return {
    taskPda,
    hireSignature: proof.candidateSignature,
    hireIntentDigest: proof.hireIntentDigest,
  };
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
  };
}

async function activateCommittedHire<TJobSpec>(
  client: MarketplaceClient,
  input: HireAndActivateInput<TJobSpec>,
  creator: TransactionSigner,
  progress: HireAndActivateActivatingProgress,
  ephemeralModeration?: unknown,
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
      } as SetTaskJobSpecInput);
      if (!isCanonicalTransactionSignature(activationResult.signature)) {
        const committed = await reconcileActivation(input, creator, progress);
        if (committed !== null) return committed;
        throw new TypeError(
          "activation returned a non-canonical transaction signature and finalized account state is not yet attributable",
        );
      }
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
      moderation: ephemeralModeration,
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
  committed: BoundHireAndActivateCommittedHire,
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
      hireIntentDigest: committed.hireIntentDigest,
      hireReconciled: committed.hireReconciled,
    });
    const validated = validateModerationResult(
      moderation,
      input.hire.taskJobSpecHash,
    );
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
    return activateCommittedHire(
      client,
      input,
      creator,
      {
        phase: "activating",
        ...committed,
        ...validated,
        moderator: activationModerator,
      },
      moderation.moderation,
    );
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
  input = snapshotInput(client, input);
  validateHireCommitment(input.hire.taskJobSpecHash);
  validateListingCommitment(input.hire.listingSpecHash);
  validateHireOverrides(input.hire);
  validateActivationOverrides(input.activation);
  const creator = input.creator!;
  const intentDigest = await hireIntentDigest(input, creator);
  const readSeam = { rpc: input.rpc, rpcUrl: input.rpcUrl ?? null };
  const canResolve = input.rpc !== undefined || Boolean(input.rpcUrl);

  input.onPhase?.("hiring");
  const [taskPda] = await facade.findTaskPda({
    creator: creator.address,
    taskId: input.hire.taskId,
  });
  // A bare occupied PDA is never adoption evidence. This read is only a
  // collision preflight; reconciliation requires the exact ambiguous wire
  // signature carried by a recovery token.
  await reconcileHire(input, creator, taskPda, null);
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
    } as HireFromListingHumanlessInput);
  } catch (sendCause) {
    // The SDK uses signature=null only when it proved the failure occurred
    // before broadcast. Reconciliation-only recovery would wedge that safe,
    // retryable case forever, so preserve the original retry-safe error.
    if (sendCause instanceof AgencError && sendCause.signature === null) {
      throw sendCause;
    }
    const signature = candidateSignature(sendCause);
    const progress: HireAndActivateHiringProgress = {
      phase: "hiring",
      taskPda,
      candidateSignature: signature,
      hireIntentDigest: intentDigest,
    };
    if (signature !== null) {
      try {
        const committed = await reconcileHire(input, creator, taskPda, {
          candidateSignature: signature,
          hireIntentDigest: intentDigest,
        });
        if (committed !== null) {
          return moderateCommittedHire(client, input, creator, committed);
        }
      } catch (reconcileCause) {
        if (reconcileCause instanceof HireAndActivateFinalizedFailure) {
          throw reconcileCause;
        }
        throw new HireAndActivateError(
          `Hire submission outcome is not safely reconcilable: ${sendCause instanceof Error ? sendCause.message : String(sendCause)}. ` +
            `Finalized proof failed: ${reconcileCause instanceof Error ? reconcileCause.message : String(reconcileCause)}. ` +
            "Resume from error.progress to retry proof; do not submit another funded hire.",
          { progress, cause: sendCause },
        );
      }
    }
    throw new HireAndActivateError(
      `Hire submission outcome is not finalized: ${sendCause instanceof Error ? sendCause.message : String(sendCause)}. ` +
        "Resume from error.progress to reconcile; do not submit another funded hire.",
      {
        progress,
        cause: sendCause,
      },
    );
  }

  if (!isCanonicalTransactionSignature(hireResult.signature)) {
    throw new HireAndActivateError(
      "Hire submission returned a non-canonical transaction signature; preserve this ambiguous token and do not submit another funded hire.",
      {
        progress: {
          phase: "hiring",
          taskPda,
          candidateSignature: null,
          hireIntentDigest: intentDigest,
        },
        cause: new TypeError("invalid hire transaction signature"),
      },
    );
  }
  return moderateCommittedHire(client, input, creator, {
    taskPda,
    hireSignature: hireResult.signature,
    hireIntentDigest: intentDigest,
  });
}

/**
 * Resume a failed hire flow. Validates that the recovery task matches the
 * supplied hire intent. An ambiguous `hiring` token decodes its attributable
 * transaction at finalized commitment and reconciles only the exact matching
 * account outcome; committed tokens start at moderation or activation. This
 * function never calls `hireFromListingHumanless`.
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
  progress = snapshotProgress(progress);
  input = snapshotInput(client, input);
  validateHireCommitment(input.hire.taskJobSpecHash);
  validateListingCommitment(input.hire.listingSpecHash);
  validateHireOverrides(input.hire);
  validateActivationOverrides(input.activation);
  const creator = input.creator!;
  const intentDigest = await hireIntentDigest(input, creator);
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
  if (
    typeof progress.hireIntentDigest !== "string" ||
    progress.hireIntentDigest.length !== 64 ||
    progress.hireIntentDigest !== intentDigest
  ) {
    throw new TypeError(
      "resumeHireAndActivate: recovery token is missing or does not match the complete supplied hire intent",
    );
  }
  if (progress.phase === "hiring") {
    if (
      !(
        progress.candidateSignature === null ||
        isCanonicalTransactionSignature(progress.candidateSignature)
      )
    ) {
      throw new TypeError(
        "resumeHireAndActivate: invalid ambiguous-hire recovery payload",
      );
    }
    if (progress.candidateSignature === null) {
      throw new HireAndActivateError(
        "Hire submission cannot be adopted without an attributable transaction signature; do not submit another funded hire unless external evidence proves the original was never broadcast.",
        {
          progress,
          cause: new Error("ambiguous hire token has no candidate signature"),
        },
      );
    }
    let committed: BoundHireAndActivateCommittedHire | null;
    try {
      committed = await reconcileHire(input, creator, progress.taskPda, {
        candidateSignature: progress.candidateSignature,
        hireIntentDigest: progress.hireIntentDigest!,
      });
    } catch (cause) {
      if (cause instanceof HireAndActivateFinalizedFailure) throw cause;
      throw new HireAndActivateError(
        `Hire submission outcome is not safely reconcilable: ${cause instanceof Error ? cause.message : String(cause)}. ` +
          "Retry this proof token; do not submit another funded hire.",
        { progress, cause },
      );
    }
    if (committed === null) {
      throw new HireAndActivateError(
        "Hire submission is still absent at finalized commitment; retry this reconciliation token later and do not submit another funded hire.",
        { progress, cause: new Error("finalized hire state is not present") },
      );
    }
    return moderateCommittedHire(client, input, creator, committed);
  }
  const isLegacyReconciledToken =
    progress.hireReconciled === true && progress.hireSignature === "";
  const hasCanonicalAttributedSignature =
    progress.hireReconciled === undefined &&
    isCanonicalTransactionSignature(progress.hireSignature);
  if (!isLegacyReconciledToken && !hasCanonicalAttributedSignature) {
    throw new TypeError("resumeHireAndActivate: invalid recovery progress");
  }
  if (progress.phase === "activating") {
    if (
      !bytesEqual(progress.jobSpecHash, input.hire.taskJobSpecHash) ||
      typeof progress.jobSpecUri !== "string" ||
      progress.jobSpecUri === "" ||
      progress.jobSpecUri !== progress.jobSpecUri.trim()
    ) {
      throw new TypeError(
        "resumeHireAndActivate: activation recovery payload does not match the funded hire intent",
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
    ? moderateCommittedHire(
        client,
        input,
        creator,
        progress as BoundHireAndActivateCommittedHire,
      )
    : activateCommittedHire(client, input, creator, progress);
}
