import { describe, it, expect } from "vitest";
import type { Address } from "@solana/kit";
import {
  facade,
  findAgentPda,
  findTaskPda,
  findClaimPda,
  findModerationBlockPda,
  findTaskSubmissionPda,
  findWorkerStatsPda,
  getAgentStatsDecoder,
  getTaskDecoder,
  TaskStatus,
  values,
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

/** An owner-aware account reader over the VM, for the SDK's turn-down readers. */
function svmReader(svm: ReturnType<typeof freshSvm>): facade.ReadAccountSnapshot {
  return async (account: Address) => {
    const found = svm.getAccount(account);
    if (!found || !found.exists) return null;
    return { owner: found.programAddress, data: Uint8Array.from(found.data) };
  };
}

// REAL on-chain execution of the revision 9 turn-down dispute flow against the
// compiled agenc-coordination program in litesvm, driven entirely by SDK-built
// (@solana/kit) instructions.
//
//   reach a submitted CreatorReview hire (hire -> claim -> submit)
//     -> a task dispute during review is refused      (6425, revision 9)
//     -> the buyer turns the delivery down             (facade.rejectAndFreeze)
//     -> the worker disputes the turn-down with a bond (facade.disputeRejection)
//     -> the 2-of-3 multisig rules for the worker      (facade.resolveRejectFrozen v2)
//
// On-chain assertions (exact lamports where nobody else pays a fee): the freeze
// is disputable, the bond is the 0.01 SOL floor above the bond account's rent,
// a second dispute fails, the ruling pays the worker as on accept and returns its
// bond, claim and submission, the buyer gets the escrow rent, and both records
// count the outcome.
describe("e2e: a turn-down the worker disputes, ruled by the multisig, on the real program", () => {
  it("refuses a review-time task dispute, then freezes, disputes with a bond, and rules for the worker", async () => {
    const svm = freshSvm();

    // Admin owns ProtocolConfig (treasury) and ModerationConfig authority. Resolver
    // roster changes require a real 2-of-3 owner threshold, even in the VM fixture.
    const admin = await fundedSigner(svm);
    const multisigApproverA = await fundedSigner(svm);
    const multisigApproverB = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address, {
      multisigOwners: [
        admin.address,
        multisigApproverA.address,
        multisigApproverB.address,
      ],
      multisigThreshold: 2,
    });

    // Real, funded signers for each actor (these MUST sign their own instructions).
    const provider = await fundedSigner(svm); // worker wallet
    const buyer = await fundedSigner(svm); // creator/hiring wallet
    const moderator = await fundedSigner(svm); // moderation authority

    await seedModerationConfig(svm, admin.address, moderator.address, true);

    // ---- Reach a submitted CreatorReview task ----

    // 1) Register the provider (worker) agent. The buyer uses the humanless
    // storefront path, which configures CreatorReview without a buyer agent.
    const providerAgentId = new Uint8Array(32).fill(11);
    await send(svm, provider, [
      await facade.registerAgent({
        authority: provider,
        agentId: providerAgentId,
        capabilities: 1n,
        endpoint: "http://provider.test",
        metadataUri: null,
        stakeAmount: 0n,
      }),
    ]);
    const [providerAgent] = await findAgentPda({ agentId: providerAgentId });

    // 2) Provider creates a standing service listing.
    const listingId = new Uint8Array(32).fill(33);
    const listingSpecHash = new Uint8Array(32).fill(7);
    const price = 1_000_000n;
    await send(svm, provider, [
      await facade.createServiceListing({
        providerAgent,
        authority: provider,
        listingId,
        name: new Uint8Array(32).fill(1),
        category: new Uint8Array(32).fill(2),
        tags: new Uint8Array(64).fill(3),
        specHash: listingSpecHash,
        specUri: "agenc://job-spec/sha256/test",
        price,
        priceMint: null,
        requiredCapabilities: 1n,
        defaultDeadlineSecs: 3600n,
        maxOpenJobs: 0,
        operator: null,
        operatorFeeBps: 0,
      }),
    ]);
    const [listing] = await facade.findListingPda({ providerAgent, listingId });

    // 3) Moderation authority records a CLEAN listing moderation so the hire passes.
    await send(svm, moderator, [
      await facade.recordListingModeration({
        moderator,
        listing,
        jobSpecHash: listingSpecHash,
        status: 0,
        riskScore: 0,
        categoryMask: 0n,
        policyHash: new Uint8Array(32).fill(9),
        scannerHash: new Uint8Array(32).fill(8),
        expiresAt: 0n,
      }),
    ]);

    // 4) Human buyer hires the listing -> Open CreatorReview Task + escrow + HireRecord.
    const taskId = new Uint8Array(32).fill(44);
    const jobHash = new Uint8Array(32).fill(55);
    await send(svm, buyer, [
      await facade.hireFromListingHumanless({
        listing,
        providerAgent,
        creator: buyer,
        taskId,
        expectedPrice: price,
        expectedVersion: 1n,
        reviewWindowSecs: 3600n,
        listingSpecHash,
        taskJobSpecHash: jobHash,
        moderator: moderator.address,
      }),
    ]);
    const [task] = await findTaskPda({ creator: buyer.address, taskId });
    const [escrow] = await facade.findEscrowPda({ task });

    // 5) Moderation authority records a CLEAN task moderation.
    await send(svm, moderator, [
      await facade.recordTaskModeration({
        moderator,
        task,
        jobSpecHash: jobHash,
        status: 0,
        riskScore: 0,
        categoryMask: 0n,
        policyHash: new Uint8Array(32).fill(1),
        scannerHash: new Uint8Array(32).fill(2),
        expiresAt: 0n,
      }),
    ]);

    // 6) Creator pins/publishes the task job spec.
    await send(svm, buyer, [
      await facade.setTaskJobSpec({
        task,
        creator: buyer,
        jobSpecHash: jobHash,
        jobSpecUri: "agenc://job-spec/sha256/x",
        moderator: moderator.address,
      }),
    ]);

    // 7) Worker claims and submits a delivery. Worker-initiated disputes require
    // both the live claim and its Submitted record, preventing no-shows from
    // self-disputing to evade expiry penalties.
    await send(svm, provider, [
      await facade.claimTaskWithJobSpec({
        task,
        worker: providerAgent,
        authority: provider,
        moderationBlock: await moderationBlockFor(jobHash),
        jobSpecHash: jobHash,
      }),
    ]);
    // The worker's claim PDA is seeded by [task, worker-agent] (bidder == the agent PDA).
    const [workerClaim] = await findClaimPda({ task, bidder: providerAgent });
    await send(svm, provider, [
      await facade.submitTaskResult({
        task,
        worker: providerAgent,
        authority: provider,
        proofHash: new Uint8Array(32).fill(56),
        resultData: new Uint8Array(64).fill(57),
      }),
    ]);
    const [taskSubmission] = await findTaskSubmissionPda({ claim: workerClaim });

    // Sanity: the task reached review with a live submitted delivery.
    {
      const tBytes = accountData(svm, task);
      expect(tBytes).not.toBeNull();
      expect(getTaskDecoder().decode(tBytes!).status).toBe(
        TaskStatus.PendingValidation,
      );
    }

    // ---- Revision 9: no task dispute on a single-worker review task ----

    // 8) The worker may not open a general dispute while the buyer reviews
    //    (deliberate revision 9 change, DisputeRefusedOnReviewTask 6425). On a
    //    single-worker review task the buyer turns work down with a freeze, and
    //    the worker disputes that freeze.
    await expect(
      send(svm, provider, [
        await facade.initiateDispute({
          task,
          agent: providerAgent,
          authority: provider,
          initiatorClaim: workerClaim,
          taskSubmission,
          disputeId: new Uint8Array(32).fill(77),
          taskId,
          evidenceHash: new Uint8Array(32).fill(1),
          resolutionType: 1, // Complete
          evidence: "evidence",
        }),
      ]),
    ).rejects.toThrow(/code: 6425/);

    // ---- Turn-down -> dispute -> multisig ruling ----

    // 9) The buyer turns the delivery down: a revision 9 freeze.
    await send(svm, buyer, [
      await facade.rejectAndFreeze({
        task,
        worker: providerAgent,
        creator: buyer,
        rejectionHash: new Uint8Array(32).fill(66),
      }),
    ]);
    const read = svmReader(svm);
    let turnDown = await facade.readTurnDown(read, {
      task,
      worker: providerAgent,
    });
    expect(turnDown).toMatchObject({
      claim: workerClaim,
      submission: taskSubmission,
      freezeKind: values.FREEZE_KIND_DISPUTABLE,
      disputable: true,
      // 10% of a 0.001 SOL price is below the 0.01 SOL floor.
      bondToDispute: values.MIN_DISPUTE_BOND_LAMPORTS,
      dispute: null,
    });
    expect(facade.turnDownStage(turnDown!, svm.getClock().unixTimestamp)).toBe(
      "dispute_window",
    );

    // 10) The worker disputes the turn-down, posting the bond on top of the
    //     bond account's rent. The buyer pays nothing.
    const buyerBeforeDispute = svm.getBalance(buyer.address) ?? 0n;
    const disputeTurnDown = async () =>
      facade.disputeRejection({
        task,
        worker: providerAgent,
        creator: buyer.address,
        authority: provider,
        evidenceHash: new Uint8Array(32).fill(67),
        evidenceUri: "agenc://evidence/turn-down",
      });
    await send(svm, provider, [await disputeTurnDown()]);
    const bond = await facade.findRejectionDisputeBondPda(task);
    const bondLamports = svm.getBalance(bond) ?? 0n;
    expect(bondLamports).toBe(
      svm.minimumBalanceForRentExemption(186n) +
        values.MIN_DISPUTE_BOND_LAMPORTS,
    );
    expect(svm.getBalance(buyer.address) ?? 0n).toBe(buyerBeforeDispute);
    turnDown = await facade.readTurnDown(read, { task, worker: providerAgent });
    expect(turnDown?.dispute).toMatchObject({
      bond,
      amount: values.MIN_DISPUTE_BOND_LAMPORTS,
      filer: provider.address,
      respondent: buyer.address,
    });
    expect(facade.turnDownStage(turnDown!, svm.getClock().unixTimestamp)).toBe(
      "awaiting_ruling",
    );
    expect(
      (await facade.getCreatorTrackRecord(read, buyer.address)).counters,
    ).toMatchObject({ rejections: 1n, rejectionsContested: 1n });
    // One dispute per turn-down: the bond address is taken.
    svm.expireBlockhash();
    await expect(
      send(svm, provider, [await disputeTurnDown()]),
    ).rejects.toThrow(/tx failed/);

    // 11) The 2-of-3 multisig rules for the worker: paid as on accept, and its
    //     bond, claim and submission come back.
    const providerBefore = svm.getBalance(provider.address) ?? 0n;
    const buyerBeforeRuling = svm.getBalance(buyer.address) ?? 0n;
    const claimLamports = svm.getBalance(workerClaim) ?? 0n;
    const submissionLamports = svm.getBalance(taskSubmission) ?? 0n;
    const escrowLamports = svm.getBalance(escrow) ?? 0n;
    const frozenTask = getTaskDecoder().decode(accountData(svm, task)!);
    const protocolFee =
      (price * BigInt(frozenTask.protocolFeeBps)) / 10_000n;
    await send(svm, admin, [
      await facade.resolveRejectFrozen({
        task,
        claim: workerClaim,
        worker: providerAgent,
        treasury: admin.address,
        creator: buyer.address,
        workerAuthority: provider.address,
        authority: admin,
        approveCompletion: true,
        rationaleHash: new Uint8Array(32).fill(68),
        rationaleUri: "agenc://ruling/turn-down",
        multisigSigners: [multisigApproverA, multisigApproverB],
      }),
    ]);

    expect(getTaskDecoder().decode(accountData(svm, task)!).status).toBe(
      TaskStatus.Completed,
    );
    expect(svm.getBalance(provider.address) ?? 0n).toBe(
      providerBefore +
        (price - protocolFee) +
        claimLamports +
        submissionLamports +
        bondLamports,
    );
    // The buyer gets only the escrow's rent back: the price was paid out.
    expect(svm.getBalance(buyer.address) ?? 0n).toBe(
      buyerBeforeRuling + (escrowLamports - price),
    );
    expect(accountData(svm, bond)).toBeNull();
    const [workerRecord] = await findWorkerStatsPda({ worker: providerAgent });
    expect(
      getAgentStatsDecoder().decode(accountData(svm, workerRecord)!),
    ).toMatchObject({ tasksRejected: 1n, disputesWon: 1n, disputesLost: 0n });
    expect(
      (await facade.getCreatorTrackRecord(read, buyer.address)).counters,
    ).toMatchObject({ disputesWon: 0n, disputesLost: 1n });
  });
});
