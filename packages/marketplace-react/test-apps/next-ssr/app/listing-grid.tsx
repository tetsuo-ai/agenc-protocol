"use client";

/**
 * The ONE component the A1 SSR Done-when requires ("provider + one hook + one
 * component"), wiring the public headless `useListings()` hook to the REAL
 * prebuilt `<ListingGrid>` component from the package — the genuine integration
 * a host writes in one line, not a hand-rolled stand-in.
 *
 * SSR-safe: `<ListingGrid>` is presentational (no window/document); on the first
 * server pass `useListings` has not resolved, so the grid renders its loading
 * state. After hydration the fixture transport resolves synchronously and the
 * grid populates with the real seeded listings — server and first client render
 * match, so there is no hydration mismatch.
 */
import { useListings } from "@tetsuo-ai/marketplace-react/hooks";
import { ListingGrid as AgencListingGrid } from "@tetsuo-ai/marketplace-react/components";

export function ListingGrid() {
  const { listings, isLoading, error, hasMore, fetchMore, refetch } =
    useListings();

  return (
    <AgencListingGrid
      listings={listings}
      isLoading={isLoading}
      error={error}
      hasMore={hasMore}
      onLoadMore={fetchMore}
      onRetry={refetch}
    />
  );
}
