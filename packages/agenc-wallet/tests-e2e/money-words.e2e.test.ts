// Owner real test 14 (rel/0.1.17 ba58ae0e, rt14-a bug 3): a dispute's Lately line read
// "The seller disputed the turn-down. $1.00" while $1.22 left the person's own agent
// (the bond and its deposit), and history named that $1.22 "Other change". A one-off
// move of money to an agent read "Gave My assistant an allowance.". A hire's line
// named the price only while the hire moved the price, its deposits and its rent.
// Each Lately line names the person's own agent and the money that moved.
import { afterEach, expect, it } from "vitest";
import { moneyHandlers } from "../src/money-handlers.js";
import { confirmDecision, eventually, REVIEW_ALLOWANCE, SOL, setEarnWithApproval, startWorld, type World } from "./harness.js";

let w: World | null = null;
afterEach(async () => { await w?.wallet.close(); w = null; });
const owner = { role: "owner" } as never;
const ASKS_EVERY_TIME = { askAboveCents: 0, refill: { enabled: false, topUpToCents: 0, perDayCents: 0 } };

it("names the person's own agent and the bond with its deposit when it disputes a turn-down, in Lately and history", async () => {
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
  // The turn-down names the person's own agent that can dispute it.
  expect((await wallet.listActivity()).find(a => /^You turned down/.test(a.text))?.text).toMatch(/\. My assistant can dispute it within 72 hours\.$/);
  const sellerJob = (await wallet.listJobs({ role: "working", agentId: seller.id }, true))[0]!;
  await wallet.fundAgent(seller.id, { usdCents: 200 });
  await wallet.setPolicy(seller.id, ASKS_EVERY_TIME);
  const held = (await wallet.reviewRecord(sellerJob.id)).quote!;
  const draft = await wallet.draftReview(sellerJob.id, "dispute", "The brief asked for no rhyme.", [], seller.id);
  const before = await w.balance(seller.address);
  await wallet.confirmReview(sellerJob.id, draft, true);
  const moved = before - await w.balance(seller.address);
  expect(moved).toBe(BigInt(held.disputeTotal.lamports));
  expect(BigInt(held.disputeTotal.lamports)).toBeGreaterThan(BigInt(held.bond.lamports));
  const line = (await wallet.listActivity()).find(a => /disputed the turn-down/.test(a.text))!;
  expect(line.text).toBe("My assistant disputed the turn-down.");
  expect(line.amount?.lamports).toBe(String(moved));
  const page = await moneyHandlers(wallet)["wallet.moneyHistory"]({}, owner);
  const row = page.rows.find(r => r.signature === line.signature && r.account === seller.address);
  expect(row?.delta).toBe(String(-moved));
  expect(row?.kind).toBe("dispute");
  expect(row?.jobId).toBe(sellerJob.id);
}, 120_000);

it("says a one-off move of money to an agent as history says it, not as an allowance", async () => {
  w = await startWorld();
  const agent = await w.wallet.createAgent("My assistant");
  const q = await w.wallet.quoteTransfer({ kind: "fund", agentId: agent.id, amount: { lamports: String(SOL / 10n) } });
  const sent = await w.wallet.confirmTransfer(q.id);
  const line = (await w.wallet.listActivity()).find(a => a.signature === sent.signature)!;
  expect(line.text).toBe("Moved money to My assistant.");
  expect(line.amount?.lamports).toBe(String(SOL / 10n));
});

it("says what a hire moved from the agent's money in its Lately line, not the price alone", async () => {
  w = await startWorld();
  const { wallet, listing } = w;
  const agent = await wallet.createAgent("My assistant");
  await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: REVIEW_ALLOWANCE });
  await wallet.fundAgent(agent.id, { usdCents: 300 });
  await wallet.setPolicy(agent.id, ASKS_EVERY_TIME);
  const before = await w.balance(agent.address);
  const hire = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
  await wallet.decideApproval(hire.approval!.id, true);
  await eventually(async () => (await wallet.listActivity()).some(a => a.kind === "hired"));
  const moved = before - await w.balance(agent.address);
  const line = (await wallet.listActivity()).find(a => a.kind === "hired")!;
  expect(line.text).toBe(`My assistant hired ${(await wallet.getJob(hire.job.id, true)).title}.`);
  const price = BigInt((await wallet.getJob(hire.job.id, true)).price.lamports);
  expect(moved).toBeGreaterThan(price);
  // The card's total: price, deposits that come back and rent; network fees are at most cents.
  expect(BigInt(line.amount!.lamports)).toBeGreaterThan(price);
  expect(moved - BigInt(line.amount!.lamports) < SOL / 1000n && BigInt(line.amount!.lamports) - moved < SOL / 1000n).toBe(true);
});
