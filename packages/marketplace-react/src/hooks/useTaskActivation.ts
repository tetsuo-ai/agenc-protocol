import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import {
  mutationStatusOf,
  requireClient,
  snapshotFixedBytes32,
  stabilizeSelectedTransactionSigner,
  type MutationStatus,
} from "./internal.js";
import { resolveActivationModerationAccounts } from "./moderation-attestor.js";

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

interface TaskActivationMutationVariables {
  client: ReturnType<typeof requireClient>;
  input: TaskActivationInput;
  taskPda: Parameters<typeof facadeNs.setTaskJobSpec>[0]["task"];
  creator: Parameters<typeof facadeNs.setTaskJobSpec>[0]["creator"];
  orchestrationRpcUrl: ReturnType<
    typeof useAgencContext
  >["orchestrationRpcUrl"];
  orchestrationRpc: ReturnType<typeof useAgencContext>["orchestrationRpc"];
}

export function useTaskActivation(
  taskPda: Parameters<typeof facadeNs.setTaskJobSpec>[0]["task"],
): UseTaskActivationResult {
  const ctx = useAgencContext();
  const mutation = useMutation<string, Error, TaskActivationMutationVariables>({
    mutationFn: async ({
      client,
      input,
      taskPda: snapshottedTaskPda,
      creator,
      orchestrationRpcUrl,
      orchestrationRpc,
    }) => {
      // P1.2: the publish gate names an explicit `moderator` (supplied by the
      // caller — the trust decision) and needs the roster-entry PDA when that
      // moderator is a registered attestor, plus a record override when the
      // attestation predates the upgrade (legacy grace window). Resolve the
      // mechanics automatically unless the caller supplied any of them.
      const callerResolved =
        input.moderationAttestor !== undefined ||
        input.moderatorIsAttestor !== undefined ||
        input.taskModeration !== undefined;
      const resolved = callerResolved
        ? {}
        : await resolveActivationModerationAccounts({
            rpcUrl: orchestrationRpcUrl,
            ...(orchestrationRpc === null ? {} : { rpc: orchestrationRpc }),
            task: snapshottedTaskPda,
            jobSpecHash: input.jobSpecHash,
            moderator: input.moderator,
          });
      const { signature } = await client.setTaskJobSpec({
        ...input,
        ...resolved,
        task: snapshottedTaskPda,
        creator,
      } as Parameters<typeof facadeNs.setTaskJobSpec>[0]);
      return signature;
    },
  });

  const activate = useCallback(
    async (input: TaskActivationInput) => {
      const client = requireClient(ctx.client);
      const detachedInput = { ...input };
      const snapshottedInput = {
        ...detachedInput,
        jobSpecHash: snapshotFixedBytes32(
          detachedInput.jobSpecHash,
          "useTaskActivation: jobSpecHash",
        ),
      };
      const creator = stabilizeSelectedTransactionSigner(
        client.signer,
        detachedInput.creator,
      );
      return mutation.mutateAsync({
        client,
        input: snapshottedInput,
        taskPda,
        creator,
        orchestrationRpcUrl: ctx.orchestrationRpcUrl,
        orchestrationRpc: ctx.orchestrationRpc,
      });
    },
    [ctx, mutation],
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
