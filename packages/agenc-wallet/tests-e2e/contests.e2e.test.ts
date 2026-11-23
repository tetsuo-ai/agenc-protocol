import { type Address } from "@solana/kit";
import { facade, findAgentPda, findTaskJobSpecPda, findClaimPda, getTaskDecoder, getTaskJobSpecDecoder, values } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { readProtocolConfig } from "../src/market.js";
import { startWorld, type World, SOL } from "./harness.js";

let world: World;
afterEach(async () => { await world?.wallet.close(); });
const brief = { request: "Enter a poem about rain.", acceptance: ["Use three lines."], reward: { lamports: "90000001" }, contestEntries: 3, reviewWindowSecs: 60 };

async function post(agent = false) {
  const { wallet, sandbox } = world;
  const deadline = await sandbox.chain.clusterTime() + 900;
  const input = { ...brief, deadline, idempotencyKey: "contest-post" };
  const buyer = await wallet.createAgent("Judge");
  sandbox.fund(buyer.address as Address, SOL);
  await wallet.setBudget(buyer.id, 10000);
  const quoted = agent ? await wallet.post({ ...input, agentId: buyer.id }) : await wallet.quotePost(input);
  expect(quoted.job.task).toBeNull();
  expect(quoted.approval?.contestCosts?.entryDeposit.lamports).toBe("10000000");
  expect(BigInt(quoted.approval!.contestCosts!.entryRent.lamports)).toBeGreaterThan(0n);
  expect(BigInt(quoted.approval!.contestCosts!.firstWorkerRecord.lamports)).toBeGreaterThan(0n);
  expect(quoted.approval?.terms?.contest?.releaseAt).toBe(deadline + 172800);
  const job = await wallet.decideApproval(quoted.approval!.id, true);
  expect(job.status, job.error ?? "").toBe("waiting");
  const task = job.task as Address;
  const account = getTaskDecoder().decode((await sandbox.chain.readAccount(task))!);
  expect(account).toMatchObject({ creator: agent ? buyer.address : wallet.mainAddress, taskType: 2, maxWorkers: 3, deadline: BigInt(deadline) });
  const [pointer] = await findTaskJobSpecPda({ task });
  const hash = getTaskJobSpecDecoder().decode((await sandbox.chain.readAccount(pointer))!).jobSpecHash;
  return { task, hash: Uint8Array.from(hash), job, buyer };
}

async function enter(task: Address, hash: Uint8Array, submit = true) {
  const { sandbox } = world;
  const authority = await sandbox.market.fundedSigner();
  const client = sandbox.chain.clientFor(authority);
  const agentId = values.randomId32();
  await client.registerAgent({ authority, agentId, capabilities: 1n, endpoint: "https://contest.invalid", metadataUri: null, stakeAmount: 10000000n });
  const [worker] = await findAgentPda({ agentId });
  await client.claimTaskWithJobSpec({ task, worker, authority, jobSpecHash: hash });
  const [claim] = await findClaimPda({ task, bidder: worker });
  const proofHash = values.randomId32();
  const submitEntry = () => client.submitTaskResult({ task, worker, claim, authority, proofHash, resultData: new Uint8Array(64).fill(1) });
  if (submit) await submitEntry();
  return { worker, authority: authority.address, async reenter() {
    sandbox.market.expireBlockhash();
    await client.claimTaskWithJobSpec({ task, worker, authority, jobSpecHash: hash });
    await submitEntry();
  } };
}

it("quotes and posts from the main balance, then refunds the creator when no one enters", async () => {
  world = await startWorld();
  const { wallet, sandbox } = world;
  await expect(wallet.postFromBalance(brief)).rejects.toThrow(/quote/);
  for (const contestEntries of [0, 1, 5, 2.1]) await expect(wallet.quotePost({ ...brief, contestEntries })).rejects.toThrow(/entry slots/);
  const { job } = await post();
  const before = await world.balance(wallet.mainAddress);
  sandbox.advanceClock(901);
  expect((await wallet.getJob(job.id, true)).status).toBe("refunded");
  expect(await world.balance(wallet.mainAddress)).toBeGreaterThan(before);
});

