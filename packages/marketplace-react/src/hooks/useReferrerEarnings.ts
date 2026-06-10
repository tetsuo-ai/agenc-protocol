/**
 * `useReferrerEarnings(wallet)` — referrer earnings (STRICTLY P6.2-GATED).
 *
 * ## THE P6.2 GATE (PLAN_2 §0, MANDATORY — this hook is the canonical example)
 *
 * Referrer earnings depend on TWO unbuilt things:
 * 1. the on-chain P6.2 referrer fields snapshotted on `HireRecord` (the 4th
 *    settlement leg), and
 * 2. the off-chain `GET /api/explorer/referrers/:wallet/hires` indexer endpoint
 *    that aggregates them.
 *
 * NEITHER exists today. So this hook:
 * - resolves `resolveReferrerCapability()` from context;
 * - when `live === false` (ALWAYS, today): returns the documented not-live
 *   state `{ live: false, totalLamports: 0n, hires: [] }` and makes NO network
 *   request. It NEVER fabricates earnings and NEVER infers a non-zero total
 *   from anything.
 * - the real fetch path is written but DEAD-CODE-GATED behind `capability.live`
 *   with a clear TODO, so when P6.2 + the endpoint land, only the gate flips —
 *   the surface does not change.
 *
 * @module hooks/useReferrerEarnings
 */
import { useQuery } from "@tanstack/react-query";
import { useAgencContext } from "../provider/context.js";
import { t } from "../strings/index.js";
import type { Address } from "../types.js";
import { pdaKey, queryKeys } from "./internal.js";

/** A single referral-earning hire (shape defined now; populated post-P6.2). */
export interface ReferrerHire {
  /** The minted Task PDA of the referred hire. */
  taskPda: string;
  /** The HireRecord PDA carrying the snapshotted referrer fields. */
  hireRecordPda: string;
  /** Referral fee earned on this hire, in lamports. */
  feeLamports: bigint;
  /** Transaction signature of the hire. */
  signature: string;
}

/** Return value of {@link useReferrerEarnings}. */
export interface UseReferrerEarningsResult {
  /**
   * Whether referral settlement is live on this cluster. ALWAYS `false` today
   * (the P6.2 gate). When false, the numbers below are the documented not-live
   * zero state, not real data.
   */
  live: boolean;
  /** Total lamports earned. `0n` while not live (never fabricated). */
  totalLamports: bigint;
  /** Per-hire earnings. `[]` while not live. */
  hires: ReferrerHire[];
  /** True while a (post-P6.2) fetch is in flight. Always false today. */
  isLoading: boolean;
  /** The fetch error, or null. */
  error: Error | null;
  /**
   * Human-readable reason the data is not live (the capability reason). Present
   * while `live` is false.
   */
  reason?: string;
  /** Force a refetch (no-op while not live). */
  refetch: () => void;
}

/**
 * Read a referrer wallet's earnings.
 *
 * @param wallet - The referrer wallet (base58 / Address). Falsy disables the
 *   (future) fetch; the not-live state is still returned.
 * @returns {@link UseReferrerEarningsResult} — the not-live zero state today.
 *
 * @example
 * ```tsx
 * const { live, totalLamports, hires, reason } = useReferrerEarnings(myWallet);
 * // today: live === false, totalLamports === 0n, hires === []
 * ```
 */
export function useReferrerEarnings(
  wallet: Address | string | undefined | null,
): UseReferrerEarningsResult {
  const ctx = useAgencContext();
  const capability = ctx.resolveReferrerCapability();

  // THE GATE: the query is enabled ONLY when referral settlement is live. Today
  // `capability.live` is hardcoded false, so this query never runs and we
  // return the not-live zero state below. NEVER remove this gate.
  const enabled = capability.live && Boolean(wallet);

  const query = useQuery<{ totalLamports: bigint; hires: ReferrerHire[] }, Error>(
    {
      queryKey: queryKeys.referrerEarnings(wallet ? pdaKey(wallet) : ""),
      enabled,
      queryFn: async () => {
        // TODO(P6.2 / indexer): once the referrer fields exist on HireRecord
        // AND the indexer exposes `GET /api/explorer/referrers/:wallet/hires`,
        // fetch + sum here. Unreachable today because `enabled` is gated on
        // `capability.live` (hardcoded false). Returning fabricated numbers
        // here would violate PLAN_2 §0 — do not.
        throw new Error(
          "useReferrerEarnings: the P6.2 referrer earnings path is not " +
            "deployed; this query must never run while capability.live is false.",
        );
      },
    },
  );

  if (!capability.live) {
    // The documented not-live state. Zeroes are HONEST (no data exists), not
    // fabricated, and no request was made.
    return {
      live: false,
      totalLamports: 0n,
      hires: [],
      isLoading: false,
      error: null,
      reason: capability.reason ?? t("referrer.notLiveReason"),
      refetch: () => {
        /* no-op while not live */
      },
    };
  }

  // --- Post-P6.2 path (currently unreachable; kept wired for the flip) ---
  return {
    live: true,
    totalLamports: query.data?.totalLamports ?? 0n,
    hires: query.data?.hires ?? [],
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
