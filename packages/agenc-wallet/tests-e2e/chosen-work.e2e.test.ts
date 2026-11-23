import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_METHODS } from "../src/client/protocol.js";
import { CENT, eventually, setEarnWithApproval, startWorld, type World } from "./harness.js";

let world: World | undefined;
afterEach(async () => { await world?.wallet.close(); world = undefined; });
const executor = { argv: [process.execPath, "-e", "process.stdout.write('Room output')", "{prompt}"],
  mode: "sandboxed" as const, timeoutMs: 3000, envAllowlist: [] };

async function setup(ready = async () => {}, tamper = () => false, enabled = () => true) {
  world = await startWorld({
    earn: { executor, chosenRoomEnabled: enabled, checkExecutionReady: ready, pollIntervalMs: 100 },
    services: services => ({ ...services, resolveAgencUri: (...args) => tamper()
      ? Promise.resolve(new TextEncoder().encode('{"instructions":"changed"}'))
      : services.resolveAgencUri!(...args) }),
  });
  const { wallet, sandbox } = world;
  const { id } = await wallet.createAgent("Worker");
  wallet.chooseWork(id, true);
  const post = (title: string) => sandbox.postOpenJob({ title, instructions: "Write one line.", rewardLamports: 50n * CENT, deadlineSeconds: 7200 });
  const first = await post("First job");
  const other = await post("Second job");
  await wallet.fundAgent(id, { usdCents: 2000 });
  await wallet.setPolicy(id, { askAboveCents: 500, refill: { enabled: true, topUpToCents: 1, perDayCents: 500 } });
  await setEarnWithApproval(wallet, id, true);
  await eventually(async () => (await wallet.openWork(id).catch(() => null))?.jobs.length === 2);
  return { wallet, sandbox, id, task: other.task, first: first.task };
}

