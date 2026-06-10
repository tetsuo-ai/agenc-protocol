/**
 * Internal helpers shared by the headless hooks.
 *
 * - A namespaced TanStack Query key factory so every hook's cache entries are
 *   stable, collision-free, and individually invalidatable.
 * - Tiny guards that turn a missing write client / signer into a clear,
 *   catalog-routed error (never a `null.method()` crash) BEFORE a mutation runs.
 *
 * SSR-safe: pure functions, no `window`/`document`, no module-scope side
 * effects.
 *
 * @module hooks/internal
 */
import { t } from "../strings/index.js";
import type { Address, MarketplaceClient } from "../types.js";

/** Root namespace for every cache key this package writes. */
export const QUERY_KEY_ROOT = "agenc" as const;

/**
 * Stable, hierarchical TanStack Query keys. Hooks build their keys ONLY through
 * this factory so a consumer (or a hook) can invalidate a whole sub-tree
 * (`["agenc", "listings"]`) or one entity (`["agenc", "listing", pda]`).
 *
 * `JSON.stringify` is intentionally NOT used — TanStack compares keys
 * structurally, so passing the raw filter object keeps equality correct for
 * `bigint`/`Address` values without a serialization step.
 */
export const queryKeys = {
  /** All listings list queries (with their filter object as the leaf). */
  listings: (filter?: unknown) =>
    [QUERY_KEY_ROOT, "listings", filter ?? null] as const,
  /** One listing + its joined provider/track-record/moderation. */
  listing: (pda: string) => [QUERY_KEY_ROOT, "listing", pda] as const,
  /** One agent's indexer track record. */
  agentTrackRecord: (agentPda: string) =>
    [QUERY_KEY_ROOT, "agentTrackRecord", agentPda] as const,
  /** One task's status (read via transport / svm decode). */
  taskStatus: (taskPda: string) =>
    [QUERY_KEY_ROOT, "taskStatus", taskPda] as const,
  /** One task's dispute record. */
  dispute: (taskPda: string) => [QUERY_KEY_ROOT, "dispute", taskPda] as const,
  /** One referrer wallet's earnings (P6.2-gated; see useReferrerEarnings). */
  referrerEarnings: (wallet: string) =>
    [QUERY_KEY_ROOT, "referrerEarnings", wallet] as const,
} as const;

/**
 * Assert a write client exists, returning it narrowed to non-null. Throws a
 * clear, catalog-routed error when the provider was configured read-only (no
 * `client` and no resolvable `rpcUrl` + `signer`).
 *
 * Mutating hooks call this at the top of their `mutationFn` so the failure is a
 * descriptive Error in the mutation's `error` channel — never a crash.
 *
 * @throws Error (`provider.missingWriteClient`) when `client` is null.
 */
export function requireClient(
  client: MarketplaceClient | null,
): MarketplaceClient {
  if (client === null) {
    throw new Error(t("provider.missingWriteClient"));
  }
  return client;
}

/** Coerce an `Address | string` to its string form for use as a cache key. */
export function pdaKey(pda: Address | string): string {
  return String(pda);
}
