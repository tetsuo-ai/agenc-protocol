// Making an agent and letting it spend, the simple way: one call makes it,
// one number says what it may spend on its own each day.
import { afterEach, describe, expect, it } from "vitest";
import { confirmPayout, CENT, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

const DAY_MS = 24 * 60 * 60_000;

describe("making an agent", () => {
  it("takes one call and needs no name", async () => {
    world = await startWorld();
    const { wallet } = world;

    expect((await wallet.createAgent()).name).toBe("Agent 1");
    expect((await wallet.createAgent("My assistant")).name).toBe("My assistant");
    expect((await wallet.createAgent()).name).toBe("Agent 3");
    expect((await wallet.createAgent("   ")).name).toBe("Agent 4");
    // A number somebody already used by hand is skipped.
    await wallet.createAgent("Agent 5");
    expect((await wallet.createAgent()).name).toBe("Agent 6");

    const made = (await wallet.overview()).agents;
    expect(made).toHaveLength(6);
    // Each has a wallet of its own, and starts by asking every time.
    expect(new Set(made.map((agent) => agent.address)).size).toBe(6);
    for (const agent of made) {
      expect(agent.budgetCents).toBe(0);
      expect(agent.balance.lamports).toBe("0");
      expect(agent.scope).toBeNull();
    }
  });

  it("is usable straight away, with no money of its own", async () => {
    world = await startWorld();
    const { wallet, listing } = world;
    const agent = await wallet.createAgent();
    const mainBefore = await world.balance(wallet.mainAddress);

    // Its first hire asks the person, and is paid from their balance.
    const { approval } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    expect(approval).not.toBeNull();
    expect(BigInt(approval!.fromMain.lamports)).toBeGreaterThan(20n * CENT);
    const posted = await wallet.decideApproval(approval!.id, true);

    expect(posted.status).toBe("waiting");
    expect(await world.balance(agent.address)).toBe(0n);
    expect(mainBefore - (await world.balance(wallet.mainAddress))).toBeGreaterThan(20n * CENT);
  });

  it("can be tied to a place the host knows, one agent per place", async () => {
    world = await startWorld();
    const { wallet } = world;

    const tied = await wallet.createAgent("research", "/home/me/research");
    expect(tied.scope).toBe("/home/me/research");
    await expect(wallet.createAgent("another", "/home/me/research")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect((await wallet.createAgent("writing", "/home/me/writing")).scope).toBe("/home/me/writing");

    // It is still tied after a restart.
    await wallet.close();
    world.wallet = await world.reopen();
    const agents = (await world.wallet.overview()).agents;
    expect(agents.map((agent) => agent.scope)).toEqual(["/home/me/research", "/home/me/writing"]);
  });
});

describe("a daily budget", () => {
  it("is one number: the agent gets that much, spends it on its own, and no more that day", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing, clock } = world;
    const agent = await wallet.createAgent("My assistant");

    // Set it, and the money is there at once.
    const set = await wallet.setBudget(agent.id, 500);
    expect(set.budgetCents).toBe(500);
    expect(set.balance.usdCents).toBe(499.95);
    expect(set.policy).toEqual({
      askAboveCents: 500,
      refill: { enabled: true, topUpToCents: 500, perDayCents: 500 },
    });
    expect((await wallet.listActivity()).map((entry) => entry.text)).toContain("Topped up My assistant.");

    // A hire within it does not ask.
    const { job, approval } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    expect(approval).toBeNull();
    expect(job.status).toBe("waiting");

    // Spend most of it. Nothing more is handed over that day...
    await sandbox.workOnce();
    // The first top-up used the day's allowance. The person's yes to this
    // exact delivery still pays it, once (owner real test 4 of 0.1.16).
    await confirmPayout(wallet, job.id);
    await wallet.reclaimFromAgent(agent.id, { usdCents: 300 });
    const low = await world.balance(agent.address);
    expect(low).toBeLessThan(250n * CENT);
    clock.now += 60_000;
    await wallet.tick();
    await wallet.tick();
    expect(await world.balance(agent.address)).toBeLessThanOrEqual(low);

    // ...and the next day it is back at the full amount.
    clock.now += DAY_MS;
    await wallet.tick();
    expect((await wallet.overview()).agents[0]!.balance.usdCents).toBe(500);
  });

  it("set to nothing makes the agent ask every time, and leaves its money alone", async () => {
    world = await startWorld();
    const { wallet, listing, clock } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setBudget(agent.id, 500);
    const held = await world.balance(agent.address);

    const off = await wallet.setBudget(agent.id, 0);
    expect(off.budgetCents).toBe(0);
    expect(off.policy.refill.enabled).toBe(false);
    expect(await world.balance(agent.address)).toBe(held);

    const { approval } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    expect(approval).not.toBeNull();
    // It has the money, so that is where an approved hire is paid from.
    expect(approval!.fromMain.lamports).toBe("0");

    clock.now += DAY_MS;
    await wallet.tick();
    expect(await world.balance(agent.address)).toBe(held);
  });

  it("refuses an amount that is not money", async () => {
    world = await startWorld();
    const agent = await world.wallet.createAgent();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) {
      await expect(world.wallet.setBudget(agent.id, bad)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(world.wallet.setBudget("agent_nobody", 500)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
