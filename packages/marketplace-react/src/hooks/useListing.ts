/**
 * `useListing(pda)` — single-listing detail hook.
 *
 * Joins, in ONE cached query, the three things a listing detail / checkout view
 * needs:
 * - the decoded `ServiceListing` (via `read.getListing`);
 * - the provider's track record (via `read.agentTrackRecord(providerAgent)`),
 *   keyed off the listing's `providerAgent` — indexer-native, so it is fetched
 *   only when the indexer backend is live and resolves to `null` under the gPA
 *   fallback (which has no trustless aggregated track record — the transport
 *   throws `ReadTransportUnsupportedError`, which the hook swallows to `null`
 *   rather than failing the whole join);
 * - the moderation/attestation state (see the moderation note below).
 *
 * ## Moderation (v1 scope, honest)
 *
 * The read transport does not yet expose a dedicated listing-moderation read
 * (the indexer's listing projection carries the pinned `specHash` but not an
 * attestation verdict). So `moderation` is the listing's indexer projection when
 * present (callers can read `indexer.metadataValid` / `metadataIssues` and the
 * pinned `specHash`) and `null` under the gPA fallback. A dedicated attestation
 * read lands when the indexer projects it; this hook's surface does not change.
 *
 * @module hooks/useListing
 */
import { useQuery } from "@tanstack/react-query";
import { useAgencContext } from "../provider/context.js";
import { ReadTransportUnsupportedError } from "../transport/index.js";
import type {
  Address,
  IndexerAgentTrackRecord,
  IndexerListing,
  ServiceListing,
} from "../types.js";
import { pdaKey, queryKeys } from "./internal.js";

/** The joined detail payload {@link useListing} resolves. */
export interface ListingDetail {
  /** The listing PDA. */
  address: Address;
  /** The decoded on-chain `ServiceListing`. */
  listing: ServiceListing;
  /** The provider's agent PDA (`ServiceListing.providerAgent`). */
  provider: Address;
  /**
   * The provider's indexer track record, or `null` when unavailable (the gPA
   * fallback has no trustless aggregated equivalent).
   */
  trackRecord: IndexerAgentTrackRecord | null;
  /**
   * The listing's indexer projection (carries `metadataValid`,
   * `metadataIssues`, the pinned `specHash`), or `null` under the gPA fallback.
   * The v1 read model does not yet project a standalone attestation verdict.
   */
  moderation: IndexerListing | null;
}

/** Options for {@link useListing}. */
export interface UseListingOptions {
  /** Disable the query (no `pda` yet, etc.). Default `true` when `pda` is set. */
  enabled?: boolean;
}

/** Return value of {@link useListing}. */
export interface UseListingResult {
  /** The joined detail, or null until loaded. */
  detail: ListingDetail | null;
  /** The decoded listing, or null until loaded (convenience projection). */
  listing: ServiceListing | null;
  /** The provider agent PDA, or null until loaded. */
  provider: Address | null;
  /** The provider's track record, or null (unavailable / not yet loaded). */
  trackRecord: IndexerAgentTrackRecord | null;
  /** The listing's indexer/moderation projection, or null. */
  moderation: IndexerListing | null;
  /** True while loading. */
  isLoading: boolean;
  /** The error, or null. */
  error: Error | null;
  /** Force a refetch. */
  refetch: () => void;
}

/**
 * Read one listing and join its provider track record + moderation projection.
 *
 * @param pda - The ServiceListing PDA (string or Address). When falsy the query
 *   is disabled.
 * @param options - `enabled` override.
 * @returns {@link UseListingResult}.
 */
export function useListing(
  pda: Address | string | undefined | null,
  options?: UseListingOptions,
): UseListingResult {
  const { read, cacheNamespace } = useAgencContext();
  const enabled = (options?.enabled ?? true) && Boolean(pda);

  const query = useQuery<ListingDetail, Error>({
    queryKey: queryKeys.listing(pda ? pdaKey(pda) : "", cacheNamespace),
    enabled,
    queryFn: async () => {
      // 1) The listing itself.
      const result = await read.getListing(pda as Address | string);
      const provider = result.account.providerAgent;

      // 2) The provider's track record — indexer-native. Swallow the
      //    gPA-fallback "unsupported" rejection to null so the join still
      //    resolves the listing + moderation (degrade, don't fail).
      let trackRecord: IndexerAgentTrackRecord | null = null;
      try {
        trackRecord = await read.agentTrackRecord(provider);
      } catch (err) {
        if (!(err instanceof ReadTransportUnsupportedError)) throw err;
      }

      return {
        address: result.address,
        listing: result.account,
        provider,
        trackRecord,
        moderation: result.indexer ?? null,
      };
    },
  });

  const detail = query.data ?? null;
  return {
    detail,
    listing: detail?.listing ?? null,
    provider: detail?.provider ?? null,
    trackRecord: detail?.trackRecord ?? null,
    moderation: detail?.moderation ?? null,
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
