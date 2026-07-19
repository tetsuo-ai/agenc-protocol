import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import {
  mutationStatusOf,
  requireClient,
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
  const cancelMut = useMutation<string, Error, CancelTaskInput | undefined>({
    mutationFn: async (input) => {
      const client = requireClient(ctx.client);
      const { signature } = await client.cancelTask({
        ...(input ?? {}),
        task: taskPda,
        authority: input?.authority ?? client.signer,
        // audit F5/F12: cancelTask requires the bond PDAs; the SDK facade derives
        // them from authority / workerBondAuthority. Default the worker wallet to
        // the task PDA itself — it can never be a bond poster (PDAs can't sign),
        // so the derived worker-bond PDA is the empty no-op account.
        workerBondAuthority: input?.workerBondAuthority ?? taskPda,
      } as Parameters<typeof facadeNs.cancelTask>[0]);
      return signature;
    },
  });
  const closeMut = useMutation<string, Error, CloseTaskInput | undefined>({
    mutationFn: async (input) => {
      const client = requireClient(ctx.client);
      const { signature } = await client.closeTask({
        ...(input ?? {}),
        task: taskPda,
        authority: input?.authority ?? client.signer,
      } as Parameters<typeof facadeNs.closeTask>[0]);
      return signature;
    },
  });
  const autoAcceptMut = useMutation<string, Error, AutoAcceptTaskResultInput>({
    mutationFn: async (input) => {
      const client = requireClient(ctx.client);
      const { signature } = await client.autoAcceptTaskResult({
        ...input,
        task: taskPda,
        authority: input.authority ?? client.signer,
      } as Parameters<typeof facadeNs.autoAcceptTaskResult>[0]);
      return signature;
    },
  });

  const cancel = useCallback(
    (input?: CancelTaskInput) => {
      lastAction.current = "cancel";
      return cancelMut.mutateAsync(input);
    },
    [cancelMut],
  );
  const close = useCallback(
    (input?: CloseTaskInput) => {
      lastAction.current = "close";
      return closeMut.mutateAsync(input);
    },
    [closeMut],
  );
  const autoAccept = useCallback(
    (input: AutoAcceptTaskResultInput) => {
      lastAction.current = "autoAccept";
      return autoAcceptMut.mutateAsync(input);
    },
    [autoAcceptMut],
  );
  const active = cancelMut.isPending || closeMut.isPending || autoAcceptMut.isPending;
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
