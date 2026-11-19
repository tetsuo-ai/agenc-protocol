// Crash safety. The journal records intent before any transaction is sent,
// so after a restart or a lost answer the chain decides what happened: a hire
// that landed is carried on, one that never landed costs nothing, and nothing
// is ever paid twice.
import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { AgencError } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { Chain } from "../src/chain.js";
import { checkCost, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close().catch(() => undefined);
  world = null;
});

const POLICY = {
  askAboveCents: 100,
  refill: { enabled: false, topUpToCents: 0, perDayCents: 0 },
};

/** A chain whose hire can be made to lose its answer, or never be sent. */
function flakyChain(mode: { hire: "ok" | "land-then-lose" | "drop"; blindReads: number }) {
  return (base: Chain): Chain => ({
    ...base,
    transferFeeLamports: base.transferFeeLamports,
    clientFor(signer) {
      const client = base.clientFor(signer);
      return Object.create(client, {
        hireFromListingHumanless: {
          value: async (input: Parameters<typeof client.hireFromListingHumanless>[0]) => {
            if (mode.hire === "drop") throw new Error("socket hang up");
            const result = await client.hireFromListingHumanless(input);
            if (mode.hire === "land-then-lose") {
              mode.blindReads = 1;
              throw new Error("socket hang up");
            }
            return result;
          },
        },
      }) as typeof client;
    },
    readAccountInfo: async (account) => {
      if (mode.blindReads > 0) {
        mode.blindReads -= 1;
        throw new Error("rpc unreachable");
      }
      return base.readAccountInfo(account);
    },
  });
}

/** What the client throws when the endpoint was too busy to even start on an order. */
function tooBusy(): AgencError {
  return new AgencError("Transaction failed: HTTP error (429): Too Many Requests", {
    code: null,
    errorName: null,
    logs: [],
    signature: null,
    cause: new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
      statusCode: 429,
      message: "Too Many Requests",
      headers: new Headers(),
    } as never),
  });
}

/** A chain that is too busy to take the first `mode.busy` hires. */
function busyChain(mode: { busy: number; tried: number }) {
  return (base: Chain): Chain => ({
    ...base,
    clientFor(signer) {
      const client = base.clientFor(signer);
      return Object.create(client, {
        hireFromListingHumanless: {
          value: async (input: Parameters<typeof client.hireFromListingHumanless>[0]) => {
            mode.tried += 1;
            if (mode.tried <= mode.busy) throw tooBusy();
            return client.hireFromListingHumanless(input);
          },
        },
      }) as typeof client;
    },
  });
}

