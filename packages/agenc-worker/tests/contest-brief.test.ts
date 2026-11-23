import { expect, it } from "vitest";
import { briefDeliverable, parseJobBrief } from "../src/job-brief.js";

it("retains contest eligibility, the saved interval and the fixed selection clock in worker evidence", () => {
  const terms = { deadline: 1800000000, reviewWindowSecs: 72, listingDurationSecs: null,
    eligibility: { minReputation: 80, requiredCapabilities: "3" }, contest: { maxEntries: 3, entryDepositLamports: "10000000", releaseAt: 1800172800 } };
  const text = briefDeliverable(terms);
  expect(parseJobBrief({ instructions: "A poem", acceptance: ["Three lines"], deliverables: [text] })).toEqual({
    request: "A poem", acceptance: ["Three lines"], terms,
  });
  expect(() => parseJobBrief({ deliverables: [text.replace("10000000", "10000001")] })).toThrow("Invalid contest terms");
  expect(() => parseJobBrief({ deliverable: text, deliverables: ["Another contest"] })).toThrow("conflicting deliverables");
});
