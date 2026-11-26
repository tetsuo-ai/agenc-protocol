import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fundingShortLogLine } from "../src/earn-log-lines.js";

// The worker's own sentence from rt6-a, which the log cut at "... fee headroom 1000000. Fund ".
const REASON = "insufficient funds: wallet ZZbfQ9Hc2b8yT7nW3dR5kLmP4xVsA1eJ6uGfN8oYqXiC holds 2879600 lamports but the claim through submission needs at least 11094720 lamports: claim rent 2303760 + submission rent 2790960 + claim deposit 5000000 (back on delivery) + fee headroom 1000000. Fund ZZbfQ9Hc2b8yT7nW3dR5kLmP4xVsA1eJ6uGfN8oYqXiC with at least 8215120 more lamports and retry.";

describe("the cannot-fund log line", () => {
  it("keeps the worker's whole sentence", () => {
    expect(REASON.length).toBeGreaterThan(300);
    expect(fundingShortLogLine("agent_x", "5LPoh7", REASON)).toBe(`earn agent_x: cannot fund 5LPoh7: ${REASON}`);
  });

  it("cuts a very long reason at a full stop, never mid-word", () => {
    const line = fundingShortLogLine("agent_x", "t", `${"A short sentence. ".repeat(100)}Tail`);
    expect(line.endsWith("A short sentence.")).toBe(true);
    expect(line.length).toBeLessThan(1300);
  });

  it("is what the earning loop logs", () => {
    const source = readFileSync(new URL("../src/earn.ts", import.meta.url), "utf8");
    expect(source).toContain("this.#log(fundingShortLogLine(agent.agentId, event.task, event.reason));");
    expect(source).not.toMatch(/cannot fund \$\{event\.task\}: \$\{String\(event\.reason \?\? ""\)\.slice\(0, 300\)\}/);
  });
});
