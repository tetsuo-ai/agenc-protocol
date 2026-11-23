import path from "node:path";
import { getBase64EncodedWireTransaction, getSignatureFromTransaction, type Address } from "@solana/kit";
import { StateStore } from "../src/store.js";
import { findEscrowPda, findTaskPda, values } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { checkHireOperator } from "../src/payable-operator.js";
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
  world = await startWorld({
    earn,
    services: (services) => ({
      ...services,
      async listServices() {
        const rows = await services.listServices();
        return rows.map(
          ({
            operatorFeeBps: _fee,
            maxOpenJobs: _capacity,
            operator: _operator,
            ...row
          }) => row,
        );
      },
    }),
  });
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
  await expect(wallet.setOffer(seller.id, input)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
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
    "fulfilled",
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
    listingVersion: (await readListing(world.sandbox.chain, listing))!.version.toString(),
    operator: operator.address, operatorFeeBps: 123,
    price: quote.offerPrice,
    proceeds: quote.proceeds,
    deliverySecs: 7201,
    maxOpenJobs: 4,
  });
  expect(buyer.proceeds?.marketFee).toEqual(buyer.marketFee?.amount);
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
  const change = {
    ...service,
    terms: {
      deliverySecs: 1800,
      tags: ["proof"],
      operatorFeeBps: 234,
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
    operator: operator.address,
    operatorFeeBps: 234,
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
    operatorFeeBps: 234,
  });
  expect(task.deadline - task.createdAt).toBe(1800n);
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
    { operator: "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK", operatorFeeBps: 1 },
    { operator: "Stake11111111111111111111111111111111111111", operatorFeeBps: 1 },
    { operator: "SysvarC1ock11111111111111111111111111111111", operatorFeeBps: 1 },
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

it("publishes for an agent already earning and pauses for a lower capacity with one approval", async () => {
  world = await startWorld({ earn });
  const { wallet } = world;
  const seller = await wallet.createAgent();
  const startup = await wallet.quoteEarn(seller.id);
  await wallet.setEarn(seller.id, true, undefined, startup.quoteId);
  await eventually(async () => {
    await wallet.tick();
    return (await wallet.overview()).agents[0]?.earn.state === "watching";
  });

  const publish = async (maxOpenJobs: number, id?: string) => {
    const input = { ...service, terms: { maxOpenJobs } };
    const before = await world.balance(wallet.mainAddress);
    const quote = await wallet.quoteEarn(seller.id, input, id);
    await wallet.setOffer(seller.id, input, id, quote.quoteId);
    const live = await eventually(async () => {
      await wallet.tick();
      const offer = (await wallet.overview()).agents[0]!.earn.offer;
      if (offer?.status === "problem") throw new Error(offer.statusText);
      return offer?.status === "live" ? offer : null;
    });
    expect(before - (await world.balance(wallet.mainAddress))).toBe(
      BigInt(quote.totalFromMain.lamports),
    );
    expect(
      await readListing(world.sandbox.chain, live.listing as Address),
    ).toMatchObject({ maxOpenJobs: maxOpenJobs || 5 });
    return live;
  };
  const offer = await publish(0);
  await publish(2, offer.id);
}, 60000);

it.each(["landed", "delayed", "expired"] as const)("recovers a signed seller transfer with a lost response (%s)", async (outcome) => {
  let intercept = false;
  let pending = true;
  let broadcasts = 0;
  let deliverOriginal: (() => Promise<void>) | undefined;
  let delivered = false;
  world = await startWorld({ earn, transport: (base) => ({
    ...base, async sendAndConfirm(tx) {
      if (!intercept) return base.sendAndConfirm(tx);
      broadcasts++;
      // This is the first instruction that could broadcast. Inspect only the test journal.
      const journal = StateStore.open(path.join(world.dataDir, "state.json")).state;
      const receipt = Object.values(journal.agents)[0]!.earn.pendingListingSends![0]!;
      expect(receipt.signedTransaction).toBe(getBase64EncodedWireTransaction(tx));
      expect(receipt.signature).toBe(getSignatureFromTransaction(tx));
      expect(receipt.operation).toMatchObject({ kind: "funding", decision: { effect: { offer: { name: service.name } } } });
      if (outcome === "landed") await base.sendAndConfirm(tx);
      if (outcome === "delayed") deliverOriginal = async () => {
        await base.sendAndConfirm(tx);
        delivered = true;
      };
      throw new Error("Connection closed before confirmation");
    },
  }), chain: (base) => ({
    ...base, listingSendOutcome: (r) => pending ? Promise.resolve("pending") : delivered ? Promise.resolve("landed") : base.listingSendOutcome!(r),
  }) });
  const seller = await world.wallet.createAgent();
  const before = await world.balance(world.wallet.mainAddress);
  const q = await world.wallet.quoteEarn(seller.id, service);
  intercept = true;
  await expect(world.wallet.setOffer(seller.id, service, undefined, q.quoteId)).rejects.toMatchObject({ code: "NETWORK" });
  const second = await world.wallet.quoteEarn(seller.id, service);
  await expect(world.wallet.setOffer(seller.id, service, undefined, second.quoteId)).rejects.toMatchObject({ code: "NETWORK" });
  await world.wallet.close();
  world.wallet = await world.reopen();
  await expect(world.wallet.setOffer(seller.id, service, undefined, q.quoteId)).rejects.toMatchObject({ code: "NETWORK" });
  await deliverOriginal?.();
  pending = false;
  await world.wallet.tick();
  const replay = () => world.wallet.setOffer(seller.id, service, undefined, q.quoteId);
  if (outcome !== "expired") {
    expect((await replay()).earn.offers).toHaveLength(1);
    expect((await replay()).earn.offers).toHaveLength(1);
    await expect(world.wallet.setOffer(seller.id, { ...service, summary: "Different" }, undefined, q.quoteId))
      .rejects.toMatchObject({ code: "PRICE_CHANGED" });
    expect(before - await world.balance(world.wallet.mainAddress)).toBe(BigInt(q.totalFromMain.lamports));
  } else {
    await expect(replay()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await world.wallet.overview()).agents[0]!.earn.offers).toHaveLength(0);
    expect(await world.balance(world.wallet.mainAddress)).toBe(before);
  }
  expect(broadcasts).toBe(1);
});

