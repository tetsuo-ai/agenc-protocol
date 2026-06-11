// Structural tests for watchClaimableTasks: fabricated TaskCreated events and a
// fake gPA transport drive the watch with NO network and NO litesvm. They prove
// (1) a fabricated TaskCreated event surfaces via onTask, (2) the claimable
// filter excludes non-matching tasks, (3) de-dupe across event + catch-up,
// (4) stop() ends the watch, and (5) the catch-up sweep surfaces Open tasks.
import { describe, it, expect, vi } from "vitest";
import {
  address,
  getAddressEncoder,
  type Address,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  TASK_CREATED_EVENT_DISCRIMINATOR,
  getTaskEncoder,
  getTaskJobSpecEncoder,
  DependencyType,
  TaskStatus,
  TaskType,
  findTaskPda,
  findTaskJobSpecPda,
} from "../src/generated/index.js";
import { watchClaimableTasks, type ClaimableTask } from "../src/watch/index.js";
import type {
  GpaFilter,
  ProgramAccountsTransport,
} from "../src/queries/index.js";
import type { MarketplaceEventsRpcSubscriptions } from "../src/events/index.js";

// ---------------------------------------------------------------------------
// Fixtures: a hand-assembled TaskCreated log blob (the events layer decodes
// `Program data:` lines emitted while the agenc program is executing).
// ---------------------------------------------------------------------------

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

const dataLine = (bytes: Uint8Array): string => `Program data: ${toBase64(bytes)}`;

const invokeLine = (program: string): string => `Program ${program} invoke [1]`;
const successLine = (program: string): string => `Program ${program} success`;

const inAgencContext = (...lines: string[]): string[] => [
  invokeLine(AGENC_COORDINATION_PROGRAM_ADDRESS),
  ...lines,
  successLine(AGENC_COORDINATION_PROGRAM_ADDRESS),
];

type TaskFixture = {
  creator: Address;
  taskId: Uint8Array;
  requiredCapabilities: bigint;
  rewardAmount: bigint;
};

/** Hand-assemble `discriminator ++ borsh(TaskCreated)` (rewardMint = None). */
function buildTaskCreatedBlob(f: TaskFixture): Uint8Array {
  const addressEncoder = getAddressEncoder();
  const size = 8 + 32 + 32 + 8 + 8 + 1 + 8 + 2 + 1 + 8;
  const blob = new Uint8Array(size);
  const view = new DataView(blob.buffer);
  let offset = 0;
  blob.set(TASK_CREATED_EVENT_DISCRIMINATOR, offset);
  offset += 8;
  blob.set(f.taskId, offset); // task_id [u8;32]
  offset += 32;
  blob.set(addressEncoder.encode(f.creator), offset); // creator
  offset += 32;
  view.setBigUint64(offset, f.requiredCapabilities, true);
  offset += 8;
  view.setBigUint64(offset, f.rewardAmount, true);
  offset += 8;
  blob[offset] = 0; // task_type
  offset += 1;
  view.setBigInt64(offset, 1_700_000_000n + 3600n, true); // deadline
  offset += 8;
  view.setUint16(offset, 0, true); // min_reputation
  offset += 2;
  blob[offset] = 0; // rewardMint Option::None
  offset += 1;
  view.setBigInt64(offset, 1_700_000_000n, true); // timestamp
  offset += 8;
  expect(offset).toBe(size);
  return blob;
}

type LogsNotification = { value: { err: unknown; logs: readonly string[] | null; signature: string } };

const notif = (logs: readonly string[] | null, signature: string): LogsNotification => ({
  value: { err: null, logs, signature },
});

/**
 * A fake rpcSubscriptions whose single program-address subscription yields the
 * scripted notifications, then (optionally) hangs until aborted so the watch
 * stays alive for stop()/abort tests.
 */
