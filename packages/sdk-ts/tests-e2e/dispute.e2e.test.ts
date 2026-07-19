import { describe, it, expect } from "vitest";
import {
  facade,
  findAgentPda,
  findTaskPda,
  findClaimPda,
  findDisputePda,
  findModerationBlockPda,
  findTaskSubmissionPda,
  getDisputeDecoder,
  getTaskDecoder,
  DisputeStatus,
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

async function moderationBlockFor(contentHash: Uint8Array) {
  return (await findModerationBlockPda({ contentHash }))[0];
}

// REAL on-chain execution of the dispute -> resolve flow against the compiled
// agenc-coordination program in litesvm, driven entirely by SDK-built (@solana/kit)
// instructions.
//
// P6.3: the arbiter vote/quorum model is RETIRED. `vote_dispute` no longer exists; a
// dispute is decided by an ASSIGNED RESOLVER on the threshold-approved roster (or by
// the protocol authority with configured M-of-N approval) calling `resolve_dispute`
// directly — no per-case arbiter registration, votes, or voting-period wait, and NO
// (vote, arbiter) remaining accounts. P6.4 also
// makes a reasoned ruling (`rationaleHash` + `rationaleUri`) REQUIRED on resolve.
//
//   reach a submitted CreatorReview task (hire -> claim -> submit)
//     -> worker initiates a COMPLETE dispute        (facade.initiateDispute, resolutionType 1)
//     -> the protocol authority assigns a resolver  (facade.assignDisputeResolver)
//     -> the assigned resolver resolves (approve)    (facade.resolveDispute + rationale)
//
// On-chain assertions (REAL decoded state after resolve):
//   (a) the Dispute account decodes to DisputeStatus.Resolved with ZERO voters and the
//       P6.3 ruling bit (votesFor == 1, votesAgainst == 0 on an APPROVE ruling),
//   (b) the Task account decodes to TaskStatus.Completed (Complete dispute -> worker wins),
//   (c) the worker's (provider authority's) lamport balance strictly increased — the
//       escrow paid out the reward through dispute resolution, not direct completion.
describe("e2e: dispute -> roster resolve settles the task on the real program", () => {
  it("drives initiate -> assign resolver -> resolve (Complete) end-to-end on-chain, no votes", async () => {
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
        moderator: moderator.address,
      }),
    ]);
    const [task] = await findTaskPda({ creator: buyer.address, taskId });
    const [escrow] = await facade.findEscrowPda({ task });

    // 5) Moderation authority records a CLEAN task moderation.
    const jobHash = new Uint8Array(32).fill(55);
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

    // ---- Dispute -> resolve flow ----

    // 8) Worker opens a COMPLETE dispute (resolutionType 1 -> worker wins on approval).
    //    The worker is the initiator, so its on-chain claim is the initiatorClaim.
    const disputeId = new Uint8Array(32).fill(77);
    const evidenceHash = new Uint8Array(32).fill(1);
    await send(svm, provider, [
      await facade.initiateDispute({
        task,
        agent: providerAgent,
        authority: provider,
        initiatorClaim: workerClaim,
        taskSubmission,
        disputeId,
        taskId,
        evidenceHash,
        resolutionType: 1, // Complete
        evidence: "evidence",
      }),
    ]);
    const [dispute] = await findDisputePda({ disputeId });

    // Sanity: the dispute is Active and the task moved to Disputed.
    {
      const dBytes = accountData(svm, dispute);
      expect(dBytes).not.toBeNull();
      expect(getDisputeDecoder().decode(dBytes!).status).toBe(DisputeStatus.Active);
    }

    // 9) The protocol authority assigns a dedicated dispute resolver to the roster. The
    //    assigned wallet can then resolve directly — no arbiters, no votes.
    const resolver = await fundedSigner(svm);
    await send(svm, admin, [
      await facade.assignDisputeResolver({
        authority: admin,
        resolver: resolver.address,
        multisigSigners: [multisigApproverA, multisigApproverB],
      }),
    ]);
    const [resolverAssignment] = await facade.findDisputeResolverPda({
      resolver: resolver.address,
    });

    // Sanity: the retired voter byte carries counter provenance; it is not a tally.
    {
      const dBytes = accountData(svm, dispute);
      const d = getDisputeDecoder().decode(dBytes!);
      expect(d.totalVoters).toBe(255);
    }

    // Snapshot the worker authority balance right before resolution so the delta is
    // attributable to the escrow payout on the Complete resolution (the worker never
    // signs the resolve tx — the resolver does — so no fee skews this leg).
    const workerBalBefore = svm.getBalance(provider.address) ?? 0n;

    // 10) The ASSIGNED resolver resolves the dispute directly — no voting-period wait, no
    //     remaining accounts. P6.4: a reasoned ruling (rationaleHash + rationaleUri) is
    //     REQUIRED. The facade derives escrow / protocol-config / hire-record and the
    //     creator/worker completion-bond PDAs; we pass the resolver's roster assignment so
    //     its case counters are bumped.
    await send(svm, resolver, [
      await facade.resolveDispute({
        dispute,
        task,
        authority: resolver,
        resolverAssignment,
        approve: true,
        rationaleHash: new Uint8Array(32).fill(5),
        rationaleUri: "agenc://ruling/sha256/complete",
        creator: buyer.address,
        workerClaim,
        worker: providerAgent,
        workerWallet: provider.address,
        taskSubmission,
        bondTreasury: admin.address,
        // creator/worker completion bonds derive from task+creator / task+workerWallet
      }),
    ]);

    // ---- REAL on-chain assertions ----

    // (a) The Dispute account decodes to Resolved (no longer Active) with the
    //     initiator-counter provenance sentinel and the P6.3 ruling bit set:
    //     APPROVE -> votesFor == 1, votesAgainst == 0. None of these retired
    //     fields is an arbiter tally.
    const disputeBytes = accountData(svm, dispute);
    expect(disputeBytes).not.toBeNull();
    const decodedDispute = getDisputeDecoder().decode(disputeBytes!);
    expect(decodedDispute.status).toBe(DisputeStatus.Resolved);
    expect(decodedDispute.totalVoters).toBe(255);
    expect(decodedDispute.votesFor).toBe(1n);
    expect(decodedDispute.votesAgainst).toBe(0n);

    // (b) The Task account decodes to Completed: a Complete dispute settled in the
    //     worker's favor, so the task is finalized through dispute resolution.
    const taskBytes = accountData(svm, task);
    expect(taskBytes).not.toBeNull();
    expect(getTaskDecoder().decode(taskBytes!).status).toBe(TaskStatus.Completed);

    // (c) The worker's lamport balance strictly increased: the escrow paid out the
    //     reward to the worker authority during resolution. (escrow is now drained.)
    const workerBalAfter = svm.getBalance(provider.address) ?? 0n;
    expect(workerBalAfter).toBeGreaterThan(workerBalBefore);

    // (d) The escrow account was closed/drained on settlement (no live escrow lamports).
    expect(svm.getBalance(escrow) ?? 0n).toBe(0n);
  });
});
