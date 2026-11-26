import { expect, it } from "vitest";
import { remainingJobMicrocents } from "../src/job-money.js";
import type { AgentRecord } from "../src/store.js";
import * as ledger from "../src/child-hire-store.js";

it("subtracts distinct purchases, worker charges, and unsettled holds together", () => {
  const agent = {
    policy: { refill: { perDayCents: 100 } },
    refills: [{ id: "claim", ts: 1, usdCents: 40 }],
    jobSpends: [{ id: "funded", at: 1, microcents: "40000000" }],
    childHolds: { funded: { funded: true, purchase: "4000000", review: "1000000", rate: 100 } },
  } as unknown as AgentRecord;
  expect(remainingJobMicrocents(agent, 2)).toBe(10000000n);
  ledger.childHolds(agent).childHolds!.funded!.futurePurchase = "500000";
  expect(remainingJobMicrocents(agent, 2)).toBe(10000000n);
  expect(remainingJobMicrocents(agent, 86_400_002)).toBe(85000000n);
});

it("deducts unsettled SOL across purchases and keeps a signed worker debit held past midnight", () => {
  const agent = {
    refills: [{ work: {}, lamports: "5" }],
    childHolds: {
      pending: { funded: false, purchase: "20", review: "2" },
      funded: { funded: true, purchase: "10", review: "3" },
    },
  } as unknown as AgentRecord;
  expect(ledger.reservedLamports(agent)).toBe(30n);
  expect(ledger.reservedLamports(agent, "pending")).toBe(8n);
});
