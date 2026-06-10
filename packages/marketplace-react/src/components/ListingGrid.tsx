/**
 * `<ListingGrid>` — a responsive grid of {@link ListingCard}s with the
 * canonical loading / empty / error states.
 *
 * Presentational by design: it takes the `useListings` result fields
 * (`listings`, `isLoading`, `error`, `hasMore`, `fetchMore`) rather than
 * calling the hook itself, so it renders identically under SSR, in Ladle, and
 * against the live transport. A host wires it to `useListings` in one line:
 *
 * ```tsx
 * const q = useListings(filter);
 * <ListingGrid {...q} onLoadMore={q.fetchMore} onHire={open} />
 * ```
 *
 * @module components/ListingGrid
 */
import type { ReactNode } from "react";
import type { IndexerListing } from "../types.js";
import { tc } from "./format.js";
import { ListingCard, type ListingCardData } from "./ListingCard.js";
import { StateMessage, rootClass, type ThemableProps } from "./primitives.js";

/** Props for {@link ListingGrid}. */
export interface ListingGridProps extends ThemableProps {
  /** The listings to render (typically `useListings().listings`). */
  listings: ListingCardData[];
  /** True while the first load is in flight. Shows the loading state. */
  isLoading?: boolean;
  /** A load error. Shows the error state (with retry when `onRetry` given). */
  error?: Error | null;
  /** Whether more rows can be revealed (shows the "Load more" control). */
  hasMore?: boolean;
  /** Reveal the next page (typically `useListings().fetchMore`). */
  onLoadMore?: () => void;
  /** Retry handler for the error state. */
  onRetry?: () => void;
  /** Hire handler forwarded to each card. */
  onHire?: (listing: ListingCardData) => void;
  /** Select handler forwarded to each card. */
  onSelect?: (listing: ListingCardData) => void;
  /**
   * Optional per-listing moderation projections, keyed by listing PDA string,
   * for the moderation badge. Absent entries render the honest "pending" badge.
   */
  moderationByPda?: Record<string, IndexerListing | null>;
  /** Override the empty-state message. */
  emptyMessage?: string;
}

/**
 * A grid of listing cards with loading/empty/error handling.
 */
export function ListingGrid({
  listings,
  isLoading = false,
  error = null,
  hasMore = false,
  onLoadMore,
  onRetry,
  onHire,
  onSelect,
  moderationByPda,
  emptyMessage,
  unstyled,
  className,
}: ListingGridProps): ReactNode {
  const gridClass = rootClass("agenc-listing-grid", unstyled, className);

  // Error wins over loading/empty so a failed refetch is never masked.
  if (error) {
    return (
      <div className={gridClass}>
        <StateMessage
          kind="error"
          message={tc("components.listingGrid.error")}
          onRetry={onRetry}
          unstyled={unstyled}
        />
      </div>
    );
  }

  if (isLoading && listings.length === 0) {
    return (
      <div className={gridClass}>
        <StateMessage kind="loading" unstyled={unstyled} />
      </div>
    );
  }

  if (listings.length === 0) {
    return (
      <div className={gridClass}>
        <StateMessage
          kind="empty"
          message={emptyMessage ?? tc("components.listingGrid.empty")}
          unstyled={unstyled}
        />
      </div>
    );
  }

  return (
    <div className={gridClass}>
      <ul
        className={unstyled ? undefined : "agenc-listing-grid__list"}
        // The list is a semantic list of cards; each item is a listitem.
      >
        {listings.map((listing) => (
          <li
            key={String(listing.address)}
            className={unstyled ? undefined : "agenc-listing-grid__item"}
          >
            <ListingCard
              listing={listing}
              moderation={moderationByPda?.[String(listing.address)] ?? null}
              onHire={onHire}
              onSelect={onSelect}
              unstyled={unstyled}
            />
          </li>
        ))}
      </ul>
      {hasMore && onLoadMore ? (
        <div className={unstyled ? undefined : "agenc-listing-grid__more"}>
          <button
            type="button"
            className={unstyled ? undefined : "agenc-button agenc-button--secondary"}
            onClick={onLoadMore}
          >
            {tc("components.listingGrid.loadMore")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
