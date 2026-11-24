// On mainnet the dollar price comes from Pyth and is read fresh at every step,
// so it differs between the quote and the payment. A quote binds its lamport
// price and its expiry. A dollar limit binds only when the buyer gave one, and
// an agent's daily allowance counts the purchase at the higher of the two rates.
import { address } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { allowanceRate } from "../src/job-quote.js";
import { microcents } from "../src/job-money.js";
import { SOL, startWorld, type World } from "./harness.js";

let w: World | undefined;
afterEach(async () => { await w?.wallet.close(); w = undefined; });

const FUNDED = /^(waiting|working|hired|active)$/;
const LIMIT = "The service costs more than the price limit.";

/** SOL/USD multiplied by `factor` on every fresh read. */
function driftingPrice(factor: number) {
  let rate = 100;
  return { solUsd: async (options?: { fresh?: boolean }) => {
    if (options?.fresh) rate = Math.round(rate * factor * 1e6) / 1e6;
    return rate;
  } };
}

/** SOL/USD that stays at 100 for the next fresh read after `arm()`, then moves to `later`. */
function steppingPrice(later: number) {
  let reads = -1;
  return { arm: () => { reads = 0; }, solUsd: async (options?: { fresh?: boolean }) => {
    if (reads < 0) return 100;
    if (options?.fresh) reads++;
    return reads > 1 ? later : 100;
  } };
}

async function decide(id: string) {
  return w!.wallet.decideApproval(id, true).then(job => ({ status: job.status as string, error: job.error ?? null }),
    error => ({ status: "refused", error: (error as Error).message }));
}

describe.each([["up", 1.0001], ["down", 0.9999], ["up by 3%", 1.03], ["down by 3%", 0.97]])("SOL/USD drifting %s between quote and payment", (_name, factor) => {
  it("lets the owner approve a hire and moves no more than the quoted lamports", async () => {
    w = await startWorld({ config: { prices: driftingPrice(factor) } });
    const { wallet } = w;
    const agent = await wallet.createAgent("Buyer");
    const quote = await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem." });
    const before = await w.balance(wallet.mainAddress);
    expect(await decide(quote.approval!.id)).toEqual({ status: expect.stringMatching(FUNDED), error: null });
    const moved = before - await w.balance(wallet.mainAddress);
    expect(moved).toBeGreaterThanOrEqual(BigInt(quote.approval!.price.lamports));
    expect(moved).toBeLessThanOrEqual(BigInt(quote.approval!.fromMain.lamports));
    expect((await wallet.getJob(quote.job.id)).price.lamports).toBe(quote.approval!.price.lamports);
  });

  it("lets an agent within its allowance hire and moves no more than the quoted lamports", async () => {
    w = await startWorld({ config: { prices: driftingPrice(factor) } });
    const { wallet, sandbox } = w;
    const agent = await wallet.createAgent("Buyer");
    await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: { enabled: true, topUpToCents: 0, perDayCents: 1000 } });
    sandbox.fund(address(agent.address), SOL);
    const reference = (await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem." }, true)).approval!;
    const before = await w.balance(agent.address);
    const main = await w.balance(wallet.mainAddress);
    const hired = await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem." });
    expect({ approval: hired.approval?.id ?? null, status: hired.job.status, error: hired.job.error ?? null })
      .toEqual({ approval: null, status: expect.stringMatching(FUNDED), error: null });
    const moved = before - await w.balance(agent.address);
    expect(moved).toBeGreaterThanOrEqual(BigInt(reference.price.lamports));
    expect(moved).toBeLessThanOrEqual(BigInt(reference.total.lamports));
    expect(await w.balance(wallet.mainAddress)).toBe(main);
  });

  it.each([["dollar", { usdCents: 100 }], ["SOL", { lamports: "3000000" }]])("lets the owner post a %s-priced request at the quoted lamports", async (_kind, reward) => {
    w = await startWorld({ config: { prices: driftingPrice(factor) } });
    const { wallet } = w;
    const quote = await wallet.quotePost({ request: "Write one poem about the sea.", reward });
    const before = await w.balance(wallet.mainAddress);
    expect(await decide(quote.approval!.id)).toEqual({ status: expect.stringMatching(FUNDED), error: null });
    const moved = before - await w.balance(wallet.mainAddress);
    expect(moved).toBeGreaterThanOrEqual(BigInt(quote.approval!.price.lamports));
    expect(moved).toBeLessThanOrEqual(BigInt(quote.approval!.fromMain.lamports));
    expect((await wallet.getJob(quote.job.id)).price.lamports).toBe(quote.approval!.price.lamports);
  });
});

it("still refuses the owner when the price passes a dollar limit the buyer gave", async () => {
  w = await startWorld({ config: { prices: driftingPrice(1.0001) } });
  const { wallet } = w;
  const agent = await wallet.createAgent("Buyer");
  // The listing costs 2,000,000 lamports: 20.002 cents at the first fresh read, more at the next.
  const quote = await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem.", maxPriceCents: 20.002 });
  const before = await w.balance(wallet.mainAddress);
  expect(await decide(quote.approval!.id)).toEqual({ status: "refused", error: LIMIT });
  expect(await w.balance(wallet.mainAddress)).toBe(before);
});

