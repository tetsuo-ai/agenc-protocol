import path from "node:path";
import { getBase64EncodedWireTransaction, getSignatureFromTransaction, type Address } from "@solana/kit";
import { StateStore } from "../src/store.js";
import { findClaimPda, findEscrowPda, findTaskPda, findTaskSubmissionPda, values } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { fixedPrice } from "../src/pricing.js";
import { checkHireOperator } from "../src/payable-operator.js";
import { readListing, readProtocolConfig, readTask } from "../src/market.js";
import {
  DEFAULT_SELLER_TERMS,
  SELLER_CATEGORIES,
} from "../src/client/seller-terms.js";
import { confirmPayout, REVIEW_ALLOWANCE, eventually, startWorld, type World } from "./harness.js";

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
    refill: REVIEW_ALLOWANCE,
  });
  const { approval } = await wallet.hire({
    agentId: customer.id,
    listing,
    request: "Edit this paragraph.",
  });
  const job = await wallet.decideApproval(approval!.id, true);
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
  await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: { ...REVIEW_ALLOWANCE, perDayCents: 10_000 } });
  const before = await world.balance(wallet.mainAddress);
  const jobs = [];
  for (let i = 0; i < 6; i++) {
    const { approval } = await wallet.hire({ agentId: buyer.id, listing, request: "Edit paragraph " + i });
    expect(approval?.terms?.hire).toMatchObject({
      operator: operator.address, operatorFeeBps: 123, operatorFee: { lamports: "36912" },
      minimumSellerNet: { lamports: "2814038" }, minimumSellerNetIfOperatorCannotReceive: { lamports: "2850950" },
    });
    const job = await wallet.decideApproval(approval!.id, true);
    jobs.push(job.id);
    await eventually(async () => (await wallet.getJob(job.id, true)).status === "delivered");
  }
  expect(await world.balance(wallet.mainAddress)).toBe(before);
  await expect(wallet.hire({ agentId: buyer.id, listing, request: "Seventh hire" })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  const lower = await wallet.quoteEarn(seller.id, { ...service, terms: { maxOpenJobs: 2 } }, offer.id);
  expect(lower.capacity).toEqual({ open: 6, proposed: 2, pausing: true });
  const chain = world.sandbox.chain;
  const { treasury } = await readProtocolConfig(chain);
  const listingAccount = (await readListing(chain, listing as Address))!;
  for (const [index, id] of jobs.slice(0, 2).entries()) {
    if (index) await wallet.fundAgent(operator.id, { usdCents: 100 });
    const job = await wallet.getJob(id, true);
    const split = job.terms!.hire!;
    const [claim] = await findClaimPda({ task: job.task as Address, bidder: listingAccount.providerAgent });
    const [submission] = await findTaskSubmissionPda({ claim });
    const [operatorBefore, treasuryBefore, sellerBefore, claimReturn, submissionReturn] =
      await Promise.all([operator.address, treasury, seller.address, claim, submission].map(key => world.balance(key))) as [bigint, bigint, bigint, bigint, bigint];
    const paid = await confirmPayout(wallet, id);
    const credited = index ? BigInt(split.operatorFee.lamports) : 0n;
    const sellerNet = index ? split.minimumSellerNet.lamports : split.minimumSellerNetIfOperatorCannotReceive.lamports;
    expect(await world.balance(operator.address) - operatorBefore).toBe(credited);
    expect(await world.balance(treasury) - treasuryBefore).toBe(BigInt(split.maximumMarketplaceFee.lamports));
    expect(await world.balance(seller.address) - sellerBefore - claimReturn - submissionReturn).toBe(BigInt(sellerNet));
    expect(paid.operatorPayment).toMatchObject({ address: operator.address,
      paid: { lamports: String(credited) }, forfeited: { lamports: String(BigInt(split.operatorFee.lamports) - credited) },
      sellerNet: { lamports: sellerNet } });
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

it("keeps the rounded-zero operator split in the preview and paid receipt after cleanup", async () => {
  world = await startWorld({ earn, config: { prices: fixedPrice(2000) } });
  const { wallet } = world;
  const seller = await wallet.createAgent("Seller");
  const operator = await wallet.createAgent("Operator");
  const buyer = await wallet.createAgent("Buyer");
  const input = { ...service, price: { lamports: "9000" }, terms: { operator: operator.address, operatorFeeBps: 1 } };
  const quote = await wallet.quoteEarn(seller.id, input);
  const proceeds = { operatorFee: { lamports: "0" }, marketFee: { lamports: "450" }, sellerNet: { lamports: "8550" } };
  expect(quote.proceeds).toMatchObject(proceeds);
  await wallet.setOffer(seller.id, input, undefined, quote.quoteId);
  const startup = await wallet.quoteEarn(seller.id);
  await wallet.setEarn(seller.id, true, undefined, startup.quoteId);
  const listing = await eventually(async () => {
    await wallet.tick();
    const offer = (await wallet.overview()).agents.find(a => a.id === seller.id)?.earn.offer;
    return offer?.status === "live" && offer.listing;
  });
  const preview = (await wallet.find({ query: service.name })).services.find(row => row.listing === listing);
  expect(preview).toMatchObject({ operator: operator.address, operatorFeeBps: 1, proceeds });
  await wallet.fundAgent(buyer.id, { lamports: "500000000" });
  await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: { ...REVIEW_ALLOWANCE, perDayCents: 10_000 } });
  const { approval } = await wallet.hire({ agentId: buyer.id, listing, request: "Edit my paragraph." });
  const job = await wallet.decideApproval(approval!.id, true);
  await eventually(async () => (await wallet.getJob(job.id, true)).status === "delivered");
  const before = await world.balance(operator.address);
  const paid = await confirmPayout(wallet, job.id);
  expect(await world.balance(operator.address)).toBe(before);
  const receipt = { address: operator.address, paid: { lamports: "0" }, forfeited: { lamports: "0" }, sellerNet: { lamports: "8550" } };
  expect(paid.operatorPayment).toMatchObject(receipt);
  world.clock.now += 2 * 3600_000;
  await wallet.tick();
  expect(await readTask(world.sandbox.chain, job.task as Address)).toBeNull();
  expect((await wallet.getJob(job.id, true)).operatorPayment).toMatchObject(receipt);
}, 30_000);