it("funds concurrent deliveries and reports both possible operator credits from settlement", async () => {
  world = await startWorld({ earn });
  const { wallet } = world;
  const seller = await wallet.createAgent("Editor");
  const operator = await wallet.createAgent("Operator");
  const buyer = await wallet.createAgent("Buyer");
  const startup = await wallet.quoteEarn(seller.id);
  await wallet.setEarn(seller.id, true, undefined, startup.quoteId);
  await eventually(async () => {
    await wallet.tick();
    return (await wallet.overview()).agents.find((a) => a.id === seller.id)?.earn.state === "watching";
  });
  const input = { ...service, terms: { maxOpenJobs: 6, operator: operator.address, operatorFeeBps: 123 } };
  const q = await wallet.quoteEarn(seller.id, input);
  const one = await wallet.quoteEarn(seller.id, { ...input, terms: { ...input.terms, maxOpenJobs: 1 } });
  expect(BigInt(q.workingReserve.lamports)).toBeGreaterThan(BigInt(one.workingReserve.lamports));
  await wallet.setOffer(seller.id, input, undefined, q.quoteId);
  const offer = await eventually(async () => {
    await wallet.tick();
    const o = (await wallet.overview()).agents.find((a) => a.id === seller.id)?.earn.offer;
    return o?.status === "live" && o;
  });
  const listing = offer.listing!;
  await wallet.fundAgent(buyer.id, { usdCents: 2000 });
  await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: { enabled: false, topUpToCents: 0, perDayCents: 0 } });
  const before = await world.balance(wallet.mainAddress);
  const jobs = [];
  for (let i = 0; i < 6; i++) {
    const { job } = await wallet.hire({ agentId: buyer.id, listing, request: "Edit paragraph " + i });
    jobs.push(job.id);
    await eventually(async () => (await wallet.getJob(job.id, true)).status === "delivered");
  }
  expect(await world.balance(wallet.mainAddress)).toBe(before);
  await expect(wallet.hire({ agentId: buyer.id, listing, request: "Seventh hire" })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  const lower = await wallet.quoteEarn(seller.id, { ...service, terms: { maxOpenJobs: 2 } }, offer.id);
  expect(lower.capacity).toEqual({ open: 6, proposed: 2, pausing: true });
  for (const [index, id] of jobs.slice(0, 2).entries()) {
    if (index) await wallet.fundAgent(operator.id, { usdCents: 100 });
    const initial = await world.balance(operator.address);
    const paid = await wallet.approveJob(id, undefined, true);
    const credited = index ? 36912n : 0n;
    expect(await world.balance(operator.address) - initial).toBe(credited);
    expect(paid.operatorPayment).toMatchObject({ address: operator.address,
      paid: { lamports: credited.toString() }, forfeited: { lamports: (36912n - credited).toString() },
      sellerNet: { lamports: (3000999n - 150049n - credited).toString() } });
  }
}, 60_000);

it("declines a buyer-specific operator conflict before creating an approval", async () => {
  world = await startWorld({ earn });
  const { wallet } = world;
  const seller = await wallet.createAgent();
  const buyer = await wallet.createAgent();
  const input = { ...service, terms: { operator: wallet.mainAddress, operatorFeeBps: 123 } };
  const quote = await wallet.quoteEarn(seller.id, input);
  await wallet.setOffer(seller.id, input, undefined, quote.quoteId);
  const on = await wallet.quoteEarn(seller.id);
  await wallet.setEarn(seller.id, true, undefined, on.quoteId);
  const listing = await eventually(async () => {
    await wallet.tick();
    const offer = (await wallet.overview()).agents.find(a => a.id === seller.id)?.earn.offer;
    return offer?.status === "live" && offer.listing;
  });
  const before = await world.balance(wallet.mainAddress);
  await expect(wallet.hire({ agentId: buyer.id, listing, request: "One edit" })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  expect((await wallet.overview()).pendingApprovals).toBe(0);
  expect(await world.balance(wallet.mainAddress)).toBe(before);
});


it("checks the buyer, derived task and escrow against the operator", async () => {
  world = await startWorld({ earn });
  const payer = world.wallet.mainAddress;
  const taskId = values.randomId32();
  const [task] = await findTaskPda({ creator: payer, taskId });
  const [escrow] = await findEscrowPda({ task });
  for (const payee of [payer, task, escrow]) {
    await expect(checkHireOperator(payee, 5, payer, taskId)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  }
});

it("requires new approval on a changed transfer even within the allowance", async () => {
  world = await startWorld({ earn });
  const { wallet } = world;
  const seller = await wallet.createAgent();
  await wallet.setPolicy(seller.id, { askAboveCents: 5000, refill: { enabled: true, topUpToCents: 0, perDayCents: 5000 } });
  const quote = await wallet.quoteEarn(seller.id, service);
  expect(quote.requiresApproval).toBe(false);
  world.sandbox.fund(seller.address as Address, 2_000_000n);
  const before = await world.balance(wallet.mainAddress);
  await expect(wallet.setOffer(seller.id, service, undefined, quote.quoteId)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  expect(await world.balance(wallet.mainAddress)).toBe(before);
  expect((await wallet.overview()).agents[0]!.earn.offers).toHaveLength(0);
});