describe("a busy network", () => {
  it("is sent the order again, and nothing is paid twice", async () => {
    const mode = { busy: 3, tried: 0 };
    world = await startWorld({ chain: busyChain(mode) });
    const { wallet, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, POLICY);
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const before = await world.balance(agent.address);

    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });

    // Turned away, not failed: nothing moved, and it is still on its way.
    expect(job.status).toBe("starting");
    expect(mode.tried).toBe(1);
    expect(await world.balance(agent.address)).toBe(before);
    // One more try per look, and still nothing has moved.
    await wallet.tick();
    await wallet.tick();
    expect(mode.tried).toBe(3);
    expect(await world.balance(agent.address)).toBe(before);

    // The fourth try gets through, and it is not sent a fifth time.
    await wallet.tick();
    expect(mode.tried).toBe(4);
    expect((await wallet.getJob(job.id, true)).status).toBe("waiting");
    await wallet.tick();
    expect(mode.tried).toBe(4);
    expect(await wallet.listJobs({ role: "buying" }, true)).toHaveLength(1);
  });

  it("never shows an agent with nothing when the balances cannot be read", async () => {
    const mode = { down: false };
    const flaky = (base: Chain): Chain => ({
      ...base,
      getBalances: async (accounts) => {
        if (mode.down) throw new Error("fetch failed");
        return base.getBalances(accounts);
      },
    });
    world = await startWorld({ chain: flaky });
    const { wallet, clock } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const seen = await wallet.overview();
    expect(seen.offline).toBe(false);
    expect(seen.agents[0]!.balance.usdCents).toBe(300);

    // The network goes away. The figures stay, marked as possibly out of date.
    mode.down = true;
    clock.now += 60_000;
    const blind = await wallet.overview();
    expect(blind.offline).toBe(true);
    expect(blind.agents[0]!.balance.lamports).toBe(seen.agents[0]!.balance.lamports);
    expect(blind.main.balance.lamports).toBe(seen.main.balance.lamports);

    // Also after a restart, when nothing has been read yet in this run.
    await wallet.close();
    world.wallet = await world.reopen();
    const restarted = await world.wallet.overview();
    expect(restarted.offline).toBe(true);
    expect(restarted.agents[0]!.balance.lamports).toBe(seen.agents[0]!.balance.lamports);
    expect(restarted.main.balance.lamports).toBe(seen.main.balance.lamports);

    mode.down = false;
    clock.now += 60_000;
    expect((await world.wallet.overview()).offline).toBe(false);
  });

  it("says which balances it never read, and a balance read as 0 stays known", async () => {
    const mode = { down: false };
    const flaky = (base: Chain): Chain => ({
      ...base,
      getBalances: async (accounts) => {
        if (mode.down) throw new Error("fetch failed");
        return base.getBalances(accounts);
      },
    });
    world = await startWorld({ chain: flaky });
    const { wallet, clock } = world;
    const spender = await wallet.createAgent("Spender");
    const read = await wallet.overview();
    expect(read.offline).toBe(false);
    expect(read.main.balanceKnown).toBe(true);
    expect(read.agents.find((entry) => entry.id === spender.id)).toMatchObject({ balance: { lamports: "0" }, balanceKnown: true });

    // The network goes away. The 0 read before is still a known figure; an agent made since was never read.
    mode.down = true;
    clock.now += 60_000;
    const newcomer = await wallet.createAgent("Newcomer");
    const blind = await wallet.overview();
    expect(blind.offline).toBe(true);
    expect(blind.main.balanceKnown).toBe(true);
    expect(blind.agents.find((entry) => entry.id === spender.id)).toMatchObject({ balance: { lamports: "0" }, balanceKnown: true });
    expect(blind.agents.find((entry) => entry.id === newcomer.id)).toMatchObject({ balance: { lamports: "0" }, balanceKnown: false });

    // After a restart nothing has been read in this run: what was read before is kept, the rest stays unknown.
    await wallet.close();
    world.wallet = await world.reopen();
    const restarted = await world.wallet.overview();
    expect(restarted.offline).toBe(true);
    expect(restarted.agents.find((entry) => entry.id === spender.id)?.balanceKnown).toBe(true);
    expect(restarted.agents.find((entry) => entry.id === newcomer.id)?.balanceKnown).toBe(false);

    mode.down = false;
    clock.now += 60_000;
    const back = await world.wallet.overview();
    expect(back.offline).toBe(false);
    expect(back.main.balanceKnown).toBe(true);
    expect(back.agents.every((entry) => entry.balanceKnown)).toBe(true);
  });

  it("knows a new agent's balance even when a read that began before it ends last", async () => {
    const gate = { hold: false, waiting: [] as Array<() => void> };
    const gated = (base: Chain): Chain => ({
      ...base,
      getBalances: async (accounts) => {
        if (gate.hold) {
          gate.hold = false;
          await new Promise<void>((done) => gate.waiting.push(done));
        }
        return base.getBalances(accounts);
      },
    });
    world = await startWorld({ chain: gated });
    const { wallet, clock } = world;
    await wallet.overview();
    // A read begins and is slow: it asks for every balance there is now.
    clock.now += 60_000;
    gate.hold = true;
    const slow = wallet.overview();
    for (let tries = 0; gate.waiting.length === 0 && tries < 200; tries += 1) await new Promise((done) => setTimeout(done, 5));
    expect(gate.waiting).toHaveLength(1);
    // Meanwhile an agent is made, and its own view reads every balance, its own too.
    const made = await wallet.createAgent("Newcomer");
    expect(made.balanceKnown).toBe(true);
    // The slow read ends last, without the new agent.
    for (const done of gate.waiting) done();
    await slow;
    const after = await wallet.overview();
    expect(after.offline).toBe(false);
    expect(after.agents.find((entry) => entry.id === made.id)).toMatchObject({ balance: { lamports: "0" }, balanceKnown: true });
  });

  it("is given up on after a while, in words that say what happened", async () => {
    const mode = { busy: 1_000, tried: 0 };
    world = await startWorld({ chain: busyChain(mode) });
    const { wallet, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, POLICY);
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const before = await world.balance(agent.address);

    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    for (let pass = 0; pass < 12; pass += 1) await wallet.tick();

    const failed = await wallet.getJob(job.id, true);
    expect(failed.status).toBe("failed");
    expect(failed.statusText).toBe("The network was too busy to place the order. Nothing was spent.");
    // The first try and eight more.
    expect(mode.tried).toBe(9);
    expect(await world.balance(agent.address)).toBe(before);
  });
});

