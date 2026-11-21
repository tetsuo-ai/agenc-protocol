// Revision 9 (C): close_task compacts a finished Task into a 56-byte
// TaskMarker at the same address. These tests pin the client side: reading a
// task by address, the moderation record's rent recipient, the close_task
// wire, and the readers that must not crash on a marker.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AccountRole,
  address,
  createNoopSigner,
  type Address,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findCreatorCompletionBondPda,
  findEscrowPda,
  findHireRecordPda,
  findTaskJobSpecPda,
  getTaskEncoder,
  getTaskMarkerEncoder,
  getTaskMarkerSize,
  TASK_MARKER_DISCRIMINATOR,
  TaskStatus,
  TaskType,
  waitForTaskStatus,
  type TaskArgs,
} from "../src/index.js";
import {
  closeTask,
  decodeTaskAccount,
  readTask,
  readTurnDown,
  taskModerationRentRecipient,
  TASK_MARKER_FLAG_ENDED_LIVE_HIRE,
  TASK_MARKER_FLAG_FEE_QUALIFIED,
  type ProgramAccountSnapshot,
} from "../src/facade/index.js";
import {
  MAX_REVIEW_WINDOW_SECS,
  assertCreatorReviewWindow,
} from "../src/values/index.js";

const PROGRAM = AGENC_COORDINATION_PROGRAM_ADDRESS;
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const CREATOR = address("BPFLoaderUpgradeab1e11111111111111111111111");
const MODERATOR = address("Stake11111111111111111111111111111111111111");
const TASK = address("SysvarRent111111111111111111111111111111111");
const WORKER_AGENT = address("Vote111111111111111111111111111111111111111");
const NONE = { __option: "None" } as const;

function taskArgs(overrides: Partial<TaskArgs> = {}): TaskArgs {
  return {
    taskId: new Uint8Array(32).fill(1),
    creator: CREATOR,
    requiredCapabilities: 0n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 100_000_000n,
    maxWorkers: 1,
    currentWorkers: 0,
    status: TaskStatus.Completed,
    taskType: TaskType.Exclusive,
    createdAt: 0n,
    deadline: 0n,
    completedAt: 0n,
    escrow: SYSTEM_PROGRAM,
    result: new Uint8Array(64),
    completions: 1,
    requiredCompletions: 1,
    bump: 255,
    protocolFeeBps: 500,
    dependsOn: NONE,
    dependencyType: 0,
    minReputation: 0,
    rewardMint: NONE,
    operator: SYSTEM_PROGRAM,
    operatorFeeBps: 0,
    referrer: SYSTEM_PROGRAM,
    referrerFeeBps: 0,
    reserved: new Uint8Array(16),
    ...overrides,
  } as TaskArgs;
}

function markerBytes(status: number, flags: number): Uint8Array {
  return new Uint8Array(
    getTaskMarkerEncoder().encode({
      creator: CREATOR,
      status,
      flags,
      closedAt: 1_800_000_000n,
      reserved: new Uint8Array(6),
    }),
  );
}

function programAccount(data: Uint8Array): ProgramAccountSnapshot {
  return { owner: PROGRAM, data };
}

