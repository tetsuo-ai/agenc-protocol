// A job whose work keeps failing is tried a few times, each time after a
// longer wait, and then given up with the reason kept, instead of being run
// again every poll in silence. Several given-up jobs in a row stop the worker
// from taking new ones until whoever runs it clears that.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { address, type Address, type TransactionSigner } from "@solana/kit";
import {
  DependencyType,
  findClaimPda,
  findTaskJobSpecPda,
  getTaskClaimEncoder,
  getTaskEncoder,
  getTaskJobSpecEncoder,
  TaskStatus,
  TaskType,
  values,
  type MarketplaceClient,
  type ProgramAccountsTransport,
  type TaskArgs,
} from "@tetsuo-ai/marketplace-sdk";
import { describe, expect, it } from "vitest";
import {
  clearWorkerPause,
  DEFAULT_RETRY_DELAY_MS,
  processCandidate,
  resumeOpenClaim,
  type WorkerAgent,
  type WorkerContext,
  type WorkerLogEvent,
} from "../src/runtime.js";
import { emptyState, loadState, saveState } from "../src/state.js";

const TASK = address("F1qYyDAYYS1sLxq5nDprfNknnwGPo7ssyKvhScv6f8Uc");
const CREATOR = address("7Y9dRMi8ZtyDjLdSpzUCsxDgHooZTfp3RyYs2eZWmL39");
const WORKER = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const WALLET = address("E5NfNsr4SxWf8wJtVH5m7WpujYzxT6f17CFqN6c51dWm");
const NONE = address("11111111111111111111111111111111");
const REWARD = 4_200_000n;
const SPEC_URI = "https://specs.example/task.json";

const agent: WorkerAgent = {
  agentId: new Uint8Array(32).fill(9),
  agentPda: WORKER,
  registered: true,
  justRegistered: false,
};

function taskData(status: TaskStatus, overrides: Partial<TaskArgs> = {}): Uint8Array {
  return new Uint8Array(
    getTaskEncoder().encode({
      taskId: new Uint8Array(32).fill(1),
      creator: CREATOR,
      requiredCapabilities: 1n,
      description: new Uint8Array(64).fill(2),
      constraintHash: new Uint8Array(32),
      rewardAmount: REWARD,
      maxWorkers: 1,
      currentWorkers: status === TaskStatus.InProgress ? 1 : 0,
      status,
      taskType: TaskType.Exclusive,
      createdAt: 1n,
      deadline: 0n,
      completedAt: 0n,
      escrow: NONE,
      result: new Uint8Array(64),
      completions: 0,
      requiredCompletions: 1,
      bump: 250,
      protocolFeeBps: 100,
      dependsOn: NONE,
      dependencyType: DependencyType.Data,
      minReputation: 0,
      rewardMint: null,
      operator: NONE,
      operatorFeeBps: 0,
      reserved: new Uint8Array(16),
      referrer: NONE,
      referrerFeeBps: 0,
      ...overrides,
    }),
  );
}

function claimData(): Uint8Array {
  return new Uint8Array(
    getTaskClaimEncoder().encode({
      task: TASK,
      worker: WORKER,
      claimedAt: 1_700_000_000n,
      expiresAt: 4_000_000_000n,
      completedAt: 0n,
      proofHash: new Uint8Array(32),
      resultData: new Uint8Array(64),
      isCompleted: false,
      isValidated: false,
      rewardPaid: 0n,
      bump: 251,
    }),
  );
}

/** The job spec of the last `heldJob`, as its host serves it. */
let heldJobSpec: () => Promise<Uint8Array> = async () => new Uint8Array();

