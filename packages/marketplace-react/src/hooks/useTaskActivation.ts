import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import {
  mutationStatusOf,
  requireClient,
  type MutationStatus,
} from "./internal.js";
import { resolveActivationModerationAttestor } from "./moderation-attestor.js";

export type TaskActivationInput = Omit<
  Parameters<typeof facadeNs.setTaskJobSpec>[0],
  "task" | "creator"
> & {
  creator?: Parameters<typeof facadeNs.setTaskJobSpec>[0]["creator"];
};

export type TaskActivationStatus = MutationStatus;

export interface UseTaskActivationResult {
  activate: (input: TaskActivationInput) => Promise<string>;
  status: TaskActivationStatus;
  signature: string | null;
  error: Error | null;
  isPending: boolean;
  reset: () => void;
}

export function useTaskActivation(
  taskPda: Parameters<typeof facadeNs.setTaskJobSpec>[0]["task"],
): UseTaskActivationResult {
  const ctx = useAgencContext();
  const mutation = useMutation<string, Error, TaskActivationInput>({
    mutationFn: async (input) => {
      const client = requireClient(ctx.client);
      // WP-A1: when the task moderation was authored by a roster attestor
      // (not the global authority), the publish gate only unlocks if the
      // attestor's roster-entry PDA is attached. Resolve it automatically
      // unless the caller supplied one.
      const moderationAttestor =
        input.moderationAttestor ??
        (await resolveActivationModerationAttestor({
          rpcUrl: ctx.rpcUrl,
          task: taskPda,
          jobSpecHash: input.jobSpecHash,
        }));
      const { signature } = await client.setTaskJobSpec({
        ...input,
        ...(moderationAttestor !== undefined ? { moderationAttestor } : {}),
        task: taskPda,
        creator: input.creator ?? client.signer,
      } as Parameters<typeof facadeNs.setTaskJobSpec>[0]);
      return signature;
    },
  });

  const activate = useCallback(
    (input: TaskActivationInput) => mutation.mutateAsync(input),
    [mutation],
  );

  return {
    activate,
    status: mutationStatusOf(mutation),
    signature: mutation.data ?? null,
    error: mutation.error ?? null,
    isPending: mutation.isPending,
    reset: mutation.reset,
  };
}
