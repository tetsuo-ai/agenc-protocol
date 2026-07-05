// REAL on-chain worker loop against the compiled agenc-coordination program
// (litesvm): a creator registers + creates + activates a CreatorReview task
// (driven through the SDK facade, mirroring the SDK's client.e2e suite), then
// ONE programmatic worker tick — with the executor stubbed to `node -e` —
// registers the worker agent, sweeps, verifies the job spec against its
// on-chain hash, claims (asserted at InProgress), executes, and submits.
// The creator then accepts and the settlement check reports the earnings.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import {
  createMarketplaceClient,
  facade,
  findAgentPda,
  findClaimPda,
  findTaskPda,
  findHireRecordPda,
  findTaskJobSpecPda,
  findTaskSubmissionPda,
  getAgentRegistrationDecoder,
  getTaskDecoder,
  getTaskSubmissionDecoder,
  SubmissionStatus,
  TaskStatus,
} from "@tetsuo-ai/marketplace-sdk";
import {
  checkSettlements,
  runTickOnce,
  type WorkerContext,
  type WorkerLogEvent,
} from "../src/runtime.js";
import { hexToBytes, loadState } from "../src/state.js";
import { sha256, sha256Hex } from "../src/result.js";
import {
  accountData,
  freshSvm,
  fundedSigner,
  seedModerationConfig,
  seedProtocolConfig,
} from "./harness.js";
import { createLiteSvmTransport } from "./litesvm-transport.js";
import { GpaSimulator } from "./gpa-sim.js";

const SPEC_BODY = new TextEncoder().encode(
  '{"title":"haiku","summary":"write a haiku about solana on stdout"}',
);

/**
 * The on-chain 64-byte description is a CONTENT-HASH COMMITMENT (sha256 of the
 * task content in bytes 0..32, zero tail — enforced by
 * `validate_description_is_content_hash`), never readable text.
 */
function descriptionCommitment(content: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  out.set(sha256(content), 0);
  return out;
}

