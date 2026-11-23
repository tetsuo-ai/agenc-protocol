import { readFileSync } from "node:fs";
import { join } from "node:path";
import { address, some } from "@solana/kit";
import {
  findClaimPda, findTaskSubmissionPda, getTaskSubmissionDecoder, getTaskSubmissionEncoder, getTaskClaimDecoder, findCreatorStatsPda, getTaskDecoder, TaskStatus, getTaskEncoder, TaskType,
} from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it, vi } from "vitest";
import type { WalletState } from "../src/store.js";
import { HAIKU, REVIEW_ALLOWANCE, startWorld, type World } from "./harness.js";

import { reviewRpc } from "./review-rpc.js";

let world: World;
afterEach(async () => { await world?.wallet.close(); });

async function buyer() {
  const agent = await world.wallet.createAgent("Buyer");
  await world.wallet.setPolicy(agent.id, { askAboveCents: 500, refill: REVIEW_ALLOWANCE });
  await world.wallet.fundAgent(agent.id, { usdCents: 500 });
  return agent;
}

async function hire(id: string, listing = world.listing) {
  const { job } = await world.wallet.hire({ agentId: id, listing, request: "Write a haiku." });
  expect(job.status).toBe("waiting");
  return job;
}

const state = () => JSON.parse(readFileSync(join(world.dataDir, "state.json"), "utf8")) as WalletState;

it("refuses a cancel clicked after delivery and reads current terms while history stalls", async () => {
  const history = vi.fn(() => new Promise<never>(() => {}));
  world = await startWorld({ chain: base => ({ ...base, reviewHistory: history }) });
  const agent = await buyer();
  const job = await hire(agent.id);
  await world.sandbox.workOnce();
  const balance = await world.balance(agent.address);
  await expect(world.wallet.refundJob(job.id, true)).rejects.toThrow(/Market/);
  expect(await world.balance(agent.address)).toBe(balance);
  expect((await world.wallet.getJob(job.id, true)).status).toBe("delivered");
  const terms = await world.wallet.reviewRecord(job.id, undefined, { termsOnly: true });
  expect(terms.quote).toMatchObject({ payer: agent.address, dailyLimitCents: 1000, canPay: true });
  expect(history).not.toHaveBeenCalled();
  expect(await world.wallet.reviewRecord(job.id)).toMatchObject({ termsAvailable: true, historyAvailable: false });
}, 15000);

it("reports public evidence and an unsent rejection after the balance drops", async () => {
  world = await startWorld({ services: (services, sandbox) => ({ ...services,
    async postChangeRequest(envelope, signer) {
      await services.postChangeRequest!(envelope, signer);
      const account = sandbox.market.svm.getAccount(signer.address)!;
      sandbox.market.svm.setAccount({ ...account, lamports: 0n } as never);
    },
  }) });
  const job = await hire((await buyer()).id);
  await world.sandbox.workOnce();
  const draft = await world.wallet.draftReview(job.id, "reject", "The title is missing.");
  const error = await world.wallet.confirmReview(job.id, draft, true).then(() => null, cause => cause);
  const record = await world.wallet.reviewRecord(job.id);
  expect(record.publication?.published).toHaveLength(1);
  expect(record.publication?.signature).toBeUndefined();
  expect(error.code).toBe("NOT_ENOUGH_MONEY");
  expect(error.message).not.toMatch(/nothing changed|may already be public/i);
  expect(error.message).toMatch(/evidence is public/i);
  expect(error.message).toMatch(/rejection was not sent/i);
  // A retry can hit the same shortfall in preflight, before publication is attempted again.
  await expect(world.wallet.confirmReview(job.id, draft, true)).rejects.toThrow(/evidence is public.*rejection was not sent/i);
  expect((await world.wallet.getJob(job.id, true)).status).toBe("delivered");
});

it("retries a confirmed payment with a missing acceptance event", async () => {
  const history = reviewRpc(true);
  world = await startWorld({ chain: history.chain, transport: history.transport });
  const job = await hire((await buyer()).id);
  await world.sandbox.workOnce();
  await world.wallet.getJob(job.id, true);
  const quote = (await world.wallet.reviewRecord(job.id)).quote!;
  history.hideAcceptance(true);
  expect((await world.wallet.approveJob(job.id, undefined, true, undefined, quote.id)).status).toBe("paid");
  expect(await world.wallet.reviewRecord(job.id)).toMatchObject({ entries: [], historyAvailable: false });
  history.hideAcceptance(false);
  expect(await world.wallet.reviewRecord(job.id)).toMatchObject({ entries: [{ action: "approve" }], historyAvailable: true });
});

