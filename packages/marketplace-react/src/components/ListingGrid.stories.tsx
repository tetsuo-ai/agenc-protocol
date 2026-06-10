/**
 * Ladle stories for {@link ListingGrid} — covers default / loading / empty /
 * error / load-more.
 */
import type { Story } from "@ladle/react";
import { ListingGrid } from "./ListingGrid.js";
import { makeListingRows } from "./__fixtures__/index.js";

export default {
  title: "Listings / ListingGrid",
};

const rows = makeListingRows(6);

export const Default: Story = () => (
  <ListingGrid listings={rows} onHire={() => {}} onSelect={() => {}} />
);

export const Loading: Story = () => (
  <ListingGrid listings={[]} isLoading />
);

export const Empty: Story = () => <ListingGrid listings={[]} />;

export const ErrorState: Story = () => (
  <ListingGrid
    listings={[]}
    error={new Error("RPC unavailable")}
    onRetry={() => {}}
  />
);

export const HasMore: Story = () => (
  <ListingGrid
    listings={rows.slice(0, 3)}
    hasMore
    onLoadMore={() => {}}
    onHire={() => {}}
  />
);

export const Unstyled: Story = () => (
  <ListingGrid listings={rows} onHire={() => {}} unstyled />
);
