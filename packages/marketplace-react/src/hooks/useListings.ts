/**
 * `useListings(filter?)` — the listing-grid read hook.
 *
 * Fetches active service listings through the provider's unified read transport
 * (indexer-first, gPA fallback — the hook never branches on which is live) and
 * caches them via TanStack Query. Filters (`provider`, `category`, `state`) are
 * forwarded verbatim to the transport, which applies server-side memcmp filters
 * (indexer/gPA) and the client-side state filter exactly as the SDK does.
 *
 * ## Pagination model (honest about the transport)
 *
 * The v1 read transport returns the FULL active-listing set in one call — there
 * is no server cursor in either backend (the gPA path can't have one; the
 * indexer's `listActiveListings` is a drop-in of it). So pagination here is a
 * client-side WINDOW over the already-fetched array: `listings` grows by
 * `pageSize` each time `fetchMore()` is called, `hasMore` reflects whether more
 * rows remain in the fetched set. This keeps one network round-trip while still
 * giving a grid an incremental-reveal API. When a future transport gains a
 * cursor, `fetchMore` can swap to `fetchNextPage` without changing this
 * surface.
 *
 * SSR-safe: no `window`/`document`; the query simply does not run until mounted
 * if the host disables it.
 *
 * @module hooks/useListings
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useAgencContext } from "../provider/context.js";
import type {
  DecodedProgramAccount,
  ListActiveListingsOptions,
  ServiceListing,
} from "../types.js";
import { queryKeys } from "./internal.js";

/** A decoded active listing row (address + decoded account). */
export type ListingRow = DecodedProgramAccount<ServiceListing>;

/** Filter for {@link useListings}. Mirrors the SDK's `ListActiveListingsOptions`. */
export type UseListingsFilter = ListActiveListingsOptions;

/** Options for {@link useListings}. */
export interface UseListingsOptions {
  /** Rows revealed per page / per `fetchMore()` call. Default `12`. */
  pageSize?: number;
  /**
   * Disable the query (e.g. until a filter is ready). When `false` the hook
   * returns the idle state and makes no request. Default `true`.
   */
  enabled?: boolean;
}

/** Return value of {@link useListings}. */
export interface UseListingsResult {
  /** The currently-revealed window of listings (grows via `fetchMore`). */
  listings: ListingRow[];
  /** Total active listings the transport returned (the full fetched set). */
  total: number;
  /** True while the underlying fetch is in flight (first load / refetch). */
  isLoading: boolean;
  /** The fetch error (typed `AgencError` for on-chain failures), or null. */
  error: Error | null;
  /** Whether more rows remain in the fetched set to reveal. */
  hasMore: boolean;
  /** Reveal the next `pageSize` rows from the fetched set. No-op when exhausted. */
  fetchMore: () => void;
  /** Force a fresh fetch from the transport. */
  refetch: () => void;
}

const DEFAULT_PAGE_SIZE = 12;

/**
 * Read active service listings for a grid.
 *
 * @param filter - Optional provider/category/state filter (SDK semantics).
 * @param options - Page size + enabled flag.
 * @returns {@link UseListingsResult}.
 *
 * @example
 * ```tsx
 * const { listings, isLoading, fetchMore, hasMore } = useListings({
 *   category: "code-generation",
 * });
 * ```
 */
export function useListings(
  filter?: UseListingsFilter,
  options?: UseListingsOptions,
): UseListingsResult {
  const { read, cacheNamespace } = useAgencContext();
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  const enabled = options?.enabled ?? true;

  const query = useQuery<ListingRow[], Error>({
    queryKey: queryKeys.listings(filter, cacheNamespace),
    queryFn: () => read.listActiveListings(filter),
    enabled,
  });

  // Client-side reveal window. Reset to one page whenever the underlying data
  // changes (new fetch / filter change resets the key, which remounts data).
  const [visible, setVisible] = useState(pageSize);

  const all = query.data ?? [];
  // Clamp the window to [pageSize, all.length] so a filter change that shrinks
  // the set never strands `visible` above the available rows.
  const windowSize = Math.min(Math.max(visible, pageSize), all.length);
  const listings = useMemo(
    () => all.slice(0, windowSize),
    [all, windowSize],
  );

  const fetchMore = useCallback(() => {
    setVisible((current) => current + pageSize);
  }, [pageSize]);

  const refetch = useCallback(() => {
    setVisible(pageSize);
    void query.refetch();
  }, [pageSize, query]);

  return {
    listings,
    total: all.length,
    isLoading: query.isLoading,
    error: query.error ?? null,
    hasMore: windowSize < all.length,
    fetchMore,
    refetch,
  };
}
