// Weighing a record by money: a rating or a finished job counts in proportion
// to the marketplace fee its job really paid, and the ranking keeps the
// amount of proof in mind.
import { describe, expect, it } from "vitest";
import {
  EMPTY_RECORD,
  JOB_WEIGHT_CAP_LAMPORTS,
  NEUTRAL_STARS,
  compareRecords,
  isFirstPartyJob,
  jobWeight,
  tally,
  trustScore,
  type FirstParty,
  type PaidJob,
} from "../src/trust.js";

const SOL = 1_000_000_000n;
/** The live marketplace fee: 5% of the price. */
const FEE_BPS = 500n;

let next = 0;
/** A paid job at `price` lamports, with the fee the marketplace takes from it. */
function job(price: bigint, score: number | null, buyer = `buyer-${(next += 1)}`): PaidJob {
  return {
    task: `task-${(next += 1)}`,
    listing: "listing",
    provider: "provider",
    buyer,
    priceLamports: price,
    feeLamports: (price * FEE_BPS) / 10_000n,
    score,
  };
}

/** The cheapest job a buyer can rate on the live marketplace: 0.002 SOL. */
const TINY = (2n * SOL) / 1000n;
const SMALL = SOL / 100n;
const MEDIUM = SOL / 20n;
const LARGE = SOL;

describe("weighing a record by money", () => {
  it("a fake five-star rating on a tiny job weighs almost nothing", () => {
    const honest = Array.from({ length: 10 }, () => job(MEDIUM, 3));
    const before = tally(honest);
    const after = tally([...honest, job(TINY, 5)]);
    expect(before.rating).toBe(3);
    // The average a buyer reads barely moves...
    expect(after.rating! - before.rating!).toBeLessThan(0.02);
    expect(after.ratings).toBe(11);
    // ...and neither does the ranking.
    expect(after.score - before.score).toBeLessThan(0.01);
  });

  it("a lone five-star rating on a tiny job ranks next to a service nobody has rated", () => {
    const fake = tally([job(TINY, 5)]);
    // The person still sees what it is: one rating of five stars...
    expect(fake.rating).toBe(5);
    expect(fake.ratings).toBe(1);
    // ...but it ranks almost where a new service starts.
    expect(fake.score - EMPTY_RECORD.score).toBeLessThan(0.05);
    expect(EMPTY_RECORD.score).toBe(NEUTRAL_STARS);
  });

  it("many four-star jobs rank above one five-star job", () => {
    const one = tally([job(MEDIUM, 5)]);
    const many = tally([job(MEDIUM, 4), job(MEDIUM, 4), job(MEDIUM, 4)]);
    expect(compareRecords(many, one)).toBeLessThan(0);
    // Also when the five-star job was twenty times bigger: one job weighs at most so much.
    const big = tally([job(LARGE, 5)]);
    expect(compareRecords(many, big)).toBeLessThan(0);
    // Smaller four-star jobs too, once there is more money behind them.
    const smallMany = tally(Array.from({ length: 15 }, () => job(SMALL, 4)));
    expect(compareRecords(smallMany, one)).toBeLessThan(0);
  });

  it("a record of paid jobs ranks above one cheap five-star rating", () => {
    const paidWork = tally(Array.from({ length: 20 }, () => job(SMALL, null)));
    const fake = tally([job(TINY, 5)]);
    expect(paidWork.rating).toBeNull();
    expect(compareRecords(paidWork, fake)).toBeLessThan(0);
  });

  it("bad ratings rank below a service nobody has rated", () => {
    const bad = tally([job(MEDIUM, 1), job(MEDIUM, 2)]);
    expect(compareRecords(EMPTY_RECORD, bad)).toBeLessThan(0);
  });

  it("weighs each rating by the fee its job paid", () => {
    // 5 stars on a job that paid the capped fee, 1 star on one that paid a tenth of it.
    const record = tally([
      { ...job(MEDIUM, 5), feeLamports: JOB_WEIGHT_CAP_LAMPORTS },
      { ...job(MEDIUM, 1), feeLamports: JOB_WEIGHT_CAP_LAMPORTS / 10n },
    ]);
    expect(record.rating).toBeCloseTo((5 * 10 + 1) / 11, 10);
    expect(record.ratings).toBe(2);
  });

  it("counts what was paid, by how many buyers, never a bare count", () => {
    const record = tally([
      job(SMALL, 5, "alice"),
      job(SMALL, null, "alice"),
      job(MEDIUM, 4, "bob"),
      job(SMALL, null, "alice"),
    ]);
    expect(record.jobs).toBe(4);
    expect(record.buyers).toBe(2);
    expect(record.paidLamports).toBe(3n * SMALL + MEDIUM);
    expect(record.feeLamports).toBe(((3n * SMALL + MEDIUM) * FEE_BPS) / 10_000n);
  });

  it("leaves out a job that paid the marketplace nothing, and counts each job once", () => {
    const free = { ...job(SMALL, 5), feeLamports: 0n };
    const paid = job(SMALL, 2);
    const record = tally([free, paid, paid]);
    expect(record.jobs).toBe(1);
    expect(record.ratings).toBe(1);
    expect(record.rating).toBe(2);
  });

  it("ignores a score that is not one to five stars", () => {
    const record = tally([job(SMALL, 9), job(SMALL, 0)]);
    expect(record.ratings).toBe(0);
    expect(record.rating).toBeNull();
    expect(record.jobs).toBe(2);
  });

  it("caps what one job weighs", () => {
    expect(jobWeight(0n)).toBe(0n);
    expect(jobWeight(-5n)).toBe(0n);
    expect(jobWeight(100_000n)).toBe(100_000n);
    expect(jobWeight(JOB_WEIGHT_CAP_LAMPORTS * 20n)).toBe(JOB_WEIGHT_CAP_LAMPORTS);
  });

  it("ranks the record more money stands behind first when the scores are equal", () => {
    expect(compareRecords(EMPTY_RECORD, tally([]))).toBe(0);
    const a = { ...EMPTY_RECORD, feeLamports: 10n };
    const b = { ...EMPTY_RECORD, feeLamports: 20n };
    expect(compareRecords(a, b)).toBeGreaterThan(0);
    expect(trustScore([])).toBe(NEUTRAL_STARS);
  });
});

describe("the marketplace's own accounts", () => {
  const firstParty: FirstParty = {
    wallets: new Set(["treasury"]),
    agents: new Set(["house-agent"]),
    listings: new Set(["dogfood"]),
  };
  const base = { listing: "listing", provider: "provider", buyer: "stranger" };

  it("leaves out a job when they are on either side of it", () => {
    expect(isFirstPartyJob(base, "owner", firstParty)).toBe(false);
    expect(isFirstPartyJob({ ...base, buyer: "treasury" }, "owner", firstParty)).toBe(true);
    expect(isFirstPartyJob({ ...base, provider: "house-agent" }, "owner", firstParty)).toBe(true);
    expect(isFirstPartyJob(base, "treasury", firstParty)).toBe(true);
    expect(isFirstPartyJob({ ...base, listing: "dogfood" }, "owner", firstParty)).toBe(true);
    expect(isFirstPartyJob({ ...base, listing: null }, null, firstParty)).toBe(false);
  });
});
