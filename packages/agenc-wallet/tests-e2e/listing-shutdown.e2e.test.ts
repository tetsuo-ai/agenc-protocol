import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import { readListing } from "../src/market.js";
import { StateStore } from "../src/store.js";
import { abortableTransport, transportSignal } from "../src/transport-scope.js";
import { CENT, eventually, setEarnWithApproval, setOfferWithApproval, startWorld, type World } from "./harness.js";

let world: World | null = null;
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await world?.wallet.close();
  world = null;
});
function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { entered, release, wait: async () => { enter(); await released; } };
}
const EARN = {
  executor: { argv: [process.execPath, "-e", "process.stdout.write('done')", "{prompt}"], mode: "sandboxed" as const, envAllowlist: [], timeoutMs: 10000 },
  pollIntervalMs: 100,
  retryDelayMs: 1000,
};
async function liveOffers(count: number) {
  const agent = await world!.wallet.createAgent();
  await setEarnWithApproval(world!.wallet, agent.id, true, 10);
  for (let i = 0; i < count; i++) {
    await setOfferWithApproval(world!.wallet, agent.id, { name: `Writer ${i}`, summary: "Write a line.", price: { usdCents: 50 } });
  }
  const offers = await eventually(async () => {
    await world!.wallet.tick();
    const current = saved(agent.id).offers!;
    return current.every((offer) => offer.status === "live") ? current : null;
  });
  return { agent, offers };
}
async function liveOffer() {
  const { agent, offers } = await liveOffers(1);
  return { agent, offer: offers[0]! };
}
function state() {
  return StateStore.open(path.join(world!.dataDir, "state.json")).state;
}
function saved(id: string) {
  return state().agents[id]!.earn;
}

