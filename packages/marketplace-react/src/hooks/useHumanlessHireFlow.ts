import { useMutation } from "@tanstack/react-query";
import { address as canonicalAddress } from "@solana/kit";
import { useCallback, useRef, useState } from "react";
import {
  HireAndActivateError,
  HireAndActivateFinalizedFailure,
  hireAndActivate as runHireAndActivate,
  resumeHireAndActivate as runResumeHireAndActivate,
  snapshotStructuredClone,
  type HireAndActivateActivatingProgress,
  type HireAndActivateInput,
  type HireAndActivateModeratingProgress,
  type HireAndActivateProgress,
  type MarketplaceClient,
  type ModerationAccountReadRpc,
} from "@tetsuo-ai/marketplace-sdk";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import type { Address } from "../types.js";
import {
  mutationStatusOf,
  requireClient,
  resolveReferrerArgs,
  snapshotFixedBytes32,
  stabilizeSelectedTransactionSigner,
  withoutReferrerArgs,
  type MutationStatus,
} from "./internal.js";
import type { HumanlessHireInput } from "./useHire.js";
import type { TaskActivationInput } from "./useTaskActivation.js";

export type HumanlessHireFlowPhase =
  | "idle"
  | "hiring"
  | "moderating"
  | "activating"
  | "activated"
  | "error";

export type HumanlessHireFlowStatus = MutationStatus;

export type HumanlessHireFlowHireInput = Omit<
  HumanlessHireInput,
  "humanless" | "creator" | "referrer" | "referrerFeeBps" | "listingSpecHash"
> & {
  /** Exact non-zero listing commitment required by durable SDK recovery. */
  listingSpecHash: NonNullable<HumanlessHireInput["listingSpecHash"]>;
};

export type HumanlessHireFlowActivationInput = Omit<
  TaskActivationInput,
  "creator" | "jobSpecHash" | "jobSpecUri" | "moderator"
> & {
  /**
   * Override the activation `moderator` (P1.2). Defaults to the `moderator`
   * returned by `hostAndModerateJobSpec` — the attestation service that
   * signed the task moderation is whose record the publish gate consumes.
   */
  moderator?: TaskActivationInput["moderator"];
};

export type HumanlessHireFlowCreator = NonNullable<
  HumanlessHireInput["creator"]
>;

export type HumanlessHireFlowJobSpecHash = Parameters<
  typeof facadeNs.setTaskJobSpec
>[0]["jobSpecHash"];

export interface HumanlessHireFlowModerationResult {
  jobSpecHash: HumanlessHireFlowJobSpecHash;
  jobSpecUri: string;
  moderationAttested: boolean;
  /**
   * The pubkey that signed/recorded the task attestation (P1.2) — the
   * attestation service's signer (e.g. attest.agenc.ag `GET /v1/info` →
   * `moderator`). Names whose record the publish gate consumes.
   */
  moderator: Address;
  moderation?: unknown;
}

export interface HumanlessHireFlowHostInput<TJobSpec> {
  taskPda: Address;
  taskId: HumanlessHireFlowHireInput["taskId"];
  listing: HumanlessHireFlowHireInput["listing"];
  jobSpec: TJobSpec;
  hireSignature: string;
  /** True when finalized account state, rather than a wire response, proved the hire. */
  hireReconciled?: boolean;
  referrerInjected: boolean;
}

export type HumanlessHireFlowHost<TJobSpec> = (
  input: HumanlessHireFlowHostInput<TJobSpec>,
) => Promise<HumanlessHireFlowModerationResult>;

export interface HumanlessHireFlowInput<TJobSpec = unknown> {
  hire: HumanlessHireFlowHireInput;
  jobSpec: TJobSpec;
  hostAndModerateJobSpec: HumanlessHireFlowHost<TJobSpec>;
  activation?: HumanlessHireFlowActivationInput;
  creator?: HumanlessHireFlowCreator;
}

export interface HumanlessHireFlowProgress {
  taskPda: Address | null;
  hireSignature: string | null;
  activationSignature: string | null;
  jobSpecHash: HumanlessHireFlowJobSpecHash | null;
  jobSpecUri: string | null;
  referrerInjected: boolean;
  /**
   * Durable SDK resume token. Persist this token before retrying a failed
   * post-submission flow; pass it to `resumeHireAndActivate`, never to the
   * funded `hireAndActivate` entry point.
   */
  recovery: HireAndActivateProgress | null;
}

