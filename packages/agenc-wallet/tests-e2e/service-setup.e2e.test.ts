import { afterEach, expect, it } from "vitest";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { startWorld, eventually, REVIEW_ALLOWANCE, type World } from "./harness.js";
import { StateStore } from "../src/store.js";

let world: World;
afterEach(async () => { await world?.wallet.close(); });
it("commits one setup across restart, ignores unrelated available work, and serves a verified hire from the same wallet on its own harness", async () => {
  const earn = { executor: { argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", "{requestSource}", "{prompt}"],
    mode: "sandboxed" as const, envAllowlist: [], timeoutMs: 10000 }, pollIntervalMs: 50 };
  world = await startWorld({ earn });
  const seller = await world.wallet.createAgent();
  const buyer = await world.wallet.createAgent();
  const open = await world.sandbox.postOpenJob({ title: "Unrelated", instructions: "Write a line.", rewardLamports: 5000000n });
  const input = { setupId: "cold-setup", enableEarns: true as const, name: "Own harness", summary: "Report the verified source.", price: { lamports: "3000000" } };
  const quote = await world.wallet.quoteEarn(seller.id, input);
  const before = await world.balance(world.wallet.mainAddress);
  expect(BigInt(quote.sellerFunding!.lockedStake.lamports)).toBeGreaterThan(0n);
  expect(quote.sellerFunding!.reclaimNow.lamports).toBe("0");
  await world.wallet.close(); world.wallet = await world.reopen();
  await world.wallet.setOffer(seller.id, input, undefined, quote.quoteId);
  expect(StateStore.open(path.join(world.dataDir, "state.json")).state.agents[seller.id]!.earn.chooseOpenJobs).toBe(true);
  const receipt = world.wallet.sellerSetup(seller.id, input.setupId)!;
  expect(receipt.fundedLamports).toBe(quote.fromMain.lamports);
  await world.wallet.close(); world.wallet = await world.reopen();
  await world.wallet.setOffer(seller.id, input, undefined, quote.quoteId);
  expect(before - await world.balance(world.wallet.mainAddress)).toBe(BigInt(quote.totalFromMain.lamports));
  await expect(world.wallet.quoteEarn(seller.id, { ...input, summary: "Another version" })).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  const listing = await eventually(async () => { await world.wallet.tick(); const state = world.wallet.sellerSetup(seller.id, input.setupId); return state?.stage === "live" ? state.listing : null; });
  await world.wallet.fundAgent(buyer.id, { usdCents: 500 });
  await world.wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: REVIEW_ALLOWANCE });
  const { job } = await world.wallet.hire({ agentId: buyer.id, listing, request: "Who paid?" });
  const delivery = await eventually(async () => { const j = await world.wallet.getJob(job.id, true); return j.status === "delivered" ? j : null; });
  expect(delivery.result?.text).toBe("own");
  const workerState = path.join(world.dataDir, "earn", seller.id, "state.json");
  if (existsSync(workerState)) expect(readFileSync(workerState, "utf8")).not.toContain(String(open.task));
  expect((await world.wallet.listJobs({ role: "working" }, true)).map(j => j.task)).not.toContain(open.task);
}, 60000);

it("keeps a different wallet's hire unclaimed on the seller's own harness", async () => {
  const earn = { executor: { argv: [process.execPath, "-e", "process.stdout.write('own harness')", "{prompt}"],
    mode: "sandboxed" as const, envAllowlist: [], timeoutMs: 10000 }, pollIntervalMs: 50 };
  let refused!: () => void;
  const rejected = new Promise<void>(resolve => { refused = resolve; });
  world = await startWorld({ earn, config: { log: line => { if (line.includes("requires the isolated job room")) refused(); } } });
  const seller = await world.wallet.createAgent();
  const input = { setupId: "other-wallet", enableEarns: true as const, name: "Isolated hire", summary: "Write a line.", price: { usdCents: 30 } };
  const quote = await world.wallet.quoteEarn(seller.id, input);
  await world.wallet.setOffer(seller.id, input, undefined, quote.quoteId);
  const listing = await eventually(async () => { await world.wallet.tick(); const s = world.wallet.sellerSetup(seller.id, input.setupId); return s?.stage === "live" ? s.listing : null; });
  const other = await world.reopen({ dataDir: path.join(world.dataDir, "other-person"), earn: { executor: null } });
  try {
    world.sandbox.fund(other.mainAddress, 2_000_000_000n);
    const buyer = await other.createAgent();
    await other.fundAgent(buyer.id, { usdCents: 500 });
    await other.setPolicy(buyer.id, { askAboveCents: 100, refill: REVIEW_ALLOWANCE });
    const { job } = await other.hire({ agentId: buyer.id, listing, request: "Other person" });
    await rejected;
    expect((await other.getJob(job.id, true)).status).not.toBe("delivered");
    expect((await world.wallet.listJobs({ role: "working" }, true)).map(j => j.task)).not.toContain(job.task);
  } finally { await other.close(); }
}, 30000);

it("accepts the approved setup after a small rate move, and refuses one the new rate leaves without a model budget", async () => {
  let rate = 100;
  const earn = { executor: { argv: [process.execPath, "-e", "process.stdout.write('done')", "{prompt}"],
    mode: "sandboxed" as const, envAllowlist: [], timeoutMs: 10000 }, pollIntervalMs: 50 };
  world = await startWorld({ earn, config: { prices: { solUsd: async () => rate } } });
  const seller = await world.wallet.createAgent();
  const input = { setupId: "rate-move", enableEarns: true as const, name: "Rate move", summary: "Write a line.", price: { lamports: "3000000" } };
  const quote = await world.wallet.quoteEarn(seller.id, input);
  const before = await world.balance(world.wallet.mainAddress);
  // The quote's dollar figures, including the model budget, came from this rate.
  expect(quote.serviceAdmission!.modelBudgetCents).toBeGreaterThan(0);
  rate = 100.37;
  await world.wallet.setOffer(seller.id, input, undefined, quote.quoteId);
  expect(world.wallet.sellerSetup(seller.id, input.setupId)!.fundedLamports).toBe(quote.fromMain.lamports);
  expect(before - await world.balance(world.wallet.mainAddress)).toBe(BigInt(quote.totalFromMain.lamports));

  const other = await world.wallet.createAgent();
  rate = 100;
  const second = { ...input, setupId: "rate-crash", name: "Rate crash" };
  const quoted = await world.wallet.quoteEarn(other.id, second);
  const kept = await world.balance(world.wallet.mainAddress);
  rate = 1;
  await expect(world.wallet.setOffer(other.id, second, undefined, quoted.quoteId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await world.balance(world.wallet.mainAddress)).toBe(kept);
}, 60000);
