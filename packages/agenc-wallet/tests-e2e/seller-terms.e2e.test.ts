import type { Address } from "@solana/kit";
import { values } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { readListing, readTask } from "../src/market.js";
import {
  DEFAULT_SELLER_TERMS,
  SELLER_CATEGORIES,
} from "../src/client/seller-terms.js";
import { eventually, startWorld, type World } from "./harness.js";

const earn = {
  executor: {
    argv: [process.execPath, "-e", "process.stdout.write('done')", "{prompt}"],
    mode: "sandboxed" as const,
    envAllowlist: [],
    timeoutMs: 10000,
  },
  pollIntervalMs: 150,
};
const service = {
  name: "Editing",
  summary: "A copy edit",
  price: { lamports: "3000999" },
};
let world: World;
afterEach(async () => {
  await world?.wallet.close();
});

it("quotes, publishes and reconciles the exact terms buyers see, including after restart", async () => {
  world = await startWorld({ earn });
  let wallet = world.wallet;
  const seller = await wallet.createAgent();
  const operator = await wallet.createAgent();
  const terms = {
    ...DEFAULT_SELLER_TERMS,
    category: "writing",
    inputs: ["Draft"],
    outputs: ["Edited copy"],
    tags: ["copy-edit"],
    maxOpenJobs: 4,
    deliverySecs: 7201,
    operator: operator.address,
    operatorFeeBps: 123,
  };
  const input = { ...service, terms };
  const before = await world.balance(wallet.mainAddress);
  const quote = await wallet.quoteEarn(seller.id, input);
  expect(await world.balance(wallet.mainAddress)).toBe(before);
  expect(quote).toMatchObject({
    offerPrice: { lamports: "3000999" },
    sellerTerms: terms,
    proceeds: { operatorFee: { lamports: "36912" } },
  });
  const attempts = await Promise.allSettled([
    wallet.setOffer(seller.id, input, undefined, quote.quoteId),
    wallet.setOffer(seller.id, input, undefined, quote.quoteId),
  ]);
  expect(attempts.map((r) => r.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(before - (await world.balance(wallet.mainAddress))).toBe(
    BigInt(quote.totalFromMain.lamports),
  );
  const startup = await wallet.quoteEarn(seller.id, undefined, undefined, 10);
  await wallet.setEarn(seller.id, true, 10, startup.quoteId);
  const live = async () =>
    eventually(async () => {
      await wallet.tick();
      const offer = (await wallet.overview()).agents.find(
        (agent) => agent.id === seller.id,
      )?.earn.offer;
      return offer?.status === "live" ? offer : null;
    });
  const offer = await live();
  const listing = offer.listing as Address;
  expect(await readListing(world.sandbox.chain, listing)).toMatchObject({
    maxOpenJobs: 4,
    defaultDeadlineSecs: 7201n,
    operatorFeeBps: 123,
    operator: operator.address,
  });
  const buyer = (await wallet.find({ query: "copy edit" })).services.find(
    (row) => row.listing === listing,
  )!;
  expect(buyer).toMatchObject({
    tags: terms.tags,
    category: terms.category,
    inputs: terms.inputs,
    outputs: terms.outputs,
    price: quote.offerPrice,
    proceeds: quote.proceeds,
    deliverySecs: 7201,
    maxOpenJobs: 4,
  });
  expect(BigInt(buyer.proceeds!.sellerNet!.lamports)).toBe(
    3000999n - 36912n - BigInt(buyer.marketFee!.amount.lamports),
  );
  await expect(
    wallet.quoteEarn(
      seller.id,
      { ...input, terms: { category: "research" } },
      offer.id,
    ),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const customer = await wallet.createAgent("Customer");
  await wallet.fundAgent(customer.id, { usdCents: 500 });
  await wallet.setPolicy(customer.id, {
    askAboveCents: 100,
    refill: { enabled: false, topUpToCents: 0, perDayCents: 0 },
  });
  const { job } = await wallet.hire({
    agentId: customer.id,
    listing,
    request: "Edit this paragraph.",
  });
  const task = (await readTask(world.sandbox.chain, job.task as Address))!;
  expect(task).toMatchObject({
    rewardAmount: 3000999n,
    operator: operator.address,
    operatorFeeBps: 123,
  });
  expect(task.deadline - task.createdAt).toBe(7201n);
  const change = {
    ...service,
    terms: {
      deliverySecs: 1800,
      tags: ["proof"],
      operator: null,
      operatorFeeBps: 0,
    },
  };
  const revised = await wallet.quoteEarn(seller.id, change, offer.id);
  await wallet.setOffer(seller.id, change, offer.id, revised.quoteId);
  await live();
  await wallet.close();
  wallet = world.wallet = await world.reopen();
  await live();
  const account = (await readListing(world.sandbox.chain, listing))!;
  expect(account).toMatchObject({
    maxOpenJobs: 4,
    defaultDeadlineSecs: 1800n,
    operatorFeeBps: 0,
    price: 3000999n,
  });
  expect(values.decodeListingTags(new Uint8Array(account.tags))).toEqual([
    "proof",
  ]);
  expect((await wallet.find({ query: "proof" })).services[0]).toMatchObject({
    outputs: terms.outputs,
    inputs: terms.inputs,
    tags: ["proof"],
  });
}, 60000);

it("refuses expired, changed and unaffordable confirmations before enabling or saving", async () => {
  world = await startWorld({ earn, mainLamports: 2000000n });
  const { wallet, clock } = world;
  const seller = await wallet.createAgent();
  const before = await world.balance(wallet.mainAddress);
  const expired = await wallet.quoteEarn(seller.id);
  clock.now = expired.expiresAt;
  await expect(
    wallet.setEarn(seller.id, true, undefined, expired.quoteId),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const wrong = await wallet.quoteEarn(seller.id, service);
  await expect(
    wallet.setOffer(
      seller.id,
      { ...service, terms: { maxOpenJobs: 3 } },
      undefined,
      wrong.quoteId,
    ),
  ).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  const insufficient = await wallet.quoteEarn(seller.id, service);
  await expect(
    wallet.setOffer(seller.id, service, undefined, insufficient.quoteId),
  ).rejects.toMatchObject({ code: "NOT_ENOUGH_MONEY" });
  const startup = await wallet.quoteEarn(seller.id);
  await expect(
    wallet.setEarn(seller.id, true, undefined, startup.quoteId),
  ).rejects.toMatchObject({ code: "NOT_ENOUGH_MONEY" });
  expect((await wallet.overview()).agents[0]?.earn).toMatchObject({
    enabled: false,
    offers: [],
  });
  expect(await world.balance(wallet.mainAddress)).toBe(before);
});

it("validates the same terms before quoting and saving", async () => {
  world = await startWorld({ earn });
  const { wallet } = world;
  const seller = await wallet.createAgent();
  expect(SELLER_CATEGORIES).toEqual(values.LISTING_CATEGORIES);
  for (const terms of [
    { maxOpenJobs: -1 },
    { maxOpenJobs: 65536 },
    { deliverySecs: 0 },
    { operatorFeeBps: 1 },
    { operatorFeeBps: 2001 },
    { operator: "bad" },
    { tags: ["too long"] },
    { inputs: [""] },
    { outputs: ["x".repeat(161)] },
    { category: "invalid" },
  ]) {
    await expect(
      wallet.quoteEarn(seller.id, { ...service, terms }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      wallet.setOffer(seller.id, { ...service, terms }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
});
