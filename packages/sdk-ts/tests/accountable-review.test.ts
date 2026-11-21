// Revision 9 (accountable review): the client mirrors of the claim deposit and
// dispute bond math, the windows, the freeze kind, and the turn-down readers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { address, type Address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findClaimPda,
  findCreatorStatsPda,
  findDisputeRejectionDisputeBondPda,
  findTaskSubmissionPda,
  getCreatorStatsEncoder,
  getDisputeBondEncoder,
  getTaskEncoder,
  getTaskSubmissionEncoder,
  SubmissionStatus,
  TaskStatus,
  TaskType,
  type CreatorStatsArgs,
  type DisputeBondArgs,
  type TaskArgs,
  type TaskSubmissionArgs,
} from "../src/index.js";
import {
  CLAIM_DEPOSIT_BPS,
  CLAIM_RELEASE_GRACE_SECS,
  DISPUTE_BOND_BPS,
  FREEZE_KIND_DISPUTABLE,
  MIN_CLAIM_DEPOSIT_LAMPORTS,
  MIN_DISPUTE_BOND_LAMPORTS,
  MIN_RESUBMIT_WINDOW_SECS,
  REJECT_DISPUTE_WINDOW_SECS,
  REJECT_RULING_WINDOW_SECS,
  claimDepositForTask,
  claimDepositLamports,
  disputeBondForTask,
  disputeBondLamports,
  isDisputableFreeze,
  submissionFreezeKind,
  workerShareLamports,
} from "../src/values/index.js";
import {
  decodeCreatorStats,
  decodeDisputeBond,
  getCreatorTrackRecord,
  readTurnDown,
  turnDownExpiryPaysWorker,
  turnDownStage,
  type ProgramAccountSnapshot,
} from "../src/facade/turn-downs.js";

const SOL = 1_000_000_000n;
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const CREATOR = address("BPFLoaderUpgradeab1e11111111111111111111111");
const WORKER_AGENT = address("Stake11111111111111111111111111111111111111");
const WORKER_WALLET = address("Vote111111111111111111111111111111111111111");
const TASK = address("SysvarRent111111111111111111111111111111111");
const NONE = { __option: "None" } as const;

function constant(source: string, name: string): bigint {
  // The production value is the first definition (the `validation-timings`
  // build redefines the windows after it).
  const match = source.match(
    new RegExp(`pub const ${name}: [ui]\\d+ = ([0-9_]+);`, "u"),
  );
  expect(match, name).not.toBeNull();
  return BigInt(match![1]!.replaceAll("_", ""));
}

describe("revision 9 constants mirror the program", () => {
  it("match programs/agenc-coordination/src/instructions/constants.rs", () => {
    const source = readFileSync(
      new URL(
        "../../../programs/agenc-coordination/src/instructions/constants.rs",
        import.meta.url,
      ),
      "utf8",
    );
    expect(constant(source, "CLAIM_DEPOSIT_BPS")).toBe(CLAIM_DEPOSIT_BPS);
    expect(constant(source, "MIN_CLAIM_DEPOSIT_LAMPORTS")).toBe(
      MIN_CLAIM_DEPOSIT_LAMPORTS,
    );
    expect(constant(source, "DISPUTE_BOND_BPS")).toBe(DISPUTE_BOND_BPS);
    expect(constant(source, "MIN_DISPUTE_BOND_LAMPORTS")).toBe(
      MIN_DISPUTE_BOND_LAMPORTS,
    );
    expect(constant(source, "REJECT_DISPUTE_WINDOW_SECS")).toBe(
      REJECT_DISPUTE_WINDOW_SECS,
    );
    expect(constant(source, "REJECT_RULING_WINDOW_SECS")).toBe(
      REJECT_RULING_WINDOW_SECS,
    );
    expect(constant(source, "MIN_RESUBMIT_WINDOW_SECS")).toBe(
      MIN_RESUBMIT_WINDOW_SECS,
    );
    expect(constant(source, "CLAIM_RELEASE_GRACE_SECS")).toBe(
      CLAIM_RELEASE_GRACE_SECS,
    );
    expect(BigInt(FREEZE_KIND_DISPUTABLE)).toBe(
      constant(source, "FREEZE_KIND_DISPUTABLE"),
    );
  });

  it("states the owner's numbers: 72 h windows, 1 h release grace, 24 h resubmit floor", () => {
    expect(REJECT_DISPUTE_WINDOW_SECS).toBe(72n * 3600n);
    expect(REJECT_RULING_WINDOW_SECS).toBe(72n * 3600n);
    expect(CLAIM_RELEASE_GRACE_SECS).toBe(3600n);
    expect(MIN_RESUBMIT_WINDOW_SECS).toBe(24n * 3600n);
    expect(MIN_CLAIM_DEPOSIT_LAMPORTS).toBe(SOL / 200n); // 0.005 SOL
    expect(MIN_DISPUTE_BOND_LAMPORTS).toBe(SOL / 100n); // 0.01 SOL
  });
});

