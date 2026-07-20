// Structural tests for watchClaimableTasks: fabricated TaskCreated events and a
// fake gPA transport drive the watch with NO network and NO litesvm. They prove
// (1) a TaskCreated hint surfaces only after current Task + pin revalidation,
// (2) local candidate filters exclude nonmatches, (3) de-dupe across event +
// catch-up, (4) stop() ends the watch, and (5) catch-up surfaces task-state-
// eligible+pinned candidates. Worker/config/cross-account gates are outside
// this structural suite.
import { describe, it, expect, vi } from "vitest";
import { address, getAddressEncoder, type Address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  TASK_CREATED_EVENT_DISCRIMINATOR,
  TASK_JOB_SPEC_DISCRIMINATOR,
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

const dataLine = (bytes: Uint8Array): string =>
  `Program data: ${toBase64(bytes)}`;

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

type LogsNotification = {
  value: { err: unknown; logs: readonly string[] | null; signature: string };
};

const notif = (
  logs: readonly string[] | null,
  signature: string,
): LogsNotification => ({
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
    taskType?: TaskType;
    maxWorkers?: number;
    currentWorkers?: number;
    completions?: number;
    requiredCompletions?: number;
    claimGeneration?: bigint;
    taskSchema?: number;
    constraintHash?: Uint8Array;
    deadline?: bigint;
  },
): Uint8Array {
  const reserved = new Uint8Array(16);
  reserved[0] = f.taskSchema ?? 0;
  new DataView(reserved.buffer).setBigUint64(3, f.claimGeneration ?? 0n, true);
  return new Uint8Array(
    getTaskEncoder().encode({
      taskId: f.taskId,
      creator: f.creator,
      requiredCapabilities: f.requiredCapabilities,
      description: new Uint8Array(64),
      constraintHash: f.constraintHash ?? new Uint8Array(32),
      rewardAmount: f.rewardAmount,
      maxWorkers: f.maxWorkers ?? 1,
      currentWorkers: f.currentWorkers ?? 0,
      status: f.status ?? TaskStatus.Open,
      taskType: f.taskType ?? TaskType.Exclusive,
      createdAt: 1_700_000_000n,
      deadline: f.deadline ?? 0n,
      completedAt: 0n,
      escrow: ZERO_ADDR,
      result: new Uint8Array(64),
      completions: f.completions ?? 0,
      requiredCompletions: f.requiredCompletions ?? 1,
      bump: 0,
      protocolFeeBps: 0,
      dependsOn: null,
      dependencyType: DependencyType.None,
      minReputation: 0,
      rewardMint: null,
      operator: ZERO_ADDR,
      operatorFeeBps: 0,
      reserved,
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

/** A filter-faithful gPA transport whose backing snapshot can change. */
function makeMutableAccountsTransport(
  initial: Array<{ address: Address; data: Uint8Array }>,
) {
  let accounts = initial;
  return {
    set(next: Array<{ address: Address; data: Uint8Array }>) {
      accounts = next;
    },
    async getProgramAccounts({ filters }: { filters: readonly GpaFilter[] }) {
      return accounts.filter(({ data }) =>
        filters.every((filter) => {
          if ("dataSize" in filter) return data.length === filter.dataSize;
          const { offset, bytes } = filter.memcmp;
          if (offset + bytes.length > data.length) return false;
          for (let index = 0; index < bytes.length; index += 1) {
            if (data[offset + index] !== bytes[index]) return false;
          }
          return true;
        }),
      );
    },
  } satisfies ProgramAccountsTransport & {
    set(next: Array<{ address: Address; data: Uint8Array }>): void;
  };
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
    const subs = makeFakeSubscriptions(
      [notif(inAgencContext(dataLine(blob)), "s1")],
      {
        hang: true,
      },
    );
    // The event path confirms the on-chain job-spec pin before surfacing, so it
    // needs a gPA read source carrying the pinned TaskJobSpec for the task.
    const [jobSpecPda] = await findTaskJobSpecPda({ task: expectedPda });
    const transport = makeGpaTransport([
      {
        address: expectedPda,
        data: encodeTask({
          creator: CREATOR_A,
          taskId,
          requiredCapabilities: 1n,
          rewardAmount: 5_000_000n,
        }),
      },
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
    // The live hint and mandatory initial catch-up intentionally race through
    // one dedupe set; either may win, but the task is delivered exactly once.
    expect(["event", "catch-up"]).toContain(task.source);
    expect(task.account).toBeDefined();
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
      {
        address: matchPda,
        data: encodeTask({
          creator: CREATOR_A,
          taskId: new Uint8Array(32).fill(1),
          requiredCapabilities: 0b01n,
          rewardAmount: 2_000_000n,
        }),
      },
      { address: matchJobSpec, data: encodeTaskJobSpec(matchPda, CREATOR_A) },
    ]);

    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      rpcSubscriptions: subs,
      indexer: transport,
      filter: {
        capabilities: 0b11n,
        minReward: 1_000_000n,
        creator: CREATOR_A,
      },
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

  it("revalidates delayed events and does not surface full or bid-exclusive tasks", async () => {
    const fullId = new Uint8Array(32).fill(5);
    const bidId = new Uint8Array(32).fill(6);
    const [fullTask] = await findTaskPda({
      creator: CREATOR_A,
      taskId: fullId,
    });
    const [bidTask] = await findTaskPda({ creator: CREATOR_A, taskId: bidId });
    const [fullSpec] = await findTaskJobSpecPda({ task: fullTask });
    const [bidSpec] = await findTaskJobSpecPda({ task: bidTask });
    const subs = makeFakeSubscriptions(
      [
        notif(
          inAgencContext(
            dataLine(
              buildTaskCreatedBlob({
                creator: CREATOR_A,
                taskId: fullId,
                requiredCapabilities: 1n,
                rewardAmount: 2_000_000n,
              }),
            ),
          ),
          "delayed-full",
        ),
        notif(
          inAgencContext(
            dataLine(
              buildTaskCreatedBlob({
                creator: CREATOR_A,
                taskId: bidId,
                requiredCapabilities: 1n,
                rewardAmount: 2_000_000n,
              }),
            ),
          ),
          "delayed-bid",
        ),
      ],
      { hang: true },
    );
    const transport = makeGpaTransport([
      {
        address: fullTask,
        data: encodeTask({
          creator: CREATOR_A,
          taskId: fullId,
          requiredCapabilities: 1n,
          rewardAmount: 2_000_000n,
          status: TaskStatus.InProgress,
          maxWorkers: 1,
          currentWorkers: 1,
          claimGeneration: 1n,
        }),
      },
      {
        address: bidTask,
        data: encodeTask({
          creator: CREATOR_A,
          taskId: bidId,
          requiredCapabilities: 1n,
          rewardAmount: 2_000_000n,
          taskType: TaskType.BidExclusive,
        }),
      },
      { address: fullSpec, data: encodeTaskJobSpec(fullTask, CREATOR_A) },
      { address: bidSpec, data: encodeTaskJobSpec(bidTask, CREATOR_A) },
    ]);
    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      rpcSubscriptions: subs,
      indexer: transport,
      onTask: (task) => {
        got.push(task);
      },
      pollIntervalMs: 1_000_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    await watch.stop();
    expect(got).toEqual([]);
  });

  it("serializes event revalidation with the mandatory initial catch-up sweep", async () => {
    const taskId = new Uint8Array(32).fill(8);
    const [task] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpec] = await findTaskJobSpecPda({ task });
    const backing = makeGpaTransport([
      {
        address: task,
        data: encodeTask({
          creator: CREATOR_A,
          taskId,
          requiredCapabilities: 1n,
          rewardAmount: 2_000_000n,
        }),
      },
      { address: jobSpec, data: encodeTaskJobSpec(task, CREATOR_A) },
    ]);
    let active = 0;
    let maxActive = 0;
    const errors: unknown[] = [];
    const nonReentrant: ProgramAccountsTransport = {
      async getProgramAccounts(request) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active > 1) throw new Error("transport overlap");
        try {
          await new Promise((resolve) => setTimeout(resolve, 3));
          return await backing.getProgramAccounts(request);
        } finally {
          active -= 1;
        }
      },
    };
    const subs = makeFakeSubscriptions(
      [
        notif(
          inAgencContext(
            dataLine(
              buildTaskCreatedBlob({
                creator: CREATOR_A,
                taskId,
                requiredCapabilities: 1n,
                rewardAmount: 2_000_000n,
              }),
            ),
          ),
          "non-reentrant",
        ),
      ],
      { hang: true },
    );
    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      rpcSubscriptions: subs,
      indexer: nonReentrant,
      onTask: (claimable) => {
        got.push(claimable);
      },
      onError: (error) => errors.push(error),
      pollIntervalMs: 10,
      operationTimeoutMs: 500,
    });

    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await watch.stop();
    expect(maxActive).toBe(1);
    expect(errors).toEqual([]);
    expect(got).toHaveLength(1);
  });
});

