import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import {
  mutationStatusOf,
  requireClient,
  type MutationStatus,
} from "./internal.js";

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
      const { signature } = await client.setTaskJobSpec({
        ...input,
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