/** A worker holding a claim on TASK, whose work exits with an error every time. */
async function heldJob(options: { task?: Uint8Array; inARow?: number } = {}) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-retries-"));
  const state = emptyState();
  state.openClaim = {
    task: TASK,
    claimedAt: "2026-11-19T00:00:00.000Z",
    phase: "claimed",
    title: "Write a line",
  };
  state.consecutiveFailures = options.inARow ?? 0;
  saveState(stateDir, state);

  const payload = { title: "Write a line", instructions: "Write one line." };
  const digest = await values.canonicalJobSpecHash(payload);
  const body = new TextEncoder().encode(
    JSON.stringify({
      integrity: { algorithm: "sha256", canonicalization: "json-stable-v1", payloadHash: digest.hex },
      payload,
    }),
  );
  const [jobSpecPda] = await findTaskJobSpecPda({ task: TASK });
  const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
  const accounts = new Map<Address, Uint8Array>([
    [TASK, options.task ?? taskData(TaskStatus.InProgress)],
    [claimPda, claimData()],
    [
      jobSpecPda,
      new Uint8Array(
        getTaskJobSpecEncoder().encode({
          task: TASK,
          creator: CREATOR,
          jobSpecHash: digest.bytes,
          jobSpecUri: SPEC_URI,
          createdAt: 1n,
          updatedAt: 1n,
          bump: 248,
          reserved: new Uint8Array(7),
        }),
      ),
    ],
  ]);
  const events: WorkerLogEvent[] = [];
  const ctx: WorkerContext = {
    config: {
      capabilities: 1n,
      minRewardLamports: 0n,
      maxRewardLamports: 10_000_000n,
      allowUnboundedReward: false,
      // The work fails the same way every time it runs.
      executor: [process.execPath, "-e", "process.stderr.write('model quota used up'); process.exit(3)", "{prompt}"],
      executorMode: "sandboxed",
      executorEnvAllowlist: [],
      resultUploader: null,
      creatorAllowlist: null,
      allowAnyCreator: true,
      endpoint: "https://worker.example",
      executorTimeoutMs: 30_000,
      pollIntervalMs: 15_000,
    },
    client: {} as MarketplaceClient,
    signer: { address: WALLET } as TransactionSigner,
    gpa: { getProgramAccounts: async () => [] } as ProgramAccountsTransport,
    readAccount: async (account) => accounts.get(account) ?? null,
    stateDir,
    log: (event) => events.push(event),
    fetchUri: async () => body,
  };
  heldJobSpec = async () => body;
  const runs = () => events.filter((event) => event.event === "task.execution-failed").length;
  /** Pretend the wait before the next attempt is over. */
  const waitOut = () => {
    const current = loadState(stateDir);
    current.openClaim!.retryAt = new Date(Date.now() - 1_000).toISOString();
    saveState(stateDir, current);
  };
  return { stateDir, accounts, ctx, events, runs, waitOut };
}

describe("a job whose work keeps failing", () => {
  it("is tried again only after a wait that grows, and given up after three attempts with why", async () => {
    const { stateDir, ctx, events, runs, waitOut } = await heldJob();

    const before = Date.now();
    expect((await resumeOpenClaim(ctx, agent))?.status).toBe("execution-failed");
    expect(runs()).toBe(1);
    const first = loadState(stateDir).openClaim!;
    expect(first.failures).toBe(1);
    expect(first.lastFailure).toMatch(/exited with code 3/);
    const firstWait = Date.parse(first.retryAt!) - before;
    expect(firstWait).toBeGreaterThanOrEqual(DEFAULT_RETRY_DELAY_MS - 1_000);

    // Polling again before the wait is over runs nothing.
    for (let poll = 0; poll < 5; poll += 1) {
      expect(await resumeOpenClaim(ctx, agent)).toMatchObject({
        status: "execution-failed",
        reason: expect.stringMatching(/waiting to try again/),
      });
    }
    expect(runs()).toBe(1);

    waitOut();
    const secondAt = Date.now();
    await resumeOpenClaim(ctx, agent);
    expect(runs()).toBe(2);
    const second = loadState(stateDir).openClaim!;
    expect(second.failures).toBe(2);
    // Each wait is longer than the one before.
    expect(Date.parse(second.retryAt!) - secondAt).toBeGreaterThan(firstWait * 2);

    waitOut();
    await resumeOpenClaim(ctx, agent);
    expect(runs()).toBe(3);

    // Three failed attempts: the job is given up and kept with why.
    const state = loadState(stateDir);
    expect(state.openClaim).toBeNull();
    expect(state.failedJobs).toEqual([
      expect.objectContaining({
        task: TASK,
        cause: "attempts",
        attempts: 3,
        title: "Write a line",
        // What the job would have paid, so its owner sees what was lost.
        rewardAmount: REWARD.toString(),
        claimReleased: false,
        reason: expect.stringMatching(/exited with code 3/),
      }),
    ]);
    expect(events.filter((event) => event.event === "task.retry-scheduled")).toHaveLength(2);
    expect(events.find((event) => event.event === "task.given-up")).toMatchObject({
      task: TASK,
      cause: "attempts",
      attempts: 3,
      title: "Write a line",
    });

    // And it is not run again.
    for (let poll = 0; poll < 3; poll += 1) await resumeOpenClaim(ctx, agent);
    expect(runs()).toBe(3);
    // The worker is free for other work, but never this job again.
    const again = await processCandidate(ctx, agent, {
      task: TASK,
      creator: CREATOR,
      rewardAmount: REWARD,
      rewardMint: null,
      requiredCapabilities: 1n,
    });
    expect(again).toMatchObject({ status: "skipped", reason: "already-given-up" });
  });

  it("is given up at once when the time to deliver has run out", async () => {
    const { stateDir, ctx, runs } = await heldJob({
      task: taskData(TaskStatus.InProgress, { deadline: 1_000n }),
    });
    expect(await resumeOpenClaim(ctx, agent)).toBeNull();
    expect(runs()).toBe(0);
    expect(loadState(stateDir).failedJobs).toEqual([
      expect.objectContaining({ cause: "expired", reason: "the time to deliver ran out", rewardAmount: REWARD.toString() }),
    ]);
  });

  it("is kept with why when the task ends before anything was delivered", async () => {
    const { stateDir, accounts, ctx } = await heldJob();
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    accounts.set(TASK, taskData(TaskStatus.Cancelled));
    accounts.delete(claimPda);

    expect(await resumeOpenClaim(ctx, agent)).toBeNull();
    const state = loadState(stateDir);
    expect(state.openClaim).toBeNull();
    expect(state.failedJobs).toEqual([
      expect.objectContaining({ cause: "cancelled", claimReleased: true }),
    ]);
    // Somebody else ending a job is not the worker failing.
    expect(state.consecutiveFailures).toBe(0);
  });
});