it("keeps all submissions, quotes a rejection and pays the selected winner only after owner approval", async () => {
  world = await startWorld();
  const { wallet } = world;
  const { task, hash, job, buyer } = await post(true);
  const a = await enter(task, hash);
  const b = await enter(task, hash);
  const read = await wallet.getJob(job.id, true);
  expect(read.contestEntries).toHaveLength(2);
  const first = read.contestEntries!.find(e => e.worker === a.worker)!;
  const winner = read.contestEntries!.find(e => e.worker === b.worker)!;
  const selection = { entryId: winner.id, action: "winner" as const };
  await expect(wallet.approveJob(job.id, undefined, false, buyer.id)).rejects.toThrow(/quote/);
  await expect(wallet.quoteContest(job.id, selection, "another-agent")).rejects.toThrow(/does not exist/);
  await expect(wallet.quoteContest(job.id, selection)).rejects.toThrow(/Reject/);
  await expect(wallet.quoteContest(job.id, { ...selection, action: "release" })).rejects.toThrow(/window/);
  const reject = { action: "reject" as const, entryId: first.id, reason: "The entry has four lines." };
  const before = await world.balance(a.authority);
  const q = (await wallet.quoteContest(job.id, reject, buyer.id)).contestQuote!;
  expect(q.gross.lamports).toBe("0");
  expect(await world.balance(a.authority)).toBe(before);
  await wallet.decideContest(job.id, q.id, true);
  expect(await world.balance(a.authority) - before).toBe(BigInt(q.entryRefund.lamports));
  const winning = (await wallet.quoteContest(job.id, selection)).contestQuote!;
  const beforeWinner = await world.balance(b.authority);
  const [settled] = await Promise.all([wallet.decideContest(job.id, winning.id, true), wallet.decideContest(job.id, winning.id, true)]);
  expect(settled.status).toBe("paid");
  expect(await world.balance(b.authority) - beforeWinner).toBe(BigInt(winning.prize.lamports) + BigInt(winning.entryRefund.lamports));
  expect(settled.contestEntries).toEqual(expect.arrayContaining([expect.objectContaining({ status: "winner" }), expect.objectContaining({ status: "rejected", reason: reject.reason })]));
  const beforeRetire = await world.balance(buyer.address);
  expect((await wallet.retireAgent(buyer.id)).earn.retired).toBe(true);
  expect(await world.balance(buyer.address)).toBeGreaterThan(beforeRetire);
});

it("splits an unclaimed odd prize at the exact boundary, and refuses stale choices", async () => {
  world = await startWorld();
  const { wallet, sandbox } = world;
  const { task, hash, job } = await post();
  const a = await enter(task, hash);
  const b = await enter(task, hash);
  const read = await wallet.getJob(job.id, true);
  const entries = read.contestEntries!;
  const old = (await wallet.quoteContest(job.id, { entryId: entries[0]!.id, action: "reject", reason: "Missing a line." })).contestQuote!;
  sandbox.advanceClock(job.terms!.contest!.releaseAt - await sandbox.chain.clusterTime());
  await expect(wallet.decideContest(job.id, old.id, true)).rejects.toThrow(/shares/);
  let total = 0n;
  for (const worker of [a, b]) {
    const e = entries.find(e => e.worker === worker.worker)!;
    const q = (await wallet.quoteContest(job.id, { entryId: e.id, action: "release" })).contestQuote!;
    const before = await world.balance(worker.authority);
    await wallet.decideContest(job.id, q.id, true);
    expect(await world.balance(worker.authority) - before).toBe(BigInt(q.prize.lamports) + BigInt(q.entryRefund.lamports));
    total += BigInt(q.gross.lamports);
  }
  expect(total).toBe(BigInt(brief.reward.lamports));
  expect((await wallet.getJob(job.id, true)).status).toBe("paid");
});

it("reconciles a lost winner confirmation after restart without sending or paying twice", async () => {
  let loseReply = false;
  let sends = 0;
  world = await startWorld({ transport: base => ({ ...base, async sendAndConfirm(tx) {
    sends++;
    const result = await base.sendAndConfirm(tx);
    if (loseReply) { loseReply = false; throw new Error("Response lost after landing"); }
    return result;
  } }) });
  const { task, hash, job } = await post();
  await enter(task, hash);
  const view = await world.wallet.getJob(job.id, true);
  const q = (await world.wallet.quoteContest(job.id, { entryId: view.contestEntries![0]!.id, action: "winner" })).contestQuote!;
  const before = await world.balance(q.recipient);
  loseReply = true;
  await expect(world.wallet.decideContest(job.id, q.id, true)).rejects.toThrow();
  const after = await world.balance(q.recipient);
  expect(after - before).toBe(BigInt(q.prize.lamports) + BigInt(q.entryRefund.lamports));
  await world.wallet.close();
  world.wallet = await world.reopen();
  expect((await world.wallet.decideContest(job.id, q.id, true)).status).toBe("paid");
  const afterTidy = sends;
  expect((await world.wallet.decideContest(job.id, q.id, true)).contestEntries?.[0]?.status).toBe("winner");
  expect(sends).toBe(afterTidy);
  expect(await world.balance(q.recipient)).toBe(after);
});

