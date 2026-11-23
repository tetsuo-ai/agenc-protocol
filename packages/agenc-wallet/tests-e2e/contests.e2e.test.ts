import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WalletState } from "../src/store.js";
import { type TransactionSigner, type Address } from "@solana/kit";
import { findTaskAttestorConfigPda, getTaskAttestorConfigSize, facade, findAgentPda, findTaskJobSpecPda, findClaimPda, getTaskDecoder, getTaskJobSpecDecoder, values } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { inTransportScope } from "../src/transport-scope.js";
import { contestRegistration } from "../src/contest.js";
import { readProtocolConfig } from "../src/market.js";
import { startWorld, type World, SOL } from "./harness.js";

let world: World;
afterEach(async () => { await world?.wallet.close(); });
const brief = { request: "Enter a poem about rain.", acceptance: ["Use three lines."], reward: { lamports: "90000001" }, contestEntries: 3, reviewWindowSecs: 60 };

async function post(agent = false, contestEntries = 3) {
  const { wallet, sandbox } = world;
  const deadline = await sandbox.chain.clusterTime() + 900;
  const input = { ...brief, contestEntries, deadline, idempotencyKey: "contest-post" };
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
  expect(account).toMatchObject({ creator: agent ? buyer.address : wallet.mainAddress, taskType: 2, maxWorkers: contestEntries, deadline: BigInt(deadline) });
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
  expect((await wallet.getJob(job.id, true)).status).toBe("waiting");
  await wallet.tick();
  expect(await world.balance(wallet.mainAddress)).toBe(before);
  const quote = (await wallet.refundJob(job.id, true)).contestQuote!;
  expect(quote.action).toBe("cancel");
  const settled = await wallet.decideContest(job.id, quote.id, true);
  expect(settled.status).toBe("refunded");
  expect((await wallet.decideContest(job.id, quote.id, true)).contestReceipt?.signature).toBe(settled.contestReceipt?.signature);
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
  const paid = done.contestEntries!.map(entry => {
    const receipt = entry.settlement!;
    expect(receipt.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(receipt.changes?.some(delta => delta.address === entry.recipient && BigInt(delta.lamports) > BigInt(receipt.prize!))).toBe(true);
    return BigInt(receipt.prize!) + BigInt(receipt.fee!);
  });
  expect(paid[0]! + paid[1]!).toBe(BigInt(brief.reward.lamports));
});

it("refunds four no-shows with the configured priority fee and all guards in one packet", async () => {
  world = await startWorld({ chain: base => ({ ...base, transferFeeLamports: 5001n, clientFor(signer) {
    const client = base.clientFor(signer);
    return { ...client, send: (instructions, options) => client.send(instructions,
      { ...options, computeUnitPrice: 1n, computeUnitLimit: 250000 }) };
  } }) });
  const { task, hash, job } = await post(false, 4);
  for (let i = 0; i < 4; i++) await enter(task, hash, false);
  const before = await world.balance(world.wallet.mainAddress);
  world.sandbox.advanceClock(1200);
  expect((await world.wallet.getJob(job.id, true)).status).toBe("working");
  expect(await world.balance(world.wallet.mainAddress)).toBe(before);
  const q = (await world.wallet.quoteContest(job.id, { action: "cancel", entryId: "" })).contestQuote!;
  expect(q.networkFee.lamports).toBe("5001");
  expect(q.transfers?.filter(t => t.label === "No-show deposit").map(t => t.amount.lamports)).toEqual(Array(4).fill("10000000"));
  expect(q.transfers?.filter(t => t.label === "Claim rent return")).toHaveLength(4);
  expect((await world.wallet.decideContest(job.id, q.id, true)).status).toBe("refunded");
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
  await expect(world.wallet.quoteContest(job.id, { entryId: original.id, action: "winner" })).rejects.toThrow(/entr/);
  const win = (await world.wallet.quoteContest(job.id, { entryId: second.id, action: "winner" })).contestQuote!;
  expect((await world.wallet.decideContest(job.id, win.id, true)).status).toBe("paid");
});

