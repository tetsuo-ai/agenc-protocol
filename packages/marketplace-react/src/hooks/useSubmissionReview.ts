/**
 * `useSubmissionReview(taskPda)` — buyer-side settlement actions.
 *
 * Exposes the three creator review verbs for a task in `PendingValidation`:
 * - `accept(...)` — accept the result and settle the escrow to the worker
 *   (`client.acceptTaskResult`, a named client convenience);
 * - `reject(...)` — reject the result with a rejection hash
 *   (`facade.rejectTaskResult` -> `client.send`);
 * - `requestChanges(...)` — return the task to the worker with a changes hash
 *   (`facade.requestChanges` -> `client.send`).
 *
 * Each verb is its own mutation so a UI can show independent
 * pending/error/success per button. Typed `AgencError`s surface UNTOUCHED.
 *
 * The `task` PDA is bound at hook construction; callers pass only the per-call
 * settlement parties (worker / treasury / hashes) the SDK cannot derive.
 *
 * @module hooks/useSubmissionReview
 */
import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { facade, type facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import { requireClient } from "./internal.js";

/** Per-call input for `accept` (task auto-bound; signer defaults to the client). */
export type AcceptInput = Omit<
  Parameters<typeof facadeNs.acceptTaskResult>[0],
  "task" | "creator"
> & {
  creator?: Parameters<typeof facadeNs.acceptTaskResult>[0]["creator"];
};

/** Per-call input for `reject`. */
export type RejectInput = Omit<
  Parameters<typeof facadeNs.rejectTaskResult>[0],
  "task" | "creator"
> & {
  creator?: Parameters<typeof facadeNs.rejectTaskResult>[0]["creator"];
};

/** Per-call input for `requestChanges`. */
export type RequestChangesInput = Omit<
  Parameters<typeof facadeNs.requestChanges>[0],
  "task" | "creator"
> & {
  creator?: Parameters<typeof facadeNs.requestChanges>[0]["creator"];
};

/** Lifecycle status of a review verb. */
export type ReviewStatus = "idle" | "pending" | "success" | "error";

/** A single review verb's surface. */
export interface ReviewAction<TInput> {
  /** Run the action. Resolves to the tx signature; rejects with `AgencError`. */
  (input: TInput): Promise<string>;
}

/** Return value of {@link useSubmissionReview}. */
export interface UseSubmissionReviewResult {
  /** Accept the result and settle to the worker. */
  accept: ReviewAction<AcceptInput>;
  /** Reject the result (with a rejection hash). */
  reject: ReviewAction<RejectInput>;
  /** Request changes (with a changes hash), returning the task to the worker. */
  requestChanges: ReviewAction<RequestChangesInput>;
  /** Aggregate status: `pending` if any verb is in flight, else last settled. */
  status: ReviewStatus;
  /** The most recent error across the three verbs, or null. */
  error: Error | null;
  /** Signature of the last successful action, or null. */
  signature: string | null;
  /** Reset all three mutations to idle. */
  reset: () => void;
}

function statusOf(m: {
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
}): ReviewStatus {
  if (m.isPending) return "pending";
  if (m.isError) return "error";
  if (m.isSuccess) return "success";
  return "idle";
}

/**
 * Buyer-side review actions for one task.
 *
 * @param taskPda - The Task PDA under review (bound to every verb).
 * @returns {@link UseSubmissionReviewResult}.
 */
export function useSubmissionReview(
  taskPda: Parameters<typeof facadeNs.acceptTaskResult>[0]["task"],
): UseSubmissionReviewResult {
  const ctx = useAgencContext();
  const lastAction = useRef<"accept" | "reject" | "requestChanges" | null>(
    null,
  );

  const acceptMut = useMutation<string, Error, AcceptInput>({
    mutationFn: async (input) => {
      const client = requireClient(ctx.client);
      const { signature } = await client.acceptTaskResult({
        ...input,
        task: taskPda,
        creator: input.creator ?? client.signer,
      } as Parameters<typeof facadeNs.acceptTaskResult>[0]);
      return signature;
    },
  });

  const rejectMut = useMutation<string, Error, RejectInput>({
    mutationFn: async (input) => {
      const client = requireClient(ctx.client);
      const ix = await facade.rejectTaskResult({
        ...input,
        task: taskPda,
        creator: input.creator ?? client.signer,
      } as Parameters<typeof facadeNs.rejectTaskResult>[0]);
      const { signature } = await client.send([ix]);
      return signature;
    },
  });

  const requestChangesMut = useMutation<string, Error, RequestChangesInput>({
    mutationFn: async (input) => {
      const client = requireClient(ctx.client);
      const ix = await facade.requestChanges({
        ...input,
        task: taskPda,
        creator: input.creator ?? client.signer,
      } as Parameters<typeof facadeNs.requestChanges>[0]);
      const { signature } = await client.send([ix]);
      return signature;
    },
  });

  const accept = useCallback<ReviewAction<AcceptInput>>(
    (input) => {
      lastAction.current = "accept";
      return acceptMut.mutateAsync(input);
    },
    [acceptMut],
  );
  const reject = useCallback<ReviewAction<RejectInput>>(
    (input) => {
      lastAction.current = "reject";
      return rejectMut.mutateAsync(input);
    },
    [rejectMut],
  );
  const requestChanges = useCallback<ReviewAction<RequestChangesInput>>(
    (input) => {
      lastAction.current = "requestChanges";
      return requestChangesMut.mutateAsync(input);
    },
    [requestChangesMut],
  );

  const anyPending =
    acceptMut.isPending || rejectMut.isPending || requestChangesMut.isPending;
  const latest =
    lastAction.current === "reject"
      ? rejectMut
      : lastAction.current === "requestChanges"
        ? requestChangesMut
        : acceptMut;
  const status: ReviewStatus = anyPending ? "pending" : statusOf(latest);

  const error = latest.error ?? null;
  const signature = latest.data ?? null;

  return {
    accept,
    reject,
    requestChanges,
    status,
    error,
    signature,
    reset: () => {
      lastAction.current = null;
      acceptMut.reset();
      rejectMut.reset();
      requestChangesMut.reset();
    },
  };
}
