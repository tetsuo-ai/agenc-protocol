/**
 * Accessibility check over every prebuilt component's states (PLAN_2 A3
 * Done-when: "an axe accessibility check ... (a11y >= 95)").
 *
 * Each component is rendered in its representative states (default / loading /
 * error / empty / the money-modal confirmation states) into jsdom, then
 * `axe-core` runs over the rendered DOM. We FAIL on any violation of impact
 * `serious` or `critical` (the bar that maps to the a11y >= 95 target); the
 * lighter `minor`/`moderate` rules are reported but non-blocking, and
 * `color-contrast` is disabled because jsdom cannot compute layout/color (it
 * is verified visually in Ladle, not here).
 *
 * The modal cases are the load-bearing ones: `HireCheckoutModal` is a
 * money-handling dialog published to third parties, so its dialog roles, label
 * wiring, and focus surface must pass with zero serious/critical violations.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { address } from "@solana/kit";
import axe, { type Result } from "axe-core";
import { TaskStatus } from "@tetsuo-ai/marketplace-sdk";
import type { ReactElement } from "react";
import type { ValidatedReferrerConfig } from "../../src/types.js";
import {
  DisputeBanner,
  HireCheckoutModal,
  ListingCard,
  ListingGrid,
  PoweredByAgenC,
  ProviderCard,
  ReferrerDisclosure,
  ReviewPanel,
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

/** axe options: skip color-contrast (jsdom has no layout/canvas). */
const AXE_OPTIONS: axe.RunOptions = {
  rules: { "color-contrast": { enabled: false } },
  resultTypes: ["violations"],
};

/** Run axe over a rendered element and return serious/critical violations. */
async function seriousViolations(ui: ReactElement): Promise<Result[]> {
  const { container } = render(ui);
  const results = await axe.run(container, AXE_OPTIONS);
  return results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
}

const listing = { address: FIXTURE_LISTING, account: makeListing() };
const referrer: ValidatedReferrerConfig = {
  wallet: address(FIXTURE_REFERRER),
  feeBps: 250,
};

/** Each entry is [name, element] covering a component state. */
const CASES: Array<[string, ReactElement]> = [
  // ListingCard
  [
    "ListingCard / default",
    <ListingCard
      listing={listing}
      moderation={makeIndexerListing()}
      onHire={() => {}}
    />,
  ],
  [
    "ListingCard / selectable",
    <ListingCard listing={listing} onSelect={() => {}} onHire={() => {}} />,
  ],
  [
    "ListingCard / unstyled",
    <ListingCard listing={listing} onHire={() => {}} unstyled />,
  ],

  // ListingGrid
  [
    "ListingGrid / populated",
    <ListingGrid listings={makeListingRows(4)} onHire={() => {}} />,
  ],
  ["ListingGrid / loading", <ListingGrid listings={[]} isLoading />],
  ["ListingGrid / empty", <ListingGrid listings={[]} />],
  [
    "ListingGrid / error",
    <ListingGrid listings={[]} error={new Error("rpc")} onRetry={() => {}} />,
  ],
  [
    "ListingGrid / hasMore",
    <ListingGrid
      listings={makeListingRows(2)}
      hasMore
      onLoadMore={() => {}}
    />,
  ],

  // HireCheckoutModal (the money path)
  [
    "HireCheckoutModal / idle",
    <HireCheckoutModal
      open
      onClose={() => {}}
      listing={listing}
      onConfirm={() => {}}
      moderation={makeIndexerListing()}
    />,
  ],
  [
    "HireCheckoutModal / pending",
    <HireCheckoutModal
      open
      onClose={() => {}}
      listing={listing}
      onConfirm={() => {}}
      status="pending"
      moderation={makeIndexerListing()}
    />,
  ],
  [
    "HireCheckoutModal / success",
    <HireCheckoutModal
      open
      onClose={() => {}}
      listing={listing}
      onConfirm={() => {}}
      status="success"
      taskPda={FIXTURE_LISTING}
      onViewTask={() => {}}
      moderation={makeIndexerListing()}
    />,
  ],
  [
    "HireCheckoutModal / error",
    <HireCheckoutModal
      open
      onClose={() => {}}
      listing={listing}
      onConfirm={() => {}}
      status="error"
      error={new Error("price changed")}
      moderation={makeIndexerListing()}
    />,
  ],
  [
    "HireCheckoutModal / referrer disclosure",
    <HireCheckoutModal
      open
      onClose={() => {}}
      listing={listing}
      onConfirm={() => {}}
      moderation={makeIndexerListing()}
      referrer={referrer}
    />,
  ],

  // ReferrerDisclosure
  [
    "ReferrerDisclosure / pending",
    <ReferrerDisclosure referrer={referrer} live={false} />,
  ],

  // TaskTimeline
  ["TaskTimeline / in progress", <TaskTimeline status={TaskStatus.InProgress} />],
  ["TaskTimeline / completed", <TaskTimeline status={TaskStatus.Completed} />],
  ["TaskTimeline / disputed", <TaskTimeline status={TaskStatus.Disputed} />],
  ["TaskTimeline / loading", <TaskTimeline status={null} isLoading />],
  ["TaskTimeline / empty", <TaskTimeline status={null} />],
  [
    "TaskTimeline / error",
    <TaskTimeline status={null} error={new Error("read")} onRetry={() => {}} />,
  ],

  // ReviewPanel
  [
    "ReviewPanel / actions",
    <ReviewPanel
      hasSubmission
      onAccept={() => {}}
      onReject={() => {}}
      onRequestChanges={() => {}}
    />,
  ],
  ["ReviewPanel / awaiting", <ReviewPanel hasSubmission={false} />],
  [
    "ReviewPanel / error",
    <ReviewPanel
      hasSubmission
      status="error"
      error={new Error("not pending")}
      onAccept={() => {}}
      onReject={() => {}}
      onRequestChanges={() => {}}
    />,
  ],

  // DisputeBanner
  ["DisputeBanner / open", <DisputeBanner disputeOpen />],
  [
    "DisputeBanner / initiatable",
    <DisputeBanner disputeOpen={false} onInitiate={() => {}} />,
  ],
  [
    "DisputeBanner / error",
    <DisputeBanner
      disputeOpen={false}
      status="error"
      error={new Error("not disputable")}
      onInitiate={() => {}}
    />,
  ],

  // ProviderCard
  [
    "ProviderCard / verified",
    <ProviderCard agent={FIXTURE_AGENT} trackRecord={makeTrackRecord()} verified />,
  ],
  [
    "ProviderCard / loading",
    <ProviderCard agent={FIXTURE_AGENT} trackRecord={null} isLoading />,
  ],
  ["ProviderCard / no data", <ProviderCard agent={FIXTURE_AGENT} trackRecord={null} />],
  [
    "ProviderCard / unsupported",
    <ProviderCard
      agent={FIXTURE_AGENT}
      trackRecord={null}
      error={new Error("unsupported")}
      onRetry={() => {}}
    />,
  ],

  // PoweredByAgenC
  ["PoweredByAgenC / default", <PoweredByAgenC />],
];

describe("component accessibility (axe)", () => {
  it.each(CASES)("%s has no serious/critical a11y violations", async (_name, ui) => {
    const violations = await seriousViolations(ui);
    // Surface the failing rule ids for a readable assertion message.
    const summary = violations.map((v) => `${v.id} (${v.impact})`).join(", ");
    expect(violations, summary).toHaveLength(0);
  });
});
