// The worker's upkeep, at the edges the end-to-end run does not reach: a
// claim left on a task that already ended is reclaimed, a contest is never
// auto-accepted, and a refused transaction is not sent again on every poll.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { address, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import {
  DependencyType,
  findClaimPda,
  findProtocolConfigPda,
  findTaskSubmissionPda,
  getProtocolConfigEncoder,
  getTaskClaimEncoder,
  getTaskEncoder,
  getTaskSubmissionEncoder,
  RECLAIM_TERMINAL_CLAIM_DISCRIMINATOR,
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
import { collectOverdueReviews, releaseOwnClaims, UPKEEP_RETRY_SECONDS } from "../src/upkeep.js";

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

function claimData(expiresAt: bigint): Uint8Array {
  return new Uint8Array(
    getTaskClaimEncoder().encode({
      task: TASK,
      worker: WORKER,
      claimedAt: 1n,
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
    expect(loadState(w.stateDir).failedJobs[0]?.claimReleased).toBe(true);
    expect(w.events.find((event) => event.event === "claim.released")).toMatchObject({ how: "reclaimed", signature: "reclaim-sig" });
  });

  it("waits while the task runs and the claim's time is not over", async () => {
    const send = vi.fn();
    const w = await setup({ send });
    givenUp(w.stateDir);
    w.accounts.set(TASK, taskData(TaskStatus.InProgress));
    w.accounts.set(w.claim, claimData(BigInt(NOW + 3_600)));
    expect(await releaseOwnClaims(w.ctx, agent)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
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