it("uses the quoted rent shortfall and fee when the payer has exactly the displayed total", async () => {
  world = await startWorld();
  const agent = await buyer();
  const job = await hire(agent.id);
  await world.sandbox.workOnce();
  await world.wallet.getJob(job.id, true);
  const original = (await world.wallet.reviewRecord(job.id)).quote!;
  const [stats] = await findCreatorStatsPda({ authority: address(agent.address) });
  world.sandbox.fund(stats, 1_000_000n);
  const quote = (await world.wallet.reviewRecord(job.id)).quote!;
  expect(BigInt(quote.rejectionRent.lamports)).toBe(BigInt(original.rejectionRent.lamports) - 1_000_000n);
  const svm = world.sandbox.market.svm;
  const payer = svm.getAccount(address(agent.address))!;
  svm.setAccount({ ...payer, lamports: BigInt(quote.rejectionTotal.lamports) } as never);
  const draft = await world.wallet.draftReview(job.id, "reject", "A line is missing.");
  await world.wallet.confirmReview(job.id, draft, true);
  expect(await world.balance(agent.address)).toBe(0n);
  expect(state().agents[agent.id]!.refills.filter(r => r.id?.startsWith("review:")).map(r => r.lamports)).toEqual([quote.rejectionTotal.lamports]);
});

it("preflights allowance before publication and serializes concurrent decisions for the same payer", async () => {
  const published = vi.fn();
  world = await startWorld({ services: base => ({ ...base, postChangeRequest: async (...args) => {
    published(); return base.postChangeRequest!(...args);
  } }) });
  const agent = await buyer();
  const jobs = [await hire(agent.id), await hire(agent.id, await world.sandbox.addService({ ...HAIKU, name: "Second writer" }))];
  await world.sandbox.workOnce();
  await Promise.all(jobs.map(job => world.wallet.getJob(job.id, true)));
  const approve = async (id: string) => world.wallet.confirmReview(id, await world.wallet.draftReview(id, "reject", "A line is missing."), true);
  await world.wallet.setPolicy(agent.id, { askAboveCents: 500, refill: { ...REVIEW_ALLOWANCE, enabled: false } });
  await expect(approve(jobs[0]!.id)).rejects.toThrow(/allowance/);
  expect(published).not.toHaveBeenCalled();
  // Different providers share one creator record. Both first-turn-down quotes include its rent.
  const total = (await world.wallet.reviewRecord(jobs[0]!.id)).quote!.rejectionTotal;
  await world.wallet.setPolicy(agent.id, { askAboveCents: 500, refill: { ...REVIEW_ALLOWANCE, perDayCents: Math.ceil(Number(total.lamports) / 100000) } });
  const drafts = await Promise.all(jobs.map(job => world.wallet.draftReview(job.id, "reject", "A line is missing.")));
  const outcomes = await Promise.allSettled(jobs.map((job, i) => world.wallet.confirmReview(job.id, drafts[i]!, true)));
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(published).toHaveBeenCalledTimes(1);
  expect(state().agents[agent.id]!.refills.filter(row => row.id?.startsWith("review:"))).toHaveLength(1);
});

it("recovers a lost broadcast acknowledgement and charges the signature once across restart", async () => {
  let lost = false;
  world = await startWorld({ transport: base => ({ ...base, async sendAndConfirm(signed) {
    const result = await base.sendAndConfirm(signed);
    if (lost) { lost = false; throw new Error("acknowledgement lost"); }
    return result;
  } }) });
  const agent = await buyer();
  const job = await hire(agent.id);
  await world.sandbox.workOnce();
  await world.wallet.getJob(job.id, true);
  const draft = await world.wallet.draftReview(job.id, "change", "Please revise line one.");
  lost = true;
  await expect(world.wallet.confirmReview(job.id, draft, true)).rejects.toThrow(/job record/);
  await world.wallet.close();
  world.wallet = await world.reopen();
  expect((await world.wallet.reviewRecord(job.id)).publication).toMatchObject({ confirmed: true, signature: expect.any(String), hashes: [expect.any(String)] });
  await expect(world.wallet.confirmReview(job.id, draft, true)).rejects.toThrow();
  expect(state().agents[agent.id]!.refills.filter(row => row.id?.startsWith("review:")).map(row => row.lamports)).toEqual(["5000"]);
});