describe("claim deposit and dispute bond math", () => {
  const sol = (rewardAmount: bigint) => ({
    rewardAmount,
    taskType: TaskType.Exclusive,
    requiredCompletions: 1,
    rewardMint: NONE,
  });

  it("takes 10% of the worker's share with the floors (design 1.4 and 5.4 numbers)", () => {
    // P = 0.1 SOL: deposit 10,000,000; bond 10,000,000.
    expect(claimDepositForTask(sol(100_000_000n))).toBe(10_000_000n);
    expect(disputeBondForTask(sol(100_000_000n))).toBe(10_000_000n);
    // P = 0.005 SOL: the floors (deposit 100% of the price, bond twice it).
    expect(claimDepositForTask(sol(5_000_000n))).toBe(5_000_000n);
    expect(disputeBondForTask(sol(5_000_000n))).toBe(10_000_000n);
    // P = 0.2 SOL: above both floors.
    expect(claimDepositForTask(sol(200_000_000n))).toBe(20_000_000n);
    expect(disputeBondForTask(sol(200_000_000n))).toBe(20_000_000n);
    // Exactly at the floors' crossover and one lamport around them.
    expect(claimDepositLamports(50_000_000n)).toBe(5_000_000n);
    expect(claimDepositLamports(50_000_010n)).toBe(5_000_001n);
    expect(disputeBondLamports(100_000_009n)).toBe(10_000_000n);
    expect(disputeBondLamports(100_000_010n)).toBe(10_000_001n);
  });

  it("uses the Collaborative share, rounded down, and the floors for token rewards", () => {
    const collaborative = {
      rewardAmount: 400_000_003n,
      taskType: TaskType.Collaborative,
      requiredCompletions: 4,
      rewardMint: NONE,
    };
    expect(workerShareLamports(collaborative)).toBe(100_000_000n);
    expect(claimDepositForTask(collaborative)).toBe(10_000_000n);
    expect(disputeBondForTask(collaborative)).toBe(10_000_000n);
    // A zero completion count reads as one part, like the program.
    expect(
      workerShareLamports({ ...collaborative, requiredCompletions: 0 }),
    ).toBe(400_000_003n);

    const token = {
      rewardAmount: 9_000_000_000n,
      taskType: TaskType.Exclusive,
      requiredCompletions: 1,
      rewardMint: { __option: "Some", value: TASK } as const,
    };
    expect(workerShareLamports(token)).toBe(0n);
    expect(claimDepositForTask(token)).toBe(MIN_CLAIM_DEPOSIT_LAMPORTS);
    expect(disputeBondForTask(token)).toBe(MIN_DISPUTE_BOND_LAMPORTS);
  });

  it("charges no second deposit on a contest claim", () => {
    expect(claimDepositForTask(sol(100_000_000n), { contest: true })).toBe(0n);
  });

  it("refuses values that are not u64 lamports", () => {
    expect(() => claimDepositLamports(-1n)).toThrow(RangeError);
    expect(() => disputeBondLamports(1n << 64n)).toThrow(RangeError);
  });
});

describe("freeze kind", () => {
  it("reads TaskSubmission.reserved[2]", () => {
    expect(submissionFreezeKind({ reserved: [0, 0, 1, 0, 0] })).toBe(1);
    expect(isDisputableFreeze({ reserved: [0, 0, 1, 0, 0] })).toBe(true);
    expect(isDisputableFreeze({ reserved: [9, 9, 0, 0, 0] })).toBe(false);
    expect(isDisputableFreeze({ reserved: [] })).toBe(false);
  });
});

