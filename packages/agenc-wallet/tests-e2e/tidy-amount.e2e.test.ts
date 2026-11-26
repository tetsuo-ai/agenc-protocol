// Independent money review of 0.1.17, MAJOR 2: "Collected the deposits" named the payer's balance after
// the tidy minus before. Housekeeping tidies jobs in parallel and nothing holds the payer between the two
// reads, so two tidies of one payer in the same tick each named both jobs' deposits. Each line now names
// what its own tidy moved, read from that transaction.
import { afterEach, expect, it } from "vitest";
import { confirmPayout, REVIEW_ALLOWANCE, startWorld, type World } from "./harness.js";

let w: World | null = null;
afterEach(async () => { await w?.wallet.close(); w = null; });

it("names each tidy's own deposits when two jobs of one payer are tidied in the same tick", async () => {
  w = await startWorld();
  const { wallet, sandbox, listing } = w;
  const agent = await wallet.createAgent("My assistant");
  await wallet.setPolicy(agent.id, { askAboveCents: 1000, refill: REVIEW_ALLOWANCE });
  await wallet.fundAgent(agent.id, { usdCents: 800 });
  const jobs: string[] = [];
  for (const request of ["A haiku about rain.", "A haiku about snow."]) {
    const hire = await wallet.hire({ agentId: agent.id, listing, request });
    if (hire.approval) await wallet.decideApproval(hire.approval.id, true);
    jobs.push(hire.job.id);
  }
  let delivered = 0;
  for (let round = 0; round < 4 && delivered < 2; round++) delivered += await sandbox.workOnce();
  expect(delivered).toBe(2);
  for (const id of jobs) {
    expect((await wallet.getJob(id, true)).status).toBe("delivered");
    // No stars: a paid hire stays open an hour so it can be rated, so neither is tidied yet.
    await confirmPayout(wallet, id);
  }
  // rt16-b bug 3: the deposits that came back with each payment have their own line; the tidy's lines are the rest.
  const before = await w.balance(agent.address);
  expect((await wallet.listActivity()).filter(entry => entry.kind === "tidied" && entry.text.startsWith("Collected"))).toEqual([]);
  w.clock.now += 61 * 60_000;
  await wallet.tick();
  const lines = (await wallet.listActivity()).filter(entry => entry.kind === "tidied" && entry.text.startsWith("Collected"));
  expect(lines.map(line => line.jobId).sort()).toEqual([...jobs].sort());
  const moved = await w.balance(agent.address) - before;
  expect(moved > 0n).toBe(true);
  const amounts = lines.map(line => BigInt(line.amount?.lamports ?? "0"));
  for (const amount of amounts) expect(amount > 0n && amount < moved).toBe(true);
  expect(amounts[0]! + amounts[1]!).toBe(moved);
});
