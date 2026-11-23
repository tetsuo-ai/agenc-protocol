import { expect, it } from "vitest";
import { AGENT_METHODS, WALLET_CAPABILITIES } from "../src/client/index.js";

it("exports exactly the documented wallet capabilities", () => {
  expect(WALLET_CAPABILITIES).toEqual(["earn-finishing", "job-terms", "job-spend-quotes", "contests", "service-discovery-v1", "chosen-work", "delivery-review-v3"]);
});


it("lets chat draft contest decisions and reserves confirmation for the owner", () => {
  expect(AGENT_METHODS).toContain("jobs.quoteContest");
  expect(AGENT_METHODS).not.toContain("jobs.decideContest");
});