describe("turn-down stage", () => {
  const deadline = 1_000_000n;
  const rulingDeadline = 2_000_000n;
  const bond = {
    bond: TASK,
    amount: 10_000_000n,
    filer: WORKER_WALLET,
    respondent: CREATOR,
    filedAt: deadline,
    rulingDeadline,
  };

  it("is inclusive at the last second of each window, as on chain", () => {
    const undisputed = { disputable: true, reviewDeadlineAt: deadline, dispute: null };
    expect(turnDownStage(undisputed, deadline - 1n)).toBe("dispute_window");
    expect(turnDownStage(undisputed, deadline)).toBe("dispute_window");
    expect(turnDownStage(undisputed, deadline + 1n)).toBe("refund_due");

    const disputed = { disputable: true, reviewDeadlineAt: deadline, dispute: bond };
    expect(turnDownStage(disputed, rulingDeadline)).toBe("awaiting_ruling");
    expect(turnDownStage(disputed, rulingDeadline + 1n)).toBe(
      "unruled_refund_due",
    );

    const legacy = { disputable: false, reviewDeadlineAt: deadline, dispute: null };
    expect(turnDownStage(legacy, Number(deadline))).toBe("legacy_review");
    expect(turnDownStage(legacy, deadline + 1n)).toBe("legacy_payout_due");
  });

  it("pays the worker on expiry only for a revision 8 freeze", () => {
    expect(turnDownExpiryPaysWorker("legacy_payout_due")).toBe(true);
    for (const stage of [
      "dispute_window",
      "refund_due",
      "awaiting_ruling",
      "unruled_refund_due",
      "legacy_review",
    ] as const) {
      expect(turnDownExpiryPaysWorker(stage)).toBe(false);
    }
  });
});

