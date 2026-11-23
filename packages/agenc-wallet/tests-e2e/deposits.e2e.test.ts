// "Money arrived" is for money someone sent in. A job paid from the main
// balance gives its deposits back to it when the job is tidied, and that is
// not money arriving: the person would think they had been paid.
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import type { Chain } from "../src/chain.js";
import { SOL, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

async function arrivals(w: World): Promise<string[]> {
  return (await w.wallet.listActivity())
    .filter((entry) => entry.kind === "added")
    .map((entry) => entry.text);
}

describe("money arriving in the main balance", () => {
  it("is not said of a job's deposits coming back", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing, clock } = world;
    // The starting balance is news once.
    await wallet.tick();
    expect(await arrivals(world)).toEqual(["Money arrived in your balance."]);

    // A hire the agent cannot cover is paid from the main balance.
    const agent = await wallet.createAgent("My assistant");
    const { job, approval } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku about rain." });
    // Housekeeping runs every few seconds while all this happens.
    await wallet.decideApproval(approval!.id, true);
    await wallet.tick();
    await sandbox.workOnce();
    await wallet.tick();
    await wallet.approveJob(job.id, 5, true);
    const beforeTidy = await world.balance(wallet.mainAddress);
    await wallet.tick();
    await wallet.tick();
    const kinds = (await wallet.listActivity()).map((entry) => entry.kind);
    expect(kinds).toContain("tidied");
    // Its deposits did come back to the main balance...
    expect(await world.balance(wallet.mainAddress)).toBeGreaterThan(beforeTidy);
    // ...and that is not money arriving.
    expect(await arrivals(world)).toEqual(["Money arrived in your balance."]);
    // A minute later they are counted in.
    clock.now += 60_000;
    await wallet.tick();
    expect(await arrivals(world)).toEqual(["Money arrived in your balance."]);

    // Money sent in from outside still is.
    sandbox.fund(wallet.mainAddress, 1n * SOL);
    await wallet.tick();
    expect(await arrivals(world)).toEqual([
      "Money arrived in your balance.",
      "Money arrived in your balance.",
    ]);
    const latest = (await wallet.listActivity()).find((entry) => entry.kind === "added");
    expect(latest?.amount?.lamports).toBe((1n * SOL).toString());
  });

  it("is not said of deposits coming back when the connection still shows the balance from before", async () => {
    // A connection can answer with a balance from a moment ago for a while.
    let behind: { account: string; lamports: bigint } | null = null;
    const lagging = (base: Chain): Chain =>
      Object.create(base, {
        getBalance: {
          value: async (account: Address) =>
            behind !== null && account === behind.account ? behind.lamports : base.getBalance(account),
        },
      }) as Chain;
    world = await startWorld({ chain: lagging });
    const { wallet, sandbox, listing, clock } = world;
    await wallet.tick();
    const agent = await wallet.createAgent("My assistant");
    const { job, approval } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku about fog." });
    await wallet.decideApproval(approval!.id, true);
    await wallet.tick();
    await sandbox.workOnce();
    await wallet.tick();
    await wallet.approveJob(job.id, 5, true);

    // The deposits come back, but the first look after it still shows the
    // balance from before; the next look, seconds later, shows them.
    behind = { account: wallet.mainAddress, lamports: await world.balance(wallet.mainAddress) };
    await wallet.tick();
    expect((await wallet.listActivity()).map((entry) => entry.kind)).toContain("tidied");
    behind = null;
    clock.now += 5_000;
    await wallet.tick();
    clock.now += 60_000;
    await wallet.tick();
    expect(await arrivals(world)).toEqual(["Money arrived in your balance."]);

    // Money sent in from outside still is news.
    sandbox.fund(wallet.mainAddress, 1n * SOL);
    await wallet.tick();
    expect(await arrivals(world)).toEqual([
      "Money arrived in your balance.",
      "Money arrived in your balance.",
    ]);
  });

  it("is not said of a cancelled job's price and deposits coming back", async () => {
    world = await startWorld();
    const { wallet, listing, clock, sandbox } = world;
    await wallet.tick();
    const agent = await wallet.createAgent("My assistant");
    const { job, approval } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku about snow." });
    await wallet.decideApproval(approval!.id, true);
    await wallet.tick();
    // Nobody starts it: the job is cancelled, the price comes back, and the
    // job is tidied.
    clock.now += 61 * 60_000;
    sandbox.advanceClock(61 * 60);
    await wallet.tick();
    await wallet.tick();
    await wallet.tick();
    expect((await wallet.getJob(job.id, true)).status).toBe("refunded");
    expect((await wallet.listActivity()).map((entry) => entry.kind)).toContain("tidied");
    expect(await arrivals(world)).toEqual(["Money arrived in your balance."]);
  });
});
