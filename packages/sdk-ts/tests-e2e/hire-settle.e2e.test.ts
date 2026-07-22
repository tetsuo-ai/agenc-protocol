import { describe, it, expect } from "vitest";
import {
  facade,
  findAgentPda,
  findTaskPda,
  findHireRecordPda,
  findModerationBlockPda,
  getTaskDecoder,
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

// REAL on-chain execution of the core embeddable happy path against the compiled
// agenc-coordination program in litesvm, driven entirely by SDK-built (@solana/kit)
// instructions. This is the PORT of the web3.js/anchor `runHireSettlement` flow from
// tests-integration/marketplace.test.mjs:
//
//   register provider agent + buyer agent  (facade.registerAgent)
//     -> create service listing            (facade.createServiceListing)
//     -> seed ModerationConfig (harness)   -> recordListingModeration
//     -> hireFromListing (mints Task + escrow + HireRecord)
//     -> recordTaskModeration -> setTaskJobSpec -> claimTaskWithJobSpec
//     -> completeTask (settles escrow, pays the worker)
//
// Each instruction is sent in its own real, signed transaction whose fee payer IS the
// instruction's required authority signer, so signTransactionMessageWithSigners actually
// signs it (only one fee payer per tx; hire requires authority == creator, so the buyer
// pays both legs of that single instruction).
//
// On-chain assertions: the Task account decodes to TaskStatus.Completed and the worker's
// (provider authority's) lamport balance strictly increased — i.e. the worker was paid.
describe("e2e: hire -> settle pays the worker on the real program", () => {
  it("drives the embeddable hire/settle happy path end-to-end on-chain", async () => {
    const svm = freshSvm();

    // Admin owns ProtocolConfig (treasury) and ModerationConfig authority.
    const admin = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);

    // Real, funded signers for each actor (these MUST sign their own instructions).
    const provider = await fundedSigner(svm); // worker wallet
    const buyer = await fundedSigner(svm); // creator/hiring wallet
    const moderator = await fundedSigner(svm); // moderation authority

    // Moderation gate enabled, with `moderator` as the moderation authority so the
    // record* calls (signed by `moderator`) are accepted.
    await seedModerationConfig(svm, admin.address, moderator.address, true);

    // 1) Register the provider agent (the worker identity) and the buyer agent
    //    (the hiring identity). Each is signed by its own wallet.
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

    // 2) Provider creates a standing service listing. The listing's pinned spec_hash
    //    binds the listing-moderation attestation PDA, so we keep it as a known value.
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

    // 3) Moderation authority records a CLEAN listing moderation (status 0, risk 0) so
    //    the fail-closed hire gate passes. Keyed by (listing, listingSpecHash).
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

    // 4) Buyer hires the listing -> mints an Open Task + escrow + HireRecord in one ix.
    //    authority == creator == buyer (enforced on-chain), so buyer is the fee payer.
    const taskId = new Uint8Array(32).fill(44);
    const jobHash = new Uint8Array(32).fill(55);
    await send(svm, buyer, [
      await facade.hireFromListing({
        listing,
        providerAgent,
        creatorAgent: buyerAgent,
        authority: buyer,
        creator: buyer,
        taskId,
        expectedPrice: price,
        expectedVersion: 1n,
        listingSpecHash,
        taskJobSpecHash: jobHash,
        moderator: moderator.address,
      }),
    ]);
    const [task] = await findTaskPda({ creator: buyer.address, taskId });

    // 5) Moderation authority records a CLEAN task moderation, keyed by (task, jobHash).
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

    // 6) Creator pins/publishes the task job spec (must reference the moderated jobHash).
    await send(svm, buyer, [
      await facade.setTaskJobSpec({
        task,
        creator: buyer,
        jobSpecHash: jobHash,
        jobSpecUri: "agenc://job-spec/sha256/x",
        moderator: moderator.address,
      }),
    ]);

    // 7) Worker claims the published task. authority = provider wallet, worker = agent PDA.
    await send(svm, provider, [
      await facade.claimTaskWithJobSpec({
        task,
        worker: providerAgent,
        authority: provider,
        moderationBlock: await moderationBlockFor(jobHash),
        jobSpecHash: jobHash,
      }),
    ]);

    // Snapshot the worker authority balance right before settlement so the delta is
    // attributable to the reward payout (and not the claim/publish fees the worker
    // never paid — the worker only signed the claim tx above).
    const workerBalBefore = svm.getBalance(provider.address) ?? 0n;

    // 8) Worker completes the task — settles the escrow on the direct-pay path. The
    //    HireRecord is ALWAYS required (its derived ["hire", task] address), even with
    //    no operator fee, so a worker cannot omit it to dodge an operator's cut.
    const [hireRecord] = await findHireRecordPda({ task });
    await send(svm, provider, [
      await facade.completeTask({
        task,
        creator: buyer.address,
        worker: providerAgent,
        treasury: admin.address,
        authority: provider,
        hireRecord,
        proofHash: new Uint8Array(32).fill(66),
        resultData: null,
      }),
    ]);

    // ---- REAL on-chain assertions ----

    // (a) The Task account decodes to Completed.
    const taskBytes = accountData(svm, task);
    expect(taskBytes).not.toBeNull();
    const decodedTask = getTaskDecoder().decode(taskBytes!);
    expect(decodedTask.status).toBe(TaskStatus.Completed);

    // (b) The worker's lamport balance strictly increased: the escrow paid out the
    //     reward to the worker authority at completion.
    const workerBalAfter = svm.getBalance(provider.address) ?? 0n;
    expect(workerBalAfter).toBeGreaterThan(workerBalBefore);
  });
});
