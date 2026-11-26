// Owner real test 6 (rel/0.1.16), tester A bug 1: the buyer's job read 5 of 5
// stars, but the seller's job read none. The buyer's tidy at payment closes
// the task, and the seller's read needed the task to name the buyer. It now
// reads the rating receipt the program wrote for this task and listing.
import type { Address } from "@solana/kit";
import { afterEach, expect, it } from "vitest";
import { readTask } from "../src/market.js";
import { confirmPayout, eventually, REVIEW_ALLOWANCE, setEarnWithApproval, setOfferWithApproval, startWorld, type World } from "./harness.js";

let w: World | null = null;
afterEach(async () => { await w?.wallet.close(); w = null; });

const SEA_HAIKU = { name: "Sea haiku", summary: "A haiku about the sea or anything near it.", price: { usdCents: 20 } };

it("shows the seller the buyer's 5 stars after the tidy closed the task", async () => {
  w = await startWorld({ earn: { executor: { argv: [process.execPath, "-e", "process.stdout.write('Waves fold the light.')", "{prompt}"],
    mode: "sandboxed", envAllowlist: [], timeoutMs: 30_000 }, pollIntervalMs: 150 } });
  const { wallet, sandbox } = w;
  const seller = await wallet.createAgent("My assistant");
  const buyer = await wallet.createAgent("Claude Code");
  await wallet.fundAgent(buyer.id, { usdCents: 500 });
  await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: REVIEW_ALLOWANCE });
  await setEarnWithApproval(wallet, seller.id, true, 10);
  await setOfferWithApproval(wallet, seller.id, SEA_HAIKU);
  const listing = await eventually(async () => {
    await wallet.tick();
    const offer = (await wallet.overview()).agents.find(a => a.id === seller.id)!.earn.offers[0];
    return offer?.status === "live" ? offer.listing! : null;
  }, 30_000);
  const { job } = await wallet.hire({ agentId: buyer.id, listing, request: "One haiku about a lighthouse." });
  await eventually(async () => (await wallet.getJob(job.id, true)).status === "delivered", 60_000);
  const task = (await wallet.getJob(job.id, true)).task! as Address;

  const paid = await confirmPayout(wallet, job.id, 5);
  expect(paid.status).toBe("paid");
  expect(paid.rating).toBe(5);
  // The tidy at payment collects the deposits and closes the task.
  await eventually(async () => { await wallet.tick(); return (await readTask(sandbox.chain, task)) === null; }, 60_000);

  const earnId = `earn_${seller.id}_${task}`;
  // rt8-a: the seller's list agrees with its job view, even before the view was opened.
  const listed = await eventually(async () => {
    await wallet.tick();
    const row = (await wallet.listJobs({ role: "working" }, true)).find(j => j.id === earnId);
    return row?.status === "paid" ? row : null;
  }, 60_000);
  expect(listed.rating).toBe(5);
  const sold = await eventually(async () => {
    await wallet.tick();
    const view = await wallet.getJob(earnId, true);
    return view.status === "paid" ? view : null;
  }, 60_000);
  expect(sold.rating).toBe(5);
  // Opened again later (rt6: 1 and 10 minutes after payment), still the same.
  expect((await wallet.getJob(earnId, true)).rating).toBe(5);
  // Kept on the work record: a later list makes no chain read for it and still shows 5.
  expect((await wallet.listJobs({ role: "working" }, true)).find(j => j.id === earnId)?.rating).toBe(5);
  await wallet.close();
  w.wallet = await w.reopen();
  expect((await w.wallet.listJobs({ role: "working" }, true)).find(j => j.id === earnId)?.rating).toBe(5);
  // The buyer's own view still reads its stars.
  expect((await w.wallet.getJob(job.id, true)).rating).toBe(5);
}, 180_000);
