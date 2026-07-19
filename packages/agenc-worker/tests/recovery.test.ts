import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { address, type Address, type TransactionSigner } from "@solana/kit";
import {
  AgentStatus,
  AgencError,
  DependencyType,
  findAgentPda,
  findClaimPda,
  findTaskJobSpecPda,
  findTaskSubmissionPda,
  getTaskClaimEncoder,
  getAgentRegistrationEncoder,
  getTaskEncoder,
  getTaskJobSpecEncoder,
  getTaskSubmissionEncoder,
  SubmissionStatus,
  TASK_DISCRIMINATOR,
  TASK_JOB_SPEC_DISCRIMINATOR,
  TaskStatus,
  TaskType,
  taskThread,
  values,
  type MarketplaceClient,
  type ProgramAccountsTransport,
  type TaskArgs,
} from "@tetsuo-ai/marketplace-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  CLAIM_ACCOUNT_SIZE,
  CONTEST_ENTRY_DEPOSIT_LAMPORTS,
  FEE_HEADROOM_LAMPORTS,
  checkSettlements,
  listClaimCandidates,
  processCandidate,
  resumeOpenClaim,
  runTickOnce,
  SUBMISSION_ACCOUNT_SIZE,
  type WorkerAgent,
  type WorkerContext,
  type WorkerLogEvent,
} from "../src/runtime.js";
import { resultDataFromHashHex, sha256Hex } from "../src/result.js";
import {
  bytesToHex,
  emptyState,
  loadState,
  saveState,
} from "../src/state.js";

const TASK = address("F1qYyDAYYS1sLxq5nDprfNknnwGPo7ssyKvhScv6f8Uc");
const CREATOR = address("7Y9dRMi8ZtyDjLdSpzUCsxDgHooZTfp3RyYs2eZWmL39");
const WORKER = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const WALLET = address("E5NfNsr4SxWf8wJtVH5m7WpujYzxT6f17CFqN6c51dWm");
const PARENT = address("11111111111111111111111111111111");
const REWARD = 4_200_000n;
const SPEC_URI = "https://specs.example/task.json";

function taskArgs(
  status: TaskStatus,
  overrides: Partial<TaskArgs> = {},
): TaskArgs {
  return {
    taskId: new Uint8Array(32).fill(1),
    creator: CREATOR,
    requiredCapabilities: 1n,
    description: new Uint8Array(64).fill(2),
    constraintHash: new Uint8Array(32),
    rewardAmount: REWARD,
    maxWorkers: 1,
    currentWorkers: status === TaskStatus.Open ? 0 : 1,
    status,
    taskType: TaskType.Exclusive,
    createdAt: 1n,
    deadline: 0n,
    completedAt: 0n,
    escrow: PARENT,
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 250,
    protocolFeeBps: 100,
    dependsOn: PARENT,
    dependencyType: DependencyType.Data,
    minReputation: 0,
    rewardMint: null,
    operator: PARENT,
    operatorFeeBps: 0,
    reserved: new Uint8Array(16),
    referrer: PARENT,
    referrerFeeBps: 0,
    ...overrides,
  };
}

function taskData(
  status: TaskStatus,
  overrides: Partial<TaskArgs> = {},
): Uint8Array {
  return new Uint8Array(getTaskEncoder().encode(taskArgs(status, overrides)));
}

