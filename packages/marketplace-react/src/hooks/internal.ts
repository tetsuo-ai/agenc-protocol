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
import type {
  Address,
  AgencContextValue,
  MarketplaceClient,
  TransactionSigner,
} from "../types.js";

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
  /** One task's completion-bond ("Guaranteed Hire") state. */
  taskGuarantee: (taskPda: string) =>
    [QUERY_KEY_ROOT, "taskGuarantee", taskPda] as const,
  /** One referrer wallet's earnings (indexer-gated; see useReferrerEarnings). */
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

export type MutationStatus = "idle" | "pending" | "success" | "error";

export function mutationStatusOf(mutation: {
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
}): MutationStatus {
  if (mutation.isPending) return "pending";
  if (mutation.isError) return "error";
  if (mutation.isSuccess) return "success";
  return "idle";
}

/** Coerce an `Address | string` to its string form for use as a cache key. */
export function pdaKey(pda: Address | string): string {
  return String(pda);
}

export interface ReferrerArgs {
  referrer?: Address;
  referrerFeeBps?: number;
}

export interface ResolvedReferrerArgs {
  referrerArgs: ReferrerArgs;
  referrerInjected: boolean;
}

export function resolveReferrerArgs(
  ctx: Pick<AgencContextValue, "resolveReferrerCapability">,
): ResolvedReferrerArgs {
  const capability = ctx.resolveReferrerCapability();
  if (!capability.live || !capability.referrer) {
    return { referrerArgs: {}, referrerInjected: false };
  }
  return {
    referrerArgs: {
      referrer: capability.referrer.wallet,
      referrerFeeBps: capability.referrer.feeBps,
    },
    referrerInjected: true,
  };
}

export type SignerOrAddress = TransactionSigner | Address;

export function signerAddress(signerOrAddress: SignerOrAddress): Address {
  if (typeof signerOrAddress === "string") {
    return signerOrAddress;
  }
  if (
    typeof signerOrAddress === "object" &&
    signerOrAddress !== null &&
    "address" in signerOrAddress &&
    typeof signerOrAddress.address === "string"
  ) {
    return signerOrAddress.address;
  }
  throw new Error("Expected a TransactionSigner or Address with an address field.");
}

export function withoutReferrerArgs<T extends object>(
  input: T,
): Omit<T, "referrer" | "referrerFeeBps"> {
  const {
    referrer: _referrer,
    referrerFeeBps: _referrerFeeBps,
    ...rest
  } = input as T & { referrer?: unknown; referrerFeeBps?: unknown };
  return rest;
}