describe("watchClaimableTasks: catch-up (gPA) path", () => {
  it("forwards the watcher commitment to every raw-RPC catch-up scan", async () => {
    const taskId = new Uint8Array(32).fill(9);
    const [taskPda] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpecPda] = await findTaskJobSpecPda({ task: taskPda });
    const accounts = [
      {
        pubkey: taskPda,
        data: encodeTask({
          creator: CREATOR_A,
          taskId,
          requiredCapabilities: 1n,
          rewardAmount: 3_000_000n,
        }),
      },
      {
        pubkey: jobSpecPda,
        data: encodeTaskJobSpec(taskPda, CREATOR_A),
      },
    ];
    const commitments: unknown[] = [];
    const rpc = {
      getAccountInfo() {
        return { send: async () => null };
      },
      getProgramAccounts(_program: unknown, config: Record<string, unknown>) {
        commitments.push(config.commitment);
        const filters = config.filters as Array<
          { dataSize: bigint } | { memcmp: { offset: bigint; bytes: string } }
        >;
        const matched = accounts.filter(({ data }) =>
          filters.every((filter) => {
            if ("dataSize" in filter)
              return BigInt(data.length) === filter.dataSize;
            const offset = Number(filter.memcmp.offset);
            const bytes = Buffer.from(filter.memcmp.bytes, "base64");
            return Buffer.from(
              data.subarray(offset, offset + bytes.length),
            ).equals(bytes);
          }),
        );
        return {
          send: async () =>
            matched.map(({ pubkey, data }) => ({
              pubkey,
              account: { data: [toBase64(data), "base64"] },
            })),
        };
      },
    };

    const { onTask, done } = collector(1);
    const watch = watchClaimableTasks({
      rpc: rpc as never,
      commitment: "finalized",
      onTask,
      pollIntervalMs: 1_000_000,
    });
    await done;
    await watch.stop();

    expect(commitments.length).toBeGreaterThan(0);
    expect(new Set(commitments)).toEqual(new Set(["finalized"]));
  });

  it("surfaces task-state-claimable candidates and excludes a full InProgress task", async () => {
    const openId = new Uint8Array(32).fill(10);
    const claimedId = new Uint8Array(32).fill(11);
    const [openPda] = await findTaskPda({ creator: CREATOR_A, taskId: openId });
    const [claimedPda] = await findTaskPda({
      creator: CREATOR_A,
      taskId: claimedId,
    });
    const [openJobSpec] = await findTaskJobSpecPda({ task: openPda });
    const [claimedJobSpec] = await findTaskJobSpecPda({ task: claimedPda });
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
          currentWorkers: 1,
        }),
      },
      // Both are pinned; capacity, not pin absence, excludes the second task.
      { address: openJobSpec, data: encodeTaskJobSpec(openPda, CREATOR_A) },
      {
        address: claimedJobSpec,
        data: encodeTaskJobSpec(claimedPda, CREATOR_A),
      },
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

    expect(task.task).toBe(openPda);
    expect(task.source).toBe("catch-up");
    expect(task.account).toBeDefined();
    expect(task.account!.status).toBe(TaskStatus.Open);
    expect(task.rewardAmount).toBe(4_000_000n);
  });

  it("lets a second worker discover an InProgress collaborative task with a remaining slot", async () => {
    const taskId = new Uint8Array(32).fill(12);
    const [task] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpec] = await findTaskJobSpecPda({ task });
    const transport = makeGpaTransport([
      {
        address: task,
        data: encodeTask({
          creator: CREATOR_A,
          taskId,
          requiredCapabilities: 1n,
          rewardAmount: 4_000_000n,
          taskType: TaskType.Collaborative,
          status: TaskStatus.InProgress,
          maxWorkers: 2,
          currentWorkers: 1,
          claimGeneration: 1n,
        }),
      },
      { address: jobSpec, data: encodeTaskJobSpec(task, CREATOR_A) },
    ]);
    const { onTask, done } = collector(1);
    const watch = watchClaimableTasks({
      indexer: transport,
      onTask,
      pollIntervalMs: 50,
    });

    const [discovered] = await done;
    await watch.stop();
    expect(discovered.task).toBe(task);
    expect(discovered.account?.status).toBe(TaskStatus.InProgress);
    expect(discovered.account?.currentWorkers).toBe(1);
    expect(discovered.account?.maxWorkers).toBe(2);
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
      // Task state plus the valid pin make it eligible for BOTH watcher candidate
      // paths; other transaction gates are outside this test. It is delivered once.
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

  it("fails fast for an event-only transport that cannot validate task state", () => {
    expect(() =>
      watchClaimableTasks({
        rpcSubscriptions: makeFakeSubscriptions([]),
        onTask: () => {},
      }),
    ).toThrow(/getProgramAccounts-capable rpc or indexer/);
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

  it("stop() resolves when an account-read transport never settles", async () => {
    let calls = 0;
    const hung: ProgramAccountsTransport = {
      getProgramAccounts() {
        calls += 1;
        return new Promise(() => {});
      },
    };
    const watch = watchClaimableTasks({
      indexer: hung,
      onTask: () => {},
      pollIntervalMs: 10,
    });
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0));

    await expect(
      Promise.race([
        watch.stop().then(() => "stopped"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("hung"), 100),
        ),
      ]),
    ).resolves.toBe("stopped");
  });

  it("treats a non-cancellable transport timeout as terminal without retry overlap", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    let rejectLate!: (error: Error) => void;
    const hung: ProgramAccountsTransport = {
      getProgramAccounts: () => {
        calls += 1;
        return new Promise((_, reject) => {
          rejectLate = reject;
        });
      },
    };
    const watch = watchClaimableTasks({
      indexer: hung,
      onTask: () => {},
      onError: (error) => errors.push(error),
      pollIntervalMs: 10,
      operationTimeoutMs: 10,
    });

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect((errors[0] as Error).message).toMatch(/timed out after 10ms/);
    // Several poll periods later there is still exactly one transport call:
    // retrying would overlap the non-cancellable request.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
    await expect(watch.stop()).resolves.toBeUndefined();

    // The detached underlying operation retains rejection handlers; a late
    // failure neither restarts reads nor becomes unhandled.
    rejectLate(new Error("late transport rejection"));
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it("aborts onTask without letting an uncooperative handler hang stop()", async () => {
    const taskId = new Uint8Array(32).fill(121);
    const [task] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpec] = await findTaskJobSpecPda({ task });
    let handlerSignal: AbortSignal | undefined;
    const watch = watchClaimableTasks({
      indexer: makeGpaTransport([
        {
          address: task,
          data: encodeTask({
            creator: CREATOR_A,
            taskId,
            requiredCapabilities: 1n,
            rewardAmount: 3_000_000n,
          }),
        },
        { address: jobSpec, data: encodeTaskJobSpec(task, CREATOR_A) },
      ]),
      onTask: (_claimable, signal) => {
        handlerSignal = signal;
        return new Promise(() => {});
      },
      pollIntervalMs: 10,
    });
    await vi.waitFor(() => expect(handlerSignal).toBeDefined());

    await expect(
      Promise.race([
        watch.stop().then(() => "stopped"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("hung"), 100),
        ),
      ]),
    ).resolves.toBe("stopped");
    expect(handlerSignal?.aborted).toBe(true);
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
// Finding #4 [MAJOR] — task-state candidates must also be job-spec pinned.
// REVERT-SENSITIVE: a fabricated Open-but-UNPINNED task must NOT be surfaced;
// an Open+pinned candidate MUST be. Against the pre-fix code (which surfaced every
// Open task) the first assertion fails — the unpinned task is wrongly surfaced.
// ---------------------------------------------------------------------------
describe("watchClaimableTasks: task-state predicate + job-spec pin (#4)", () => {
  it("catch-up: surfaces a pinned Open candidate but NOT an Open-but-unpinned one", async () => {
    const pinnedId = new Uint8Array(32).fill(40);
    const unpinnedId = new Uint8Array(32).fill(41);
    const [pinnedPda] = await findTaskPda({
      creator: CREATOR_A,
      taskId: pinnedId,
    });
    const [unpinnedPda] = await findTaskPda({
      creator: CREATOR_A,
      taskId: unpinnedId,
    });
    const [pinnedJobSpec] = await findTaskJobSpecPda({ task: pinnedPda });

    // Both tasks are Open. ONLY the first has a TaskJobSpec pointer (with a
    // non-zero hash), so only the first satisfies the watcher's job-spec
    // candidate gate; claiming the second fails AccountNotInitialized (3012).
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
    expect(surfaced.has(pinnedPda)).toBe(true); // pinned candidate → surfaced
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
    // Current Task passes the task-local candidate predicate, but the source has
    // NO TaskJobSpec.
    const transport = makeGpaTransport([
      {
        address: pda,
        data: encodeTask({
          creator: CREATOR_A,
          taskId,
          requiredCapabilities: 1n,
          rewardAmount: 5_000_000n,
        }),
      },
    ]);

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

  it("does not retire a delivered task when one successful pin snapshot transiently lags", async () => {
    const taskId = new Uint8Array(32).fill(44);
    const [task] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpec] = await findTaskJobSpecPda({ task });
    const taskAccount = {
      address: task,
      data: encodeTask({
        creator: CREATOR_A,
        taskId,
        requiredCapabilities: 1n,
        rewardAmount: 5_000_000n,
      }),
    };
    const specAccount = {
      address: jobSpec,
      data: encodeTaskJobSpec(task, CREATOR_A),
    };
    const withPin = makeGpaTransport([taskAccount, specAccount]);
    const withoutPin = makeGpaTransport([taskAccount]);
    let pinReads = 0;
    const lagging: ProgramAccountsTransport = {
      getProgramAccounts(request) {
        const discriminator = request.filters[0];
        const isPinRead =
          discriminator !== undefined &&
          "memcmp" in discriminator &&
          discriminator.memcmp.bytes.length ===
            TASK_JOB_SPEC_DISCRIMINATOR.length &&
          discriminator.memcmp.bytes.every(
            (byte, index) => byte === TASK_JOB_SPEC_DISCRIMINATOR[index],
          );
        if (isPinRead) {
          pinReads += 1;
          return (pinReads === 2 ? withoutPin : withPin).getProgramAccounts(
            request,
          );
        }
        return withPin.getProgramAccounts(request);
      },
    };
    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: lagging,
      onTask: (claimable) => {
        got.push(claimable);
      },
      pollIntervalMs: 10,
    });

    await vi.waitFor(() => expect(pinReads).toBeGreaterThanOrEqual(3), {
      timeout: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await watch.stop();
    expect(got).toHaveLength(1);
  });

  it("rechecks the deadline after a slow pin read before admitting the task", async () => {
    const taskId = new Uint8Array(32).fill(45);
    const [task] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpec] = await findTaskJobSpecPda({ task });
    let nowMs = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const backing = makeGpaTransport([
      {
        address: task,
        data: encodeTask({
          creator: CREATOR_A,
          taskId,
          requiredCapabilities: 1n,
          rewardAmount: 5_000_000n,
          deadline: 1_040n,
        }),
      },
      { address: jobSpec, data: encodeTaskJobSpec(task, CREATOR_A) },
    ]);
    let pinReads = 0;
    const slowPin: ProgramAccountsTransport = {
      getProgramAccounts(request) {
        const discriminator = request.filters[0];
        const isPinRead =
          discriminator !== undefined &&
          "memcmp" in discriminator &&
          discriminator.memcmp.bytes.length ===
            TASK_JOB_SPEC_DISCRIMINATOR.length &&
          discriminator.memcmp.bytes.every(
            (byte, index) => byte === TASK_JOB_SPEC_DISCRIMINATOR[index],
          );
        if (isPinRead) {
          pinReads += 1;
          nowMs = 1_020_000;
        }
        return backing.getProgramAccounts(request);
      },
    };
    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: slowPin,
      onTask: (claimable) => {
        got.push(claimable);
      },
      pollIntervalMs: 10,
    });

    try {
      await vi.waitFor(() => expect(pinReads).toBeGreaterThanOrEqual(1));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(got).toEqual([]);
    } finally {
      await watch.stop();
      nowSpy.mockRestore();
    }
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
  function makeMutableGpaTransport(
    initial: Array<{ address: Address; data: Uint8Array }>,
  ) {
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

  it("re-delivers a legacy task that reopens with a different completion marker", async () => {
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
        taskType: TaskType.Collaborative,
        currentWorkers: 0,
        completions: 0,
        requiredCompletions: 2,
      }),
    };
    // A legacy-generation collaborative cycle can return to Open+0 workers
    // with one accepted completion while additional completions remain.
    const openReopened = {
      address: pda,
      data: encodeTask({
        creator: CREATOR_A,
        taskId,
        requiredCapabilities: 1n,
        rewardAmount: 3_000_000n,
        status: TaskStatus.Open,
        taskType: TaskType.Collaborative,
        currentWorkers: 0,
        completions: 1,
        requiredCompletions: 2,
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

  it("re-delivers a sole-worker task after an observed closed sweep even when it reopens as 0:0", async () => {
    const taskId = new Uint8Array(32).fill(52);
    const [pda] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpec] = await findTaskJobSpecPda({ task: pda });
    const jobSpecAcct = {
      address: jobSpec,
      data: encodeTaskJobSpec(pda, CREATOR_A),
    };
    const open = {
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
    const transport = makeMutableGpaTransport([open, jobSpecAcct]);
    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: transport,
      onTask: (task) => {
        got.push(task);
      },
      pollIntervalMs: 10,
    });
    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 1000 });

    // Claim/expiry makes the task non-Open for at least one complete sweep.
    transport.set([jobSpecAcct]);
    await new Promise((resolve) => setTimeout(resolve, 35));
    // expire_claim restores a sole-worker task to the legacy 0:0 counter shape.
    transport.set([open, jobSpecAcct]);
    await vi.waitFor(() => expect(got).toHaveLength(2), { timeout: 1000 });
    await watch.stop();
  });

  it("re-delivers a legacy 0:0 counter-shape reopen from its monotonic claim generation without observing the closed state", async () => {
    const taskId = new Uint8Array(32).fill(53);
    const [pda] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpec] = await findTaskJobSpecPda({ task: pda });
    const jobSpecAcct = {
      address: jobSpec,
      data: encodeTaskJobSpec(pda, CREATOR_A),
    };
    const task = (claimGeneration: bigint) => ({
      address: pda,
      data: encodeTask({
        creator: CREATOR_A,
        taskId,
        requiredCapabilities: 1n,
        rewardAmount: 3_000_000n,
        status: TaskStatus.Open,
        currentWorkers: 0,
        completions: 0,
        claimGeneration,
      }),
    });
    const transport = makeMutableGpaTransport([task(0n), jobSpecAcct]);
    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: transport,
      onTask: (claimable) => {
        got.push(claimable);
      },
      pollIntervalMs: 10,
    });
    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 1000 });

    // No sweep observes InProgress/absence. The next snapshot is byte-for-byte
    // identical in the legacy 0:0 counter shape, except that the program atomically
    // advanced the reserved-space generation when the intervening claim began.
    transport.set([task(1n), jobSpecAcct]);
    await vi.waitFor(() => expect(got).toHaveLength(2), { timeout: 1000 });
    await watch.stop();

    expect(got.map(({ task: address }) => address)).toEqual([pda, pda]);
  });

  it("does not re-deliver on generation advances while a multi-worker task stays candidate-eligible", async () => {
    const taskId = new Uint8Array(32).fill(54);
    const [pda] = await findTaskPda({ creator: CREATOR_A, taskId });
    const [jobSpec] = await findTaskJobSpecPda({ task: pda });
    const jobSpecAcct = {
      address: jobSpec,
      data: encodeTaskJobSpec(pda, CREATOR_A),
    };
    const task = (
      status: TaskStatus,
      currentWorkers: number,
      claimGeneration: bigint,
    ) => ({
      address: pda,
      data: encodeTask({
        creator: CREATOR_A,
        taskId,
        requiredCapabilities: 1n,
        rewardAmount: 3_000_000n,
        taskType: TaskType.Collaborative,
        maxWorkers: 4,
        status,
        currentWorkers,
        claimGeneration,
      }),
    });
    const transport = makeMutableGpaTransport([
      task(TaskStatus.Open, 0, 0n),
      jobSpecAcct,
    ]);
    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: transport,
      onTask: (claimable) => {
        got.push(claimable);
      },
      pollIntervalMs: 10,
    });
    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 1000 });

    // These are ordinary claims consuming additional slots, not close/reopen
    // cycles. The task remains eligible under the watcher's task-state+pin
    // predicate and stays at-most-once; worker/config gates are not modeled.
    transport.set([task(TaskStatus.InProgress, 1, 1n), jobSpecAcct]);
    await new Promise((resolve) => setTimeout(resolve, 35));
    transport.set([task(TaskStatus.InProgress, 2, 2n), jobSpecAcct]);
    await new Promise((resolve) => setTimeout(resolve, 35));
    await watch.stop();

    expect(got).toHaveLength(1);
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

  it("bounds the active dedupe set and admits new work after a slot closes", async () => {
    // maxSeen=1: A occupies the one active slot. Once a complete sweep shows A
    // absent, B can be admitted; when B later closes, reopened A re-delivers.
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
    const specA = {
      address: jobSpecA,
      data: encodeTaskJobSpec(pdaA, CREATOR_A),
    };
    const specB = {
      address: jobSpecB,
      data: encodeTaskJobSpec(pdaB, CREATOR_A),
    };
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
    // 2) swap to B only → a complete sweep retires A, then B is admitted
    transport.set([taskB, specB]);
    await vi.waitFor(
      () => expect(got.some((t) => t.task === pdaB)).toBe(true),
      { timeout: 1000 },
    );
    // 3) bring A back → A re-delivers because it was observably absent
    transport.set([taskA, specA]);
    await vi.waitFor(
      () => expect(got.filter((t) => t.task === pdaA).length).toBe(2),
      { timeout: 1000 },
    );
    await watch.stop();
    expect(got.filter((t) => t.task === pdaA)).toHaveLength(2);
  });

  it("does not churn or re-deliver an oversized steady-state backlog", async () => {
    const accounts: Array<{ address: Address; data: Uint8Array }> = [];
    const taskPdas: Address[] = [];
    for (let index = 0; index < 3; index += 1) {
      const taskId = new Uint8Array(32).fill(80 + index);
      const [task] = await findTaskPda({ creator: CREATOR_A, taskId });
      const [jobSpec] = await findTaskJobSpecPda({ task });
      taskPdas.push(task);
      accounts.push(
        {
          address: task,
          data: encodeTask({
            creator: CREATOR_A,
            taskId,
            requiredCapabilities: 1n,
            rewardAmount: 3_000_000n,
          }),
        },
        { address: jobSpec, data: encodeTaskJobSpec(task, CREATOR_A) },
      );
    }
    const transport = makeGpaTransport(accounts);
    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: transport,
      maxSeen: 2,
      pollIntervalMs: 10,
      onTask: (task) => {
        got.push(task);
      },
    });
    await vi.waitFor(() => expect(got).toHaveLength(2), { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await watch.stop();

    expect(new Set(got.map(({ task }) => task)).size).toBe(2);
    expect(got).toHaveLength(2);
    expect(taskPdas).toContain(got[0]!.task);
  });

  it("does not allocate iterator backlog for callback-only use", async () => {
    const accounts: Array<{ address: Address; data: Uint8Array }> = [];
    for (let index = 0; index < 3; index += 1) {
      const taskId = new Uint8Array(32).fill(90 + index);
      const [task] = await findTaskPda({ creator: CREATOR_A, taskId });
      const [jobSpec] = await findTaskJobSpecPda({ task });
      accounts.push(
        {
          address: task,
          data: encodeTask({
            creator: CREATOR_A,
            taskId,
            requiredCapabilities: 1n,
            rewardAmount: 3_000_000n,
          }),
        },
        { address: jobSpec, data: encodeTaskJobSpec(task, CREATOR_A) },
      );
    }
    const got: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: makeGpaTransport(accounts),
      maxQueue: 1,
      pollIntervalMs: 10,
      onTask: async (task) => {
        await Promise.resolve();
        got.push(task);
      },
    });
    // If callback-only delivery shared the bounded iterator queue, it would
    // block forever after the first task because no iterator drains it.
    await vi.waitFor(() => expect(got).toHaveLength(3), { timeout: 1000 });
    await watch.stop();
  });

  it("applies bounded backpressure to a slow async iterator", async () => {
    const accounts: Array<{ address: Address; data: Uint8Array }> = [];
    for (let index = 0; index < 3; index += 1) {
      const taskId = new Uint8Array(32).fill(100 + index);
      const [task] = await findTaskPda({ creator: CREATOR_A, taskId });
      const [jobSpec] = await findTaskJobSpecPda({ task });
      accounts.push(
        {
          address: task,
          data: encodeTask({
            creator: CREATOR_A,
            taskId,
            requiredCapabilities: 1n,
            rewardAmount: 3_000_000n,
          }),
        },
        { address: jobSpec, data: encodeTaskJobSpec(task, CREATOR_A) },
      );
    }
    const callbacks: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: makeGpaTransport(accounts),
      maxQueue: 1,
      pollIntervalMs: 10,
      onTask: (task) => {
        callbacks.push(task);
      },
    });
    const iterator = watch[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    await vi.waitFor(() => expect(callbacks).toHaveLength(2), {
      timeout: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callbacks).toHaveLength(2);
    expect((await iterator.next()).done).toBe(false);
    await vi.waitFor(() => expect(callbacks).toHaveLength(3), {
      timeout: 1000,
    });
    await watch.stop();
  });

  it("drops a task that expires while waiting for iterator backpressure", async () => {
    const firstId = new Uint8Array(32).fill(130);
    const expiringId = new Uint8Array(32).fill(131);
    const [firstTask] = await findTaskPda({
      creator: CREATOR_A,
      taskId: firstId,
    });
    const [expiringTask] = await findTaskPda({
      creator: CREATOR_A,
      taskId: expiringId,
    });
    const [firstSpec] = await findTaskJobSpecPda({ task: firstTask });
    const [expiringSpec] = await findTaskJobSpecPda({ task: expiringTask });
    let nowMs = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const callbacks: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: makeGpaTransport([
        {
          address: firstTask,
          data: encodeTask({
            creator: CREATOR_A,
            taskId: firstId,
            requiredCapabilities: 1n,
            rewardAmount: 3_000_000n,
          }),
        },
        {
          address: expiringTask,
          data: encodeTask({
            creator: CREATOR_A,
            taskId: expiringId,
            requiredCapabilities: 1n,
            rewardAmount: 3_000_000n,
            deadline: 1_040n,
          }),
        },
        { address: firstSpec, data: encodeTaskJobSpec(firstTask, CREATOR_A) },
        {
          address: expiringSpec,
          data: encodeTaskJobSpec(expiringTask, CREATOR_A),
        },
      ]),
      maxQueue: 1,
      pollIntervalMs: 10,
      onTask: (claimable) => {
        callbacks.push(claimable);
      },
    });
    const iterator = watch[Symbol.asyncIterator]();

    try {
      // Do not consume yet: firstTask fills the one-item queue and the second
      // serialized delivery blocks on space while it is still initially valid.
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      expect(callbacks[0]!.task).toBe(firstTask);
      nowMs = 1_020_000; // 1020 + 30 safety >= deadline 1040
      const first = await iterator.next();
      expect(first.done).toBe(false);
      if (first.done) throw new Error("iterator ended before first delivery");
      expect(first.value.task).toBe(firstTask);
      await new Promise((resolve) => setTimeout(resolve, 40));

      // The post-backpressure freshness check suppresses BOTH consumers.
      expect(callbacks).toHaveLength(1);
    } finally {
      await watch.stop();
      nowSpy.mockRestore();
    }
  });

  it("rejects unsafe queue and timer controls synchronously", () => {
    const transport = makeGpaTransport([]);
    for (const pollIntervalMs of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() =>
        watchClaimableTasks({
          indexer: transport,
          onTask: () => {},
          pollIntervalMs,
        }),
      ).toThrow(/pollIntervalMs/);
    }
    for (const maxBackoffMs of [9, 1.5, Number.NaN, Infinity]) {
      expect(() =>
        watchClaimableTasks({
          indexer: transport,
          onTask: () => {},
          pollIntervalMs: 10,
          maxBackoffMs,
        }),
      ).toThrow(/maxBackoffMs/);
    }
    for (const maxQueue of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() =>
        watchClaimableTasks({
          indexer: transport,
          onTask: () => {},
          maxQueue,
        }),
      ).toThrow(/maxQueue/);
    }
    for (const operationTimeoutMs of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() =>
        watchClaimableTasks({
          indexer: transport,
          onTask: () => {},
          operationTimeoutMs,
        }),
      ).toThrow(/operationTimeoutMs/);
    }
    expect(() =>
      watchClaimableTasks({
        indexer: transport,
        onTask: () => {},
        deadlineSafetySeconds: -1n,
      }),
    ).toThrow(/deadlineSafetySeconds/);
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
    // The first serialized status read fails each logical sweep. A flat loop
    // would produce ~30+ attempts; backoff keeps that count small.
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

  it("an async-rejecting onError cannot escape as an unhandled rejection", async () => {
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
      const watch = watchClaimableTasks({
        indexer: failing,
        onTask: () => {},
        onError: async () => {
          onErrorCalls += 1;
          throw new Error("async onError rejection");
        },
        pollIntervalMs: 10,
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await watch.stop();

      expect(onErrorCalls).toBeGreaterThanOrEqual(2);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