it("offers only an executable change request for a legacy token reward", async () => {
  world = await startWorld();
  const agent = await buyer();
  const job = await hire(agent.id);
  await world.sandbox.workOnce();
  await world.wallet.getJob(job.id, true);
  const svm = world.sandbox.market.svm;
  const raw = svm.getAccount(address(job.task!))!;
  if (!raw.exists) throw new Error("Missing task");
  const task = getTaskDecoder().decode(raw.data);
  svm.setAccount({ ...raw, data: getTaskEncoder().encode({ ...task, rewardMint: some(address(agent.address)) }) } as never);
  const delivered = await world.wallet.getJob(job.id, true);
  expect(delivered).toMatchObject({ canApprove: false, canRefund: false, canAskChanges: true, autoApproveAt: null });
  expect(delivered.statusText).not.toMatch(/approve it to pay|it is paid/i);
  const quote = (await world.wallet.reviewRecord(job.id)).quote!;
  expect(quote).toMatchObject({ canPay: false, actions: ["change"] });
  await expect(world.wallet.approveJob(job.id, undefined, true, undefined, quote.id)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  expect(state().reviewIntents?.[job.id]).toBeUndefined();
  const draft = await world.wallet.draftReview(job.id, "change", "Add the missing title.");
  expect((await world.wallet.confirmReview(job.id, draft, true)).status).toBe("changes_requested");
});

it("filters contest, multi-worker and token actions using the submitted job's chain terms", async () => {
  world = await startWorld();
  const agent = await buyer();
  const job = await hire(agent.id);
  await world.sandbox.workOnce();
  await world.wallet.getJob(job.id, true);
  const svm = world.sandbox.market.svm;
  const raw = svm.getAccount(address(job.task!))!;
  if (!raw.exists) throw new Error("Missing sandbox task");
  const task = getTaskDecoder().decode(raw.data);
  for (const [change, actions] of [
    [{ taskType: TaskType.Collaborative }, ["change"]],
    [{ rewardMint: some(address(agent.address)) }, ["change"]],
    [{ taskType: TaskType.Competitive, reserved: Uint8Array.from(task.reserved, (_, i) => i === 0 ? 1 : 0) }, []],
  ] as const) {
    svm.setAccount({ ...raw, data: getTaskEncoder().encode({ ...task, ...change }) } as never);
    expect((await world.wallet.reviewRecord(job.id)).quote?.actions).toEqual(actions);
    await expect(world.wallet.draftReview(job.id, "reject", "Missing a line.")).rejects.toThrow();
  }
  svm.setAccount({ ...raw, data: getTaskEncoder().encode({ ...task, taskType: TaskType.Collaborative }) } as never);
  const request = await world.wallet.draftReview(job.id, "change", "Please add the title.");
  await world.wallet.confirmReview(job.id, request, true);
  const current = getTaskDecoder().decode((await world.sandbox.chain.readAccount(address(job.task!)))!);
  const [claim] = await findClaimPda({ task: address(job.task!), bidder: address(state().jobs[job.id]!.providerAgent) });
  const held = getTaskClaimDecoder().decode((await world.sandbox.chain.readAccount(claim))!);
  // Other claims can hold the task pending and extend its shared deadline beyond this worker's.
  svm.setAccount({ ...raw, data: getTaskEncoder().encode({ ...current, status: TaskStatus.PendingValidation, deadline: held.expiresAt + 86400n }) } as never);
  expect((await world.wallet.reviewRecord(job.id)).resubmitBy).toBe(Number(held.expiresAt) * 1000);
});

it.each(["approve", "reject", "change"] as const)("refuses a changed delivery at the %s signing boundary", async action => {
  let replace: (() => void) | undefined;
  let sends = 0;
  world = await startWorld({ transport: base => ({ ...base,
    async getLatestBlockhash() {
      const latest = await base.getLatestBlockhash();
      replace?.();
      return latest;
    },
    async sendAndConfirm(tx) { sends++; return base.sendAndConfirm(tx); },
  }) });
  const agent = await buyer();
  const job = await hire(agent.id);
  await world.sandbox.workOnce();
  await world.wallet.getJob(job.id, true);
  const quote = (await world.wallet.reviewRecord(job.id)).quote!;
  const draft = action === "approve" ? null : await world.wallet.draftReview(job.id, action, "Review this line.");
  const [claim] = await findClaimPda({ task: address(job.task!), bidder: address(state().jobs[job.id]!.providerAgent) });
  const [submission] = await findTaskSubmissionPda({ claim });
  const svm = world.sandbox.market.svm;
  const original = svm.getAccount(submission)!;
  if (!original.exists) throw new Error("Missing submission");
  const account = getTaskSubmissionDecoder().decode(original.data);
  replace = () => {
    replace = undefined;
    const change = action === "reject" ? { proofHash: Buffer.alloc(32, 3) } : { submissionCount: account.submissionCount + 1 };
    svm.setAccount({ ...original, data: getTaskSubmissionEncoder().encode({ ...account, ...change }) } as never);
  };
  const before = sends;
  await expect(draft ? world.wallet.confirmReview(job.id, draft, true) : world.wallet.approveJob(job.id, undefined, true, undefined, quote.id))
    .rejects.toThrow(/delivery changed before signing/i);
  expect(sends).toBe(before);
  expect(state().reviewIntents?.[job.id]?.receipt).toBeUndefined();
});
