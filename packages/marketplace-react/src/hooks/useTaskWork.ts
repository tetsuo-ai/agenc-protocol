import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import type { MarketplaceClient } from "../types.js";
import {
  mutationStatusOf,
  requireClient,
  snapshotFixedBytes32,
  snapshotOptionalFixedBytes,
  snapshotRecord,
  stabilizeSelectedTransactionSigner,
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

interface QueuedTaskWorkInput<TInput> {
  readonly client: MarketplaceClient;
  readonly input: TInput;
}

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
  const claimMut = useMutation<
    string,
    Error,
    QueuedTaskWorkInput<ClaimTaskInput>
  >({
    mutationFn: async ({ client, input }) => {
      const { signature } = await client.claimTaskWithJobSpec({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.claimTaskWithJobSpec>[0]);
      return signature;
    },
  });
  const submitMut = useMutation<
    string,
    Error,
    QueuedTaskWorkInput<SubmitTaskResultInput>
  >({
    mutationFn: async ({ client, input }) => {
      const { signature } = await client.submitTaskResult({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.submitTaskResult>[0]);
      return signature;
    },
  });

  const claim = useCallback(
    async (input: ClaimTaskInput) => {
      const client = requireClient(ctx.client);
      const detachedInput = snapshotRecord(input);
      const authority = stabilizeSelectedTransactionSigner(
        client.signer,
        detachedInput.authority,
      );
      const snapshottedInput = snapshotRecord({
        ...detachedInput,
        authority,
        ...(detachedInput.jobSpecHash === undefined
          ? {}
          : {
              jobSpecHash: snapshotFixedBytes32(
                detachedInput.jobSpecHash,
                "useTaskWork.claim: jobSpecHash",
              ),
            }),
      }) as ClaimTaskInput;
      lastAction.current = "claim";
      return claimMut.mutateAsync({ client, input: snapshottedInput });
    },
    [claimMut, ctx.client],
  );
  const submit = useCallback(
    async (input: SubmitTaskResultInput) => {
      const client = requireClient(ctx.client);
      const detachedInput = snapshotRecord(input);
      const authority = stabilizeSelectedTransactionSigner(
        client.signer,
        detachedInput.authority,
      );
      const snapshottedInput = snapshotRecord({
        ...detachedInput,
        authority,
        proofHash: snapshotFixedBytes32(
          detachedInput.proofHash,
          "useTaskWork.submit: proofHash",
        ),
        resultData: snapshotOptionalFixedBytes(
          detachedInput.resultData,
          64,
          "useTaskWork.submit: resultData",
        ),
      }) as SubmitTaskResultInput;
      lastAction.current = "submit";
      return submitMut.mutateAsync({ client, input: snapshottedInput });
    },
    [ctx.client, submitMut],
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
