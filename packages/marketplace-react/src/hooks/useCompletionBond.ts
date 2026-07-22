/**
 * `useCompletionBond(taskPda)` — the completion-bond ("Guaranteed Hire")
 * mutations for one task.
 *
 * Two verbs over the write client, each its own mutation (independent
 * pending/error per button, like `useSubmissionReview`):
 * - `post(...)` — post a completion bond (`client.postCompletionBond`). The
 *   bond PDA is auto-derived from (task, signing wallet); size is fixed
 *   on-chain at 25% of the reward (`BOND_BPS`), SOL-only in v1. A worker
 *   posting the role-1 bond is what makes the task read as GUARANTEED.
 * - `reclaim(...)` — the recovery crank (`client.reclaimCompletionBond`) for a
 *   bond a settlement left live; refunds to the recorded posting wallet.
 *
 * A successful verb invalidates the task's `useTaskGuarantee` cache entry so
 * badges refresh without manual wiring. Typed `AgencError`s surface UNTOUCHED.
 *
 * HONEST BOUNDARY (phase 1 — do not overclaim in UI copy): a FORFEITED bond
 * pays the protocol **treasury**, not the harmed party; the buyer's protection
 * is the escrow refund plus the worker's skin in the game. Phase 2 (batch-2
 * program work) redirects forfeiture to the harmed party.
 *
 * @module hooks/useCompletionBond
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import type { MarketplaceClient } from "../types.js";
import {
  mutationStatusOf,
  pdaKey,
  queryKeys,
  requireClient,
  snapshotRecord,
  stabilizeSelectedTransactionSigner,
  type MutationStatus,
} from "./internal.js";

/**
 * Per-call input for `post` (task auto-bound; the bonding `authority` signer
 * defaults to the client's signer). `role` stays explicit: 1 = worker (the
 * guarantee), 0 = creator.
 */
export type PostCompletionBondInput = Omit<
  Parameters<typeof facadeNs.postCompletionBond>[0],
  "task" | "authority"
> & {
  /** Override the bonding authority signer (defaults to the client signer). */
  authority?: Parameters<typeof facadeNs.postCompletionBond>[0]["authority"];
};

/**
 * Per-call input for `reclaim` (task auto-bound; `party` — the posting wallet
 * the refund returns to — defaults to the client signer's address). The
 * instruction is a permissionless crank, so any fee payer may run it.
 */
export type ReclaimCompletionBondInput = Omit<
  Parameters<typeof facadeNs.reclaimCompletionBond>[0],
  "task" | "party"
> & {
  /** Override the bond's posting wallet (defaults to the client signer). */
  party?: Parameters<typeof facadeNs.reclaimCompletionBond>[0]["party"];
};

/** Lifecycle status of a bond verb. */
export type CompletionBondStatus = MutationStatus;

interface QueuedCompletionBondInput<TInput> {
  readonly client: MarketplaceClient;
  readonly input: TInput;
}

/** Return value of {@link useCompletionBond}. */
export interface UseCompletionBondResult {
  /** Post a bond. Resolves to the tx signature; rejects with `AgencError`. */
  post: (input: PostCompletionBondInput) => Promise<string>;
  /** Reclaim a settled-but-live bond. Resolves to the tx signature. */
  reclaim: (input: ReclaimCompletionBondInput) => Promise<string>;
  /** Aggregate status: `pending` if either verb is in flight, else last settled. */
  status: CompletionBondStatus;
  /** The most recent error across the two verbs, or null. */
  error: Error | null;
  /** Signature of the last successful action, or null. */
  signature: string | null;
  /** True while either verb is in flight. */
  isPending: boolean;
  /** Reset both mutations to idle. */
  reset: () => void;
}

/**
 * Completion-bond actions for one task.
 *
 * @param taskPda - The Task PDA (bound to both verbs).
 * @returns {@link UseCompletionBondResult}.
 */
export function useCompletionBond(
  taskPda: Parameters<typeof facadeNs.postCompletionBond>[0]["task"],
): UseCompletionBondResult {
  const ctx = useAgencContext();
  const queryClient = useQueryClient();
  const lastAction = useRef<"post" | "reclaim" | null>(null);

  const invalidateGuarantee = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.taskGuarantee(pdaKey(taskPda), ctx.cacheNamespace),
    });
  }, [ctx.cacheNamespace, queryClient, taskPda]);

  const postMut = useMutation<
    string,
    Error,
    QueuedCompletionBondInput<PostCompletionBondInput>
  >({
    mutationFn: async ({ client, input }) => {
      const { signature } = await client.postCompletionBond({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.postCompletionBond>[0]);
      invalidateGuarantee();
      return signature;
    },
  });

  const reclaimMut = useMutation<
    string,
    Error,
    QueuedCompletionBondInput<ReclaimCompletionBondInput>
  >({
    mutationFn: async ({ client, input }) => {
      const { signature } = await client.reclaimCompletionBond({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.reclaimCompletionBond>[0]);
      invalidateGuarantee();
      return signature;
    },
  });

  const post = useCallback(
    async (input: PostCompletionBondInput) => {
      const client = requireClient(ctx.client);
      const detachedInput = snapshotRecord(input);
      const authority = stabilizeSelectedTransactionSigner(
        client.signer,
        detachedInput.authority,
      );
      const snapshottedInput = snapshotRecord({
        ...detachedInput,
        authority,
      }) as PostCompletionBondInput;
      lastAction.current = "post";
      return postMut.mutateAsync({ client, input: snapshottedInput });
    },
    [ctx.client, postMut],
  );
  const reclaim = useCallback(
    async (input: ReclaimCompletionBondInput) => {
      const client = requireClient(ctx.client);
      const detachedInput = snapshotRecord(input);
      const feePayer = stabilizeSelectedTransactionSigner(client.signer);
      const snapshottedInput = snapshotRecord({
        ...detachedInput,
        party: detachedInput.party ?? feePayer.address,
      }) as ReclaimCompletionBondInput;
      lastAction.current = "reclaim";
      return reclaimMut.mutateAsync({ client, input: snapshottedInput });
    },
    [ctx.client, reclaimMut],
  );

  const isPending = postMut.isPending || reclaimMut.isPending;
  const latest = lastAction.current === "reclaim" ? reclaimMut : postMut;
  const status: CompletionBondStatus = isPending
    ? "pending"
    : mutationStatusOf(latest);

  return {
    post,
    reclaim,
    status,
    error: latest.error ?? null,
    signature: latest.data ?? null,
    isPending,
    reset: () => {
      lastAction.current = null;
      postMut.reset();
      reclaimMut.reset();
    },
  };
}
