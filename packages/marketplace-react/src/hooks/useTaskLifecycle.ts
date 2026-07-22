import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import type { MarketplaceClient } from "../types.js";
import {
  mutationStatusOf,
  requireClient,
  snapshotRecord,
  snapshotRecordArray,
  stabilizeSelectedTransactionSigner,
  type MutationStatus,
} from "./internal.js";

export type CancelTaskInput = Omit<
  Parameters<typeof facadeNs.cancelTask>[0],
  "task" | "authority"
> & {
  authority?: Parameters<typeof facadeNs.cancelTask>[0]["authority"];
};
export type CloseTaskInput = Omit<
  Parameters<typeof facadeNs.closeTask>[0],
  "task" | "authority"
> & {
  authority?: Parameters<typeof facadeNs.closeTask>[0]["authority"];
};
export type AutoAcceptTaskResultInput = Omit<
  Parameters<typeof facadeNs.autoAcceptTaskResult>[0],
  "task" | "authority"
> & {
  authority?: Parameters<typeof facadeNs.autoAcceptTaskResult>[0]["authority"];
};
export type TaskLifecycleStatus = MutationStatus;

interface QueuedTaskLifecycleInput<TInput> {
  readonly client: MarketplaceClient;
  readonly input: TInput;
}

export interface UseTaskLifecycleResult {
  cancel: (input?: CancelTaskInput) => Promise<string>;
  close: (input?: CloseTaskInput) => Promise<string>;
  autoAccept: (input: AutoAcceptTaskResultInput) => Promise<string>;
  status: TaskLifecycleStatus;
  signature: string | null;
  error: Error | null;
  isPending: boolean;
  reset: () => void;
}

export function useTaskLifecycle(
  taskPda: Parameters<typeof facadeNs.cancelTask>[0]["task"],
): UseTaskLifecycleResult {
  const ctx = useAgencContext();
  const lastAction = useRef<"cancel" | "close" | "autoAccept" | null>(null);
  const cancelMut = useMutation<
    string,
    Error,
    QueuedTaskLifecycleInput<CancelTaskInput>
  >({
    mutationFn: async ({ client, input }) => {
      const { signature } = await client.cancelTask({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.cancelTask>[0]);
      return signature;
    },
  });
  const closeMut = useMutation<
    string,
    Error,
    QueuedTaskLifecycleInput<CloseTaskInput>
  >({
    mutationFn: async ({ client, input }) => {
      const { signature } = await client.closeTask({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.closeTask>[0]);
      return signature;
    },
  });
  const autoAcceptMut = useMutation<
    string,
    Error,
    QueuedTaskLifecycleInput<AutoAcceptTaskResultInput>
  >({
    mutationFn: async ({ client, input }) => {
      const { signature } = await client.autoAcceptTaskResult({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.autoAcceptTaskResult>[0]);
      return signature;
    },
  });

  const cancel = useCallback(
    async (input?: CancelTaskInput) => {
      const client = requireClient(ctx.client);
      const detachedInput = snapshotRecord(input ?? {}) as CancelTaskInput;
      const authority = stabilizeSelectedTransactionSigner(
        client.signer,
        detachedInput.authority,
      );
      const snapshottedInput = snapshotRecord({
        ...detachedInput,
        authority,
        // audit F5/F12: cancelTask requires the bond PDAs; the SDK facade derives
        // them from authority / workerBondAuthority. Default the worker wallet to
        // the task PDA itself — it can never be a bond poster (PDAs can't sign),
        // so the derived worker-bond PDA is the empty no-op account.
        workerBondAuthority: detachedInput.workerBondAuthority ?? taskPda,
        ...(detachedInput.workerAccounts === undefined
          ? {}
          : {
              workerAccounts: snapshotRecordArray(detachedInput.workerAccounts),
            }),
        ...(detachedInput.bidSettlement === undefined
          ? {}
          : { bidSettlement: snapshotRecord(detachedInput.bidSettlement) }),
      }) as CancelTaskInput;
      lastAction.current = "cancel";
      return cancelMut.mutateAsync({ client, input: snapshottedInput });
    },
    [cancelMut, ctx.client],
  );
  const close = useCallback(
    async (input?: CloseTaskInput) => {
      const client = requireClient(ctx.client);
      const detachedInput = snapshotRecord(input ?? {}) as CloseTaskInput;
      const authority = stabilizeSelectedTransactionSigner(
        client.signer,
        detachedInput.authority,
      );
      const snapshottedInput = snapshotRecord({
        ...detachedInput,
        authority,
        ...(detachedInput.children === undefined
          ? {}
          : { children: snapshotRecordArray(detachedInput.children) }),
      }) as CloseTaskInput;
      lastAction.current = "close";
      return closeMut.mutateAsync({ client, input: snapshottedInput });
    },
    [closeMut, ctx.client],
  );
  const autoAccept = useCallback(
    async (input: AutoAcceptTaskResultInput) => {
      const client = requireClient(ctx.client);
      const detachedInput = snapshotRecord(input);
      const authority = stabilizeSelectedTransactionSigner(
        client.signer,
        detachedInput.authority,
      );
      const snapshottedInput = snapshotRecord({
        ...detachedInput,
        authority,
        ...(detachedInput.bidSettlement === undefined
          ? {}
          : { bidSettlement: snapshotRecord(detachedInput.bidSettlement) }),
      }) as AutoAcceptTaskResultInput;
      lastAction.current = "autoAccept";
      return autoAcceptMut.mutateAsync({ client, input: snapshottedInput });
    },
    [autoAcceptMut, ctx.client],
  );
  const active =
    cancelMut.isPending || closeMut.isPending || autoAcceptMut.isPending;
  const latest =
    lastAction.current === "close"
      ? closeMut
      : lastAction.current === "autoAccept"
        ? autoAcceptMut
        : cancelMut;

  return {
    cancel,
    close,
    autoAccept,
    status: active ? "pending" : mutationStatusOf(latest),
    signature: latest.data ?? null,
    error: latest.error ?? null,
    isPending: active,
    reset: () => {
      lastAction.current = null;
      cancelMut.reset();
      closeMut.reset();
      autoAcceptMut.reset();
    },
  };
}
