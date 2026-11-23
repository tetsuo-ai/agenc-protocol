import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { address } from "@solana/kit";
import { loadState } from "@tetsuo-ai/agenc-worker";
import { findAgentPda, findClaimPda, findTaskSubmissionPda, findWorkerStatsPda, getAgentRegistrationDecoder, getAgentRegistrationEncoder, getTaskDecoder, getTaskEncoder, getTaskSubmissionDecoder, SubmissionStatus, TaskStatus, values } from "@tetsuo-ai/marketplace-sdk";
import type { WorkerQuote } from "../src/client/types.js";
import { AGENT_METHODS } from "../src/client/protocol.js";
import { CENT, eventually, setEarnWithApproval, startWorld, type World } from "./harness.js";

let world: World | undefined;
afterEach(async () => { await world?.wallet.close(); world = undefined; });
const executor = { argv: [process.execPath, "-e", "process.stdout.write('Room output')", "{prompt}"],
  mode: "sandboxed" as const, timeoutMs: 3000, envAllowlist: [] };

async function setup(ready = async () => {}, tamper = () => false, enabled = () => true, options: NonNullable<Parameters<typeof startWorld>[0]> = {}) {
  world = await startWorld({
    services: services => ({ ...services, resolveAgencUri: (...args) => tamper()
      ? Promise.resolve(new TextEncoder().encode('{"instructions":"changed"}'))
      : services.resolveAgencUri!(...args) }),
    ...options,
    earn: { executor, chosenRoomEnabled: enabled, checkExecutionReady: ready, pollIntervalMs: 100, ...options.earn },
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

async function assertBalances(quote: WorkerQuote, outcome: Pick<WorkerQuote, "balances" | "flows"> = quote) {
  const before = await Promise.all(outcome.balances.map(row => world!.balance(row.account)));
  for (const flow of outcome.flows) {
    expect(flow.amount.usdCents).not.toBeNull();
    expect(flow.to).toBeTruthy();
    expect(flow.from).toBeTruthy();
  }
  expect(await world!.wallet.decideWork(quote.id, true)).toEqual({ approved: true });
  for (const [i, row] of outcome.balances.entries()) {
    expect(row.net.usdCents).not.toBeNull();
    expect(await world!.balance(row.account) - before[i]!).toBe(BigInt(row.net.lamports));
  }
}
const journal = (id: string) => loadState(path.join(world!.dataDir, "earn", id));
async function completedRoom(id: string, task: string) {
  const wallet = world!.wallet;
  await wallet.decideWork((await wallet.quoteWork(id, task, "claim")).id, true);
  return eventually(async () => (await wallet.openWork(id)).held?.resultHash);
}

describe("chosen open work", () => {
  it.each(["submit", "release"] as const)("claims only the chosen job, holds its room result and waits for %s", async (action) => {
    const { wallet, id, task, first, sandbox } = await setup();
    expect((await wallet.openWork(id, 0, first)).jobs.map((job) => job.task)).toEqual([first]);
    const q = await wallet.quoteWork(id, task, "claim");
    expect(q.job).toMatchObject({ title: "Second job", deposit: { lamports: "5000000" }, reviewSeconds: 3600 });
    expect(await wallet.quoteWork(id, task, "claim")).toEqual(q);
    expect(wallet.pendingWork()).toEqual([q]);
    await assertBalances(q);
    await expect(wallet.decideWork(q.id, true)).rejects.toThrow();
    const held = await eventually(async () => {
      const job = (await wallet.openWork(id)).held;
      return job?.canSubmit && job;
    });
    expect(held).toMatchObject({ task, preview: "Room output", resultBytes: 11, resultHash: expect.stringMatching(/^[a-f0-9]{64}$/), canRelease: true });
    expect(sandbox.deliveries.size).toBe(0);
    const next = await wallet.quoteWork(id, task, action);
    expect(next.balances.find(row => row.account === next.job.worker)?.net.lamports).toBe(action === "submit" ? "2204040" : "7298760");
    expect(next.flows).toEqual(expect.arrayContaining([expect.objectContaining({ label: action === "submit" ? "Submission rent" : "Claim rent and remaining balance returned" })]));
    await assertBalances(next);
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
    sandbox.advanceClock(2999);
    const early = await restarted.quoteWork(id, task, "release");
    expect(early.expiresAt).toBe(world!.clock.now + 1000);
    const resume = new Date((early.job.releaseBy! + 1) * 1000).toISOString();
    sandbox.advanceClock(1);
    await expect(restarted.decideWork(early.id, true)).rejects.toThrow(resume);
    for (const elapsed of [0, 599, 1]) {
      sandbox.advanceClock(elapsed);
      expect((await restarted.openWork(id)).held).toMatchObject({ canRelease: false, canSubmit: true,
        releaseWindow: { phase: "paused", notice: expect.stringContaining(resume) } });
      await expect(restarted.quoteWork(id, task, "release")).rejects.toThrow(resume);
    }
    sandbox.advanceClock(1);
    const late = await restarted.quoteWork(id, task, "release");
    expect(late.job).toMatchObject({ canRelease: true, depositReturns: false });
    expect(late.job.releaseWindow?.notice).toContain(`buyer (${late.job.buyer}) gets the deposit`);
    expect(late.afterWindow).toBeUndefined();
    expect(late.balances.find(row => row.account === late.job.worker)?.net.lamports).toBe("2298760");
    expect(late.balances.find(row => row.account === late.job.buyer)?.net.lamports).toBe("5000000");
    await assertBalances(late);
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
    expect(await world!.wallet.openWork(id)).toMatchObject({ jobs: [], held: { canRelease: true, canSubmit: false } });
    await expect(world!.wallet.quoteWork(id, task, "submit")).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 200));
    await world!.wallet.setEarn(id, false);
    await assertBalances(await world!.wallet.quoteWork(id, task, "release"));
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

it.each([3600, 3601])("discloses both recipients and reconciles a release landing %i seconds after claim", async delay => {
  let approved = false;
  const { wallet, id, task } = await setup(undefined, undefined, undefined, {
    transport: base => ({ ...base, async sendAndConfirm(tx) {
      if (approved) world!.sandbox.advanceClock(delay);
      return base.sendAndConfirm(tx);
    } }),
  });
  await completedRoom(id, task);
  const quote = await wallet.quoteWork(id, task, "release");
  const { worker, buyer, deposit, releaseWindow, releaseBy } = quote.job;
  expect(quote.job.depositReturns).toBeNull();
  expect(releaseWindow!.notice).toContain(`at or before ${new Date(releaseBy! * 1000).toISOString()}, the worker (${worker}) gets the deposit`);
  expect(releaseWindow!.notice).toContain(`If it lands later, the buyer (${buyer}) gets it`);
  const later = quote.afterWindow!;
  expect(quote.flows).toContainEqual(expect.objectContaining({ to: worker, amount: deposit }));
  expect(later.flows).toContainEqual(expect.objectContaining({ to: buyer, amount: deposit }));
  expect(later.balances).toContainEqual(expect.objectContaining({ account: worker, net: expect.objectContaining({ lamports: "2298760" }) }));
  expect(later.balances).toContainEqual({ account: buyer, net: deposit });
  expect(quote.charge.lamports).toBe("5000");
  expect(wallet.pendingWork()).toEqual([quote]);
  const buyerBefore = await world!.balance(buyer);
  approved = true;
  await assertBalances(quote, delay > 3600 ? later : quote);
  expect(await world!.balance(buyer) - buyerBefore).toBe(delay > 3600 ? BigInt(deposit.lamports) : 0n);
  expect(journal(id).failedJobs.find(row => row.task === task)?.claimReleased).toBe(true);
});

it("refuses an approved release that enters the pause while signing, before reserving or sending", async () => {
  let delay = false, broadcasts = 0;
  const { wallet, id, task } = await setup(undefined, undefined, undefined, {
    transport: base => ({ ...base, async getLatestBlockhash() {
      if (delay) world!.sandbox.advanceClock(3000);
      return base.getLatestBlockhash();
    }, async sendAndConfirm(tx) {
      if (delay) broadcasts++;
      return base.sendAndConfirm(tx);
    } }),
  });
  const hash = await completedRoom(id, task);
  const quote = await wallet.quoteWork(id, task, "release");
  delay = true;
  await expect(wallet.decideWork(quote.id, true)).rejects.toThrow("Check again at");
  delay = false;
  expect(broadcasts).toBe(0);
  const submit = await wallet.quoteWork(id, task, "submit");
  expect(submit.job.resultHash).toBe(hash);
  expect(submit.dailyRemaining).toEqual(quote.dailyRemaining);
});

it("quotes the worker on both sides of the window for a claim protected by a prior dispute", async () => {
  const { wallet, sandbox, id, task } = await setup();
  await completedRoom(id, task);
  const svm = sandbox.market.svm;
  const raw = svm.getAccount(task)!;
  if (!raw.exists) throw new Error("Missing task");
  const data = getTaskDecoder().decode(Uint8Array.from(raw.data));
  const reserved = Uint8Array.from(data.reserved);
  reserved[13] = 1;
  svm.setAccount({ ...raw, data: Uint8Array.from(getTaskEncoder().encode({ ...data, reserved })) } as never);
  const early = await wallet.quoteWork(id, task, "release");
  expect(early.job.releaseWindow?.notice).toContain(`If it lands later, the worker (${early.job.worker}) gets it`);
  expect(early.afterWindow).toBeUndefined();
  sandbox.advanceClock(3601);
  const late = await wallet.quoteWork(id, task, "release");
  expect(late.job.releaseWindow?.notice).toContain(`The worker (${late.job.worker}) gets the deposit`);
  await assertBalances(late);
});

it("returns residual claim rent to the worker when the balance cannot fund a late deposit", async () => {
  const { wallet, sandbox, id, task } = await setup();
  await completedRoom(id, task);
  const original = await wallet.quoteWork(id, task, "release");
  const claim = original.flows.find(row => row.label === "Claim deposit returned or paid")!.from;
  const svm = sandbox.market.svm;
  const raw = svm.getAccount(address(claim))!;
  if (!raw.exists) throw new Error("Missing claim");
  // One lamport below a full forfeitable deposit, as can happen with a rent change.
  svm.setAccount({ ...raw, lamports: raw.lamports - 1n } as never);
  await expect(wallet.decideWork(original.id, true)).rejects.toThrow();
  const early = await wallet.quoteWork(id, task, "release");
  expect(early.job.deposit.lamports).toBe("0");
  expect(early.afterWindow).toBeUndefined();
  sandbox.advanceClock(3601);
  const buyer = await world!.balance(early.job.buyer);
  const late = await wallet.quoteWork(id, task, "release");
  expect(late.job.depositReturns).toBeNull();
  await assertBalances(late);
  expect(await world!.balance(early.job.buyer)).toBe(buyer);
});

it("charges only the fee and restores the completed result after a landed release fails", async () => {
  let freeze = false;
  let sends = 0;
  const { wallet, sandbox, id, task } = await setup(undefined, undefined, undefined, {
    transport: base => ({ ...base, async sendAndConfirm(tx) {
      if (!freeze) return base.sendAndConfirm(tx);
      sends++;
      const svm = world!.sandbox.market.svm;
      const raw = svm.getAccount(task)!;
      if (!raw.exists) throw new Error("Missing task");
      const data = getTaskDecoder().decode(Uint8Array.from(raw.data));
      svm.setAccount({ ...raw, data: Uint8Array.from(getTaskEncoder().encode({ ...data, status: TaskStatus.Disputed })) } as never);
      try { return await base.sendAndConfirm(tx); }
      finally { svm.setAccount(raw as never); }
    } }),
  });
  const hash = await completedRoom(id, task);
  const refund = await wallet.quoteWork(id, task, "release");
  const buyer = await world!.balance(refund.job.buyer);
  const worker = await world!.balance(refund.job.worker);
  freeze = true;
  await expect(wallet.decideWork(refund.id, true)).rejects.toThrow();
  freeze = false;
  expect(sends).toBe(1);
  expect(await world!.balance(refund.job.buyer)).toBe(buyer);
  expect(await world!.balance(refund.job.worker)).toBe(worker - 5000n);
  await eventually(async () => (await wallet.openWork(id)).held?.canSubmit);
  const submit = await wallet.quoteWork(id, task, "submit");
  expect(BigInt(refund.dailyRemaining.lamports) - BigInt(submit.dailyRemaining.lamports)).toBe(5000n);
  expect(submit.job.resultHash).toBe(hash);
  expect(sandbox.deliveries.size).toBe(0);
  await assertBalances(submit);
});

it("refunds a provably unused submission reservation and requires a new approval for a second send", async () => {
  let refuse = false;
  let attempts = 0;
  const { wallet, id, task } = await setup(undefined, undefined, undefined, {
    transport: base => ({ ...base, async sendAndConfirm(tx) {
      if (refuse) { attempts++; throw new Error("dropped before broadcast"); }
      return base.sendAndConfirm(tx);
    } }),
  });
  await completedRoom(id, task);
  const original = await wallet.quoteWork(id, task, "submit");
  refuse = true;
  await expect(wallet.decideWork(original.id, true)).rejects.toThrow();
  await eventually(async () => (await wallet.openWork(id)).held?.canSubmit);
  await expect(wallet.decideWork(original.id, true)).rejects.toThrow();
  const retry = await wallet.quoteWork(id, task, "submit");
  expect(retry.dailyRemaining).toEqual(original.dailyRemaining);
  expect(retry.id).not.toBe(original.id);
  expect(attempts).toBe(1);
  refuse = false;
  await assertBalances(retry);
});

it("recognizes a signed release after losing its response and restarting", async () => {
  let lose = false;
  const { wallet, id, task } = await setup(undefined, undefined, undefined, {
    chain: base => ({ ...base, workOutcome: receipt => lose ? Promise.resolve("pending") : base.workOutcome!(receipt) }),
    transport: base => ({ ...base, async sendAndConfirm(tx) {
      const result = await base.sendAndConfirm(tx);
      if (lose) throw new Error("connection closed after confirming");
      return result;
    } }),
  });
  await completedRoom(id, task);
  const release = await wallet.quoteWork(id, task, "release");
  lose = true;
  await expect(wallet.decideWork(release.id, true)).rejects.toThrow();
  expect(journal(id).openClaim?.chosenAttempt?.signature).toBeTruthy();
  await wallet.close();
  lose = false;
  world!.wallet = await world!.reopen();
  await eventually(async () => !journal(id).openClaim);
  expect(journal(id).failedJobs.find(row => row.task === task)).toMatchObject({ chosen: true, cause: "released", claimReleased: true });
});

it("keeps the private approval intact when both public quote responses are modified", async () => {
  const { wallet, id, task } = await setup();
  const quote = await wallet.quoteWork(id, task, "claim");
  const privateCopy = structuredClone(quote);
  for (const item of [quote, wallet.pendingWork()[0]!]) {
    Object.assign(item, { action: "release" });
    Object.assign(item.charge, { lamports: "0" });
    Object.assign(item.job, { task: "another task" });
    Object.assign(item.flows[0]!, { to: "someone else" });
  }
  expect(wallet.pendingWork()).toEqual([privateCopy]);
  await wallet.setBudget(id, 0);
  await expect(wallet.decideWork(quote.id, true)).rejects.toThrow(/allowance/);
  expect(journal(id).openClaim).toBeNull();
});

it.each(["startup", "turn", "resumed turn"])("revokes the chosen executor during %s and keeps the claim", async stage => {
  const dir = mkdtempSync(path.join(tmpdir(), "chosen-room-"));
  const started = path.join(dir, "started"), turn = path.join(dir, "turn"), stopped = path.join(dir, "stopped");
  const child = `const fs=require("node:fs"); process.on("SIGTERM",()=>{ fs.writeFileSync(${JSON.stringify(stopped)},"off"); process.exit(0) });
    fs.writeFileSync(${JSON.stringify(started)},"self-test"); setTimeout(()=>fs.writeFileSync(${JSON.stringify(turn)},"turn"),${stage === "startup" ? 2000 : 5}); setInterval(()=>{},1000);`;
  let enabled = true;
  const earn = { executor: { ...executor, argv: [process.execPath, "-e", child, "{prompt}"], timeoutMs: 10000 },
    chosenRoomEnabled: () => enabled, checkExecutionReady: async () => {}, pollIntervalMs: 100 };
  const { wallet, id, task } = await setup(undefined, undefined, undefined, { earn });
  await wallet.decideWork((await wallet.quoteWork(id, task, "claim")).id, true);
  if (stage === "resumed turn") {
    await wallet.close();
    world!.wallet = await world!.reopen({ earn });
  }
  await eventually(async () => existsSync(stage === "startup" ? started : turn));
  enabled = false;
  await eventually(async () => existsSync(stopped));
  if (stage === "startup") expect(existsSync(turn)).toBe(false);
  expect(journal(id).openClaim).toMatchObject({ task, chosen: true });
  expect(journal(id).openClaim?.execution).toBeUndefined();
  expect(world!.sandbox.deliveries.size).toBe(0);
});

it.each(["offline", "invalid"])("holds a chosen claim through %s spec recovery and past the refund window", async kind => {
  let fail = false;
  const { wallet, sandbox, id, task } = await setup(undefined, undefined, undefined, {
    earn: { executor, maxJobAttempts: 1 },
    services: base => ({ ...base, async resolveAgencUri(...args) {
      if (fail) { if (kind === "offline") throw new Error("host offline"); return new TextEncoder().encode("wrong"); }
      return base.resolveAgencUri!(...args);
    } }),
  });
  const claim = await wallet.quoteWork(id, task, "claim");
  await wallet.decideWork(claim.id, true);
  fail = true;
  const buyer = await world!.balance(claim.job.buyer);
  await eventually(async () => !!(journal(id).openClaim?.ownerDecision || journal(id).openClaim?.fetchWaits));
  expect((await wallet.openWork(id)).held).toMatchObject({ canRelease: true, releaseWindow: { phase: "early" } });
  sandbox.advanceClock(3700);
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(journal(id).openClaim).toMatchObject({ chosen: true, task });
  expect(await world!.balance(claim.job.buyer)).toBe(buyer);
  await assertBalances(await wallet.quoteWork(id, task, "release"));
});

it("prices only the shortfall on a pre-funded worker record, in the quote and the funding gate", async () => {
  const { wallet, id, task, sandbox } = await setup();
  const [agent] = await findAgentPda({ agentId: values.hexToBytes(journal(id).agentIdHex!) });
  const [record] = await findWorkerStatsPda({ worker: agent });
  const original = await wallet.quoteWork(id, task, "claim");
  sandbox.fund(record, 1000000n);
  const q = await wallet.quoteWork(id, task, "claim");
  expect(BigInt(q.job.recordRent.lamports)).toBe(BigInt(original.job.recordRent.lamports) - 1000000n);
  expect(q.flows.find(row => row.to === record)?.amount).toEqual(q.job.recordRent);
  const svm = sandbox.market.svm;
  const raw = svm.getAccount(q.job.worker as never)!;
  const reserve = [q.job.deposit, q.job.feeReserve, q.job.rent, q.job.recordRent, q.job.futureRent].reduce((sum, v) => sum + BigInt(v.lamports), 0n);
  svm.setAccount({ ...raw, lamports: reserve - 1n } as never);
  expect((await wallet.openWork(id, 0, task)).jobs).toEqual([]);
  await expect(wallet.decideWork(q.id, true)).rejects.toThrow();
  svm.setAccount({ ...raw, lamports: reserve } as never);
  await assertBalances(await wallet.quoteWork(id, task, "claim"));
});

it("offers direct payment at the worker reputation rate and refuses self-posts and insufficient reputation", async () => {
  const { wallet, sandbox, id } = await setup();
  const self = await wallet.post({ agentId: id, request: "Draw a flower", reward: { usdCents: 20 } });
  expect(self.job.task).toBeTruthy();
  expect((await wallet.openWork(id, 0, self.job.task!)).jobs).toEqual([]);
  await expect(wallet.quoteWork(id, self.job.task!, "claim")).rejects.toThrow();
  const direct = await sandbox.postOpenJob({ title: "Direct", instructions: "Answer", rewardLamports: 50n * CENT, minReputation: 9000, settlement: "auto" });
  expect((await wallet.openWork(id, 0, direct.task)).jobs).toEqual([]);
  const [agent] = await findAgentPda({ agentId: values.hexToBytes(journal(id).agentIdHex!) });
  const raw = sandbox.market.svm.getAccount(agent)!;
  if (!raw.exists) throw new Error("Worker registration missing");
  const before = getAgentRegistrationDecoder().decode(Uint8Array.from(raw.data));
  sandbox.market.svm.setAccount({ ...raw, data: Uint8Array.from(getAgentRegistrationEncoder().encode({ ...before, reputation: 9500 })) } as never);
  const claim = await wallet.quoteWork(id, direct.task, "claim");
  expect(claim.job.direct).toBe(true);
  const task = getTaskDecoder().decode((await sandbox.chain.readAccount(direct.task))!);
  const reward = task.rewardAmount;
  expect(BigInt(claim.job.payout.lamports)).toBe(reward - reward * BigInt(Math.max(1, task.protocolFeeBps - 15)) / 10000n);
  await assertBalances(claim);
  await eventually(async () => (await wallet.openWork(id)).held?.canSubmit);
  const complete = await wallet.quoteWork(id, direct.task, "submit");
  expect(complete.job.direct).toBe(true);
  expect(complete.flows.find(x => x.label === "Worker payout")?.amount).toEqual(claim.job.payout);
  await assertBalances(complete);
});

it("admits a second contest entrant after submission and names the treasury and selection deadline", async () => {
  const { wallet, sandbox, id } = await setup();
  const { task } = await sandbox.postOpenJob({ title: "Contest", instructions: "Enter", rewardLamports: 50n * CENT, settlement: "contest" });
  await completedRoom(id, task);
  const submission = await wallet.quoteWork(id, task, "submit");
  expect(submission.job.canRelease).toBe(false);
  expect(submission.job.releaseBy).toBeNull();
  await assertBalances(submission);
  const other = await wallet.createAgent("Another worker");
  wallet.chooseWork(other.id, true);
  await wallet.fundAgent(other.id, { usdCents: 2000 });
  await wallet.setPolicy(other.id, { askAboveCents: 500, refill: { enabled: true, topUpToCents: 1, perDayCents: 500 } });
  await setEarnWithApproval(wallet, other.id, true);
  await eventually(async () => (await wallet.openWork(other.id).catch(() => null))?.jobs.some(job => job.task === task));
  const entry = await wallet.quoteWork(other.id, task, "claim");
  expect(entry.job).toMatchObject({ contest: true, selectionDeadline: entry.job.deadline + 172800, treasury: submission.job.treasury });
  await assertBalances(entry);
  await expect(wallet.quoteWork(other.id, task, "release")).rejects.toThrow();
  expect(getTaskDecoder().decode((await sandbox.chain.readAccount(task))!).status).toBe(TaskStatus.PendingValidation);
  await eventually(async () => (await wallet.openWork(other.id)).held?.canSubmit);
  const second = await wallet.quoteWork(other.id, task, "submit");
  expect(second.job.preview).toBe("Room output");
  await assertBalances(second);
  for (const workerId of [id, other.id]) {
    const [bidder] = await findAgentPda({ agentId: values.hexToBytes(journal(workerId).agentIdHex!) });
    const [claim] = await findClaimPda({ task, bidder });
    const [submissionPda] = await findTaskSubmissionPda({ claim });
    expect(getTaskSubmissionDecoder().decode((await sandbox.chain.readAccount(submissionPda))!))
      .toMatchObject({ worker: bidder, claim, status: SubmissionStatus.Submitted });
  }
});

it("pages a stable set of eligible addresses and reads an exact brief without holding the signing lane", async () => {
  const directRead = new AsyncLocalStorage<boolean>();
  let withheld: string | undefined;
  let unblock!: () => void;
  let enter!: () => void;
  const waiting = new Promise<void>(resolve => { unblock = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const { wallet, sandbox, id, task } = await setup(undefined, undefined, undefined, { chain: base => ({ ...base, gpa: new Proxy(base.gpa, {
    get(target, key) {
      if (directRead.getStore() && key === "getProgramAccounts") throw new Error("Unexpected full scan during an exact lookup");
      return Reflect.get(target, key);
    },
  }) }), services: base => ({
    ...base, async resolveAgencUri(...args) {
      if (withheld && String(args[0]).includes(withheld)) { enter(); await waiting; }
      return base.resolveAgencUri!(...args);
    },
  }) });
  const request = "A".repeat(4500) + " final requirement";
  const acceptance = Array.from({ length: 11 }, (_, i) => String(i) + "B".repeat(320));
  const posted: Awaited<ReturnType<typeof sandbox.postOpenJob>>[] = [];
  for (let i = 0; i < 10; i++) posted.push(await sandbox.postOpenJob({ title: "Row " + i, instructions: "", rewardLamports: 50n * CENT,
    brief: { fullDescription: request, shortDescription: "Short", acceptanceCriteria: acceptance, index: i } }));
  await sandbox.postOpenJob({ title: "Ineligible", instructions: "No", rewardLamports: 80n * CENT, minReputation: 10000 });
  const first = await wallet.openWork(id);
  expect(first.jobs).toHaveLength(10);
  const added = await sandbox.postOpenJob({ title: "New highest", instructions: "Changed order", rewardLamports: 90n * CENT });
  const second = await wallet.openWork(id, first.next!);
  expect(second.next).toBeNull();
  const addresses = [...first.jobs, ...second.jobs].map(x => x.task);
  expect(new Set(addresses).size).toBe(12);
  expect(addresses).not.toContain(added.task);
  expect(addresses).toEqual([...addresses].sort((a, b) => a.localeCompare(b, "en")));
  const exact = await directRead.run(true, () => wallet.openWork(id, 0, posted[0]!.task));
  expect(exact.jobs[0]).toMatchObject({ request, criteria: acceptance });
  const raw = JSON.parse(exact.jobs[0]!.brief);
  expect(raw).toMatchObject({ shortDescription: "Short", index: 0 });
  const hash = await values.canonicalJobSpecHash(raw);
  withheld = hash.hex;
  const slow = wallet.openWork(id, 0, posted[0]!.task);
  try {
    await entered;
    await completedRoom(id, task);
    await assertBalances(await wallet.quoteWork(id, task, "release"));
  } finally { unblock(); }
  expect((await slow).jobs[0]?.task).toBe(posted[0]!.task);
}, 30000);

it("refuses a release when the stock instruction cannot be simulated", async () => {
  const { getReleaseClaimDiscriminatorBytes } = await import("@tetsuo-ai/marketplace-sdk");
  const { wallet, id, task } = await setup(undefined, undefined, undefined, { chain: base => ({
    ...base, simulateWork: (payer, ix) => getReleaseClaimDiscriminatorBytes().every((v, i) => ix.data?.[i] === v)
      ? Promise.resolve(null) : base.simulateWork!(payer, ix),
  }) });
  await completedRoom(id, task);
  expect((await wallet.openWork(id)).held).toMatchObject({ canRelease: false, canSubmit: true });
  await expect(wallet.quoteWork(id, task, "release")).rejects.toThrow();
});

it("retains the signed claim reservation over restart until it proves unused", async () => {
  let drop = false, pending = true;
  const { wallet, id, task } = await setup(undefined, undefined, undefined, {
    transport: base => ({ ...base, async sendAndConfirm(tx) {
      if (drop) throw new Error("no broadcast receipt");
      return base.sendAndConfirm(tx);
    } }),
    chain: base => ({ ...base, workOutcome: receipt => drop && pending ? Promise.resolve("pending") : base.workOutcome!(receipt) }),
  });
  const quote = await wallet.quoteWork(id, task, "claim");
  drop = true;
  await expect(wallet.decideWork(quote.id, true)).rejects.toThrow();
  expect(journal(id).openClaim).toMatchObject({ chosen: true, phase: "claiming", claimTransactionSignature: expect.any(String), claimLastValidBlockHeight: expect.any(String) });
  await wallet.close();
  world!.wallet = await world!.reopen();
  expect((await world!.wallet.openWork(id)).jobs).toEqual([]);
  pending = false;
  await eventually(async () => !journal(id).openClaim);
  const retry = await world!.wallet.quoteWork(id, task, "claim");
  expect(retry.dailyRemaining).toEqual(quote.dailyRemaining);
  expect(retry.id).not.toBe(quote.id);
});
