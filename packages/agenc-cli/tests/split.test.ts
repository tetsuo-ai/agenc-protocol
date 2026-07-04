import { describe, expect, it } from "vitest";
import {
  formatSplitTable,
  lamportsToSol,
  percentOfReward,
  type SettlementLeg,
} from "../src/split.js";

// A fake settlement delta set mirroring the real 4-way split of a
// 1_000_000-lamport reward: 10% operator, 5% referrer, 5% protocol fee,
// worker gets the remaining 80%.
function fakeLegs(): SettlementLeg[] {
  return [
    { label: "worker", address: "Worker1111111111111111111111111111111111111", deltaLamports: 800_000n },
    { label: "operator", address: "Operator111111111111111111111111111111111111", deltaLamports: 100_000n },
    { label: "referrer", address: "Referrer111111111111111111111111111111111111", deltaLamports: 50_000n },
    { label: "protocol treasury", address: "Treasury111111111111111111111111111111111111", deltaLamports: 50_000n },
  ];
}

describe("lamportsToSol", () => {
  it("formats whole and fractional SOL", () => {
    expect(lamportsToSol(1_000_000_000n)).toBe("1");
    expect(lamportsToSol(800_000n)).toBe("0.0008");
    expect(lamportsToSol(0n)).toBe("0");
    expect(lamportsToSol(-50_000n)).toBe("-0.00005");
  });
});

describe("percentOfReward", () => {
  it("computes basis-point-exact percentages", () => {
    expect(percentOfReward(800_000n, 1_000_000n)).toBe("80.00%");
    expect(percentOfReward(50_000n, 1_000_000n)).toBe("5.00%");
    expect(percentOfReward(123_400n, 1_000_000n)).toBe("12.34%");
    expect(percentOfReward(0n, 0n)).toBe("0.00%");
  });
});

describe("formatSplitTable", () => {
  it("renders all four legs with lamports, SOL, and percentages", () => {
    const table = formatSplitTable(fakeLegs(), 1_000_000n);
    expect(table).toContain("worker");
    expect(table).toContain("operator");
    expect(table).toContain("referrer");
    expect(table).toContain("protocol treasury");
    expect(table).toContain("800000");
    expect(table).toContain("80.00%");
    expect(table).toContain("5.00%");
    expect(table).toContain("0.0008");
  });

  it("totals the legs and shows 100% when they sum to the reward", () => {
    const table = formatSplitTable(fakeLegs(), 1_000_000n);
    expect(table).toContain("total");
    expect(table).toContain("100.00%");
    expect(table).not.toContain("total > reward");
  });

  it("adds the rent-refund footnote when the worker delta includes rents", () => {
    const legs = fakeLegs();
    legs[0]!.deltaLamports += 2_000_000n; // claim/submission rent refunds
    const table = formatSplitTable(legs, 1_000_000n);
    expect(table).toContain("total > reward");
    expect(table).toContain("rent");
  });

  it("shortens payee addresses for the table", () => {
    const table = formatSplitTable(fakeLegs(), 1_000_000n);
    expect(table).toContain("Work…1111");
    expect(table).not.toContain("Worker1111111111111111111111111111111111111");
  });
});
