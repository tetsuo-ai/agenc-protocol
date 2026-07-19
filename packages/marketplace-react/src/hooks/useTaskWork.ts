import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import {
  mutationStatusOf,
  requireClient,
  type MutationStatus,
} from "./internal.js";

export type ClaimTaskInput = Omit<
  Parameters<typeof facadeNs.claimTaskWithJobSpec>[0],
  "task"
>;
export type SubmitTaskResultInput = Omit<
  Parameters<typeof facadeNs.submitTaskResult>[0],
  "task"
>;
export type TaskWorkStatus = MutationStatus;

export interface UseTaskWorkResult {
  claim: (input: ClaimTaskInput) => Promise<string>;
  submit: (input: SubmitTaskResultInput) => Promise<string>;
  status: TaskWorkStatus;
  signature: string | null;
  error: Error | null;
  isPending: boolean;
  reset: () => void;
}

export function useTaskWork(
  taskPda: Parameters<typeof facadeNs.claimTaskWithJobSpec>[0]["task"],
): UseTaskWorkResult {
  const ctx = useAgencContext();
  const lastAction = useRef<"claim" | "submit" | null>(null);
  const claimMut = useMutation<string, Error, ClaimTaskInput>({
    mutationFn: async (input) => {
      const client = requireClient(ctx.client);
      const { signature } = await client.claimTaskWithJobSpec({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.claimTaskWithJobSpec>[0]);
      return signature;
    },
  });
  const submitMut = useMutation<string, Error, SubmitTaskResultInput>({
    mutationFn: async (input) => {
      const client = requireClient(ctx.client);
      const { signature } = await client.submitTaskResult({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.submitTaskResult>[0]);
      return signature;
    },
  });

  const claim = useCallback((input: ClaimTaskInput) => {
    lastAction.current = "claim";
    return claimMut.mutateAsync(input);
  }, [claimMut]);
  const submit = useCallback(
    (input: SubmitTaskResultInput) => {
      lastAction.current = "submit";
      return submitMut.mutateAsync(input);
    },
    [submitMut],
  );
  const active = claimMut.isPending || submitMut.isPending;
  const latest = lastAction.current === "submit" ? submitMut : claimMut;

  return {
    claim,
    submit,
    status: active ? "pending" : mutationStatusOf(latest),
    signature: latest.data ?? null,
    error: latest.error ?? null,
    isPending: active,
    reset: () => {
      lastAction.current = null;
      claimMut.reset();
      submitMut.reset();
    },
  };
}