describe("crash safety", () => {
  it("carries a job on after the service restarts", async () => {
    world = await startWorld();
    const { sandbox, listing } = world;
    const agent = await world.wallet.createAgent("My assistant");
    await world.wallet.setPolicy(agent.id, POLICY);
    await world.wallet.fundAgent(agent.id, { usdCents: 300 });
    const { job } = await world.wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    await world.wallet.close();

    const reopened = await world.reopen();
    world.wallet = reopened;
    await sandbox.workOnce();
    const delivered = await reopened.getJob(job.id, true);
    expect(delivered.status).toBe("delivered");
    expect((await reopened.approveJob(job.id, undefined, true)).status).toBe("paid");
    expect((await reopened.overview()).agents[0]!.name).toBe("My assistant");
  });

  it("refuses to open the same folder twice at once", async () => {
    world = await startWorld();
    await expect(world.reopen()).rejects.toMatchObject({ code: "BUSY" });
  });

  it("refuses the wrong unlock secret", async () => {
    world = await startWorld();
    await world.wallet.close();
    await expect(world.reopen({ unlockSecret: new Uint8Array(32).fill(7) })).rejects.toMatchObject({
      code: "NOT_ALLOWED",
    });
    world.wallet = await world.reopen();
  });

  it("finishes a hire whose answer was lost, without paying twice", async () => {
    const mode = { hire: "land-then-lose" as "ok" | "land-then-lose" | "drop", blindReads: 0 };
    world = await startWorld({ chain: flakyChain(mode), config: { rateWindowMs: 0 } });
    const { wallet, sandbox, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, POLICY);
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const before = await world.balance(agent.address);

    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    expect(job.status).toBe("starting");
    mode.hire = "ok";
    await wallet.tick();
    const posted = await wallet.getJob(job.id, true);
    expect(posted.status).toBe("waiting");

    await sandbox.workOnce();
    await wallet.getJob(job.id, true);
    await wallet.approveJob(job.id, undefined, true);
    await wallet.tick();
    await wallet.tick();
    const jobs = await wallet.listJobs({ role: "buying" }, true);
    expect(jobs).toHaveLength(1);
    // Exactly one price left the wallet, plus what one job costs the network.
    expect((await wallet.overview()).agents[0]!.spent.lamports).toBe("2000000");
    const rent = (space: number) => world!.sandbox.chain.getMinimumBalanceForRentExemption(space);
    expect(before - (await world.balance(agent.address))).toBe(
      2_000_000n + (await rent(466)) + (await rent(67)) + 4n * 5_000n + (await checkCost(world)),
    );
  });

  it("fails a hire that never reached the network, at no cost", async () => {
    const mode = { hire: "drop" as "ok" | "land-then-lose" | "drop", blindReads: 0 };
    world = await startWorld({ chain: flakyChain(mode) });
    const { wallet, listing, clock } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, POLICY);
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const before = await world.balance(agent.address);

    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    expect(job.status).toBe("starting");
    await wallet.tick();
    expect((await wallet.getJob(job.id, true)).status).toBe("starting");

    clock.now += 151_000;
    await wallet.tick();
    const failed = await wallet.getJob(job.id, true);
    expect(failed.status).toBe("failed");
    expect(failed.statusText).toMatch(/Nothing was spent/);
    expect(await world.balance(agent.address)).toBe(before);
  });
});