describe("e2e: one worker tick against the real program", () => {
  it("registers, sweeps, verifies the job spec, claims, executes, submits — then settles on accept", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    const modAuth = await fundedSigner(svm);
    const creator = await fundedSigner(svm);
    const workerWallet = await fundedSigner(svm);
    // Live-mainnet-shaped config: registration REQUIRES a nonzero stake, so
    // this run proves against the real program that the worker reads the
    // on-chain minimum and stakes exactly that (the 0.1.0 hardcoded 0n
    // reverted here with InsufficientStake).
    const MIN_AGENT_STAKE = 10_000_000n;
    await seedProtocolConfig(svm, admin.address, { minAgentStake: MIN_AGENT_STAKE });
    await seedModerationConfig(svm, admin.address, modAuth.address, true);

    const transport = createLiteSvmTransport(svm);
    const creatorClient = createMarketplaceClient({ transport, signer: creator });
    const modClient = createMarketplaceClient({ transport, signer: modAuth });
    const workerClient = createMarketplaceClient({ transport, signer: workerWallet });

    // ---- CREATOR SIDE (sdk facade, mirroring client.e2e.test.ts) ----
    const creatorAgentId = new Uint8Array(32).fill(7);
    await creatorClient.registerAgent({
      authority: creator,
      agentId: creatorAgentId,
      capabilities: 1n,
      endpoint: "http://creator.test",
      metadataUri: null,
      stakeAmount: MIN_AGENT_STAKE,
    });
    const [creatorAgent] = await findAgentPda({ agentId: creatorAgentId });

    const taskId = new Uint8Array(32).fill(9);
    const reward = 2_000_000n;
    const now = svm.getClock().unixTimestamp;
    await creatorClient.send([
      await facade.createTask({
        authority: creator,
        creator,
        creatorAgent,
        taskId,
        requiredCapabilities: 1n,
        description: descriptionCommitment(SPEC_BODY),
        rewardAmount: reward,
        maxWorkers: 1,
        deadline: now + 3600n,
        taskType: 0,
        constraintHash: null,
        minReputation: 0,
        rewardMintArg: null,
      }),
    ]);
    const [task] = await findTaskPda({ creator: creator.address, taskId });
    const [hireRecord] = await findHireRecordPda({ task });
    await creatorClient.send([
      await facade.configureTaskValidation({
        task,
        creator,
        hireRecord,
        mode: 1, // CreatorReview
        reviewWindowSecs: 3600n,
        validatorQuorum: 0,
        attestor: null,
      }),
    ]);

    // Moderate + pin the REAL sha256 of the job-spec body, so the worker's
    // fetch+verify path runs the genuine hash check (not the agenc:// bypass).
    const jobSpecHash = sha256(SPEC_BODY);
    const jobSpecUri = "https://specs.example/haiku.json";
    await modClient.send([
      await facade.recordTaskModeration({
        task,
        moderator: modAuth,
        jobSpecHash,
        status: 0, // CLEAN
        riskScore: 0,
        categoryMask: 0n,
        policyHash: new Uint8Array(32).fill(1),
        scannerHash: new Uint8Array(32).fill(2),
        expiresAt: 0n,
      }),
    ]);
    await creatorClient.setTaskJobSpec({
      task,
      creator,
      jobSpecHash,
      jobSpecUri,
      moderator: modAuth.address,
    });
    const [taskJobSpec] = await findTaskJobSpecPda({ task });

    // ---- WORKER SIDE (this package's runtime, one programmatic tick) ----
    const gpa = new GpaSimulator(svm);
    gpa.register(task, taskJobSpec);

    const events: WorkerLogEvent[] = [];
    // Snapshot the on-chain task status at the exact moment the claim lands
    // (the log hook fires synchronously after claim confirmation, before the
    // executor runs).
    let statusAtClaim: TaskStatus | null = null;
    const log = (event: WorkerLogEvent) => {
      events.push(event);
      if (event.event === "task.claimed") {
        statusAtClaim = getTaskDecoder().decode(accountData(svm, task)!).status;
      }
    };

    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-e2e-"));
    const ctx: WorkerContext = {
      config: {
        capabilities: 1n,
        minRewardLamports: 0n,
        maxRewardLamports: 10_000_000n,
        executor: [process.execPath, "-e", 'console.log("result")', "{prompt}"],
        resultUploader: null,
        creatorAllowlist: null,
        endpoint: "http://worker.test",
        executorTimeoutMs: 60_000,
        pollIntervalMs: 1_000,
      },
      client: workerClient,
      signer: workerWallet,
      gpa,
      readAccount: async (addr) => accountData(svm, addr),
      stateDir,
      log,
      fetchUri: async (uri) => {
        expect(uri).toBe(jobSpecUri);
        return SPEC_BODY;
      },
      // Exercises the pre-registration funding preflight (the wallet is
      // funded well past the requirement, so registration proceeds).
      getBalance: async (addr) => svm.getBalance(addr) ?? 0n,
    };

    const tick = await runTickOnce(ctx);

    // The tick claimed exactly this task and submitted a result.
    expect(tick.outcome?.status).toBe("submitted");
    expect(tick.outcome?.task).toBe(task);

    // The claim LANDED on-chain: at claim time the task was InProgress.
    expect(statusAtClaim).toBe(TaskStatus.InProgress);

    // Worker agent was registered on-chain by ensureRegistered.
    const state = loadState(stateDir);
    expect(state.agentIdHex).not.toBeNull();
    const [workerAgent] = await findAgentPda({
      agentId: hexToBytes(state.agentIdHex!),
    });
    const registration = getAgentRegistrationDecoder().decode(
      accountData(svm, workerAgent)!,
    );
    expect(registration.authority).toBe(workerWallet.address);
    // The worker staked EXACTLY the live on-chain minimum, recorded in the
    // agent account by the real program.
    expect(registration.stake).toBe(MIN_AGENT_STAKE);
    const registeredEvent = events.find((e) => e.event === "agent.registered");
    expect(registeredEvent).toBeDefined();
    expect(registeredEvent!.stakedLamports).toBe(MIN_AGENT_STAKE.toString());

    // The submission account EXISTS on-chain with our proof hash: sha256 of
    // the executor stdout (`console.log("result")` emits "result\n").
    const expectedStdout = new TextEncoder().encode("result\n");
    const expectedHashHex = sha256Hex(expectedStdout);
    const [claim] = await findClaimPda({ task, bidder: workerAgent });
    const [submission] = await findTaskSubmissionPda({ claim });
    const submitted = getTaskSubmissionDecoder().decode(
      accountData(svm, submission)!,
    );
    expect(submitted.task).toBe(task);
    expect(submitted.worker).toBe(workerAgent);
    expect(submitted.status).toBe(SubmissionStatus.Submitted);
    expect(Array.from(submitted.proofHash)).toEqual(
      Array.from(sha256(expectedStdout)),
    );
    expect(new TextDecoder().decode(new Uint8Array(submitted.resultData))).toBe(
      expectedHashHex,
    );
    expect(getTaskDecoder().decode(accountData(svm, task)!).status).toBe(
      TaskStatus.PendingValidation,
    );

    // Local ledger: one unsettled submission, no open claim held.
    expect(state.openClaim).toBeNull();
    expect(state.submissions).toHaveLength(1);
    expect(state.submissions[0]!.task).toBe(task);
    expect(state.submissions[0]!.resultHashHex).toBe(expectedHashHex);
    expect(state.submissions[0]!.resultUri).toBe(
      `agenc://result/sha256/${expectedHashHex}`,
    );
    expect(state.submissions[0]!.settled).toBe(false);

    // Before acceptance no settlement is observed.
    expect(tick.settlements).toHaveLength(0);

    // ---- CREATOR ACCEPTS (facade) → the worker gets paid ----
    const workerBalanceBefore = svm.getBalance(workerWallet.address) ?? 0n;
    await creatorClient.acceptTaskResult({
      task,
      worker: workerAgent,
      creator,
      treasury: admin.address,
      workerAuthority: workerWallet.address,
    });
    expect(getTaskDecoder().decode(accountData(svm, task)!).status).toBe(
      TaskStatus.Completed,
    );
    const workerBalanceAfter = svm.getBalance(workerWallet.address) ?? 0n;
    expect(workerBalanceAfter).toBeGreaterThan(workerBalanceBefore);

    // ---- SETTLEMENT OBSERVED: earnings reported from the on-chain delta ----
    const agent = {
      agentId: hexToBytes(state.agentIdHex!),
      agentPda: workerAgent,
      registered: true,
      justRegistered: false,
    };
    const reports = await checkSettlements(ctx, agent);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.task).toBe(task);
    expect(reports[0]!.outcome).toBe("accepted");
    // protocolFeeBps is 100 (1%) in the seeded config: 2_000_000 - 20_000.
    expect(reports[0]!.earnedLamports).toBe(1_980_000n);
    // No signature lookup wired (litesvm has no signature index): the report
    // falls back to earnings + task PDA.
    expect(reports[0]!.receiptUrl).toBeNull();
    const settledEvent = events.find((e) => e.event === "settlement.observed");
    expect(settledEvent?.message).toBe(`earned 0.00198 SOL — task ${task}`);

    const after = loadState(stateDir);
    expect(after.submissions[0]!.settled).toBe(true);
    expect(after.submissions[0]!.outcome).toBe("accepted");
    expect(after.submissions[0]!.earnedLamports).toBe("1980000");

    // Idempotent: a second check observes nothing new.
    expect(await checkSettlements(ctx, agent)).toHaveLength(0);
  });

  it("fails closed end-to-end: a job spec whose content mismatches the pinned hash is never claimed", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    const modAuth = await fundedSigner(svm);
    const creator = await fundedSigner(svm);
    const workerWallet = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);
    await seedModerationConfig(svm, admin.address, modAuth.address, true);

    const transport = createLiteSvmTransport(svm);
    const creatorClient = createMarketplaceClient({ transport, signer: creator });
    const modClient = createMarketplaceClient({ transport, signer: modAuth });
    const workerClient = createMarketplaceClient({ transport, signer: workerWallet });

    const creatorAgentId = new Uint8Array(32).fill(21);
    await creatorClient.registerAgent({
      authority: creator,
      agentId: creatorAgentId,
      capabilities: 1n,
      endpoint: "http://creator2.test",
      metadataUri: null,
      stakeAmount: 0n,
    });
    const [creatorAgent] = await findAgentPda({ agentId: creatorAgentId });

    const taskId = new Uint8Array(32).fill(22);
    const now = svm.getClock().unixTimestamp;
    await creatorClient.send([
      await facade.createTask({
        authority: creator,
        creator,
        creatorAgent,
        taskId,
        requiredCapabilities: 1n,
        description: descriptionCommitment(SPEC_BODY),
        rewardAmount: 1_000_000n,
        maxWorkers: 1,
        deadline: now + 3600n,
        taskType: 0,
        constraintHash: null,
        minReputation: 0,
        rewardMintArg: null,
      }),
    ]);
    const [task] = await findTaskPda({ creator: creator.address, taskId });
    const jobSpecHash = sha256(SPEC_BODY);
    await modClient.send([
      await facade.recordTaskModeration({
        task,
        moderator: modAuth,
        jobSpecHash,
        status: 0,
        riskScore: 0,
        categoryMask: 0n,
        policyHash: new Uint8Array(32).fill(3),
        scannerHash: new Uint8Array(32).fill(4),
        expiresAt: 0n,
      }),
    ]);
    await creatorClient.setTaskJobSpec({
      task,
      creator,
      jobSpecHash,
      jobSpecUri: "https://specs.example/swapped.json",
      moderator: modAuth.address,
    });
    const [taskJobSpec] = await findTaskJobSpecPda({ task });

    const gpa = new GpaSimulator(svm);
    gpa.register(task, taskJobSpec);
    const events: WorkerLogEvent[] = [];
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-e2e-"));
    const ctx: WorkerContext = {
      config: {
        capabilities: 1n,
        minRewardLamports: 0n,
        maxRewardLamports: null,
        executor: [process.execPath, "-e", 'console.log("never runs")', "{prompt}"],
        resultUploader: null,
        creatorAllowlist: null,
        endpoint: "http://worker2.test",
        executorTimeoutMs: 60_000,
        pollIntervalMs: 1_000,
      },
      client: workerClient,
      signer: workerWallet,
      gpa,
      readAccount: async (addr: Address) => accountData(svm, addr),
      stateDir,
      log: (event) => events.push(event),
      // The host serves DIFFERENT bytes than the creator pinned on-chain.
      fetchUri: async () =>
        new TextEncoder().encode('{"title":"swapped","summary":"malicious"}'),
    };

    const tick = await runTickOnce(ctx);
    expect(tick.outcome?.status).toBe("skipped");
    expect(
      events.some(
        (e) =>
          e.event === "task.job-spec-rejected" &&
          String(e.reason).includes("hash mismatch"),
      ),
    ).toBe(true);
    // Nothing was claimed on-chain: the task is still Open with 0 workers.
    const decoded = getTaskDecoder().decode(accountData(svm, task)!);
    expect(decoded.status).toBe(TaskStatus.Open);
    expect(decoded.currentWorkers).toBe(0);
    expect(loadState(stateDir).openClaim).toBeNull();
    expect(loadState(stateDir).submissions).toHaveLength(0);
  });
});