it("recovers submissions from program events after other people release every share while the owner is offline", async () => {
  world = await startWorld();
  const { task, hash, job } = await post();
  const { sandbox, wallet } = world;
  await wallet.close();
  const entrants = [await enter(task, hash), await enter(task, hash)];
  sandbox.advanceClock(job.terms!.contest!.releaseAt - await sandbox.chain.clusterTime());
  const cranker = await sandbox.market.fundedSigner();
  const config = await readProtocolConfig(sandbox.chain);
  for (const e of entrants) {
    await sandbox.chain.clientFor(cranker).send([await facade.distributeGhostShare({
      task, cranker, treasury: config.treasury, creator: wallet.mainAddress, worker: e.worker, workerAuthority: e.authority,
    })]);
  }
  world.wallet = await world.reopen();
  const done = await world.wallet.getJob(job.id, true);
  expect(done.status).toBe("paid");
  expect(done.contestEntries?.map(e => e.status)).toEqual(["released", "released"]);
  expect(done.contestEntries?.map(e => e.recipient).sort()).toEqual(entrants.map(e => e.authority).sort());
});

it("returns an empty contest to its payer when several claimants never submit", async () => {
  world = await startWorld();
  const { task, hash, job } = await post();
  await enter(task, hash, false);
  await enter(task, hash, false);
  const before = await world.balance(world.wallet.mainAddress);
  world.sandbox.advanceClock(1200);
  expect((await world.wallet.getJob(job.id, true)).status).toBe("refunded");
  expect(await world.balance(world.wallet.mainAddress)).toBeGreaterThan(before);
});

it("requires a fresh quote when another worker enters after a payout was drafted", async () => {
  world = await startWorld();
  const { task, hash, job } = await post();
  await enter(task, hash);
  const view = await world.wallet.getJob(job.id, true);
  const selection = { entryId: view.contestEntries![0]!.id, action: "winner" as const };
  const quote = (await world.wallet.quoteContest(job.id, selection)).contestQuote!;
  const before = await world.balance(quote.recipient);
  await enter(task, hash, false);
  await expect(world.wallet.decideContest(job.id, quote.id, true)).rejects.toThrow(/changed/);
  expect(await world.balance(quote.recipient)).toBe(before);
  await world.wallet.decideContest(job.id, quote.id, false);
  expect((await world.wallet.getJob(job.id, true)).contestQuote).toBeUndefined();
});

it("refuses to quote a contest without fresh dollar prices", async () => {
  world = await startWorld({ config: { prices: { solUsd: async () => null } } });
  await expect(world.wallet.quotePost(brief)).rejects.toThrow(/Dollar prices/);
  expect(await world.wallet.listApprovals()).toHaveLength(0);
});

it("retains a repeated submission by the same worker in the same second as a distinct entry", async () => {
  world = await startWorld();
  const { task, hash, job } = await post();
  const worker = await enter(task, hash);
  const view = await world.wallet.getJob(job.id, true);
  const original = view.contestEntries![0]!;
  const q = (await world.wallet.quoteContest(job.id, { entryId: original.id, action: "reject", reason: "Missing a line." })).contestQuote!;
  await world.wallet.decideContest(job.id, q.id, true);
  await worker.reenter();
  const again = await world.wallet.getJob(job.id, true);
  expect(again.contestEntries).toHaveLength(2);
  const second = again.contestEntries!.find(e => e.status === "submitted")!;
  expect(second.id).not.toBe(original.id);
  expect(second.hash).toBe(original.hash);
  await expect(world.wallet.quoteContest(job.id, { entryId: original.id, action: "winner" })).rejects.toThrow(/entries/);
  const win = (await world.wallet.quoteContest(job.id, { entryId: second.id, action: "winner" })).contestQuote!;
  expect((await world.wallet.decideContest(job.id, win.id, true)).status).toBe("paid");
});
