import { describe, expect, it } from "vitest";
import { DISPUTE_SAFE_MAX_WORKERS } from "../src/values/index.js";

describe("protocol limits", () => {
  it("exports the revision-5 dispute-safe worker cap", () => {
    expect(DISPUTE_SAFE_MAX_WORKERS).toBe(4);
  });
});