it("switches Earns off and withdraws an unrelated live offer while an offer transfer is pending", async () => {
  let loseNextReply = false;
  let heldSignature: string | undefined;
  world = await startWorld({
    earn,
    transport: base => ({
      ...base,
      async sendAndConfirm(tx) {
        if (!loseNextReply) return base.sendAndConfirm(tx);
        loseNextReply = false;
        heldSignature = getSignatureFromTransaction(tx);
        await base.sendAndConfirm(tx);
        throw new Error("Lost the funding confirmation");
      },
    }),
    chain: base => ({
      ...base,
      listingSendOutcome: receipt => receipt.signature === heldSignature ? Promise.resolve("pending") : base.listingSendOutcome!(receipt),
    }),
  });
  const { wallet } = world;
  const seller = await wallet.createAgent();
  const startup = await wallet.quoteEarn(seller.id);
  await wallet.setEarn(seller.id, true, undefined, startup.quoteId);
  await eventually(async () => {
    await wallet.tick();
    return (await wallet.overview()).agents[0]!.earn.state === "watching";
  });
  const publish = async (name: string) => {
    const input = { ...service, name };
    const quote = await wallet.quoteEarn(seller.id, input);
    await wallet.setOffer(seller.id, input, undefined, quote.quoteId);
    return eventually(async () => {
      await wallet.tick();
      return (await wallet.overview()).agents[0]!.earn.offers.find(o => o.name === name && o.status === "live");
    });
  };
  const editing = await publish("Editing");
  const proof = await publish("Proofreading");
  const edit = { ...service, terms: { maxOpenJobs: 6 } };
  const quote = await wallet.quoteEarn(seller.id, edit, editing.id);
  expect(BigInt(quote.fromMain.lamports)).toBeGreaterThan(0n);
  loseNextReply = true;
  await expect(wallet.setOffer(seller.id, edit, editing.id, quote.quoteId)).rejects.toMatchObject({ code: "NETWORK" });
  await expect(wallet.setOffer(seller.id, null, editing.id)).rejects.toMatchObject({ code: "NETWORK" });
  const spent = await world.balance(wallet.mainAddress);
  const withdrawn = await wallet.setOffer(seller.id, null, proof.id);
  expect(withdrawn.earn.offers.find(o => o.id === proof.id)).toMatchObject({ wanted: false, status: "paused" });
  expect(await readListing(world.sandbox.chain, proof.listing as Address)).toMatchObject({ state: 1 });
  expect((await wallet.setEarn(seller.id, false)).earn.enabled).toBe(false);
  await expect(wallet.setOffer(seller.id, edit, editing.id, quote.quoteId)).rejects.toMatchObject({ code: "NETWORK" });
  heldSignature = undefined;
  await wallet.tick();
  const recovered = await wallet.setOffer(seller.id, edit, editing.id, quote.quoteId);
  expect(recovered.earn.enabled).toBe(false);
  expect(recovered.earn.offers.find(o => o.id === proof.id)).toMatchObject({ wanted: false });
  expect(recovered.earn.offers.find(o => o.id === editing.id)).toMatchObject({ terms: { maxOpenJobs: 6 } });
  expect(await world.balance(wallet.mainAddress)).toBe(spent);
}, 30_000);

it("binds a cold-room quote to one seller setup across a wallet restart", async () => {
  world = await startWorld({ earn });
  const seller = await world.wallet.createAgent();
  const input = { ...service, setupId: "room-setup-one", enableEarns: true as const };
  const initial = await world.balance(world.wallet.mainAddress);
  const stale = await world.wallet.quoteEarn(seller.id, input);
  await world.wallet.close();
  world.wallet = await world.reopen();
  await expect(world.wallet.approveEarnFunding(stale.quoteId)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  await expect(world.wallet.setOffer(seller.id, { ...input, setupId: "changed-room" }, undefined, stale.quoteId))
    .rejects.toMatchObject({ code: "PRICE_CHANGED" });
  expect(await world.balance(world.wallet.mainAddress)).toBe(initial);
  const quote = await world.wallet.quoteEarn(seller.id, input);
  await world.wallet.close();
  world.wallet = await world.reopen();
  const confirm = () => world.wallet.setOffer(seller.id, input, undefined, quote.quoteId);
  expect((await confirm()).earn.enabled).toBe(true);
  expect((await confirm()).earn.offers).toHaveLength(1);
  expect(initial - await world.balance(world.wallet.mainAddress)).toBe(BigInt(quote.totalFromMain.lamports));
});
