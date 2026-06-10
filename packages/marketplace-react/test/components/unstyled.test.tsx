/**
 * The `unstyled` white-label invariant for EVERY prebuilt component.
 *
 * Per PLAN_2 A3, every component accepts `unstyled` and must then emit semantic
 * markup + ARIA but NONE of the default `--agenc-*`-driven classes (so a host
 * can style from scratch). This sweep renders each component (in a state that
 * exercises its root + a few children) with `unstyled` and asserts no element
 * carries any `agenc-*` class — the guard that the `rootClass`/`elementClass`
 * helpers are threaded correctly through every component.
 *
 * It is revert-sensitive: drop the `unstyled` prop on any component's root and
 * its case goes red.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { address } from "@solana/kit";
import { TaskStatus } from "@tetsuo-ai/marketplace-sdk";
import type { ReactElement } from "react";
import type { ValidatedReferrerConfig } from "../../src/types.js";
import {
  Badge,
  Button,
  DisputeBanner,
  HireCheckoutModal,
  ListingCard,
  ListingGrid,
  Modal,
  ProviderCard,
  ReferrerDisclosure,
  ReviewPanel,
  Spinner,
  StateMessage,
  TaskTimeline,
} from "../../src/components/index.js";
import {
  FIXTURE_AGENT,
  FIXTURE_LISTING,
  FIXTURE_REFERRER,
  makeIndexerListing,
  makeListing,
  makeListingRows,
  makeTrackRecord,
} from "../../src/components/__fixtures__/index.js";

afterEach(cleanup);

const listing = { address: FIXTURE_LISTING, account: makeListing() };
const referrer: ValidatedReferrerConfig = {
  wallet: address(FIXTURE_REFERRER),
  feeBps: 250,
};

const CASES: Array<[string, ReactElement]> = [
  ["Button", <Button unstyled>x</Button>],
  ["Badge", <Badge unstyled>x</Badge>],
  ["Spinner", <Spinner unstyled />],
  ["StateMessage", <StateMessage kind="loading" unstyled />],
  [
    "ListingCard",
    <ListingCard
      listing={listing}
      moderation={makeIndexerListing()}
      onHire={() => {}}
      unstyled
    />,
  ],
  [
    "ListingGrid",
    <ListingGrid listings={makeListingRows(2)} onHire={() => {}} unstyled />,
  ],
  [
    "Modal",
    <Modal open onClose={() => {}} title="t" unstyled>
      body
    </Modal>,
  ],
  [
    "HireCheckoutModal",
    <HireCheckoutModal
      open
      onClose={() => {}}
      listing={listing}
      onConfirm={() => {}}
      moderation={makeIndexerListing()}
      referrer={referrer}
      unstyled
    />,
  ],
  ["ReferrerDisclosure", <ReferrerDisclosure referrer={referrer} unstyled />],
  ["TaskTimeline", <TaskTimeline status={TaskStatus.InProgress} unstyled />],
  [
    "ReviewPanel",
    <ReviewPanel hasSubmission onAccept={() => {}} unstyled />,
  ],
  ["DisputeBanner", <DisputeBanner disputeOpen unstyled />],
  [
    "ProviderCard",
    <ProviderCard agent={FIXTURE_AGENT} trackRecord={makeTrackRecord()} verified unstyled />,
  ],
];

describe("unstyled white-label sweep", () => {
  it.each(CASES)("%s emits no agenc-* classes when unstyled", (_name, ui) => {
    // Modal/HireCheckoutModal render into baseElement; use it to be safe.
    const { baseElement } = render(ui);
    expect(baseElement.querySelector('[class*="agenc-"]')).toBeNull();
  });
});
