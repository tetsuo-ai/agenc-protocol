// rt11-b: the worker's job row kept "Delivered. Waiting for the buyer to approve it."
// about 70 s after the buyer paid (the buyer's side at once). When this wallet pays a
// job its own agent delivered, the seller's side reads the payment at once too.
import { afterEach, expect, it } from "vitest";
import { confirmPayout, eventually, REVIEW_ALLOWANCE, setEarnWithApproval, setOfferWithApproval, startWorld, type World } from "./harness.js";

let w: World | null = null;
afterEach(async () => { await w?.wallet.close(); w = null; });

it("shows the seller's job paid within seconds of the buyer paying, long before the next poll", async () => {
  w = await startWorld({ earn: { executor: { argv: [process.execPath, "-e", "process.stdout.write('Waves fold the light.')", "{prompt}"],
    mode: "sandboxed", envAllowlist: [], timeoutMs: 30_000 }, pollIntervalMs: 20_000 } });
  const { wallet } = w;
  const seller = await wallet.createAgent("My assistant");
  const buyer = await wallet.createAgent("Claude Code");
  await wallet.fundAgent(buyer.id, { usdCents: 500 });
  await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: REVIEW_ALLOWANCE });
  await setEarnWithApproval(wallet, seller.id, true, 10);
  await setOfferWithApproval(wallet, seller.id, { name: "Sea haiku", summary: "A haiku about the sea.", price: { usdCents: 20 } });
  const listing = await eventually(async () => {
    await wallet.tick();
    const offer = (await wallet.overview()).agents.find(a => a.id === seller.id)!.earn.offers[0];
    return offer?.status === "live" ? offer.listing! : null;
  }, 60_000);
  const { job } = await wallet.hire({ agentId: buyer.id, listing, request: "One haiku about a lighthouse." });
  const task = await eventually(async () => { const view = await wallet.getJob(job.id, true); return view.status === "delivered" && view.task; }, 90_000);
  const earnId = `earn_${seller.id}_${task}`;
  await eventually(async () => (await wallet.listJobs({ role: "working" }, true)).find(j => j.id === earnId)?.status === "delivered", 60_000);
  const paid = await confirmPayout(wallet, job.id, 5);
  expect(paid.status).toBe("paid");
  const at = Date.now();
  await eventually(async () => (await wallet.listJobs({ role: "working" }, true)).find(j => j.id === earnId)?.status === "paid", 5_000);
  expect(Date.now() - at).toBeLessThan(5_000);
}, 240_000);