describe("chosen open work", () => {
  it.each(["submit", "release"] as const)("claims only the chosen job, holds its room result and waits for %s", async (action) => {
    const { wallet, id, task, first, sandbox } = await setup();
    expect((await wallet.openWork(id, 0, first)).jobs.map((job) => job.task)).toEqual([first]);
    const q = await wallet.quoteWork(id, task, "claim");
    expect(q.job).toMatchObject({ title: "Second job", deposit: { lamports: "5000000" }, reviewSeconds: 3600 });
    expect(await wallet.quoteWork(id, task, "claim")).toEqual(q);
    expect(wallet.pendingWork()).toEqual([q]);
    expect(await wallet.decideWork(q.id, true)).toEqual({ approved: true });
    await expect(wallet.decideWork(q.id, true)).rejects.toThrow();
    const held = await eventually(async () => {
      const job = (await wallet.openWork(id)).held;
      return job?.canSubmit && job;
    });
    expect(held).toMatchObject({ task, preview: "Room output", resultBytes: 11, resultHash: expect.stringMatching(/^[a-f0-9]{64}$/), canRelease: true });
    expect(sandbox.deliveries.size).toBe(0);
    const next = await wallet.quoteWork(id, task, action);
    expect(await wallet.decideWork(next.id, true)).toEqual({ approved: true });
    expect(sandbox.deliveries.size).toBe(action === "submit" ? 1 : 0);
    expect((await wallet.openWork(id)).held).toBeNull();
    expect((await wallet.openWork(id)).jobs.map((job) => job.task)).toContain(first);
  }, 30000);

  it("refuses a failed room self-test, exhausted allowance, expired approval and disabled earning", async () => {
    const ready = vi.fn(async () => {});
    const { wallet, id, task } = await setup(ready);
    const quote = () => wallet.quoteWork(id, task, "claim");
    const stale = await quote();
    world!.clock.now += 300001;
    await expect(wallet.decideWork(stale.id, true)).rejects.toThrow(/expired/);
    ready.mockRejectedValueOnce(new Error("self-test failed"));
    await expect(wallet.decideWork((await quote()).id, true)).rejects.toThrow();
    expect((await wallet.openWork(id)).jobs).toHaveLength(2);
    await wallet.setBudget(id, 0);
    await expect(wallet.decideWork((await quote()).id, true)).rejects.toThrow(/allowance/);
    const pending = await quote();
    await wallet.setEarn(id, false);
    await expect(wallet.decideWork(pending.id, true)).rejects.toThrow(/Earns/);
    expect(world!.sandbox.deliveries.size).toBe(0);
  }, 30000);

  it("checks the live Take jobs switch again after the claim self-test", async () => {
    let enabled = true;
    const ready = async () => { enabled = false; };
    const { wallet, id, task } = await setup(ready, undefined, () => enabled);
    const quote = await wallet.quoteWork(id, task, "claim");
    await expect(wallet.decideWork(quote.id, true)).rejects.toThrow();
    enabled = true;
    expect((await wallet.openWork(id)).jobs).toHaveLength(2);
    expect(world!.sandbox.deliveries.size).toBe(0);
  });

  it("rechecks the exact spec and fails closed when its published contents change", async () => {
    let changed = false;
    const { wallet, id, task } = await setup(undefined, () => changed);
    const q = await wallet.quoteWork(id, task, "claim");
    changed = true;
    expect((await wallet.openWork(id)).jobs).toEqual([]);
    await expect(wallet.decideWork(q.id, true)).rejects.toThrow();
    expect(world!.sandbox.deliveries.size).toBe(0);
  });

  it("holds the same room output over restart and refuses a release at the grace boundary", async () => {
    const { wallet, id, task, sandbox } = await setup();
    await wallet.decideWork((await wallet.quoteWork(id, task, "claim")).id, true);
    await eventually(async () => (await wallet.openWork(id)).held?.canSubmit);
    await wallet.close();
    world!.wallet = await world!.reopen();
    const restarted = world!.wallet;
    await eventually(async () => (await restarted.openWork(id).catch(() => null))?.held?.canSubmit);
    expect(restarted.pendingWork()).toEqual([]);
    expect(sandbox.deliveries.size).toBe(0);
    const early = await restarted.quoteWork(id, task, "release");
    sandbox.advanceClock(3520);
    await expect(restarted.decideWork(early.id, true)).rejects.toThrow();
    expect((await restarted.openWork(id)).held).toMatchObject({ canRelease: false, depositReturns: true });
    sandbox.advanceClock(150);
    const late = await restarted.quoteWork(id, task, "release");
    expect(late.job).toMatchObject({ canRelease: true, depositReturns: false });
    await expect(restarted.decideWork(late.id, true)).resolves.toEqual({ approved: true });
    expect((await restarted.openWork(id)).held).toBeNull();
  });

  it("does not use a fallback executor when restarted without the isolated room", async () => {
    const { wallet, id, task, sandbox } = await setup();
    await wallet.decideWork((await wallet.quoteWork(id, task, "claim")).id, true);
    await wallet.close();
    const called = vi.fn(async () => {});
    world!.wallet = await world!.reopen({ earn: {
      executor, chosenRoomEnabled: () => false, ownJobsOnly: true, checkExecutionReady: called, pollIntervalMs: 30,
    } });
    await expect(world!.wallet.openWork(id)).rejects.toThrow();
    await expect(world!.wallet.quoteWork(id, task, "submit")).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(called).not.toHaveBeenCalled();
    expect(sandbox.deliveries.size).toBe(0);
  });

  it("requires a room for chosen work and keeps owner decisions off agent connections", async () => {
    world = await startWorld({ earn: { executor, ownJobsOnly: true, chosenRoomEnabled: () => true } });
    const { id } = await world.wallet.createAgent("Worker");
    expect(() => world!.wallet.chooseWork(id, true)).toThrow(/room/);
    expect(AGENT_METHODS.filter((m) => m.startsWith("work."))).toEqual(["work.list", "work.quote"]);
  });
});
