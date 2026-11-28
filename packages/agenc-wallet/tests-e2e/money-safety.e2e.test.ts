import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EarnHost } from "../src/earn.js";
import { connectWallet } from "../src/client/socket-client.js";
import { serveWallet } from "../src/server.js";
import { readListing } from "../src/market.js";
import type { Address } from "@solana/kit";
import { CENT, SOL, eventually, setEarnWithApproval, startWorld, type World } from "./harness.js";

const EARN = {
  executor: {
    argv: [process.execPath, "-e", "process.stdout.write('pay=' + process.argv[1])", "{pay}", "{prompt}"],
    mode: "sandboxed" as const,
    envAllowlist: [],
    timeoutMs: 10_000,
  },
  pollIntervalMs: 100,
  serviceRefreshMs: 250,
};
const OFFER = { name: "Writer", summary: "Write one line.", price: { lamports: "1000000000" } };
let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});
async function view(id: string) {
  return (await world!.wallet.overview()).agents.find((a) => a.id === id)!;
}
async function live(id: string) {
  return eventually(async () => {
    await world!.wallet.tick();
    const a = await view(id);
    return a.earn.offer?.status === "live" ? a : null;
  }, 15_000);
}
function charges(id: string) {
  return JSON.parse(readFileSync(path.join(world!.dataDir, "state.json"), "utf8")).agents[id].refills as {
    lamports: string;
    usdCents: number;
  }[];
}

