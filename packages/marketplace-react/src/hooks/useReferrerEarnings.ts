/**
 * `useReferrerEarnings(wallet)` — referrer earnings (indexer-gated).
 *
 * ## EARNINGS INDEXER GATE
 *
 * Referrer settlement is live in the protocol. Aggregated referrer earnings still
 * depend on the off-chain `GET /api/explorer/referrers/:wallet/hires` indexer
 * endpoint that sums paid referral events.
 *
 * That endpoint is not published yet. So this hook:
 * - resolves `resolveReferrerCapability()` from context;
 * - when the earnings indexer is not live: returns the documented not-live
 *   state `{ live: false, totalLamports: 0n, hires: [] }` and makes NO network
 *   request. It NEVER fabricates earnings and NEVER infers a non-zero total
 *   from anything.
 * - the real fetch path is written but gated behind `EARNINGS_INDEXER_LIVE`, so
 *   when the endpoint lands, only the gate flips — the surface does not change.
 *
 * @module hooks/useReferrerEarnings
 */
import { useQuery } from "@tanstack/react-query";
import { useAgencContext } from "../provider/context.js";
import { t } from "../strings/index.js";
import type { Address } from "../types.js";
import { pdaKey, queryKeys } from "./internal.js";

const EARNINGS_INDEXER_LIVE = false;

/** A single referral-earning hire (shape defined now; populated once the earnings indexer ships). */
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
   * Whether aggregated referral earnings are live. Settlement may be live even
   * when this is false; false means the numbers below are the documented
   * not-live zero state, not real data.
   */
  live: boolean;
  /** Total lamports earned. `0n` while not live (never fabricated). */
  totalLamports: bigint;
  /** Per-hire earnings. `[]` while not live. */
  hires: ReferrerHire[];
  /** True while a fetch is in flight. Always false until the earnings indexer ships. */
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
   * @returns {@link UseReferrerEarningsResult} — the not-live zero state until
   * the earnings indexer ships.
 *
 * @example
 * ```tsx
 * const { live, totalLamports, hires, reason } = useReferrerEarnings(myWallet);
   * // until the earnings indexer ships: live === false, totalLamports === 0n, hires === []
 * ```
 */
export function useReferrerEarnings(
  wallet: Address | string | undefined | null,
): UseReferrerEarningsResult {
  const ctx = useAgencContext();
  const capability = ctx.resolveReferrerCapability();

  // THE GATE: settlement can be live while the aggregate earnings indexer is not.
  // Keep this false until the endpoint is published.
  const enabled = capability.live && EARNINGS_INDEXER_LIVE && Boolean(wallet);

  const query = useQuery<{ totalLamports: bigint; hires: ReferrerHire[] }, Error>(
    {
      queryKey: queryKeys.referrerEarnings(wallet ? pdaKey(wallet) : ""),
      enabled,
      queryFn: async () => {
        // TODO(indexer): once `GET /api/explorer/referrers/:wallet/hires` is
        // published, fetch + sum here. Returning fabricated numbers here would
        // violate the money-surface contract.
        throw new Error(
          "useReferrerEarnings: the referrer earnings indexer is not deployed; " +
            "this query must never run while EARNINGS_INDEXER_LIVE is false.",
        );
      },
    },
  );

  if (!capability.live || !EARNINGS_INDEXER_LIVE) {
    // The documented not-live state. Zeroes are HONEST (no data exists), not
    // fabricated, and no request was made.
    return {
      live: false,
      totalLamports: 0n,
      hires: [],
      isLoading: false,
      error: null,
      reason: capability.live
        ? t("referrer.earningsNotLiveReason")
        : (capability.reason ?? t("referrer.notLiveReason")),
      refetch: () => {
        /* no-op while not live */
      },
    };
  }

  // --- Post-indexer path (currently unreachable; kept wired for the flip) ---
  return {
    live: true,
    totalLamports: query.data?.totalLamports ?? 0n,
    hires: query.data?.hires ?? [],
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
