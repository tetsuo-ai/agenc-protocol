// "Whoever asks for an approval pays for it", against the real program with
// no change to it.
//
// The program makes the approver pay the deposit behind each approval record
// (`payer = moderator`). Nothing stops the one who asked from handing the
// approver that deposit in the very same transaction, and paying the
// transaction's fee too. Then the approver is never out of pocket, and the
// two halves cannot come apart: no payment, no approval.
//
// The first two tests prove that on the program itself. The rest drive the
// wallet: it pays for its own approvals, it will not sign an approval that
// takes more than the deposit, and it never pays for the same one twice.
import {
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import {
  facade,
  findAgentPda,
  findHireRecordPda,
  findTaskModerationPda,
  findTaskPda,
  getListingModerationSize,
  getTaskModerationDecoder,
  getTaskModerationDiscriminatorBytes,
  getTaskModerationSize,
  values,
  type ProgramAccountsTransport,
} from "@tetsuo-ai/marketplace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_FEE_LAMPORTS, transferInstruction, type Chain } from "../src/chain.js";
import type { AgentView } from "../src/client/types.js";
import type { Sandbox } from "../src/sandbox.js";
import type { ApprovalPayment, MarketServices } from "../src/services.js";
import { CENT, MARKER_SPACE, checkCost, eventually, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

const CLEAN = {
  status: 0,
  riskScore: 0,
  categoryMask: 0n,
  policyHash: new Uint8Array(32),
  scannerHash: new Uint8Array(32),
  expiresAt: 0n,
} as const;

const POLICY = {
  askAboveCents: 100,
  refill: { enabled: false, topUpToCents: 0, perDayCents: 0 },
};

describe("who pays for an approval", () => {
  it("can be the one who asked, in the same transaction, with the program unchanged", async () => {
    world = await startWorld();
    const { sandbox } = world;
    const chain = sandbox.chain;
    const approver = sandbox.market.moderator.signer;
    const buyer = await sandbox.market.fundedSigner();
    const client = chain.clientFor(buyer);

    // A job that is waiting for its approval.
    const agentId = values.randomId32();
    await client.registerAgent({
      authority: buyer,
      agentId,
      capabilities: 1n,
      endpoint: "https://sandbox.invalid/buyer",
      metadataUri: null,
      stakeAmount: 10_000_000n,
    });
    const [creatorAgent] = await findAgentPda({ agentId });
    const payload = { title: "A line", instructions: "Write one friendly line." };
    const hash = await values.canonicalJobSpecHash(payload);
    const description = new Uint8Array(64);
    description.set(hash.bytes, 0);
    const taskId = values.randomId32();
    const now = BigInt(await chain.clusterTime());
    await client.send([
      await facade.createTask({
        authority: buyer,
        creator: buyer,
        creatorAgent,
        taskId,
        requiredCapabilities: 1n,
        description,
        rewardAmount: 1_000_000n,
        maxWorkers: 1,
        deadline: now + 3_600n,
        taskType: 0,
        constraintHash: null,
        minReputation: 0,
        rewardMintArg: null,
      }),
    ]);
    const [task] = await findTaskPda({ creator: buyer.address, taskId });
    const [hireRecord] = await findHireRecordPda({ task });
    await client.send([
      await facade.configureTaskValidation({
        task,
        creator: buyer,
        hireRecord,
        mode: 1,
        reviewWindowSecs: 3_600n,
        validatorQuorum: 0,
        attestor: null,
      }),
    ]);

    const deposit = await chain.getMinimumBalanceForRentExemption(getTaskModerationSize());
    const before = {
      buyer: await chain.getBalance(buyer.address),
      approver: await chain.getBalance(approver.address),
    };

    // One transaction. The buyer is its fee payer, hands the approver the
    // record's deposit, and the approver records its approval. Both sign.
    await client.send([
      transferInstruction(buyer, approver.address, deposit),
      await facade.recordTaskModeration({
        moderator: approver,
        task,
        jobSpecHash: hash.bytes,
        ...CLEAN,
      }),
    ]);

    const after = {
      buyer: await chain.getBalance(buyer.address),
      approver: await chain.getBalance(approver.address),
    };
    // The approver is exactly where it started: the deposit came in and went
    // straight into the record.
    expect(after.approver).toBe(before.approver);
    // The buyer paid the deposit and the fee of a two-signature transaction.
    expect(before.buyer - after.buyer).toBe(deposit + 2n * BASE_FEE_LAMPORTS);

    // And the approval is a real one: the job can be published with it.
    await client.setTaskJobSpec({
      task,
      creator: buyer,
      jobSpecHash: hash.bytes,
      jobSpecUri: `agenc://job-spec/sha256/${hash.hex}`,
      moderator: approver.address,
    });
  }, 60_000);

  it("gives no approval when the payment is missing or short", async () => {
    world = await startWorld();
    const { sandbox } = world;
    const chain = sandbox.chain;
    const buyer = await sandbox.market.fundedSigner();
    // The marketplace's approver, with nothing to spare in its wallet: like a
    // service that never pays for approvals itself.
    const approver = sandbox.market.moderator.signer;
    const floor = await chain.getMinimumBalanceForRentExemption(0);
    const spare = (await chain.getBalance(approver.address)) - floor - BASE_FEE_LAMPORTS;
    await chain.clientFor(approver).send([transferInstruction(approver, buyer.address, spare)]);
    expect(await chain.getBalance(approver.address)).toBe(floor);

    const agentId = values.randomId32();
    const client = chain.clientFor(buyer);
    await client.registerAgent({
      authority: buyer,
      agentId,
      capabilities: 1n,
      endpoint: "https://sandbox.invalid/buyer",
      metadataUri: null,
      stakeAmount: 10_000_000n,
    });
    const [creatorAgent] = await findAgentPda({ agentId });
    const hash = await values.canonicalJobSpecHash({ title: "A line", instructions: "Write a line." });
    const description = new Uint8Array(64);
    description.set(hash.bytes, 0);
    const taskId = values.randomId32();
    const now = BigInt(await chain.clusterTime());
    await client.send([
      await facade.createTask({
        authority: buyer,
        creator: buyer,
        creatorAgent,
        taskId,
        requiredCapabilities: 1n,
        description,
        rewardAmount: 1_000_000n,
        maxWorkers: 1,
        deadline: now + 3_600n,
        taskType: 0,
        constraintHash: null,
        minReputation: 0,
        rewardMintArg: null,
      }),
    ]);
    const [task] = await findTaskPda({ creator: buyer.address, taskId });
    const deposit = await chain.getMinimumBalanceForRentExemption(getTaskModerationSize());
    const record = async () =>
      facade.recordTaskModeration({ moderator: approver, task, jobSpecHash: hash.bytes, ...CLEAN });

    // No payment at all, then short by one: the approver cannot cover the
    // record, so the whole transaction fails and nothing is recorded.
    const buyerBefore = await chain.getBalance(buyer.address);
    for (const attempt of [
      async () => client.send([await record()]),
      async () => client.send([transferInstruction(buyer, approver.address, deposit - 1n), await record()]),
    ]) {
      // Both are the network's own "not enough money": error 1 when the record
      // cannot be created, and the rent rule when a wallet would be left short.
      await expect(attempt()).rejects.toThrow(/program error 1 \(0x1\)|InsufficientFundsForRent/);
      expect(await chain.getBalance(approver.address)).toBe(floor);
    }
    // A failed transaction moved none of the buyer's money either (litesvm
    // charges no fee for a transaction it rejects up front).
    expect(buyerBefore - (await chain.getBalance(buyer.address))).toBeLessThanOrEqual(2n * 2n * BASE_FEE_LAMPORTS);

    // With the full payment the same approval goes through.
    await client.send([transferInstruction(buyer, approver.address, deposit), await record()]);
    expect(await chain.getBalance(approver.address)).toBe(floor);
  }, 60_000);
});

/** Count the approvals the wallet asks for, and optionally swap what comes back. */
function watchedServices(
  seen: { asked: number },
  swap?: (payment: ApprovalPayment, payer: Address, sandbox: Sandbox) => Promise<ApprovalPayment>,
) {
  return (base: MarketServices, sandbox: Sandbox): MarketServices => ({
    ...base,
    async attestTask(input) {
      seen.asked += 1;
      const payment = await base.attestTask(input);
      if (swap === undefined || payment === null) return payment;
      return swap(payment, input.payer, sandbox);
    },
  });
}

/** The approval record of a job, read from the chain. */
async function approvalRecordOf(current: World, task: Address) {
  const scan = current.sandbox.chain.gpa as ProgramAccountsTransport;
  const found = await scan.getProgramAccounts({
    filters: [
      { memcmp: { offset: 0, bytes: Uint8Array.from(getTaskModerationDiscriminatorBytes()) } },
    ],
  });
  return found
    .map((entry) => ({ address: entry.address, record: getTaskModerationDecoder().decode(entry.data) }))
    .find((entry) => entry.record.task === task);
}

describe("the wallet pays for its own approvals", () => {
  it("a buyer pays for the check of its request, and the approver pays nothing", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing } = world;
    const approver = sandbox.market.moderator.address;
    const rent = (space: number) => sandbox.chain.getMinimumBalanceForRentExemption(space);

    // What every job is said to cost before it is hired, and keeps: since
    // revision 9 only the marker its tidied record is compacted into and the
    // fees. The check's deposit comes back with the tidy.
    expect(BigInt((await wallet.networkFee()).lamports)).toBe((await rent(MARKER_SPACE)) + 30_000n);

    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, POLICY);
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const approverBefore = await world.balance(approver);

    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });

    // Posted: its approval is on the chain, recorded by the approver...
    expect(job.status).toBe("waiting");
    const approval = (await approvalRecordOf(world, job.task as Address))!;
    expect(approval.record.moderator).toBe(approver);
    expect(approval.record.creator).toBe(agent.address);
    expect(approval.record.status).toBe(0);
    // ...paid for by the buyer: the approver holds exactly what it held.
    expect(await world.balance(approver)).toBe(approverBefore);
    expect(await world.balance(approval.address)).toBe(await rent(getTaskModerationSize()));
  });

  it("shows the check in what a person is asked to approve", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing } = world;
    const rent = (space: number) => sandbox.chain.getMinimumBalanceForRentExemption(space);
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, { ...POLICY, askAboveCents: 0 });
    await wallet.fundAgent(agent.id, { usdCents: 300 });

    const { approval } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });

    // What never comes back: the marker the tidied job record is compacted
    // into and the first hire's one-time record. The deposit behind the
    // safety check of the request comes back since revision 9.
    expect(BigInt(approval!.fees.lamports)).toBe((await rent(MARKER_SPACE)) + (await rent(67)));
    expect(BigInt(approval!.deposits.lamports)).toBeGreaterThan(BigInt(approval!.fees.lamports));
  });

  it("an agent pays for the check of the service it offers", async () => {
    world = await startWorld({
      earn: {
        executor: {
          argv: [process.execPath, "-e", "process.stdout.write('Done.')", "{prompt}"],
          mode: "sandboxed" as const,
          envAllowlist: [],
          timeoutMs: 30_000,
        },
        pollIntervalMs: 150,
      },
    });
    const { wallet, sandbox } = world;
    const approver = sandbox.market.moderator.address;
    const rent = (space: number) => sandbox.chain.getMinimumBalanceForRentExemption(space);
    const approverBefore = await world.balance(approver);
    const worker = await wallet.createAgent("Worker");

    // The one-time cost shown before anything is spent includes the check:
    // the listing's deposit and fee, the check's deposit and its fee.
    const before = await wallet.setEarn(worker.id, true, 10);
    expect(BigInt(before.earn.offerCost!.lamports)).toBe(
      (await rent(697)) + 5_000n + (await rent(getListingModerationSize())) + 10_000n,
    );

    await wallet.setOffer(worker.id, {
      name: "Line Writer",
      summary: "One friendly line about anything you name.",
      price: { usdCents: 30 },
    });
    const live = await eventually(async () => {
      await wallet.tick();
      const view = (await wallet.overview()).agents.find((entry) => entry.id === worker.id) as AgentView;
      return view.earn.offer?.status === "live" ? view : null;
    }, 30_000);

    expect(live.earn.offer!.statusText).toBe("On offer. Other agents can hire it.");
    // The approver holds exactly what it held: the agent paid.
    expect(await world.balance(approver)).toBe(approverBefore);
  }, 60_000);

  it("new words for a service on offer cost exactly what the view says, and a new price alone pays for no check", async () => {
    world = await startWorld({
      earn: {
        executor: {
          argv: [process.execPath, "-e", "process.stdout.write('Done.')", "{prompt}"],
          mode: "sandboxed" as const,
          envAllowlist: [],
          timeoutMs: 30_000,
        },
        pollIntervalMs: 150,
      },
    });
    const { wallet, sandbox } = world;
    const rent = (space: number) => sandbox.chain.getMinimumBalanceForRentExemption(space);
    const worker = await wallet.createAgent("Worker");
    const before = await wallet.setEarn(worker.id, true, 10);
    // Known before anything is spent: a new check's deposit, its fee and the change's own fee.
    expect(BigInt(before.earn.wordsCost!.lamports)).toBe(
      (await rent(getListingModerationSize())) + 10_000n + BASE_FEE_LAMPORTS,
    );
    const words = { name: "Line Writer", summary: "One friendly line about anything you name.", price: { usdCents: 30 } };
    await wallet.setOffer(worker.id, words);
    const liveAgain = async (): Promise<AgentView> =>
      eventually(async () => {
        await wallet.tick();
        const view = (await wallet.overview()).agents.find((entry) => entry.id === worker.id) as AgentView;
        return view.earn.offer?.status === "live" ? view : null;
      }, 30_000);
    const live = await liveAgain();
    const offerId = live.earn.offer!.id;
    const main = (await wallet.overview()).main.address;
    const mainBefore = await world.balance(main);

    // A new price: the change's fee and nothing for a check.
    const repricedFrom = await world.balance(worker.address);
    await wallet.setOffer(worker.id, { ...words, price: { usdCents: 45 } }, offerId);
    await liveAgain();
    expect(repricedFrom - (await world.balance(worker.address))).toBe(BASE_FEE_LAMPORTS);

    // The same words, tidied the same way, are not new words: nothing is sent at all.
    const sameFrom = await world.balance(worker.address);
    await wallet.setOffer(worker.id, { ...words, summary: `  ${words.summary}  `, price: { usdCents: 45 } }, offerId);
    await liveAgain();
    expect(await world.balance(worker.address)).toBe(sameFrom);

    // New words: exactly the figure the view gave beforehand.
    const rewordedFrom = await world.balance(worker.address);
    await wallet.setOffer(worker.id, { ...words, summary: "Two friendly lines about anything you name.", price: { usdCents: 45 } }, offerId);
    const reworded = await liveAgain();
    expect(rewordedFrom - (await world.balance(worker.address))).toBe(BigInt(reworded.earn.wordsCost!.lamports));
    // None of it came from the balance.
    expect(await world.balance(main)).toBe(mainBefore);
  }, 90_000);

  it("does not sign an approval that takes more than its deposit", async () => {
    const seen = { asked: 0 };
    const extra = 10n * CENT;
    // An approver that signs a real approval but helps itself to ten cents
    // more than the record costs. The wallet could afford it.
    const greedy = async (
      honest: ApprovalPayment,
      payer: Address,
      sandbox: Sandbox,
    ): Promise<ApprovalPayment> => {
      const approver = sandbox.market.moderator.signer;
      const message = getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(honest.transaction).messageBytes,
      );
      if (message.version !== 0) throw new Error("the practice approver builds version 0");
      const accounts = message.staticAccounts;
      const record = message.instructions[message.instructions.length - 1]!;
      const task = accounts[record.accountIndices![1]!]!;
      const hash = Uint8Array.from(record.data!).subarray(8, 40);
      const deposit = await sandbox.chain.getMinimumBalanceForRentExemption(getTaskModerationSize());
      const payerSlot = createNoopSigner(payer);
      const built = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payerSlot, m),
        (m) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: message.lifetimeToken as Blockhash, lastValidBlockHeight: 1_000_000n },
            m,
          ),
        async (m) =>
          appendTransactionMessageInstructions(
            [
              transferInstruction(payerSlot, approver.address, deposit + extra),
              (await facade.recordTaskModeration({
                moderator: approver,
                task,
                jobSpecHash: hash,
                ...CLEAN,
              })) as Instruction,
            ],
            m,
          ),
      );
      const partial = await partiallySignTransactionMessageWithSigners(await built);
      return {
        transaction: new Uint8Array(getTransactionEncoder().encode(partial)),
        moderator: approver.address,
      };
    };
    const lines: string[] = [];
    world = await startWorld({
      services: watchedServices(seen, greedy),
      config: { log: (line) => lines.push(line) },
    });
    const { wallet, sandbox, listing, clock } = world;
    const approver = sandbox.market.moderator.address;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, POLICY);
    await wallet.fundAgent(agent.id, { usdCents: 500 });
    const before = { buyer: await world.balance(agent.address), approver: await world.balance(approver) };

    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });

    // Hired, but not posted: the wallet would not sign what came back.
    expect(seen.asked).toBe(1);
    expect(job.status).toBe("starting");
    // Revision 9: a job's approval never pays its deposit to the approver,
    // so any transfer in it is refused, the greedy one first of all.
    expect(lines.join("\n")).toMatch(/approval transaction refused: a job's approval pays its deposit by a transfer/);
    expect(await world.balance(approver)).toBe(before.approver);
    expect(await approvalRecordOf(world, job.task as Address)).toBeUndefined();
    // It keeps refusing for as long as the answer stays the same.
    await wallet.tick();
    expect(seen.asked).toBe(2);
    expect(await world.balance(approver)).toBe(before.approver);

    // A job that cannot be posted is cancelled and its price comes back.
    clock.now += 31 * 60_000;
    await wallet.tick();
    const refunded = await wallet.getJob(job.id, true);
    expect(refunded.status).toBe("refunded");
    expect(refunded.statusText).toMatch(/price returned/);
    expect(await world.balance(approver)).toBe(before.approver);
    // Gone from the buyer: only what the network keeps for a job that was
    // hired, cancelled and tidied (since revision 9 the marker its record
    // was compacted into, the first hire's one-time record, three fees, and
    // the record of turn-downs and cancels this first cancel started). Not
    // the check, and not the ten cents.
    const rent = (space: number) => sandbox.chain.getMinimumBalanceForRentExemption(space);
    expect(before.buyer - (await world.balance(agent.address))).toBe(
      (await rent(MARKER_SPACE)) + (await rent(67)) + (await rent(129)) + 3n * 5_000n,
    );
  });

  it("does not pay twice when the answer to its payment is lost", async () => {
    const seen = { asked: 0 };
    const mode = { lose: true };
    // The payment reaches the network, and then the connection drops.
    const lossy = (base: Chain): Chain => ({
      ...base,
      async sendSigned(transaction) {
        const signature = await base.sendSigned(transaction);
        if (mode.lose) {
          mode.lose = false;
          throw new Error("socket hang up");
        }
        return signature;
      },
    });
    world = await startWorld({ chain: lossy, services: watchedServices(seen) });
    const { wallet, sandbox, listing } = world;
    const approver = sandbox.market.moderator.address;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, POLICY);
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const before = { buyer: await world.balance(agent.address), approver: await world.balance(approver) };

    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    expect(job.status).toBe("starting");

    // The next look finds the approval it paid for and carries on.
    await wallet.tick();
    expect((await wallet.getJob(job.id, true)).status).toBe("waiting");
    expect(seen.asked).toBe(1);
    // A second payment would have been left in the approver's wallet.
    expect(await world.balance(approver)).toBe(before.approver);
    // So far the buyer is out the price, the deposits a posted job holds, two
    // fees (hire, post) and one check.
    const rent = (space: number) => sandbox.chain.getMinimumBalanceForRentExemption(space);
    const spent = before.buyer - (await world.balance(agent.address));
    expect(spent).toBeGreaterThan(20n * CENT + (await checkCost(world)));
    expect(spent).toBeLessThan(
      20n * CENT + (await checkCost(world)) + 2n * 5_000n + (await rent(466)) + 6n * (await rent(200)),
    );
  });

  it("asks again, but only later, when its payment never went out", async () => {
    const seen = { asked: 0 };
    const mode = { drop: true };
    const dropping = (base: Chain): Chain => ({
      ...base,
      async sendSigned(transaction) {
        if (mode.drop) {
          mode.drop = false;
          throw new Error("socket hang up");
        }
        return base.sendSigned(transaction);
      },
    });
    world = await startWorld({ chain: dropping, services: watchedServices(seen) });
    const { wallet, sandbox, listing, clock } = world;
    const approver = sandbox.market.moderator.address;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, POLICY);
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const approverBefore = await world.balance(approver);

    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    expect(job.status).toBe("starting");
    expect(seen.asked).toBe(1);

    // It cannot know the payment was lost, so it waits out the time a
    // payment can still land before asking for another.
    await wallet.tick();
    clock.now += 60_000;
    await wallet.tick();
    expect(seen.asked).toBe(1);
    expect((await wallet.getJob(job.id, true)).status).toBe("starting");

    clock.now += 61_000;
    await wallet.tick();
    expect(seen.asked).toBe(2);
    expect((await wallet.getJob(job.id, true)).status).toBe("waiting");
    expect(await world.balance(approver)).toBe(approverBefore);
    const [record] = await findTaskModerationPda({
      task: job.task as Address,
      jobSpecHash: (await approvalRecordOf(world, job.task as Address))!.record
        .jobSpecHash as Uint8Array,
      moderator: approver,
    });
    expect(await world.balance(record)).toBe(
      await sandbox.chain.getMinimumBalanceForRentExemption(getTaskModerationSize()),
    );
  });
});
