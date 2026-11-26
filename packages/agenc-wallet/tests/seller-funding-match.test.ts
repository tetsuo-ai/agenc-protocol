import { describe, expect, it } from "vitest";
import { sameFundingLamports, sameServiceAdmission } from "../src/seller-funding-match.js";

const row = (lamports: string, usdCents: number, quotedUsd?: string) => ({ lamports, sol: "0", usdCents, ...(quotedUsd && { quotedUsd }) });
const rows = (usd: number) => ({
  lockedStake: row("10000000", usd, `${usd}.01`), claimDeposits: row("500000", 5), registrationRent: row("4000000", 40),
  listingRent: row("3000000", 30), moderationRent: row("100000", 1), firstClaimRecordRent: row("0", 0), setupFees: row("15000", 0),
  refundableClaimRent: row("2000000", 20), reclaimNow: row("0", 0), feeReserve: row("5000", 0),
}) as never;

describe("a funding yes after a rate move", () => {
  it("matches the same lamports whatever the dollar figures say", () => {
    expect(sameFundingLamports(rows(100), rows(101))).toBe(true);
    expect(sameFundingLamports({ ...(rows(100) as object), price: row("1", 1) } as never, rows(100))).toBe(true);
  });
  it("refuses a lamport that moved, or a row that came or went", () => {
    const moved = { ...(rows(100) as object), setupFees: row("15001", 0) } as never;
    expect(sameFundingLamports(rows(100), moved)).toBe(false);
    const extra = { ...(rows(100) as object), alreadyStaked: row("0", 0) } as never;
    expect(sameFundingLamports(rows(100), extra)).toBe(false);
  });
  it("binds the service capability, not the budget at the rate of the moment", () => {
    expect(sameServiceAdmission({ minimumPriceLamports: "11", modelBudgetCents: 27, capabilities: "1" },
      { minimumPriceLamports: "10", modelBudgetCents: 28, capabilities: "1" })).toBe(true);
    expect(sameServiceAdmission({ minimumPriceLamports: "10", modelBudgetCents: 28, capabilities: "5" },
      { minimumPriceLamports: "10", modelBudgetCents: 28, capabilities: "1" })).toBe(false);
  });
});
