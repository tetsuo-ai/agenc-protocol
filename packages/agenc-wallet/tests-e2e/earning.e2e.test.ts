import { setEarnWithApproval } from "./harness.js";
// Earning on practice money, end to end against the real program: the host
// hears when an earned job is paid and what it was called; a buyer who goes
// quiet still pays; two jobs paid while the agent was not looking are both
// counted; and a job whose work keeps failing stops and says why.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WalletEvent } from "../src/client/protocol.js";
import type { EarnOptions } from "../src/earn.js";
import { CENT, eventually, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

/** The pay of a 50-cent job after the marketplace's 5%. */
const NET = (50n * CENT * 95n) / 100n;

function earning(script: string, extra: Partial<EarnOptions> = {}): EarnOptions {
  return {
    executor: {
      argv: [process.execPath, "-e", script, "{prompt}"],
      mode: "sandboxed",
      envAllowlist: [],
      timeoutMs: 30_000,
    },
    pollIntervalMs: 150,
    ...extra,
  };
}

const WORKS = "process.stdout.write('Here is the finished work.')";
const FAILS = "process.exit(3)";

async function delivered(w: World, task: string): Promise<void> {
  await eventually(async () => {
    const jobs = await w.wallet.listJobs({ role: "working" }, true);
    return jobs.find((job) => job.task === task && job.status === "delivered");
  }, 30_000);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("earning on practice money", () => {
  it("stops a job in progress at once when it closes, without counting a failed try", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "agenc-wallet-stop-"));
    const pidFile = path.join(folder, "pid");
    // A job program that would take a minute.
    const slow = 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},60000)';
    world = await startWorld({
      earn: {
        executor: { argv: [process.execPath, "-e", slow, pidFile, "{prompt}"], mode: "sandboxed", envAllowlist: [], timeoutMs: 120_000 },
        pollIntervalMs: 150,
      },
    });
    const { wallet, sandbox, dataDir } = world;
    const agent = await wallet.createAgent("My assistant");
    await setEarnWithApproval(wallet, agent.id, true, 10);
    const open = await sandbox.postOpenJob({
      title: "Write a line",
      instructions: "Write one friendly line.",
      rewardLamports: 50n * CENT,
    });
    let pid = 0;
    try {
      await eventually(async () => existsSync(pidFile), 30_000);
      pid = Number(readFileSync(pidFile, "utf8"));
      expect(alive(pid)).toBe(true);
      const closing = Date.now();
      const closed = await Promise.race([
        wallet.close().then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("still closing"), 5_000)),
      ]);
      expect(closed).toBe("closed");
      expect(Date.now() - closing).toBeLessThan(5_000);
      expect(alive(pid)).toBe(false);
      // The job is still the agent's, to be done on the next start: no try used up.
      const state = JSON.parse(readFileSync(path.join(dataDir, "earn", agent.id, "state.json"), "utf8")) as {
        openClaim: { task: string; failures?: number } | null;
        failedJobs?: unknown[];
      };
      expect(state.openClaim).toMatchObject({ task: open.task });
      expect(state.openClaim?.failures).toBeUndefined();
      expect(state.failedJobs ?? []).toEqual([]);
    } finally {
      if (pid > 0 && alive(pid)) process.kill(-pid, "SIGKILL");
      rmSync(folder, { recursive: true, force: true });
    }
  }, 90_000);

  it("tells the host when an earned job is paid, and names the job", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet, sandbox } = world;
    const events: WalletEvent[] = [];
    wallet.on((event) => events.push(event));
    const agent = await wallet.createAgent("My assistant");
    await setEarnWithApproval(wallet, agent.id, true, 10);
    const open = await sandbox.postOpenJob({
      title: "Write a line",
      instructions: "Write one friendly line.",
      rewardLamports: 50n * CENT,
    });
    await delivered(world, open.task);
    const jobId = `earn_${agent.id}_${open.task}`;
    expect((await wallet.getJob(jobId, true)).title).toBe("Write a line");

    await open.approve();
    await eventually(async () =>
      events.some((event) => event.type === "job" && event.jobId === jobId) &&
      (await wallet.getJob(jobId, true)).status === "paid",
    );
    const paid = await wallet.getJob(jobId, true);
    expect(paid).toMatchObject({ title: "Write a line", status: "paid", statusText: "Done. Your agent earned $0.48." });
    expect(paid.price.lamports).toBe(NET.toString());
    const activity = await wallet.listActivity();
    expect(activity.find((entry) => entry.kind === "earned")).toMatchObject({
      text: "My assistant was paid for Write a line.",
      jobId,
    });
  }, 90_000);

  it("is paid when the buyer goes quiet, once the review time is up", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet, sandbox, clock } = world;
    const agent = await wallet.createAgent("My assistant");
    await setEarnWithApproval(wallet, agent.id, true, 10);
    const open = await sandbox.postOpenJob({
      title: "Write a line",
      instructions: "Write one friendly line.",
      rewardLamports: 50n * CENT,
    });
    await delivered(world, open.task);

    // The buyer never looks at it. Within the hour of review nothing moves.
    sandbox.advanceClock(3_000);
    clock.now += 3_000_000;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await wallet.overview()).agents[0]!.earned.lamports).toBe("0");

    // After it, the agent settles its own delivery and is paid.
    sandbox.advanceClock(700);
    clock.now += 700_000;
    const paid = await eventually(async () => {
      const view = (await wallet.overview()).agents[0]!;
      return BigInt(view.earned.lamports) > 0n ? view : null;
    }, 30_000);
    expect(paid.earned.lamports).toBe(NET.toString());
    expect(paid.earn.jobsDone).toBe(1);
    const job = await wallet.getJob(`earn_${agent.id}_${open.task}`, true);
    expect(job.status).toBe("paid");
  }, 90_000);

  it("counts two jobs paid while the agent was not looking", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet, sandbox } = world;
    const agent = await wallet.createAgent("My assistant");
    // Money for a second job's deposits while the first one's are still out.
    await wallet.fundAgent(agent.id, { usdCents: 1_000 });
    await setEarnWithApproval(wallet, agent.id, true, 10);
    const first = await sandbox.postOpenJob({ title: "First line", instructions: "Write a line.", rewardLamports: 50n * CENT });
    await delivered(world, first.task);
    const second = await sandbox.postOpenJob({ title: "Second line", instructions: "Write a line.", rewardLamports: 50n * CENT });
    await delivered(world, second.task);

    // Both buyers pay while earning is off (the app was closed, say).
    await setEarnWithApproval(wallet, agent.id, false);
    await first.approve();
    await second.approve();
    await setEarnWithApproval(wallet, agent.id, true);

    const view = await eventually(async () => {
      const found = (await wallet.overview()).agents[0]!;
      return found.earn.jobsDone === 2 ? found : null;
    }, 30_000);
    expect(view.earned.lamports).toBe((2n * NET).toString());
    const jobs = await wallet.listJobs({ role: "working" }, true);
    expect(jobs.map((job) => [job.title, job.status, job.price.lamports]).sort()).toEqual([
      ["First line", "paid", NET.toString()],
      ["Second line", "paid", NET.toString()],
    ]);
    const earned = (await wallet.listActivity()).filter((entry) => entry.kind === "earned");
    expect(earned.map((entry) => entry.text).sort()).toEqual([
      "My assistant was paid for First line.",
      "My assistant was paid for Second line.",
    ]);
  }, 120_000);

  it("stops trying a job whose work keeps failing, and says why", async () => {
    world = await startWorld({ earn: earning(FAILS, { retryDelayMs: 100 }) });
    const { wallet, sandbox } = world;
    const events: WalletEvent[] = [];
    wallet.on((event) => events.push(event));
    const agent = await wallet.createAgent("My assistant");
    await setEarnWithApproval(wallet, agent.id, true, 10);
    const open = await sandbox.postOpenJob({ title: "Write a line", instructions: "Write one friendly line.", rewardLamports: 50n * CENT });
    const jobId = `earn_${agent.id}_${open.task}`;

    const failed = await eventually(async () => {
      const job = (await wallet.listJobs({ role: "working" }, true)).find((entry) => entry.id === jobId);
      return job?.status === "failed" ? job : null;
    }, 30_000);
    expect(failed).toMatchObject({
      title: "Write a line",
      statusText: "Your agent stopped after 3 tries: the program that does the work kept failing.",
    });
    // It shows what the job would have paid.
    expect(failed.price.lamports).toBe((50n * CENT).toString());
    expect(events).toContainEqual({ type: "job", jobId });
    expect((await wallet.listActivity()).find((entry) => entry.jobId === jobId)).toMatchObject({
      kind: "note",
      text: "My assistant could not do Write a line: the program that does the work kept failing.",
    });

    // And it is not tried again: the job stays as it is.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await wallet.getJob(jobId, true)).status).toBe("failed");
  }, 90_000);

  it("stops taking jobs after several in a row fail, until earning is switched on again", async () => {
    world = await startWorld({ earn: earning(FAILS, { maxJobAttempts: 1 }) });
    const { wallet, sandbox } = world;
    const agent = await wallet.createAgent("My assistant");
    // Given-up jobs keep their deposits out until their claims are released.
    await wallet.fundAgent(agent.id, { usdCents: 1_000 });
    await setEarnWithApproval(wallet, agent.id, true, 10);
    for (const title of ["One", "Two", "Three"]) {
      const open = await sandbox.postOpenJob({ title, instructions: "Write a line.", rewardLamports: 50n * CENT });
      await eventually(async () =>
        (await wallet.listJobs({ role: "working" }, true)).some(
          (job) => job.task === open.task && job.status === "failed",
        ),
      30_000);
    }
    const stopped = await eventually(async () => {
      const view = (await wallet.overview()).agents[0]!;
      return view.earn.state === "error" ? view : null;
    }, 30_000);
    expect(stopped.earn.lastError).toBe(
      "Stopped taking jobs after several in a row failed: the program that does the work kept failing.",
    );
    // A fourth job is left alone.
    const fourth = await sandbox.postOpenJob({ title: "Four", instructions: "Write a line.", rewardLamports: 50n * CENT });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await wallet.listJobs({ role: "working" }, true)).some((job) => job.task === fourth.task)).toBe(false);

    // Switching earning off and on is the go to try again.
    await setEarnWithApproval(wallet, agent.id, false);
    const again = await setEarnWithApproval(wallet, agent.id, true);
    expect(again.earn.lastError).toBeNull();
    await eventually(async () =>
      (await wallet.listJobs({ role: "working" }, true)).some((job) => job.task === fourth.task),
    30_000);
  }, 120_000);
});
