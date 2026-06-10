/**
 * Ladle stories for {@link ListingCard}.
 */
import type { Story } from "@ladle/react";
import { ListingCard } from "./ListingCard.js";
import {
  makeIndexerListing,
  makeListingRow,
} from "./__fixtures__/index.js";

export default {
  title: "Listings / ListingCard",
};

const row = makeListingRow();

export const Default: Story = () => (
  <ListingCard
    listing={row}
    moderation={makeIndexerListing()}
    onHire={() => {}}
  />
);

export const Pending: Story = () => (
  <ListingCard listing={row} moderation={null} onHire={() => {}} />
);

export const WithIssues: Story = () => (
  <ListingCard
    listing={row}
    moderation={makeIndexerListing({
      metadataValid: false,
      metadataIssues: ["name exceeds 32 bytes"],
    })}
    onHire={() => {}}
  />
);

export const Selectable: Story = () => (
  <ListingCard listing={row} onSelect={() => {}} onHire={() => {}} />
);

export const DisplayOnly: Story = () => (
  <ListingCard listing={row} moderation={makeIndexerListing()} />
);

export const Unstyled: Story = () => (
  <ListingCard
    listing={row}
    moderation={makeIndexerListing()}
    onHire={() => {}}
    unstyled
  />
);
