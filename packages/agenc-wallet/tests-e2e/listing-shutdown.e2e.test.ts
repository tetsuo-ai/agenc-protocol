import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import type { Address } from "@solana/kit";
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
async function liveOffer() {
  const agent = await world!.wallet.createAgent();
  await setEarnWithApproval(world!.wallet, agent.id, true, 10);
  await setOfferWithApproval(world!.wallet, agent.id, { name: "Writer", summary: "Write a line.", price: { usdCents: 50 } });
  const offer = await eventually(async () => {
    await world!.wallet.tick();
    const current = (await world!.wallet.overview()).agents.find((entry) => entry.id === agent.id)!;
    return current.earn.offer?.status === "live" ? current.earn.offer : null;
  });
  return { agent, offer };
}
function saved(id: string) {
  return StateStore.open(path.join(world!.dataDir, "state.json")).state.agents[id]!.earn;
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
      async listingSendSettled(receipt) {
        checks += 1;
        if (unresolved) return false;
        await check.wait();
        return base.listingSendSettled!(receipt);
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
  expect(readAfterCheck).toBe(true);
  expect(saved(agent.id).pendingListingSends).toEqual([]);
  expect(saved(agent.id).listingReconciliationRequired).toBe(false);
  expect(await readListing(world.sandbox.chain, listing as Address)).toMatchObject({ state: 0 });
});