function claimData(claimPda: Address, worker: Address = WORKER): Uint8Array {
  void claimPda;
  return new Uint8Array(
    getTaskClaimEncoder().encode({
      task: TASK,
      worker,
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

function submissionData(
  claimPda: Address,
  proofHash: Uint8Array,
  status = SubmissionStatus.Submitted,
  rejectionHash: Uint8Array = new Uint8Array(32),
  submissionCount = 1,
): Uint8Array {
  return new Uint8Array(
    getTaskSubmissionEncoder().encode({
      task: TASK,
      claim: claimPda,
      worker: WORKER,
      status,
      proofHash,
      resultData: resultDataFromHashHex(Buffer.from(proofHash).toString("hex")),
      submissionCount,
      submittedAt: 1_700_000_100n,
      reviewDeadlineAt: 1_700_003_700n,
      acceptedAt: 0n,
      rejectedAt: 0n,
      rejectionHash,
      bump: 249,
      reserved: new Uint8Array(5),
    }),
  );
}

function agentRegistrationData(totalEarned: bigint): Uint8Array {
  return new Uint8Array(
    getAgentRegistrationEncoder().encode({
      agentId: agent.agentId,
      authority: WALLET,
      capabilities: 1n,
      status: AgentStatus.Active,
      endpoint: "https://worker.example",
      metadataUri: "",
      registeredAt: 1n,
      lastActive: 1n,
      tasksCompleted: 1n,
      totalEarned,
      reputation: 3_000,
      activeTasks: 0,
      stake: 10_000_000n,
      bump: 255,
      lastTaskCreated: 0n,
      lastDisputeInitiated: 0n,
      taskCount24h: 0,
      disputeCount24h: 0,
      rateLimitWindowStart: 0n,
      activeDisputeVotes: 0,
      lastVoteTimestamp: 0n,
      lastStateUpdate: 0n,
      disputesAsDefendant: 0,
      reserved: new Uint8Array(4),
    }),
  );
}

function config() {
  return {
    capabilities: 1n,
    minRewardLamports: 0n,
    maxRewardLamports: 10_000_000n,
    allowUnboundedReward: false,
    executor: [
      process.execPath,
      "-e",
      'process.stdout.write("worker-result")',
      "{prompt}",
    ],
    executorMode: "sandboxed" as const,
    executorEnvAllowlist: [],
    resultUploader: null,
    creatorAllowlist: null,
    allowAnyCreator: true,
    endpoint: "https://worker.example",
    executorTimeoutMs: 10_000,
    pollIntervalMs: 1_000,
  };
}

function context(
  stateDir: string,
  accounts: Map<Address, Uint8Array>,
  client: Record<string, unknown>,
  events: WorkerLogEvent[],
): WorkerContext {
  return {
    config: config(),
    client: client as unknown as MarketplaceClient,
    signer: { address: WALLET } as TransactionSigner,
    gpa: { getProgramAccounts: async () => [] } as ProgramAccountsTransport,
    readAccount: async (account) => accounts.get(account) ?? null,
    stateDir,
    log: (event) => events.push(event),
    // Every fresh-claim path is live-funded. Individual tests override these
    // seams when exercising insufficient funds or recovery ordering.
    getBalance: async () => 1_000_000_000n,
    getMinimumBalanceForRentExemption: async (space) => {
      if (space === CLAIM_ACCOUNT_SIZE) return 2_000_000n;
      if (space === SUBMISSION_ACCOUNT_SIZE) return 3_000_000n;
      throw new Error(`unexpected fresh-claim account size ${space}`);
    },
  };
}

const agent: WorkerAgent = {
  agentId: new Uint8Array(32).fill(9),
  agentPda: WORKER,
  registered: true,
  justRegistered: false,
};

describe("transaction-boundary recovery", () => {
  it("rejects SPL-reward candidates before reading content or claiming", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-spl-reward-reject-"),
    );
    const events: WorkerLogEvent[] = [];
    const ctx = context(stateDir, new Map(), {}, events);
    const outcome = await processCandidate(ctx, agent, {
      task: TASK,
      creator: CREATOR,
      rewardAmount: REWARD,
      rewardMint: PARENT,
      requiredCapabilities: 1n,
      parentTask: PARENT,
    });
    expect(outcome).toEqual({
      status: "skipped",
      task: TASK,
      reason: "spl-reward-unsupported",
    });
    expect(events).toContainEqual({
      event: "task.skipped",
      task: TASK,
      reason: "spl-reward-unsupported",
    });
  });

  it("re-filters the canonical reward before fetching content or claiming", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-canonical-reward-reject-"),
    );
    const payload = { title: "repriced task", summary: "must be re-filtered" };
    const digest = await values.canonicalJobSpecHash(payload);
    const body = new TextEncoder().encode(
      JSON.stringify({
        integrity: {
          algorithm: "sha256",
          canonicalization: "json-stable-v1",
          payloadHash: digest.hex,
        },
        payload,
      }),
    );
    const [jobSpecPda] = await findTaskJobSpecPda({ task: TASK });
    const accounts = new Map<Address, Uint8Array>([
      [
        TASK,
        taskData(TaskStatus.Open, {
          rewardAmount: 10_000_001n,
        }),
      ],
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
    const claimTaskWithJobSpec = vi.fn(async () => {
      throw new AgencError("claim should not be attempted", {
        signature: null,
      });
    });
    const ctx = context(stateDir, accounts, { claimTaskWithJobSpec }, []);
    const fetchUri = vi.fn(async () => body);
    ctx.fetchUri = fetchUri;

    const outcome = await processCandidate(ctx, agent, {
      task: TASK,
      creator: CREATOR,
      rewardAmount: REWARD,
      rewardMint: null,
      requiredCapabilities: 1n,
      parentTask: PARENT,
    });

    expect(outcome).toEqual({
      status: "skipped",
      task: TASK,
      reason: "above-max-reward-cap",
    });
    expect(fetchUri).not.toHaveBeenCalled();
    expect(claimTaskWithJobSpec).not.toHaveBeenCalled();
  });

  it("requires a live recurring-task funding gate and blocks an underfunded registered worker", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-recurring-funding-"),
    );
    const payload = {
      title: "recurring worker funding",
      summary: "fund the complete claim lifecycle",
    };
    const digest = await values.canonicalJobSpecHash(payload);
    const body = new TextEncoder().encode(
      JSON.stringify({
        integrity: {
          algorithm: "sha256",
          canonicalization: "json-stable-v1",
          payloadHash: digest.hex,
        },
        payload,
      }),
    );
    const [jobSpecPda] = await findTaskJobSpecPda({ task: TASK });
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.Open)],
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
    const claimTaskWithJobSpec = vi.fn(async () => ({
      signature: "must-not-claim",
    }));
    const ctx = context(
      stateDir,
      accounts,
      { claimTaskWithJobSpec },
      [],
    );
    ctx.fetchUri = async () => body;
    const claimRent = 2_000_000n;
    const submissionRent = 3_000_000n;
    const required =
      claimRent +
      submissionRent +
      CONTEST_ENTRY_DEPOSIT_LAMPORTS +
      FEE_HEADROOM_LAMPORTS;
    const getBalance = vi.fn(async () => required - 1n);
    const getMinimumBalanceForRentExemption = vi.fn(async (space: number) => {
      if (space === CLAIM_ACCOUNT_SIZE) return claimRent;
      if (space === SUBMISSION_ACCOUNT_SIZE) return submissionRent;
      throw new Error(`unexpected recurring-worker account size ${space}`);
    });
    ctx.getBalance = getBalance;
    ctx.getMinimumBalanceForRentExemption =
      getMinimumBalanceForRentExemption;

    const candidate = {
      task: TASK,
      creator: CREATOR,
      rewardAmount: REWARD,
      rewardMint: null,
      requiredCapabilities: 1n,
      parentTask: PARENT,
    };
    await expect(processCandidate(ctx, agent, candidate)).rejects.toThrow(
      new RegExp(
        `working another task needs at least ${required} lamports.*1 more lamport`,
        "s",
      ),
    );
    expect(getBalance).toHaveBeenCalledExactlyOnceWith(WALLET);
    expect(getMinimumBalanceForRentExemption.mock.calls).toEqual([
      [CLAIM_ACCOUNT_SIZE],
      [SUBMISSION_ACCOUNT_SIZE],
    ]);
    expect(claimTaskWithJobSpec).not.toHaveBeenCalled();
    expect(loadState(stateDir).openClaim).toBeNull();

    delete ctx.getMinimumBalanceForRentExemption;
    await expect(processCandidate(ctx, agent, candidate)).rejects.toThrow(
      /fresh-claim funding gate requires live getBalance.*refusing to claim without both/s,
    );
    expect(claimTaskWithJobSpec).not.toHaveBeenCalled();
    expect(loadState(stateDir).openClaim).toBeNull();

    delete ctx.getBalance;
    await expect(processCandidate(ctx, agent, candidate)).rejects.toThrow(
      /fresh-claim funding gate requires live getBalance.*refusing to claim without both/s,
    );
    expect(claimTaskWithJobSpec).not.toHaveBeenCalled();
    expect(loadState(stateDir).openClaim).toBeNull();

    ctx.getBalance = async () => required;
    ctx.getMinimumBalanceForRentExemption =
      getMinimumBalanceForRentExemption;
    claimTaskWithJobSpec.mockRejectedValueOnce(
      new AgencError("expected post-gate claim stop", { signature: null }),
    );
    await expect(processCandidate(ctx, agent, candidate)).resolves.toMatchObject(
      { status: "claim-failed", task: TASK },
    );
    expect(claimTaskWithJobSpec).toHaveBeenCalledTimes(1);
    expect(loadState(stateDir).openClaim).toBeNull();
  });

  it("recovers an already-landed claim before consulting the fresh-claim funding gate", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-funded-recovery-order-"),
    );
    const agentId = new Uint8Array(32).fill(9);
    const [agentPda] = await findAgentPda({ agentId });
    const [claimPda] = await findClaimPda({ task: TASK, bidder: agentPda });
    const [jobSpecPda] = await findTaskJobSpecPda({ task: TASK });
    const payload = {
      title: "landed claim recovery",
      summary: "resume before checking fresh-claim funds",
    };
    const digest = await values.canonicalJobSpecHash(payload);
    const body = new TextEncoder().encode(
      JSON.stringify({
        integrity: {
          algorithm: "sha256",
          canonicalization: "json-stable-v1",
          payloadHash: digest.hex,
        },
        payload,
      }),
    );
    const state = emptyState();
    state.agentIdHex = bytesToHex(agentId);
    state.openClaim = {
      task: TASK,
      claimedAt: "2026-07-19T00:00:00.000Z",
      phase: "claiming",
    };
    saveState(stateDir, state);
    const accounts = new Map<Address, Uint8Array>([
      [agentPda, agentRegistrationData(0n)],
      [TASK, taskData(TaskStatus.InProgress)],
      [claimPda, claimData(claimPda, agentPda)],
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
    const claimTaskWithJobSpec = vi.fn();
    const submitTaskResult = vi.fn(async () => ({
      signature: "recovered-submit-signature",
    }));
    const events: WorkerLogEvent[] = [];
    const ctx = context(
      stateDir,
      accounts,
      { claimTaskWithJobSpec, submitTaskResult },
      events,
    );
    ctx.fetchUri = async () => body;
    const getBalance = vi.fn(async () => 0n);
    const getMinimumBalanceForRentExemption = vi.fn(async () => {
      throw new Error("fresh-claim rent gate must not run during recovery");
    });
    ctx.getBalance = getBalance;
    ctx.getMinimumBalanceForRentExemption =
      getMinimumBalanceForRentExemption;

    const result = await runTickOnce(ctx);

    expect(result.outcome?.status).toBe("submitted");
    expect(claimTaskWithJobSpec).not.toHaveBeenCalled();
    expect(submitTaskResult).toHaveBeenCalledTimes(1);
    expect(getBalance).not.toHaveBeenCalled();
    expect(getMinimumBalanceForRentExemption).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event)).toContain(
      "task.resuming-open-claim",
    );
  });

  it("migrates the legacy claim-only state marker to the claimed phase", () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-legacy-state-"),
    );
    writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({
        agentIdHex: null,
        openClaim: {
          task: TASK,
          claimedAt: "2026-07-18T00:00:00.000Z",
        },
        totalEarnedBaseline: "0",
        submissions: [],
      }),
      { mode: 0o600 },
    );
    expect(loadState(stateDir).openClaim).toMatchObject({
      task: TASK,
      phase: "claimed",
    });
  });

  it("writes intent before each broadcast and recovers claim + submission when both land but RPC throws", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-recovery-"));
    const accounts = new Map<Address, Uint8Array>();
    const events: WorkerLogEvent[] = [];
    const payload = { title: "dependent task", summary: "prove recovery" };
    const digest = await values.canonicalJobSpecHash(payload);
    const body = new TextEncoder().encode(
      JSON.stringify({
        integrity: {
          algorithm: "sha256",
          canonicalization: "json-stable-v1",
          payloadHash: digest.hex,
        },
        payload,
      }),
    );
    const [jobSpecPda] = await findTaskJobSpecPda({ task: TASK });
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
    accounts.set(TASK, taskData(TaskStatus.Open));
    accounts.set(
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
    );

    const claimTaskWithJobSpec = vi.fn(
      async (
        input: { parentTask?: Address },
        options: { maxRetries?: number },
      ) => {
        expect(input.parentTask).toBe(PARENT);
        expect(options).toEqual({ maxRetries: 0 });
        expect(loadState(stateDir).openClaim?.phase).toBe("claiming");
        accounts.set(TASK, taskData(TaskStatus.InProgress));
        accounts.set(claimPda, claimData(claimPda));
        throw new AgencError(
          "confirmation failed at https://user:pass@rpc.example/v2/path-token?api-key=query-token",
          { signature: "claim-ambiguous-signature" },
        );
      },
    );
    const submitTaskResult = vi.fn(
      async (
        input: { proofHash: Uint8Array },
        options: { maxRetries?: number },
      ) => {
        const marker = loadState(stateDir).openClaim;
        expect(options).toEqual({ maxRetries: 0 });
        expect(marker?.phase).toBe("submitting");
        expect(marker?.claimTransactionSignature).toBe(
          "claim-ambiguous-signature",
        );
        expect(marker?.submission?.resultHashHex).toBe(
          Buffer.from(input.proofHash).toString("hex"),
        );
        accounts.set(TASK, taskData(TaskStatus.PendingValidation));
        accounts.set(submissionPda, submissionData(claimPda, input.proofHash));
        throw new AgencError(
          "confirmation failed at https://rpc.example/v2/submit-token?key=query-token",
          { signature: "submit-ambiguous-signature" },
        );
      },
    );
    const ctx = context(
      stateDir,
      accounts,
      { claimTaskWithJobSpec, submitTaskResult },
      events,
    );
    ctx.fetchUri = async (uri) => {
      expect(uri).toBe(SPEC_URI);
      return body;
    };

    const outcome = await processCandidate(ctx, agent, {
      task: TASK,
      creator: CREATOR,
      rewardAmount: REWARD,
      rewardMint: null,
      requiredCapabilities: 1n,
      parentTask: PARENT,
    });

    expect(outcome.status).toBe("submitted");
    expect(claimTaskWithJobSpec).toHaveBeenCalledTimes(1);
    expect(submitTaskResult).toHaveBeenCalledTimes(1);
    const state = loadState(stateDir);
    expect(state.openClaim).toBeNull();
    expect(state.submissions).toHaveLength(1);
    expect(state.submissions[0]?.submissionSignature).toBe(
      "submit-ambiguous-signature",
    );
    expect(events.map((event) => event.event)).toContain(
      "task.claim-recovered",
    );
    expect(events.map((event) => event.event)).toContain(
      "task.submission-recovered",
    );
    expect(JSON.stringify(events)).not.toMatch(
      /user|pass|path-token|query-token/,
    );
    expect(events.every((event) => !("resultUri" in event))).toBe(true);
  });

  it("clears only proven pre-send/custom claim failures and retains signature-bearing ambiguity", async () => {
    const payload = { title: "claim errors", summary: "classify safely" };
    const digest = await values.canonicalJobSpecHash(payload);
    const body = new TextEncoder().encode(
      JSON.stringify({
        integrity: {
          algorithm: "sha256",
          canonicalization: "json-stable-v1",
          payloadHash: digest.hex,
        },
        payload,
      }),
    );

    for (const fixture of [
      {
        error: new AgencError("pre-send", { signature: null }),
        retained: false,
      },
      {
        error: new AgencError("confirmed custom", {
          signature: "confirmed-failed-signature",
          code: 6_001,
        }),
        retained: false,
      },
      {
        error: new AgencError("confirmation timeout", {
          signature: "ambiguous-live-signature",
        }),
        retained: true,
      },
    ]) {
      const stateDir = mkdtempSync(
        path.join(tmpdir(), "agenc-worker-claim-error-"),
      );
      const [jobSpecPda] = await findTaskJobSpecPda({ task: TASK });
      const accounts = new Map<Address, Uint8Array>([
        [TASK, taskData(TaskStatus.Open)],
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
      const claimTaskWithJobSpec = vi.fn(
        async (_input: unknown, options: { maxRetries?: number }) => {
          expect(options).toEqual({ maxRetries: 0 });
          throw fixture.error;
        },
      );
      const ctx = context(stateDir, accounts, { claimTaskWithJobSpec }, []);
      ctx.fetchUri = async () => body;

      const outcome = await processCandidate(ctx, agent, {
        task: TASK,
        creator: CREATOR,
        rewardAmount: REWARD,
        rewardMint: null,
        requiredCapabilities: 1n,
        parentTask: PARENT,
      });
      expect(outcome.status).toBe(
        fixture.retained ? "execution-failed" : "claim-failed",
      );
      const marker = loadState(stateDir).openClaim;
      if (fixture.retained) {
        expect(marker).toMatchObject({
          phase: "claiming",
          claimTransactionSignature: "ambiguous-live-signature",
        });
      } else {
        expect(marker).toBeNull();
      }
    }
  });

  it("startup ledgers a landed submission without executing, uploading, or submitting again", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-restart-"));
    const resultHashHex = sha256Hex(new TextEncoder().encode("already landed"));
    const state = emptyState();
    state.openClaim = {
      task: TASK,
      claimedAt: "2026-07-18T00:00:00.000Z",
      phase: "submitting",
      submission: {
        resultUri: "https://uploads.example/results/private-token",
        resultHashHex,
        rewardAmount: REWARD.toString(),
        preparedAt: "2026-07-18T00:01:00.000Z",
      },
    };
    saveState(stateDir, state);

    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.PendingValidation)],
      [claimPda, claimData(claimPda)],
      [
        submissionPda,
        submissionData(
          claimPda,
          new Uint8Array(Buffer.from(resultHashHex, "hex")),
        ),
      ],
    ]);
    const submitTaskResult = vi.fn(async () => {
      throw new Error("must not resubmit");
    });
    const uploadFetch = vi.fn(async () => {
      throw new Error("must not re-upload");
    });
    const events: WorkerLogEvent[] = [];
    const ctx = context(stateDir, accounts, { submitTaskResult }, events);
    ctx.config.executor = ["/must/not/execute", "{prompt}"];
    ctx.config.resultUploader = "https://uploads.example/secret";
    ctx.uploadFetch = uploadFetch as unknown as typeof fetch;

    const outcome = await resumeOpenClaim(ctx, agent);

    expect(outcome?.status).toBe("submitted");
    expect(submitTaskResult).not.toHaveBeenCalled();
    expect(uploadFetch).not.toHaveBeenCalled();
    const recovered = loadState(stateDir);
    expect(recovered.openClaim).toBeNull();
    expect(recovered.submissions[0]).toMatchObject({
      task: TASK,
      resultHashHex,
      resultUri: "https://uploads.example/results/private-token",
      submissionSignature: null,
    });
  });

  it("does not abandon an ambiguous recent claim merely because one RPC read is null", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-claim-wal-"),
    );
    const state = emptyState();
    state.openClaim = {
      task: TASK,
      claimedAt: new Date().toISOString(),
      phase: "claiming",
    };
    saveState(stateDir, state);
    const accounts = new Map<Address, Uint8Array>();
    const ctx = context(stateDir, accounts, {}, []);

    const pending = await resumeOpenClaim(ctx, agent);
    expect(pending?.status).toBe("execution-failed");
    expect(loadState(stateDir).openClaim?.phase).toBe("claiming");

    const expired = loadState(stateDir);
    expired.openClaim!.claimedAt = "2000-01-01T00:00:00.000Z";
    saveState(stateDir, expired);
    expect(await resumeOpenClaim(ctx, agent)).toBeNull();
    expect(loadState(stateDir).openClaim).toBeNull();
  });

  it("retains every pre-submission WAL phase when claim=null conflicts with an InProgress task", async () => {
    const resultBytes = new TextEncoder().encode("durable output");
    const resultHashHex = sha256Hex(resultBytes);
    for (const phase of [
      "claiming",
      "claimed",
      "executed",
      "uploading",
    ] as const) {
      const stateDir = mkdtempSync(
        path.join(tmpdir(), `agenc-worker-incoherent-${phase}-`),
      );
      const state = emptyState();
      state.openClaim = {
        task: TASK,
        claimedAt: "2000-01-01T00:00:00.000Z",
        phase,
        ...(phase === "executed" || phase === "uploading"
          ? {
              execution: {
                resultBytesBase64: Buffer.from(resultBytes).toString("base64"),
                resultHashHex,
                rewardAmount: REWARD.toString(),
                executedAt: "2026-07-18T00:00:00.000Z",
              },
            }
          : {}),
      };
      saveState(stateDir, state);
      const accounts = new Map<Address, Uint8Array>([
        [TASK, taskData(TaskStatus.InProgress)],
      ]);
      const events: WorkerLogEvent[] = [];
      const ctx = context(stateDir, accounts, {}, events);

      expect((await resumeOpenClaim(ctx, agent))?.status).toBe(
        "execution-failed",
      );
      expect(loadState(stateDir).openClaim?.phase).toBe(phase);
      expect(events.map(({ event }) => event)).toContain(
        "task.chain-state-incoherent",
      );
    }
  });

  it("retains durable execution when reopened/terminal Task state conflicts with a live claim", async () => {
    const resultBytes = new TextEncoder().encode("durable terminal output");
    const resultHashHex = sha256Hex(resultBytes);
    for (const status of [
      TaskStatus.Open,
      TaskStatus.Completed,
      TaskStatus.Cancelled,
    ]) {
      const stateDir = mkdtempSync(
        path.join(tmpdir(), `agenc-worker-live-terminal-claim-${status}-`),
      );
      const state = emptyState();
      state.openClaim = {
        task: TASK,
        claimedAt: "2000-01-01T00:00:00.000Z",
        phase: "executed",
        execution: {
          resultBytesBase64: Buffer.from(resultBytes).toString("base64"),
          resultHashHex,
          rewardAmount: REWARD.toString(),
          executedAt: "2026-07-18T00:00:00.000Z",
        },
      };
      saveState(stateDir, state);
      const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
      const accounts = new Map<Address, Uint8Array>([
        [TASK, taskData(status)],
        [claimPda, claimData(claimPda)],
      ]);
      const events: WorkerLogEvent[] = [];
      const ctx = context(stateDir, accounts, {}, events);

      expect((await resumeOpenClaim(ctx, agent))?.status).toBe(
        "execution-failed",
      );
      expect(loadState(stateDir).openClaim?.phase).toBe("executed");
      expect(events.map(({ event }) => event)).toContain(
        "task.submission-recovery-pending",
      );
    }
  });

  it("retains the WAL when Task and claim are null but a canonical submission remains", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-live-submission-tuple-"),
    );
    const state = emptyState();
    state.openClaim = {
      task: TASK,
      claimedAt: "2000-01-01T00:00:00.000Z",
      phase: "claimed",
    };
    saveState(stateDir, state);
    const proofHash = new Uint8Array(32).fill(8);
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
    const accounts = new Map<Address, Uint8Array>([
      [
        submissionPda,
        submissionData(
          claimPda,
          proofHash,
          SubmissionStatus.Rejected,
          new Uint8Array(32).fill(4),
        ),
      ],
    ]);
    const ctx = context(stateDir, accounts, {}, []);

    expect((await resumeOpenClaim(ctx, agent))?.status).toBe(
      "execution-failed",
    );
    expect(loadState(stateDir).openClaim?.phase).toBe("claimed");
  });

  it("does not treat Open plus a live claim and Rejected submission as terminal", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-open-live-rejected-"),
    );
    const state = emptyState();
    state.openClaim = {
      task: TASK,
      claimedAt: "2026-07-18T00:00:00.000Z",
      phase: "claimed",
    };
    saveState(stateDir, state);
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.Open)],
      [claimPda, claimData(claimPda)],
      [
        submissionPda,
        submissionData(
          claimPda,
          new Uint8Array(32).fill(5),
          SubmissionStatus.Rejected,
          new Uint8Array(32).fill(4),
        ),
      ],
    ]);
    const ctx = context(stateDir, accounts, {}, []);

    expect((await resumeOpenClaim(ctx, agent))?.status).toBe(
      "execution-failed",
    );
    expect(loadState(stateDir).openClaim?.phase).toBe("claimed");
    expect(loadState(stateDir).submissions).toEqual([]);
  });

  it("ledgers a broadcast intent when terminal settlement already closed both child accounts", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-terminal-fast-settlement-"),
    );
    const resultHashHex = sha256Hex(
      new TextEncoder().encode("fast-settled result"),
    );
    const state = emptyState();
    state.openClaim = {
      task: TASK,
      claimedAt: "2026-07-18T00:00:00.000Z",
      phase: "submitting",
      submission: {
        resultUri: `agenc://result/sha256/${resultHashHex}`,
        resultHashHex,
        rewardAmount: REWARD.toString(),
        preparedAt: "2000-01-01T00:00:00.000Z",
        transactionSignature: "fast-settlement-signature",
      },
    };
    saveState(stateDir, state);
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.Completed)],
    ]);
    const ctx = context(stateDir, accounts, {}, []);

    expect((await resumeOpenClaim(ctx, agent))?.status).toBe("submitted");
    expect(loadState(stateDir)).toMatchObject({
      openClaim: null,
      submissions: [
        {
          task: TASK,
          resultHashHex,
          submissionSignature: "fast-settlement-signature",
          settled: false,
        },
      ],
    });
  });

  it("clears every pre-submission WAL phase only with coherent reopened Task evidence", async () => {
    const resultBytes = new TextEncoder().encode("obsolete durable output");
    const resultHashHex = sha256Hex(resultBytes);
    for (const phase of [
      "claiming",
      "claimed",
      "executed",
      "uploading",
    ] as const) {
      const stateDir = mkdtempSync(
        path.join(tmpdir(), `agenc-worker-reopened-${phase}-`),
      );
      const state = emptyState();
      state.openClaim = {
        task: TASK,
        claimedAt: "2000-01-01T00:00:00.000Z",
        phase,
        ...(phase === "executed" || phase === "uploading"
          ? {
              execution: {
                resultBytesBase64: Buffer.from(resultBytes).toString("base64"),
                resultHashHex,
                rewardAmount: REWARD.toString(),
                executedAt: "2026-07-18T00:00:00.000Z",
              },
            }
          : {}),
      };
      saveState(stateDir, state);
      const accounts = new Map<Address, Uint8Array>([
        [TASK, taskData(TaskStatus.Open)],
      ]);
      const ctx = context(stateDir, accounts, {}, []);

      expect(await resumeOpenClaim(ctx, agent)).toBeNull();
      expect(loadState(stateDir).openClaim).toBeNull();
    }
  });

  it("does not retry an ambiguous recent submission until its blockhash can no longer land", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-submit-wal-"),
    );
    const resultHashHex = sha256Hex(
      new TextEncoder().encode("prepared result"),
    );
    const state = emptyState();
    state.openClaim = {
      task: TASK,
      claimedAt: new Date().toISOString(),
      phase: "submitting",
      submission: {
        resultUri: "agenc://result/sha256/prepared",
        resultHashHex,
        rewardAmount: REWARD.toString(),
        preparedAt: new Date().toISOString(),
      },
    };
    saveState(stateDir, state);
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.InProgress)],
    ]);
    const submitTaskResult = vi.fn(async () => ({ signature: "sig-retry" }));
    const ctx = context(stateDir, accounts, { submitTaskResult }, []);

    const pending = await resumeOpenClaim(ctx, agent);
    expect(pending?.status).toBe("execution-failed");
    expect(submitTaskResult).not.toHaveBeenCalled();

    accounts.set(claimPda, claimData(claimPda));
    const expired = loadState(stateDir);
    expired.openClaim!.submission!.preparedAt = "2000-01-01T00:00:00.000Z";
    saveState(stateDir, expired);
    expect((await resumeOpenClaim(ctx, agent))?.status).toBe("submitted");
    expect(submitTaskResult).toHaveBeenCalledTimes(1);
  });

  it("restores request_changes as a live revision round and re-executes/resubmits", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-revision-"));
    const previousHash = new Uint8Array(32).fill(3);
    const previousHashHex = Buffer.from(previousHash).toString("hex");
    const changesEnvelope: taskThread.TaskThreadEnvelope = {
      v: 1,
      taskPda: TASK,
      parentHash: null,
      role: "buyer",
      body: "Please add the missing recovery evidence.",
      attachments: [],
      ts: 1_700_000_200,
    };
    const changesHash = (await taskThread.envelopeHash(changesEnvelope)).bytes;
    const state = emptyState();
    state.submissions.push({
      task: TASK,
      submissionSignature: "previous-submit-signature",
      resultUri: "agenc://result/sha256/previous",
      resultHashHex: previousHashHex,
      rewardAmount: REWARD.toString(),
      submittedAt: "2026-07-18T00:00:00.000Z",
      settled: false,
    });
    saveState(stateDir, state);

    const payload = { title: "revision task", summary: "revise it" };
    const digest = await values.canonicalJobSpecHash(payload);
    const body = new TextEncoder().encode(
      JSON.stringify({
        integrity: {
          algorithm: "sha256",
          canonicalization: "json-stable-v1",
          payloadHash: digest.hex,
        },
        payload,
      }),
    );
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
    const [jobSpecPda] = await findTaskJobSpecPda({ task: TASK });
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.InProgress)],
      [claimPda, claimData(claimPda)],
      [
        submissionPda,
        submissionData(
          claimPda,
          previousHash,
          SubmissionStatus.Rejected,
          changesHash,
        ),
      ],
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
    const submittedHashes: string[] = [];
    const submitTaskResult = vi.fn(
      async (
        input: { proofHash: Uint8Array },
        options: { maxRetries?: number },
      ) => {
        expect(options).toEqual({ maxRetries: 0 });
        submittedHashes.push(Buffer.from(input.proofHash).toString("hex"));
        return { signature: "revision-submit-signature" };
      },
    );
    const events: WorkerLogEvent[] = [];
    const ctx = context(stateDir, accounts, { submitTaskResult }, events);
    ctx.fetchUri = async () => body;
    const threadGet = vi.fn(async () => ({ messages: [changesEnvelope] }));
    ctx.taskThreadTransport = {
      baseUrl: "https://threads.example",
      get: threadGet,
      post: async () => {
        throw new Error("not used");
      },
    };
    ctx.config.executor = [
      process.execPath,
      "-e",
      'process.stdout.write(process.argv[1].includes("missing recovery evidence") ? "revision-used-feedback" : "revision-missed-feedback")',
      "{prompt}",
    ];

    expect(await checkSettlements(ctx, agent)).toEqual([]);
    expect(loadState(stateDir)).toMatchObject({
      openClaim: {
        task: TASK,
        phase: "claimed",
        revisionSubmissionCount: 1,
      },
      submissions: [],
    });

    expect((await resumeOpenClaim(ctx, agent))?.status).toBe("submitted");
    expect(threadGet).toHaveBeenCalledTimes(1);
    expect(submittedHashes).toHaveLength(1);
    expect(submittedHashes[0]).toBe(
      sha256Hex(new TextEncoder().encode("revision-used-feedback")),
    );
    expect(
      events.filter((event) => event.event === "task.revision-requested"),
    ).toHaveLength(1);
  });

  it("does not immediately resend after a signature timeout while RPC still shows the stale Rejected revision", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-revision-ambiguity-"),
    );
    const previousHash = new Uint8Array(32).fill(3);
    const currentBytes = new TextEncoder().encode("current revision result");
    const currentHashHex = sha256Hex(currentBytes);
    const state = emptyState();
    state.openClaim = {
      task: TASK,
      claimedAt: "2026-07-18T00:00:00.000Z",
      phase: "submitting",
      revisionSubmissionCount: 1,
      submission: {
        resultUri: `agenc://result/sha256/${currentHashHex}`,
        resultHashHex: currentHashHex,
        rewardAmount: REWARD.toString(),
        preparedAt: "2000-01-01T00:00:00.000Z",
      },
    };
    saveState(stateDir, state);

    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.InProgress)],
      [claimPda, claimData(claimPda)],
      [
        submissionPda,
        submissionData(claimPda, previousHash, SubmissionStatus.Rejected),
      ],
    ]);
    const submitTaskResult = vi
      .fn()
      .mockRejectedValueOnce(
        new AgencError("confirmation timeout", {
          signature: "ambiguous-revision-signature",
        }),
      )
      .mockResolvedValueOnce({ signature: "revision-retry-signature" });
    const ctx = context(stateDir, accounts, { submitTaskResult }, []);

    expect((await resumeOpenClaim(ctx, agent))?.status).toBe(
      "execution-failed",
    );
    expect(submitTaskResult).toHaveBeenCalledTimes(1);
    const timedOutIntent = loadState(stateDir).openClaim?.submission;
    expect(timedOutIntent).toMatchObject({
      transactionSignature: "ambiguous-revision-signature",
    });
    expect(
      Date.now() - Date.parse(timedOutIntent!.lastBroadcastAt!),
    ).toBeLessThan(30_000);

    expect((await resumeOpenClaim(ctx, agent))?.status).toBe(
      "execution-failed",
    );
    expect(submitTaskResult).toHaveBeenCalledTimes(1);

    const retryable = loadState(stateDir);
    retryable.openClaim!.submission!.lastBroadcastAt =
      "2000-01-01T00:00:00.000Z";
    saveState(stateDir, retryable);
    expect((await resumeOpenClaim(ctx, agent))?.status).toBe("submitted");
    expect(submitTaskResult).toHaveBeenCalledTimes(2);
  });

  it("does not mistake an equal-hash Submitted account from the prior revision for the current round", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-revision-round-binding-"),
    );
    const resultHash = new Uint8Array(32).fill(6);
    const resultHashHex = Buffer.from(resultHash).toString("hex");
    const state = emptyState();
    state.openClaim = {
      task: TASK,
      claimedAt: "2026-07-18T00:00:00.000Z",
      phase: "submitting",
      revisionSubmissionCount: 1,
      submission: {
        resultUri: `agenc://result/sha256/${resultHashHex}`,
        resultHashHex,
        rewardAmount: REWARD.toString(),
        preparedAt: "2000-01-01T00:00:00.000Z",
      },
    };
    saveState(stateDir, state);
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.PendingValidation)],
      [claimPda, claimData(claimPda)],
      [
        submissionPda,
        submissionData(
          claimPda,
          resultHash,
          SubmissionStatus.Submitted,
          new Uint8Array(32),
          1,
        ),
      ],
    ]);
    const submitTaskResult = vi.fn(async () => ({
      signature: "must-not-send",
    }));
    const ctx = context(stateDir, accounts, { submitTaskResult }, []);

    expect((await resumeOpenClaim(ctx, agent))?.status).toBe(
      "execution-failed",
    );
    expect(submitTaskResult).not.toHaveBeenCalled();
    expect(loadState(stateDir).openClaim?.phase).toBe("submitting");
    expect(loadState(stateDir).submissions).toEqual([]);

    accounts.set(
      submissionPda,
      submissionData(
        claimPda,
        resultHash,
        SubmissionStatus.Submitted,
        new Uint8Array(32),
        2,
      ),
    );
    expect((await resumeOpenClaim(ctx, agent))?.status).toBe("submitted");
    expect(loadState(stateDir).openClaim).toBeNull();
    expect(loadState(stateDir).submissions).toHaveLength(1);
  });

  it("does not restore a prior-round Submitted account over an unexecuted revision marker", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-revision-unexecuted-round-"),
    );
    const previousHash = new Uint8Array(32).fill(7);
    const state = emptyState();
    state.openClaim = {
      task: TASK,
      claimedAt: "2026-07-18T00:00:00.000Z",
      phase: "claimed",
      revisionSubmissionCount: 1,
    };
    saveState(stateDir, state);
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.PendingValidation)],
      [claimPda, claimData(claimPda)],
      [submissionPda, submissionData(claimPda, previousHash)],
    ]);
    const ctx = context(stateDir, accounts, {}, []);

    expect((await resumeOpenClaim(ctx, agent))?.status).toBe(
      "execution-failed",
    );
    expect(loadState(stateDir).openClaim).toMatchObject({
      phase: "claimed",
      revisionSubmissionCount: 1,
    });
    expect(loadState(stateDir).submissions).toEqual([]);
  });

  it("fails a revision closed when its anchored change-request envelope cannot be resolved", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-revision-feedback-missing-"),
    );
    const state = emptyState();
    state.openClaim = {
      task: TASK,
      claimedAt: "2026-07-18T00:00:00.000Z",
      phase: "claimed",
      revisionSubmissionCount: 1,
    };
    saveState(stateDir, state);
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.InProgress)],
      [claimPda, claimData(claimPda)],
      [
        submissionPda,
        submissionData(
          claimPda,
          new Uint8Array(32).fill(3),
          SubmissionStatus.Rejected,
          new Uint8Array(32).fill(4),
        ),
      ],
    ]);
    const events: WorkerLogEvent[] = [];
    const submitTaskResult = vi.fn();
    const ctx = context(stateDir, accounts, { submitTaskResult }, events);
    ctx.config.executor = ["/must/not/execute", "{prompt}"];

    expect((await resumeOpenClaim(ctx, agent))?.status).toBe(
      "execution-failed",
    );
    expect(submitTaskResult).not.toHaveBeenCalled();
    expect(loadState(stateDir).openClaim?.phase).toBe("claimed");
    expect(events.map(({ event }) => event)).toContain(
      "task.revision-feedback-unavailable",
    );
  });

  it("recovers executed/uploading phases from private stdout without rerunning the executor", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-executed-"));
    const resultBytes = new TextEncoder().encode("persisted executor stdout");
    const resultHashHex = sha256Hex(resultBytes);
    const state = emptyState();
    state.openClaim = {
      task: TASK,
      claimedAt: "2026-07-18T00:00:00.000Z",
      phase: "executed",
      execution: {
        resultBytesBase64: Buffer.from(resultBytes).toString("base64"),
        resultHashHex,
        rewardAmount: REWARD.toString(),
        executedAt: "2026-07-18T00:01:00.000Z",
      },
    };
    saveState(stateDir, state);
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.InProgress)],
      [claimPda, claimData(claimPda)],
    ]);
    const uploadedBodies: Uint8Array[] = [];
    const idempotencyKeys: string[] = [];
    let uploadAttempt = 0;
    const uploadFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      uploadedBodies.push(new Uint8Array(init?.body as ArrayBuffer));
      idempotencyKeys.push(new Headers(init?.headers).get("idempotency-key")!);
      uploadAttempt += 1;
      if (uploadAttempt === 1) throw new Error("ambiguous upload failure");
      return new Response(
        JSON.stringify({ uri: "https://results.example/private/token" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const submitTaskResult = vi.fn(async () => ({ signature: "sig-uploaded" }));
    const events: WorkerLogEvent[] = [];
    const ctx = context(stateDir, accounts, { submitTaskResult }, events);
    ctx.config.executor = ["/must/not/execute", "{prompt}"];
    ctx.config.resultUploader = "https://uploads.example/private-token";
    ctx.uploadFetch = uploadFetch as unknown as typeof fetch;

    expect((await resumeOpenClaim(ctx, agent))?.status).toBe(
      "execution-failed",
    );
    expect(loadState(stateDir).openClaim?.phase).toBe("uploading");
    expect((await resumeOpenClaim(ctx, agent))?.status).toBe("submitted");

    expect(uploadFetch).toHaveBeenCalledTimes(2);
    expect(uploadedBodies).toEqual([resultBytes, resultBytes]);
    expect(idempotencyKeys).toEqual([resultHashHex, resultHashHex]);
    expect(submitTaskResult).toHaveBeenCalledTimes(1);
    expect(events.every((event) => !("resultUri" in event))).toBe(true);
  });
});

