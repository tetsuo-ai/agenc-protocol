import { describe, it, expect } from "vitest";
import type { Address } from "@solana/kit";
import {
  facade,
  values,
  findAgentPda,
  findTaskPda,
  findEscrowPda,
  findClaimPda,
  findTaskSubmissionPda,
  findHireRecordPda,
  findModerationBlockPda,
  findWorkerStatsPda,
  findCreatorStatsPda,
  findWorkerCompletionBondPda,
  getAgentStatsDecoder,
  getCreatorStatsDecoder,
  getTaskClaimDecoder,
  getTaskDecoder,
  getTaskSubmissionDecoder,
  TaskStatus,
} from "../src/index.js";
import {
  freshSvm,
  seedProtocolConfig,
  seedModerationConfig,
  fundedSigner,
  send,
  accountData,
} from "./harness.js";

// REAL on-chain execution of the revision 9 (accountable review) money paths
// for claims and turn-downs, driven by SDK-built instructions against the
// compiled program in litesvm. A separate `payer` signs as the fee payer of
// every transaction, so the parties' balances move only by what the program
// moves and every delta below is exact.

type Svm = ReturnType<typeof freshSvm>;
const DAY = 86_400n;
const CLAIM_SIZE = 203n;
const DISPUTE_BOND_SIZE = 186n;

function lamportsOf(svm: Svm, account: Address): bigint {
  return svm.getBalance(account) ?? 0n;
}

function warp(svm: Svm, unixTimestamp: bigint): void {
  const clock = svm.getClock();
  clock.unixTimestamp = unixTimestamp;
  svm.setClock(clock);
  svm.expireBlockhash();
}

function svmReader(svm: Svm): facade.ReadAccountSnapshot {
  return async (account: Address) => {
    const found = svm.getAccount(account);
    if (!found || !found.exists) return null;
    return { owner: found.programAddress, data: Uint8Array.from(found.data) };
  };
}

/** A direct CreatorReview task (Exclusive, one worker), ready to claim. */
async function reviewTask(reward: bigint) {
  const svm = freshSvm();
  const admin = await fundedSigner(svm);
  const modAuth = await fundedSigner(svm);
  const payer = await fundedSigner(svm);
  await seedProtocolConfig(svm, admin.address);
  await seedModerationConfig(svm, admin.address, modAuth.address, true);
  const creator = await fundedSigner(svm);
  const worker = await fundedSigner(svm);

  const register = async (
    authority: typeof creator,
    fill: number,
  ): Promise<Address> => {
    const agentId = new Uint8Array(32).fill(fill);
    await send(svm, authority, [
      await facade.registerAgent({
        authority,
        agentId,
        capabilities: 1n,
        endpoint: `http://agent-${fill}.test`,
        metadataUri: null,
        stakeAmount: 0n,
      }),
    ]);
    return (await findAgentPda({ agentId }))[0];
  };
  const creatorAgent = await register(creator, 11);
  const workerAgent = await register(worker, 22);

  const taskId = new Uint8Array(32).fill(33);
  const now = svm.getClock().unixTimestamp;
  await send(svm, creator, [
    await facade.createTask({
      authority: creator,
      creator,
      creatorAgent,
      taskId,
      requiredCapabilities: 1n,
      description: new Uint8Array(64).fill(7, 0, 32),
      rewardAmount: reward,
      maxWorkers: 1,
      deadline: now + 10n * DAY,
      taskType: 0,
      constraintHash: null,
      minReputation: 0,
      rewardMintArg: null,
    }),
  ]);
  const [task] = await findTaskPda({ creator: creator.address, taskId });
  const [escrow] = await findEscrowPda({ task });
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
  const jobSpecHash = new Uint8Array(32).fill(44);
  await send(svm, modAuth, [
    await facade.recordTaskModeration({
      task,
      moderator: modAuth,
      jobSpecHash,
      status: 0,
      riskScore: 0,
      categoryMask: 0n,
      policyHash: new Uint8Array(32).fill(1),
      scannerHash: new Uint8Array(32).fill(2),
      expiresAt: 0n,
    }),
  ]);
  await send(svm, creator, [
    await facade.setTaskJobSpec({
      task,
      creator,
      jobSpecHash,
      jobSpecUri: "agenc://job-spec/sha256/accountable-review",
      moderator: modAuth.address,
    }),
  ]);

  const [claim] = await findClaimPda({ task, bidder: workerAgent });
  const [submission] = await findTaskSubmissionPda({ claim });
  const [workerRecord] = await findWorkerStatsPda({ worker: workerAgent });
  const [creatorRecord] = await findCreatorStatsPda({
    authority: creator.address,
  });
  const doClaim = async () => {
    await send(svm, payer, [
      await facade.claimTaskWithJobSpec({
        task,
        worker: workerAgent,
        authority: worker,
        moderationBlock: (await findModerationBlockPda({ contentHash: jobSpecHash }))[0],
        jobSpecHash,
      }),
    ]);
    return getTaskClaimDecoder().decode(accountData(svm, claim)!);
  };
  const doSubmit = async () => {
    await send(svm, payer, [
      await facade.submitTaskResult({
        task,
        worker: workerAgent,
        authority: worker,
        proofHash: new Uint8Array(32).fill(55),
        resultData: new Uint8Array(64).fill(9),
      }),
    ]);
  };
  const doFreeze = async () => {
    await send(svm, payer, [
      await facade.rejectAndFreeze({
        task,
        worker: workerAgent,
        creator,
        rejectionHash: new Uint8Array(32).fill(66),
      }),
    ]);
  };
  const expireFrozen = async () =>
    send(svm, payer, [
      await facade.expireRejectFrozen({
        task,
        claim,
        worker: workerAgent,
        treasury: admin.address,
        creator: creator.address,
        workerAuthority: worker.address,
        authority: payer,
      }),
    ]);
  const deposit = values.claimDepositForTask(
    getTaskDecoder().decode(accountData(svm, task)!),
  );
  return {
    svm,
    admin,
    payer,
    creator,
    worker,
    workerAgent,
    task,
    escrow,
    claim,
    submission,
    workerRecord,
    creatorRecord,
    deposit,
    reward,
    doClaim,
    doSubmit,
    doFreeze,
    expireFrozen,
    read: svmReader(svm),
  };
}