function makeFakeSubscriptions(
  notifications: LogsNotification[],
  { hang = false }: { hang?: boolean } = {},
): MarketplaceEventsRpcSubscriptions {
  return {
    logsNotifications() {
      return {
        subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) =>
          (async function* () {
            for (const item of notifications) yield item;
            if (hang) {
              await new Promise<void>((resolve) => {
                if (abortSignal.aborted) return resolve();
                abortSignal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            }
          })(),
      };
    },
  };
}

const CREATOR_A = address("BPFLoaderUpgradeab1e11111111111111111111111");
const CREATOR_B = address("So11111111111111111111111111111111111111112");
const ZERO_ADDR = address("11111111111111111111111111111111");

/** Encode a full Task account (for the gPA catch-up fake), rewardMint = SOL. */
function encodeTask(
  f: TaskFixture & {
    status?: TaskStatus;
    currentWorkers?: number;
    completions?: number;
  },
): Uint8Array {
  return new Uint8Array(
    getTaskEncoder().encode({
      taskId: f.taskId,
      creator: f.creator,
      requiredCapabilities: f.requiredCapabilities,
      description: new Uint8Array(64),
      constraintHash: new Uint8Array(32),
      rewardAmount: f.rewardAmount,
      maxWorkers: 1,
      currentWorkers: f.currentWorkers ?? 0,
      status: f.status ?? TaskStatus.Open,
      taskType: TaskType.Exclusive,
      createdAt: 1_700_000_000n,
      deadline: 1_700_003_600n,
      completedAt: 0n,
      escrow: ZERO_ADDR,
      result: new Uint8Array(64),
      completions: f.completions ?? 0,
      requiredCompletions: 1,
      bump: 0,
      protocolFeeBps: 0,
      dependsOn: null,
      dependencyType: DependencyType.None,
      minReputation: 0,
      rewardMint: null,
      operator: ZERO_ADDR,
      operatorFeeBps: 0,
      reserved: new Uint8Array(16),
      referrer: ZERO_ADDR,
      referrerFeeBps: 0,
    }),
  );
}

/**
 * Encode a `TaskJobSpec` account pinning `task`. `jobSpecHash` defaults to a
 * non-zero hash (a genuinely-pinned spec); pass an all-zero hash to model the
 * NOT-pinned-on-chain case the `validate_job_spec_pointer` gate rejects.
 */
function encodeTaskJobSpec(
  task: Address,
  creator: Address,
  { hash = new Uint8Array(32).fill(0xab) }: { hash?: Uint8Array } = {},
): Uint8Array {
  return new Uint8Array(
    getTaskJobSpecEncoder().encode({
      task,
      creator,
      jobSpecHash: hash,
      jobSpecUri: "agenc://job-spec/test",
      createdAt: 1_700_000_000n,
      updatedAt: 1_700_000_000n,
      bump: 0,
      reserved: new Uint8Array(7),
    }),
  );
}

/** A fake gPA transport over an in-memory account set (exact RPC memcmp semantics). */
function makeGpaTransport(
  accounts: Array<{ address: Address; data: Uint8Array }>,
): ProgramAccountsTransport & { calls: number } {
  const transport = {
    calls: 0,
    async getProgramAccounts({ filters }: { filters: readonly GpaFilter[] }) {
      transport.calls += 1;
      return accounts.filter(({ data }) =>
        filters.every((filter) => {
          if ("dataSize" in filter) return data.length === filter.dataSize;
          const { offset, bytes } = filter.memcmp;
          if (offset + bytes.length > data.length) return false;
          for (let i = 0; i < bytes.length; i += 1) {
            if (data[offset + i] !== bytes[i]) return false;
          }
          return true;
        }),
      );
    },
  };
  return transport;
}

/** Collect ClaimableTasks delivered to onTask, resolving when `count` arrive. */
function collector(count: number): {
  onTask: (t: ClaimableTask) => void;
  done: Promise<ClaimableTask[]>;
} {
  const got: ClaimableTask[] = [];
  let resolve!: (v: ClaimableTask[]) => void;
  const done = new Promise<ClaimableTask[]>((r) => (resolve = r));
  return {
    onTask: (t) => {
      got.push(t);
      if (got.length >= count) resolve(got.slice());
    },
    done,
  };
}

describe("watchClaimableTasks: event path", () => {
  it("surfaces a fabricated TaskCreated event via onTask (once its job spec is pinned)", async () => {
    const taskId = new Uint8Array(32).fill(7);
    const [expectedPda] = await findTaskPda({ creator: CREATOR_A, taskId });
    const blob = buildTaskCreatedBlob({
      creator: CREATOR_A,
      taskId,
      requiredCapabilities: 1n,
      rewardAmount: 5_000_000n,
    });
    const subs = makeFakeSubscriptions([notif(inAgencContext(dataLine(blob)), "s1")], {
      hang: true,
    });
    // The event path confirms the on-chain job-spec pin before surfacing, so it
    // needs a gPA read source carrying the pinned TaskJobSpec for the task.
    const [jobSpecPda] = await findTaskJobSpecPda({ task: expectedPda });
    const transport = makeGpaTransport([
      { address: jobSpecPda, data: encodeTaskJobSpec(expectedPda, CREATOR_A) },
    ]);
    const { onTask, done } = collector(1);

    const watch = watchClaimableTasks({
      rpcSubscriptions: subs,
      indexer: transport,
      onTask,
      pollIntervalMs: 1_000_000, // keep the catch-up sweep out of this event-path assertion
    });
    const [task] = await done;
    await watch.stop();

    expect(task.task).toBe(expectedPda);
    expect(task.creator).toBe(CREATOR_A);
    expect(task.requiredCapabilities).toBe(1n);
    expect(task.rewardAmount).toBe(5_000_000n);
    expect(task.rewardMint).toBeNull();
    expect(task.source).toBe("event");
    expect(task.account).toBeUndefined();
    expect(new Uint8Array(task.taskId)).toEqual(taskId);
  });

  it("excludes a TaskCreated event that fails the filter (capabilities + minReward + creator)", async () => {
    // Three tasks; only the first matches { capabilities: 0b11, minReward: 1e6, creator: A }.
    const match = buildTaskCreatedBlob({
      creator: CREATOR_A,
      taskId: new Uint8Array(32).fill(1),
      requiredCapabilities: 0b01n, // subset of 0b11
      rewardAmount: 2_000_000n,
    });
    const tooExpensiveCaps = buildTaskCreatedBlob({
      creator: CREATOR_A,
      taskId: new Uint8Array(32).fill(2),
      requiredCapabilities: 0b100n, // NOT a subset of 0b11
      rewardAmount: 9_000_000n,
    });
    const tooCheap = buildTaskCreatedBlob({
      creator: CREATOR_A,
      taskId: new Uint8Array(32).fill(3),
      requiredCapabilities: 0b01n,
      rewardAmount: 1n, // below minReward
    });
    const wrongCreator = buildTaskCreatedBlob({
      creator: CREATOR_B,
      taskId: new Uint8Array(32).fill(4),
      requiredCapabilities: 0b01n,
      rewardAmount: 9_000_000n,
    });
    const subs = makeFakeSubscriptions(
      [
        notif(inAgencContext(dataLine(match)), "m"),
        notif(inAgencContext(dataLine(tooExpensiveCaps)), "c"),
        notif(inAgencContext(dataLine(tooCheap)), "p"),
        notif(inAgencContext(dataLine(wrongCreator)), "w"),
      ],
      { hang: true },
    );

    const [matchPda] = await findTaskPda({
      creator: CREATOR_A,
      taskId: new Uint8Array(32).fill(1),
    });
    // The (only) filter-passing task is pinned on-chain so the event path can
    // surface it; the others are dropped by the filter before any pin check.
    const [matchJobSpec] = await findTaskJobSpecPda({ task: matchPda });
    const transport = makeGpaTransport([
      { address: matchJobSpec, data: encodeTaskJobSpec(matchPda, CREATOR_A) },
    ]);

    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      rpcSubscriptions: subs,
      indexer: transport,
      filter: { capabilities: 0b11n, minReward: 1_000_000n, creator: CREATOR_A },
      onTask: (t) => {
        got.push(t);
      },
      pollIntervalMs: 1_000_000, // event-path assertion only
    });
    // Drain the four scripted notifications, then stop.
    const first = (async () => {
      for await (const t of watch) {
        void t;
        break;
      }
    })();
    await first;
    await watch.stop();

    expect(got).toHaveLength(1);
    expect(got[0]!.task).toBe(matchPda);
  });
});