export interface HumanlessHireFlowResult {
  taskPda: Address;
  hireSignature: string;
  activationSignature: string;
  jobSpecHash: HumanlessHireFlowJobSpecHash;
  jobSpecUri: string;
  referrerInjected: boolean;
  hireReconciled?: boolean;
  activationReconciled?: boolean;
  moderation?: unknown;
}

export interface UseHumanlessHireFlowResult<TJobSpec = unknown> {
  hireAndActivate: (
    input: HumanlessHireFlowInput<TJobSpec>,
  ) => Promise<HumanlessHireFlowResult>;
  /** Resume an exact durable SDK token without submitting another hire. */
  resumeHireAndActivate: (
    input: HumanlessHireFlowInput<TJobSpec>,
    recovery: HireAndActivateProgress,
  ) => Promise<HumanlessHireFlowResult>;
  phase: HumanlessHireFlowPhase;
  status: HumanlessHireFlowStatus;
  progress: HumanlessHireFlowProgress;
  result: HumanlessHireFlowResult | null;
  error: Error | null;
  isPending: boolean;
  reset: () => void;
}

function emptyProgress(): HumanlessHireFlowProgress {
  return {
    taskPda: null,
    hireSignature: null,
    activationSignature: null,
    jobSpecHash: null,
    jobSpecUri: null,
    referrerInjected: false,
    recovery: null,
  };
}

interface SnapshottedFlowInput<TJobSpec> {
  input: HumanlessHireFlowInput<TJobSpec>;
  creatorAddress: Address;
}

function readCreatorAddress(
  creator: HumanlessHireFlowCreator,
  label: string,
): Address {
  try {
    return canonicalAddress(creator.address);
  } catch (cause) {
    throw new TypeError(
      `useHumanlessHireFlow: ${label} must expose a valid Solana address`,
      { cause },
    );
  }
}

function assertCreatorUnchanged(
  creator: HumanlessHireFlowCreator,
  expectedAddress: Address,
): HumanlessHireFlowCreator {
  if (readCreatorAddress(creator, "creator") !== expectedAddress) {
    throw new TypeError(
      "useHumanlessHireFlow: creator address changed after enqueue; no transaction was submitted",
    );
  }
  return creator;
}

function snapshotFlowInput<TJobSpec>(
  input: HumanlessHireFlowInput<TJobSpec>,
  defaultCreator: HumanlessHireFlowCreator,
): SnapshottedFlowInput<TJobSpec> {
  let jobSpec: TJobSpec;
  try {
    jobSpec = snapshotStructuredClone(
      input.jobSpec,
      "useHumanlessHireFlow: jobSpec",
    );
  } catch (cause) {
    throw new TypeError(
      "useHumanlessHireFlow: jobSpec must be structured-cloneable",
      { cause },
    );
  }
  const creator = stabilizeSelectedTransactionSigner(
    defaultCreator,
    input.creator,
  ) as HumanlessHireFlowCreator;
  return {
    creatorAddress: readCreatorAddress(creator, "creator"),
    input: {
      ...input,
      hire: {
        ...input.hire,
        taskId: snapshotFixedBytes32(
          input.hire.taskId,
          "useHumanlessHireFlow: hire.taskId",
        ),
        listingSpecHash: snapshotFixedBytes32(
          input.hire.listingSpecHash,
          "useHumanlessHireFlow: hire.listingSpecHash",
        ),
        taskJobSpecHash: snapshotFixedBytes32(
          input.hire.taskJobSpecHash,
          "useHumanlessHireFlow: hire.taskJobSpecHash",
        ),
      },
      jobSpec,
      ...(input.activation === undefined
        ? {}
        : { activation: { ...input.activation } }),
      creator,
    },
  };
}

function snapshotRecovery(
  recovery: HireAndActivateProgress,
): HireAndActivateProgress {
  return recovery.phase === "activating"
    ? {
        ...recovery,
        jobSpecHash: snapshotFixedBytes32(
          recovery.jobSpecHash,
          "useHumanlessHireFlow: recovery.jobSpecHash",
        ),
      }
    : { ...recovery };
}

function progressFromRecovery(
  recovery: HireAndActivateProgress,
  referrerInjected: boolean,
): HumanlessHireFlowProgress {
  const committed = recovery.phase !== "hiring";
  const activating = recovery.phase === "activating" ? recovery : null;
  return {
    taskPda: recovery.taskPda,
    hireSignature:
      committed && recovery.hireSignature !== ""
        ? recovery.hireSignature
        : null,
    activationSignature: null,
    jobSpecHash: activating?.jobSpecHash ?? null,
    jobSpecUri: activating?.jobSpecUri ?? null,
    referrerInjected,
    recovery,
  };
}