it("recovers a terminal no-show by quote after restart and returns all contest record rent", async () => {
  let loseReply = false;
  world = await startWorld({ transport: base => ({ ...base, async sendAndConfirm(tx) {
    const landed = await base.sendAndConfirm(tx);
    if (loseReply) { loseReply = false; throw new Error("Lost claim recovery reply"); }
    return landed;
  } }) });
  const { wallet, sandbox } = world;
  const { task, hash, job } = await post();
  await enter(task, hash);
  const noShow = await enter(task, hash, false);
  const view = await wallet.getJob(job.id, true);
  const q = (await wallet.quoteContest(job.id, { action: "winner", entryId: view.contestEntries![0]!.id })).contestQuote!;
  const paid = await wallet.decideContest(job.id, q.id, true);
  expect(paid.contestClaims).toHaveLength(1);
  const claim = paid.contestClaims![0]!.claim;
  const workerBefore = await world.balance(noShow.authority);
  const recovery = (await wallet.quoteContest(job.id, { action: "reclaim", entryId: claim })).contestQuote!;
  expect(recovery.transfers!.find(t => t.label === "No-show deposit")?.amount.lamports).toBe("10000000");
  loseReply = true;
  await expect(wallet.decideContest(job.id, recovery.id, true)).rejects.toThrow(/Lost/);
  await wallet.close();
  world.wallet = await world.reopen();
  const landed = await world.wallet.decideContest(job.id, recovery.id, true);
  expect(landed.contestClaims).toHaveLength(0);
  expect(await world.balance(claim)).toBe(0n);
  expect(await world.balance(noShow.authority) - workerBefore).toBe(BigInt(recovery.entryRefund.lamports));
  const [attestor] = await findTaskAttestorConfigPda({ task });
  expect(await world.balance(attestor)).toBe(await sandbox.chain.getMinimumBalanceForRentExemption(getTaskAttestorConfigSize()));
  const cleanup = (await world.wallet.quoteContest(job.id, { action: "cleanup", entryId: "" })).contestQuote!;
  const before = await world.balance(wallet.mainAddress);
  await world.wallet.tick();
  await world.wallet.getJob(job.id, true);
  expect(await world.balance(wallet.mainAddress)).toBe(before);
  await world.wallet.decideContest(job.id, cleanup.id, true);
  expect(await world.balance(attestor)).toBe(0n);
  expect(await world.balance(wallet.mainAddress) - before).toBe(BigInt(cleanup.transfers![0]!.amount.lamports) - BigInt(cleanup.networkFee.lamports));
});

it("refuses the signed settlement atomically when another valid share is released during dispatch", async () => {
  let beforeDispatch: (() => Promise<void>) | undefined;
  world = await startWorld({ transport: base => ({ ...base, async sendAndConfirm(tx) {
    const run = beforeDispatch;
    beforeDispatch = undefined;
    await run?.();
    return base.sendAndConfirm(tx);
  } }) });
  const { task, hash, job } = await post();
  const first = await enter(task, hash);
  const other = await enter(task, hash);
  const { sandbox, wallet } = world;
  sandbox.advanceClock(job.terms!.contest!.releaseAt - await sandbox.chain.clusterTime());
  const entry = (await wallet.getJob(job.id, true)).contestEntries!.find(e => e.worker === first.worker)!;
  const q = (await wallet.quoteContest(job.id, { action: "release", entryId: entry.id })).contestQuote!;
  const before = await world.balance(first.authority);
  const caller = await sandbox.market.fundedSigner();
  beforeDispatch = async () => {
    const share = await facade.distributeGhostShare({ task, creator: wallet.mainAddress, worker: other.worker,
      workerAuthority: other.authority, treasury: q.treasury as Address, cranker: caller });
    // A separate caller has its own dispatch journal.
    await inTransportScope({ signal: new AbortController().signal, sending() {}, confirmed() {} }, () => sandbox.chain.clientFor(caller).send([share]));
  };
  await expect(wallet.decideContest(job.id, q.id, true)).rejects.toThrow();
  expect(await world.balance(first.authority)).toBe(before);
  const fresh = (await wallet.quoteContest(job.id, { action: "release", entryId: entry.id })).contestQuote!;
  expect(BigInt(fresh.prize.lamports)).toBe(BigInt(q.prize.lamports) + 1n);
  expect((await wallet.decideContest(job.id, fresh.id, true)).status).toBe("paid");
});