describe("watchClaimableTasks: catch-up (gPA) path", () => {
  it("surfaces Open tasks from a listOpenTasks sweep and excludes non-Open", async () => {
    const openId = new Uint8Array(32).fill(10);
    const claimedId = new Uint8Array(32).fill(11);
    const [openPda] = await findTaskPda({ creator: CREATOR_A, taskId: openId });
    const [claimedPda] = await findTaskPda({
      creator: CREATOR_A,
      taskId: claimedId,
    });
    const [openJobSpec] = await findTaskJobSpecPda({ task: openPda });
    const transport = makeGpaTransport([
      {
        address: openPda,
        data: encodeTask({
          creator: CREATOR_A,
          taskId: openId,
          requiredCapabilities: 1n,
          rewardAmount: 4_000_000n,
          status: TaskStatus.Open,
        }),
      },
      {
        address: claimedPda,
        data: encodeTask({
          creator: CREATOR_A,
          taskId: claimedId,
          requiredCapabilities: 1n,
          rewardAmount: 4_000_000n,
          status: TaskStatus.InProgress,
        }),
      },
      // Pin the Open task's job spec so it is genuinely claimable.
      { address: openJobSpec, data: encodeTaskJobSpec(openPda, CREATOR_A) },
    ]);

    const { onTask, done } = collector(1);
    const watch = watchClaimableTasks({
      indexer: transport,
      filter: { capabilities: 0b1n },
      onTask,
      pollIntervalMs: 50,
    });
    const [task] = await done;
    await watch.stop();

    expect(task.task).toBe(openPda); // the InProgress task is filtered out server-side
    expect(task.source).toBe("catch-up");
    expect(task.account).toBeDefined();
    expect(task.account!.status).toBe(TaskStatus.Open);
    expect(task.rewardAmount).toBe(4_000_000n);
  });

  it("de-dupes a task that appears on BOTH the event and the catch-up path", async () => {
    const taskId = new Uint8Array(32).fill(20);
    const [pda] = await findTaskPda({ creator: CREATOR_A, taskId });

    const blob = buildTaskCreatedBlob({
      creator: CREATOR_A,
      taskId,
      requiredCapabilities: 1n,
      rewardAmount: 3_000_000n,
    });
    const subs = makeFakeSubscriptions(
      [notif(inAgencContext(dataLine(blob)), "dup")],
      { hang: true },
    );
    const [jobSpecPda] = await findTaskJobSpecPda({ task: pda });
    const transport = makeGpaTransport([
      {
        address: pda,
        data: encodeTask({
          creator: CREATOR_A,
          taskId,
          requiredCapabilities: 1n,
          rewardAmount: 3_000_000n,
          status: TaskStatus.Open,
        }),
      },
      // Pinned so BOTH the event path and the catch-up path consider it
      // claimable — the point being it is still delivered exactly once.
      { address: jobSpecPda, data: encodeTaskJobSpec(pda, CREATOR_A) },
    ]);

    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      rpcSubscriptions: subs,
      indexer: transport,
      onTask: (t) => {
        got.push(t);
      },
      pollIntervalMs: 20,
    });
    // Let both the event and at least one catch-up sweep run.
    await new Promise((r) => setTimeout(r, 120));
    await watch.stop();

    expect(got.filter((t) => t.task === pda)).toHaveLength(1);
  });
});

