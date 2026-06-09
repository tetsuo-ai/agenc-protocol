import { describe, it, expect } from "vitest";
import { AccountRole, type Address, type Instruction } from "@solana/kit";
import {
  facade,
  findAgentPda,
  findTaskPda,
  findClaimPda,
  findDisputePda,
  findVoteDisputeVotePda,
  getDisputeDecoder,
  getTaskDecoder,
  DisputeStatus,
  TaskStatus,
} from "../src/index.js";
import {
  freshSvm,
  seedProtocolConfig,
  seedModerationConfig,
  seedAgentStake,
  fundedSigner,
  send,
  accountData,
} from "./harness.js";

// REAL on-chain execution of the dispute -> resolve flow against the compiled
// agenc-coordination program in litesvm, driven entirely by SDK-built (@solana/kit)
// instructions. This is the PORT of the web3.js/anchor dispute sequence from
// tests-integration/marketplace.test.mjs (`runHireSettlement` stopBeforeComplete +
// the "completion bond: resolve_dispute Complete ..." / paused-resolve tests):
//
//   reach a claimed InProgress task (the proven hire+claim port, verbatim)
//     -> worker initiates a COMPLETE dispute        (facade.initiateDispute, resolutionType 1)
//     -> register 3 ARBITER agents (cap 1<<7) + seed each >= minArbiterStake
//     -> each arbiter votes approve (true)          (facade.voteDispute)
//     -> warp the clock past the voting deadline    (svm.setClock)
//     -> resolve the dispute                         (facade.resolveDispute)
//          with the (vote PDA, arbiterAgent PDA) pairs appended as REMAINING ACCOUNTS,
//          mirroring the reference's remainingAccounts ordering exactly.
//
// minArbiterStake is seeded to 1_000_000 so arbiter votes carry weight; each arbiter
// agent is seeded to that stake so the three approvals clear the approval threshold and
// the Complete resolution fires.
//
// On-chain assertions (REAL decoded state after resolve):
//   (a) the Dispute account decodes to DisputeStatus.Resolved with votesFor == 3,
//   (b) the Task account decodes to TaskStatus.Completed (Complete dispute -> worker wins),
//   (c) the worker's (provider authority's) lamport balance strictly increased — the
//       escrow paid out the reward through dispute resolution, not direct completion.
describe("e2e: dispute -> resolve settles the task on the real program", () => {
  it("drives initiate -> vote x3 -> resolve (Complete) end-to-end on-chain", async () => {
    const svm = freshSvm();

    // Admin owns ProtocolConfig (treasury) and ModerationConfig authority. Seed a
    // non-zero minArbiterStake so arbiter votes carry weight toward the approval gate.
    const admin = await fundedSigner(svm);
    const MIN_ARBITER_STAKE = 1_000_000n;
    await seedProtocolConfig(svm, admin.address, {
      minArbiterStake: MIN_ARBITER_STAKE,
    });

    // Real, funded signers for each actor (these MUST sign their own instructions).
    const provider = await fundedSigner(svm); // worker wallet
    const buyer = await fundedSigner(svm); // creator/hiring wallet
    const moderator = await fundedSigner(svm); // moderation authority

    await seedModerationConfig(svm, admin.address, moderator.address, true);

    // ---- Reach a claimed InProgress task (the proven hire+claim port, verbatim) ----

    // 1) Register the provider (worker) agent and the buyer (hiring) agent.
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

    const buyerAgentId = new Uint8Array(32).fill(22);
    await send(svm, buyer, [
      await facade.registerAgent({
        authority: buyer,
        agentId: buyerAgentId,
        capabilities: 1n,
        endpoint: "http://buyer.test",
        metadataUri: null,
        stakeAmount: 0n,
      }),
    ]);
    const [buyerAgent] = await findAgentPda({ agentId: buyerAgentId });

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

    // 4) Buyer hires the listing -> mints an Open Task + escrow + HireRecord.
    const taskId = new Uint8Array(32).fill(44);
    await send(svm, buyer, [
      await facade.hireFromListing({
        listing,
        creatorAgent: buyerAgent,
        authority: buyer,
        creator: buyer,
        taskId,
        expectedPrice: price,
        expectedVersion: 1n,
        listingSpecHash,
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
      }),
    ]);

    // 7) Worker claims the published task -> task is now InProgress, with a live claim.
    await send(svm, provider, [
      await facade.claimTaskWithJobSpec({
        task,
        worker: providerAgent,
        authority: provider,
      }),
    ]);
    // The worker's claim PDA is seeded by [task, worker-agent] (bidder == the agent PDA).
    const [workerClaim] = await findClaimPda({ task, bidder: providerAgent });

    // Sanity: the task really reached InProgress before we dispute it.
    {
      const tBytes = accountData(svm, task);
      expect(tBytes).not.toBeNull();
      expect(getTaskDecoder().decode(tBytes!).status).toBe(TaskStatus.InProgress);
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

    // 9) Register 3 distinct ARBITER agents (ARBITER capability = 1<<7 = 128), seed each
    //    with >= minArbiterStake so its approval vote carries weight, then vote approve.
    //    resolve_dispute needs the (vote, arbiter) pairs as remaining_accounts, in that
    //    exact order — mirror the reference.
    const arbiterRemaining: { address: Address; role: AccountRole }[] = [];
    for (let i = 0; i < 3; i++) {
      const arb = await fundedSigner(svm);
      const arbId = new Uint8Array(32).fill(100 + i);
      await send(svm, arb, [
        await facade.registerAgent({
          authority: arb,
          agentId: arbId,
          capabilities: 128n, // ARBITER
          endpoint: "http://arb.test",
          metadataUri: null,
          stakeAmount: 0n,
        }),
      ]);
      const [arbAgent] = await findAgentPda({ agentId: arbId });
      // Give the arbiter agent vote weight (>= minArbiterStake).
      seedAgentStake(svm, arbAgent, MIN_ARBITER_STAKE);

      await send(svm, arb, [
        await facade.voteDispute({
          dispute,
          task,
          arbiter: arbAgent,
          authority: arb,
          approve: true,
        }),
      ]);

      // The per-arbiter (vote, arbiter) pair are the resolve remaining accounts. The
      // Sybil-guard authorityVote PDA is auto-derived inside voteDispute and is NOT a
      // remaining account (mirrors the reference, which only passes vote + arbiter).
      const [votePda] = await findVoteDisputeVotePda({ dispute, arbiter: arbAgent });
      arbiterRemaining.push(
        { address: votePda, role: AccountRole.WRITABLE },
        { address: arbAgent, role: AccountRole.WRITABLE },
      );
    }

    // Sanity: all three approvals landed before warping the clock. `votesFor` is the
    // cumulative *vote weight* (derived from each arbiter's staked balance), not a head
    // count — so assert the head count via totalVoters and that the approval weight is
    // strictly positive (each staked arbiter contributed weight).
    {
      const dBytes = accountData(svm, dispute);
      const d = getDisputeDecoder().decode(dBytes!);
      expect(d.totalVoters).toBe(3);
      expect(d.votesFor).toBeGreaterThan(0n);
      expect(d.votesAgainst).toBe(0n);
    }

    // 10) Warp the clock past the voting deadline (created_at + 86400s voting period)
    //     but before dispute expiry, so resolve_dispute (not expire) is the valid path.
    const clk = svm.getClock();
    clk.unixTimestamp = clk.unixTimestamp + 86400n + 100n;
    svm.setClock(clk);

    // Snapshot the worker authority balance right before resolution so the delta is
    // attributable to the escrow payout on the Complete resolution (the worker never
    // signs the resolve tx — admin does — so no fee skews this leg).
    const workerBalBefore = svm.getBalance(provider.address) ?? 0n;

    // 11) Admin (protocol authority) resolves the dispute. The facade derives the
    //     escrow / protocol-config / hire-record and the creator/worker completion-bond
    //     PDAs; we pass the worker agent + worker wallet so the bond PDA derives. Then we
    //     APPEND the (vote, arbiter) remaining-account pairs to the kit instruction's
    //     account list (kit instructions are plain objects).
    const resolveIx = await facade.resolveDispute({
      dispute,
      task,
      authority: admin,
      approve: true,
      creator: buyer.address,
      workerClaim,
      worker: providerAgent,
      workerWallet: provider.address,
      bondTreasury: admin.address,
      // creator/worker completion bonds derive from task+creator / task+workerWallet
    });
    const resolveWithArbiters: Instruction = {
      ...resolveIx,
      accounts: [...(resolveIx.accounts ?? []), ...arbiterRemaining],
    };
    await send(svm, admin, [resolveWithArbiters]);

    // ---- REAL on-chain assertions ----

    // (a) The Dispute account decodes to Resolved (no longer Active), 3 voters, all
    //     approving (votesFor weight > 0, no votes against).
    const disputeBytes = accountData(svm, dispute);
    expect(disputeBytes).not.toBeNull();
    const decodedDispute = getDisputeDecoder().decode(disputeBytes!);
    expect(decodedDispute.status).toBe(DisputeStatus.Resolved);
    expect(decodedDispute.totalVoters).toBe(3);
    expect(decodedDispute.votesFor).toBeGreaterThan(0n);
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
