/**
 * `useTaskGuarantee(taskPda)` — a task's completion-bond ("Guaranteed Hire")
 * state, read-only.
 *
 * Guaranteed Hire is the productized read of the LIVE completion-bond
 * machinery: a worker who posts a completion bond stakes 25% of the reward on
 * passing review, and forfeits it if the result is rejected or they lose a
 * dispute. `guaranteed` is `true` iff the worker bond is posted and unresolved
 * (bond PDAs are closed by every settlement exit, so live == unresolved).
 *
 * HONEST BOUNDARY (phase 1 — do not overclaim in UI copy): a FORFEITED bond
 * pays the protocol **treasury**, not the harmed party. The buyer's protection
 * today is the escrow refund on a failed review PLUS the worker's 25% skin in
 * the game — the buyer does not receive the bond itself. Phase 2 (batch-2
 * program work) redirects forfeiture to the harmed party.
 *
 * ## How it reads
 *
 * The bond accounts are keyed by (task, posting wallet) and the worker's
 * wallet is not derivable from the Task account alone, so this is a
 * `getProgramAccounts` read (`CompletionBond.task` memcmp) — the SDK's
 * `fetchTaskGuarantee`. Resolution order:
 * 1. `options.guaranteeReader` — an injected reader seam (tests, litesvm,
 *    custom transports; same pattern as `useTaskStatus`/`useDispute`);
 * 2. the provider's resolved `rpcUrl` — a kit RPC is built for the read. NOTE:
 *    the RPC must allow `getProgramAccounts` (many public providers restrict
 *    it); a rejection surfaces in `error`, never a crash.
 * Without either, the hook stays idle.
 *
 * @module hooks/useTaskGuarantee
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { createSolanaRpc } from "@solana/kit";
import {
  fetchTaskGuarantee,
  type ProgramAccountsSource,
  type TaskGuarantee,
} from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import type { Address } from "../types.js";
import { pdaKey, queryKeys } from "./internal.js";

/** Reads a task's {@link TaskGuarantee} (the SDK `fetchTaskGuarantee` shape). */
export type TaskGuaranteeReader = (
  taskPda: Address | string,
) => Promise<TaskGuarantee>;

/** Options for {@link useTaskGuarantee}. */
export interface UseTaskGuaranteeOptions {
  /**
   * Injected reader seam (wins over the provider `rpcUrl` default). Wire it
   * from litesvm/gpa-sim in tests or from your own transport.
   */
  guaranteeReader?: TaskGuaranteeReader;
  /** Disable the read. Default `true` when `taskPda` + a read source exist. */
  enabled?: boolean;
}

/** Return value of {@link useTaskGuarantee}. */
export interface UseTaskGuaranteeResult {
  /** The full bond state (worker/creator bonds + flag), or null until read. */
  guarantee: TaskGuarantee | null;
  /**
   * Convenience: `guarantee?.guaranteed ?? false` — `true` iff the worker
   * bond is live (posted and unresolved).
   */
  guaranteed: boolean;
  /** True while the first read is in flight. */
  isLoading: boolean;
  /** The read error, or null. */
  error: Error | null;
  /** Force a refetch (e.g. after posting/reclaiming a bond). */
  refetch: () => void;
}

/**
 * Read a task's Guaranteed Hire state.
 *
 * @param taskPda - The Task PDA (falsy disables the read).
 * @param options - Reader seam + enabled.
 * @returns {@link UseTaskGuaranteeResult}.
 */
export function useTaskGuarantee(
  taskPda: Address | string | undefined | null,
  options?: UseTaskGuaranteeOptions,
): UseTaskGuaranteeResult {
  const ctx = useAgencContext();
  const injected = options?.guaranteeReader;
  const rpcUrl = ctx.rpcUrl;

  // Injected seam wins; else build a gPA read over the provider's rpcUrl.
  const reader = useMemo<TaskGuaranteeReader | null>(() => {
    if (injected) return injected;
    if (!rpcUrl) return null;
    return (pda) =>
      fetchTaskGuarantee(
        createSolanaRpc(rpcUrl) as unknown as ProgramAccountsSource,
        pda as Address,
      );
  }, [injected, rpcUrl]);

  const enabled =
    (options?.enabled ?? true) && Boolean(taskPda) && reader !== null;

  const query = useQuery<TaskGuarantee, Error>({
    queryKey: queryKeys.taskGuarantee(
      taskPda ? pdaKey(taskPda) : "",
      ctx.cacheNamespace,
    ),
    enabled,
    queryFn: () => reader!(taskPda as Address | string),
  });

  const guarantee = query.data ?? null;
  return {
    guarantee,
    guaranteed: guarantee?.guaranteed ?? false,
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