describe("watchClaimableTasks: lifecycle", () => {
  it("requires at least one transport", () => {
    expect(() => watchClaimableTasks({ onTask: () => {} })).toThrow(
      /at least one transport/,
    );
  });

  it("stop() ends the async iteration and the catch-up sweep", async () => {
    const transport = makeGpaTransport([]); // no accounts → empty sweeps
    const watch = watchClaimableTasks({
      indexer: transport,
      onTask: () => {},
      pollIntervalMs: 10,
    });

    // Iterate in the background; stop() must terminate it.
    const iterated: ClaimableTask[] = [];
    const loop = (async () => {
      for await (const t of watch) iterated.push(t);
    })();

    await new Promise((r) => setTimeout(r, 40));
    const callsAtStop = transport.calls;
    await watch.stop();
    await loop; // resolves only once iteration ends

    // No more sweeps after stop().
    await new Promise((r) => setTimeout(r, 40));
    expect(transport.calls).toBe(callsAtStop);
    expect(iterated).toEqual([]);
  });

  it("stops when an already-aborted signal is passed", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = makeGpaTransport([]);
    const watch = watchClaimableTasks({
      indexer: transport,
      onTask: () => {},
      signal: controller.signal,
      pollIntervalMs: 10,
    });
    const got: ClaimableTask[] = [];
    for await (const t of watch) got.push(t);
    expect(got).toEqual([]);
    expect(transport.calls).toBe(0);
  });

  it("routes a transport error to onError without throwing through the iterator", async () => {
    const failing: ProgramAccountsTransport = {
      async getProgramAccounts() {
        throw new Error("gpa boom");
      },
    };
    const errors: unknown[] = [];
    const watch = watchClaimableTasks({
      indexer: failing,
      onTask: () => {},
      onError: (e) => errors.push(e),
      pollIntervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 40));
    await watch.stop();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as Error).message).toMatch(/gpa boom/);
  });
});

