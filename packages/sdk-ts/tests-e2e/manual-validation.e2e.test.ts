import { describe, it, expect } from "vitest";
import {
  facade,
  findAgentPda,
  findTaskPda,
  findClaimPda,
  findEscrowPda,
  findTaskSubmissionPda,
  findTaskJobSpecPda,
  findHireRecordPda,
  findModerationBlockPda,
  getTaskDecoder,
  getTaskSubmissionDecoder,
  getTaskEscrowDecoder,
  TaskStatus,
  SubmissionStatus,
} from "../src/index.js";
import {
  freshSvm,
  seedProtocolConfig,
  seedModerationConfig,
  fundedSigner,
  send,
  accountData,
} from "./harness.js";

async function moderationBlockFor(contentHash: Uint8Array) {
  return (await findModerationBlockPda({ contentHash }))[0];
}

// REAL on-chain execution of the CreatorReview (manual validation) settlement path,
// driven entirely by SDK-built @solana/kit instructions running against the compiled
// agenc-coordination program in litesvm. Ports setupManualTask + runManualSettlement
// from tests-integration/marketplace.test.mjs.
//
// Flow: register creator + worker agents -> create_task (Auto, non-hired) ->
// configure_task_validation (CreatorReview, ["hire", task] passed as the empty
// non-hired PDA) -> record_task_moderation -> set_task_job_spec ->
// claim_task_with_job_spec -> submit_task_result -> accept_task_result.
//
// Multi-signer note: each step has exactly one authority signer; that signer is the
// send() fee payer so signTransactionMessageWithSigners signs it. Distinct actors
// (creator/worker/moderator) each get their own send() call, mirroring how the
// reference sends each .instruction() with its own signer set.
describe("e2e: CreatorReview manual validation settles on the real program", () => {
  it("submit -> accept marks the Task Completed, the submission Accepted, pays the worker, and closes escrow", async () => {
    const svm = freshSvm();

    // admin = protocol authority + treasury (matches seedProtocolConfig); modAuth =
    // the moderation authority that signs record_task_moderation.
    const admin = await fundedSigner(svm);
    const modAuth = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);
    await seedModerationConfig(svm, admin.address, modAuth.address, true);

    // Real, funded creator and worker signers.
    const creator = await fundedSigner(svm); // == buyer/authority/creator in the reference
    const worker = await fundedSigner(svm); // == provider/worker authority in the reference

    // --- register the creator's agent (createTask requires a real creatorAgent) ---
    const creatorAgentId = new Uint8Array(32).fill(11);
    await send(svm, creator, [
      await facade.registerAgent({
        authority: creator,
        agentId: creatorAgentId,
        capabilities: 1n,
        endpoint: "http://creator.test",
        metadataUri: null,
        stakeAmount: 0n,
      }),
    ]);
    const [creatorAgent] = await findAgentPda({ agentId: creatorAgentId });

    // --- register the worker's agent (claim_task_with_job_spec needs a worker agent) ---
    const workerAgentId = new Uint8Array(32).fill(22);
    await send(svm, worker, [
      await facade.registerAgent({
        authority: worker,
        agentId: workerAgentId,
        capabilities: 1n,
        endpoint: "http://worker.test",
        metadataUri: null,
        stakeAmount: 0n,
      }),
    ]);
    const [workerAgent] = await findAgentPda({ agentId: workerAgentId });

    // --- create_task: Auto type, plain SOL reward, non-hired (constraintHash = null) ---
    const taskId = new Uint8Array(32).fill(33);
    const reward = 2_000_000n;
    const description = new Uint8Array(64).fill(7, 0, 32);
    const now = svm.getClock().unixTimestamp; // 1_700_000_000n from freshSvm
    await send(svm, creator, [
      await facade.createTask({
        // authority and creator must be the SAME signer (anti-social-engineering
        // guard, #375); both are the creator, who is also the fee payer.
        authority: creator,
        creator,
        creatorAgent,
        taskId,
        requiredCapabilities: 1n,
        description,
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
    const [escrow] = await findEscrowPda({ task });

    // The escrow holds the reward after create_task (proves funds were locked).
    const escrowData0 = accountData(svm, escrow);
    expect(escrowData0).not.toBeNull();
    expect(getTaskEscrowDecoder().decode(escrowData0!).amount).toBe(reward);

    // --- configure_task_validation: CreatorReview (mode = 1) ---
    // hireRecord must be the derived ["hire", task] PDA even though this task is
    // non-hired (the account simply doesn't exist -> the guard lets it through).
    const [hireRecord] = await findHireRecordPda({ task });
    await send(svm, creator, [
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

    // --- record_task_moderation (moderation authority signs) -> approve (status 0) ---
    const jobSpecHash = new Uint8Array(32).fill(44);
    await send(svm, modAuth, [
      await facade.recordTaskModeration({
        task,
        moderator: modAuth,
        jobSpecHash,
        status: 0, // approved
        riskScore: 0,
        categoryMask: 0n,
        policyHash: new Uint8Array(32).fill(1),
        scannerHash: new Uint8Array(32).fill(2),
        expiresAt: 0n,
      }),
    ]);

    // --- set_task_job_spec (creator publishes the job-spec pointer; required to claim) ---
    await send(svm, creator, [
      await facade.setTaskJobSpec({
        task,
        creator,
        jobSpecHash,
        jobSpecUri: "agenc://job-spec/sha256/manual",
        moderator: modAuth.address,
      }),
    ]);
    const [jobSpec] = await findTaskJobSpecPda({ task });
    expect(accountData(svm, jobSpec)).not.toBeNull();

    // --- claim_task_with_job_spec (worker authority signs; worker = its agent PDA) ---
    await send(svm, worker, [
      await facade.claimTaskWithJobSpec({
        task,
        worker: workerAgent,
        authority: worker,
        moderationBlock: await moderationBlockFor(jobSpecHash),
        jobSpecHash,
      }),
    ]);
    // The claim PDA's second seed field is named `bidder` in the generated helper,
    // but it is the worker agent PDA (seed string is "claim").
    const [claim] = await findClaimPda({ task, bidder: workerAgent });
    expect(accountData(svm, claim)).not.toBeNull();

    // After a claim the task is InProgress.
    expect(getTaskDecoder().decode(accountData(svm, task)!).status).toBe(
      TaskStatus.InProgress,
    );

    // --- submit_task_result (worker submits for review) ---
    const proofHash = new Uint8Array(32).fill(55);
    const resultData = new Uint8Array(64).fill(9);
    await send(svm, worker, [
      await facade.submitTaskResult({
        task,
        worker: workerAgent,
        authority: worker,
        proofHash,
        resultData,
      }),
    ]);
    const [submission] = await findTaskSubmissionPda({ claim });

    // After submit the task is PendingValidation and the submission is Submitted.
    expect(getTaskDecoder().decode(accountData(svm, task)!).status).toBe(
      TaskStatus.PendingValidation,
    );
    expect(
      getTaskSubmissionDecoder().decode(accountData(svm, submission)!).status,
    ).toBe(SubmissionStatus.Submitted);

    // Snapshot the worker authority's balance BEFORE settle. The creator (not the
    // worker) signs accept_task_result, so the worker's balance delta reflects the
    // payout cleanly (no fee/signature noise from the worker).
    const workerBalBefore = svm.getBalance(worker.address);

    // --- accept_task_result (creator accepts; settles the escrow to the worker) ---
    await send(svm, creator, [
      await facade.acceptTaskResult({
        task,
        worker: workerAgent,
        creator,
        treasury: admin.address, // matches the seeded ProtocolConfig.treasury
        workerAuthority: worker.address,
      }),
    ]);

    // ===================== REAL ON-CHAIN ASSERTIONS =====================

    // 1) Task reaches Completed.
    const taskAfter = getTaskDecoder().decode(accountData(svm, task)!);
    expect(taskAfter.status).toBe(TaskStatus.Completed);

    // 2) The accepted submission is CLOSED to the worker at settle (Batch 3
    //    WS-CONTEST §1 — submission rent returns to the worker who funded it).
    expect(accountData(svm, submission)).toBeNull();

    // 3) The worker was paid (balance strictly increased; worker did not sign accept).
    const workerBalAfter = svm.getBalance(worker.address);
    expect(workerBalBefore).not.toBeNull();
    expect(workerBalAfter).not.toBeNull();
    expect(workerBalAfter!).toBeGreaterThan(workerBalBefore!);

    // 4) The escrow account was closed on settlement (rent reclaimed).
    expect(accountData(svm, escrow)).toBeNull();
  });
});