describe("TaskMarker layout", () => {
  it("is the IDL's 56-byte account with discriminator c10bc0c833d06cff", () => {
    expect(getTaskMarkerSize()).toBe(56);
    expect(
      Array.from(TASK_MARKER_DISCRIMINATOR, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ).toBe("c10bc0c833d06cff");
    const bytes = markerBytes(TaskStatus.Completed, 3);
    expect(bytes).toHaveLength(56);
    // creator at 8, status at 40, flags at 41, closed_at at 42.
    expect(bytes[40]).toBe(TaskStatus.Completed);
    expect(bytes[41]).toBe(3);
  });
});

describe("decodeTaskAccount and readTask", () => {
  it("reads a live Task as a task", () => {
    const read = decodeTaskAccount(
      programAccount(new Uint8Array(getTaskEncoder().encode(taskArgs()))),
    );
    expect(read.kind).toBe("task");
    if (read.kind !== "task") throw new Error("unreachable");
    expect(read.task.creator).toBe(CREATOR);
    expect(read.task.status).toBe(TaskStatus.Completed);
  });

  it("reads a compacted task as closed, with its status and flags", () => {
    const paidHire = decodeTaskAccount(
      programAccount(
        markerBytes(
          TaskStatus.Completed,
          TASK_MARKER_FLAG_ENDED_LIVE_HIRE | TASK_MARKER_FLAG_FEE_QUALIFIED,
        ),
      ),
    );
    expect(paidHire).toMatchObject({
      kind: "closed",
      status: "completed",
      endedLiveHire: true,
      feeQualified: true,
      marker: { creator: CREATOR, closedAt: 1_800_000_000n },
    });
    const cancelled = decodeTaskAccount(
      programAccount(markerBytes(TaskStatus.Cancelled, 0)),
    );
    expect(cancelled).toMatchObject({
      kind: "closed",
      status: "cancelled",
      endedLiveHire: false,
      feeQualified: false,
    });
  });

  it("treats no account, an empty one and a system or foreign owned one as missing", () => {
    expect(decodeTaskAccount(null)).toEqual({ kind: "missing" });
    expect(
      decodeTaskAccount({ owner: PROGRAM, data: new Uint8Array() }),
    ).toEqual({ kind: "missing" });
    // Anyone can send lamports to a task's address.
    expect(
      decodeTaskAccount({
        owner: SYSTEM_PROGRAM,
        data: markerBytes(TaskStatus.Completed, 0),
      }),
    ).toEqual({ kind: "missing" });
  });

  it("refuses another program account and a marker the program could not write", () => {
    // Some other program account (its discriminator is neither).
    const other = new Uint8Array(121).fill(7);
    expect(() => decodeTaskAccount(programAccount(other))).toThrow(
      /neither a Task nor a TaskMarker/,
    );
    expect(() =>
      decodeTaskAccount(programAccount(markerBytes(TaskStatus.InProgress, 0))),
    ).toThrow(/not Completed or Cancelled/);
  });

  it("readTask goes through the account reader", async () => {
    const accounts = new Map<Address, ProgramAccountSnapshot>([
      [TASK, programAccount(markerBytes(TaskStatus.Completed, 0))],
    ]);
    const read = async (account: Address) => accounts.get(account) ?? null;
    expect((await readTask(read, TASK)).kind).toBe("closed");
    expect((await readTask(read, CREATOR)).kind).toBe("missing");
  });

  it("readTurnDown reports a closed task as no turn-down instead of throwing", async () => {
    const read = async () =>
      programAccount(markerBytes(TaskStatus.Cancelled, 0));
    await expect(
      readTurnDown(read, { task: TASK, worker: WORKER_AGENT }),
    ).resolves.toBeNull();
  });

  it("waitForTaskStatus fails at once with a clear message on a marker", async () => {
    const data = Buffer.from(markerBytes(TaskStatus.Completed, 0)).toString(
      "base64",
    );
    const rpc = {
      getAccountInfo: () => ({
        send: async () => ({ value: { data: [data, "base64"] } }),
      }),
    };
    await expect(
      waitForTaskStatus(rpc as never, TASK, TaskStatus.Completed, {
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/was closed \(compacted to a TaskMarker with status Completed\)/);
  });
});

describe("taskModerationRentRecipient", () => {
  const record = (role: number) => ({
    creator: CREATOR,
    moderator: MODERATOR,
    reserved: Uint8Array.from([role, 0, 0, 0, 0, 0, 0]),
  });

  it("returns the creator only for a creator-paid record", () => {
    expect(taskModerationRentRecipient(record(1))).toBe(CREATOR);
    // Records from before revision 9 hold 0; values above 1 cannot be
    // written by the program and route to the moderator, as on chain.
    expect(taskModerationRentRecipient(record(0))).toBe(MODERATOR);
    expect(taskModerationRentRecipient(record(2))).toBe(MODERATOR);
  });
});

describe("closeTask wire (revision 9)", () => {
  const authority = createNoopSigner(CREATOR);

  it("derives the creator bond from the signer and leaves the escrow out by default", async () => {
    const ix = await closeTask({ task: TASK, authority });
    const [bond] = await findCreatorCompletionBondPda({
      task: TASK,
      creator: CREATOR,
    });
    const [jobSpec] = await findTaskJobSpecPda({ task: TASK });
    const [hire] = await findHireRecordPda({ task: TASK });
    expect(ix.accounts.map((account) => account.address)).toEqual([
      TASK,
      jobSpec,
      PROGRAM,
      hire,
      PROGRAM,
      bond,
      PROGRAM,
      CREATOR,
      expect.any(String),
    ]);
    expect(ix.accounts[0]!.role).toBe(AccountRole.WRITABLE);
    expect(ix.accounts[2]!.role).toBe(AccountRole.READONLY);
    expect(ix.accounts[5]!.role).toBe(AccountRole.READONLY);
  });

  it("passes the canonical escrow for a token task, and an explicit escrow wins", async () => {
    const [escrow] = await findEscrowPda({ task: TASK });
    const token = await closeTask({ task: TASK, authority, tokenEscrow: true });
    expect(token.accounts[2]).toEqual({
      address: escrow,
      role: AccountRole.WRITABLE,
    });
    const explicit = await closeTask({
      task: TASK,
      authority,
      tokenEscrow: true,
      escrow: MODERATOR,
    });
    expect(explicit.accounts[2]).toEqual({
      address: MODERATOR,
      role: AccountRole.WRITABLE,
    });
  });

  it("sweeps a moderation record to the recipient its payer flag names", async () => {
    const recordAddress = address("SysvarC1ock11111111111111111111111111111111");
    const ix = await closeTask({
      task: TASK,
      authority,
      taskJobSpec: null,
      children: [
        {
          kind: "namedRecipient",
          account: recordAddress,
          recipient: taskModerationRentRecipient({
            creator: CREATOR,
            moderator: MODERATOR,
            reserved: Uint8Array.from([1, 0, 0, 0, 0, 0, 0]),
          }),
        },
      ],
    });
    expect(ix.accounts.slice(9)).toEqual([
      { address: recordAddress, role: AccountRole.WRITABLE },
      { address: CREATOR, role: AccountRole.WRITABLE },
    ]);
  });
});

describe("review window bound", () => {
  it("mirrors MAX_REVIEW_WINDOW_SECS in the program", () => {
    const source = readFileSync(
      new URL(
        "../../../programs/agenc-coordination/src/instructions/task_validation_helpers.rs",
        import.meta.url,
      ),
      "utf8",
    );
    const match = source.match(
      /pub const MAX_REVIEW_WINDOW_SECS: i64 = ([0-9_]+);/u,
    );
    expect(match).not.toBeNull();
    expect(BigInt(match![1]!.replaceAll("_", ""))).toBe(MAX_REVIEW_WINDOW_SECS);
  });

  it("accepts 1 second to 7 days only", () => {
    expect(() => assertCreatorReviewWindow(1, "t")).not.toThrow();
    expect(() => assertCreatorReviewWindow(604_800n, "t")).not.toThrow();
    expect(() => assertCreatorReviewWindow(0, "t")).toThrow(RangeError);
    expect(() => assertCreatorReviewWindow(604_801n, "t")).toThrow(RangeError);
    expect(() => assertCreatorReviewWindow(Number.NaN, "t")).toThrow(
      /whole number/,
    );
  });
});
