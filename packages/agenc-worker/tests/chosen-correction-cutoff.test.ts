import { describe, expect, it } from "vitest";
import {
  CORRECTION_RELEASE_MARGIN_SECS,
  CORRECTION_SUBMIT_MARGIN_SECS,
  chosenReleaseWindow,
  correctionCutoff,
  correctionRunSeconds,
} from "../src/chosen-release.js";

describe("correction cutoff", () => {
  const now = 1_000_000;
  it("stops before the early release pause while giving the claim back is open", () => {
    const releaseBy = now + 3600;
    const held = { expiresAt: now + 7200, deadline: now + 7200, releaseWindow: chosenReleaseWindow(releaseBy, now) };
    expect(correctionCutoff(held)).toBe(releaseBy - 600 - CORRECTION_RELEASE_MARGIN_SECS);
    expect(correctionRunSeconds(correctionCutoff(held), now, 86_400)).toBe(3600 - 600 - CORRECTION_RELEASE_MARGIN_SECS);
  });
  it("leaves time to submit before the claim expires or the deadline passes", () => {
    const late = chosenReleaseWindow(now - 100, now);
    expect(correctionCutoff({ expiresAt: now + 1800, deadline: now + 3600, releaseWindow: late }))
      .toBe(now + 1800 - CORRECTION_SUBMIT_MARGIN_SECS);
    expect(correctionCutoff({ expiresAt: now + 3600, deadline: now + 900, releaseWindow: null }))
      .toBe(now + 900 - CORRECTION_SUBMIT_MARGIN_SECS);
    // The full time left is never used, even when the executor allows more.
    expect(correctionRunSeconds(now + 1800 - CORRECTION_SUBMIT_MARGIN_SECS, now, 86_400)).toBe(1500);
  });
  it("refuses a correction when only the submit margin remains", () => {
    const cutoff = correctionCutoff({ expiresAt: now + CORRECTION_SUBMIT_MARGIN_SECS + 30, deadline: 0, releaseWindow: null });
    expect(correctionRunSeconds(cutoff, now, 86_400)).toBeNull();
    expect(correctionRunSeconds(now - 1, now, 86_400)).toBeNull();
  });
  it("uses the executor limit when nothing bounds the claim", () => {
    expect(correctionCutoff({ expiresAt: 0, deadline: 0, releaseWindow: null })).toBeNull();
    expect(correctionRunSeconds(null, now, 3)).toBe(3);
  });
});
