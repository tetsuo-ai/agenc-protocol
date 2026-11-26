// rt16-b bug 3 (also rt15): a payment returns part of the deposits to the payer in its own
// transaction, and Lately had no line for it, so "Collected the deposits ... $1.27" read as if
// $0.13 of a $1.40 deposit was kept. Every amount that comes back at a payment has its line, and
// the lines add up to what the payer's balance did.
import { afterEach, expect, it } from "vitest";
import { confirmPayout, REVIEW_ALLOWANCE, startWorld, type World } from "./harness.js";

let w: World | null = null;
afterEach(async () => { await w?.wallet.close(); w = null; });

it("gives a line to the deposits that come back with the payment, and the lines add up", async () => {
  w = await startWorld();
  const { wallet, sandbox, listing } = w;
  const agent = await wallet.createAgent("My assistant");
  await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: REVIEW_ALLOWANCE });
  await wallet.fundAgent(agent.id, { usdCents: 800 });
  const hire = await wallet.hire({ agentId: agent.id, listing, request: "A haiku about a lighthouse." });
  if (hire.approval) await wallet.decideApproval(hire.approval.id, true);
  let delivered = 0;
  for (let round = 0; round < 4 && !delivered; round++) delivered += await sandbox.workOnce();
  expect(delivered).toBe(1);
  expect((await wallet.getJob(hire.job.id, true)).status).toBe("delivered");
  const beforePay = await w.balance(agent.address);
  await confirmPayout(wallet, hire.job.id);
  const atPay = await w.balance(agent.address) - beforePay;
  const lines = () => wallet.listActivity().then(all => all.filter(entry => entry.jobId === hire.job.id));
  const back = (await lines()).filter(line => line.kind === "tidied");
  expect(atPay > 0n).toBe(true);
  {
    expect(back).toHaveLength(1);
    expect(back[0]!.text).toMatch(/^Part of the deposits from .+ came back with the payment\.$/);
    expect(BigInt(back[0]!.amount!.lamports)).toBe(atPay);
  }
  w.clock.now += 61 * 60_000;
  const beforeTidy = await w.balance(agent.address);
  await wallet.tick();
  const tidied = await w.balance(agent.address) - beforeTidy;
  const all = (await lines()).filter(line => line.kind === "tidied");
  expect(all).toHaveLength(2);
  const rest = all.find(line => line.text.startsWith("Collected the rest of the deposits"))!;
  expect(BigInt(rest.amount!.lamports)).toBe(tidied);
  // What came back at the payment and at the tidy is what the payer got back in all.
  expect(BigInt(back[0]!.amount!.lamports) + tidied).toBe(await w.balance(agent.address) - beforePay);
});
