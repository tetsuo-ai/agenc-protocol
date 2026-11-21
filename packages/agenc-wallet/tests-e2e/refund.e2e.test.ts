// Getting money back: a job nobody starts refunds itself; a provider who
// starts and never delivers is cancelled after the deadline. A delivery is
// different: the buyer has read it, so turning it down (a person's call, not
// an agent's) holds the price instead of handing it back. Since revision 9
// the provider may dispute the turn-down within 72 hours, posting a bond; if
// it does not, the price comes back then. A disputed turn-down is ruled by
// the marketplace's reviewers; if nobody rules, the price comes back too.
import type { Address } from "@solana/kit";
import {
  findClaimPda,
  findTaskJobSpecPda,
  findTaskSubmissionPda,
  getAgentStatsDecoder,
  getTaskJobSpecDecoder,
  getTaskSubmissionDecoder,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { providerRecordAddress, turnDownReason } from "../src/market.js";
import { CENT, checkCost, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

/** How many of a provider's deliveries were turned down, as its marketplace record says. */
async function turnDowns(current: World, provider: string): Promise<bigint | null> {
  const data = await current.sandbox.chain.readAccount(await providerRecordAddress(provider as Address));
  return data === null ? null : getAgentStatsDecoder().decode(data).tasksRejected;
}

async function submissionOf(current: World, task: string, provider: string) {
  const [claim] = await findClaimPda({ task: task as Address, bidder: provider as Address });
  const [submission] = await findTaskSubmissionPda({ claim });
  return getTaskSubmissionDecoder().decode((await current.sandbox.chain.readAccount(submission))!);
}

/** The reason the chain holds for a delivery that was turned down. */
async function recordedReason(current: World, task: string, provider: string): Promise<string> {
  return values.bytesToHex(new Uint8Array((await submissionOf(current, task, provider)).rejectionHash));
}

/**
 * The reason as a reviewer works it out with nothing but the chain: the
 * delivery's fingerprint from the submission, the request's from the pinned
 * job spec, and the one reason a person gives.
 */
async function reasonFromChain(current: World, task: string, provider: string): Promise<string> {
  const [spec] = await findTaskJobSpecPda({ task: task as Address });
  const pinned = getTaskJobSpecDecoder().decode((await current.sandbox.chain.readAccount(spec))!);
  const submission = await submissionOf(current, task, provider);
  const reason = await turnDownReason({
    task: task as Address,
    deliveryHashHex: values.bytesToHex(new Uint8Array(submission.proofHash)),
    requestHashHex: values.bytesToHex(new Uint8Array(pinned.jobSpecHash)),
  });
  return reason.hex;
}

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
    // record, four transaction fees, the safety check of the request, and
    // (revision 9) the buyer's record of turn-downs and cancels, which this
    // first cancel started.
    const rent = (space: number) => world!.sandbox.chain.getMinimumBalanceForRentExemption(space);
    expect(before - after).toBe(
      (await rent(466)) +
        (await rent(67)) +
        (await rent(129)) +
        4n * 5_000n +
        (await checkCost(world)),
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

  it("holds the price when a person turns a delivery down, and refunds the buyer when the provider does not dispute", async () => {
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
    const looked = await wallet.getJob(job.id, true);
    expect(looked.canRefund).toBe(true);
    // Revision 9: the provider's claim started its record, and every
    // turn-down counts there.
    expect(await turnDowns(world, looked.provider!)).toBe(0n);
    expect(looked.turnDownRecorded).toBe(true);
    // The buyer's own record does not exist yet: its first turn-down or
    // cancel starts it, and the screen says what that costs.
    const recordRent = await sandbox.chain.getMinimumBalanceForRentExemption(129);
    expect(looked.firstRecordCost?.lamports).toBe(recordRent.toString());

    const beforeTurnDown = await world.balance(agent.address);
    const turnedDown = await wallet.refundJob(job.id, true);
    expect(turnedDown.status).toBe("in_review");
    expect(await turnDowns(world, looked.provider!)).toBe(1n);
    // The delivery carries a reason anyone can work out again from what the
    // chain holds: this delivery, this request, and why.
    expect(await recordedReason(world, looked.task!, looked.provider!)).toBe(
      await reasonFromChain(world, looked.task!, looked.provider!),
    );
    await wallet.tick();
    const held = await wallet.getJob(job.id, true);
    expect(held.status).toBe("in_review");
    expect(held.statusText).toMatch(/The time to dispute it ends.*If nobody disputes it, the price comes back then/);
    expect(held.turnDown).toMatchObject({
      disputable: true,
      disputed: false,
      ifNobodyActs: "buyer_refunded",
      bond: { lamports: values.MIN_DISPUTE_BOND_LAMPORTS.toString() },
    });
    expect(held.reviewEndsAt).toBe(held.turnDown!.disputeEndsAt);
    expect(held.autoApproveAt).toBeNull();
    // Nothing more to decide while it is held, and no second turn-down.
    expect(held.canApprove).toBe(false);
    expect(held.canAskChanges).toBe(false);
    expect(held.canRefund).toBe(false);
    expect(held.canDispute).toBe(false);
    await expect(wallet.refundJob(job.id, true)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    // The price did not come back yet. The turn-down cost the transaction's
    // fee and the buyer's record, once.
    expect(beforeTurnDown - (await world.balance(agent.address))).toBe(5_000n + recordRent);
    expect((await wallet.overview()).agents[0]!.held.lamports).toBe(job.price.lamports);
    expect((await wallet.listActivity()).some((entry) => /turned down/.test(entry.text))).toBe(true);

    // Before the dispute time is up nothing settles.
    sandbox.advanceClock(71 * 3600);
    clock.now += 71 * 3600_000;
    await wallet.tick();
    expect((await wallet.getJob(job.id, true)).status).toBe("in_review");

    // Nobody disputed. The price comes back, and this wallet is the one that
    // settles it, so the job is not left hanging. It is a refund, not a payment.
    const beforeRefund = await world.balance(agent.address);
    sandbox.advanceClock(3600 + 120);
    clock.now += 3600_000 + 120_000;
    await wallet.tick();
    await wallet.tick();
    const settled = await wallet.getJob(job.id, true);
    expect(settled.status).toBe("refunded");
    expect(settled.statusText).toMatch(/did not dispute your turn-down in time, so the price came back/);
    expect((await world.balance(agent.address)) - beforeRefund).toBeGreaterThanOrEqual(
      BigInt(job.price.lamports) - 5_000n,
    );
    expect((await wallet.overview()).agents[0]!.spent.lamports).toBe("0");
    expect((await wallet.overview()).agents[0]!.held.lamports).toBe("0");
  });

  it("refunds the buyer with the provider's bond when the reviewers uphold a disputed turn-down", async () => {
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

    // The reviewers rule only on a turn-down the provider disputed.
    await expect(
      sandbox.ruleOnTurnedDown({
        task: held.task as never,
        providerAgent: held.provider as never,
        payProvider: false,
      }),
    ).rejects.toThrow();
    await sandbox.disputeTurnDown({ task: held.task as never, providerAgent: held.provider as never });
    await wallet.tick();
    const disputed = await wallet.getJob(job.id, true);
    expect(disputed.status).toBe("in_review");
    expect(disputed.turnDown?.disputed).toBe(true);
    expect(disputed.statusText).toMatch(/Your turn-down was disputed/);
    const beforeRuling = await world.balance(agent.address);

    await sandbox.ruleOnTurnedDown({
      task: held.task as never,
      providerAgent: held.provider as never,
      payProvider: false,
    });
    await wallet.tick();
    const refunded = await wallet.getJob(job.id, true);
    expect(refunded.status).toBe("refunded");
    // The price and the provider's bond.
    expect((await world.balance(agent.address)) - beforeRuling).toBeGreaterThanOrEqual(
      BigInt(job.price.lamports) + values.MIN_DISPUTE_BOND_LAMPORTS,
    );
    expect((await wallet.overview()).agents[0]!.spent.lamports).toBe("0");
  });

  it("pays the provider when the reviewers overturn a disputed turn-down", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing } = world;
    const agent = await fundedAgent(world);
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    await sandbox.workOnce();
    await wallet.getJob(job.id, true);
    await wallet.refundJob(job.id, true);
    await wallet.tick();
    const held = await wallet.getJob(job.id, true);
    await sandbox.disputeTurnDown({ task: held.task as never, providerAgent: held.provider as never });

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

  it("refunds the buyer when nobody rules on a disputed turn-down", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing, clock } = world;
    const agent = await fundedAgent(world);
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    await sandbox.workOnce();
    await wallet.getJob(job.id, true);
    await wallet.refundJob(job.id, true);
    await wallet.tick();
    const held = await wallet.getJob(job.id, true);
    await sandbox.disputeTurnDown({ task: held.task as never, providerAgent: held.provider as never });
    await wallet.tick();
    expect((await wallet.getJob(job.id, true)).turnDown?.disputed).toBe(true);

    sandbox.advanceClock(72 * 3600 + 120);
    clock.now += 72 * 3600_000 + 120_000;
    await wallet.tick();
    await wallet.tick();
    const settled = await wallet.getJob(job.id, true);
    expect(settled.status).toBe("refunded");
    expect(settled.statusText).toMatch(/disputed your turn-down and nobody ruled in time, so the price came back/);
    expect((await wallet.overview()).agents[0]!.spent.lamports).toBe("0");
  });

  it("counts every turn-down on the provider's record, and starts the buyer's own record once", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing } = world;
    const agent = await fundedAgent(world, 500);
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku about rain." });
    await sandbox.workOnce();
    const looked = await wallet.getJob(job.id, true);
    expect(looked.status).toBe("delivered");
    const provider = looked.provider!;
    expect(await turnDowns(world, provider)).toBe(0n);
    expect(looked.turnDownRecorded).toBe(true);
    const recordRent = await sandbox.chain.getMinimumBalanceForRentExemption(129);
    expect(looked.firstRecordCost?.lamports).toBe(recordRent.toString());

    // The first turn-down pays the fee and starts the buyer's record.
    const balance = await world.balance(agent.address);
    const turnedDown = await wallet.refundJob(job.id, true);
    expect(turnedDown.status).toBe("in_review");
    expect(balance - (await world.balance(agent.address))).toBe(5_000n + recordRent);
    expect(await turnDowns(world, provider)).toBe(1n);
    expect(await recordedReason(world, looked.task!, provider)).toBe(
      await reasonFromChain(world, looked.task!, provider),
    );

    // A later turn-down costs only its fee.
    const { job: next } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku about snow." });
    await sandbox.workOnce();
    const again = await wallet.getJob(next.id, true);
    expect(again.turnDownRecorded).toBe(true);
    expect(again.firstRecordCost).toBeNull();
    const balanceAgain = await world.balance(agent.address);
    await wallet.refundJob(next.id, true);
    expect(balanceAgain - (await world.balance(agent.address))).toBe(5_000n);
    expect(await turnDowns(world, provider)).toBe(2n);
    // Each reason names its own delivery.
    expect(await recordedReason(world, again.task!, provider)).not.toBe(
      await recordedReason(world, looked.task!, provider),
    );
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