it.each(["background", "shutdown"])("cancels a stalled %s listing read, releases ownership within the bound, and reconciles before discovery", async (where) => {
  const read = gate();
  let listing: string | null = null;
  let hold = false;
  let claims = 0;
  const signals: AbortSignal[] = [];
  world = await startWorld({ earn: EARN, config: { listingTimeoutMs: 1000 }, chain: (base) => ({ ...base,
    async readAccountInfo(address) {
      if (hold && address === listing) {
        signals.push(transportSignal()!);
        await read.wait();
      }
      return base.readAccountInfo(address);
    },
    clientFor(signer) {
      const original = base.clientFor(signer);
      return Object.create(original, { claimTaskWithJobSpec: { value: async (...args: Parameters<typeof original.claimTaskWithJobSpec>) => {
        claims += 1;
        return original.claimTaskWithJobSpec(...args);
      } } }) as typeof original;
    },
  }) });
  const { agent, offer } = await liveOffer();
  listing = offer.listing;
  hold = true;
  const tick = where === "background" ? world.wallet.tick() : Promise.resolve();
  if (where === "background") await read.entered;
  const started = Date.now();
  const old = world.wallet;
  const close = old.close();
  expect(old.close()).toBe(close);
  await Promise.all([close, tick]);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(signals.length).toBe(where === "background" ? 2 : 1);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(saved(agent.id).listingReconciliationRequired).toBe(true);
  const readsBeforeReopen = signals.length;
  await world.sandbox.postOpenJob({ title: "Wait for reconciliation", instructions: "Write one line.", rewardLamports: 50n * CENT });
  world.wallet = await world.reopen();
  await eventually(async () => signals.length > readsBeforeReopen);
  await delay(150);
  expect(claims).toBe(0);
  hold = false;
  read.release();
  await eventually(async () => !saved(agent.id).listingReconciliationRequired);
  await eventually(async () => claims === 1);
  await expect(old.setEarn(agent.id, false)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  expect(saved(agent.id).enabled).toBe(true);
});

it("journals a broadcast with a stalled response and checks its outcome before reopening admissions", async () => {
  const sent = gate();
  const check = gate();
  let stall = false;
  let unresolved = false;
  let checks = 0;
  let readAfterCheck = false;
  let listing: string | null = null;
  world = await startWorld({ earn: EARN, config: { listingTimeoutMs: 1000 },
    transport: (base) => ({ ...base, async sendAndConfirm(transaction) {
      const result = await base.sendAndConfirm(transaction);
      if (stall) {
        stall = false;
        await abortableTransport(transportSignal(), () => sent.wait());
      }
      return result;
    } }),
    chain: (base) => ({ ...base,
      async listingSendOutcome(receipt) {
        checks += 1;
        if (unresolved) return "pending";
        await check.wait();
        return base.listingSendOutcome!(receipt);
      },
      async readAccountInfo(address) {
        if (checks > 0 && address === listing) readAfterCheck = true;
        return base.readAccountInfo(address);
      },
    }),
  });
  const { agent, offer } = await liveOffer();
  listing = offer.listing;
  stall = true;
  unresolved = true;
  await world.wallet.setEarn(agent.id, false);
  await sent.entered;
  // The chain applied the pause but its response has not reached the wallet.
  expect(await readListing(world.sandbox.chain, listing as Address)).toMatchObject({ state: 1 });
  const started = Date.now();
  await world.wallet.close();
  expect(Date.now() - started).toBeLessThan(1000);
  const pending = saved(agent.id).pendingListingSends;
  expect(pending).toHaveLength(1);
  expect(pending![0]).toMatchObject({ signature: expect.any(String), lastValidBlockHeight: expect.any(String) });
  expect(saved(agent.id).listingReconciliationRequired).toBe(true);
  unresolved = false;
  world.wallet = await world.reopen();
  await check.entered;
  const on = world.wallet.setEarn(agent.id, true);
  await delay(150);
  expect(saved(agent.id).pendingListingSends).toEqual(pending);
  check.release();
  await on;
  await eventually(async () => (await readListing(world!.sandbox.chain, listing as Address))?.state === 0);
  expect(readAfterCheck).toBe(true);
  expect(saved(agent.id).pendingListingSends).toEqual([]);
  expect(saved(agent.id).listingReconciliationRequired).toBe(false);
  expect(await readListing(world.sandbox.chain, listing as Address)).toMatchObject({ state: 0 });
});

it.each([
  { readMs: 2000, config: {}, startupMs: 70_000 },
  { readMs: 100, config: { listingTimeoutMs: 1000 }, startupMs: 5000 },
])("restarts four live listings and claims on successful $readMs ms reads", async ({ readMs, config, startupMs }) => {
  let slow = false;
  let claims = 0;
  const readiness = gate();
  let checkRoom = false;
  world = await startWorld({ earn: {
    ...EARN,
    async checkExecutionReady() {
      if (checkRoom) await readiness.wait();
    },
  }, config, chain: (base) => ({
    ...base,
    async readAccountInfo(address) {
      if (slow) await delay(readMs);
      return base.readAccountInfo(address);
    },
    clientFor(signer) {
      const original = base.clientFor(signer);
      return Object.create(original, { claimTaskWithJobSpec: { value: async (...args: Parameters<typeof original.claimTaskWithJobSpec>) => {
        const result = await original.claimTaskWithJobSpec(...args);
        claims++;
        return result;
      } } }) as typeof original;
    },
  }) });
  releases.push(() => { slow = false; });
  const { agent, offers } = await liveOffers(4);
  await world.wallet.close();
  await world.sandbox.postOpenJob({ title: "Waiting for startup", instructions: "Write one line.", rewardLamports: 50n * CENT });
  checkRoom = slow = true;
  const started = Date.now();
  world.wallet = await world.reopen();
  await readiness.entered;
  for (const offer of offers) expect(await readListing(world.sandbox.chain, offer.listing as Address)).toMatchObject({ state: 1 });
  expect(claims).toBe(0);
  readiness.release();
  await eventually(async () => claims === 1, startupMs - (Date.now() - started));
  expect(Date.now() - started).toBeLessThan(startupMs);
  await eventually(async () => saved(agent.id).offers!.every((offer) => offer.status === "live"), startupMs);
  expect(claims).toBe(1);
}, 130_000);

it("releases ownership at the default deadline and fences a late shutdown read", async () => {
  const read = gate();
  let listing: string | undefined;
  let heldSignal: AbortSignal | undefined;
  world = await startWorld({ earn: EARN, chain: (base) => ({
    ...base,
    async readAccountInfo(address) {
      if (address === listing) {
        heldSignal = transportSignal();
        await read.wait();
      }
      return base.readAccountInfo(address);
    },
  }) });
  const { agent, offer } = await liveOffer();
  listing = offer.listing!;
  const started = Date.now();
  const closing = world.wallet.close();
  await read.entered;
  await closing;
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(29_500);
  expect(elapsed).toBeLessThan(32_000);
  expect(heldSignal?.aborted).toBe(true);
  expect(saved(agent.id).listingReconciliationRequired).toBe(true);
  listing = undefined;
  world.wallet = await world.reopen();
  await eventually(async () => !saved(agent.id).listingReconciliationRequired);
  await world.wallet.renameAgent(agent.id, "Fresh owner");
  read.release();
  await delay(100);
  expect(state().agents[agent.id]!.name).toBe("Fresh owner");
}, 40_000);

it("recovers one activity entry and allowance charge for a landed funding transfer", async () => {
  const sent = gate();
  let stall = false;
  let main: string | undefined;
  let landed: string | undefined;
  let checkOutcome = false;
  world = await startWorld({ earn: EARN, config: { listingTimeoutMs: 1000 },
    chain: (base) => ({ ...base, listingSendOutcome: (receipt) =>
      checkOutcome ? base.listingSendOutcome!(receipt) : Promise.resolve("pending") }),
    transport: (base) => ({ ...base, async sendAndConfirm(transaction) {
      const result = await base.sendAndConfirm(transaction);
      const payer = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).staticAccounts[0];
      if (stall && transportSignal() && payer === main) {
        stall = false;
        landed = result.signature;
        await sent.wait();
      }
      return result;
    } }),
  });
  const { agent } = await liveOffer();
  main = world.wallet.mainAddress;
  // Leave room for the earlier registration and listing as well as the interrupted transfer.
  await world.wallet.setPolicy(agent.id, { askAboveCents: 1500, refill: { enabled: true, topUpToCents: 0, perDayCents: 1500 } });
  await world.wallet.confirmTransfer((await world.wallet.quoteTransfer({ kind: "reclaim", agentId: agent.id, amount: "all" })).id);
  const before = await world.balance(main);
  const initialCharges = state().agents[agent.id]!.refills.length;
  stall = true;
  const setting = world.wallet.setOffer(agent.id, { name: "Extra writer", summary: "Write a line.", price: { usdCents: 50 } });
  await sent.entered;
  await setting;
  const debit = before - await world.balance(main);
  const amount = (debit - world.sandbox.chain.transferFeeLamports).toString();
  expect(BigInt(amount)).toBeGreaterThan(0n);
  expect(saved(agent.id).pendingListingSends).toMatchObject([{ signature: landed, operation: { kind: "funding", lamports: amount } }]);
  expect(state().activity.some((entry) => entry.signature === landed)).toBe(false);
  expect(state().agents[agent.id]!.refills).toHaveLength(initialCharges + 1);
  // Isolate recovery from new funding that the second offer would otherwise request.
  await world.wallet.setPolicy(agent.id, { askAboveCents: 0, refill: { enabled: false, topUpToCents: 0, perDayCents: 0 } });
  await world.wallet.close();
  checkOutcome = true;
  for (let i = 0; i < 2; i++) {
    world.wallet = await world.reopen();
    await eventually(async () => saved(agent.id).pendingListingSends?.length === 0);
    sent.release();
    const journal = state();
    expect(journal.activity.filter((entry) => entry.signature === landed)).toMatchObject([
      { kind: "allowance", agentId: agent.id, lamports: amount },
    ]);
    expect(journal.agents[agent.id]!.refills).toHaveLength(initialCharges + 1);
    expect(journal.agents[agent.id]!.refills.filter((charge) => charge.signature === landed)).toMatchObject([
      { lamports: debit.toString() },
    ]);
    await world.wallet.close();
  }
});

it("resumes an interrupted pass from its unfinished listing across retries and reopen", async () => {
  let failing: string | undefined;
  const reads: string[] = [];
  world = await startWorld({ earn: EARN, chain: (base) => ({ ...base,
    async readAccountInfo(address) {
      if (failing && transportSignal()) {
        reads.push(address);
        if (address === failing) throw new Error("temporarily unavailable");
      }
      return base.readAccountInfo(address);
    },
  }) });
  const { agent, offers } = await liveOffers(4);
  await world.wallet.close();
  failing = offers[3]!.listing!;
  world.wallet = await world.reopen();
  await eventually(async () => !!saved(agent.id).lastError);
  const earlier = offers.slice(0, 3).map((offer) => offer.listing!);
  for (const address of earlier) expect(reads).toContain(address);
  reads.length = 0;
  await world.wallet.tick();
  await world.wallet.close();
  world.wallet = await world.reopen();
  await eventually(async () => reads.filter((address) => address === failing).length >= 3);
  expect(reads.filter((address) => earlier.includes(address))).toEqual([]);
  failing = undefined;
  await world.wallet.tick();
  await eventually(async () => saved(agent.id).offers!.every((offer) => offer.status === "live"));
});