function validateModerationResult(
  result: HumanlessHireFlowModerationResult,
  committedHash: HumanlessHireFlowJobSpecHash,
): {
  jobSpecHash: HumanlessHireFlowJobSpecHash;
  jobSpecUri: string;
  moderator: Address;
} {
  if (result.moderationAttested !== true) {
    throw new Error(
      "Task moderation was not attested; activation was not signed.",
    );
  }
  let jobSpecHash: HumanlessHireFlowJobSpecHash;
  try {
    jobSpecHash = snapshotFixedBytes32(
      result.jobSpecHash,
      "useHumanlessHireFlow: moderation.jobSpecHash",
    ) as HumanlessHireFlowJobSpecHash;
  } catch {
    throw new Error(
      "Task moderation returned an invalid jobSpecHash; activation was not signed.",
    );
  }
  if (!jobSpecHash.every((byte, index) => byte === committedHash[index])) {
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
  return {
    jobSpecHash,
    jobSpecUri,
    moderator: result.moderator,
  };
}

export function useHumanlessHireFlow<
  TJobSpec = unknown,
>(): UseHumanlessHireFlowResult<TJobSpec> {
  const ctx = useAgencContext();
  const [phase, setPhase] = useState<HumanlessHireFlowPhase>("idle");
  const [progress, setProgress] =
    useState<HumanlessHireFlowProgress>(emptyProgress);
  const flowInFlight = useRef(false);

  const mutation = useMutation<
    HumanlessHireFlowResult,
    Error,
    {
      input: HumanlessHireFlowInput<TJobSpec>;
      creatorAddress: Address;
      recovery: HireAndActivateProgress | null;
      client: MarketplaceClient;
      rpc: ModerationAccountReadRpc | null;
      rpcUrl: string | null;
      referral: ReturnType<typeof resolveReferrerArgs>;
    }
  >({
    mutationFn: async ({
      input,
      creatorAddress,
      recovery,
      client,
      rpc,
      rpcUrl,
      referral,
    }) => {
      // The public boundary already canonicalized same-address fee-payer
      // overrides and stabilized distinct signers. Re-read the locked address
      // defensively before any funded orchestration work begins.
      const creator = assertCreatorUnchanged(input.creator!, creatorAddress);
      const { referrerArgs, referrerInjected } = referral;
      const hireInput = withoutReferrerArgs(input.hire);
      const activationInput: NonNullable<
        HireAndActivateInput<TJobSpec>["activation"]
      > = { ...(input.activation ?? {}) };
      let activationRecovery: HireAndActivateActivatingProgress | null =
        recovery?.phase === "activating" ? recovery : null;

      setPhase(recovery?.phase ?? "hiring");
      setProgress(
        recovery === null
          ? { ...emptyProgress(), referrerInjected }
          : progressFromRecovery(recovery, referrerInjected),
      );

      try {
        // The SDK owns automatic hire-moderation account resolution. Keeping
        // those transaction-mechanics fields outside this wrapper's logical
        // input makes the intent digest identical on an ambiguous resume.
        const orchestration: HireAndActivateInput<TJobSpec> = {
          hire: {
            ...hireInput,
            ...referrerArgs,
          } as HireAndActivateInput<TJobSpec>["hire"],
          jobSpec: input.jobSpec,
          activation: activationInput,
          creator,
          hostAndModerateJobSpec: async (host) => {
            const committed: HireAndActivateModeratingProgress = {
              phase: "moderating",
              taskPda: host.taskPda,
              hireSignature: host.hireSignature,
              hireIntentDigest: host.hireIntentDigest,
              ...(host.hireReconciled === true ? { hireReconciled: true } : {}),
            };
            setProgress(progressFromRecovery(committed, referrerInjected));

            const moderation = await input.hostAndModerateJobSpec({
              taskPda: host.taskPda,
              taskId: host.taskId,
              listing: host.listing,
              jobSpec: host.jobSpec,
              hireSignature: host.hireSignature,
              ...(host.hireReconciled === true ? { hireReconciled: true } : {}),
              referrerInjected,
            });
            const validated = validateModerationResult(
              moderation,
              input.hire.taskJobSpecHash,
            );
            const activationModerator =
              input.activation?.moderator ?? validated.moderator;
            activationRecovery = {
              phase: "activating",
              taskPda: host.taskPda,
              hireSignature: host.hireSignature,
              hireIntentDigest: host.hireIntentDigest,
              ...(host.hireReconciled === true ? { hireReconciled: true } : {}),
              ...validated,
              moderator: activationModerator,
            };
            return moderation;
          },
          onPhase: (nextPhase) => {
            setPhase(nextPhase);
            if (nextPhase === "activating" && activationRecovery !== null) {
              setProgress(
                progressFromRecovery(activationRecovery, referrerInjected),
              );
            }
          },
          ...(rpc !== null ? { rpc } : {}),
          ...(rpcUrl !== null ? { rpcUrl } : {}),
        };

        const orchestrationResult =
          recovery === null
            ? await runHireAndActivate(client, orchestration)
            : await runResumeHireAndActivate(client, orchestration, recovery);

        const result: HumanlessHireFlowResult = {
          taskPda: orchestrationResult.taskPda,
          hireSignature: orchestrationResult.hireSignature,
          activationSignature: orchestrationResult.activationSignature,
          jobSpecHash: orchestrationResult.jobSpecHash,
          jobSpecUri: orchestrationResult.jobSpecUri,
          referrerInjected,
          ...(orchestrationResult.hireReconciled === true
            ? { hireReconciled: true }
            : {}),
          ...(orchestrationResult.activationReconciled === true
            ? { activationReconciled: true }
            : {}),
          moderation: orchestrationResult.moderation,
        };

        setProgress({
          taskPda: result.taskPda,
          hireSignature: result.hireSignature || null,
          activationSignature: result.activationSignature || null,
          jobSpecHash: result.jobSpecHash,
          jobSpecUri: result.jobSpecUri,
          referrerInjected,
          recovery: null,
        });
        setPhase("activated");
        return result;
      } catch (error) {
        if (error instanceof HireAndActivateError) {
          setProgress(progressFromRecovery(error.progress, referrerInjected));
        } else if (error instanceof HireAndActivateFinalizedFailure) {
          // The exact candidate transaction failed atomically and the SDK
          // proved no hire accounts exist. Discard the non-resubmitting token;
          // the surfaced retrySafe error explicitly permits a corrected retry.
          setProgress({ ...emptyProgress(), referrerInjected });
        }
        setPhase("error");
        throw error;
      }
    },
  });

  const hireAndActivate = useCallback(
    async (input: HumanlessHireFlowInput<TJobSpec>) => {
      if (flowInFlight.current) {
        throw new Error("A humanless hire flow is already in progress.");
      }
      flowInFlight.current = true;
      try {
        const client = requireClient(ctx.client);
        const snapshot = snapshotFlowInput(input, client.signer);
        return await mutation.mutateAsync({
          ...snapshot,
          recovery: null,
          client,
          rpc: ctx.orchestrationRpc,
          rpcUrl: ctx.orchestrationRpcUrl,
          referral: resolveReferrerArgs(ctx),
        });
      } finally {
        flowInFlight.current = false;
      }
    },
    [ctx, mutation],
  );

  const resumeHireAndActivate = useCallback(
    async (
      input: HumanlessHireFlowInput<TJobSpec>,
      recovery: HireAndActivateProgress,
    ) => {
      if (flowInFlight.current) {
        throw new Error("A humanless hire flow is already in progress.");
      }
      flowInFlight.current = true;
      try {
        const client = requireClient(ctx.client);
        const snapshot = snapshotFlowInput(input, client.signer);
        return await mutation.mutateAsync({
          ...snapshot,
          recovery: snapshotRecovery(recovery),
          client,
          rpc: ctx.orchestrationRpc,
          rpcUrl: ctx.orchestrationRpcUrl,
          referral: resolveReferrerArgs(ctx),
        });
      } finally {
        flowInFlight.current = false;
      }
    },
    [ctx, mutation],
  );

  const reset = useCallback(() => {
    mutation.reset();
    setPhase("idle");
    setProgress(emptyProgress());
  }, [mutation]);

  return {
    hireAndActivate,
    resumeHireAndActivate,
    phase,
    status: mutationStatusOf(mutation),
    progress,
    result: mutation.data ?? null,
    error: mutation.error ?? null,
    isPending: mutation.isPending,
    reset,
  };
}
