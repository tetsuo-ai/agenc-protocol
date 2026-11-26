import { describe, expect, it } from "vitest";
import { EarnHost, jobPayCents, maximumOfferPrice } from "../src/earn.js";
import type { Chain } from "../src/chain.js";
import type { MarketServices } from "../src/services.js";

describe("earning limits", () => {
  it("caps offers at 1 SOL or a stricter worker cap", () => {
    expect(maximumOfferPrice({ executor: null })).toBe(1_000_000_000n);
    expect(maximumOfferPrice({ executor: null, maxRewardLamports: null })).toBe(1_000_000_000n);
    expect(maximumOfferPrice({ executor: null, maxRewardLamports: 2_000_000_000n })).toBe(1_000_000_000n);
    expect(maximumOfferPrice({ executor: null, maxRewardLamports: 50n })).toBe(50n);
  });
  it("budgets the current job and rounds down rather than using minimum pay", () => {
    expect(jobPayCents(100_000_000n, 100)).toBe(1000);
    expect(jobPayCents(1_234_567n, 100)).toBe(12);
    expect(jobPayCents(100_000_000n, 80)).toBe(800);
  });
  it.each([null, NaN, Infinity, 0, -1])("never emits an empty or unlimited budget for rate %s", (rate) => {
    expect(() => jobPayCents(100_000_000n, rate)).toThrow(/spending limit/);
  });
  it("refuses sub-cent jobs rather than disabling the host limit with zero", () => {
    expect(() => jobPayCents(1n, 100)).toThrow(/spending limit/);
  });
  it("uses live rents and adds the advertised price's 10 percent claim deposit", async () => {
    const host = new EarnHost({
      chain: { getMinimumBalanceForRentExemption: async (space: number) => BigInt(space) } as Chain,
      services: {} as MarketServices,
      options: { executor: null },
      dataDir: "unused",
      log() {},
      notify() {},
    });
    expect((await host.jobReserve(1_000_000_000n)) - (await host.jobReserve(10_000_000n))).toBe(95_000_000n);
    expect(await host.jobDeposits()).toBe(203n + 273n);
  });
});