describe("selling money safety", () => {
  it("quotes all startup and offer funding without moving money, and approval is single use", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet } = world;
    const a = await wallet.createAgent();
    const before = await world.balance(wallet.mainAddress);
    const q = await wallet.quoteEarn(a.id, OFFER);
    expect(await world.balance(wallet.mainAddress)).toBe(before);
    expect(await world.balance(a.address)).toBe(0n);
    expect(q.requiresApproval).toBe(true);
    const sum = [q.registration, q.listings, q.checks, q.workingReserve, q.networkReserve].reduce(
      (s, v) => s + BigInt(v.lamports),
      0n,
    );
    expect(BigInt(q.fromMain.lamports)).toBe(sum);
    expect(BigInt(q.totalFromMain.lamports)).toBe(sum + BigInt(q.transferFee.lamports));
    expect(BigInt(q.workingReserve.lamports)).toBeGreaterThan(100_000_000n);
    await expect(wallet.setEarn(a.id, true)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(await world.balance(wallet.mainAddress)).toBe(before);
    await wallet.approveEarnFunding(q.quoteId);
    await expect(wallet.approveEarnFunding(q.quoteId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await wallet.setOffer(a.id, OFFER);
    await wallet.setEarn(a.id, true, 10);
    await live(a.id);
    expect(before - (await world.balance(wallet.mainAddress))).toBe(BigInt(q.totalFromMain.lamports));
    expect(charges(a.id)).toHaveLength(1);
  }, 30_000);

  it("uses one rolling allowance for refills and concurrent earning attempts, including transfer fees", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet, clock } = world;
    const a = await wallet.createAgent();
    await wallet.setBudget(a.id, 300);
    const before = await world.balance(wallet.mainAddress);
    await Promise.allSettled([wallet.setEarn(a.id, true), wallet.setEarn(a.id, true), wallet.tick()]);
    expect(await world.balance(wallet.mainAddress)).toBe(before);
    expect(charges(a.id).reduce((s, c) => s + BigInt(c.lamports), 0n)).toBe(300n * CENT);
    await wallet.confirmTransfer((await wallet.quoteTransfer({ kind: "reclaim", agentId: a.id, amount: "all" })).id);
    await wallet.tick();
    expect(await world.balance(wallet.mainAddress)).toBeGreaterThanOrEqual(before);
    clock.now += 86_400_001;
    await wallet.tick();
    expect((await view(a.id)).balance.usdCents).toBe(299.95);
  });

  it("serializes automatic startup against refill and another startup within one cap", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet } = world;
    const a = await wallet.createAgent();
    const q = await wallet.quoteEarn(a.id);
    const cap = Math.ceil(q.totalFromMain.usdCents!);
    await wallet.setPolicy(a.id, {
      askAboveCents: cap,
      refill: { enabled: true, topUpToCents: cap, perDayCents: cap },
    });
    const before = await world.balance(wallet.mainAddress);
    await Promise.allSettled([wallet.setEarn(a.id, true), wallet.tick(), wallet.setEarn(a.id, true)]);
    const moved = before - (await world.balance(wallet.mainAddress));
    expect(moved).toBeGreaterThan(0n);
    expect(moved).toBeLessThanOrEqual(BigInt(cap) * CENT);
    expect(charges(a.id).reduce((s, c) => s + BigInt(c.lamports), 0n)).toBe(moved);
  });

  it("counts automatic listing funding and refuses rewording and maintenance beyond the cap", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet } = world;
    const a = await wallet.createAgent();
    const small = { ...OFFER, price: { lamports: "3000000" } };
    await wallet.setOffer(a.id, small);
    const q = await wallet.quoteEarn(a.id);
    const cap = Math.ceil(q.totalFromMain.usdCents!);
    await wallet.setPolicy(a.id, { askAboveCents: cap, refill: { enabled: true, topUpToCents: 1, perDayCents: cap } });
    await wallet.setEarn(a.id, true, 10);
    await live(a.id);
    expect(charges(a.id).length).toBeGreaterThan(0);
    await wallet.confirmTransfer((await wallet.quoteTransfer({ kind: "reclaim", agentId: a.id, amount: "all" })).id);
    const before = await world.balance(wallet.mainAddress);
    await wallet.setOffer(a.id, { ...small, summary: "Write two lines." });
    await wallet.tick();
    await wallet.tick();
    expect(await world.balance(wallet.mainAddress)).toBe(before);
    expect((await view(a.id)).earn.offer?.statusText).toMatch(/approval/);
    const reword = await wallet.quoteEarn(a.id);
    expect(reword.requiresApproval).toBe(true);
    await wallet.approveEarnFunding(reword.quoteId);
    await live(a.id);
    expect(charges(a.id).reduce((s, c) => s + c.usdCents, 0)).toBeGreaterThan(cap);
  }, 30_000);

  it("tries offer funding once across ticks and restart, then once after owner approval", async () => {
    world = await startWorld({ earn: EARN });
    const seller = await world.wallet.createAgent();
    const offer = { ...OFFER, price: { lamports: "3000000" } };
    await world.wallet.setOffer(seller.id, offer);
    await setEarnWithApproval(world.wallet, seller.id, true);
    await live(seller.id);
    await world.wallet.reclaimFromAgent(seller.id, { lamports: "1000000" });

    // Defer the price update to housekeeping. Each funding quote reads the job deposits once.
    using attempts = vi.spyOn(EarnHost.prototype, "jobDeposits");
    attempts.mockRejectedValueOnce(new Error("Marketplace temporarily offline"));
    const changed = { ...offer, price: { lamports: "5000000" } };
    await world.wallet.setOffer(seller.id, changed);
    attempts.mockClear();
    for (let tick = 0; tick < 3; tick++) await world.wallet.tick();
    const problem = { status: "problem", statusText: expect.stringMatching(/funding needs your approval/i) };
    expect((await view(seller.id)).earn.offer).toMatchObject(problem);
    expect(attempts).toHaveBeenCalledTimes(1);

    await world.wallet.close();
    world.wallet = await world.reopen();
    await world.wallet.setOffer(seller.id, changed);
    await world.wallet.tick();
    expect((await view(seller.id)).earn.offer).toMatchObject(problem);
    expect(attempts).toHaveBeenCalledTimes(1);

    const quote = await world.wallet.quoteEarn(seller.id);
    expect(quote.requiresApproval).toBe(true);
    attempts.mockClear();
    await world.wallet.approveEarnFunding(quote.quoteId);
    const resumed = await live(seller.id);
    for (let tick = 0; tick < 3; tick++) await world.wallet.tick();
    expect(attempts).toHaveBeenCalledTimes(1);
    expect(await readListing(world.sandbox.chain, resumed.earn.offer!.listing as Address)).toMatchObject({ price: 5000000n });
  });

  it("retries only the edited offer until earning is switched off and on", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet } = world;
    const seller = await wallet.createAgent();
    await setEarnWithApproval(wallet, seller.id, true);
    const first = { ...OFFER, price: { lamports: "3000000" } };
    const second = { ...first, name: "Editor" };
    await wallet.setOffer(seller.id, first);
    await wallet.setOffer(seller.id, second);
    const statuses = async () => (await view(seller.id)).earn.offers.map((offer) => offer.status);
    await eventually(async () => {
      await wallet.tick();
      return (await statuses()).every((status) => status === "problem");
    });

    const quote = await wallet.quoteEarn(seller.id);
    await wallet.fundAgent(seller.id, { lamports: quote.fromMain.lamports });
    await wallet.tick();
    expect(await statuses()).toEqual(["problem", "problem"]);
    await wallet.setOffer(seller.id, { ...first, summary: "Write two lines." });
    await wallet.tick();
    expect(await statuses()).toEqual(["live", "problem"]);

    await wallet.setEarn(seller.id, false);
    await wallet.setEarn(seller.id, true);
    await eventually(async () => {
      await wallet.tick();
      return (await statuses()).every((status) => status === "live");
    });
  });

  it("persists a reservation before an ambiguous transfer and does not retry outside the cap", async () => {
    let fail = true;
    world = await startWorld({
      earn: EARN,
      chain: (chain) => ({
        ...chain,
        clientFor(signer) {
          const client = chain.clientFor(signer);
          return new Proxy(client, {
            get(target, key) {
              if (key !== "send") return Reflect.get(target, key);
              return async (...args: Parameters<typeof client.send>) => {
                if (fail) {
                  fail = false;
                  throw new Error("unknown broadcast outcome");
                }
                return client.send(...args);
              };
            },
          });
        },
      }),
    });
    const { wallet } = world;
    const a = await wallet.createAgent();
    const q = await wallet.quoteEarn(a.id);
    const cap = Math.ceil(q.totalFromMain.usdCents!);
    await wallet.setPolicy(a.id, { askAboveCents: cap, refill: { enabled: true, topUpToCents: 1, perDayCents: cap } });
    await expect(wallet.setEarn(a.id, true)).rejects.toMatchObject({ code: "NETWORK" });
    expect(charges(a.id)).toHaveLength(1);
    await wallet.close();
    world.wallet = await world.reopen();
    await expect(world.wallet.setEarn(a.id, true)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(charges(a.id)).toHaveLength(1);
    expect(await world.balance(a.address)).toBe(0n);
  });

  it("does not share one agent's allowance or quote with another and expires old quotes", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet, clock } = world;
    const a = await wallet.createAgent();
    const b = await wallet.createAgent();
    const q = await wallet.quoteEarn(a.id, OFFER);
    q.agentId = b.id; // Mutating a returned view cannot change the stored authorization.
    await wallet.approveEarnFunding(q.quoteId);
    expect(await world.balance(b.address)).toBe(0n);
    await expect(wallet.setEarn(b.id, true)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const old = await wallet.quoteEarn(b.id);
    clock.now += 5 * 60_000;
    await expect(wallet.approveEarnFunding(old.quoteId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects SOL and dollar prices above the worker cap, including edits", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet } = world;
    const a = await wallet.createAgent();
    for (const price of [{ lamports: (SOL + 1n).toString() }, { usdCents: 10_001 }]) {
      await expect(wallet.setOffer(a.id, { ...OFFER, price })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(wallet.quoteEarn(a.id, { ...OFFER, price })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    const saved = await wallet.setOffer(a.id, OFFER);
    await expect(
      wallet.setOffer(a.id, { ...OFFER, price: { lamports: (SOL + 1n).toString() } }, saved.earn.offer!.id),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await view(a.id)).earn.offer!.price.lamports).toBe(SOL.toString());
  });

  it("keeps legacy oversized offers paused after a restart", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet, dataDir } = world;
    const a = await wallet.createAgent();
    await wallet.approveEarnFunding((await wallet.quoteEarn(a.id, OFFER)).quoteId);
    await wallet.setOffer(a.id, OFFER);
    await wallet.setEarn(a.id, true, 10);
    const ready = await live(a.id);
    await wallet.close();
    const file = path.join(dataDir, "state.json");
    const journal = JSON.parse(readFileSync(file, "utf8"));
    journal.agents[a.id].earn.offers[0].priceLamports = "2000000000";
    writeFileSync(file, JSON.stringify(journal));
    world.wallet = await world.reopen();
    const before = await world.balance(world.wallet.mainAddress);
    await world.wallet.tick();
    expect((await view(a.id)).earn.offer).toMatchObject({
      status: "problem",
      statusText: expect.stringMatching(/reward limit/),
    });
    expect(Number((await readListing(world.sandbox.chain, ready.earn.offer!.listing as Address))!.state)).toBe(1);
    expect(await world.balance(world.wallet.mainAddress)).toBe(before);
  });

  it("funds and delivers a 1 SOL hire, and caps the executor at the seller's net", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet } = world;
    const seller = await wallet.createAgent();
    const buyer = await wallet.createAgent();
    const quote = await wallet.quoteEarn(seller.id, OFFER);
    await wallet.approveEarnFunding(quote.quoteId);
    await wallet.setOffer(seller.id, OFFER);
    await wallet.setEarn(seller.id, true, 10);
    const ready = await live(seller.id);
    await wallet.fundAgent(buyer.id, { lamports: (2n * SOL).toString() });
    await wallet.setPolicy(buyer.id, {
      askAboveCents: 20_000,
      refill: { enabled: false, topUpToCents: 0, perDayCents: 100_000 },
    });
    const { job } = await wallet.hire({
      agentId: buyer.id,
      listing: ready.earn.offer!.listing!,
      request: "Write one line.",
    });
    const delivered = await eventually(async () => {
      const j = await wallet.getJob(job.id, true);
      return j.status === "delivered" ? j : null;
    });
    expect(delivered.result?.text).toBe("pay=9500");
  }, 30_000);

  it("takes a cheap own service hire while refusing an equally cheap open job", async () => {
    let attempts = 0;
    world = await startWorld({ earn: EARN, chain: base => ({ ...base, clientFor(signer) {
      const client = base.clientFor(signer);
      return Object.create(client, { claimTaskWithJobSpec: { value: async (...args: Parameters<typeof client.claimTaskWithJobSpec>) => {
        attempts++;
        // Let a routine listing refresh fire with this admitted claim still in flight.
        await new Promise(resolve => setTimeout(resolve, 600));
        return client.claimTaskWithJobSpec(...args);
      } } }) as typeof client;
    } }) });
    const { wallet, sandbox } = world;
    const seller = await wallet.createAgent();
    const buyer = await wallet.createAgent();
    const small = { ...OFFER, price: { lamports: "3000000" } };
    await wallet.approveEarnFunding((await wallet.quoteEarn(seller.id, small)).quoteId);
    await wallet.setOffer(seller.id, small);
    await wallet.setEarn(seller.id, true, 100);
    const ready = await live(seller.id);
    const open = await sandbox.postOpenJob({
      title: "Cheap open work",
      instructions: "Write one line.",
      rewardLamports: 30n * CENT,
    });
    await wallet.fundAgent(buyer.id, { usdCents: 500 });
    await wallet.setPolicy(buyer.id, {
      askAboveCents: 500,
      refill: { enabled: false, topUpToCents: 0, perDayCents: 10000 },
    });
    const { job } = await wallet.hire({
      agentId: buyer.id,
      listing: ready.earn.offer!.listing!,
      request: "Write a line.",
    });
    await eventually(async () => (await wallet.getJob(job.id, true)).status === "delivered");
    expect(await open.delivered()).toBe(false);
    expect(attempts).toBe(1);
  }, 30_000);

  it("fails closed when pricing is missing at startup and recovers on a fresh quote", async () => {
    let rate: number | null = null;
    world = await startWorld({ earn: EARN, config: { prices: { solUsd: async () => rate } } });
    const { wallet, sandbox } = world;
    const a = await wallet.createAgent();
    const quote = await wallet.quoteEarn(a.id);
    expect(quote.requiresApproval).toBe(true);
    await wallet.approveEarnFunding(quote.quoteId);
    const on = await wallet.setEarn(a.id, true, 10);
    expect(on.earn.lastError).toMatch(/dollar price/);
    expect(on.earn.state).toBe("off");
    const open = await sandbox.postOpenJob({
      title: "One line",
      instructions: "Write a line.",
      rewardLamports: 50n * CENT,
    });
    await wallet.tick();
    expect(await open.delivered()).toBe(false);
    rate = 100;
    await wallet.tick();
    await eventually(() => open.delivered());
    expect(new TextDecoder().decode([...sandbox.deliveries.values()][0])).toBe("pay=50");
  }, 30_000);

  it("exposes quotes over RPC and denies quote approval to agent credentials", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet, dataDir } = world;
    const a = await wallet.createAgent();
    const token = "t".repeat(40);
    const socketPath = path.join(dataDir, "rpc.sock");
    const server = await serveWallet({ wallet, socketPath, ownerToken: token, agentExists: (id) => id === a.id });
    const owner = await connectWallet({ socketPath, token });
    const lane = await connectWallet({ socketPath, token, actAs: a.id });
    try {
      const q = await owner.call("earn.quote", { agentId: a.id, offer: OFFER });
      await expect(lane.call("earn.approveFunding", { quoteId: q.quoteId })).rejects.toMatchObject({
        code: "NOT_ALLOWED",
      });
      await owner.call("earn.approveFunding", { quoteId: q.quoteId });
      expect(await world.balance(a.address)).toBe(BigInt(q.fromMain.lamports));
    } finally {
      owner.close();
      lane.close();
      await server.close();
    }
  });
});
