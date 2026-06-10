/**
 * `useDispute(taskPda)` — dispute entry point + state for one task.
 *
 * Reads the task's `Dispute` account (via an injected reader seam — same reason
 * as `useTaskStatus`: the unified read transport has no raw account fetch and
 * litesvm has no RPC) and exposes `initiate(...)` which opens a dispute through
 * the write client (`client.initiateDispute`). Typed `AgencError`s surface
 * UNTOUCHED.
 *
 * @module hooks/useDispute
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  type Dispute,
  type facade as facadeNs,
} from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import type { Address } from "../types.js";
import { pdaKey, queryKeys, requireClient } from "./internal.js";

/** Reads a Dispute account for a task, returning the decoded value or null. */
export type DisputeReader = (
  taskPda: Address | string,
) => Promise<Dispute | null>;

/**
 * Per-call input for `initiate(...)`. This is the SDK `facade.initiateDispute`
 * input minus the fee-payer `authority` signer (defaulted to the client's
 * signer; pass it to override). `task` is bound at hook construction.
 */
export type InitiateDisputeInput = Omit<
  Parameters<typeof facadeNs.initiateDispute>[0],
  "task" | "authority"
> & {
  /** Override the initiator authority signer (defaults to the client signer). */
  authority?: Parameters<typeof facadeNs.initiateDispute>[0]["authority"];
};

/** Lifecycle status of the initiate mutation. */
export type DisputeStatus = "idle" | "pending" | "success" | "error";

/** Options for {@link useDispute}. */
export interface UseDisputeOptions {
  /** How to read the Dispute account. Without it the read stays idle. */
  disputeReader?: DisputeReader;
  /** Disable the read query. Default `true` when `taskPda` + reader exist. */
  enabled?: boolean;
}

/** Return value of {@link useDispute}. */
export interface UseDisputeResult {
  /** The decoded dispute, or null (none open / not yet read). */
  dispute: Dispute | null;
  /** Open a dispute. Resolves to the tx signature; rejects with `AgencError`. */
  initiate: (input: InitiateDisputeInput) => Promise<string>;
  /** Status of the initiate mutation. */
  status: DisputeStatus;
  /** Signature of the last successful initiate, or null. */
  signature: string | null;
  /** The read OR initiate error, or null. */
  error: Error | null;
  /** True while reading the dispute. */
  isLoading: boolean;
  /** Force a dispute refetch. */
  refetch: () => void;
  /** Reset the initiate mutation. */
  reset: () => void;
}

/**
 * Dispute entry + state for one task.
 *
 * @param taskPda - The Task PDA (falsy disables the read).
 * @param options - Reader + enabled.
 * @returns {@link UseDisputeResult}.
 */
export function useDispute(
  taskPda: Address | string | undefined | null,
  options?: UseDisputeOptions,
): UseDisputeResult {
  const ctx = useAgencContext();
  const reader = options?.disputeReader;
  const enabled =
    (options?.enabled ?? true) && Boolean(taskPda) && Boolean(reader);

  const read = useQuery<Dispute | null, Error>({
    queryKey: queryKeys.dispute(taskPda ? pdaKey(taskPda) : ""),
    enabled,
    queryFn: () => reader!(taskPda as Address | string),
  });

  const mutation = useMutation<string, Error, InitiateDisputeInput>({
    mutationFn: async (input) => {
      const client = requireClient(ctx.client);
      const { signature } = await client.initiateDispute({
        ...input,
        task: taskPda as Address,
        authority: input.authority ?? client.signer,
      } as Parameters<typeof facadeNs.initiateDispute>[0]);
      // A new dispute exists — refresh the read.
      void read.refetch();
      return signature;
    },
  });

  const initiate = useCallback(
    (input: InitiateDisputeInput) => mutation.mutateAsync(input),
    [mutation],
  );

  const status: DisputeStatus = mutation.isPending
    ? "pending"
    : mutation.isError
      ? "error"
      : mutation.isSuccess
        ? "success"
        : "idle";

  return {
    dispute: read.data ?? null,
    initiate,
    status,
    signature: mutation.data ?? null,
    error: mutation.error ?? read.error ?? null,
    isLoading: read.isLoading,
    refetch: () => void read.refetch(),
    reset: mutation.reset,
  };
}
