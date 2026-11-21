/**
 * `useSubmissionReview(taskPda)` — buyer-side settlement actions.
 *
 * Exposes the creator review verbs for a task in `PendingValidation`:
 * - `accept(...)` — accept the result and settle the escrow to the worker
 *   (`client.acceptTaskResult`, a named client convenience);
 * - `turnDown(...)`: turn the delivery down on a single-worker review task
 *   (`facade.rejectAndFreeze` -> `client.send`). The price stays held. Since
 *   revision 9 the worker may dispute it within 72 hours with a bond; with no
 *   dispute the buyer is refunded when that time ends;
 * - `reject(...)` — reject the result with a rejection hash
 *   (`facade.rejectTaskResult` -> `client.send`). Revision 9 refuses it on a
 *   single-worker review task (6418); it stays for Collaborative and contest
 *   tasks;
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
import type { MarketplaceClient } from "../types.js";
import {
  requireClient,
  snapshotFixedBytes32,
  snapshotRecord,
  stabilizeSelectedTransactionSigner,
} from "./internal.js";

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

/** Per-call input for `turnDown` (pass the claim's worker agent as `worker`). */
export type TurnDownInput = Omit<
  Parameters<typeof facadeNs.rejectAndFreeze>[0],
  "task" | "creator"
> & {
  creator?: Parameters<typeof facadeNs.rejectAndFreeze>[0]["creator"];
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

interface QueuedReviewInput<TInput> {
  readonly client: MarketplaceClient;
  readonly input: TInput;
}

/** A single review verb's surface. */
export interface ReviewAction<TInput> {
  /** Run the action. Resolves to the tx signature; rejects with `AgencError`. */
  (input: TInput): Promise<string>;
}

/** Return value of {@link useSubmissionReview}. */
export interface UseSubmissionReviewResult {
  /** Accept the result and settle to the worker. */
  accept: ReviewAction<AcceptInput>;
  /**
   * Turn the delivery down on a single-worker review task (a freeze the
   * worker may dispute within 72 hours; the buyer is refunded if it does not).
   */
  turnDown: ReviewAction<TurnDownInput>;
  /** Reject the result (Collaborative and contest tasks; refused on single-worker review tasks). */
  reject: ReviewAction<RejectInput>;
  /** Request changes (with a changes hash), returning the task to the worker. */
  requestChanges: ReviewAction<RequestChangesInput>;
  /** Aggregate status: `pending` if any verb is in flight, else last settled. */
  status: ReviewStatus;
  /** The most recent error across the verbs, or null. */
  error: Error | null;
  /** Signature of the last successful action, or null. */
  signature: string | null;
  /** Reset every verb to idle. */
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
  const lastAction = useRef<
    "accept" | "turnDown" | "reject" | "requestChanges" | null
  >(null);

  const acceptMut = useMutation<string, Error, QueuedReviewInput<AcceptInput>>({
    mutationFn: async ({ client, input }) => {
      const { signature } = await client.acceptTaskResult({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.acceptTaskResult>[0]);
      return signature;
    },
  });

  const rejectMut = useMutation<string, Error, QueuedReviewInput<RejectInput>>({
    mutationFn: async ({ client, input }) => {
      const ix = await facade.rejectTaskResult({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.rejectTaskResult>[0]);
      const { signature } = await client.send([ix]);
      return signature;
    },
  });

  const turnDownMut = useMutation<
    string,
    Error,
    QueuedReviewInput<TurnDownInput>
  >({
    mutationFn: async ({ client, input }) => {
      const ix = await facade.rejectAndFreeze({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.rejectAndFreeze>[0]);
      const { signature } = await client.send([ix]);
      return signature;
    },
  });

  const requestChangesMut = useMutation<
    string,
    Error,
    QueuedReviewInput<RequestChangesInput>
  >({
    mutationFn: async ({ client, input }) => {
      const ix = await facade.requestChanges({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.requestChanges>[0]);
      const { signature } = await client.send([ix]);
      return signature;
    },
  });

  const accept = useCallback<ReviewAction<AcceptInput>>(
    async (input) => {
      const client = requireClient(ctx.client);
      const detachedInput = snapshotRecord(input);
      const creator = stabilizeSelectedTransactionSigner(
        client.signer,
        detachedInput.creator,
      );
      const snapshottedInput = snapshotRecord({
        ...detachedInput,
        creator,
        ...(detachedInput.bidSettlement === undefined
          ? {}
          : { bidSettlement: snapshotRecord(detachedInput.bidSettlement) }),
      }) as AcceptInput;
      lastAction.current = "accept";
      return acceptMut.mutateAsync({ client, input: snapshottedInput });
    },
    [acceptMut, ctx.client],
  );
  const reject = useCallback<ReviewAction<RejectInput>>(
    async (input) => {
      const client = requireClient(ctx.client);
      const detachedInput = snapshotRecord(input);
      const creator = stabilizeSelectedTransactionSigner(
        client.signer,
        detachedInput.creator,
      );
      const snapshottedInput = snapshotRecord({
        ...detachedInput,
        creator,
        rejectionHash: snapshotFixedBytes32(
          detachedInput.rejectionHash,
          "useSubmissionReview.reject: rejectionHash",
        ),
      }) as RejectInput;
      lastAction.current = "reject";
      return rejectMut.mutateAsync({ client, input: snapshottedInput });
    },
    [ctx.client, rejectMut],
  );
  const turnDown = useCallback<ReviewAction<TurnDownInput>>(
    async (input) => {
      const client = requireClient(ctx.client);
      const detachedInput = snapshotRecord(input);
      const creator = stabilizeSelectedTransactionSigner(
        client.signer,
        detachedInput.creator,
      );
      const snapshottedInput = snapshotRecord({
        ...detachedInput,
        creator,
        rejectionHash: snapshotFixedBytes32(
          detachedInput.rejectionHash,
          "useSubmissionReview.turnDown: rejectionHash",
        ),
      }) as TurnDownInput;
      lastAction.current = "turnDown";
      return turnDownMut.mutateAsync({ client, input: snapshottedInput });
    },
    [ctx.client, turnDownMut],
  );
  const requestChanges = useCallback<ReviewAction<RequestChangesInput>>(
    async (input) => {
      const client = requireClient(ctx.client);
      const detachedInput = snapshotRecord(input);
      const creator = stabilizeSelectedTransactionSigner(
        client.signer,
        detachedInput.creator,
      );
      const snapshottedInput = snapshotRecord({
        ...detachedInput,
        creator,
        changesHash: snapshotFixedBytes32(
          detachedInput.changesHash,
          "useSubmissionReview.requestChanges: changesHash",
        ),
      }) as RequestChangesInput;
      lastAction.current = "requestChanges";
      return requestChangesMut.mutateAsync({
        client,
        input: snapshottedInput,
      });
    },
    [ctx.client, requestChangesMut],
  );

  const anyPending =
    acceptMut.isPending ||
    turnDownMut.isPending ||
    rejectMut.isPending ||
    requestChangesMut.isPending;
  const latest =
    lastAction.current === "turnDown"
      ? turnDownMut
      : lastAction.current === "reject"
        ? rejectMut
        : lastAction.current === "requestChanges"
          ? requestChangesMut
          : acceptMut;
  const status: ReviewStatus = anyPending ? "pending" : statusOf(latest);

  const error = latest.error ?? null;
  const signature = latest.data ?? null;

  return {
    accept,
    turnDown,
    reject,
    requestChanges,
    status,
    error,
    signature,
    reset: () => {
      lastAction.current = null;
      acceptMut.reset();
      turnDownMut.reset();
      rejectMut.reset();
      requestChangesMut.reset();
    },
  };
}
