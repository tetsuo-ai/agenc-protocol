// Getting money back: a job nobody starts refunds itself; a provider who
// starts and never delivers is cancelled after the deadline. A delivery is
// different: the buyer has read it, so turning it down (a person's call, not
// an agent's) holds the price for review instead of handing it back.
import { afterEach, describe, expect, it } from "vitest";
import { CENT, checkCost, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

async function fundedAgent(current: World, cents = 300) {
  const agent = await current.wallet.createAgent("My assistant");
  await current.wallet.setPolicy(agent.id, {
    askAboveCents: 100,
    refill: { enabled: false, topUpToCents: 0, perDayCents: 0 },
  });
  await current.wallet.fundAgent(agent.id, { usdCents: cents });
  return agent;
}

describe("refunds", () => {
  it("refunds a job nobody starts, by itself", async () => {
    world = await startWorld();
    const { wallet, listing, clock } = world;
    const agent = await fundedAgent(world);
    const before = await world.balance(agent.address);
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    expect(job.status).toBe("waiting");

    clock.now += 9 * 60_000;
    await wallet.tick();
    expect((await wallet.getJob(job.id, true)).status).toBe("waiting");

    clock.now += 2 * 60_000;
    await wallet.tick();
    await wallet.tick();
    const refunded = await wallet.getJob(job.id, true);
    expect(refunded.status).toBe("refunded");
    expect(refunded.statusText).toMatch(/price returned/);
    const after = await world.balance(agent.address);
    // The whole price came back. What is gone is exactly what the network
    // keeps: the job record's deposit, the buyer's one-time rate-limit
    // record, four transaction fees, and the safety check of the request.
    const rent = (space: number) => world!.sandbox.chain.getMinimumBalanceForRentExemption(space);
    expect(before - after).toBe(
      (await rent(466)) + (await rent(67)) + 4n * 5_000n + (await checkCost(world)),
    );
    expect((await wallet.overview()).agents[0]!.spent.lamports).toBe("0");
  });

  it("lets the buyer cancel a waiting job at once", async () => {
    world = await startWorld();
    const { wallet, listing } = world;
    const agent = await fundedAgent(world);
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    const refunded = await wallet.refundJob(job.id, false, agent.id);
    expect(refunded.status).toBe("refunded");
  });

  it("cancels after the deadline when the provider started and never delivered", async () => {
    world = await startWorld();
    const { wallet, sandbox, clock } = world;
    const listing = await sandbox.addService({
      name: "Sleepy Provider",
      category: "writing",
      summary: "Takes the job and goes quiet.",
      priceLamports: 30n * CENT,
      deliverySecs: 600,
      replyPrefix: "",
      noShow: true,
    });
    const agent = await fundedAgent(world);
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "Anything." });
    await sandbox.workOnce();
    const working = await wallet.getJob(job.id, true);
    expect(working.status).toBe("working");
    // A started job cannot be cancelled before the provider's deadline.
    await expect(wallet.refundJob(job.id, true)).rejects.toMatchObject({ code: "NOT_ALLOWED" });

    sandbox.advanceClock(600 + 180);
    clock.now += 13 * 60_000;
    await wallet.tick();
    const refunded = await wallet.getJob(job.id, true);
    expect(refunded.status).toBe("refunded");
    expect(refunded.statusText).toMatch(/did not deliver in time/);
  });

  it("holds the price for review when a person turns a delivery down, and pays the provider when nobody rules", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing, clock } = world;
    const agent = await fundedAgent(world);
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    await sandbox.workOnce();
    const delivered = await wallet.getJob(job.id, false, agent.id);
    expect(delivered.status).toBe("delivered");
    // An agent cannot turn a delivery down. A person can.
    expect(delivered.canRefund).toBe(false);
    await expect(wallet.refundJob(job.id, false, agent.id)).rejects.toMatchObject({
      code: "NOT_ALLOWED",
    });
    expect((await wallet.getJob(job.id, true)).canRefund).toBe(true);

    const beforeTurnDown = await world.balance(agent.address);
    const turnedDown = await wallet.refundJob(job.id, true);
    expect(turnedDown.status).toBe("in_review");
    await wallet.tick();
    const held = await wallet.getJob(job.id, true);
    expect(held.status).toBe("in_review");
    expect(held.statusText).toMatch(/on hold while it is reviewed/);
    expect(held.reviewEndsAt).not.toBeNull();
    expect(held.autoApproveAt).toBeNull();
    // Nothing more to decide while it is held, and no second turn-down.
    expect(held.canApprove).toBe(false);
    expect(held.canAskChanges).toBe(false);
    expect(held.canRefund).toBe(false);
    await expect(wallet.refundJob(job.id, true)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    // The buyer has read the work, so the price did NOT come back: turning it
    // down cost one transaction fee and nothing else.
    expect(beforeTurnDown - (await world.balance(agent.address))).toBe(5_000n);
    expect((await wallet.overview()).agents[0]!.held.lamports).toBe(job.price.lamports);
    expect((await wallet.listActivity()).some((entry) => /turned down/.test(entry.text))).toBe(true);

    // Before the review time is up nothing settles.
    sandbox.advanceClock(23 * 3600);
    clock.now += 23 * 3600_000;
    await wallet.tick();
    expect((await wallet.getJob(job.id, true)).status).toBe("in_review");

    // Nobody ruled. The provider is paid, and this wallet is the one that
    // settles it, so the job is not left hanging.
    sandbox.advanceClock(3600 + 120);
    clock.now += 3600_000 + 120_000;
    await wallet.tick();
    await wallet.tick();
    const settled = await wallet.getJob(job.id, true);
    expect(settled.status).toBe("paid");
    expect(settled.statusText).toMatch(/was paid to the provider/);
    expect((await wallet.overview()).agents[0]!.spent.lamports).toBe(job.price.lamports);
    expect((await wallet.overview()).agents[0]!.held.lamports).toBe("0");
  });

  it("returns the price when the reviewer agrees with the buyer", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing } = world;
    const agent = await fundedAgent(world);
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    await sandbox.workOnce();
    await wallet.getJob(job.id, true);
    await wallet.refundJob(job.id, true);
    await wallet.tick();
    const held = await wallet.getJob(job.id, true);
    expect(held.status).toBe("in_review");
    const beforeRuling = await world.balance(agent.address);

    await sandbox.ruleOnTurnedDown({
      task: held.task as never,
      providerAgent: held.provider as never,
      payProvider: false,
    });
    await wallet.tick();
    const refunded = await wallet.getJob(job.id, true);
    expect(refunded.status).toBe("refunded");
    expect((await world.balance(agent.address)) - beforeRuling).toBeGreaterThanOrEqual(
      BigInt(job.price.lamports),
    );
    expect((await wallet.overview()).agents[0]!.spent.lamports).toBe("0");
  });

  it("pays the provider when the reviewer overturns the turn-down", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing } = world;
    const agent = await fundedAgent(world);
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    await sandbox.workOnce();
    await wallet.getJob(job.id, true);
    await wallet.refundJob(job.id, true);
    await wallet.tick();
    const held = await wallet.getJob(job.id, true);

    await sandbox.ruleOnTurnedDown({
      task: held.task as never,
      providerAgent: held.provider as never,
      payProvider: true,
    });
    await wallet.tick();
    const paid = await wallet.getJob(job.id, true);
    expect(paid.status).toBe("paid");
    expect((await wallet.overview()).agents[0]!.spent.lamports).toBe(job.price.lamports);
  });

  it("does not let one agent touch another agent's job", async () => {
    world = await startWorld();
    const { wallet, listing } = world;
    const mine = await fundedAgent(world);
    const other = await wallet.createAgent("Someone else");
    const { job } = await wallet.hire({ agentId: mine.id, listing, request: "A haiku." });
    await expect(wallet.getJob(job.id, false, other.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(wallet.refundJob(job.id, false, other.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
