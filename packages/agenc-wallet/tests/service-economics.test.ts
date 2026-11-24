import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { admitQuotedService, serviceEconomics } from "../src/service-economics.js";
import { reserveServiceRun, serviceUsage } from "../src/service-usage.js";

const terms = { usdPerSol: 100, minimumMarginCents: 2, marketFeeBps: 501, operatorFeeBps: 1234, modelCapCents: 3 };
describe("service fulfilment", () => {
  it("enforces the first spendable cent after both separately rounded fees and margin", () => {
    const floor = serviceEconomics({ ...terms, priceLamports: 1000000n }).minimumPriceLamports;
    expect(() => serviceEconomics({ ...terms, priceLamports: floor - 1n })).toThrow(/less than one cent/);
    expect(serviceEconomics({ ...terms, priceLamports: floor }).modelBudgetCents).toBe(1);
    expect(serviceEconomics({ ...terms, priceLamports: 1000000n }).modelBudgetCents).toBe(3);
    expect(() => serviceEconomics({ ...terms, priceLamports: floor, usdPerSol: null })).toThrow(/current dollar/);
  });
  it("consumes the buyer's versioned C3 payout contract and refuses a changed split", () => {
    const quote = { listingVersion: "7", operator: "operator", operatorFeeBps: 123, marketplaceFeeBps: 500,
      price: { lamports: "3000999" }, operatorFee: { lamports: "36912" }, minimumSellerNet: { lamports: "2814038" } };
    expect(admitQuotedService(quote, 100).modelBudgetCents).toBe(28);
    expect(() => admitQuotedService({ ...quote, operatorFeeBps: 124 }, 100)).toThrow(/payout changed/);
  });
  it("preserves the reservation if one of two paid rounds has incomplete usage", () => {
    const root = mkdtempSync(path.join(tmpdir(), "usage-"));
    const first = reserveServiceRun(root, "task", 3);
    writeFileSync(first, JSON.stringify({ costUsd: 0.012 }));
    expect(serviceUsage(root, "task")).toEqual({ costUsd: 0.012, runs: 1, reservedCents: 3, unknownReservedCents: 0 });
    reserveServiceRun(root, "task", 2);
    expect(serviceUsage(root, "task")).toEqual({ costUsd: null, runs: 2, reservedCents: 5, unknownReservedCents: 2 });
  });
});