describe("settlement evidence coherence", () => {
  function pendingState(stateDir: string, submittedAt: string): string {
    const resultHashHex = sha256Hex(new TextEncoder().encode("pending result"));
    const state = emptyState();
    state.totalEarnedBaseline = "50";
    state.submissions.push({
      task: TASK,
      submissionSignature: "pending-signature",
      resultUri: "agenc://result/sha256/pending",
      resultHashHex,
      rewardAmount: REWARD.toString(),
      submittedAt,
      settled: false,
    });
    saveState(stateDir, state);
    return resultHashHex;
  }

  it("does not terminalize an old record from a lone null Task read", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-settlement-null-"),
    );
    pendingState(stateDir, "2000-01-01T00:00:00.000Z");
    const ctx = context(stateDir, new Map(), {}, []);

    expect(await checkSettlements(ctx, agent)).toEqual([]);
    expect(loadState(stateDir).submissions[0]?.settled).toBe(false);
    expect(loadState(stateDir).totalEarnedBaseline).toBe("50");
  });

  it("does not call a transient Open task rejected while its canonical submission is Submitted", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-settlement-open-"),
    );
    const resultHashHex = pendingState(stateDir, "2000-01-01T00:00:00.000Z");
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.Open)],
      [claimPda, claimData(claimPda)],
      [
        submissionPda,
        submissionData(
          claimPda,
          new Uint8Array(Buffer.from(resultHashHex, "hex")),
        ),
      ],
    ]);
    const ctx = context(stateDir, accounts, {}, []);

    expect(await checkSettlements(ctx, agent)).toEqual([]);
    expect(loadState(stateDir).submissions[0]?.settled).toBe(false);

    accounts.set(
      submissionPda,
      submissionData(
        claimPda,
        new Uint8Array(Buffer.from(resultHashHex, "hex")),
        SubmissionStatus.Rejected,
      ),
    );
    expect(await checkSettlements(ctx, agent)).toEqual([]);
    expect(loadState(stateDir).submissions[0]?.settled).toBe(false);

    accounts.delete(claimPda);
    const reports = await checkSettlements(ctx, agent);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.outcome).toBe("rejected");
  });

  it("does not call a Completed Collaborative straggler accepted while its submission is still Submitted", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-settlement-straggler-"),
    );
    const resultHashHex = pendingState(stateDir, "2000-01-01T00:00:00.000Z");
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
    const accounts = new Map<Address, Uint8Array>([
      [
        TASK,
        taskData(TaskStatus.Completed, {
          taskType: TaskType.Collaborative,
          maxWorkers: 2,
          currentWorkers: 1,
          completions: 1,
          requiredCompletions: 1,
        }),
      ],
      [claimPda, claimData(claimPda)],
      [
        submissionPda,
        submissionData(
          claimPda,
          new Uint8Array(Buffer.from(resultHashHex, "hex")),
        ),
      ],
      [WORKER, agentRegistrationData(150n)],
    ]);
    const events: WorkerLogEvent[] = [];
    const ctx = context(stateDir, accounts, {}, events);

    expect(await checkSettlements(ctx, agent)).toEqual([]);
    expect(loadState(stateDir).submissions[0]?.settled).toBe(false);
    expect(loadState(stateDir).submissions[0]?.terminalEvidence).toBe(
      "collaborative-straggler",
    );
    expect(loadState(stateDir).totalEarnedBaseline).toBe("50");
    expect(events.map(({ event }) => event)).toContain(
      "settlement.terminal-submission-pending",
    );

    accounts.delete(claimPda);
    accounts.delete(submissionPda);
    const reports = await checkSettlements(ctx, agent);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      outcome: "straggler",
      earnedLamports: 0n,
    });
    expect(loadState(stateDir).totalEarnedBaseline).toBe("50");
  });

  it("does not misread a just-landed record plus stale Rejected account as a new revision", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-settlement-fresh-revision-"),
    );
    const resultHashHex = pendingState(stateDir, new Date().toISOString());
    const [claimPda] = await findClaimPda({ task: TASK, bidder: WORKER });
    const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.InProgress)],
      [claimPda, claimData(claimPda)],
      [
        submissionPda,
        submissionData(
          claimPda,
          new Uint8Array(Buffer.from(resultHashHex, "hex")),
          SubmissionStatus.Rejected,
        ),
      ],
    ]);
    const ctx = context(stateDir, accounts, {}, []);

    expect(await checkSettlements(ctx, agent)).toEqual([]);
    expect(loadState(stateDir).openClaim).toBeNull();
    expect(loadState(stateDir).submissions).toHaveLength(1);

    const aged = loadState(stateDir);
    aged.submissions[0]!.submittedAt = "2000-01-01T00:00:00.000Z";
    saveState(stateDir, aged);
    expect(await checkSettlements(ctx, agent)).toEqual([]);
    expect(loadState(stateDir).openClaim?.phase).toBe("claimed");
    expect(loadState(stateDir).submissions).toHaveLength(0);
  });

  it("does not infer an SPL-token acceptance from Completed plus absent child accounts", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-settlement-spl-evidence-"),
    );
    pendingState(stateDir, "2000-01-01T00:00:00.000Z");
    const accounts = new Map<Address, Uint8Array>([
      [
        TASK,
        taskData(TaskStatus.Completed, {
          rewardMint: PARENT,
        }),
      ],
      [WORKER, agentRegistrationData(150n)],
    ]);
    const ctx = context(stateDir, accounts, {}, []);

    expect(await checkSettlements(ctx, agent)).toEqual([]);
    expect(loadState(stateDir).submissions[0]?.settled).toBe(false);
    expect(loadState(stateDir).totalEarnedBaseline).toBe("50");
  });

  it("defers paid settlement while AgentRegistration is transiently null without resetting its baseline", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-settlement-agent-null-"),
    );
    pendingState(stateDir, "2000-01-01T00:00:00.000Z");
    const accounts = new Map<Address, Uint8Array>([
      [TASK, taskData(TaskStatus.Completed)],
    ]);
    const ctx = context(stateDir, accounts, {}, []);

    expect(await checkSettlements(ctx, agent)).toEqual([]);
    expect(loadState(stateDir).totalEarnedBaseline).toBe("50");
    expect(loadState(stateDir).submissions[0]?.settled).toBe(false);

    accounts.set(WORKER, agentRegistrationData(50n));
    expect(await checkSettlements(ctx, agent)).toEqual([]);
    expect(loadState(stateDir).totalEarnedBaseline).toBe("50");
    expect(loadState(stateDir).submissions[0]?.settled).toBe(false);

    accounts.set(WORKER, agentRegistrationData(25n));
    expect(await checkSettlements(ctx, agent)).toEqual([]);
    expect(loadState(stateDir).totalEarnedBaseline).toBe("50");
    expect(loadState(stateDir).submissions[0]?.settled).toBe(false);

    accounts.set(WORKER, agentRegistrationData(150n));
    const reports = await checkSettlements(ctx, agent);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.earnedLamports).toBe(100n);
    expect(loadState(stateDir).totalEarnedBaseline).toBe("150");
  });
});

