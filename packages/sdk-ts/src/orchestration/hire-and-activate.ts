/**
 * `hireAndActivate` — the complete buyer-side service-hire orchestration in
 * the open SDK: hire a listing, host + moderate the buyer-specific job spec,
 * then pin it (`set_task_job_spec`) so provider agents can claim.
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
 *     the moderator returned by step 2. After this the task is claimable.
 *
 * Moderation-gate mechanics (P1.2 roster PDA / legacy record overrides) are
 * auto-resolved via {@link resolveHireListingModerationAccounts} /
 * {@link resolveActivationModerationAccounts} when an RPC is supplied and the
 * caller has not resolved them explicitly.
 *
 * @module orchestration/hire-and-activate
 */
import type { Address, TransactionSigner } from "@solana/kit";
import type { MarketplaceClient } from "../client/index.js";
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
export type HireAndActivateHireInput = Omit<HumanlessHireFacadeInput, "creator">;

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
  hireSignature: string;
  activationSignature: string;
  jobSpecHash: SetTaskJobSpecFacadeInput["jobSpecHash"];
  jobSpecUri: string;
  moderation?: unknown;
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
  return {
    jobSpecHash: result.jobSpecHash,
    jobSpecUri,
    moderator: result.moderator,
  };
}

/**
 * Run the full hire → host/moderate → activate flow through a
 * {@link MarketplaceClient}. Returns only after the task is claimable by
 * provider agents (activation signed); throws on the first failed step.
 */
export async function hireAndActivate<TJobSpec = unknown>(
  client: MarketplaceClient,
  input: HireAndActivateInput<TJobSpec>,
): Promise<HireAndActivateResult> {
  const creator = input.creator ?? client.signer;
  const readSeam = { rpc: input.rpc, rpcUrl: input.rpcUrl ?? null };
  const canResolve = input.rpc !== undefined || Boolean(input.rpcUrl);

  input.onPhase?.("hiring");
  // P1.2: resolve the hire gate's moderation mechanics (roster PDA / legacy
  // record override) unless the caller supplied any of them.
  const hireCallerResolved =
    input.hire.moderationAttestor !== undefined ||
    input.hire.moderatorIsAttestor !== undefined ||
    input.hire.listingModeration !== undefined;
  const hireModerationArgs =
    !hireCallerResolved && canResolve && input.hire.listingSpecHash !== undefined
      ? await resolveHireListingModerationAccounts({
          ...readSeam,
          listing: input.hire.listing,
          listingSpecHash: input.hire.listingSpecHash,
          moderator: input.hire.moderator,
        })
      : {};
  const hireResult = await client.hireFromListingHumanless({
    ...input.hire,
    ...hireModerationArgs,
    creator,
  } as HumanlessHireFacadeInput);

  const [taskPda] = await facade.findTaskPda({
    creator: creator.address,
    taskId: input.hire.taskId,
  });

  input.onPhase?.("moderating");
  const moderation = await input.hostAndModerateJobSpec({
    taskPda,
    taskId: input.hire.taskId,
    listing: input.hire.listing,
    jobSpec: input.jobSpec,
    hireSignature: hireResult.signature,
  });
  const { jobSpecHash, jobSpecUri, moderator } =
    validateModerationResult(moderation);

  input.onPhase?.("activating");
  // P1.2: the publish gate consumes the record of the moderator that signed
  // the attestation (the host callback's service by default). Resolve the
  // gate mechanics unless the caller supplied any of them.
  const activationModerator = input.activation?.moderator ?? moderator;
  const activationCallerResolved =
    input.activation?.moderationAttestor !== undefined ||
    input.activation?.moderatorIsAttestor !== undefined ||
    input.activation?.taskModeration !== undefined;
  const activationModerationArgs =
    !activationCallerResolved && canResolve
      ? await resolveActivationModerationAccounts({
          ...readSeam,
          task: taskPda,
          jobSpecHash,
          moderator: activationModerator,
        })
      : {};
  const activationResult = await client.setTaskJobSpec({
    ...(input.activation ?? {}),
    ...activationModerationArgs,
    task: taskPda,
    creator,
    jobSpecHash,
    jobSpecUri,
    moderator: activationModerator,
  } as SetTaskJobSpecFacadeInput);

  return {
    taskPda,
    hireSignature: hireResult.signature,
    activationSignature: activationResult.signature,
    jobSpecHash,
    jobSpecUri,
    moderation: moderation.moderation,
  };
}
