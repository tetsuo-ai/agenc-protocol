// A hire the agent's allowance does not cover waits for a person. Approving
// pays from the main balance; declining spends nothing.
import { afterEach, describe, expect, it } from "vitest";
import { confirmPayout, CENT, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

describe("approvals", () => {
  it("asks first when the agent has no allowance, then pays from the main balance", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    const mainBefore = await world.balance(wallet.mainAddress);

    const { job, approval } = await wallet.hire({
      agentId: agent.id,
      listing,
      request: "A haiku about rain.",
    });
    expect(job.status).toBe("needs_approval");
    expect(approval).not.toBeNull();
    expect(approval!.kind).toBe("hire");
    expect(approval!.service?.name).toBe("Haiku Writer");
    expect(approval!.price).toEqual({ lamports: (20n * CENT).toString(), usdCents: 20 });
    expect(BigInt(approval!.fromMain.lamports)).toBeGreaterThan(20n * CENT);
    expect(BigInt(approval!.fees.lamports)).toBeGreaterThan(0n);
    expect(BigInt(approval!.fees.lamports)).toBeLessThan(BigInt(approval!.deposits.lamports));
    expect(await world.balance(wallet.mainAddress)).toBe(mainBefore);
    expect((await wallet.overview()).pendingApprovals).toBe(1);

    // The agent-side wait resolves once the person answers.
    const waiting = wallet.waitApproval(approval!.id, 10_000);
    const posted = await wallet.decideApproval(approval!.id, true);
    expect(posted.status).toBe("waiting");
    expect((await waiting).decided).toBe(true);
    expect(await world.balance(agent.address)).toBe(0n);
    expect(mainBefore - (await world.balance(wallet.mainAddress))).toBeGreaterThan(20n * CENT);

    await sandbox.workOnce();
    const paid = await confirmPayout(wallet, job.id, undefined);
    expect(paid.status).toBe("paid");
    expect((await wallet.overview()).agents[0]!.spent.lamports).toBe((20n * CENT).toString());
  });

  it("spends nothing when the person says no", async () => {
    world = await startWorld();
    const { wallet, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    const mainBefore = await world.balance(wallet.mainAddress);
    const { approval } = await wallet.hire({ agentId: agent.id, listing, request: "Anything." });
    const declined = await wallet.decideApproval(approval!.id, false);
    expect(declined.status).toBe("declined");
    expect(await world.balance(wallet.mainAddress)).toBe(mainBefore);
    expect(await wallet.listApprovals()).toEqual([]);
  });

  it("asks when the price is above the agent's limit even if the allowance covers it", async () => {
    world = await startWorld();
    const { wallet, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.fundAgent(agent.id, { usdCents: 500 });
    await wallet.setPolicy(agent.id, {
      askAboveCents: 10,
      refill: { enabled: false, topUpToCents: 0, perDayCents: 10000 },
    });
    const { job, approval } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    expect(job.status).toBe("needs_approval");
    // The allowance covers it, so nothing comes from the main balance.
    expect(approval!.fromMain.lamports).toBe("0");
    const mainBefore = await world.balance(wallet.mainAddress);
    const posted = await wallet.decideApproval(approval!.id, true);
    expect(posted.status).toBe("waiting");
    expect(await world.balance(wallet.mainAddress)).toBe(mainBefore);
  });

  it("lapses an unanswered approval and returns the same job for a repeated request", async () => {
    world = await startWorld();
    const { wallet, listing, clock } = world;
    const agent = await wallet.createAgent("My assistant");
    const first = await wallet.hire({
      agentId: agent.id,
      listing,
      request: "A haiku.",
      idempotencyKey: "turn-1",
    });
    const again = await wallet.hire({
      agentId: agent.id,
      listing,
      request: "A haiku.",
      idempotencyKey: "turn-1",
    });
    expect(again.job.id).toBe(first.job.id);
    expect(again.approval!.id).toBe(first.approval!.id);

    clock.now += 31 * 60_000;
    await wallet.tick();
    const lapsed = await wallet.getJob(first.job.id, true);
    expect(lapsed.status).toBe("declined");
    expect(await wallet.listApprovals()).toEqual([]);
  });

  it("moves the same amount twice in a row and takes it all back", async () => {
    world = await startWorld();
    const { wallet } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.fundAgent(agent.id, { usdCents: 500 });
    const quote = await wallet.quoteTransfer({ kind: "fund", agentId: agent.id, amount: { usdCents: 500 } });
    await wallet.confirmTransfer(quote.id);
    const twice = (await wallet.overview()).agents[0]!;
    expect(twice.balance.usdCents).toBe(1_000);
    await wallet.confirmTransfer((await wallet.quoteTransfer({ kind: "reclaim", agentId: agent.id, amount: "all" })).id);
    const back = (await wallet.overview()).agents.find(entry => entry.id === agent.id)!;
    // Nothing still needs this agent's money, so all of it came back.
    expect(back.balance.lamports).toBe("0");
    const out = await wallet.withdraw("11111111111111111111111111111112", { usdCents: 100 });
    expect(out.signature.length).toBeGreaterThan(40);
    await expect(wallet.fundAgent(agent.id, { usdCents: 999_999_999 })).rejects.toMatchObject({
      code: "NOT_ENOUGH_MONEY",
    });
    await expect(wallet.quoteTransfer({ kind: "withdraw", to: agent.address, amount: "all" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("tops an allowance up from the main balance, within the daily rule", async () => {
    world = await startWorld();
    const { wallet, clock } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, {
      askAboveCents: 100,
      refill: { enabled: true, topUpToCents: 500, perDayCents: 600 },
    });
    await wallet.tick();
    expect((await wallet.overview()).agents[0]!.balance.usdCents).toBe(500);

    // Spend it down (here: take it back) and the rule refills, but only up
    // to what is left of today's limit.
    await wallet.confirmTransfer((await wallet.quoteTransfer({ kind: "reclaim", agentId: agent.id, amount: "all" })).id);
    await wallet.tick();
    // "Take it all back" leaves nothing behind in an agent with nothing to pay for.
    const afterSecond = BigInt((await wallet.overview()).agents[0]!.balance.lamports);
    expect(afterSecond).toBe(100n * CENT - 2n * world.sandbox.chain.transferFeeLamports);
    await wallet.confirmTransfer((await wallet.quoteTransfer({ kind: "reclaim", agentId: agent.id, amount: "all" })).id);
    await wallet.tick();
    expect(BigInt((await wallet.overview()).agents[0]!.balance.lamports)).toBe(0n);

    // A day later the limit is fresh.
    clock.now += 25 * 60 * 60_000;
    await wallet.tick();
    expect((await wallet.overview()).agents[0]!.balance.usdCents).toBe(500);
    const kinds = (await wallet.listActivity()).filter((entry) => entry.kind === "allowance");
    expect(kinds.map((entry) => entry.text)).toContain("Topped up My assistant.");
  });

  it("refuses a hire above the caller's own price limit", async () => {
    world = await startWorld();
    const { wallet, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    await expect(
      wallet.hire({ agentId: agent.id, listing, request: "A haiku.", maxPriceCents: 5 }),
    ).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  });
});
