// The worker looks after its own jobs against the REAL compiled program
// (litesvm): a delivery whose buyer never reviews it is auto-accepted by the
// worker itself once the review window has passed, so it is paid; the claim
// of a job it gave up is given back (revision 9 release_claim), so the
// claim's rent and, in its first hour, its deposit come back and its
// active-task slot is free again; and a delivery the buyer turns down is
// disputed only under the operator's policy, and collected once its window
// is over.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KeyPairSigner } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  createMarketplaceClient,
  facade,
  findAgentPda,
  findClaimPda,
  findTaskSubmissionPda,
  findWorkerStatsPda,
  getAgentStatsDecoder,
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
  return {
    svm,
    ctx,
    events,
    stateDir,
    task,
    creator: creator as KeyPairSigner,
    creatorClient,
    workerWallet,
    advance,
    workerAgent,
  };
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

  it("gives back the claim of a job it gave up at once, and gets the claim's rent and deposit back", async () => {
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
    const claimHeld = w.svm.getBalance(claim) ?? 0n;
    // Revision 9: the claim holds its rent and the 0.005 SOL deposit floor.
    expect(claimHeld).toBe(
      w.svm.minimumBalanceForRentExemption(203n) + values.MIN_CLAIM_DEPOSIT_LAMPORTS,
    );
    expect(getAgentRegistrationDecoder().decode(accountData(w.svm, agentPda)!).activeTasks).toBe(1);

    // On the next pass, inside the claim's first hour, the worker gives it back.
    const before = w.svm.getBalance(w.workerWallet.address) ?? 0n;
    await runTickOnce(w.ctx);
    expect(w.events.find((event) => event.event === "claim.released")).toMatchObject({
      task: w.task,
      how: "released",
      depositBack: true,
    });
    expect(accountData(w.svm, claim)).toBeNull();
    expect(getAgentRegistrationDecoder().decode(accountData(w.svm, agentPda)!).activeTasks).toBe(0);
    // Everything the claim held came back, deposit included, less the fee.
    expect((w.svm.getBalance(w.workerWallet.address) ?? 0n) - before).toBeGreaterThanOrEqual(claimHeld - FEE);
    expect(loadState(w.stateDir).failedJobs[0]).toMatchObject({ claimReleased: true });
    // The worker's record, created at its claim, counts no lapse.
    const [record] = await findWorkerStatsPda({ worker: agentPda });
    expect(getAgentStatsDecoder().decode(accountData(w.svm, record)!).claimsExpired).toBe(0n);
    // The task is open again for someone who can do it.
    expect(getTaskDecoder().decode(accountData(w.svm, w.task)!).status).toBe(TaskStatus.Open);
  });

  it("gives back a claim after its first hour: the deposit goes to the buyer and the lapse is counted", async () => {
    const w = await world(
      [process.execPath, "-e", "process.exit(3)", "{prompt}"],
      { maxJobAttempts: 1 },
    );
    await runTickOnce(w.ctx);
    const agentPda = await w.workerAgent();
    const creatorBefore = w.svm.getBalance(w.creator.address) ?? 0n;
    // Past the hour, still before the claim's own expiry (the deadline plus an hour).
    w.advance(3_600n + 30n);
    await runTickOnce(w.ctx);
    expect(loadState(w.stateDir).failedJobs[0]).toMatchObject({ claimReleased: true });
    expect(w.events.find((event) => event.event === "claim.released")).toMatchObject({
      how: "released",
      depositBack: false,
    });
    expect((w.svm.getBalance(w.creator.address) ?? 0n) - creatorBefore).toBe(
      values.MIN_CLAIM_DEPOSIT_LAMPORTS,
    );
    const [record] = await findWorkerStatsPda({ worker: agentPda });
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

  it("reports a turn-down while its window is open, then collects it: the buyer is refunded and its rents come back", async () => {
    const w = await world([process.execPath, "-e", "process.stdout.write('Here is your line.')", "{prompt}"]);
    expect((await runTickOnce(w.ctx)).outcome?.status).toBe("submitted");
    const agentPda = await w.workerAgent();
    await w.creatorClient.send([
      await facade.rejectAndFreeze({
        task: w.task,
        worker: agentPda,
        creator: w.creator,
        rejectionHash: new Uint8Array(32).fill(0x5a),
      }),
    ]);
    expect(getTaskDecoder().decode(accountData(w.svm, w.task)!).status).toBe(TaskStatus.RejectFrozen);

    // Inside the dispute window, with the policy off (the default), nothing is sent.
    const balanceInWindow = w.svm.getBalance(w.workerWallet.address) ?? 0n;
    await runTickOnce(w.ctx);
    expect(w.events.find((event) => event.event === "task.turned-down")).toMatchObject({
      task: w.task,
      stage: "dispute_window",
      bondLamports: values.MIN_DISPUTE_BOND_LAMPORTS.toString(),
      disputePolicy: "off",
    });
    expect(w.svm.getBalance(w.workerWallet.address) ?? 0n).toBe(balanceInWindow);

    // After the window the worker sends the expiry. The buyer gets the price
    // back and the worker its claim and submission rent; it is not paid.
    w.advance(values.REJECT_DISPUTE_WINDOW_SECS + 1n);
    const [claim] = await findClaimPda({ task: w.task, bidder: agentPda });
    const rents =
      (w.svm.getBalance(claim) ?? 0n) +
      (w.svm.getBalance((await findTaskSubmissionPda({ claim }))[0]) ?? 0n);
    const before = w.svm.getBalance(w.workerWallet.address) ?? 0n;
    const tick = await runTickOnce(w.ctx);
    expect(w.events.find((event) => event.event === "task.turn-down-collected")).toMatchObject({
      task: w.task,
      paid: false,
    });
    expect(getTaskDecoder().decode(accountData(w.svm, w.task)!).status).toBe(TaskStatus.Cancelled);
    expect((w.svm.getBalance(w.workerWallet.address) ?? 0n) - before).toBe(rents - FEE);
    expect(tick.settlements).toEqual([
      expect.objectContaining({ task: w.task, outcome: "cancelled" }),
    ]);
  });

  it("disputes a turn-down with the bond when its operator turned the policy on", async () => {
    const w = await world(
      [process.execPath, "-e", "process.stdout.write('Here is your line.')", "{prompt}"],
      { disputeTurnDowns: true },
    );
    expect((await runTickOnce(w.ctx)).outcome?.status).toBe("submitted");
    const agentPda = await w.workerAgent();
    await w.creatorClient.send([
      await facade.rejectAndFreeze({
        task: w.task,
        worker: agentPda,
        creator: w.creator,
        rejectionHash: new Uint8Array(32).fill(0x5b),
      }),
    ]);
    const before = w.svm.getBalance(w.workerWallet.address) ?? 0n;
    await runTickOnce(w.ctx);
    expect(w.events.find((event) => event.event === "task.turn-down-disputed")).toMatchObject({
      task: w.task,
      bondLamports: values.MIN_DISPUTE_BOND_LAMPORTS.toString(),
    });
    const bond = await facade.findRejectionDisputeBondPda(w.task);
    const bondLamports = w.svm.getBalance(bond) ?? 0n;
    expect(bondLamports).toBe(
      w.svm.minimumBalanceForRentExemption(186n) + values.MIN_DISPUTE_BOND_LAMPORTS,
    );
    expect(before - (w.svm.getBalance(w.workerWallet.address) ?? 0n)).toBe(bondLamports + FEE);
    // A second pass does not dispute again: the turn-down now awaits a ruling.
    await runTickOnce(w.ctx);
    expect(w.events.filter((event) => event.event === "task.turn-down-disputed")).toHaveLength(1);
  });
});
