// Crash safety. The journal records intent before any transaction is sent,
// so after a restart or a lost answer the chain decides what happened: a hire
// that landed is carried on, one that never landed costs nothing, and nothing
// is ever paid twice.
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