describe("dependent-task discovery", () => {
  it("preserves the decoded dependsOn account in claim candidates", async () => {
    const digest = new Uint8Array(32).fill(7);
    const [jobSpecPda] = await findTaskJobSpecPda({ task: TASK });
    const taskRow = { address: TASK, data: taskData(TaskStatus.Open) };
    const specRow = {
      address: jobSpecPda,
      data: new Uint8Array(
        getTaskJobSpecEncoder().encode({
          task: TASK,
          creator: CREATOR,
          jobSpecHash: digest,
          jobSpecUri: SPEC_URI,
          createdAt: 1n,
          updatedAt: 1n,
          bump: 248,
          reserved: new Uint8Array(7),
        }),
      ),
    };
    const transport: ProgramAccountsTransport = {
      async getProgramAccounts({ filters }) {
        const discriminator = filters.find(
          (
            filter,
          ): filter is { memcmp: { offset: number; bytes: Uint8Array } } =>
            "memcmp" in filter && filter.memcmp.offset === 0,
        );
        if (discriminator === undefined) return [];
        if (
          Buffer.from(discriminator.memcmp.bytes).equals(
            Buffer.from(TASK_DISCRIMINATOR),
          )
        ) {
          return [taskRow];
        }
        if (
          Buffer.from(discriminator.memcmp.bytes).equals(
            Buffer.from(TASK_JOB_SPEC_DISCRIMINATOR),
          )
        ) {
          return [specRow];
        }
        return [];
      },
    };
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-dependent-"),
    );
    const ctx = context(stateDir, new Map(), {}, []);
    ctx.gpa = transport;

    const candidates = await listClaimCandidates(ctx, emptyState());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.parentTask).toBe(PARENT);
  });
});