function taskArgs(overrides: Partial<TaskArgs> = {}): TaskArgs {
  return {
    taskId: new Uint8Array(32).fill(1),
    creator: CREATOR,
    requiredCapabilities: 0n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 100_000_000n,
    maxWorkers: 1,
    currentWorkers: 1,
    status: TaskStatus.RejectFrozen,
    taskType: TaskType.Exclusive,
    createdAt: 0n,
    deadline: 0n,
    completedAt: 0n,
    escrow: SYSTEM_PROGRAM,
    result: new Uint8Array(64),
    completions: 0,
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

function submissionArgs(
  claim: Address,
  freezeKind: number,
  reviewDeadlineAt: bigint,
): TaskSubmissionArgs {
  const reserved = new Uint8Array(5);
  reserved[2] = freezeKind;
  return {
    task: TASK,
    claim,
    worker: WORKER_AGENT,
    status: SubmissionStatus.Rejected,
    proofHash: new Uint8Array(32).fill(2),
    resultData: new Uint8Array(64),
    submissionCount: 1,
    submittedAt: 0n,
    reviewDeadlineAt,
    acceptedAt: 0n,
    rejectedAt: 0n,
    rejectionHash: new Uint8Array(32).fill(3),
    bump: 254,
    reserved,
  };
}

function bondArgs(): DisputeBondArgs {
  return {
    subject: TASK,
    task: TASK,
    filer: WORKER_WALLET,
    respondent: CREATOR,
    amount: 10_000_000n,
    kind: 0,
    filedAt: 1_000n,
    rulingDeadline: 260_200n,
    bump: 253,
    reserved: new Uint8Array(24),
  };
}

async function world(options: {
  freezeKind: number;
  bond: "none" | "program" | "funded-system";
}) {
  const accounts = new Map<string, ProgramAccountSnapshot>();
  const program = AGENC_COORDINATION_PROGRAM_ADDRESS;
  const [claim] = await findClaimPda({ task: TASK, bidder: WORKER_AGENT });
  const [submission] = await findTaskSubmissionPda({ claim });
  const [bond] = await findDisputeRejectionDisputeBondPda({ task: TASK });
  accounts.set(TASK, {
    owner: program,
    data: new Uint8Array(getTaskEncoder().encode(taskArgs())),
  });
  accounts.set(submission, {
    owner: program,
    data: new Uint8Array(
      getTaskSubmissionEncoder().encode(
        submissionArgs(claim, options.freezeKind, 259_200n),
      ),
    ),
  });
  if (options.bond === "program") {
    accounts.set(bond, {
      owner: program,
      data: new Uint8Array(getDisputeBondEncoder().encode(bondArgs())),
    });
  } else if (options.bond === "funded-system") {
    // Anyone may send lamports to the canonical bond address.
    accounts.set(bond, { owner: SYSTEM_PROGRAM, data: new Uint8Array() });
  }
  const read = async (account: Address) => accounts.get(account) ?? null;
  return { read, claim, submission, bond };
}

describe("readTurnDown", () => {
  it("reads an undisputed revision 9 turn-down and the bond a dispute would cost", async () => {
    const { read, claim, submission } = await world({
      freezeKind: 1,
      bond: "none",
    });
    const turnDown = await readTurnDown(read, {
      task: TASK,
      worker: WORKER_AGENT,
    });
    expect(turnDown).toMatchObject({
      task: TASK,
      claim,
      submission,
      freezeKind: 1,
      disputable: true,
      reviewDeadlineAt: 259_200n,
      bondToDispute: 10_000_000n,
      dispute: null,
    });
    expect(turnDownStage(turnDown!, 259_201n)).toBe("refund_due");
  });

  it("treats a funded system account at the bond address as no bond", async () => {
    const { read } = await world({ freezeKind: 1, bond: "funded-system" });
    const turnDown = await readTurnDown(read, {
      task: TASK,
      worker: WORKER_AGENT,
    });
    expect(turnDown?.dispute).toBeNull();
  });

  it("reads a posted bond and its ruling deadline", async () => {
    const { read, bond } = await world({ freezeKind: 1, bond: "program" });
    const turnDown = await readTurnDown(read, {
      task: TASK,
      worker: WORKER_AGENT,
    });
    expect(turnDown?.dispute).toEqual({
      bond,
      amount: 10_000_000n,
      filer: WORKER_WALLET,
      respondent: CREATOR,
      filedAt: 1_000n,
      rulingDeadline: 260_200n,
    });
    expect(turnDownStage(turnDown!, 260_200n)).toBe("awaiting_ruling");
  });

  it("keeps a revision 8 freeze on its old rules", async () => {
    const { read } = await world({ freezeKind: 0, bond: "none" });
    const turnDown = await readTurnDown(read, {
      task: TASK,
      worker: WORKER_AGENT,
    });
    expect(turnDown?.disputable).toBe(false);
    expect(turnDownStage(turnDown!, 259_201n)).toBe("legacy_payout_due");
  });

  it("returns null when the task is not frozen", async () => {
    const accounts = new Map<string, ProgramAccountSnapshot>([
      [
        TASK,
        {
          owner: AGENC_COORDINATION_PROGRAM_ADDRESS,
          data: new Uint8Array(
            getTaskEncoder().encode(taskArgs({ status: TaskStatus.Completed })),
          ),
        },
      ],
    ]);
    expect(
      await readTurnDown(async (account) => accounts.get(account) ?? null, {
        task: TASK,
        worker: WORKER_AGENT,
      }),
    ).toBeNull();
  });
});

describe("record decoders", () => {
  it("decode a DisputeBond and a CreatorStats, and refuse a foreign program account", async () => {
    const program = AGENC_COORDINATION_PROGRAM_ADDRESS;
    expect(
      decodeDisputeBond({
        owner: program,
        data: new Uint8Array(getDisputeBondEncoder().encode(bondArgs())),
      })?.amount,
    ).toBe(10_000_000n);
    expect(decodeDisputeBond(null)).toBeNull();
    expect(
      decodeDisputeBond({ owner: SYSTEM_PROGRAM, data: new Uint8Array(186) }),
    ).toBeNull();
    expect(() =>
      decodeDisputeBond({ owner: program, data: new Uint8Array(186) }),
    ).toThrow(/not a DisputeBond/);

    const stats: CreatorStatsArgs = {
      wallet: CREATOR,
      rejections: 2n,
      rejectionsContested: 1n,
      disputesWon: 1n,
      disputesLost: 0n,
      cancels: 3n,
      depositsReceived: 1n,
      lastUpdated: 5n,
      bump: 252,
      reserved: new Uint8Array(32),
    };
    const data = new Uint8Array(getCreatorStatsEncoder().encode(stats));
    expect(data).toHaveLength(129);
    expect(decodeCreatorStats({ owner: program, data })?.cancels).toBe(3n);

    const [record] = await findCreatorStatsPda({ authority: CREATOR });
    const withRecord = await getCreatorTrackRecord(
      async (account) => (account === record ? { owner: program, data } : null),
      CREATOR,
    );
    expect(withRecord).toMatchObject({
      wallet: CREATOR,
      creatorStats: record,
      hasStats: true,
      counters: {
        rejections: 2n,
        rejectionsContested: 1n,
        disputesWon: 1n,
        disputesLost: 0n,
        cancels: 3n,
        depositsReceived: 1n,
      },
    });
    const without = await getCreatorTrackRecord(async () => null, CREATOR);
    expect(without.hasStats).toBe(false);
    expect(without.counters.cancels).toBe(0n);
  });
});
