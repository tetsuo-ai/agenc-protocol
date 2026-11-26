import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import {
  createMarketplaceClient, findProtocolConfigPda, getProtocolConfigDecoder, getProtocolConfigEncoder,
  getServiceListingEncoder, getTaskDecoder,
} from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { WalletError } from "../src/errors.js";
import { ceilingLamports, fractionalQuoteUsd } from "../src/job-money.js";
import { readListing } from "../src/market.js";
import type { WalletState } from "../src/store.js";
import { CENT, SOL, startWorld, type World } from "./harness.js";

let world: World;
afterEach(async () => { await world?.wallet.close(); });

const request = "Check the poem.";
const post = { request, reward: { usdCents: 100 } };

it("reserves simultaneous all-in hires against carried funds, including after restart", async () => {
  world = await startWorld();
  const { wallet, sandbox, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  sandbox.fund(agent.address as Address, SOL);
  const input = { agentId: agent.id, listing, request };
  const quoted = await wallet.hire(input, true);
  const cap = Math.ceil(quoted.approval!.total!.usdCents!);
  expect(cap).toBeGreaterThan(2 * quoted.approval!.price.usdCents!);
  await wallet.setBudget(agent.id, cap);
  const pair = await Promise.all(["a", "b"].map(idempotencyKey => wallet.hire({ ...input, idempotencyKey })));
  expect(pair.map(result => result.job.status).sort()).toEqual(["needs_approval", "waiting"]);
  await wallet.close();
  world.wallet = await world.reopen();
  const third = await world.wallet.hire({ ...input, idempotencyKey: "c" });
  expect(third.approval?.fromMain.lamports).toBe("0");
  expect((await world.wallet.decideApproval(third.approval!.id, true)).status).toBe("waiting");
});

it("keeps recent agent spending from an older journal subject to approval", async () => {
  world = await startWorld();
  const { wallet, sandbox, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  sandbox.fund(agent.address as Address, SOL);
  await wallet.setBudget(agent.id, 1000);
  const input = { agentId: agent.id, listing, request };
  expect((await wallet.hire(input)).job.status).toBe("waiting");
  await wallet.close();
  const file = join(world.dataDir, "state.json");
  const old: WalletState = JSON.parse(readFileSync(file, "utf8"));
  delete old.agents[agent.id]!.jobSpends;
  writeFileSync(file, JSON.stringify(old));
  world.wallet = await world.reopen();
  expect((await world.wallet.hire(input)).job.status).toBe("needs_approval");
});

it("requires an owner decision after a budget cut during publication", async () => {
  let cut = async () => {};
  world = await startWorld({ services: base => ({
    ...base, async publishJobSpec(input) { await cut(); return base.publishJobSpec(input); },
  }) });
  const { wallet, sandbox } = world;
  const agent = await wallet.createAgent("Buyer");
  sandbox.fund(agent.address as Address, SOL);
  await wallet.setBudget(agent.id, 500);
  cut = async () => { await wallet.setBudget(agent.id, 1); };
  const before = await world.balance(agent.address);
  const result = await wallet.post({ ...post, agentId: agent.id });
  expect(result.job.status).toBe("needs_approval");
  expect(await world.balance(agent.address)).toBe(before);
  expect((await wallet.decideApproval(result.approval!.id, true)).status).toBe("waiting");
});

// A dollar reward is converted once, at the quote. The quoted lamports and the quote's expiry bind,
// so a SOL/USD move before the approval or the funding neither refuses the post nor changes the lamports.
it.each(["approval", "funding"])("posts a dollar reward at its quoted lamports when SOL/USD moves before %s", async stage => {
  let rate = 100;
  world = await startWorld({ config: { prices: { solUsd: async () => rate } }, services: base => ({
    ...base, async publishJobSpec(input) { rate = 200; return base.publishJobSpec(input); },
  }) });
  const { wallet } = world;
  const quote = (await wallet.quotePost(post)).approval!;
  expect(quote.maxPriceCents).toBe(100);
  expect(quote.price.lamports).toBe("10000000");
  const before = await world.balance(wallet.mainAddress);
  if (stage === "approval") rate = 200;
  const job = await wallet.decideApproval(quote.id, true);
  expect(job.status).toBe("waiting");
  expect(job.price.lamports).toBe(quote.price.lamports);
  const moved = before - await world.balance(wallet.mainAddress);
  expect(moved).toBeGreaterThanOrEqual(BigInt(quote.price.lamports));
  expect(moved).toBeLessThanOrEqual(BigInt(quote.fromMain.lamports));
});

it("still refuses a contest when SOL/USD rose after its quote", async () => {
  let rate = 100;
  world = await startWorld({ config: { prices: { solUsd: async () => rate } } });
  const { wallet, sandbox } = world;
  const quote = (await wallet.quotePost({ ...post, contestEntries: 3, deadline: await sandbox.chain.clusterTime() + 900, reviewWindowSecs: 60 })).approval!;
  const before = await world.balance(wallet.mainAddress);
  rate = 101;
  await expect(wallet.decideApproval(quote.id, true)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  expect(await world.balance(wallet.mainAddress)).toBe(before);
});

it("bounds a first automatic refund with configured priority fees and live cancellation rent", async () => {
  const transactionFee = 5_250n;
  world = await startWorld({ chain: (base, sandbox) => ({
    ...base, transferFeeLamports: transactionFee,
    clientFor: signer => createMarketplaceClient({ signer, transport: sandbox.market.transport, computeUnitPrice: 1000n, computeUnitLimit: 250_000 }),
  }) });
  const { wallet, sandbox } = world;
  const before = await world.balance(wallet.mainAddress);
  const quote = (await wallet.quotePost({ ...post, deadlineDays: 1 })).approval!;
  expect(quote.cancellationRent!.lamports).toBe((await sandbox.chain.getMinimumBalanceForRentExemption(129)).toString());
  expect(quote.networkFees!.lamports).toBe((4n * transactionFee + 10_000n).toString());
  const job = await wallet.decideApproval(quote.id, true);
  expect(job.status).toBe("waiting");
  expect(before - await world.balance(wallet.mainAddress)).toBeLessThanOrEqual(BigInt(quote.fromMain.lamports));
  sandbox.advanceClock(86401);
  await wallet.tick();
  await wallet.tick();
  expect((await wallet.getJob(job.id, true)).status).toBe("refunded");
  expect(before - await world.balance(wallet.mainAddress)).toBe(BigInt(quote.fees.lamports));
});

it("funds exactly the quoted price on an operator listing within the quoted main contribution", async () => {
  const transactionFee = 5_250n;
  world = await startWorld({ chain: (base, sandbox) => ({
    ...base, transferFeeLamports: transactionFee,
    clientFor: signer => createMarketplaceClient({ signer, transport: sandbox.market.transport, computeUnitPrice: 1000n, computeUnitLimit: 250_000 }),
  }) });
  const { wallet, sandbox, listing } = world;
  const buyer = await wallet.createAgent("Buyer");
  const operator = await wallet.createAgent("Operator");
  const row = (await readListing(sandbox.chain, listing))!;
  const raw = sandbox.market.svm.getAccount(listing);
  if (!raw.exists) throw new Error("Missing sandbox listing");
  sandbox.market.svm.setAccount({ ...raw, data: new Uint8Array(getServiceListingEncoder().encode({
    ...row, operator: operator.address as Address, operatorFeeBps: 100,
  })) });
  const quote = (await wallet.hire({ agentId: buyer.id, listing, request }, true)).approval!;
  expect(quote.networkFees!.lamports).toBe((4n * transactionFee + 10_000n).toString());
  const before = await world.balance(wallet.mainAddress);
  const funded = await wallet.decideApproval(quote.id, true);
  expect(funded.status).toBe("waiting");
  const task = getTaskDecoder().decode((await sandbox.chain.readAccount(funded.task as Address))!);
  expect(task.rewardAmount).toBe(BigInt(quote.price.lamports));
  expect(task.operatorFeeBps).toBe(100);
  expect(task.operator).toBe(quote.terms!.hire!.operator);
  expect(before - await world.balance(wallet.mainAddress)).toBeLessThanOrEqual(BigInt(quote.fromMain.lamports));
});

it("keeps a keyed outcome after pruning and restart, rejecting a changed replay", async () => {
  world = await startWorld();
  let wallet = world.wallet;
  const agent = await wallet.createAgent("Buyer");
  const input = { agentId: agent.id, listing: world.listing, request, idempotencyKey: "retained" };
  const quote = await wallet.hire(input);
  const placed = await wallet.decideApproval(quote.approval!.id, true);
  await wallet.refundJob(placed.id, true);
  await wallet.tick();
  await wallet.close();
  const file = join(world.dataDir, "state.json");
  const state: WalletState = JSON.parse(readFileSync(file, "utf8"));
  const existing = state.jobs[placed.id]!;
  for (let n = 0; n < 500; n++) {
    const id = "later-" + n;
    state.jobs[id] = { ...existing, id, idempotencyKey: null, updatedAt: existing.updatedAt + 1 };
  }
  writeFileSync(file, JSON.stringify(state));
  wallet = world.wallet = await world.reopen();
  await wallet.renameAgent(agent.id, "Buyer again");
  expect(JSON.parse(readFileSync(file, "utf8")).jobs[placed.id]).toBeUndefined();
  await wallet.close();
  wallet = world.wallet = await world.reopen();
  const before = await world.balance(wallet.mainAddress);
  expect((await wallet.callOutcome(agent.id, "hire", input.idempotencyKey)).job).toMatchObject({ id: placed.id, task: placed.task, status: "refunded" });
  expect((await wallet.hire(input)).job.id).toBe(placed.id);
  await expect(wallet.hire({ ...input, request: "Another job" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await world.balance(wallet.mainAddress)).toBe(before);
});

it("refuses stale search prices, cached descriptions and a changed listing after quote", async () => {
  let stale = true;
  world = await startWorld({ services: base => ({ ...base, listServices: async () =>
    (await base.listServices()).map(row => stale ? { ...row, specHashHex: "00".repeat(32) } : row) }) });
  const { wallet, sandbox, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  const input = { agentId: agent.id, request, listing };
  await expect(wallet.hire(input, true)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  stale = false;
  await expect(wallet.hire({ ...input, expectedPriceLamports: (19n * CENT).toString() }, true)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  const quote = (await wallet.hire(input, true)).approval!;
  const row = (await readListing(sandbox.chain, listing))!;
  const raw = sandbox.market.svm.getAccount(listing);
  sandbox.market.svm.setAccount({ ...raw, data: new Uint8Array(getServiceListingEncoder().encode({ ...row, price: 21n * CENT })) } as never);
  const before = await world.balance(wallet.mainAddress);
  await expect(wallet.decideApproval(quote.id, true)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  expect(await world.balance(wallet.mainAddress)).toBe(before);
});

it.each(["NETWORK", "NOT_ALLOWED"] as const)("ends a cleared safety-check refusal safely (%s)", async code => {
  let blocked = true;
  const publish = vi.fn();
  world = await startWorld({ services: base => ({
    ...base, async trustedModerators() {
      if (blocked) throw new WalletError(code, "Gate unavailable");
      return base.trustedModerators();
    }, async publishJobSpec(input) { publish(); return base.publishJobSpec(input); },
  }) });
  const { wallet, clock } = world;
  const agent = await wallet.createAgent("Buyer");
  const quote = (await wallet.hire({ agentId: agent.id, listing: world.listing, request }, true)).approval!;
  const result = await wallet.decideApproval(quote.id, true);
  expect(result.status).toBe(code === "NETWORK" ? "starting" : "failed");
  blocked = false;
  clock.now = quote.expiresAt + 1;
  await wallet.tick();
  expect((await wallet.getJob(result.id, true)).status).toBe("failed");
  expect(publish).not.toHaveBeenCalled();
});

it("refuses a mutable default clock even if the protocol duration changes before execution", async () => {
  world = await startWorld();
  const { wallet, sandbox, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  const row = (await readListing(sandbox.chain, listing))!;
  const quote = (await wallet.hire({ agentId: agent.id, listing, request }, true)).approval!;
  const raw = sandbox.market.svm.getAccount(listing);
  sandbox.market.svm.setAccount({ ...raw, data: new Uint8Array(getServiceListingEncoder().encode({ ...row, defaultDeadlineSecs: 0n })) } as never);
  const [config] = await findProtocolConfigPda();
  const account = sandbox.market.svm.getAccount(config)!;
  if (!account.exists) throw new Error("Missing sandbox protocol configuration");
  const current = getProtocolConfigDecoder().decode(new Uint8Array(account.data));
  sandbox.market.svm.setAccount({ ...account, data: new Uint8Array(getProtocolConfigEncoder().encode({ ...current, maxClaimDuration: 3601n })) } as never);
  expect((await wallet.decideApproval(quote.id, true)).status).toBe("failed");
  await expect(wallet.hire({ agentId: agent.id, listing, request }, true)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
});

it("rotates an unpriced request's ID once, without approving the new quote", async () => {
  let rate: number | null = null;
  world = await startWorld({ config: { prices: { solUsd: async () => rate } } });
  const { wallet, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  const first = (await wallet.hire({ agentId: agent.id, listing, request })).approval!;
  expect(first.price.usdCents).toBeNull();
  await expect(wallet.decideApproval(first.id, true)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  rate = 100;
  const { approval } = await wallet.refreshApproval(first.id);
  expect(approval).toMatchObject({ jobId: first.jobId, price: { usdCents: 20 } });
  expect(approval.id).not.toBe(first.id);
  await expect(wallet.decideApproval(first.id, true)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  expect((await wallet.listApprovals()).map(q => q.id)).toEqual([approval.id]);
  expect((await wallet.decideApproval(approval.id, true)).status).toBe("waiting");
});

it("rounds fractional price ceilings down to lamports, including exact decimal boundaries", () => {
  expect(ceilingLamports(19.9, 100)).toBe(1_990_000n);
  expect(ceilingLamports(19.999999, 100)).toBe(1_999_999n);
  expect(ceilingLamports(5002, 50.02)).toBe(SOL);
  expect(fractionalQuoteUsd(1_990_000n, 100)).toBe("0.199");
  expect(fractionalQuoteUsd(1n, 71.64297517)).toBe("0.00000007164297517");
});

// rt9 bug 2: a first post carries the payer's marketplace record, kept for good, and says how much of the rent it is.
it("names the first job's marketplace record in the quote, and not on the next job", async () => {
  world = await startWorld();
  const { wallet } = world;
  const first = (await wallet.quotePost(post)).approval!;
  expect(BigInt(first.firstRecordRent!.lamports)).toBeGreaterThan(0n);
  expect(BigInt(first.firstRecordRent!.lamports)).toBeLessThanOrEqual(BigInt(first.retainedRent!.lamports));
  expect((await wallet.decideApproval(first.id, true)).status).toBe("waiting");
  const next = (await wallet.quotePost(post)).approval!;
  expect(next.firstRecordRent).toBeUndefined();
  expect(BigInt(first.retainedRent!.lamports) - BigInt(next.retainedRent!.lamports)).toBe(BigInt(first.firstRecordRent!.lamports));
});
