// A job whose work keeps failing is tried a few times, each time after a
// longer wait, and then given up with the reason kept, instead of being run
// again every poll in silence. Several given-up jobs in a row stop the worker
// from taking new ones until whoever runs it clears that.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultPinnedRequester,
  JobSpecError,
  JobSpecUnreachableError,
} from "../src/job-spec.js";
import {
  clearWorkerPause,
  DEFAULT_MAX_FETCH_WAIT_MS,
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

describe("a job spec host that answers with an HTTP error", () => {
  // A real HTTP server on this computer, reached the way the worker reaches a
  // job spec host: the pinned requester, with the answer's status as sent.
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((request, response) => {
      const status = Number((request.url ?? "/500").slice(1));
      response.statusCode = Number.isInteger(status) ? status : 500;
      response.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });
  /** What the worker's own downloader makes of the host answering `status`. */
  const download = (status: number) => async (): Promise<Uint8Array> => {
    const answer = await defaultPinnedRequester({
      url: new URL(`http://127.0.0.1:${port}/${status}`),
      address: { address: "127.0.0.1", family: 4 },
      maxBytes: 64 * 1024,
      signal: AbortSignal.timeout(5_000),
    });
    if (answer.kind !== "success") throw new Error("unexpected redirect");
    return answer.bytes;
  };

  it("tells a refusal for good from a host that is down or busy", async () => {
    for (const status of [404, 410, 403, 401]) {
      const error = await download(status)().catch((caught: unknown) => caught);
      expect(error, `status ${status}`).toBeInstanceOf(JobSpecError);
      expect(error, `status ${status}`).not.toBeInstanceOf(JobSpecUnreachableError);
    }
    for (const status of [500, 502, 503, 408, 429]) {
      const error = await download(status)().catch((caught: unknown) => caught);
      expect(error, `status ${status}`).toBeInstanceOf(JobSpecUnreachableError);
    }
  });

  it("gives a job up after its tries when the job spec is gone (404)", async () => {
    const { stateDir, ctx, runs, waitOut } = await heldJob();
    ctx.fetchUri = download(404);
    await resumeOpenClaim(ctx, agent);
    waitOut();
    await resumeOpenClaim(ctx, agent);
    waitOut();
    await resumeOpenClaim(ctx, agent);
    const state = loadState(stateDir);
    expect(state.openClaim).toBeNull();
    expect(state.failedJobs).toEqual([
      expect.objectContaining({ cause: "attempts", attempts: 3, reason: expect.stringMatching(/job spec could not be checked.*404/) }),
    ]);
    expect(runs()).toBe(0);
  });

  it("does not stop taking jobs for jobs whose description could not be read", async () => {
    // Two jobs given up in a row already; a third that is given up because its
    // job spec is gone ran no work, so it does not stop the worker.
    const { stateDir, ctx, events, runs, waitOut } = await heldJob({ inARow: 2 });
    ctx.fetchUri = download(404);
    await resumeOpenClaim(ctx, agent);
    waitOut();
    await resumeOpenClaim(ctx, agent);
    waitOut();
    await resumeOpenClaim(ctx, agent);
    const state = loadState(stateDir);
    expect(state.openClaim).toBeNull();
    expect(state.failedJobs).toEqual([
      expect.objectContaining({ cause: "attempts", reason: expect.stringMatching(/job spec could not be checked.*404/) }),
    ]);
    expect(state.consecutiveFailures).toBe(2);
    expect(state.pause).toBeNull();
    expect(events.some((event) => event.event === "worker.paused")).toBe(false);
    expect(runs()).toBe(0);
  });

  it("counts a job whose work ran toward the pause, even when its last try met a job spec that is gone", async () => {
    // Two jobs given up in a row already. This one's work runs and fails
    // twice; then its job spec is taken away and the third try is refused.
    const { stateDir, ctx, events, runs, waitOut } = await heldJob({ inARow: 2 });
    await resumeOpenClaim(ctx, agent);
    waitOut();
    await resumeOpenClaim(ctx, agent);
    waitOut();
    ctx.fetchUri = download(404);
    await resumeOpenClaim(ctx, agent);
    const state = loadState(stateDir);
    expect(runs()).toBe(2);
    expect(state.openClaim).toBeNull();
    expect(state.failedJobs).toEqual([
      expect.objectContaining({ cause: "attempts", attempts: 3, reason: expect.stringMatching(/job spec could not be checked.*404/) }),
    ]);
    expect(state.consecutiveFailures).toBe(3);
    expect(state.pause).not.toBeNull();
    expect(events.some((event) => event.event === "worker.paused")).toBe(true);
  });

  it("keeps waiting while the job spec host answers that it is down (500)", async () => {
    const { stateDir, ctx, waitOut } = await heldJob();
    ctx.fetchUri = download(500);
    for (let look = 0; look < 4; look += 1) {
      waitOut();
      await resumeOpenClaim(ctx, agent);
    }
    const held = loadState(stateDir);
    expect(held.failedJobs).toEqual([]);
    expect(held.openClaim).toMatchObject({ task: TASK, fetchWaits: 4 });
    expect(held.openClaim?.failures).toBeUndefined();
  });
});

describe("a job spec that cannot be fetched for hours", () => {
  it("is given up once the waiting has gone on for six hours, with why", async () => {
    const { stateDir, ctx, events, waitOut } = await heldJob();
    ctx.fetchUri = async () => {
      throw new Error("connect ECONNREFUSED specs.example");
    };
    await resumeOpenClaim(ctx, agent);
    const waiting = loadState(stateDir).openClaim!;
    expect(Date.now() - Date.parse(waiting.fetchFailingSince!)).toBeLessThan(60_000);

    // Six hours of failed fetches later.
    const later = loadState(stateDir);
    later.openClaim!.fetchFailingSince = new Date(Date.now() - DEFAULT_MAX_FETCH_WAIT_MS - 1_000).toISOString();
    saveState(stateDir, later);
    waitOut();
    await resumeOpenClaim(ctx, agent);

    const state = loadState(stateDir);
    expect(state.openClaim).toBeNull();
    expect(state.failedJobs).toEqual([
      expect.objectContaining({ cause: "attempts", reason: "the job spec could not be fetched for 6 hours", rewardAmount: REWARD.toString() }),
    ]);
    expect(events.some((event) => event.event === "task.given-up")).toBe(true);
  });

  it("does not count time the worker was stopped or the computer slept", async () => {
    const { stateDir, ctx, waitOut } = await heldJob();
    ctx.fetchUri = async () => {
      throw new Error("connect ECONNREFUSED specs.example");
    };
    await resumeOpenClaim(ctx, agent);
    // That one failure, then the wallet stays closed for seven hours.
    const closed = loadState(stateDir);
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    closed.openClaim!.fetchFailingSince = sevenHoursAgo;
    closed.openClaim!.lastFetchFailureAt = sevenHoursAgo;
    saveState(stateDir, closed);
    waitOut();
    // Opened again, its first fetch fails before the network is up: the job waits on.
    await resumeOpenClaim(ctx, agent);
    const state = loadState(stateDir);
    expect(state.failedJobs).toEqual([]);
    expect(state.openClaim).toMatchObject({ task: TASK, fetchWaits: 1 });
    expect(Date.now() - Date.parse(state.openClaim!.fetchFailingSince!)).toBeLessThan(60_000);
  });

  it("keeps counting the time spent trying across a gap, so six hours of trying in parts give it up", async () => {
    const { stateDir, ctx, waitOut } = await heldJob();
    ctx.fetchUri = async () => {
      throw new Error("connect ECONNREFUSED specs.example");
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-20T00:00:00.000Z"));
      await resumeOpenClaim(ctx, agent);
      // Four hours of trying, a try at every wait (the longest is half an hour).
      for (let look = 0; look < 8; look += 1) {
        vi.setSystemTime(new Date(Date.now() + 30 * 60_000));
        waitOut();
        await resumeOpenClaim(ctx, agent);
      }
      expect(loadState(stateDir).openClaim).not.toBeNull();
      // The wallet is closed overnight, eight hours.
      vi.setSystemTime(new Date(Date.now() + 8 * 60 * 60_000));
      waitOut();
      await resumeOpenClaim(ctx, agent);
      expect(loadState(stateDir).openClaim).not.toBeNull();
      // Two more hours of trying make six.
      for (let look = 0; look < 5 && loadState(stateDir).openClaim !== null; look += 1) {
        vi.setSystemTime(new Date(Date.now() + 30 * 60_000));
        waitOut();
        await resumeOpenClaim(ctx, agent);
      }
    } finally {
      vi.useRealTimers();
    }
    const state = loadState(stateDir);
    expect(state.openClaim).toBeNull();
    expect(state.failedJobs).toEqual([
      expect.objectContaining({ cause: "attempts", reason: "the job spec could not be fetched for 6 hours" }),
    ]);
  });

  it("is given up after six hours of failures at every wait while it runs", async () => {
    const { stateDir, ctx, waitOut } = await heldJob();
    ctx.fetchUri = async () => {
      throw new Error("connect ECONNREFUSED specs.example");
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-20T00:00:00.000Z"));
      await resumeOpenClaim(ctx, agent);
      // A try at least every half hour (the longest wait) for six and a half hours.
      for (let look = 0; look < 13 && loadState(stateDir).openClaim !== null; look += 1) {
        vi.setSystemTime(new Date(Date.now() + 30 * 60_000));
        waitOut();
        await resumeOpenClaim(ctx, agent);
      }
    } finally {
      vi.useRealTimers();
    }
    const state = loadState(stateDir);
    expect(state.openClaim).toBeNull();
    expect(state.failedJobs).toEqual([
      expect.objectContaining({ cause: "attempts", reason: "the job spec could not be fetched for 6 hours" }),
    ]);
  });

  it("does not stop taking jobs when a job is given up after six hours of failed fetches", async () => {
    const { stateDir, ctx, waitOut } = await heldJob({ inARow: 2 });
    ctx.fetchUri = async () => {
      throw new Error("connect ECONNREFUSED specs.example");
    };
    await resumeOpenClaim(ctx, agent);
    const later = loadState(stateDir);
    later.openClaim!.fetchFailingSince = new Date(Date.now() - DEFAULT_MAX_FETCH_WAIT_MS - 1_000).toISOString();
    saveState(stateDir, later);
    waitOut();
    await resumeOpenClaim(ctx, agent);
    const state = loadState(stateDir);
    expect(state.openClaim).toBeNull();
    expect(state.failedJobs).toHaveLength(1);
    expect(state.consecutiveFailures).toBe(2);
    expect(state.pause).toBeNull();
  });

  it("starts the six hours again after a good fetch", async () => {
    const { stateDir, ctx, waitOut } = await heldJob();
    const good = heldJobSpec;
    ctx.fetchUri = async () => {
      throw new Error("connect ECONNREFUSED specs.example");
    };
    await resumeOpenClaim(ctx, agent);
    expect(loadState(stateDir).openClaim?.fetchFailingSince).toBeDefined();
    // The host is back: the job spec arrives (the work then fails, as this job's always does).
    ctx.fetchUri = good;
    waitOut();
    await resumeOpenClaim(ctx, agent);
    const after = loadState(stateDir).openClaim!;
    expect(after.fetchFailingSince).toBeUndefined();
    expect(after.lastFetchFailureAt).toBeUndefined();
    expect(after.fetchWaits).toBeUndefined();
    expect(after.failures).toBe(1);
  });
});

describe("a job in progress when the worker is stopped", () => {
  it("is stopped at once, and the stop is not counted as a failed try", async () => {
    const { stateDir, ctx, events } = await heldJob();
    const pidFile = path.join(stateDir, "job.pid");
    // A job program that would run for half a minute.
    ctx.config.executor = [
      process.execPath,
      "-e",
      'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},30000)',
      pidFile,
      "{prompt}",
    ];
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const resuming = resumeOpenClaim(ctx, agent);
    let pid = 0;
    try {
      for (let waited = 0; waited < 5_000 && !existsSync(pidFile); waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      pid = Number(readFileSync(pidFile, "utf8"));
      controller.abort();
      const outcome = await Promise.race([
        resuming,
        new Promise((resolve) => setTimeout(() => resolve("still running"), 3_000)),
      ]);
      expect(outcome).toMatchObject({ status: "execution-failed", task: TASK });
      expect(() => process.kill(pid, 0)).toThrow();
      const state = loadState(stateDir);
      expect(state.openClaim).toMatchObject({ task: TASK, phase: "claimed" });
      expect(state.openClaim?.failures).toBeUndefined();
      expect(state.openClaim?.retryAt).toBeUndefined();
      expect(state.failedJobs).toEqual([]);
      expect(events.some((event) => event.event === "task.execution-stopped")).toBe(true);
      expect(events.some((event) => event.event === "task.execution-failed")).toBe(false);
    } finally {
      try {
        if (pid > 0) process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
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