describe("e2e: revision 9 claim deposits and release_claim on the real program", () => {
  it("a claim puts down 10% of the share, at least 0.005 SOL, and the first delivery returns it", async () => {
    const w = await reviewTask(200_000_000n); // 0.2 SOL
    expect(w.deposit).toBe(20_000_000n);
    const before = lamportsOf(w.svm, w.worker.address);
    await w.doClaim();
    const claimRent = w.svm.minimumBalanceForRentExemption(CLAIM_SIZE);
    expect(lamportsOf(w.svm, w.claim)).toBe(claimRent + w.deposit);
    // The worker paid its claim (rent and deposit) and started its own record.
    expect(accountData(w.svm, w.workerRecord)).not.toBeNull();
    const afterClaim = lamportsOf(w.svm, w.worker.address);
    expect(afterClaim).toBe(
      before -
        lamportsOf(w.svm, w.claim) -
        lamportsOf(w.svm, w.workerRecord),
    );

    await w.doSubmit();
    expect(lamportsOf(w.svm, w.claim)).toBe(claimRent);
    expect(lamportsOf(w.svm, w.worker.address)).toBe(
      afterClaim + w.deposit - lamportsOf(w.svm, w.submission),
    );

    // The floor applies to a small job: 0.005 SOL on a 0.005 SOL price.
    const small = await reviewTask(5_000_000n);
    expect(small.deposit).toBe(values.MIN_CLAIM_DEPOSIT_LAMPORTS);
    await small.doClaim();
    expect(lamportsOf(small.svm, small.claim)).toBe(
      small.svm.minimumBalanceForRentExemption(CLAIM_SIZE) +
        values.MIN_CLAIM_DEPOSIT_LAMPORTS,
    );
  });

  it("release_claim within the hour returns the deposit; after the hour the buyer gets it", async () => {
    const early = await reviewTask(100_000_000n);
    const claimed = await early.doClaim();
    const claimLamports = lamportsOf(early.svm, early.claim);
    const workerBefore = lamportsOf(early.svm, early.worker.address);
    const creatorBefore = lamportsOf(early.svm, early.creator.address);
    // The last second of the grace still refunds (inclusive, as on chain).
    warp(early.svm, claimed.claimedAt + values.CLAIM_RELEASE_GRACE_SECS);
    await send(early.svm, early.payer, [
      await facade.releaseClaim({
        task: early.task,
        worker: early.workerAgent,
        creator: early.creator.address,
        authority: early.worker,
      }),
    ]);
    expect(accountData(early.svm, early.claim)).toBeNull();
    expect(lamportsOf(early.svm, early.worker.address)).toBe(
      workerBefore + claimLamports,
    );
    expect(lamportsOf(early.svm, early.creator.address)).toBe(creatorBefore);
    const reopened = getTaskDecoder().decode(accountData(early.svm, early.task)!);
    expect(reopened.status).toBe(TaskStatus.Open);
    expect(reopened.currentWorkers).toBe(0);
    expect(
      getAgentStatsDecoder().decode(accountData(early.svm, early.workerRecord)!)
        .claimsExpired,
    ).toBe(0n);

    const late = await reviewTask(100_000_000n);
    const lateClaim = await late.doClaim();
    const lateClaimLamports = lamportsOf(late.svm, late.claim);
    const lateWorkerBefore = lamportsOf(late.svm, late.worker.address);
    const lateCreatorBefore = lamportsOf(late.svm, late.creator.address);
    warp(late.svm, lateClaim.claimedAt + values.CLAIM_RELEASE_GRACE_SECS + 1n);
    await send(late.svm, late.payer, [
      await facade.releaseClaim({
        task: late.task,
        worker: late.workerAgent,
        creator: late.creator.address,
        authority: late.worker,
      }),
    ]);
    expect(lamportsOf(late.svm, late.creator.address)).toBe(
      lateCreatorBefore + late.deposit,
    );
    expect(lamportsOf(late.svm, late.worker.address)).toBe(
      lateWorkerBefore + lateClaimLamports - late.deposit,
    );
    expect(
      getAgentStatsDecoder().decode(accountData(late.svm, late.workerRecord)!)
        .claimsExpired,
    ).toBe(1n);
  });

  it("release_claim refuses delivered work under review", async () => {
    const w = await reviewTask(100_000_000n);
    await w.doClaim();
    await w.doSubmit();
    await expect(
      send(w.svm, w.payer, [
        await facade.releaseClaim({
          task: w.task,
          worker: w.workerAgent,
          creator: w.creator.address,
          authority: w.worker,
        }),
      ]),
    ).rejects.toThrow(/code: 6427/);
  });

  it("a no-show expiry sends the deposit to the creator, and the creator's first cancel starts its record", async () => {
    const w = await reviewTask(100_000_000n);
    const claimed = await w.doClaim();
    const claimLamports = lamportsOf(w.svm, w.claim);
    const workerBefore = lamportsOf(w.svm, w.worker.address);
    const creatorBefore = lamportsOf(w.svm, w.creator.address);
    // After the claim's expiry and the 60-second worker grace, anyone may expire.
    warp(w.svm, claimed.expiresAt + 61n);
    const expire = await facade.expireClaim({
      authority: w.payer,
      task: w.task,
      worker: w.workerAgent,
      rentRecipient: w.worker.address,
      creator: w.creator.address,
      workerCompletionBond: (
        await findWorkerCompletionBondPda({
          task: w.task,
          workerAuthority: w.worker.address,
        })
      )[0],
      treasury: w.admin.address,
    });
    await send(w.svm, w.payer, [expire]);
    expect(lamportsOf(w.svm, w.creator.address)).toBe(creatorBefore + w.deposit);
    expect(lamportsOf(w.svm, w.worker.address)).toBe(
      workerBefore + claimLamports - w.deposit,
    );
    expect(
      getAgentStatsDecoder().decode(accountData(w.svm, w.workerRecord)!)
        .claimsExpired,
    ).toBe(1n);
    // An expiry never creates the creator's record (cranks stay cheap).
    expect(accountData(w.svm, w.creatorRecord)).toBeNull();

    // The creator cancels for its refund; the record starts here, paid by it.
    const escrowLamports = lamportsOf(w.svm, w.escrow);
    const creatorBeforeCancel = lamportsOf(w.svm, w.creator.address);
    await send(w.svm, w.payer, [
      await facade.cancelTask({
        task: w.task,
        authority: w.creator,
        workerBondAuthority: w.creator.address,
      }),
    ]);
    const record = getCreatorStatsDecoder().decode(
      accountData(w.svm, w.creatorRecord)!,
    );
    expect(record.wallet).toBe(w.creator.address);
    expect(record.cancels).toBe(1n);
    expect(lamportsOf(w.svm, w.creator.address)).toBe(
      creatorBeforeCancel + escrowLamports - lamportsOf(w.svm, w.creatorRecord),
    );
  });
});

