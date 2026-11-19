// Earning on practice money, end to end against the real program: the host
// hears when an earned job is paid and what it was called, and two jobs paid
// while the agent was not looking are both counted.
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

async function delivered(w: World, task: string): Promise<void> {
  await eventually(async () => {
    const jobs = await w.wallet.listJobs({ role: "working" }, true);
    return jobs.find((job) => job.task === task && job.status === "delivered");
  }, 30_000);
}

describe("earning on practice money", () => {
  it("tells the host when an earned job is paid, and names the job", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet, sandbox } = world;
    const events: WalletEvent[] = [];
    wallet.on((event) => events.push(event));
    const agent = await wallet.createAgent("My assistant");
    await wallet.setEarn(agent.id, true, 10);
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

  it("counts two jobs paid while the agent was not looking", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet, sandbox } = world;
    const agent = await wallet.createAgent("My assistant");
    // Money for a second job's deposits while the first one's are still out.
    await wallet.fundAgent(agent.id, { usdCents: 1_000 });
    await wallet.setEarn(agent.id, true, 10);
    const first = await sandbox.postOpenJob({ title: "First line", instructions: "Write a line.", rewardLamports: 50n * CENT });
    await delivered(world, first.task);
    const second = await sandbox.postOpenJob({ title: "Second line", instructions: "Write a line.", rewardLamports: 50n * CENT });
    await delivered(world, second.task);

    // Both buyers pay while earning is off (the app was closed, say).
    await wallet.setEarn(agent.id, false);
    await first.approve();
    await second.approve();
    await wallet.setEarn(agent.id, true);

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
});
