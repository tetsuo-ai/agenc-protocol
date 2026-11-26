// rt10 A bug 1: after "Confirm rating", Home and Lately changed within seconds, but the wallet
// history listed the stars' debit and the deposits that came back only at the next idle
// housekeeping pass, about 4.5 minutes later. The wallet's own sends record their rows when they land.
import { afterEach, expect, it } from "vitest";
import { confirmPayout, startWorld, type World } from "./harness.js";

let w: World;
afterEach(async () => { await w?.wallet.close(); });

it("lists the stars' debit and the deposits back as soon as they land, with no housekeeping pass", async () => {
  w = await startWorld({ config: { rateWindowMs: 60 * 60_000 } });
  const { wallet, sandbox } = w;
  const agent = await wallet.createAgent("Reader");
  const hire = await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem." });
  await wallet.decideApproval(hire.approval!.id, true);
  await sandbox.workOnce();
  await confirmPayout(wallet, hire.job.id);
  // Paid with no stars: the job waits to be rated and keeps its deposits.
  expect((await wallet.getJob(hire.job.id, true)).canRate).toBe(true);
  const kinds = () => wallet.moneyHistory(hire.job.id).rows.filter(r => r.account === wallet.mainAddress).map(r => r.kind);
  const q = await wallet.quoteRating(hire.job.id, 5, true);
  expect((await wallet.rateJob(hire.job.id, 5, true, undefined, q.id)).rating).toBe(5);
  expect(kinds()).toContain("rating");
  // Rated, the job is tidied when it is next read, as Market does after Confirm rating.
  await wallet.getJob(hire.job.id, true);
  expect(wallet.moneyHistory(hire.job.id).rows.find(r => r.kind === "rent" && r.account === wallet.mainAddress)).toMatchObject({ delta: expect.stringMatching(/^[1-9]/) });
  // Housekeeping later finds nothing new to add twice.
  const count = wallet.moneyHistory().rows.length;
  await wallet.tick();
  expect(wallet.moneyHistory().rows.length).toBe(count);
});