// ---------------------------------------------------------------------------
// Finding #4 [MAJOR] — claimable predicate must be "Open AND job-spec pinned".
// REVERT-SENSITIVE: a fabricated Open-but-UNPINNED task must NOT be surfaced;
// an Open+pinned task MUST be. Against the pre-fix code (which surfaced every
// Open task) the first assertion fails — the unpinned task is wrongly surfaced.
// ---------------------------------------------------------------------------
describe("watchClaimableTasks: claimable predicate = Open AND job-spec pinned (#4)", () => {
  it("catch-up: surfaces an Open+pinned task but NOT an Open-but-unpinned one", async () => {
    const pinnedId = new Uint8Array(32).fill(40);
    const unpinnedId = new Uint8Array(32).fill(41);
    const [pinnedPda] = await findTaskPda({ creator: CREATOR_A, taskId: pinnedId });
    const [unpinnedPda] = await findTaskPda({
      creator: CREATOR_A,
      taskId: unpinnedId,
    });
    const [pinnedJobSpec] = await findTaskJobSpecPda({ task: pinnedPda });

    // Both tasks are Open. ONLY the first has a TaskJobSpec pointer (with a
    // non-zero hash) — i.e. only the first would let claim_task_with_job_spec
    // land on-chain; claiming the second fails AccountNotInitialized (3012).
    const transport = makeGpaTransport([
      {
        address: pinnedPda,
        data: encodeTask({
          creator: CREATOR_A,
          taskId: pinnedId,
          requiredCapabilities: 1n,
          rewardAmount: 4_000_000n,
          status: TaskStatus.Open,
        }),
      },
      {
        address: unpinnedPda,
        data: encodeTask({
          creator: CREATOR_A,
          taskId: unpinnedId,
          requiredCapabilities: 1n,
          rewardAmount: 4_000_000n,
          status: TaskStatus.Open,
        }),
      },
      { address: pinnedJobSpec, data: encodeTaskJobSpec(pinnedPda, CREATOR_A) },
    ]);

    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: transport,
      onTask: (t) => {
        got.push(t);
      },
      pollIntervalMs: 15,
    });
    // Let several sweeps run so an unpinned task would have plenty of chances to
    // leak through if the predicate were Open-only.
    await new Promise((r) => setTimeout(r, 90));
    await watch.stop();

    const surfaced = new Set(got.map((t) => t.task));
    expect(surfaced.has(pinnedPda)).toBe(true); // claimable → surfaced
    expect(surfaced.has(unpinnedPda)).toBe(false); // Open but unpinned → NOT surfaced
    expect(got.filter((t) => t.task === pinnedPda)).toHaveLength(1); // exactly once
  });

  it("catch-up: an all-zero job-spec hash counts as NOT pinned (mirrors validate_job_spec_pointer)", async () => {
    // A TaskJobSpec account EXISTS but its hash is all zero — the on-chain
    // validate_job_spec_pointer rejects this (InvalidTaskJobSpecHash), so the
    // task is not actually claimable and must not be surfaced.
    const taskId = new Uint8Array(32).fill(42);
    const [pda] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpec] = await findTaskJobSpecPda({ task: pda });
    const transport = makeGpaTransport([
      {
        address: pda,
        data: encodeTask({
          creator: CREATOR_A,
          taskId,
          requiredCapabilities: 1n,
          rewardAmount: 4_000_000n,
          status: TaskStatus.Open,
        }),
      },
      {
        address: jobSpec,
        data: encodeTaskJobSpec(pda, CREATOR_A, { hash: new Uint8Array(32) }),
      },
    ]);

    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: transport,
      onTask: (t) => {
        got.push(t);
      },
      pollIntervalMs: 15,
    });
    await new Promise((r) => setTimeout(r, 70));
    await watch.stop();

    expect(got).toHaveLength(0);
  });

  it("event: a TaskCreated whose job spec is NOT yet pinned is not surfaced", async () => {
    const taskId = new Uint8Array(32).fill(43);
    const [pda] = await findTaskPda({ creator: CREATOR_A, taskId });
    const blob = buildTaskCreatedBlob({
      creator: CREATOR_A,
      taskId,
      requiredCapabilities: 1n,
      rewardAmount: 5_000_000n,
    });
    const subs = makeFakeSubscriptions(
      [notif(inAgencContext(dataLine(blob)), "unpinned")],
      { hang: true },
    );
    // Catch-up source has NO TaskJobSpec for this task → not pinned.
    const transport = makeGpaTransport([]);

    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      rpcSubscriptions: subs,
      indexer: transport,
      onTask: (t) => {
        got.push(t);
      },
      pollIntervalMs: 1_000_000, // isolate the event path
    });
    await new Promise((r) => setTimeout(r, 80));
    await watch.stop();

    expect(got.filter((t) => t.task === pda)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Finding #6 [MINOR] — bounded dedupe + re-open re-fires.
// REVERT-SENSITIVE (re-open half): a task that goes Open → (claimed) → Open
// again must be delivered AGAIN. Against the pre-fix pure-PDA Set the second
// delivery is permanently suppressed (got.length stays 1).
// ---------------------------------------------------------------------------
describe("watchClaimableTasks: bounded re-open-aware dedupe (#6)", () => {
  /** A gPA transport whose returned accounts can be swapped between sweeps. */
  function makeMutableGpaTransport(initial: Array<{ address: Address; data: Uint8Array }>) {
    let accounts = initial;
    const transport = {
      set(next: Array<{ address: Address; data: Uint8Array }>) {
        accounts = next;
      },
      async getProgramAccounts({ filters }: { filters: readonly GpaFilter[] }) {
        return accounts.filter(({ data }) =>
          filters.every((filter) => {
            if ("dataSize" in filter) return data.length === filter.dataSize;
            const { offset, bytes } = filter.memcmp;
            if (offset + bytes.length > data.length) return false;
            for (let i = 0; i < bytes.length; i += 1) {
              if (data[offset + i] !== bytes[i]) return false;
            }
            return true;
          }),
        );
      },
    };
    return transport;
  }

  it("re-delivers a task that is re-opened (different claim-state marker)", async () => {
    const taskId = new Uint8Array(32).fill(50);
    const [pda] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpec] = await findTaskJobSpecPda({ task: pda });
    const jobSpecAcct = {
      address: jobSpec,
      data: encodeTaskJobSpec(pda, CREATOR_A),
    };
    const openFresh = {
      address: pda,
      data: encodeTask({
        creator: CREATOR_A,
        taskId,
        requiredCapabilities: 1n,
        rewardAmount: 3_000_000n,
        status: TaskStatus.Open,
        currentWorkers: 0,
        completions: 0,
      }),
    };
    // The SAME PDA, Open again but with a post-cycle claim-state marker
    // (currentWorkers reflects a prior claim). Mirrors PendingValidation→Open.
    const openReopened = {
      address: pda,
      data: encodeTask({
        creator: CREATOR_A,
        taskId,
        requiredCapabilities: 1n,
        rewardAmount: 3_000_000n,
        status: TaskStatus.Open,
        currentWorkers: 1,
        completions: 0,
      }),
    };
    const transport = makeMutableGpaTransport([openFresh, jobSpecAcct]);

    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: transport,
      onTask: (t) => {
        got.push(t);
      },
      pollIntervalMs: 10,
    });
    // First: deliver the fresh Open task.
    await vi.waitFor(() => expect(got.length).toBe(1), { timeout: 1000 });
    // Now re-open with a different marker and let further sweeps run.
    transport.set([openReopened, jobSpecAcct]);
    await vi.waitFor(() => expect(got.length).toBe(2), { timeout: 1000 });
    await watch.stop();

    expect(got).toHaveLength(2);
    expect(got.every((t) => t.task === pda)).toBe(true);
  });

  it("does NOT re-deliver a steady-state task (same marker) across sweeps", async () => {
    const taskId = new Uint8Array(32).fill(51);
    const [pda] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpec] = await findTaskJobSpecPda({ task: pda });
    const transport = makeGpaTransport([
      {
        address: pda,
        data: encodeTask({
          creator: CREATOR_A,
          taskId,
          requiredCapabilities: 1n,
          rewardAmount: 3_000_000n,
          status: TaskStatus.Open,
        }),
      },
      { address: jobSpec, data: encodeTaskJobSpec(pda, CREATOR_A) },
    ]);
    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: transport,
      onTask: (t) => {
        got.push(t);
      },
      pollIntervalMs: 10,
    });
    // Let many sweeps run; the unchanged task must still be delivered once.
    await new Promise((r) => setTimeout(r, 90));
    await watch.stop();
    expect(got.filter((t) => t.task === pda)).toHaveLength(1);
  });

  it("rejects a non-positive maxSeen", () => {
    const transport = makeGpaTransport([]);
    expect(() =>
      watchClaimableTasks({ indexer: transport, onTask: () => {}, maxSeen: 0 }),
    ).toThrow(/maxSeen must be a positive integer/);
  });

  it("bounds the dedupe set: an evicted task can re-deliver, an in-cap one cannot", async () => {
    // maxSeen=1: after surfacing task B, task A's key is evicted, so when A
    // re-surfaces it is delivered AGAIN (proving the cap evicts). A pure
    // unbounded Set would suppress A's second delivery forever.
    const idA = new Uint8Array(32).fill(60);
    const idB = new Uint8Array(32).fill(61);
    const [pdaA] = await findTaskPda({ creator: CREATOR_A, taskId: idA });
    const [pdaB] = await findTaskPda({ creator: CREATOR_A, taskId: idB });
    const [jobSpecA] = await findTaskJobSpecPda({ task: pdaA });
    const [jobSpecB] = await findTaskJobSpecPda({ task: pdaB });
    const taskA = {
      address: pdaA,
      data: encodeTask({
        creator: CREATOR_A,
        taskId: idA,
        requiredCapabilities: 1n,
        rewardAmount: 3_000_000n,
        status: TaskStatus.Open,
      }),
    };
    const taskB = {
      address: pdaB,
      data: encodeTask({
        creator: CREATOR_A,
        taskId: idB,
        requiredCapabilities: 1n,
        rewardAmount: 3_000_000n,
        status: TaskStatus.Open,
      }),
    };
    const specA = { address: jobSpecA, data: encodeTaskJobSpec(pdaA, CREATOR_A) };
    const specB = { address: jobSpecB, data: encodeTaskJobSpec(pdaB, CREATOR_A) };
    const transport = makeMutableGpaTransport([taskA, specA]);

    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: transport,
      maxSeen: 1,
      onTask: (t) => {
        got.push(t);
      },
      pollIntervalMs: 10,
    });
    // 1) deliver A (seen = {A})
    await vi.waitFor(
      () => expect(got.some((t) => t.task === pdaA)).toBe(true),
      { timeout: 1000 },
    );
    // 2) swap to B only → deliver B, which evicts A from the size-1 set
    transport.set([taskB, specB]);
    await vi.waitFor(
      () => expect(got.some((t) => t.task === pdaB)).toBe(true),
      { timeout: 1000 },
    );
    // 3) bring A back → A re-delivers because it was evicted
    transport.set([taskA, specA]);
    await vi.waitFor(
      () => expect(got.filter((t) => t.task === pdaA).length).toBe(2),
      { timeout: 1000 },
    );
    await watch.stop();
    expect(got.filter((t) => t.task === pdaA)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Finding #7 [MINOR] — catch-up backoff + a throwing onError must not kill the
// watch. REVERT-SENSITIVE (throwing-onError half): a user onError that throws
// must not crash the watch nor surface an unhandled rejection. Against the
// pre-fix code (onError called unguarded) the throw propagates out of the pump
// and rejects the never-awaited producers → unhandled rejection / silent death.
// ---------------------------------------------------------------------------
describe("watchClaimableTasks: failed-sweep backoff + resilient onError (#7)", () => {
  it("backs off between consecutive failing sweeps (sweep rate tapers, not flat)", async () => {
    const timestamps: number[] = [];
    const failing: ProgramAccountsTransport = {
      async getProgramAccounts() {
        timestamps.push(Date.now());
        throw new Error("rpc down");
      },
    };
    const watch = watchClaimableTasks({
      indexer: failing,
      onTask: () => {},
      onError: () => {},
      pollIntervalMs: 10,
      maxBackoffMs: 400,
    });
    // Run long enough that a NON-backing-off loop (flat ~10ms) would fire ~30+
    // sweeps, but a backing-off loop (sleeps 20, 30, 50, 90, 170, 330...) fires
    // far fewer. Count, then assert the gaps grow.
    await new Promise((r) => setTimeout(r, 400));
    await watch.stop();

    expect(timestamps.length).toBeGreaterThanOrEqual(3);
    // A flat 10ms loop over ~400ms would produce ~30+ sweeps; backoff keeps it small.
    expect(timestamps.length).toBeLessThan(15);
    // The inter-sweep gaps must GROW under sustained failure: the largest gap
    // is well above the flat pollIntervalMs (impossible without backoff), and
    // the later gaps exceed the earliest. Compare gap MAXes rather than the
    // single last gap (which can be truncated by stop()).
    const gaps: number[] = [];
    for (let i = 1; i < timestamps.length; i += 1) {
      gaps.push(timestamps[i]! - timestamps[i - 1]!);
    }
    const maxGap = Math.max(...gaps);
    const firstGap = gaps[0]!;
    // Backoff pushed at least one gap far beyond the flat 10ms interval...
    expect(maxGap).toBeGreaterThan(40);
    // ...and the gaps taper upward (a later gap exceeds the first).
    expect(maxGap).toBeGreaterThan(firstGap);
  });

  it("a clean sweep resets the backoff (failure → success → failure starts low again)", async () => {
    // First sweep fails, second succeeds (resetting backoff), then keeps
    // succeeding. We assert the watch keeps sweeping (does not die) and the
    // successful task surfaces despite the initial failure.
    const taskId = new Uint8Array(32).fill(70);
    const [pda] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpec] = await findTaskJobSpecPda({ task: pda });
    const good = [
      {
        address: pda,
        data: encodeTask({
          creator: CREATOR_A,
          taskId,
          requiredCapabilities: 1n,
          rewardAmount: 3_000_000n,
          status: TaskStatus.Open,
        }),
      },
      { address: jobSpec, data: encodeTaskJobSpec(pda, CREATOR_A) },
    ];
    let sweep = 0;
    const transport: ProgramAccountsTransport = {
      async getProgramAccounts({ filters }) {
        sweep += 1;
        if (sweep === 1) throw new Error("transient");
        return good.filter(({ data }) =>
          filters.every((filter) => {
            if ("dataSize" in filter) return data.length === filter.dataSize;
            const { offset, bytes } = filter.memcmp;
            if (offset + bytes.length > data.length) return false;
            for (let i = 0; i < bytes.length; i += 1) {
              if (data[offset + i] !== bytes[i]) return false;
            }
            return true;
          }),
        );
      },
    };
    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: transport,
      onTask: (t) => {
        got.push(t);
      },
      onError: () => {},
      pollIntervalMs: 10,
    });
    await vi.waitFor(() => expect(got.length).toBe(1), { timeout: 1000 });
    await watch.stop();
    expect(got[0]!.task).toBe(pda);
  });

  it("a throwing user onError does not crash the watch or surface an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const failing: ProgramAccountsTransport = {
        async getProgramAccounts() {
          throw new Error("gpa down");
        },
      };
      let onErrorCalls = 0;
      // Fire-and-forget: register onTask, never iterate, never await stop early.
      const watch = watchClaimableTasks({
        indexer: failing,
        onTask: () => {},
        onError: () => {
          onErrorCalls += 1;
          throw new Error("user onError blew up");
        },
        pollIntervalMs: 10,
      });
      // Give the pump several failing sweeps; a throwing onError must NOT abort it.
      await new Promise((r) => setTimeout(r, 80));
      // Let any microtask-queued unhandled rejection settle.
      await new Promise((r) => setTimeout(r, 0));
      await watch.stop();

      expect(onErrorCalls).toBeGreaterThanOrEqual(2); // the loop kept running across sweeps
      expect(unhandled).toHaveLength(0); // no unhandled rejection escaped
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
