// The worker's upkeep, at the edges the end-to-end run does not reach: a
// claim left on a task that already ended is reclaimed, a contest is never
// auto-accepted, and a refused transaction is not sent again on every poll.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { address, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  DependencyType,
  findClaimPda,
  findDisputeRejectionDisputeBondPda,
  getDisputeBondEncoder,
  findProtocolConfigPda,
  findTaskSubmissionPda,
  getProtocolConfigEncoder,
  getTaskClaimEncoder,
  getTaskEncoder,
  getTaskMarkerEncoder,
  getTaskSubmissionEncoder,
  DISPUTE_REJECTION_DISCRIMINATOR,
  EXPIRE_REJECT_FROZEN_DISCRIMINATOR,
  RECLAIM_TERMINAL_CLAIM_DISCRIMINATOR,
  RELEASE_CLAIM_DISCRIMINATOR,
  SubmissionStatus,
  TaskStatus,
  TaskType,
  type MarketplaceClient,
  type ProgramAccountsTransport,
  type TaskArgs,
} from "@tetsuo-ai/marketplace-sdk";
import { describe, expect, it, vi } from "vitest";
import type { WorkerAgent, WorkerContext, WorkerLogEvent } from "../src/runtime.js";
import { emptyState, loadState, saveState } from "../src/state.js";
import {
  collectOverdueReviews,
  collectTurnDowns,
  releaseOwnClaims,
  UPKEEP_RETRY_SECONDS,
} from "../src/upkeep.js";

const TASK = address("F1qYyDAYYS1sLxq5nDprfNknnwGPo7ssyKvhScv6f8Uc");
const CREATOR = address("7Y9dRMi8ZtyDjLdSpzUCsxDgHooZTfp3RyYs2eZWmL39");
const WORKER = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const WALLET = address("E5NfNsr4SxWf8wJtVH5m7WpujYzxT6f17CFqN6c51dWm");
const TREASURY = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const NONE = address("11111111111111111111111111111111");
const NOW = 1_800_000_000;

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
      description: new Uint8Array(64),
      constraintHash: new Uint8Array(32),
      rewardAmount: 1_000_000n,
      maxWorkers: 1,
      currentWorkers: 1,
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
      protocolFeeBps: 500,
      dependsOn: null,
      dependencyType: DependencyType.None,
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

