/**
 * Ladle stories for the connected {@link HireButton} (wraps the fixture
 * `AgencProvider`) and the standalone {@link ReferrerDisclosure}.
 */
import type { Story } from "@ladle/react";
import { HireButton } from "./HireButton.js";
import { ReferrerDisclosure } from "./ReferrerDisclosure.js";
import { address } from "@solana/kit";
import {
  FIXTURE_AGENT,
  FIXTURE_LISTING,
  FIXTURE_REFERRER,
  FixtureProvider,
  makeListing,
} from "./__fixtures__/index.js";
import type { ValidatedReferrerConfig } from "../types.js";

export default {
  title: "Hire / HireButton",
};

const listing = { address: FIXTURE_LISTING, account: makeListing() };

const buildInput = () =>
  ({
    listing: listing.address,
    creatorAgent: FIXTURE_AGENT,
    taskId: new Uint8Array(32).fill(9),
    expectedPrice: listing.account.price,
    expectedVersion: listing.account.version,
  }) as never;

export const Default: Story = () => (
  <FixtureProvider>
    <HireButton listing={listing} buildHireInput={buildInput} />
  </FixtureProvider>
);

export const WithReferrer: Story = () => (
  <FixtureProvider referrer={{ wallet: FIXTURE_REFERRER, feeBps: 300 }}>
    <HireButton listing={listing} buildHireInput={buildInput} />
  </FixtureProvider>
);

export const NoWalletConnected: Story = () => (
  <FixtureProvider withClient={false}>
    <HireButton listing={listing} buildHireInput={buildInput} />
  </FixtureProvider>
);

export const PriceHidden: Story = () => (
  <FixtureProvider>
    <HireButton
      listing={listing}
      buildHireInput={buildInput}
      showPriceInLabel={false}
    />
  </FixtureProvider>
);

const referrer: ValidatedReferrerConfig = {
  wallet: address(FIXTURE_REFERRER),
  feeBps: 250,
};

export const DisclosurePending: Story = () => (
  <ReferrerDisclosure referrer={referrer} live={false} />
);

export const DisclosureLive: Story = () => (
  <ReferrerDisclosure referrer={referrer} live />
);