describe("e2e: revision 9 turn-downs refund the buyer unless a ruling pays the worker", () => {
  it("an undisputed turn-down refunds the buyer when the dispute window ends", async () => {
    const w = await reviewTask(100_000_000n);
    await w.doClaim();
    await w.doSubmit();
    await w.doFreeze();
    const frozen = getTaskSubmissionDecoder().decode(
      accountData(w.svm, w.submission)!,
    );
    expect(values.isDisputableFreeze(frozen)).toBe(true);
    const turnDown = await facade.readTurnDown(w.read, {
      task: w.task,
      worker: w.workerAgent,
    });
    expect(turnDown?.dispute).toBeNull();

    // The window is still open at its last second.
    warp(w.svm, frozen.reviewDeadlineAt);
    expect(facade.turnDownStage(turnDown!, frozen.reviewDeadlineAt)).toBe(
      "dispute_window",
    );
    await expect(w.expireFrozen()).rejects.toThrow(/code: 6422/);

    warp(w.svm, frozen.reviewDeadlineAt + 1n);
    const stage = facade.turnDownStage(turnDown!, frozen.reviewDeadlineAt + 1n);
    expect(stage).toBe("refund_due");
    expect(facade.turnDownExpiryPaysWorker(stage)).toBe(false);
    const creatorBefore = lamportsOf(w.svm, w.creator.address);
    const workerBefore = lamportsOf(w.svm, w.worker.address);
    const escrowLamports = lamportsOf(w.svm, w.escrow);
    const claimLamports = lamportsOf(w.svm, w.claim);
    const submissionLamports = lamportsOf(w.svm, w.submission);
    await w.expireFrozen();
    expect(getTaskDecoder().decode(accountData(w.svm, w.task)!).status).toBe(
      TaskStatus.Cancelled,
    );
    // The buyer gets the price and the escrow rent; the worker only its rents.
    expect(lamportsOf(w.svm, w.creator.address)).toBe(
      creatorBefore + escrowLamports,
    );
    expect(escrowLamports).toBeGreaterThan(w.reward);
    expect(lamportsOf(w.svm, w.worker.address)).toBe(
      workerBefore + claimLamports + submissionLamports,
    );
  });

  it("a dispute nobody rules on refunds the buyer and returns the worker's bond", async () => {
    const w = await reviewTask(200_000_000n);
    await w.doClaim();
    await w.doSubmit();
    await w.doFreeze();
    const workerBeforeBond = lamportsOf(w.svm, w.worker.address);
    await send(w.svm, w.payer, [
      await facade.disputeRejection({
        task: w.task,
        worker: w.workerAgent,
        creator: w.creator.address,
        authority: w.worker,
        evidenceHash: new Uint8Array(32).fill(67),
        evidenceUri: "",
      }),
    ]);
    const bond = await facade.findRejectionDisputeBondPda(w.task);
    const bondLamports = lamportsOf(w.svm, bond);
    // 10% of 0.2 SOL, above the floor, on top of the bond account's rent.
    expect(bondLamports).toBe(
      w.svm.minimumBalanceForRentExemption(DISPUTE_BOND_SIZE) + 20_000_000n,
    );
    expect(lamportsOf(w.svm, w.worker.address)).toBe(
      workerBeforeBond - bondLamports,
    );
    const turnDown = await facade.readTurnDown(w.read, {
      task: w.task,
      worker: w.workerAgent,
    });
    const rulingDeadline = turnDown!.dispute!.rulingDeadline;

    warp(w.svm, rulingDeadline);
    await expect(w.expireFrozen()).rejects.toThrow(/code: 6422/);

    warp(w.svm, rulingDeadline + 1n);
    expect(facade.turnDownStage(turnDown!, rulingDeadline + 1n)).toBe(
      "unruled_refund_due",
    );
    const creatorBefore = lamportsOf(w.svm, w.creator.address);
    const workerBefore = lamportsOf(w.svm, w.worker.address);
    const escrowLamports = lamportsOf(w.svm, w.escrow);
    const claimLamports = lamportsOf(w.svm, w.claim);
    const submissionLamports = lamportsOf(w.svm, w.submission);
    await w.expireFrozen();
    expect(getTaskDecoder().decode(accountData(w.svm, w.task)!).status).toBe(
      TaskStatus.Cancelled,
    );
    expect(lamportsOf(w.svm, w.creator.address)).toBe(
      creatorBefore + escrowLamports,
    );
    expect(lamportsOf(w.svm, w.worker.address)).toBe(
      workerBefore + bondLamports + claimLamports + submissionLamports,
    );
    expect(accountData(w.svm, bond)).toBeNull();
  });
});
