import { approvedPost } from "./harness.js";
// Posting a request for anyone to take, on practice money: the person posts
// from the main balance, or an agent from its own money within its budget; a
// stranger (a house provider of the sandbox) takes it and delivers; the
// person pays, or turns it down; before anyone takes it, it can be cancelled.
import type { Address } from "@solana/kit";
import {
  findClaimPda,
  findTaskJobSpecPda,
  findTaskSubmissionPda,
  findTaskValidationConfigPda,
  getTaskDecoder,
  getTaskJobSpecDecoder,
  getTaskSubmissionDecoder,
  getCreateTaskHumanlessDiscriminatorBytes,
  getTaskValidationConfigDecoder,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { Chain } from "../src/chain.js";
import {
  providerRecordAddress,
  readAgent,
  requestDescription,
  turnDownReason,
} from "../src/market.js";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startSandbox } from "../src/sandbox.js";
import { AgencWallet } from "../src/wallet.js";
import { CENT, SOL, eventually, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

const REQUEST = "Write a haiku about a lighthouse.\nThree lines, about the light at night.";

/** The quote the panel shows before posting from the main balance. */
async function postCost(current: World) {
  return eventually(async () => (await current.wallet.overview()).postCost);
}

async function readTaskAccount(current: World, task: string) {
  return getTaskDecoder().decode((await current.sandbox.chain.readAccount(task as Address))!);
}

async function submissionOf(current: World, task: string, provider: string) {
  const [claim] = await findClaimPda({ task: task as Address, bidder: provider as Address });
  const [submission] = await findTaskSubmissionPda({ claim });
  return getTaskSubmissionDecoder().decode((await current.sandbox.chain.readAccount(submission))!);
}

/**
 * A chain whose first request lands but whose answer is lost on the way back,
 * with the next read failing too: the wallet cannot know at once what happened.
 */
function losesTheFirstAnswer(state: { lost: number; blindReads: number }) {
  const creates = (instructions: readonly { data?: ArrayLike<number> }[]): boolean => {
    const mark = Array.from(getCreateTaskHumanlessDiscriminatorBytes());
    return instructions.some((entry) => mark.every((byte, index) => entry.data?.[index] === byte));
  };
  return (base: Chain): Chain => ({
    ...base,
    clientFor(signer) {
      const client = base.clientFor(signer);
      return Object.create(client, {
        send: {
          value: async (instructions: Parameters<typeof client.send>[0], ...rest: unknown[]) => {
            const result = await (client.send as (...args: unknown[]) => ReturnType<typeof client.send>)(instructions, ...rest);
            if (state.lost === 0 && creates(instructions as never)) {
              state.lost += 1;
              state.blindReads = 1;
              throw new Error("socket hang up");
            }
            return result;
          },
        },
      }) as typeof client;
    },
    readAccountInfo: async (account) => {
      if (state.blindReads > 0) {
        state.blindReads -= 1;
        throw new Error("rpc unreachable");
      }
      return base.readAccountInfo(account);
    },
  });
}

describe("posting a request", () => {
  it("posts from the main balance; a stranger takes it, delivers, and is paid on approval", async () => {
    world = await startWorld();
    const { wallet, sandbox } = world;
    const quote = await postCost(world);
    const before = await world.balance(wallet.mainAddress);

    const posted = await approvedPost(wallet, { request: REQUEST, reward: { usdCents: 30 } });
    expect(posted).toMatchObject({
      kind: "request",
      role: "buying",
      agentId: "",
      title: "Write a haiku about a lighthouse",
      listing: null,
      provider: null,
      status: "waiting",
    });
    expect(posted.price).toEqual({ lamports: (30n * CENT).toString(), usdCents: 30 });
    expect(posted.statusText).toMatch(/^Waiting for someone to take it\. If nobody does, it is cancelled and the reward comes back in 7 days\.$/);
    expect(posted.canRefund).toBe(true);
    // While it runs, what left the balance is the reward plus exactly what
    // the quote said: what is kept, and what is set aside.
    expect(before - (await world.balance(wallet.mainAddress))).toBe(
      30n * CENT + BigInt(quote.kept.lamports) + BigInt(quote.setAside.lamports) -
        // Two fees of the five the quote counts are still to come: paying and tidying.
        10_000n,
    );
    expect((await wallet.overview()).held.lamports).toBe((30n * CENT).toString());

    // On the chain: an open task for one worker, the reward in escrow, the
    // buyer's review on, committing to exactly the published request.
    const task = await readTaskAccount(world, posted.task!);
    expect(task.rewardAmount).toBe(30n * CENT);
    expect(task.maxWorkers).toBe(1);
    const [validation] = await findTaskValidationConfigPda({ task: posted.task as Address });
    expect(getTaskValidationConfigDecoder().decode((await sandbox.chain.readAccount(validation))!).mode).toBe(1);
    const [specAddress] = await findTaskJobSpecPda({ task: posted.task as Address });
    const pinned = getTaskJobSpecDecoder().decode((await sandbox.chain.readAccount(specAddress))!);
    expect(Array.from(new Uint8Array(task.description))).toEqual(
      Array.from(requestDescription(new Uint8Array(pinned.jobSpecHash))),
    );
    // The request is what was asked, as a request: not a hire of a service.
    const spec = sandbox.services.resolveAgencUri!(pinned.jobSpecUri);
    const published = JSON.parse(new TextDecoder().decode(await spec)) as { payload: Record<string, unknown> };
    expect(published.payload).toMatchObject({ title: "Write a haiku about a lighthouse", instructions: REQUEST });
    expect(published.payload).not.toHaveProperty("sourceListing");

    // A house provider of the practice marketplace, which nobody hired, takes it.
    expect(await sandbox.workOnce()).toBe(1);
    const delivered = await wallet.getJob(posted.id, true);
    expect(delivered.status).toBe("delivered");
    expect(delivered.provider).not.toBeNull();
    expect(delivered.result?.text).toContain("You asked: Write a haiku about a lighthouse.");
    expect(delivered.result?.verified).toBe(true);
    expect(delivered.canApprove).toBe(true);
    expect(delivered.statusText).toMatch(/^Delivered\. Approve it to pay \$0\.30\./);
    expect(delivered.canRate).toBe(false);

    const worker = await readAgent(sandbox.chain, delivered.provider as Address);
    const workerBefore = await world.balance(worker!.authority);
    const paid = await wallet.approveJob(posted.id, undefined, true);
    expect(paid.status).toBe("paid");
    expect(paid.statusText).toBe("Done. $0.30 was paid for it.");
    expect(paid.canRate).toBe(false);
    // The worker got the reward less the marketplace's 5%, and its deposits back.
    expect((await world.balance(worker!.authority)) - workerBefore).toBeGreaterThanOrEqual((30n * CENT * 95n) / 100n);

    // Tidied at once (nothing to rate): what is gone for good is exactly what
    // the quote called kept.
    await wallet.tick();
    expect((await wallet.getJob(posted.id, true)).status).toBe("paid");
    expect(before - (await world.balance(wallet.mainAddress))).toBe(30n * CENT + BigInt(quote.kept.lamports));
    expect((await wallet.overview()).held.lamports).toBe("0");
    // Paid from the main balance, so counted as what the balance spent.
    expect((await wallet.overview()).main.spent.lamports).toBe((30n * CENT).toString());
    const said = (await wallet.listActivity()).map((entry) => entry.text);
    expect(said).toContain("You posted a request: Write a haiku about a lighthouse.");
    expect(said).toContain("Paid for Write a haiku about a lighthouse.");
    await expect(wallet.rateJob(posted.id, 5, true)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("turns a delivered request down: the reward is held, and the buyer pays the fee and starts its record once", async () => {
    world = await startWorld();
    const { wallet, sandbox } = world;
    const posted = await approvedPost(wallet, { request: REQUEST, reward: { usdCents: 30 } });
    await sandbox.workOnce();
    const delivered = await wallet.getJob(posted.id, true);
    expect(delivered.status).toBe("delivered");
    // Revision 9: whoever took it has a record (its claim started it), and
    // every turn-down counts there.
    expect(delivered.turnDownRecorded).toBe(true);
    const recordRent = await sandbox.chain.getMinimumBalanceForRentExemption(129);
    expect(delivered.firstRecordCost?.lamports).toBe(recordRent.toString());

    const before = await world.balance(wallet.mainAddress);
    const held = await wallet.refundJob(posted.id, true);
    expect(held.status).toBe("in_review");
    await wallet.tick();
    expect((await wallet.getJob(posted.id, true)).statusText).toMatch(
      /The time to dispute it ends.*the reward comes back then/,
    );
    expect(before - (await world.balance(wallet.mainAddress))).toBe(5_000n + recordRent);
    // The turn-down is on the taker's record, and carries a reason anyone
    // can rebuild from the chain alone.
    expect(await sandbox.chain.readAccount(await providerRecordAddress(delivered.provider as Address))).not.toBeNull();
    const submission = await submissionOf(world, posted.task!, delivered.provider!);
    const [specAddress] = await findTaskJobSpecPda({ task: posted.task as Address });
    const pinned = getTaskJobSpecDecoder().decode((await sandbox.chain.readAccount(specAddress))!);
    const expected = await turnDownReason({
      task: posted.task as Address,
      deliveryHashHex: values.bytesToHex(new Uint8Array(submission.proofHash)),
      requestHashHex: values.bytesToHex(new Uint8Array(pinned.jobSpecHash)),
    });
    expect(values.bytesToHex(new Uint8Array(submission.rejectionHash))).toBe(expected.hex);

    // The taker disputes; the reviewers agree with the buyer: the reward
    // comes back, with the taker's bond.
    await sandbox.disputeTurnDown({
      task: posted.task as Address,
      providerAgent: delivered.provider as Address,
    });
    await sandbox.ruleOnTurnedDown({
      task: posted.task as Address,
      providerAgent: delivered.provider as Address,
      payProvider: false,
    });
    await wallet.tick();
    await wallet.tick();
    const refunded = await wallet.getJob(posted.id, true);
    expect(refunded.status).toBe("refunded");
    expect((await world.balance(wallet.mainAddress)) - before).toBeGreaterThanOrEqual(
      30n * CENT + values.MIN_DISPUTE_BOND_LAMPORTS - 5_000n - recordRent,
    );
    expect((await wallet.overview()).main.spent.lamports).toBe("0");
  });

  it("cancels a request before anyone takes it, and the reward comes back", async () => {
    world = await startWorld();
    const { wallet, sandbox } = world;
    const quote = await postCost(world);
    const before = await world.balance(wallet.mainAddress);
    const posted = await approvedPost(wallet, { request: REQUEST, reward: { usdCents: 30 } });
    const cancelled = await wallet.refundJob(posted.id, true);
    expect(cancelled.status).toBe("refunded");
    expect(cancelled.statusText).toBe("Cancelled. The reward came back.");
    await wallet.tick();
    // Only what the quote called kept is gone, and the record of turn-downs
    // and cancels this first cancel started (revision 9).
    expect(before - (await world.balance(wallet.mainAddress))).toBe(
      BigInt(quote.kept.lamports) + (await sandbox.chain.getMinimumBalanceForRentExemption(129)),
    );
    // Nobody can take it any more.
    expect(await sandbox.workOnce()).toBe(0);
    expect((await wallet.listActivity()).map((entry) => entry.text)).toContain(
      "Write a haiku about a lighthouse was cancelled and the reward came back.",
    );
  });

  it("cancels a request nobody took by the time it had to be delivered", async () => {
    world = await startWorld();
    const { wallet, sandbox } = world;
    // Too small for any house provider, so nobody takes it.
    const posted = await approvedPost(wallet, { request: REQUEST, reward: { usdCents: 5 }, deadlineDays: 1 });
    expect(posted.status).toBe("waiting");
    expect(posted.statusText).toMatch(/comes back in 24 hours\.$/);
    await sandbox.workOnce();
    sandbox.advanceClock(23 * 3600);
    await wallet.tick();
    expect((await wallet.getJob(posted.id, true)).status).toBe("waiting");
    sandbox.advanceClock(3600 + 5);
    await wallet.tick();
    const refunded = await wallet.getJob(posted.id, true);
    expect(refunded.status).toBe("refunded");
    expect(refunded.statusText).toBe("Nobody took this request in time, so it was cancelled and the reward came back.");
  });

  it("cancels a request whose taker never delivers, once the time to deliver has passed", async () => {
    // A practice marketplace whose only house provider takes jobs and goes quiet.
    const sandbox = await startSandbox({ followWallClock: false });
    await sandbox.addService({
      name: "Sleepy Provider",
      category: "writing",
      summary: "Takes the job and goes quiet.",
      priceLamports: 30n * CENT,
      replyPrefix: "",
      noShow: true,
    });
    const clock = { now: 1_800_000_000_000 };
    const wallet = await AgencWallet.open({
      dataDir: mkdtempSync(path.join(tmpdir(), "agenc-wallet-e2e-")),
      unlockSecret: randomBytes(32),
      chain: sandbox.chain,
      services: sandbox.services,
      prices: sandbox.prices,
      now: () => clock.now,
    });
    try {
      sandbox.fund(wallet.mainAddress, 5n * SOL);
      const quote = await eventually(async () => (await wallet.overview()).postCost);
      const before = await sandbox.chain.getBalance(wallet.mainAddress);
      const posted = await approvedPost(wallet, { request: REQUEST, reward: { usdCents: 30 }, deadlineDays: 1 });
      await sandbox.workOnce();
      const taken = await wallet.getJob(posted.id, true);
      expect(taken.status).toBe("working");
      expect(taken.statusText).toBe("Someone took it and is working on it.");
      expect(taken.provider).not.toBeNull();
      // Taken, so it cannot be cancelled before the time to deliver is up.
      expect(taken.canRefund).toBe(false);
      await expect(wallet.refundJob(posted.id, true)).rejects.toMatchObject({ code: "NOT_ALLOWED" });

      sandbox.advanceClock(24 * 3600 + 180);
      await wallet.tick();
      const refunded = await wallet.getJob(posted.id, true);
      expect(refunded.status).toBe("refunded");
      expect(refunded.statusText).toBe(
        "Whoever took this request did not deliver in time, so it was cancelled and the reward came back.",
      );
      await wallet.tick();
      // The reward came back. What is gone is what the quote called kept
      // (and, on the practice chain, the fee of the cancel it refused above),
      // plus the record this first cancel started, less the taker's claim
      // deposit, which a no-show leaves to the buyer (revision 9).
      const gone = before - (await sandbox.chain.getBalance(wallet.mainAddress));
      const expected =
        BigInt(quote.kept.lamports) +
        (await sandbox.chain.getMinimumBalanceForRentExemption(129)) -
        values.MIN_CLAIM_DEPOSIT_LAMPORTS;
      expect(gone).toBeGreaterThanOrEqual(expected);
      expect(gone).toBeLessThanOrEqual(expected + 5_000n);
    } finally {
      await wallet.close();
    }
  });

  it("lets an agent post within its budget, and asks the person above it", async () => {
    world = await startWorld();
    const { wallet, sandbox } = world;
    const agent = await wallet.createAgent("My assistant");
    // Practice rent is higher than the live network's, so a request sets
    // aside more than a dollar of deposits: the budget is five.
    await wallet.setBudget(agent.id, 500);
    const agentBefore = await world.balance(agent.address);

    // Within the budget, and its own money covers it: posted at once.
    const small = await wallet.post({ agentId: agent.id, request: "A haiku about rain.", reward: { usdCents: 20 } });
    expect(small.approval).toBeNull();
    expect(small.job).toMatchObject({ kind: "request", agentId: agent.id, status: "waiting" });
    expect(agentBefore - (await world.balance(agent.address))).toBeGreaterThan(20n * CENT);
    // The agent sees its own request; it can cancel it while nobody has taken it.
    expect((await wallet.getJob(small.job.id, false, agent.id)).canRefund).toBe(true);

    // Above the budget: it waits for the person, with the whole cost on the card.
    const mainBefore = await world.balance(wallet.mainAddress);
    const big = await wallet.post({ agentId: agent.id, request: "A sonnet about rain.", reward: { usdCents: 600 } });
    expect(big.job.status).toBe("needs_approval");
    expect(big.approval).toMatchObject({ kind: "request", service: null, request: "A sonnet about rain.", agentName: "My assistant" });
    expect(big.approval!.price).toEqual({ lamports: (600n * CENT).toString(), usdCents: 600 });
    expect(BigInt(big.approval!.fees.lamports)).toBeGreaterThan(0n);
    expect(BigInt(big.approval!.fromMain.lamports)).toBeGreaterThan(600n * CENT);
    expect(await world.balance(wallet.mainAddress)).toBe(mainBefore);
    const approved = await wallet.decideApproval(big.approval!.id, true);
    expect(approved.status).toBe("waiting");
    expect(mainBefore - (await world.balance(wallet.mainAddress))).toBeGreaterThan(600n * CENT);

    // A third, declined, spends nothing.
    const third = await wallet.post({ agentId: agent.id, request: "A limerick.", reward: { usdCents: 900 } });
    const declined = await wallet.decideApproval(third.approval!.id, false);
    expect(declined.status).toBe("declined");

    // The house provider takes the biggest first; the agent's own job list has both.
    await sandbox.workOnce();
    const mine = await wallet.listJobs({ agentId: agent.id }, false);
    expect(mine.map((job) => job.kind)).toEqual(["request", "request", "request"]);
    // The agent cannot turn a delivery down; the person can.
    const delivered = await eventually(async () => {
      const job = await wallet.getJob(big.job.id, false, agent.id);
      return job.status === "delivered" ? job : null;
    });
    expect(delivered.canRefund).toBe(false);
    await expect(wallet.refundJob(big.job.id, false, agent.id)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    const paid = await wallet.approveJob(big.job.id, 5, false, agent.id);
    expect(paid.status).toBe("paid");
    expect(paid.rating).toBeNull();
  });

  it("carries on a request whose answer was lost, and posts it once", async () => {
    const state = { lost: 0, blindReads: 0 };
    world = await startWorld({ chain: losesTheFirstAnswer(state) });
    const { wallet, sandbox } = world;
    const quote = await postCost(world);
    const before = await world.balance(wallet.mainAddress);
    const posted = await approvedPost(wallet, { request: REQUEST, reward: { usdCents: 30 } });
    // The request went out and its answer did not come back: still starting.
    expect(state.lost).toBe(1);
    expect(posted.status).toBe("starting");
    // The next look asks the chain, which says it landed, and it goes on.
    await wallet.tick();
    const waiting = await wallet.getJob(posted.id, true);
    expect(waiting.status).toBe("waiting");
    // Posted once: one reward held, and to the lamport what one request costs.
    expect((await wallet.overview()).held.lamports).toBe((30n * CENT).toString());
    expect(before - (await world.balance(wallet.mainAddress))).toBe(
      30n * CENT + BigInt(quote.kept.lamports) + BigInt(quote.setAside.lamports) - 10_000n,
    );
    // And it is a real request, which a stranger can take.
    expect(await sandbox.workOnce()).toBe(1);
    expect((await wallet.getJob(posted.id, true)).status).toBe("delivered");
  });

  it("posts once for a call made twice, and refuses what it cannot post", async () => {
    world = await startWorld({ mainLamports: 1_000_000_000n });
    const { wallet } = world;
    const first = await approvedPost(wallet, { request: REQUEST, reward: { usdCents: 30 }, idempotencyKey: "form-1" });
    const again = await approvedPost(wallet, { request: REQUEST, reward: { usdCents: 30 }, idempotencyKey: "form-1" });
    expect(again.id).toBe(first.id);
    expect((await wallet.listJobs({}, true)).filter((job) => job.kind === "request")).toHaveLength(1);

    await expect(approvedPost(wallet, { request: "  ", reward: { usdCents: 30 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(approvedPost(wallet, { request: REQUEST, reward: { usdCents: 0 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      approvedPost(wallet, { request: REQUEST, reward: { usdCents: 30 }, deadlineDays: 31 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      approvedPost(wallet, { request: REQUEST, reward: { usdCents: 30 }, deadlineDays: 2.5 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // More than the balance holds: nothing is posted and nothing is spent.
    const before = await world.balance(wallet.mainAddress);
    await expect(
      approvedPost(wallet, { request: REQUEST, reward: { usdCents: 1_000_000 } }),
    ).rejects.toMatchObject({ code: "NOT_ENOUGH_MONEY", message: expect.stringMatching(/^There is not enough in your balance\./) });
    expect(await world.balance(wallet.mainAddress)).toBe(before);
  });
});
