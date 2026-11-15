// The buying side, end to end against the real program: an agent hires a
// service from its own allowance, a house provider delivers, the delivery is
// approved, rated and tidied. Money is checked at every step.
import { afterEach, describe, expect, it } from "vitest";
import { CENT, checkCost, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

describe("buying from an allowance", () => {
  it("hires, receives the delivery, pays, rates and tidies", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, {
      askAboveCents: 100,
      refill: { enabled: false, topUpToCents: 0, perDayCents: 0 },
    });
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const funded = await world.balance(agent.address);
    expect(funded).toBe(300n * CENT);

    const found = await wallet.find({ query: "haiku" });
    expect(found.map((service) => service.listing)).toEqual([listing]);
    expect(found[0]!.price).toEqual({ lamports: (20n * CENT).toString(), usdCents: 20 });

    const { job, approval } = await wallet.hire({
      agentId: agent.id,
      listing,
      request: "A haiku about a lighthouse.",
      acceptance: ["three lines"],
    });
    expect(approval).toBeNull();
    expect(job.status).toBe("waiting");
    expect(job.autoRefundAt).not.toBeNull();
    const afterHire = await world.balance(agent.address);
    expect(funded - afterHire).toBeGreaterThan(20n * CENT);

    expect(await sandbox.workOnce()).toBe(1);
    const delivered = await wallet.getJob(job.id, true);
    expect(delivered.status).toBe("delivered");
    expect(delivered.result?.verified).toBe(true);
    expect(delivered.result?.text).toContain("old pond");
    expect(delivered.result?.text).toContain("A haiku about a lighthouse.");
    expect(delivered.canApprove).toBe(true);

    const paid = await wallet.approveJob(job.id, 5, true);
    expect(paid.status).toBe("paid");
    expect(paid.rating).toBe(5);

    await wallet.tick();
    const overview = await wallet.overview();
    const view = overview.agents[0]!;
    expect(view.spent.lamports).toBe((20n * CENT).toString());
    expect(view.held.lamports).toBe("0");
    const final = await world.balance(agent.address);
    // Everything the buyer paid, to the lamport: the price, the permanent job
    // record, the one-time rate-limit record of a first hire, the rating's
    // permanent record, five transaction fees (hire, post, pay, rate, tidy),
    // and the safety check of its request. Every other deposit came back.
    const rent = (space: number) => world!.sandbox.chain.getMinimumBalanceForRentExemption(space);
    expect(funded - final).toBe(
      20n * CENT +
        (await rent(466)) +
        (await rent(67)) +
        (await rent(439)) +
        5n * 5_000n +
        (await checkCost(world)),
    );
    const [tidied] = await wallet.listJobs({ role: "buying" }, true);
    expect(tidied!.canRate).toBe(false);
    const kinds = (await wallet.listActivity()).map((entry) => entry.kind);
    expect(kinds).toEqual(expect.arrayContaining(["allowance", "hired", "paid", "tidied"]));
  });
});
