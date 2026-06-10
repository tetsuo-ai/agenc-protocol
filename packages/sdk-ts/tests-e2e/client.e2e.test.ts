// REAL on-chain execution of the FULL marketplace flow driven entirely through
// createMarketplaceClient — zero manual kit plumbing. The litesvm Transport
// (./litesvm-transport.ts) plugs the in-process VM into the exact same
// assemble/sign/confirm/error pipeline production uses against a kit RPC; every
// transaction below goes through client methods (named conveniences or
// client.send of facade-built instructions).
//
// Flows ported from the existing e2e suite:
//  - hire-settle: register provider+buyer -> listing -> listing moderation ->
//    hireFromListing -> task moderation -> job spec -> claim -> (bonds) ->
//    complete_task settles the hired task and refunds the bonds. (An
//    agent-hired task settles on the direct-pay path; configure_task_validation
//    rejects tasks with a live HireRecord, so submit/accept is exercised on the
//    CreatorReview flow below, exactly like the existing suite splits them.)
//  - manual-validation: createTask -> CreatorReview -> claim -> submit ->
//    accept settles to the worker.
// Plus a forced deterministic on-chain failure asserting AgencError hydration.
import { describe, it, expect } from "vitest";
import {
  facade,
  findAgentPda,
  findTaskPda,
  findHireRecordPda,
  findCompletionBondPda,
  findClaimPda,
  findTaskSubmissionPda,
  getTaskDecoder,
  getTaskSubmissionDecoder,
  TaskStatus,
  SubmissionStatus,
  AGENC_COORDINATION_ERROR__INVALID_CAPABILITIES,
} from "../src/index.js";
import { AgencError, createMarketplaceClient } from "../src/client/index.js";
import {
  freshSvm,
  seedProtocolConfig,
  seedModerationConfig,
  fundedSigner,
  accountData,
} from "./harness.js";
import { createLiteSvmTransport } from "./litesvm-transport.js";

