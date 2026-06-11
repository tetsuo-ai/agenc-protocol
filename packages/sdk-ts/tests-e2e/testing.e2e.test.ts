// REAL on-chain execution of the FULL marketplace flow driven entirely through
// the PUBLIC ./testing surface (startLocalMarketplace) — no harness imports,
// no manual seeding, no manual transport wiring. This is the consumer-facing
// sandbox: if these tests pass, the README quickstart works.
//
// Recipes mirrored from client.e2e.test.ts:
//  - hire flow: register provider+buyer -> listing -> attestListing ->
//    hireFromListing -> attestTask -> setTaskJobSpec -> claim -> bonds ->
//    completeTask settles and refunds the bonds (an agent-hired task settles
//    on the direct-pay path; configure_task_validation rejects tasks with a
//    live HireRecord, so submit/accept runs on the CreatorReview flow below).
//  - CreatorReview flow: createTask -> configureTaskValidation -> attestTask
//    -> setTaskJobSpec -> claim -> submit -> accept settles to the worker.
import { describe, it, expect, vi } from "vitest";
import type { Address } from "@solana/kit";
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
} from "../src/index.js";
import {
  startLocalMarketplace,
  resolveTestingProgramSo,
  DEFAULT_FUNDING_LAMPORTS,
  type LocalMarketplace,
} from "../src/testing/index.js";

// node:fs passthrough mock used ONLY by the missing-.so test below: with
// forceMissingSo=false (the default) every call delegates to the real
// existsSync, so all other tests in this file see the untouched filesystem.
const fsMockState = vi.hoisted(() => ({ forceMissingSo: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (target: Parameters<typeof actual.existsSync>[0]) =>
      fsMockState.forceMissingSo ? false : actual.existsSync(target),
  };
});

function accountData(
  market: LocalMarketplace,
  addr: Address,
): Uint8Array | null {
  const account = market.svm.getAccount(addr);
  if (!account || !account.exists) return null;
  return Uint8Array.from(account.data);
}

