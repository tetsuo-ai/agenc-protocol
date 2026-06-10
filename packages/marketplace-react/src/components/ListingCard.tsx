/**
 * `<ListingCard>` — a single service-listing card.
 *
 * Renders the decoded on-chain `ServiceListing` (name, category, price,
 * provider, lifetime hires) plus the moderation attestation badge. It is a
 * PRESENTATIONAL component: it takes already-fetched data (a `ListingRow` from
 * `useListings`, or a `ServiceListing` + address) so it can be used inside a
 * grid, a detail page, or SSR without owning a query.
 *
 * Themable via `--agenc-*`; `unstyled` strips the default classes. Every
 * literal routes through the component catalog.
 *
 * @module components/ListingCard
 */
import type { ReactNode } from "react";
import type { Address, IndexerListing, ServiceListing } from "../types.js";
import {
  decodeListingCategory,
  decodeListingName,
  formatPriceSol,
  tc,
  truncateAddress,
} from "./format.js";
import { ModerationBadge } from "./badges.js";
import { Badge, Button, rootClass, type ThemableProps } from "./primitives.js";

/** A decoded listing the card can render (matches `useListings`' `ListingRow`). */
export interface ListingCardData {
  /** The listing PDA. */
  address: Address;
  /** The decoded on-chain account. */
  account: ServiceListing;
}

/** Props for {@link ListingCard}. */
export interface ListingCardProps extends ThemableProps {
  /** The decoded listing to render. */
  listing: ListingCardData;
  /**
   * Optional indexer projection for the moderation badge. When absent the badge
   * shows the honest "pending" state (never asserts attestation).
   */
  moderation?: IndexerListing | null;
  /**
   * Click/hire handler. When provided the card renders a hire CTA (use
   * {@link HireButton} for the full flow); when absent the card is display-only.
   */
  onHire?: (listing: ListingCardData) => void;
  /** Optional select handler (e.g. open a detail view) on the card body. */
  onSelect?: (listing: ListingCardData) => void;
  /** Hide the price row (e.g. a teaser card). Default false. */
  hidePrice?: boolean;
}

/**
 * Render one service listing as a card.
 *
 * @example
 * ```tsx
 * <ListingCard listing={row} moderation={detail.moderation} onHire={open} />
 * ```
 */
export function ListingCard({
  listing,
  moderation,
  onHire,
  onSelect,
  hidePrice = false,
  unstyled,
  className,
}: ListingCardProps): ReactNode {
  const { account } = listing;
  const name = decodeListingName(account) || tc("components.listingCard.untitled");
  const category = decodeListingCategory(account);
  const price = formatPriceSol(account.price);
  const provider = truncateAddress(account.providerAgent);
  const hires = account.totalHires;

  const cardClass = rootClass("agenc-listing-card", unstyled, className);

  const selectable = Boolean(onSelect);
  const heading = (
    <h3 className={unstyled ? undefined : "agenc-listing-card__title"}>{name}</h3>
  );

  return (
    <article
      className={cardClass}
      aria-label={name}
    >
      <header className={unstyled ? undefined : "agenc-listing-card__header"}>
        {selectable ? (
          <button
            type="button"
            className={
              unstyled ? undefined : "agenc-listing-card__title-button"
            }
            onClick={() => onSelect?.(listing)}
          >
            {heading}
          </button>
        ) : (
          heading
        )}
        <ModerationBadge moderation={moderation} unstyled={unstyled} />
      </header>

      <dl className={unstyled ? undefined : "agenc-listing-card__meta"}>
        {category ? (
          <div className={unstyled ? undefined : "agenc-listing-card__meta-row"}>
            <dt>{tc("components.listingCard.category")}</dt>
            <dd>
              <Badge tone="info" unstyled={unstyled}>
                {category}
              </Badge>
            </dd>
          </div>
        ) : null}
        <div className={unstyled ? undefined : "agenc-listing-card__meta-row"}>
          <dt>{tc("components.listingCard.byProvider", { provider })}</dt>
          <dd>{tc("components.listingCard.hires", { count: String(hires) })}</dd>
        </div>
      </dl>

      <footer className={unstyled ? undefined : "agenc-listing-card__footer"}>
        {hidePrice ? null : (
          <p className={unstyled ? undefined : "agenc-listing-card__price"}>
            <span className={unstyled ? undefined : "agenc-listing-card__price-label"}>
              {tc("components.listingCard.priceLabel")}
            </span>{" "}
            <span className={unstyled ? undefined : "agenc-listing-card__price-value"}>
              {price}
            </span>
          </p>
        )}
        {onHire ? (
          <Button
            unstyled={unstyled}
            variant="primary"
            onClick={() => onHire(listing)}
          >
            {tc("components.hire.cta")}
          </Button>
        ) : null}
      </footer>
    </article>
  );
}
