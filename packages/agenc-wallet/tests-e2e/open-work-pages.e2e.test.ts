// Review 0.1.17 money 8, MAJOR 1: a list read in pages shows every job of its listing exactly once,
// also when Market or another chat lists again between pages, a job passes its deadline, or a page
// is read more than 5 minutes after the last.
import { afterEach, expect, it, vi } from "vitest";
import { CENT, eventually, setEarnWithApproval, startWorld, type World } from "./harness.js";

let world: World | undefined;
afterEach(async () => { vi.restoreAllMocks(); await world?.wallet.close(); world = undefined; });
const executor = { argv: [process.execPath, "-e", "process.stdout.write('Room output')", "{prompt}"],
  mode: "sandboxed" as const, timeoutMs: 3000, envAllowlist: [] };

async function setup(count: number) {
  world = await startWorld({ earn: { executor, chosenRoomEnabled: () => true, checkExecutionReady: async () => {}, pollIntervalMs: 100 } });
  const { wallet, sandbox } = world;
  const { id } = await wallet.createAgent("Worker");
  wallet.chooseWork(id, true);
  const tasks: string[] = [];
  for (let i = 0; i < count; i++) tasks.push((await sandbox.postOpenJob({ title: "Row " + i, instructions: "Write one line.",
    rewardLamports: BigInt(40 + i) * CENT, deadlineSeconds: 7200 })).task);
  await wallet.fundAgent(id, { usdCents: 2000 });
  await wallet.setPolicy(id, { askAboveCents: 500, refill: { enabled: true, topUpToCents: 1, perDayCents: 500 } });
  await setEarnWithApproval(wallet, id, true);
  await eventually(async () => (await wallet.openWork(id).catch(() => null))?.jobs.length === 10);
  return { wallet, sandbox, id, tasks };
}

/** What a chat shows: every page until next is null, starting over when the wallet says relisted. */
async function readOn(wallet: World["wallet"], id: string, page: Awaited<ReturnType<World["wallet"]["openWork"]>>, shown: string[]) {
  while (page.next !== null) {
    page = await wallet.openWork(id, page.next);
    if (page.relisted) shown.length = 0;
    shown.push(...page.jobs.map(job => job.task));
  }
  return shown;
}

const once = (shown: string[]) => expect(new Set(shown).size).toBe(shown.length);

it("a better-paid job posted between pages, then Market listing again, shows no job twice", async () => {
  const { wallet, sandbox, id, tasks } = await setup(13);
  const first = await wallet.openWork(id);
  expect(first.jobs).toHaveLength(10);
  await sandbox.postOpenJob({ title: "Better paid", instructions: "Write one line.", rewardLamports: 90n * CENT, deadlineSeconds: 7200 });
  const market = await wallet.openWork(id);
  expect(market.jobs[0]!.title).toBe("Better paid");
  const shown = await readOn(wallet, id, first, first.jobs.map(job => job.task));
  once(shown);
  expect([...shown].sort()).toEqual([...tasks].sort());
  // Market's own listing reads on too, and has the new job once.
  const marketShown = await readOn(wallet, id, market, market.jobs.map(job => job.task));
  once(marketShown);
  expect(marketShown).toHaveLength(14);
}, 120000);

it("a job that passes its deadline between pages leaves no open job unshown", async () => {
  const { wallet, sandbox, id, tasks } = await setup(12);
  const soon = (await sandbox.postOpenJob({ title: "Ends soon", instructions: "Write one line.", rewardLamports: 90n * CENT, deadlineSeconds: 600 })).task;
  const first = await wallet.openWork(id);
  expect(first.jobs.map(job => job.task)).toContain(soon);
  sandbox.advanceClock(601);
  expect((await wallet.openWork(id)).jobs.map(job => job.task)).not.toContain(soon);
  const shown = await readOn(wallet, id, first, first.jobs.map(job => job.task));
  once(shown);
  expect([...shown].sort()).toEqual([...tasks, soon].sort());
}, 120000);

it("a page read more than 5 minutes after the last read lists again from the start and says so", async () => {
  const { wallet, sandbox, id, tasks } = await setup(13);
  const now = Date.now.bind(Date);
  let shift = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now() + shift);
  const first = await wallet.openWork(id);
  // The 5 minutes slide on each read: 4 minutes later, then 4 more, the same page is still there.
  shift = 240000;
  expect((await wallet.openWork(id, first.next!)).relisted).toBeUndefined();
  shift = 480000;
  const again = await wallet.openWork(id, first.next!);
  expect(again.relisted).toBeUndefined();
  expect(again.jobs).toHaveLength(3);
  const late = (await sandbox.postOpenJob({ title: "Better paid", instructions: "Write one line.", rewardLamports: 90n * CENT, deadlineSeconds: 7200 })).task;
  shift = 480000 + 301000;
  const shown = await readOn(wallet, id, first, first.jobs.map(job => job.task));
  once(shown);
  expect([...shown].sort()).toEqual([...tasks, late].sort());
}, 120000);

it("a stale, evicted or made-up position is harmless: it lists again from the start", async () => {
  const { wallet, id, tasks } = await setup(11);
  const fresh = (await wallet.openWork(id)).jobs.map(job => job.task);
  for (const offset of [1, 10, 2 ** 20 - 1, 999 * 2 ** 20 + 3]) {
    const page = await wallet.openWork(id, offset);
    expect(page.relisted).toBe(true);
    expect(page.jobs.map(job => job.task)).toEqual(fresh);
  }
  // A few listings per worker: a fifth listing forgets the oldest one, whose page then lists again.
  const oldest = await wallet.openWork(id);
  for (let i = 0; i < 4; i++) await wallet.openWork(id);
  const page = await wallet.openWork(id, oldest.next!);
  expect(page.relisted).toBe(true);
  const shown = await readOn(wallet, id, page, page.jobs.map(job => job.task));
  once(shown);
  expect([...shown].sort()).toEqual([...tasks].sort());
  await expect(wallet.openWork(id, -1)).rejects.toThrow("That page is not available.");
}, 120000);