function claimData(expiresAt: bigint, claimedAt = 1n): Uint8Array {
  return new Uint8Array(
    getTaskClaimEncoder().encode({
      task: TASK,
      worker: WORKER,
      claimedAt,
      expiresAt,
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

async function protocolConfig(): Promise<[Address, Uint8Array]> {
  const [pda, bump] = await findProtocolConfigPda();
  return [
    pda,
    new Uint8Array(
      getProtocolConfigEncoder().encode({
        authority: WALLET,
        treasury: TREASURY,
        disputeThreshold: 50,
        protocolFeeBps: 500,
        minArbiterStake: 0n,
        minAgentStake: 0n,
        maxClaimDuration: 604800n,
        maxDisputeDuration: 604800n,
        totalAgents: 0n,
        totalTasks: 0n,
        completedTasks: 0n,
        totalValueDistributed: 0n,
        bump,
        multisigThreshold: 0,
        multisigOwnersLen: 0,
        taskCreationCooldown: 0n,
        maxTasksPer24h: 0,
        disputeInitiationCooldown: 0n,
        maxDisputesPer24h: 0,
        minStakeForDispute: 0n,
        slashPercentage: 50,
        stateUpdateCooldown: 0n,
        votingPeriod: 86400n,
        protocolVersion: 1,
        minSupportedVersion: 1,
        protocolPaused: false,
        disabledTaskTypeMask: 0,
        surfaceRevision: 1,
        multisigOwners: [NONE, NONE, NONE, NONE, NONE],
      }),
    ),
  ];
}

async function setup(client: Record<string, unknown>) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-upkeep-unit-"));
  const accounts = new Map<Address, Uint8Array>([await protocolConfig()]);
  const events: WorkerLogEvent[] = [];
  let now = NOW;
  const ctx: WorkerContext = {
    config: {
      capabilities: 1n,
      minRewardLamports: 0n,
      maxRewardLamports: null,
      allowUnboundedReward: true,
      executor: ["/never", "{prompt}"],
      executorMode: "sandboxed",
      executorEnvAllowlist: [],
      resultUploader: null,
      creatorAllowlist: null,
      allowAnyCreator: true,
      endpoint: "https://worker.example",
      executorTimeoutMs: 1_000,
      pollIntervalMs: 1_000,
    },
    client: client as unknown as MarketplaceClient,
    signer: { address: WALLET } as TransactionSigner,
    gpa: { getProgramAccounts: async () => [] } as ProgramAccountsTransport,
    readAccount: async (account) => accounts.get(account) ?? null,
    stateDir,
    log: (event) => events.push(event),
    clusterTime: async () => now,
  };
  const [claim] = await findClaimPda({ task: TASK, bidder: WORKER });
  const [submission] = await findTaskSubmissionPda({ claim });
  return {
    stateDir,
    accounts,
    events,
    ctx,
    claim,
    submission,
    later: (seconds: number) => {
      now += seconds;
    },
  };
}

function givenUp(stateDir: string): void {
  const state = emptyState();
  state.failedJobs.push({
    task: TASK,
    claimedAt: "2026-11-19T00:00:00.000Z",
    failedAt: "2026-11-19T00:10:00.000Z",
    chosen: false,
    cause: "attempts",
    reason: "executor exited with code 3",
    attempts: 3,
    claimReleased: false,
  });
  saveState(stateDir, state);
}

describe("releasing a given-up job's claim", () => {
  it("reclaims it at once when the task already ended", async () => {
    const send = vi.fn(async (_instructions: readonly Instruction[]) => ({ signature: "reclaim-sig" }));
    const w = await setup({ send });
    givenUp(w.stateDir);
    w.accounts.set(TASK, taskData(TaskStatus.Completed));
    w.accounts.set(w.claim, claimData(BigInt(NOW + 3_600)));

    expect(await releaseOwnClaims(w.ctx, agent)).toEqual([{ task: TASK, how: "reclaimed" }]);
    expect(send).toHaveBeenCalledTimes(1);
    const [instruction] = send.mock.calls[0]![0];
    expect([...instruction!.data!.slice(0, 8)]).toEqual([...RECLAIM_TERMINAL_CLAIM_DISCRIMINATOR]);
    // Revision 9: the task's creator, who gets a stranded deposit after expiry.
    expect(instruction!.accounts?.[9]?.address).toBe(CREATOR);
    expect(loadState(w.stateDir).failedJobs[0]?.claimReleased).toBe(true);
    expect(w.events.find((event) => event.event === "claim.released")).toMatchObject({ how: "reclaimed", signature: "reclaim-sig" });
  });

  it("gives a live undelivered claim back at once with release_claim (revision 9)", async () => {
    const send = vi.fn(async (_instructions: readonly Instruction[]) => ({ signature: "release-sig" }));
    const w = await setup({ send });
    givenUp(w.stateDir);
    w.accounts.set(TASK, taskData(TaskStatus.InProgress));
    // Claimed 10 minutes ago: inside the first hour, so the deposit comes back.
    w.accounts.set(w.claim, claimData(BigInt(NOW + 3_600), BigInt(NOW - 600)));
    expect(await releaseOwnClaims(w.ctx, agent)).toEqual([{ task: TASK, how: "released" }]);
    expect(send).toHaveBeenCalledTimes(1);
    const [instruction] = send.mock.calls[0]![0];
    expect([...instruction!.data!.slice(0, 8)]).toEqual([...RELEASE_CLAIM_DISCRIMINATOR]);
    // No validation config on this task: the optional account is left out.
    expect(instruction!.accounts?.[4]?.address).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(instruction!.accounts?.[6]?.address).toBe(CREATOR);
    expect(loadState(w.stateDir).failedJobs[0]?.claimReleased).toBe(true);
    expect(w.events.find((event) => event.event === "claim.released")).toMatchObject({
      how: "released",
      depositBack: true,
    });
  });

  it("says when a release after the first hour sends the deposit to the buyer", async () => {
    const send = vi.fn(async () => ({ signature: "release-sig" }));
    const w = await setup({ send });
    givenUp(w.stateDir);
    w.accounts.set(TASK, taskData(TaskStatus.InProgress));
    w.accounts.set(w.claim, claimData(BigInt(NOW + 3_600), BigInt(NOW - 3_601)));
    expect(await releaseOwnClaims(w.ctx, agent)).toEqual([{ task: TASK, how: "released" }]);
    expect(w.events.find((event) => event.event === "claim.released")).toMatchObject({
      depositBack: false,
    });
  });

  it("waits for expiry on a contest or bid task, which release_claim refuses", async () => {
    for (const taskType of [TaskType.Competitive, TaskType.BidExclusive]) {
      const send = vi.fn();
      const w = await setup({ send });
      givenUp(w.stateDir);
      w.accounts.set(TASK, taskData(TaskStatus.InProgress, { taskType }));
      w.accounts.set(w.claim, claimData(BigInt(NOW + 3_600)));
      expect(await releaseOwnClaims(w.ctx, agent)).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("counts a claim someone else closed as released, sending nothing", async () => {
    const send = vi.fn();
    const w = await setup({ send });
    givenUp(w.stateDir);
    w.accounts.set(TASK, taskData(TaskStatus.Cancelled));
    expect(await releaseOwnClaims(w.ctx, agent)).toEqual([{ task: TASK, how: "closed" }]);
    expect(send).not.toHaveBeenCalled();
    expect(loadState(w.stateDir).failedJobs[0]?.claimReleased).toBe(true);
  });

  it("sends a refused release again only after a wait", async () => {
    const send = vi.fn(async () => {
      throw new Error("blockhash not found");
    });
    const w = await setup({ send });
    givenUp(w.stateDir);
    w.accounts.set(TASK, taskData(TaskStatus.InProgress));
    w.accounts.set(w.claim, claimData(BigInt(NOW - 10)));
    const memory = new Map<string, number>();
    await releaseOwnClaims(w.ctx, agent, memory);
    await releaseOwnClaims(w.ctx, agent, memory);
    expect(send).toHaveBeenCalledTimes(1);
    w.later(UPKEEP_RETRY_SECONDS);
    await releaseOwnClaims(w.ctx, agent, memory);
    expect(send).toHaveBeenCalledTimes(2);
    expect(loadState(w.stateDir).failedJobs[0]?.claimReleased).toBe(false);
  });
});

describe("a compacted task (revision 9)", () => {
  it("is skipped by every upkeep step instead of failing to decode", async () => {
    const send = vi.fn(async () => ({ signature: "never" }));
    const autoAcceptTaskResult = vi.fn(async () => ({ signature: "never" }));
    const w = await setup({ send, autoAcceptTaskResult });
    const state = emptyState();
    state.submissions.push({
      task: TASK,
      submissionSignature: "submit-sig",
      resultUri: "agenc://result/sha256/x",
      resultHashHex: "ab".repeat(32),
      rewardAmount: "1000000",
      submittedAt: "2026-11-19T00:00:00.000Z",
      settled: false,
    });
    state.failedJobs.push({
      task: TASK,
      claimedAt: "2026-11-19T00:00:00.000Z",
      failedAt: "2026-11-19T00:10:00.000Z",
      cause: "attempts",
      reason: "executor exited with code 3",
      attempts: 3,
      claimReleased: false,
    });
    saveState(w.stateDir, state);
    w.accounts.set(
      TASK,
      new Uint8Array(
        getTaskMarkerEncoder().encode({
          creator: CREATOR,
          status: TaskStatus.Completed,
          flags: 0,
          closedAt: BigInt(NOW),
          reserved: new Uint8Array(6),
        }),
      ),
    );

    expect(await collectOverdueReviews(w.ctx, agent)).toEqual([]);
    // Compaction needs every claim gone, so a given-up claim there is over.
    expect(await releaseOwnClaims(w.ctx, agent)).toEqual([
      { task: TASK, how: "closed" },
    ]);
    // Even with a claim account left, the closed task is skipped.
    w.accounts.set(w.claim, claimData(BigInt(NOW + 3_600)));
    const later = emptyState();
    later.failedJobs.push({ ...state.failedJobs[0]!, claimReleased: false });
    later.submissions.push(state.submissions[0]!);
    saveState(w.stateDir, later);
    expect(await releaseOwnClaims(w.ctx, agent)).toEqual([]);
    expect(await collectTurnDowns(w.ctx, agent)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(autoAcceptTaskResult).not.toHaveBeenCalled();
  });
});

describe("auto-accepting a delivery nobody reviewed", () => {
  function delivered(stateDir: string): void {
    const state = emptyState();
    state.submissions.push({
      task: TASK,
      submissionSignature: "submit-sig",
      resultUri: "agenc://result/sha256/x",
      resultHashHex: "ab".repeat(32),
      rewardAmount: "1000000",
      submittedAt: "2026-11-19T00:00:00.000Z",
      settled: false,
    });
    saveState(stateDir, state);
  }

  function submissionData(claim: Address, reviewDeadlineAt: bigint): Uint8Array {
    return new Uint8Array(
      getTaskSubmissionEncoder().encode({
        task: TASK,
        claim,
        worker: WORKER,
        status: SubmissionStatus.Submitted,
        proofHash: new Uint8Array(32).fill(0xab),
        resultData: new Uint8Array(64),
        submissionCount: 1,
        submittedAt: 1n,
        reviewDeadlineAt,
        acceptedAt: 0n,
        rejectedAt: 0n,
        rejectionHash: new Uint8Array(32),
        bump: 249,
        reserved: new Uint8Array(5),
      }),
    );
  }

  it("is sent for the worker's own delivery once the window has passed, with the task's payees", async () => {
    const autoAcceptTaskResult = vi.fn(async (_input: Record<string, unknown>) => ({ signature: "accept-sig" }));
    const w = await setup({ autoAcceptTaskResult });
    delivered(w.stateDir);
    w.accounts.set(
      TASK,
      taskData(TaskStatus.PendingValidation, { operator: TREASURY, operatorFeeBps: 1_000 }),
    );
    w.accounts.set(w.submission, submissionData(w.claim, BigInt(NOW + 30)));

    expect(await collectOverdueReviews(w.ctx, agent)).toEqual([]);
    w.later(31);
    expect(await collectOverdueReviews(w.ctx, agent)).toEqual([TASK]);
    expect(autoAcceptTaskResult.mock.calls[0]![0]).toMatchObject({
      task: TASK,
      worker: WORKER,
      creator: CREATOR,
      treasury: TREASURY,
      workerAuthority: WALLET,
      operator: TREASURY,
    });
  });

  it("is never sent for a contest, which cannot be auto-accepted", async () => {
    const autoAcceptTaskResult = vi.fn();
    const w = await setup({ autoAcceptTaskResult });
    delivered(w.stateDir);
    w.accounts.set(TASK, taskData(TaskStatus.PendingValidation, { taskType: TaskType.Competitive }));
    w.accounts.set(w.submission, submissionData(w.claim, BigInt(NOW - 100)));
    expect(await collectOverdueReviews(w.ctx, agent)).toEqual([]);
    expect(autoAcceptTaskResult).not.toHaveBeenCalled();
  });

  it("is not sent again on every poll after it was refused", async () => {
    const autoAcceptTaskResult = vi.fn(async () => {
      throw new Error("ReviewWindowNotElapsed");
    });
    const w = await setup({ autoAcceptTaskResult });
    delivered(w.stateDir);
    w.accounts.set(TASK, taskData(TaskStatus.PendingValidation));
    w.accounts.set(w.submission, submissionData(w.claim, BigInt(NOW - 100)));
    const memory = new Map<string, number>();
    for (let poll = 0; poll < 4; poll += 1) await collectOverdueReviews(w.ctx, agent, memory);
    expect(autoAcceptTaskResult).toHaveBeenCalledTimes(1);
    expect(w.events.find((event) => event.event === "settlement.auto-accept-failed")).toMatchObject({
      reason: expect.stringMatching(/ReviewWindowNotElapsed/),
    });
    w.later(UPKEEP_RETRY_SECONDS);
    await collectOverdueReviews(w.ctx, agent, memory);
    expect(autoAcceptTaskResult).toHaveBeenCalledTimes(2);
  });
});

describe("a delivery the buyer turned down (revision 9)", () => {
  function delivered(stateDir: string): void {
    const state = emptyState();
    state.submissions.push({
      task: TASK,
      submissionSignature: "submit-sig",
      resultUri: "agenc://result/sha256/x",
      resultHashHex: "ab".repeat(32),
      rewardAmount: "1000000",
      submittedAt: "2026-11-19T00:00:00.000Z",
      settled: false,
    });
    saveState(stateDir, state);
  }

  function frozenSubmission(claim: Address, freezeKind: number, deadline: bigint): Uint8Array {
    const reserved = new Uint8Array(5);
    reserved[2] = freezeKind;
    return new Uint8Array(
      getTaskSubmissionEncoder().encode({
        task: TASK,
        claim,
        worker: WORKER,
        status: SubmissionStatus.Rejected,
        proofHash: new Uint8Array(32).fill(0xab),
        resultData: new Uint8Array(64),
        submissionCount: 1,
        submittedAt: 1n,
        reviewDeadlineAt: deadline,
        acceptedAt: 0n,
        rejectedAt: 2n,
        rejectionHash: new Uint8Array(32).fill(0xcd),
        bump: 249,
        reserved,
      }),
    );
  }

  async function frozen(options: {
    freezeKind?: number;
    deadline?: bigint;
    disputeTurnDowns?: boolean;
    send?: ReturnType<typeof vi.fn>;
  }) {
    const send = options.send ?? vi.fn(async () => ({ signature: "turn-down-sig" }));
    const w = await setup({ send });
    if (options.disputeTurnDowns !== undefined) {
      w.ctx.config.disputeTurnDowns = options.disputeTurnDowns;
    }
    delivered(w.stateDir);
    w.accounts.set(TASK, taskData(TaskStatus.RejectFrozen));
    w.accounts.set(
      w.submission,
      frozenSubmission(w.claim, options.freezeKind ?? 1, options.deadline ?? BigInt(NOW + 3_600)),
    );
    return { ...w, send };
  }

  it("only reports it while the operator's dispute policy is off (the default)", async () => {
    const w = await frozen({});
    expect(await collectTurnDowns(w.ctx, agent)).toEqual([]);
    expect(w.send).not.toHaveBeenCalled();
    expect(w.events.find((event) => event.event === "task.turned-down")).toMatchObject({
      task: TASK,
      stage: "dispute_window",
      disputeUntil: NOW + 3_600,
      // 10% of a 0.001 SOL price is below the 0.01 SOL bond floor.
      bondLamports: "10000000",
      disputePolicy: "off",
    });
  });

  it("disputes it with the bond inside the window when the policy is on", async () => {
    const w = await frozen({ disputeTurnDowns: true });
    expect(await collectTurnDowns(w.ctx, agent)).toEqual([{ task: TASK, action: "disputed" }]);
    expect(w.send).toHaveBeenCalledTimes(1);
    const [instruction] = (w.send.mock.calls[0]![0] as Instruction[]);
    expect([...instruction!.data!.slice(0, 8)]).toEqual([...DISPUTE_REJECTION_DISCRIMINATOR]);
    const [bond] = await findDisputeRejectionDisputeBondPda({ task: TASK });
    expect(instruction!.accounts?.[4]?.address).toBe(bond);
    expect(instruction!.accounts?.[7]?.address).toBe(WALLET);
  });

  it("does not dispute when the wallet cannot hold the bond, its account rent and fees", async () => {
    const w = await frozen({ disputeTurnDowns: true });
    w.ctx.getBalance = async () => 10_000_000n;
    w.ctx.getMinimumBalanceForRentExemption = async () => 1_000_000n;
    expect(await collectTurnDowns(w.ctx, agent)).toEqual([]);
    expect(w.send).not.toHaveBeenCalled();
    expect(w.events.find((event) => event.event === "task.turn-down-dispute-unfunded")).toMatchObject({
      neededLamports: String(10_000_000n + 1_000_000n + 100_000n),
    });
  });

  it("sends the expiry once the window is over, which refunds the buyer and returns the worker's rent", async () => {
    const w = await frozen({ deadline: BigInt(NOW - 1) });
    expect(await collectTurnDowns(w.ctx, agent)).toEqual([{ task: TASK, action: "collected" }]);
    const [instruction] = (w.send.mock.calls[0]![0] as Instruction[]);
    expect([...instruction!.data!.slice(0, 8)]).toEqual([...EXPIRE_REJECT_FROZEN_DISCRIMINATOR]);
    expect(w.events.find((event) => event.event === "task.turn-down-collected")).toMatchObject({
      paid: false,
    });
  });

  it("waits while a disputed turn-down can still be ruled, then collects the bond back", async () => {
    const w = await frozen({ deadline: BigInt(NOW - 100) });
    const [bond] = await findDisputeRejectionDisputeBondPda({ task: TASK });
    const bondData = new Uint8Array(
      getDisputeBondEncoder().encode({
        subject: TASK,
        task: TASK,
        filer: WALLET,
        respondent: CREATOR,
        amount: 10_000_000n,
        kind: 0,
        filedAt: BigInt(NOW - 200),
        rulingDeadline: BigInt(NOW + 50),
        bump: 248,
        reserved: new Uint8Array(24),
      }),
    );
    w.accounts.set(bond, bondData);
    const memory = new Map<string, number>();
    expect(await collectTurnDowns(w.ctx, agent, memory)).toEqual([]);
    expect(w.send).not.toHaveBeenCalled();
    w.later(51);
    expect(await collectTurnDowns(w.ctx, agent, memory)).toEqual([{ task: TASK, action: "collected" }]);
  });

  it("collects the pay of a revision 8 freeze after its review time", async () => {
    const w = await frozen({ freezeKind: 0, deadline: BigInt(NOW - 1) });
    expect(await collectTurnDowns(w.ctx, agent)).toEqual([{ task: TASK, action: "collected" }]);
    expect(w.events.find((event) => event.event === "task.turn-down-collected")).toMatchObject({
      paid: true,
    });
  });
});

it("guards an automatic refundable release through signing and landing",async()=>{
  let instructions: readonly Instruction[] = [], checked = false;
  const send=vi.fn(async(ix:readonly Instruction[], options:{assertAuthorized?:()=>void})=>{
    instructions=ix; options.assertAuthorized?.(); checked=!!options.assertAuthorized; return {signature:"local"};
  });
  const w=await setup({send});givenUp(w.stateDir);
  w.accounts.set(TASK,taskData(TaskStatus.InProgress));w.accounts.set(w.claim,claimData(BigInt(NOW+7200),BigInt(NOW-3590)));
  await releaseOwnClaims(w.ctx,agent);
  expect(checked).toBe(true);
  const {lighthouse}=await import("@tetsuo-ai/marketplace-sdk");
  expect(instructions).toContainEqual(lighthouse.assertClockBefore(NOW+11));
});
