/**
 * Moderation badge legibility test (finding #5).
 *
 * The `issues` state used to render the same visible text as the `pending`
 * (unknown) state ("Moderation pending"), so a sighted buyer could not tell
 * "we found problems" apart from "we haven't checked". The `issues` state now
 * renders a distinct string ("Moderation issues found").
 *
 * REVERT-SENSITIVITY: against the pre-fix code (issues mapped to the pending
 * string) the "renders the distinct issues text" + "does not say pending"
 * assertions go red.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ModerationBadge } from "../../src/components/index.js";
import { makeIndexerListing } from "../../src/components/__fixtures__/index.js";

afterEach(cleanup);

describe("ModerationBadge moderation states (finding #5)", () => {
  it("renders the distinct issues text for the issues state", () => {
    render(
      <ModerationBadge
        moderation={makeIndexerListing({ metadataValid: false })}
      />,
    );
    expect(screen.getByText("Moderation issues found")).toBeTruthy();
    // The issues state must NOT reuse the unknown/pending copy.
    expect(screen.queryByText("Moderation pending")).toBeNull();
  });

  it("renders pending for the unknown (null projection) state", () => {
    render(<ModerationBadge moderation={null} />);
    expect(screen.getByText("Moderation pending")).toBeTruthy();
    expect(screen.queryByText("Moderation issues found")).toBeNull();
  });

  it("issues and unknown render textually DISTINCT labels", () => {
    const { container: issuesC } = render(
      <ModerationBadge
        moderation={makeIndexerListing({ metadataValid: false })}
      />,
    );
    const { container: unknownC } = render(<ModerationBadge moderation={null} />);
    expect(issuesC.textContent).not.toBe(unknownC.textContent);
  });
});
