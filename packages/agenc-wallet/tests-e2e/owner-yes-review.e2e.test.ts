// Owner regression sweep 12 (rel/0.1.17, rt12-a bug 1): on a hire paid with an
// agent's own money the person's "Yes, turn it down" was refused with "This
// review would exceed the agent's daily allowance.", and so was the seller's
// "Yes, dispute it" on its own agent's work. A turn-down and a dispute are the
// person's decisions only, so the person's yes to that exact quote covers them
// above the agent's daily amount, once, still counted against the day, as it
// covers an approval. An agent's own call never takes this path.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { WalletState } from "../src/store.js";
import { AGENT_METHODS } from "../src/client/protocol.js";
import { confirmDecision, eventually, REVIEW_ALLOWANCE, setEarnWithApproval, startWorld, type World } from "./harness.js";

let w: World | null = null;
afterEach(async () => { await w?.wallet.close(); w = null; });
const state = () => JSON.parse(readFileSync(path.join(w!.dataDir, "state.json"), "utf8")) as WalletState;
const charges = (agentId: string) => state().agents[agentId]!.refills.filter(row => row.id?.startsWith("review:")).map(row => row.lamports);
/** "Asks you every time", with no daily amount: the agent spends nothing on its own. */
const ASKS_EVERY_TIME = { askAboveCents: 0, refill: { enabled: false, topUpToCents: 0, perDayCents: 0 } };

async function agentPaidDelivery() {
  w = await startWorld();
  const { wallet, sandbox, listing } = w;
  const agent = await wallet.createAgent("My assistant");
  await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: REVIEW_ALLOWANCE });
  await wallet.fundAgent(agent.id, { usdCents: 300 });
  await wallet.setPolicy(agent.id, ASKS_EVERY_TIME);
  const hire = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
  await wallet.decideApproval(hire.approval!.id, true);
  expect(await sandbox.workOnce()).toBe(1);
  expect((await wallet.getJob(hire.job.id, true)).status).toBe("delivered");
  return { wallet, agent, jobId: hire.job.id };
}

it("turns down an agent-paid delivery on the person's yes above the daily amount, once, and counts it", async () => {
  const { wallet, agent, jobId } = await agentPaidDelivery();
  const { quote } = await wallet.reviewRecord(jobId, undefined, { termsOnly: true });
  const before = await w!.balance(agent.address);
  const draft = await wallet.draftReview(jobId, "reject", "The haiku has four lines.");
  const done = await wallet.confirmReview(jobId, draft, true);
  expect(done.status).not.toBe("delivered");
  expect(before - await w!.balance(agent.address)).toBe(BigInt(quote!.rejectionTotal.lamports));
  // Still counted against the agent's day.
  expect(charges(agent.id)).toEqual([quote!.rejectionTotal.lamports]);
  // One use: the same yes cannot send it again.
  await expect(wallet.confirmReview(jobId, draft, true)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  expect(charges(agent.id)).toHaveLength(1);
});

it("still refuses a turn-down an agent asks for on its own", async () => {
  const { wallet, agent, jobId } = await agentPaidDelivery();
  const before = await w!.balance(agent.address);
  const draft = await wallet.draftReview(jobId, "reject", "The haiku has four lines.", [], agent.id);
  await expect(wallet.confirmReview(jobId, draft, false)).rejects.toMatchObject({ code: "NOT_ALLOWED", message: expect.stringContaining("confirm this decision in Market") });
  expect(AGENT_METHODS).not.toContain("jobs.confirmReview");
  expect(await w!.balance(agent.address)).toBe(before);
  expect(charges(agent.id)).toEqual([]);
  expect((await wallet.getJob(jobId, true)).status).toBe("delivered");
});

it("still says when the agent's own money is short for the turn-down, and moves nothing", async () => {
  const { wallet, agent, jobId } = await agentPaidDelivery();
  const svm = w!.sandbox.market.svm;
  const { address } = await import("@solana/kit");
  const account = svm.getAccount(address(agent.address))!;
  const { quote } = await wallet.reviewRecord(jobId, undefined, { termsOnly: true });
  svm.setAccount({ ...account, lamports: BigInt(quote!.rejectionTotal.lamports) - 1n } as never);
  const draft = await wallet.draftReview(jobId, "reject", "The haiku has four lines.");
  await expect(wallet.confirmReview(jobId, draft, true)).rejects.toMatchObject({ code: "NOT_ENOUGH_MONEY" });
  expect(charges(agent.id)).toEqual([]);
  expect((await wallet.getJob(jobId, true)).status).toBe("delivered");
});

it("disputes a turn-down of its own agent's work on the person's yes above the daily amount, once, and counts it", async () => {
  w = await startWorld({ earn: { executor: { argv: [process.execPath, "-e", "process.stdout.write('Done work.')", "{prompt}"],
    mode: "sandboxed", envAllowlist: [], timeoutMs: 30_000 }, pollIntervalMs: 150 } });
  const { wallet } = w;
  const buyer = await wallet.createAgent("Buyer");
  const seller = await wallet.createAgent("My assistant");
  await wallet.setPolicy(buyer.id, { askAboveCents: 1000, refill: REVIEW_ALLOWANCE });
  await wallet.setPolicy(seller.id, { askAboveCents: 1000, refill: { enabled: true, topUpToCents: 1, perDayCents: 3000 } });
  await wallet.fundAgent(buyer.id, { usdCents: 500 });
  await setEarnWithApproval(wallet, seller.id, true, 10);
  const { job } = await wallet.post({ agentId: buyer.id, request: "Write one line.", reward: { usdCents: 50 } });
  await eventually(async () => (await wallet.getJob(job.id, true)).result?.text === "Done work.", 60_000);
  await confirmDecision(wallet, job.id, "reject", "The line is missing a rhyme.");
  const sellerJob = (await wallet.listJobs({ role: "working", agentId: seller.id }, true))[0]!;
  await wallet.fundAgent(seller.id, { usdCents: 200 });
  // The seller's agent may not spend on its own any more.
  await wallet.setPolicy(seller.id, ASKS_EVERY_TIME);
  const held = (await wallet.reviewRecord(sellerJob.id)).quote!;
  expect(held.actions).toEqual(["dispute"]);
  const draft = await wallet.draftReview(sellerJob.id, "dispute", "The brief asked for no rhyme.", [], seller.id);
  // The agent's own call is refused and moves nothing.
  const before = await w.balance(seller.address);
  await expect(wallet.confirmReview(sellerJob.id, draft, false)).rejects.toMatchObject({ code: "NOT_ALLOWED", message: expect.stringContaining("confirm this decision in Market") });
  expect(await w.balance(seller.address)).toBe(before);
  // The person's yes sends it.
  await wallet.confirmReview(sellerJob.id, draft, true);
  expect(before - await w.balance(seller.address)).toBe(BigInt(held.disputeTotal.lamports));
  expect(charges(seller.id)).toEqual([held.disputeTotal.lamports]);
  expect((await wallet.reviewRecord(sellerJob.id)).entries.at(-1)).toMatchObject({ action: "dispute", bond: held.bond });
  await expect(wallet.confirmReview(sellerJob.id, draft, true)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  expect(charges(seller.id)).toHaveLength(1);
}, 120_000);
