import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { findTaskPda } from "@tetsuo-ai/marketplace-sdk";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import type { Address } from "../types.js";
import {
  mutationStatusOf,
  requireClient,
  resolveReferrerArgs,
  signerAddress,
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
  "humanless" | "creator" | "referrer" | "referrerFeeBps"
>;

export type HumanlessHireFlowActivationInput = Omit<
  TaskActivationInput,
  "creator" | "jobSpecHash" | "jobSpecUri"
>;

export type HumanlessHireFlowCreator = HumanlessHireInput["creator"];

export type HumanlessHireFlowJobSpecHash =
  Parameters<typeof facadeNs.setTaskJobSpec>[0]["jobSpecHash"];

export interface HumanlessHireFlowModerationResult {
  jobSpecHash: HumanlessHireFlowJobSpecHash;
  jobSpecUri: string;
  moderationAttested: boolean;
  moderation?: unknown;
}

export interface HumanlessHireFlowHostInput<TJobSpec> {
  taskPda: Address;
  taskId: HumanlessHireFlowHireInput["taskId"];
  listing: HumanlessHireFlowHireInput["listing"];
  jobSpec: TJobSpec;
  hireSignature: string;
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
}

export interface HumanlessHireFlowResult {
  taskPda: Address;
  hireSignature: string;
  activationSignature: string;
  jobSpecHash: HumanlessHireFlowJobSpecHash;
  jobSpecUri: string;
  referrerInjected: boolean;
  moderation?: unknown;
}

export interface UseHumanlessHireFlowResult<TJobSpec = unknown> {
  hireAndActivate: (
    input: HumanlessHireFlowInput<TJobSpec>,
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
  };
}

function validateModerationResult(
  result: HumanlessHireFlowModerationResult,
): { jobSpecHash: HumanlessHireFlowJobSpecHash; jobSpecUri: string } {
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
  return { jobSpecHash: result.jobSpecHash, jobSpecUri };
}

export function useHumanlessHireFlow<TJobSpec = unknown>(): UseHumanlessHireFlowResult<TJobSpec> {
  const ctx = useAgencContext();
  const [phase, setPhase] = useState<HumanlessHireFlowPhase>("idle");
  const [progress, setProgress] =
    useState<HumanlessHireFlowProgress>(emptyProgress);
  const flowInFlight = useRef(false);

  const mutation = useMutation<
    HumanlessHireFlowResult,
    Error,
    HumanlessHireFlowInput<TJobSpec>
  >({
    mutationFn: async (input) => {
      const client = requireClient(ctx.client);
      const creator = input.creator ?? client.signer;
      const { referrerArgs, referrerInjected } = resolveReferrerArgs(ctx);
      const hireInput = withoutReferrerArgs(input.hire);

      setPhase("hiring");
      setProgress(emptyProgress());

      try {
        const hireResult = await client.hireFromListingHumanless({
          ...hireInput,
          creator,
          ...referrerArgs,
        } as Parameters<typeof facadeNs.hireFromListingHumanless>[0]);

        const [taskPda] = await findTaskPda({
          creator: signerAddress(creator),
          taskId: input.hire.taskId,
        });

        setProgress({
          ...emptyProgress(),
          taskPda,
          hireSignature: hireResult.signature,
          referrerInjected,
        });

        setPhase("moderating");
        const moderation = await input.hostAndModerateJobSpec({
          taskPda,
          taskId: input.hire.taskId,
          listing: input.hire.listing,
          jobSpec: input.jobSpec,
          hireSignature: hireResult.signature,
          referrerInjected,
        });
        const { jobSpecHash, jobSpecUri } = validateModerationResult(moderation);

        setProgress((current) => ({
          ...current,
          jobSpecHash,
          jobSpecUri,
        }));

        setPhase("activating");
        const activationResult = await client.setTaskJobSpec({
          ...(input.activation ?? {}),
          task: taskPda,
          creator,
          jobSpecHash,
          jobSpecUri,
        } as Parameters<typeof facadeNs.setTaskJobSpec>[0]);

        const result: HumanlessHireFlowResult = {
          taskPda,
          hireSignature: hireResult.signature,
          activationSignature: activationResult.signature,
          jobSpecHash,
          jobSpecUri,
          referrerInjected,
          moderation: moderation.moderation,
        };

        setProgress((current) => ({
          ...current,
          activationSignature: activationResult.signature,
        }));
        setPhase("activated");
        return result;
      } catch (error) {
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
        return await mutation.mutateAsync(input);
      } finally {
        flowInFlight.current = false;
      }
    },
    [mutation],
  );

  const reset = useCallback(() => {
    mutation.reset();
    setPhase("idle");
    setProgress(emptyProgress());
  }, [mutation]);

  return {
    hireAndActivate,
    phase,
    status: mutationStatusOf(mutation),
    progress,
    result: mutation.data ?? null,
    error: mutation.error ?? null,
    isPending: mutation.isPending,
    reset,
  };
}
