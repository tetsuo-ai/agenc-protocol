import { approvedPost } from "./harness.js";
import { address } from "@solana/kit";
import { setImmediate } from "node:timers/promises";
import path from "node:path";
import { getCreateTaskHumanlessDiscriminatorBytes } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chain } from "../src/chain.js";
import { connectWallet, type WalletClient } from "../src/client/socket-client.js";
import { serveWallet, type WalletServer } from "../src/server.js";
import { startWorld, type World } from "./harness.js";

let world: World | null = null;
let server: WalletServer | null = null;
const clients: WalletClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await server?.close();
  server = null;
  await world?.wallet.close();
  world = null;
});

type Operation = "hire" | "post" | "owner-post";
const operations: Operation[] = ["hire", "post", "owner-post"];
const request = "Write a haiku about a lighthouse.";
function call(operation: Operation, agentId: string, idempotencyKey = "same-request") {
  const params = { agentId, request, idempotencyKey };
  if (operation === "hire") return world!.wallet.hire({ ...params, listing: world!.listing });
  if (operation === "post") return world!.wallet.post({ ...params, reward: { usdCents: 20 } });
  return approvedPost(world!.wallet, { ...params, reward: { usdCents: 20 } })
    .then((job) => ({ job, approval: null }));
}

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await released; } };
}

/** Count creation attempts; optionally land one and lose both its answer and reconciliation read. */
function creationChain(state: { sends: number; loseAnswer?: boolean; blindReads?: number }) {
  return (base: Chain): Chain => ({
    ...base,
    clientFor(signer) {
      const client = base.clientFor(signer);
      const creation = async <T>(send: () => Promise<T>): Promise<T> => {
        state.sends += 1;
        const result = await send();
        if (state.loseAnswer) {
          state.blindReads = 1;
          throw new Error("socket hang up after send");
        }
        return result;
      };
      return Object.create(client, {
        hireFromListingHumanless: {
          value: (...args: Parameters<typeof client.hireFromListingHumanless>) =>
            creation(() => client.hireFromListingHumanless(...args)),
        },
        send: {
          value: (...args: Parameters<typeof client.send>) => {
            const mark = Array.from(getCreateTaskHumanlessDiscriminatorBytes());
            const creates = args[0].some((ix) => mark.every((byte, index) => ix.data?.[index] === byte));
            return creates ? creation(() => client.send(...args)) : client.send(...args);
          },
        },
      }) as typeof client;
    },
    readAccountInfo: async (account) => {
      if (state.blindReads) {
        state.blindReads -= 1;
        throw new Error("reconciliation unavailable");
      }
      return base.readAccountInfo(account);
    },
  });
}