describe("a job whose job spec cannot be fetched", () => {
  it("waits for it while there is time, without using up the job's attempts", async () => {
    const { stateDir, ctx, events, runs, waitOut } = await heldJob();
    let downloads = 0;
    // The host that keeps the job spec is down for a while.
    ctx.fetchUri = async () => {
      downloads += 1;
      throw new Error("connect ECONNREFUSED specs.example");
    };

    const before = Date.now();
    await resumeOpenClaim(ctx, agent);
    const first = loadState(stateDir).openClaim!;
    const firstWait = Date.parse(first.retryAt!) - before;
    expect(firstWait).toBeGreaterThanOrEqual(DEFAULT_RETRY_DELAY_MS - 1_000);
    for (let look = 1; look < 6; look += 1) {
      waitOut();
      await resumeOpenClaim(ctx, agent);
    }
    expect(downloads).toBe(6);
    const held = loadState(stateDir);
    expect(held.failedJobs).toEqual([]);
    expect(held.consecutiveFailures).toBe(0);
    expect(held.openClaim).toMatchObject({ task: TASK, phase: "claimed", fetchWaits: 6 });
    expect(held.openClaim?.failures).toBeUndefined();
    expect(held.openClaim?.lastFailure).toMatch(/could not be fetched/);
    // The waits still grow.
    expect(Date.parse(held.openClaim!.retryAt!) - Date.now()).toBeGreaterThan(firstWait * 2);
    expect(events.filter((event) => event.event === "task.fetch-wait-scheduled")).toHaveLength(6);
    expect(runs()).toBe(0);

    // The host is back: the job is done as asked.
    ctx.fetchUri = heldJobSpec;
    waitOut();
    await resumeOpenClaim(ctx, agent);
    expect(runs()).toBe(1);
  });

  it("uses up an attempt when it is fetched but is not the job spec the task names", async () => {
    const { stateDir, ctx, waitOut } = await heldJob();
    ctx.fetchUri = async () => new TextEncoder().encode(JSON.stringify({ payload: { title: "Something else" } }));
    await resumeOpenClaim(ctx, agent);
    waitOut();
    await resumeOpenClaim(ctx, agent);
    waitOut();
    await resumeOpenClaim(ctx, agent);
    const state = loadState(stateDir);
    expect(state.openClaim).toBeNull();
    expect(state.failedJobs).toEqual([
      expect.objectContaining({ cause: "attempts", attempts: 3, reason: expect.stringMatching(/job spec could not be checked/) }),
    ]);
  });
});

describe("several jobs given up in a row", () => {
  it("stop the worker taking new jobs until that is cleared", async () => {
    const { stateDir, ctx, events, waitOut } = await heldJob({ inARow: 2 });
    await resumeOpenClaim(ctx, agent);
    waitOut();
    await resumeOpenClaim(ctx, agent);
    waitOut();
    await resumeOpenClaim(ctx, agent);

    const state = loadState(stateDir);
    expect(state.consecutiveFailures).toBe(3);
    expect(state.pause).toEqual({
      since: expect.any(String),
      reason: expect.stringMatching(/exited with code 3/),
    });
    expect(events.find((event) => event.event === "worker.paused")).toMatchObject({
      failedJobsInARow: 3,
    });

    const candidate = {
      task: address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"),
      creator: CREATOR,
      rewardAmount: REWARD,
      rewardMint: null,
      requiredCapabilities: 1n,
    };
    expect(await processCandidate(ctx, agent, candidate)).toMatchObject({
      status: "skipped",
      reason: "paused-after-failed-jobs",
    });

    expect(clearWorkerPause(stateDir)).toBe(true);
    expect(loadState(stateDir)).toMatchObject({ pause: null, consecutiveFailures: 0 });
    // No longer refused for the pause (it now fails later, on the task read).
    expect(await processCandidate(ctx, agent, candidate)).not.toMatchObject({
      reason: "paused-after-failed-jobs",
    });
    expect(clearWorkerPause(stateDir)).toBe(false);
  });
});