it("expires during a delayed final balance read without dispatching a transaction", async () => {
  let expire = false, sends = 0;
  world = await startWorld({ chain: base => ({ ...base, async getBalance(address) {
    if (expire) world.clock.now += 31 * 60_000;
    return base.getBalance(address);
  } }), transport: base => ({ ...base, async sendAndConfirm(tx) { sends++; return base.sendAndConfirm(tx); } }) });
  const { task, hash, job } = await post();
  await enter(task, hash);
  const { wallet } = world;
  const entry = (await wallet.getJob(job.id, true)).contestEntries![0]!;
  const q = (await wallet.quoteContest(job.id, { action: "winner", entryId: entry.id })).contestQuote!;
  const before = sends;
  expire = true;
  await expect(wallet.decideContest(job.id, q.id, true)).rejects.toThrow(/expired/);
  expect(sends).toBe(before);
});

it("quotes a fractional contest overage and preserves its outcome across a chat replay", async () => {
  let rate = 100;
  world = await startWorld({ config: { prices: { solUsd: async () => rate } } });
  const { wallet, sandbox } = world;
  const agent = await wallet.createAgent("Contest buyer");
  sandbox.fund(agent.address as Address, SOL);
  await wallet.setBudget(agent.id, 1);
  const input = { ...brief, reward: { usdCents: 19.9 }, agentId: agent.id, idempotencyKey: "fractional-contest" };
  const quote = (await wallet.post(input)).approval!;
  expect(quote.maxPriceCents).toBe(19.9);
  expect(quote.contestOverBudget).toBe(true);
  const before = await world.balance(agent.address);
  rate = 101;
  await expect(wallet.decideApproval(quote.id, true)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  expect(await world.balance(agent.address)).toBe(before);
  rate = 100;
  const job = await wallet.decideApproval(quote.id, true);
  expect(job.status).toBe("waiting");
  const refund = (await wallet.refundJob(job.id, true)).contestQuote!;
  await wallet.decideContest(job.id, refund.id, true);
  const tidy = (await wallet.quoteContest(job.id, { action: "cleanup", entryId: "" })).contestQuote!;
  await wallet.decideContest(job.id, tidy.id, true);
  await wallet.close();
  const file = join(world.dataDir, "state.json");
  const state: WalletState = JSON.parse(readFileSync(file, "utf8"));
  const { terms: _terms, ...finished } = state.jobs[job.id]!;
  for (let i = 0; i < 500; i++) {
    const id = "later-" + i;
    state.jobs[id] = { ...finished, id, idempotencyKey: null, updatedAt: finished.updatedAt + 1 };
  }
  writeFileSync(file, JSON.stringify(state));
  world.wallet = await world.reopen();
  await world.wallet.renameAgent(agent.id, "Contest buyer again");
  expect(JSON.parse(readFileSync(file, "utf8")).jobs[job.id]).toBeUndefined();
  await world.wallet.close();
  world.wallet = await world.reopen();
  expect((await world.wallet.post(input)).job.task).toBe(job.task);
  expect((await world.wallet.callOutcome(agent.id, "request", input.idempotencyKey)).job.id).toBe(job.id);
  await expect(world.wallet.post({ ...input, contestEntries: 4 })).rejects.toThrow();
});

it("quotes a fresh main registration after its previous identity retires", async () => {
  let creator: TransactionSigner | undefined;
  world = await startWorld({ chain: base => ({ ...base, clientFor(signer) {
    if (signer.address === world?.wallet.mainAddress) creator = signer;
    return base.clientFor(signer);
  } }) });
  const { wallet, sandbox } = world;
  const { task, job } = await post();
  const registration = await contestRegistration(sandbox.chain, wallet.mainAddress, "");
  const [agent] = await findAgentPda({ agentId: values.hexToBytes(registration.agentId) });
  const q = (await wallet.refundJob(job.id, true)).contestQuote!;
  await wallet.decideContest(job.id, q.id, true);
  const tidy = (await wallet.quoteContest(job.id, { action: "cleanup", entryId: "" })).contestQuote!;
  await wallet.decideContest(job.id, tidy.id, true);
  await sandbox.chain.clientFor(creator!).send([await facade.deregisterAgent({ agent, authority: creator! })]);
  const fresh = (await wallet.quotePost({ ...brief, idempotencyKey: "after-retirement" })).approval!;
  expect(BigInt(fresh.contestCosts!.registrationStake.lamports)).toBeGreaterThan(0n);
  const next = await wallet.decideApproval(fresh.id, true);
  expect(next.status).toBe("waiting");
  expect(next.task).not.toBe(task);
});

it("pages a roster bigger than a socket frame and reads individual long entries by ID", async () => {
  const content = new Map<string, string>();
  world = await startWorld({ services: base => ({ ...base, async fetchResult({ proofHashHex }) {
    const text = content.get(proofHashHex);
    return text ? { bytes: Buffer.from(text), uri: "https://example.invalid/entry/" + proofHashHex } : null;
  } }) });
  const { task, job, hash } = await post();
  await enter(task, hash);
  await enter(task, hash);
  const { wallet } = world;
  const entries = (await wallet.getJob(job.id, true)).contestEntries!;
  for (const [i, e] of entries.entries()) content.set(e.hash, `entry ${i} `.repeat(4000));
  for (const e of entries) expect((await wallet.jobDelivery(job.id, true, undefined, e.id)).text).toBe(content.get(e.hash));
  await wallet.close();
  const file = join(world.dataDir, "state.json");
  const state = JSON.parse(readFileSync(file, "utf8")) as WalletState;
  const record = state.jobs[job.id]!;
  for (let i = 0; i < 120; i++) record.contestEntries!.push({ ...record.contestEntries![0]!, status: "closed", id: `saved-${i}`, text: "x".repeat(20000) });
  writeFileSync(file, JSON.stringify(state));
  world.wallet = await world.reopen();
  const view = await world.wallet.getJob(job.id, true);
  expect(JSON.stringify(view).length).toBeLessThan(64000);
  const ids = view.contestEntries!.map(e => e.id);
  let next = view.contestNext;
  while (next) {
    const page = world.wallet.contestPage(job.id, next);
    ids.push(...page.entries.map(e => e.id));
    next = page.next;
  }
  expect(new Set(ids).size).toBe(122);
  const draft = await world.wallet.quoteContest(job.id, { action: "reject", entryId: entries[0]!.id, reason: "Review complete." });
  expect(world.wallet.savedContestQuote(job.id, draft.contestQuote!.id).quote.proof).toBe(entries[0]!.hash);
  const confirmed = await world.wallet.decideContest(job.id, draft.contestQuote!.id, true);
  expect(JSON.stringify(confirmed).length).toBeLessThan(64000);
});

it("charges only the quoted first cancellation and returns the attestor deposit", async () => {
  world = await startWorld();
  const { wallet } = world;
  const before = await world.balance(wallet.mainAddress);
  const post = (await wallet.quotePost(brief)).approval!;
  const job = await wallet.decideApproval(post.id, true);
  const refund = (await wallet.refundJob(job.id, true)).contestQuote!;
  expect(refund.recordCost.lamports).toBe(post.cancellationRent!.lamports);
  await wallet.decideContest(job.id, refund.id, true);
  const tidy = (await wallet.quoteContest(job.id, { entryId: "", action: "cleanup" })).contestQuote!;
  await wallet.decideContest(job.id, tidy.id, true);
  const registration = BigInt(post.contestCosts!.registrationRent.lamports) + BigInt(post.contestCosts!.registrationStake.lamports);
  expect(before - await world.balance(wallet.mainAddress) - registration).toBeLessThanOrEqual(BigInt(post.fees.lamports));
});

it("finds the attestor rent on a previously tidied contest and quotes its return", async () => {
  let creator: TransactionSigner | undefined;
  world = await startWorld({ chain: base => ({ ...base, clientFor(signer) {
    if (signer.address === world?.wallet.mainAddress) creator = signer;
    return base.clientFor(signer);
  } }) });
  const { task, job } = await post();
  const { wallet, sandbox } = world;
  const refund = (await wallet.refundJob(job.id, true)).contestQuote!;
  await wallet.decideContest(job.id, refund.id, true);
  // A revision 9 close from an older wallet compacts the task but omits its attestor.
  await sandbox.chain.clientFor(creator!).send([await facade.closeTask({ task, authority: creator! })]);
  const [attestor] = await findTaskAttestorConfigPda({ task });
  const rent = await world.balance(attestor);
  expect(rent).toBeGreaterThan(0n);
  await wallet.close();
  const file = join(world.dataDir, "state.json");
  const state: WalletState = JSON.parse(readFileSync(file, "utf8"));
  const legacy = state.jobs[job.id]!;
  legacy.tidied = true;
  delete legacy.contestScanned;
  writeFileSync(file, JSON.stringify(state));
  world.wallet = await world.reopen();
  await world.wallet.tick();
  expect((await world.wallet.getJob(job.id, true)).contestCleanup).toBe(true);
  expect(await world.balance(attestor)).toBe(rent);
  const quote = (await world.wallet.quoteContest(job.id, { action: "cleanup", entryId: "" })).contestQuote!;
  const owner = await world.balance(wallet.mainAddress);
  await world.wallet.decideContest(job.id, quote.id, true);
  expect(await world.balance(attestor)).toBe(0n);
  expect(await world.balance(wallet.mainAddress) - owner).toBe(BigInt(quote.transfers![0]!.amount.lamports) - BigInt(quote.networkFee.lamports));
});

it("lists an entry submitted between the history and live reads only once", async () => {
  let submit: (() => Promise<unknown>) | undefined;
  world = await startWorld({ chain: base => ({ ...base, async contestHistory(...params) {
    const page = await base.contestHistory!(...params);
    const next = submit;
    submit = undefined;
    await next?.();
    return page;
  } }) });
  const { job, task, hash } = await post();
  submit = () => enter(task, hash);
  const first = (await world.wallet.getJob(job.id, true)).contestEntries!;
  expect(first.map(e => e.status)).toEqual(["submitted"]);
  const second = (await world.wallet.getJob(job.id, true)).contestEntries!;
  expect(second.map(e => [e.id, e.status])).toEqual([[first[0]!.id, "submitted"]]);
});

it("reconciles funding on read and refunds an interrupted publication on a fresh owner quote", async () => {
  let dispatches = 0;
  world = await startWorld({ transport: base => ({ ...base, async sendAndConfirm(tx) {
    dispatches++;
    return base.sendAndConfirm(tx);
  } }) });
  const { job } = await post();
  await world.wallet.close();
  const file = join(world.dataDir, "state.json");
  const state: WalletState = JSON.parse(readFileSync(file, "utf8"));
  const record = state.jobs[job.id]!;
  record.phase = "hiring";
  record.approvedCosts!.expiresAt = world.clock.now - 1;
  writeFileSync(file, JSON.stringify(state));
  const count = dispatches;
  world.wallet = await world.reopen();
  await world.wallet.tick();
  await world.wallet.getJob(job.id, true);
  expect(dispatches).toBe(count);
  const quote = (await world.wallet.refundJob(job.id, true)).contestQuote!;
  expect((await world.wallet.decideContest(job.id, quote.id, true)).status).toBe("refunded");
  expect(dispatches).toBe(count + 1);
});