describe("single-flight job requests", () => {
  it.each(operations)("shares concurrent %s calls through completion, even after the record exists", async (operation) => {
    const publishing = gate();
    const state = { sends: 0 };
    const publish = vi.fn();
    world = await startWorld({
      chain: creationChain(state),
      services: (base) => ({
        ...base,
        publishJobSpec: async (input) => {
          publish();
          await publishing.wait();
          return base.publishJobSpec(input);
        },
      }),
    });
    const agent = await world.wallet.createAgent("Buyer");
    world.sandbox.fund(address(agent.address), 1_000_000_000n);
    await world.wallet.setPolicy(agent.id, {
      askAboveCents: 100,
      refill: { enabled: false, topUpToCents: 0, perDayCents: 10000 },
    });
    let completed = 0;
    const run = () => call(operation, agent.id).then((value) => { completed += 1; return value; });
    const first = run();
    const second = run();
    await publishing.entered;
    const late = run();
    try {
      await setImmediate();
      expect(completed).toBe(0);
      expect(publish).toHaveBeenCalledTimes(1);
      if (operation === "owner-post") {
        // An invalid agent ID must not join an owner's pending request.
        await expect(call("post", "")).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
    } finally {
      publishing.release();
    }
    const results = await Promise.all([first, second, late]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]!.job.status).toBe("waiting");
    expect(results[0]!.job.task).not.toBeNull();
    expect(state.sends).toBe(1);
    expect(await world.wallet.listJobs({}, true)).toHaveLength(1);
    expect((await call(operation, agent.id, " same-request ")).job.id).toBe(results[0]!.job.id);
    expect(state.sends).toBe(1);
  });

  it.each(["hire", "post"] as const)("creates one approval for concurrent %s calls", async (operation) => {
    world = await startWorld();
    const agent = await world.wallet.createAgent("Unfunded buyer");
    const [first, second] = await Promise.all([call(operation, agent.id), call(operation, agent.id)]);
    expect(second).toEqual(first);
    expect(first.job.status).toBe("needs_approval");
    expect(first.approval).not.toBeNull();
    expect(await world.wallet.listApprovals()).toHaveLength(1);
    expect(await world.wallet.listJobs({}, true)).toHaveLength(1);
  });

  it.each(operations)("returns the recorded %s state after a possibly sent failure, including after restart", async (operation) => {
    const state = { sends: 0, loseAnswer: true };
    world = await startWorld({ chain: creationChain(state) });
    const agent = await world.wallet.createAgent("Buyer");
    world.sandbox.fund(address(agent.address), 1_000_000_000n);
    await world.wallet.setPolicy(agent.id, {
      askAboveCents: 100,
      refill: { enabled: false, topUpToCents: 0, perDayCents: 10000 },
    });
    const [first, second] = await Promise.all([call(operation, agent.id), call(operation, agent.id)]);
    expect(second).toEqual(first);
    expect(first.job.task).not.toBeNull();
    expect(await world.sandbox.chain.readAccount(address(first.job.task!))).not.toBeNull();
    expect(state.sends).toBe(1);
    expect(await call(operation, agent.id)).toEqual(first);
    await world.wallet.close();
    world.wallet = await world.reopen();
    expect(await call(operation, agent.id)).toEqual(first);
    expect(state.sends).toBe(1);
    expect(await world.wallet.listJobs({}, true)).toHaveLength(1);
  });

  it.each(["hire", "post"] as const)("shares a %s preparation failure and allows retry when no job was recorded", async (operation) => {
    const preparing = gate();
    const failure = new Error("price unavailable");
    let fail = false;
    const prices = vi.fn(async () => {
      if (fail) { await preparing.wait(); throw failure; }
      return 100;
    });
    world = await startWorld({ config: { prices: { solUsd: prices } } });
    const agent = await world.wallet.createAgent("Buyer");
    world.sandbox.fund(address(agent.address), 1_000_000_000n);
    await world.wallet.setPolicy(agent.id, {
      askAboveCents: 100,
      refill: { enabled: false, topUpToCents: 0, perDayCents: 10000 },
    });
    prices.mockClear();
    fail = true;
    const pending = Promise.allSettled([call(operation, agent.id), call(operation, agent.id)]);
    await preparing.entered;
    preparing.release();
    expect(await pending).toEqual([
      { status: "rejected", reason: failure }, { status: "rejected", reason: failure },
    ]);
    expect(prices).toHaveBeenCalledTimes(1);
    expect(await world.wallet.listJobs({}, true)).toHaveLength(0);
    fail = false;
    expect((await call(operation, agent.id)).job.status).toBe("waiting");
  });

  it("scopes keys by agent and operation and leaves unkeyed calls independent", async () => {
    world = await startWorld();
    const a = await world.wallet.createAgent("Buyer A");
    const b = await world.wallet.createAgent("Buyer B");
    const results = await Promise.all([
      call("hire", a.id), call("post", a.id), call("hire", b.id),
      call("post", a.id, "different"), call("post", a.id, ""), call("post", a.id, ""),
    ]);
    expect(new Set(results.map(({ job }) => job.id)).size).toBe(6);
    expect(await world.wallet.listApprovals()).toHaveLength(6);
  });

  it.each(["hire", "post"] as const)("deduplicates concurrent market.%s RPCs from separate connections", async (operation) => {
    const state = { sends: 0 };
    world = await startWorld({ chain: creationChain(state) });
    const agent = await world.wallet.createAgent("Buyer");
    world.sandbox.fund(address(agent.address), 1_000_000_000n);
    await world.wallet.setPolicy(agent.id, {
      askAboveCents: 100,
      refill: { enabled: false, topUpToCents: 0, perDayCents: 10000 },
    });
    const socketPath = path.join(world.dataDir, "wallet.sock");
    const ownerToken = "single-flight-test-owner-credential";
    server = await serveWallet({ wallet: world.wallet, socketPath, ownerToken, agentExists: (id) => world!.wallet.hasAgent(id) });
    clients.push(await connectWallet({ socketPath, token: ownerToken, actAs: agent.id }), await connectWallet({ socketPath, token: ownerToken, actAs: agent.id }));
    const params = { agentId: agent.id, request, idempotencyKey: "rpc-request" };
    const results = await Promise.all(clients.map((client) => operation === "hire"
      ? client.call("market.hire", { ...params, listing: world!.listing })
      : client.call("market.post", { ...params, reward: { usdCents: 20 } })));
    expect(results[1]).toEqual(results[0]);
    expect(results[0]!.job.status).toBe("waiting");
    expect(state.sends).toBe(1);
    expect(await world.wallet.listJobs({}, true)).toHaveLength(1);
  });
});