it("still refuses an agent hire when the price passes a dollar limit the agent gave", async () => {
  w = await startWorld({ config: { prices: driftingPrice(1.0001) } });
  const { wallet, sandbox } = w;
  const agent = await wallet.createAgent("Buyer");
  await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: { enabled: true, topUpToCents: 0, perDayCents: 1000 } });
  sandbox.fund(address(agent.address), SOL);
  const before = await w.balance(agent.address);
  const hired = await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem.", maxPriceCents: 20.002 });
  expect({ status: hired.job.status, error: hired.job.error ?? null }).toEqual({ status: "failed", error: LIMIT });
  expect(await w.balance(agent.address)).toBe(before);
});

it("keeps an explicit limit that the drifting price stays under", async () => {
  w = await startWorld({ config: { prices: driftingPrice(1.0001) } });
  const { wallet } = w;
  const agent = await wallet.createAgent("Buyer");
  const quote = await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem.", maxPriceCents: 25 });
  expect(await decide(quote.approval!.id)).toEqual({ status: expect.stringMatching(FUNDED), error: null });
});

it("asks the owner when a purchase fits the daily allowance at the quote's rate but not at the payment's", async () => {
  const prices = steppingPrice(110);
  w = await startWorld({ config: { prices } });
  const { wallet, sandbox } = w;
  const agent = await wallet.createAgent("Buyer");
  sandbox.fund(address(agent.address), SOL);
  await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: { enabled: true, topUpToCents: 0, perDayCents: 1000 } });
  const reference = (await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem." }, true)).approval!;
  const total = BigInt(reference.total.lamports);
  // The whole day's allowance is exactly this purchase at the quote's rate.
  const perDayCents = Number((microcents(total, 100) + 999_999n) / 1_000_000n);
  expect(microcents(total, 110)).toBeGreaterThan(BigInt(perDayCents) * 1_000_000n);
  await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: { enabled: true, topUpToCents: 0, perDayCents } });
  const before = await w.balance(agent.address);
  prices.arm();
  const hired = await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem." });
  expect({ status: hired.job.status, asked: hired.approval !== null }).toEqual({ status: "needs_approval", asked: true });
  expect((await wallet.listApprovals()).map(approval => approval.id)).toContain(hired.approval!.id);
  expect(await w.balance(agent.address)).toBe(before);
  // The owner can still say yes, and the same lamports move.
  expect(await decide(hired.approval!.id)).toEqual({ status: expect.stringMatching(FUNDED), error: null });
  expect(before - await w.balance(agent.address)).toBeLessThanOrEqual(total);
});

it("lets the same purchase through on its own when the rate does not move", async () => {
  const prices = steppingPrice(100);
  w = await startWorld({ config: { prices } });
  const { wallet, sandbox } = w;
  const agent = await wallet.createAgent("Buyer");
  sandbox.fund(address(agent.address), SOL);
  await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: { enabled: true, topUpToCents: 0, perDayCents: 1000 } });
  const reference = (await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem." }, true)).approval!;
  const perDayCents = Number((microcents(BigInt(reference.total.lamports), 100) + 999_999n) / 1_000_000n);
  await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: { enabled: true, topUpToCents: 0, perDayCents } });
  prices.arm();
  const hired = await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem." });
  expect({ status: hired.job.status, approval: hired.approval?.id ?? null }).toEqual({ status: expect.stringMatching(FUNDED), approval: null });
});

it("counts a purchase against the day at the quote's rate when SOL/USD fell before the payment", async () => {
  const prices = steppingPrice(50);
  w = await startWorld({ config: { prices } });
  const { wallet, sandbox } = w;
  const agent = await wallet.createAgent("Buyer");
  sandbox.fund(address(agent.address), SOL);
  await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: { enabled: true, topUpToCents: 0, perDayCents: 1000 } });
  const reference = (await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem." }, true)).approval!;
  // Room for one purchase at the quote's rate, and for two at the lower rate.
  const perDayCents = Number((microcents(BigInt(reference.total.lamports), 100) + 999_999n) / 1_000_000n);
  expect(2n * microcents(BigInt(reference.total.lamports), 50)).toBeLessThanOrEqual(BigInt(perDayCents) * 1_000_000n);
  await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: { enabled: true, topUpToCents: 0, perDayCents } });
  prices.arm();
  const first = await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem." });
  expect({ status: first.job.status, approval: first.approval?.id ?? null }).toEqual({ status: expect.stringMatching(FUNDED), approval: null });
  const before = await w.balance(agent.address);
  const second = await wallet.hire({ agentId: agent.id, listing: w.listing, request: "A second poem." });
  expect(second.job.status).toBe("needs_approval");
  expect(await w.balance(agent.address)).toBe(before);
});

it("charges the allowance at the higher of the quoted and the current rate", () => {
  expect(allowanceRate(100, 101)).toBe(101);
  expect(allowanceRate(101, 100)).toBe(101);
  expect(allowanceRate(100, null)).toBe(100);
  expect(allowanceRate(100, undefined)).toBe(100);
});