describe("e2e: startLocalMarketplace drives the real program through the public ./testing surface", () => {
  it("runs the full hire flow — register x2, list, attestListing, hire, attestTask, claim, bond, settle", async () => {
    const market = await startLocalMarketplace();

    // Two actors funded by the sandbox, one client per actor — each
    // instruction's authority signer is that client's fee payer.
    const provider = await market.fundedSigner(); // worker wallet
    const buyer = await market.fundedSigner(); // creator/hiring wallet
    const providerClient = market.clientFor(provider);
    const buyerClient = market.clientFor(buyer);

    // 1) register provider + buyer agents.
    const providerAgentId = new Uint8Array(32).fill(11);
    const registerResult = await providerClient.registerAgent({
      authority: provider,
      agentId: providerAgentId,
      capabilities: 1n,
      endpoint: "http://provider.test",
      metadataUri: null,
      stakeAmount: 0n,
    });
    expect(registerResult.signature.length).toBeGreaterThan(0);
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

    // 2) provider lists a service.
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

    // 3) the sandbox moderator records the CLEAN listing attestation so the
    //    fail-closed hire gate passes unaided.
    await market.moderator.attestListing(listing, listingSpecHash);

    // 4) buyer hires the listing -> Task + escrow + HireRecord.
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

    // 5) CLEAN task attestation + job-spec pin (claim is gated on both).
    const jobSpecHash = new Uint8Array(32).fill(55);
    await market.moderator.attestTask(task, jobSpecHash);
    await buyerClient.send([
      await facade.setTaskJobSpec({
        task,
        creator: buyer,
        jobSpecHash,
        jobSpecUri: "agenc://job-spec/sha256/x",
      }),
    ]);

    // 6) provider claims the hired task -> InProgress.
    await providerClient.claimTaskWithJobSpec({
      task,
      worker: providerAgent,
      authority: provider,
    });
    expect(getTaskDecoder().decode(accountData(market, task)!).status).toBe(
      TaskStatus.InProgress,
    );

    // 7) both parties post 25% completion bonds.
    await buyerClient.postCompletionBond({ authority: buyer, task, role: 0 });
    await providerClient.postCompletionBond({
      authority: provider,
      task,
      role: 1,
    });
    const [creatorBond] = await findCompletionBondPda({
      task,
      party: buyer.address,
    });
    const [workerBond] = await findCompletionBondPda({
      task,
      party: provider.address,
    });
    expect(accountData(market, creatorBond)).not.toBeNull();
    expect(accountData(market, workerBond)).not.toBeNull();

    // 8) provider settles on the direct-pay path; the sandbox admin doubles
    //    as the protocol treasury.
    const workerBalBefore = market.svm.getBalance(provider.address) ?? 0n;
    const [hireRecord] = await findHireRecordPda({ task });
    await providerClient.send([
      await facade.completeTask({
        task,
        creator: buyer.address,
        worker: providerAgent,
        treasury: market.admin.address,
        authority: provider,
        hireRecord,
        creatorCompletionBond: creatorBond,
        workerCompletionBond: workerBond,
        proofHash: new Uint8Array(32).fill(66),
        resultData: null,
      }),
    ]);

    // ---- REAL on-chain assertions ----
    expect(getTaskDecoder().decode(accountData(market, task)!).status).toBe(
      TaskStatus.Completed,
    );
    // worker got paid (reward + bond refund >> the fees it paid)
    expect(market.svm.getBalance(provider.address) ?? 0n).toBeGreaterThan(
      workerBalBefore,
    );
    // both bonds were refunded + closed at settlement
    expect(accountData(market, creatorBond)).toBeNull();
    expect(accountData(market, workerBond)).toBeNull();
  });

  it("drives a CreatorReview task to acceptance — create, attestTask, claim, submit, accept", async () => {
    const market = await startLocalMarketplace();
    const creator = await market.fundedSigner();
    const worker = await market.fundedSigner();
    const creatorClient = market.clientFor(creator);
    const workerClient = market.clientFor(worker);

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

    // create an Auto task, then pin CreatorReview validation (manual flow);
    // the sandbox clock is deterministic, so deadline math is too.
    const taskId = new Uint8Array(32).fill(103);
    const now = market.svm.getClock().unixTimestamp;
    await creatorClient.send([
      await facade.createTask({
        authority: creator,
        creator,
        creatorAgent,
        taskId,
        requiredCapabilities: 1n,
        description: new Uint8Array(64).fill(104, 0, 32),
        rewardAmount: 2_000_000n,
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

    // sandbox attestation + job-spec pin, then the worker claims
    const jobSpecHash = new Uint8Array(32).fill(105);
    await market.moderator.attestTask(task, jobSpecHash);
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
    expect(getTaskDecoder().decode(accountData(market, task)!).status).toBe(
      TaskStatus.PendingValidation,
    );
    expect(
      getTaskSubmissionDecoder().decode(accountData(market, submission)!)
        .status,
    ).toBe(SubmissionStatus.Submitted);

    // accept (creator) -> Completed, submission Accepted, worker paid
    const workerBalBefore = market.svm.getBalance(worker.address) ?? 0n;
    await creatorClient.acceptTaskResult({
      task,
      worker: workerAgent,
      creator,
      treasury: market.admin.address,
      workerAuthority: worker.address,
    });

    expect(getTaskDecoder().decode(accountData(market, task)!).status).toBe(
      TaskStatus.Completed,
    );
    expect(
      getTaskSubmissionDecoder().decode(accountData(market, submission)!)
        .status,
    ).toBe(SubmissionStatus.Accepted);
    expect(market.svm.getBalance(worker.address) ?? 0n).toBeGreaterThan(
      workerBalBefore,
    );
  });

  it("exposes working sandbox utilities: fundedSigner amounts, expireBlockhash, attestation hash guards, missing-.so errors", async () => {
    const market = await startLocalMarketplace();

    // fundedSigner: default and explicit lamports actually land.
    const rich = await market.fundedSigner();
    expect(market.svm.getBalance(rich.address)).toBe(DEFAULT_FUNDING_LAMPORTS);
    const poor = await market.fundedSigner(5_000_000n);
    expect(market.svm.getBalance(poor.address)).toBe(5_000_000n);

    // expireBlockhash: advances past the current blockhash (the litesvm
    // identical-transaction dedupe escape hatch).
    const blockhashBefore = market.svm.latestBlockhash();
    market.expireBlockhash();
    expect(market.svm.latestBlockhash()).not.toBe(blockhashBefore);

    // the moderator refuses hashes the program would reject, with clear errors.
    const someAddress = market.admin.address;
    await expect(
      market.moderator.attestTask(someAddress, new Uint8Array(32)),
    ).rejects.toThrow(/all zeros/);
    await expect(
      market.moderator.attestListing(someAddress, new Uint8Array(31).fill(1)),
    ).rejects.toThrow(/32 bytes/);

    // a bad explicit programPath fails with the path in the message.
    await expect(
      startLocalMarketplace({ programPath: "/definitely/missing.so" }),
    ).rejects.toThrow(/\/definitely\/missing\.so/);
  });

  it("moderator.attest* throws a descriptive LOCAL error when started with moderationEnabled: false", async () => {
    const market = await startLocalMarketplace({ moderationEnabled: false });
    const someAddress = market.admin.address;
    const hash = new Uint8Array(32).fill(1);

    // Pre-fix these surfaced as opaque on-chain program errors; they must be
    // clear local errors that name the option that caused them and state what
    // moderationEnabled: false actually skips (only the hire-time listing
    // gate).
    await expect(
      market.moderator.attestTask(someAddress, hash),
    ).rejects.toThrow(/moderationEnabled: false/);
    await expect(
      market.moderator.attestListing(someAddress, hash),
    ).rejects.toThrow(/hire-time listing gate/);

    // The enabled default keeps working (sanity: attest fails for a different,
    // hash-shaped reason, never the moderation-disabled error).
    const enabledMarket = await startLocalMarketplace();
    await expect(
      enabledMarket.moderator.attestTask(someAddress, new Uint8Array(32)),
    ).rejects.toThrow(/all zeros/);
  });

  it("missing-.so error explains the bundler-relocation failure mode, not just reinstall", () => {
    // Simulate the bundled/relocated-module case: both probed candidate paths
    // miss (the real install is intact — see the passthrough mock up top).
    fsMockState.forceMissingSo = true;
    try {
      expect(() => resolveTestingProgramSo()).toThrow(
        /bundled\/copied out of node_modules/,
      );
      expect(() => resolveTestingProgramSo()).toThrow(
        /mark[\s\S]*@tetsuo-ai\/marketplace-sdk\/testing as external in your bundler or pass \{ programPath \}/,
      );
    } finally {
      fsMockState.forceMissingSo = false;
    }
  });
});
