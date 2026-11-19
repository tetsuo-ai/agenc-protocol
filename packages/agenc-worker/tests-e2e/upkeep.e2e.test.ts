// The worker looks after its own jobs against the REAL compiled program
// (litesvm): a delivery whose buyer never reviews it is auto-accepted by the
// worker itself once the review window has passed, so it is paid; and the
// claim of a job it gave up is expired by the worker once its time is over,
// so the claim's rent comes back and its active-task slot is free again.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lamports, type Address, type KeyPairSigner } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  createMarketplaceClient,
  facade,
  findAgentPda,
  findClaimPda,
  findExpireClaimAgentStatsPda,
  getAgentStatsDecoder,
  getAgentStatsEncoder,
  findHireRecordPda,
  findTaskJobSpecPda,
  findTaskPda,
  getAgentRegistrationDecoder,
  getTaskDecoder,
  TaskStatus,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import {
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

const ENCODER = new TextEncoder();
const FEE = 5_000n;
const PAYLOAD = { title: "Write a line", summary: "write one friendly line on stdout" };
const CANONICAL = ENCODER.encode(values.canonicalJobSpecJson(PAYLOAD));
const SPEC_HASH = sha256(CANONICAL);
const SPEC_BODY = ENCODER.encode(
  JSON.stringify({
    integrity: { algorithm: "sha256", canonicalization: "json-stable-v1", payloadHash: sha256Hex(CANONICAL) },
    payload: PAYLOAD,
  }),
);
const REWARD = 2_000_000n;
const REVIEW_WINDOW_SECS = 3_600n;
const DEADLINE_SECS = 1_800n;

/** One CreatorReview task with a pinned job spec, and a worker set up to take it. */
async function world(executor: string[], config: Partial<WorkerContext["config"]> = {}) {
  const svm = freshSvm();
  const admin = await fundedSigner(svm);
  const modAuth = await fundedSigner(svm);
  const creator = await fundedSigner(svm);
  const workerWallet = await fundedSigner(svm);
  await seedProtocolConfig(svm, admin.address, { minAgentStake: 10_000_000n });
  await seedModerationConfig(svm, admin.address, modAuth.address, true);
  const transport = createLiteSvmTransport(svm);
  const creatorClient = createMarketplaceClient({ transport, signer: creator });
  const modClient = createMarketplaceClient({ transport, signer: modAuth });

  const creatorAgentId = new Uint8Array(32).fill(7);
  await creatorClient.registerAgent({
    authority: creator,
    agentId: creatorAgentId,
    capabilities: 1n,
    endpoint: "http://creator.test",
    metadataUri: null,
    stakeAmount: 10_000_000n,
  });
  const [creatorAgent] = await findAgentPda({ agentId: creatorAgentId });
  const taskId = new Uint8Array(32).fill(9);
  await creatorClient.send([
    await facade.createTask({
      authority: creator,
      creator,
      creatorAgent,
      taskId,
      requiredCapabilities: 1n,
      description: (() => {
        const out = new Uint8Array(64);
        out.set(SPEC_HASH, 0);
        return out;
      })(),
      rewardAmount: REWARD,
      maxWorkers: 1,
      deadline: svm.getClock().unixTimestamp + DEADLINE_SECS,
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
      reviewWindowSecs: REVIEW_WINDOW_SECS,
      validatorQuorum: 0,
      attestor: null,
    }),
  ]);
  await modClient.send([
    await facade.recordTaskModeration({
      task,
      moderator: modAuth,
      jobSpecHash: SPEC_HASH,
      status: 0,
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
    jobSpecHash: SPEC_HASH,
    jobSpecUri: "https://specs.example/line.json",
    moderator: modAuth.address,
  });
  const [taskJobSpec] = await findTaskJobSpecPda({ task });
  const gpa = new GpaSimulator(svm);
  gpa.register(task, taskJobSpec);

  const events: WorkerLogEvent[] = [];
  const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-upkeep-"));
  const ctx: WorkerContext = {
    config: {
      capabilities: 1n,
      minRewardLamports: 0n,
      maxRewardLamports: 10_000_000n,
      allowUnboundedReward: false,
      executor,
      executorMode: "sandboxed",
      executorEnvAllowlist: [],
      resultUploader: null,
      creatorAllowlist: null,
      allowAnyCreator: true,
      endpoint: "http://worker.test",
      executorTimeoutMs: 60_000,
      pollIntervalMs: 1_000,
      ...config,
    },
    client: createMarketplaceClient({ transport, signer: workerWallet }),
    signer: workerWallet,
    gpa,
    readAccount: async (addr) => accountData(svm, addr),
    stateDir,
    log: (event) => events.push(event),
    fetchUri: async () => SPEC_BODY,
    getBalance: async (addr) => svm.getBalance(addr) ?? 0n,
    getMinimumBalanceForRentExemption: async (space) =>
      svm.minimumBalanceForRentExemption(BigInt(space)),
  };
  const advance = (seconds: bigint) => {
    const clock = svm.getClock();
    clock.unixTimestamp += seconds;
    svm.setClock(clock);
    svm.expireBlockhash();
  };
  const workerAgent = async () => {
    const [agentPda] = await findAgentPda({ agentId: hexToBytes(loadState(stateDir).agentIdHex!) });
    return agentPda;
  };
  return { svm, ctx, events, stateDir, task, creator: creator as KeyPairSigner, workerWallet, advance, workerAgent };
}

/** An agent's record of turn-downs and lapses, as if someone had started it. */
function seedRecord(svm: ReturnType<typeof freshSvm>, record: Address, agent: Address, bump: number): void {
  const data = new Uint8Array(
    getAgentStatsEncoder().encode({
      agent,
      tasksRejected: 0n,
      disputesWon: 0n,
      disputesLost: 0n,
      claimsExpired: 0n,
      totalCancelled: 0n,
      lastUpdated: 0n,
      bump,
      reserved: new Uint8Array(32),
    }),
  );
  svm.setAccount({
    address: record,
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
    space: BigInt(data.length),
  });
}

describe("e2e: a worker looks after its own jobs", () => {
  it("auto-accepts its delivery once the buyer has let the review window pass, and is paid", async () => {
    const w = await world([process.execPath, "-e", "process.stdout.write('Here is your line.')", "{prompt}"]);
    const first = await runTickOnce(w.ctx);
    expect(first.outcome?.status).toBe("submitted");
    expect(getTaskDecoder().decode(accountData(w.svm, w.task)!).status).toBe(TaskStatus.PendingValidation);

    // The buyer says nothing. Inside the review window the worker waits.
    w.advance(REVIEW_WINDOW_SECS - 60n);
    const early = await runTickOnce(w.ctx);
    expect(early.settlements).toHaveLength(0);
    expect(w.events.some((event) => event.event === "settlement.auto-accepted")).toBe(false);

    // Past the window, the worker settles its own delivery and is paid.
    w.advance(120n);
    const before = w.svm.getBalance(w.workerWallet.address) ?? 0n;
    const late = await runTickOnce(w.ctx);
    expect(w.events.find((event) => event.event === "settlement.auto-accepted")).toMatchObject({
      task: w.task,
    });
    expect(getTaskDecoder().decode(accountData(w.svm, w.task)!).status).toBe(TaskStatus.Completed);
    // The protocol's 1% fee in the seeded config: 2,000,000 - 20,000.
    expect(late.settlements).toEqual([
      expect.objectContaining({ task: w.task, outcome: "accepted", earnedLamports: 1_980_000n }),
    ]);
    const after = w.svm.getBalance(w.workerWallet.address) ?? 0n;
    // Paid, plus its claim and submission deposits back, less one fee.
    expect(after - before).toBeGreaterThan(1_980_000n);
    expect(loadState(w.stateDir).submissions[0]).toMatchObject({ settled: true, outcome: "accepted", title: "Write a line" });
  });

  it("expires the claim of a job it gave up once its time is over, and gets the claim's rent back", async () => {
    const w = await world(
      [process.execPath, "-e", "process.exit(3)", "{prompt}"],
      { maxJobAttempts: 1 },
    );
    const first = await runTickOnce(w.ctx);
    expect(first.outcome?.status).toBe("execution-failed");
    const given = loadState(w.stateDir);
    expect(given.openClaim).toBeNull();
    expect(given.failedJobs).toEqual([
      expect.objectContaining({ task: w.task, cause: "attempts", attempts: 1, claimReleased: false }),
    ]);
    const agentPda = await w.workerAgent();
    const [claim] = await findClaimPda({ task: w.task, bidder: agentPda });
    expect(accountData(w.svm, claim)).not.toBeNull();
    expect(getAgentRegistrationDecoder().decode(accountData(w.svm, agentPda)!).activeTasks).toBe(1);

    // Before the claim's time is over, it cannot be released.
    w.advance(DEADLINE_SECS);
    await runTickOnce(w.ctx);
    expect(accountData(w.svm, claim)).not.toBeNull();

    // After it (the deadline plus an hour), the worker expires its own claim.
    w.advance(3_600n + 30n);
    const before = w.svm.getBalance(w.workerWallet.address) ?? 0n;
    const claimHeld = w.svm.getBalance(claim) ?? 0n;
    await runTickOnce(w.ctx);
    expect(w.events.find((event) => event.event === "claim.released")).toMatchObject({
      task: w.task,
      how: "expired",
    });
    expect(accountData(w.svm, claim)).toBeNull();
    expect(getAgentRegistrationDecoder().decode(accountData(w.svm, agentPda)!).activeTasks).toBe(0);
    // Everything the claim held came back, less the one fee: the agent had no
    // record of lapses, and the worker did not pay to start one (its rent
    // would have come out of this).
    const [record] = await findExpireClaimAgentStatsPda({ worker: agentPda });
    expect(accountData(w.svm, record)).toBeNull();
    expect((w.svm.getBalance(w.workerWallet.address) ?? 0n) - before).toBeGreaterThanOrEqual(claimHeld - FEE);
    expect(loadState(w.stateDir).failedJobs[0]).toMatchObject({ claimReleased: true });
    // The task is open again for someone who can do it.
    expect(getTaskDecoder().decode(accountData(w.svm, w.task)!).status).toBe(TaskStatus.Open);
  });

  it("counts the lapse of a job it gave up in a record of lapses the agent already has", async () => {
    const w = await world(
      [process.execPath, "-e", "process.exit(3)", "{prompt}"],
      { maxJobAttempts: 1 },
    );
    await runTickOnce(w.ctx);
    const agentPda = await w.workerAgent();
    // Someone already started the agent's record (anyone may, at their cost).
    const [record, bump] = await findExpireClaimAgentStatsPda({ worker: agentPda });
    seedRecord(w.svm, record, agentPda, bump);

    w.advance(DEADLINE_SECS + 3_600n + 30n);
    await runTickOnce(w.ctx);
    expect(loadState(w.stateDir).failedJobs[0]).toMatchObject({ claimReleased: true });
    expect(getAgentStatsDecoder().decode(accountData(w.svm, record)!).claimsExpired).toBe(1n);
  });

  it("gives up a job whose time to deliver ran out while it waited to try again, and releases it", async () => {
    const w = await world(
      [process.execPath, "-e", "process.exit(3)", "{prompt}"],
      { retryDelayMs: 24 * 3_600_000 },
    );
    await runTickOnce(w.ctx);
    expect(loadState(w.stateDir).openClaim?.failures).toBe(1);

    w.advance(DEADLINE_SECS + 10n);
    await runTickOnce(w.ctx);
    expect(loadState(w.stateDir).failedJobs).toEqual([
      expect.objectContaining({ cause: "expired", reason: "the time to deliver ran out", claimReleased: false }),
    ]);

    w.advance(3_600n + 30n);
    await runTickOnce(w.ctx);
    expect(loadState(w.stateDir).failedJobs[0]).toMatchObject({ claimReleased: true });
  });
});