describe("e2e: createMarketplaceClient drives the real program end-to-end", () => {
  it("runs the full hire flow — register x2, list, moderate, hire, claim, bond, settle — through client methods only", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    const moderator = await fundedSigner(svm);
    const provider = await fundedSigner(svm); // worker wallet
    const buyer = await fundedSigner(svm); // creator/hiring wallet
    await seedProtocolConfig(svm, admin.address);
    await seedModerationConfig(svm, admin.address, moderator.address, true);

    // ONE transport (one chain), one client per actor — each instruction's
    // authority signer is that client's fee payer, mirroring the existing suite.
    const transport = createLiteSvmTransport(svm);
    const providerClient = createMarketplaceClient({ transport, signer: provider });
    const buyerClient = createMarketplaceClient({ transport, signer: buyer });
    const moderatorClient = createMarketplaceClient({ transport, signer: moderator });

    // 1) register provider + buyer agents (named convenience methods).
    const providerAgentId = new Uint8Array(32).fill(11);
    const registerResult = await providerClient.registerAgent({
      authority: provider,
      agentId: providerAgentId,
      capabilities: 1n,
      endpoint: "http://provider.test",
      metadataUri: null,
      stakeAmount: 0n,
    });
    expect(typeof registerResult.signature).toBe("string");
    expect(registerResult.signature.length).toBeGreaterThan(0);
    expect(registerResult.logs.length).toBeGreaterThan(0);
    const [providerAgent] = await findAgentPda({ agentId: providerAgentId });

    const buyerAgentId = new Uint8Array(32).fill(22);
    await buyerClient.registerAgent({
      authority: buyer,
      agentId: buyerAgentId,
      capabilities: 1n,
      endpoint: "http://buyer.test",
      metadataUri: null,
      stakeAmount: 0n,
    });
    const [buyerAgent] = await findAgentPda({ agentId: buyerAgentId });

    // 2) provider lists a service (named convenience).
    const listingId = new Uint8Array(32).fill(33);
    const listingSpecHash = new Uint8Array(32).fill(7);
    const price = 1_000_000n;
    await providerClient.createServiceListing({
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
    });
    const [listing] = await facade.findListingPda({ providerAgent, listingId });

    // 3) CLEAN listing moderation so the fail-closed hire gate passes
    //    (same seeding the existing listing/hire e2e tests use).
    await moderatorClient.send([
      await facade.recordListingModeration({
        moderator,
        listing,
        jobSpecHash: listingSpecHash,
        status: 0, // CLEAN
        riskScore: 0,
        categoryMask: 0n,
        policyHash: new Uint8Array(32).fill(9),
        scannerHash: new Uint8Array(32).fill(8),
        expiresAt: 0n,
      }),
    ]);

    // 4) buyer hires the listing (named convenience) -> Task + escrow + HireRecord.
    const taskId = new Uint8Array(32).fill(44);
    await buyerClient.hireFromListing({
      listing,
      creatorAgent: buyerAgent,
      authority: buyer,
      creator: buyer,
      taskId,
      expectedPrice: price,
      expectedVersion: 1n,
      listingSpecHash,
    });
    const [task] = await findTaskPda({ creator: buyer.address, taskId });

    // 5) CLEAN task moderation + job-spec pin (claim is gated on both).
    const jobSpecHash = new Uint8Array(32).fill(55);
    await moderatorClient.send([
      await facade.recordTaskModeration({
        moderator,
        task,
        jobSpecHash,
        status: 0,
        riskScore: 0,
        categoryMask: 0n,
        policyHash: new Uint8Array(32).fill(1),
        scannerHash: new Uint8Array(32).fill(2),
        expiresAt: 0n,
      }),
    ]);
    await buyerClient.send([
      await facade.setTaskJobSpec({
        task,
        creator: buyer,
        jobSpecHash,
        jobSpecUri: "agenc://job-spec/sha256/x",
      }),
    ]);

    // 6) provider claims the hired task (named convenience) -> InProgress.
    await providerClient.claimTaskWithJobSpec({
      task,
      worker: providerAgent,
      authority: provider,
    });
    expect(getTaskDecoder().decode(accountData(svm, task)!).status).toBe(
      TaskStatus.InProgress,
    );

    // 7) both parties post 25% completion bonds (named convenience).
    await buyerClient.postCompletionBond({ authority: buyer, task, role: 0 });
    await providerClient.postCompletionBond({ authority: provider, task, role: 1 });
    const [creatorBond] = await findCompletionBondPda({
      task,
      authority: buyer.address,
    });
    const [workerBond] = await findCompletionBondPda({
      task,
      authority: provider.address,
    });
    expect(accountData(svm, creatorBond)).not.toBeNull();
    expect(accountData(svm, workerBond)).not.toBeNull();

    // 8) provider settles the hired task on the direct-pay path, passing the
    //    HireRecord (always required for hires) and both bonds so they refund.
    const workerBalBefore = svm.getBalance(provider.address) ?? 0n;
    const [hireRecord] = await findHireRecordPda({ task });
    await providerClient.send([
      await facade.completeTask({
        task,
        creator: buyer.address,
        worker: providerAgent,
        treasury: admin.address,
        authority: provider,
        hireRecord,
        creatorCompletionBond: creatorBond,
        workerCompletionBond: workerBond,
        proofHash: new Uint8Array(32).fill(66),
        resultData: null,
      }),
    ]);

    // ---- REAL on-chain assertions ----
    expect(getTaskDecoder().decode(accountData(svm, task)!).status).toBe(
      TaskStatus.Completed,
    );
    // worker got paid (reward + bond refund >> fees paid as fee payer)
    expect(svm.getBalance(provider.address) ?? 0n).toBeGreaterThan(
      workerBalBefore,
    );
    // both bonds were refunded + closed at settlement
    expect(accountData(svm, creatorBond)).toBeNull();
    expect(accountData(svm, workerBond)).toBeNull();
  });

  it("drives a CreatorReview task to acceptance — claim, submit, accept — through client methods only", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    const modAuth = await fundedSigner(svm);
    const creator = await fundedSigner(svm);
    const worker = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);
    await seedModerationConfig(svm, admin.address, modAuth.address, true);

    const transport = createLiteSvmTransport(svm);
    const creatorClient = createMarketplaceClient({ transport, signer: creator });
    const workerClient = createMarketplaceClient({ transport, signer: worker });
    const modClient = createMarketplaceClient({ transport, signer: modAuth });

    // register creator + worker agents
    const creatorAgentId = new Uint8Array(32).fill(101);
    await creatorClient.registerAgent({
      authority: creator,
      agentId: creatorAgentId,
      capabilities: 1n,
      endpoint: "http://creator.test",
      metadataUri: null,
      stakeAmount: 0n,
    });
    const [creatorAgent] = await findAgentPda({ agentId: creatorAgentId });

    const workerAgentId = new Uint8Array(32).fill(102);
    await workerClient.registerAgent({
      authority: worker,
      agentId: workerAgentId,
      capabilities: 1n,
      endpoint: "http://worker.test",
      metadataUri: null,
      stakeAmount: 0n,
    });
    const [workerAgent] = await findAgentPda({ agentId: workerAgentId });

    // create an Auto task, then pin CreatorReview validation (manual flow)
    const taskId = new Uint8Array(32).fill(103);
    const reward = 2_000_000n;
    const now = svm.getClock().unixTimestamp;
    await creatorClient.send([
      await facade.createTask({
        authority: creator,
        creator,
        creatorAgent,
        taskId,
        requiredCapabilities: 1n,
        description: new Uint8Array(64).fill(104),
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
    const [hireRecord] = await findHireRecordPda({ task }); // empty PDA (non-hired)
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

    // moderation + job-spec pin, then the worker claims (named convenience)
    const jobSpecHash = new Uint8Array(32).fill(105);
    await modClient.send([
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
    await creatorClient.send([
      await facade.setTaskJobSpec({
        task,
        creator,
        jobSpecHash,
        jobSpecUri: "agenc://job-spec/sha256/manual",
      }),
    ]);
    await workerClient.claimTaskWithJobSpec({
      task,
      worker: workerAgent,
      authority: worker,
    });

    // submit (worker) -> PendingValidation, submission Submitted
    await workerClient.submitTaskResult({
      task,
      worker: workerAgent,
      authority: worker,
      proofHash: new Uint8Array(32).fill(106),
      resultData: new Uint8Array(64).fill(9),
    });
    const [claim] = await findClaimPda({ task, bidder: workerAgent });
    const [submission] = await findTaskSubmissionPda({ claim });
    expect(getTaskDecoder().decode(accountData(svm, task)!).status).toBe(
      TaskStatus.PendingValidation,
    );
    expect(
      getTaskSubmissionDecoder().decode(accountData(svm, submission)!).status,
    ).toBe(SubmissionStatus.Submitted);

    // accept (creator) -> Completed, submission Accepted, worker paid
    const workerBalBefore = svm.getBalance(worker.address) ?? 0n;
    await creatorClient.acceptTaskResult({
      task,
      worker: workerAgent,
      creator,
      treasury: admin.address,
      workerAuthority: worker.address,
    });

    expect(getTaskDecoder().decode(accountData(svm, task)!).status).toBe(
      TaskStatus.Completed,
    );
    expect(
      getTaskSubmissionDecoder().decode(accountData(svm, submission)!).status,
    ).toBe(SubmissionStatus.Accepted);
    expect(svm.getBalance(worker.address) ?? 0n).toBeGreaterThan(
      workerBalBefore,
    );
  });

  it("rejects a forced on-chain failure with an AgencError whose code/errorName match the generated constant", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);
    const wallet = await fundedSigner(svm);
    const client = createMarketplaceClient({
      transport: createLiteSvmTransport(svm),
      signer: wallet,
    });

    // Deterministic program failure: register_agent requires a non-zero
    // capabilities bitmask -> CoordinationError::InvalidCapabilities (0x1774).
    const failure = await client
      .registerAgent({
        authority: wallet,
        agentId: new Uint8Array(32).fill(201),
        capabilities: 0n, // invalid on-chain
        endpoint: "http://invalid.test",
        metadataUri: null,
        stakeAmount: 0n,
      })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AgencError);
    const agencError = failure as AgencError;
    expect(agencError.code).toBe(AGENC_COORDINATION_ERROR__INVALID_CAPABILITIES);
    expect(agencError.errorName).toBe(
      "AGENC_COORDINATION_ERROR__INVALID_CAPABILITIES",
    );
    // the litesvm transport surfaced the real program logs on the failure
    expect(agencError.logs.length).toBeGreaterThan(0);
    expect(agencError.logs.join("\n")).toContain("custom program error");
  });
});
