/**
 * `useReferrerEarnings(wallet)` — aggregated referrer earnings (P3.8).
 *
 * ## Data source
 *
 * `GET <earningsBase>/api/explorer/referrers/:wallet/hires` — the hosted
 * explorer endpoint that sums the referrer leg over SETTLED hires with the
 * program's own split math (shipped 2026-07-03; ground-truthed against the
 * cross-node canary's on-chain legs). `earningsBase` resolves from
 * `config.indexer.baseUrl` when set, else the per-network hosted default
 * (mainnet only). When no base resolves (localnet/devnet without an indexer),
 * the hook returns the documented not-live zero state and makes NO network
 * request — it NEVER fabricates earnings; a fetch failure surfaces as
 * `error` with zero totals, never invented numbers.
 *
 * @module hooks/useReferrerEarnings
 */
import { useQuery } from "@tanstack/react-query";
import { useAgencContext } from "../provider/context.js";
import { t } from "../strings/index.js";
import type { Address, AgencContextValue, AgencNetwork } from "../types.js";
import { pdaKey, queryKeys } from "./internal.js";

/**
 * Hosted explorer bases serving the earnings endpoints, per network. Only
 * mainnet has one today; an explicit `config.indexer.baseUrl` always wins.
 */
const EARNINGS_INDEXER_DEFAULTS: Partial<Record<AgencNetwork, string>> = {
  mainnet: "https://api.agenc.ag",
};

/** Resolve the earnings endpoint base, or `null` (not live) when none. */
function resolveEarningsBaseUrl(ctx: AgencContextValue): string | null {
  return ctx.indexerBaseUrl ?? EARNINGS_INDEXER_DEFAULTS[ctx.network] ?? null;
}

/** A single referral-earning hire. */
export interface ReferrerHire {
  /** The minted Task PDA of the referred hire. */
  taskPda: string;
  /** The HireRecord PDA carrying the snapshotted referrer fields. */
  hireRecordPda: string;
  /** Referral fee earned on this hire, in lamports. */
  feeLamports: bigint;
  /** Transaction signature of the hire (empty until event indexing lands). */
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
  /** True while a fetch is in flight. */
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

/** The endpoint's wire shape (lamports as decimal strings). */
interface EarningsWire {
  totalLamports?: string;
  hires?: Array<{
    taskPda?: string;
    hireRecordPda?: string;
    feeLamports?: string;
    signature?: string;
  }>;
}

/**
 * Read a referrer wallet's aggregated earnings from the hosted explorer.
 *
 * @param wallet - The referrer wallet (base58 / Address). Falsy disables the
 *   fetch; the not-live state is still returned.
 * @returns {@link UseReferrerEarningsResult}
 *
 * @example
 * ```tsx
 * const { live, totalLamports, hires, reason } = useReferrerEarnings(myWallet);
 * ```
 */
export function useReferrerEarnings(
  wallet: Address | string | undefined | null,
): UseReferrerEarningsResult {
  const ctx = useAgencContext();
  const capability = ctx.resolveReferrerCapability();
  const earningsBase = resolveEarningsBaseUrl(ctx);

  // Live only when settlement capability holds AND an earnings endpoint base
  // resolves. No base (localnet/devnet without an indexer) = the documented
  // not-live zero state, zero network requests.
  const enabled = capability.live && earningsBase !== null && Boolean(wallet);

  const query = useQuery<{ totalLamports: bigint; hires: ReferrerHire[] }, Error>(
    {
      queryKey: queryKeys.referrerEarnings(wallet ? pdaKey(wallet) : ""),
      enabled,
      queryFn: async () => {
        const url = `${earningsBase}/api/explorer/referrers/${encodeURIComponent(
          String(wallet),
        )}/hires`;
        const response = await fetch(url, {
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          throw new Error(
            t("referrer.earningsFetchFailed") + ` (HTTP ${response.status})`,
          );
        }
        const body = (await response.json()) as EarningsWire;
        // Lamports arrive as decimal strings; parse to bigint. Anything
        // malformed throws (surfaces as `error`) — never silently coerced.
        const hires: ReferrerHire[] = (body.hires ?? []).map((h) => ({
          taskPda: String(h.taskPda ?? ""),
          hireRecordPda: String(h.hireRecordPda ?? ""),
          feeLamports: BigInt(h.feeLamports ?? "0"),
          signature: String(h.signature ?? ""),
        }));
        return {
          totalLamports: BigInt(body.totalLamports ?? "0"),
          hires,
        };
      },
    },
  );

  if (!enabled) {
    // The documented not-live state. Zeroes are HONEST (no data was read),
    // not fabricated, and no request was made.
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

  return {
    live: true,
    totalLamports: query.data?.totalLamports ?? 0n,
    hires: query.data?.hires ?? [],
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
