// Owner real test 4 (rel/0.1.16): an approval of a hire paid with the agent's
// own money was refused by the daily amount, stars paid with it were never
// recorded, and a one-job service stayed busy after its only hire was paid.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { WalletState } from "../src/store.js";
import { confirmPayout, eventually, REVIEW_ALLOWANCE, setEarnWithApproval, setOfferWithApproval, startWorld, type World } from "./harness.js";

let w: World | null = null;
afterEach(async () => { await w?.wallet.close(); w = null; });
const state = () => JSON.parse(readFileSync(path.join(w!.dataDir, "state.json"), "utf8")) as WalletState;
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
  return { wallet, agent, jobId: hire.job.id };
}

it("pays an agent-paid delivery on the person's yes above the daily amount, once, and counts it", async () => {
  const { wallet, agent, jobId } = await agentPaidDelivery();
  const paid = await confirmPayout(wallet, jobId);
  expect(paid.status).toBe("paid");
  // The charge is still counted against the agent's day.
  expect(state().agents[agent.id]!.refills.some(entry => entry.id.startsWith("review:" + jobId))).toBe(true);
  // A second approval of the same delivery is refused: the yes covers it once.
  const { quote } = await wallet.reviewRecord(jobId, undefined, { termsOnly: true });
  expect(quote?.canPay ?? false).toBe(false);
});

it("still refuses an agent-paid approval the agent makes on its own above the daily amount", async () => {
  const { wallet, agent, jobId } = await agentPaidDelivery();
  const { quote } = await wallet.reviewRecord(jobId, undefined, { termsOnly: true });
  const balance = await w!.balance(agent.address);
  await expect(wallet.approveJob(jobId, undefined, false, agent.id, quote!.id)).rejects.toThrow();
  expect(await w!.balance(agent.address)).toBe(balance);
  expect((await wallet.getJob(jobId, true)).status).toBe("delivered");
});

it("records the stars the person paid with the approval of an agent-paid hire", async () => {
  const { wallet, jobId } = await agentPaidDelivery();
  const paid = await confirmPayout(wallet, jobId, 5);
  expect(paid.status).toBe("paid");
  expect(paid.rating).toBe(5);
  const service = (await wallet.find({ query: "haiku" })).services[0]!;
  expect(service).toMatchObject({ rating: 5, ratingCount: 1 });
});

it("frees a one-job service for a new hire once its only hire is paid without stars", async () => {
  w = await startWorld({ earn: { executor: { argv: [process.execPath, "-e", "process.stdout.write('Done work.')", "{prompt}"],
    mode: "sandboxed", envAllowlist: [], timeoutMs: 30_000 }, pollIntervalMs: 150 } });
  const { wallet } = w;
  const worker = await wallet.createAgent("My assistant");
  const buyer = await wallet.createAgent("Claude Code");
  await wallet.fundAgent(buyer.id, { usdCents: 500 });
  await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: REVIEW_ALLOWANCE });
  await setEarnWithApproval(wallet, worker.id, true, 10);
  await setOfferWithApproval(wallet, worker.id, { name: "Rain Line", summary: "One line about rain.", price: { usdCents: 20 } });
  const offer = await eventually(async () => {
    await wallet.tick();
    const view = (await wallet.overview()).agents.find(agent => agent.id === worker.id)!;
    return view.earn.offers[0]?.status === "live" ? view.earn.offers[0] : null;
  }, 30_000);
  const first = await wallet.hire({ agentId: buyer.id, listing: offer.listing!, request: "A line about rain." });
  await eventually(async () => (await wallet.getJob(first.job.id, true)).status === "delivered", 60_000);
  expect((await confirmPayout(wallet, first.job.id)).status).toBe("paid");
  await wallet.tick();
  const second = await wallet.hire({ agentId: buyer.id, listing: offer.listing!, request: "Another line about rain." });
  expect(second.job.status).not.toBe("failed");
  await eventually(async () => (await wallet.getJob(second.job.id, true)).status === "delivered", 60_000);
}, 120_000);

it("keeps a paid hire open for its stars while the service still has room", async () => {
  w = await startWorld();
  const { wallet, sandbox, listing } = w;
  const agent = await wallet.createAgent("My assistant");
  await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: REVIEW_ALLOWANCE });
  await wallet.fundAgent(agent.id, { usdCents: 300 });
  const hire = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
  await sandbox.workOnce();
  await confirmPayout(wallet, hire.job.id);
  await wallet.tick();
  const paid = await wallet.getJob(hire.job.id, true);
  expect(paid.canRate).toBe(true);
});
