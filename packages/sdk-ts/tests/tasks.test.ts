import { describe, it, expect } from "vitest";
import { AccountRole, address, createNoopSigner } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findTaskModerationPda,
  findModerationAttestorPda,
  findModerationBlockPda,
  getCreateTaskInstructionDataDecoder,
  getCreateTaskHumanlessInstructionDataDecoder,
  getCreateDependentTaskInstructionDataDecoder,
  getClaimTaskWithJobSpecInstructionDataDecoder,
  getSubmitTaskResultInstructionDataDecoder,
  getAcceptTaskResultInstructionDataDecoder,
  getRejectTaskResultInstructionDataDecoder,
  getAutoAcceptTaskResultInstructionDataDecoder,
  getValidateTaskResultInstructionDataDecoder,
  getRequestChangesInstructionDataDecoder,
  getRejectAndFreezeInstructionDataDecoder,
  getCompleteTaskInstructionDataDecoder,
  getCancelTaskInstructionDataDecoder,
  getCloseTaskInstructionDataDecoder,
  getReclaimOrphanTaskChildInstructionDataDecoder,
  getExpireClaimInstructionDataDecoder,
  getConfigureTaskValidationInstructionDataDecoder,
  getDistributeGhostShareInstructionDataDecoder,
  getReclaimTerminalClaimInstructionDataDecoder,
  getSetTaskJobSpecInstructionDataDecoder,
  findTaskPda,
  findHireRecordPda,
  findProtocolConfigPda,
  findBidBookPda,
  findWorkerCompletionBondPda,
} from "../src/index.js";
import {
  createTask,
  createTaskHumanless,
  createDependentTask,
  claimTaskWithJobSpec,
  submitTaskResult,
  acceptTaskResult,
  rejectTaskResult,
  autoAcceptTaskResult,
  validateTaskResult,
  requestChanges,
  rejectAndFreeze,
  completeTask,
  cancelTask,
  closeTask,
  reclaimOrphanTaskChild,
  expireClaim,
  configureTaskValidation,
  setTaskJobSpec,
  createContestTask,
  distributeGhostShare,
  reclaimTerminalClaim,
  CONTEST_ENTRY_DEPOSIT_LAMPORTS,
  CONTEST_SELECTION_WINDOW_SECS,
} from "../src/facade/tasks.js";

// Structural tests (the same pattern as agents.test.ts): build each lifecycle
// instruction through the facade and assert the program address, the account
// order, and that the encoded data round-trips through the matching generated
// decoder. The Async builders auto-derive PDAs, so we only supply the accounts a
// caller must provide; we assert those land in the right positions. No VM.

// Reusable valid base58 placeholders.
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const A = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const B = address("So11111111111111111111111111111111111111112");
const C = address("4xTpJ4p76bAeggXoYywpCCNKfJspbuRzZ79R7zG6BfQB");
const D = address("9Y8Nt5Z3sYTLNm6n5jKj7c5y8C2y2H8gPq4y6t9q1aA");
const signerA = createNoopSigner(
  address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
);
const signerB = createNoopSigner(
  address("Stake11111111111111111111111111111111111111"),
);

const ID32 = new Uint8Array(32).fill(7);
const DESC64 = new Uint8Array(64).fill(3);
const HASH32 = new Uint8Array(32).fill(9);

describe("createTask facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await createTask({
      creatorAgent: A,
      authority: signerA,
      creator: signerA,
      taskId: ID32,
      requiredCapabilities: 5n,
      description: DESC64,
      rewardAmount: 1000n,
      maxWorkers: 2,
      deadline: 9999n,
      taskType: 1,
      constraintHash: null,
      minReputation: 0,
      rewardMintArg: null,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    // task, escrow, protocolConfig auto-derived (positions 0..2).
    expect(names[3]).toBe(A); // creatorAgent
    expect(names[5]).toBe(signerA.address); // authority
    expect(names[6]).toBe(signerA.address); // creator
    expect(names[7]).toBe(SYSTEM_PROGRAM);
    expect(names[11]).toBe(TOKEN_PROGRAM);
    expect(names[12]).toBe(ATA_PROGRAM);

    const decoded = getCreateTaskInstructionDataDecoder().decode(ix.data);
    expect(decoded.rewardAmount).toBe(1000n);
    expect(decoded.requiredCapabilities).toBe(5n);
    expect(decoded.maxWorkers).toBe(2);
    expect(decoded.taskType).toBe(1);
    expect(Array.from(decoded.taskId)).toEqual(Array.from(ID32));
  });
});

describe("createTaskHumanless facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await createTaskHumanless({
      creator: signerA,
      taskId: ID32,
      requiredCapabilities: 3n,
      description: DESC64,
      rewardAmount: 500n,
      deadline: 8888n,
      minReputation: 1,
      reviewWindowSecs: 3600n,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    // task, escrow, validationConfig, protocolConfig, rateLimit auto-derived.
    expect(names[5]).toBe(signerA.address); // creator
    expect(names[6]).toBe(SYSTEM_PROGRAM);
    expect(names).toHaveLength(7);

    const decoded =
      getCreateTaskHumanlessInstructionDataDecoder().decode(ix.data);
    expect(decoded.rewardAmount).toBe(500n);
    expect(decoded.reviewWindowSecs).toBe(3600n);
    expect(decoded.minReputation).toBe(1);
  });
});

describe("createDependentTask facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await createDependentTask({
      parentTask: B,
      creatorAgent: A,
      authority: signerA,
      creator: signerA,
      taskId: ID32,
      requiredCapabilities: 7n,
      description: DESC64,
      rewardAmount: 2000n,
      maxWorkers: 1,
      deadline: 7777n,
      taskType: 0,
      constraintHash: null,
      dependencyType: 2,
      minReputation: 0,
      rewardMintArg: null,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    // task, escrow auto-derived; parentTask at index 2.
    expect(names[2]).toBe(B); // parentTask
    expect(names[4]).toBe(A); // creatorAgent
    expect(names[6]).toBe(signerA.address); // authority
    expect(names[7]).toBe(signerA.address); // creator

    const decoded =
      getCreateDependentTaskInstructionDataDecoder().decode(ix.data);
    expect(decoded.rewardAmount).toBe(2000n);
    expect(decoded.dependencyType).toBe(2);
    expect(decoded.taskType).toBe(0);
  });
});

describe("claimTaskWithJobSpec facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const [moderationBlock] = await findModerationBlockPda({
      contentHash: HASH32,
    });
    const ix = await claimTaskWithJobSpec({
      task: A,
      worker: B,
      authority: signerA,
      moderationBlock,
      jobSpecHash: HASH32,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    const [hireRecord] = await findHireRecordPda({ task: A });
    expect(names[2]).toBe(hireRecord);
    expect(names[3]).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS); // no legacy listing
    expect(names[4]).toBe(moderationBlock);
    // claim + protocolConfig are auto-derived at 5..6.
    expect(names[7]).toBe(B); // worker
    expect(names[8]).toBe(signerA.address); // authority
    expect(names[9]).toBe(SYSTEM_PROGRAM);

    // Empty-args instruction: data is just the 8-byte discriminator.
    const decoded =
      getClaimTaskWithJobSpecInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator).toHaveLength(8);
  });

  it("appends the Proof parent as a read-only remaining account", async () => {
    const [moderationBlock] = await findModerationBlockPda({
      contentHash: HASH32,
    });
    const ix = await claimTaskWithJobSpec({
      task: A,
      worker: B,
      authority: signerA,
      moderationBlock,
      jobSpecHash: HASH32,
      parentTask: C,
    });

    expect(ix.accounts.at(-1)).toEqual({
      address: C,
      role: AccountRole.READONLY,
    });
    expect(ix.accounts).toHaveLength(11);
  });
});

describe("submitTaskResult facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await submitTaskResult({
      task: A,
      worker: B,
      authority: signerA,
      proofHash: HASH32,
      resultData: null,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    // claim, validationConfig, submission, protocolConfig auto-derived (1..4).
    expect(names[5]).toBe(B); // worker
    expect(names[6]).toBe(signerA.address); // authority
    expect(names[7]).toBe(SYSTEM_PROGRAM);

    const decoded = getSubmitTaskResultInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.proofHash)).toEqual(Array.from(HASH32));
  });
});

describe("acceptTaskResult facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await acceptTaskResult({
      task: A,
      worker: B,
      treasury: C,
      creator: signerA,
      workerAuthority: D,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    // claim, escrow, validationConfig, submission auto-derived (1..4).
    expect(names[5]).toBe(B); // worker
    // protocolConfig auto-derived (6).
    expect(names[7]).toBe(C); // treasury
    expect(names[8]).toBe(signerA.address); // creator
    expect(names[9]).toBe(D); // workerAuthority
    const [hireRecord] = await findHireRecordPda({ task: A });
    expect(names[10]).toBe(hireRecord);

    const decoded = getAcceptTaskResultInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator).toHaveLength(8);
  });

  it("appends dependency evidence before accepted-bid settlement state", async () => {
    const ix = await acceptTaskResult({
      task: A,
      worker: B,
      treasury: C,
      creator: signerA,
      workerAuthority: D,
      dependencyParent: B,
      bidSettlement: {
        acceptedBid: C,
        bidderMarketState: D,
      },
    });
    const [bidBook] = await findBidBookPda({ task: A });
    expect(ix.accounts.slice(-5).map((account) => account.address)).toEqual([
      B,
      bidBook,
      C,
      D,
      D,
    ]);
  });
});

describe("rejectTaskResult facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await rejectTaskResult({
      task: A,
      claim: C,
      worker: B,
      creator: signerA,
      workerAuthority: D,
      rejectionHash: HASH32,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    expect(names[1]).toBe(C); // claim
    // validationConfig, submission auto-derived (2..3).
    expect(names[4]).toBe(B); // worker
    // protocolConfig auto-derived (5).
    expect(names[6]).toBe(signerA.address); // creator
    expect(names[7]).toBe(D); // workerAuthority
    const [workerBond] = await findWorkerCompletionBondPda({
      task: A,
      workerAuthority: D,
    });
    expect(names.at(-1)).toBe(workerBond);
    expect(ix.accounts.at(-1)?.role).toBe(AccountRole.WRITABLE);

    const decoded = getRejectTaskResultInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.rejectionHash)).toEqual(Array.from(HASH32));
  });
});

describe("autoAcceptTaskResult facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    // Audit F-10: hire_record is now required + seeds-pinned (was an optional
    // account that default-null exploited to skip operator/referrer legs).
    const [hireRecord] = await findHireRecordPda({ task: A });
    const ix = await autoAcceptTaskResult({
      task: A,
      worker: B,
      treasury: C,
      creator: D,
      workerAuthority: A,
      authority: signerA,
      hireRecord,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    // claim, escrow, validationConfig, submission auto-derived (1..4).
    expect(names[5]).toBe(B); // worker
    // protocolConfig auto-derived (6).
    expect(names[7]).toBe(C); // treasury
    expect(names[8]).toBe(D); // creator
    expect(names[9]).toBe(A); // workerAuthority
    expect(names[10]).toBe(hireRecord); // hireRecord (required, audit F-10)
    // operator(11), referrer(12), creator/workerCompletionBond(13,14)
    expect(names[15]).toBe(signerA.address); // authority

    const decoded =
      getAutoAcceptTaskResultInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator).toHaveLength(8);
  });
});

describe("validateTaskResult facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await validateTaskResult({
      task: A,
      worker: B,
      treasury: C,
      creator: D,
      workerAuthority: A,
      reviewer: signerA,
      approved: true,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    expect(names[7]).toBe(B); // worker
    expect(names[10]).toBe(C); // treasury
    expect(names[11]).toBe(D); // creator
    expect(names[12]).toBe(A); // workerAuthority
    expect(names[13]).toBe(signerA.address); // reviewer

    const decoded =
      getValidateTaskResultInstructionDataDecoder().decode(ix.data);
    expect(decoded.approved).toBe(true);
  });
});

describe("requestChanges facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await requestChanges({
      task: A,
      claim: C,
      creator: signerA,
      changesHash: HASH32,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    expect(names[1]).toBe(C); // claim
    // validationConfig, submission, protocolConfig auto-derived (2..4).
    expect(names[5]).toBe(signerA.address); // creator

    const decoded = getRequestChangesInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.changesHash)).toEqual(Array.from(HASH32));
  });
});

describe("rejectAndFreeze facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await rejectAndFreeze({
      task: A,
      claim: C,
      creator: signerA,
      rejectionHash: HASH32,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    expect(names[1]).toBe(C); // claim
    // validationConfig, submission, protocolConfig auto-derived (2..4).
    expect(names[5]).toBe(signerA.address); // creator

    const decoded = getRejectAndFreezeInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.rejectionHash)).toEqual(Array.from(HASH32));
  });
});

describe("completeTask facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await completeTask({
      task: A,
      creator: C,
      worker: B,
      treasury: D,
      authority: signerA,
      hireRecord: A,
      proofHash: HASH32,
      resultData: null,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    // claim, escrow auto-derived (1..2).
    expect(names[3]).toBe(C); // creator
    expect(names[4]).toBe(B); // worker
    // protocolConfig auto-derived (5).
    expect(names[6]).toBe(D); // treasury
    expect(names[7]).toBe(signerA.address); // authority
    expect(names[8]).toBe(SYSTEM_PROGRAM);
    expect(names[14]).toBe(A); // hireRecord

    const decoded = getCompleteTaskInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.proofHash)).toEqual(Array.from(HASH32));
  });
});

describe("cancelTask facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    // Audit F5/F12: bond PDAs are required on the full surface; the facade derives
    // them from authority / workerBondAuthority.
    const ix = await cancelTask({
      task: A,
      authority: signerA,
      workerBondAuthority: signerB.address,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    // escrow auto-derived (1).
    expect(names[2]).toBe(signerA.address); // authority
    // protocolConfig auto-derived (3).
    expect(names[4]).toBe(SYSTEM_PROGRAM);

    const decoded = getCancelTaskInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator).toHaveLength(8);
  });

  it("appends the canonical BidExclusive open-book settlement account", async () => {
    const ix = await cancelTask({
      task: A,
      authority: signerA,
      workerBondAuthority: signerB.address,
      bidSettlement: { kind: "open" },
    });
    const [bidBook] = await findBidBookPda({ task: A });
    expect(ix.accounts.at(-1)?.address).toBe(bidBook);
    expect(ix.accounts.at(-1)?.role).toBe(AccountRole.WRITABLE);
  });

  it("appends worker triple before accepted-bid settlement accounts", async () => {
    const ix = await cancelTask({
      task: A,
      authority: signerA,
      workerBondAuthority: signerB.address,
      workerAccounts: [
        { claim: B, workerAgent: C, workerAuthority: signerB.address },
      ],
      dependencyParent: A,
      bidSettlement: {
        kind: "accepted",
        acceptedBid: C,
        bidderMarketState: D,
      },
    });
    const [bidBook] = await findBidBookPda({ task: A });
    expect(ix.accounts.slice(-7).map((account) => account.address)).toEqual([
      A,
      B,
      C,
      signerB.address,
      bidBook,
      C,
      D,
    ]);
    expect(ix.accounts.slice(-6).every((account) => account.role === AccountRole.WRITABLE)).toBe(true);
  });

  it("rejects accepted-bid settlement without exactly one worker triple", async () => {
    await expect(
      cancelTask({
        task: A,
        authority: signerA,
        workerBondAuthority: signerB.address,
        bidSettlement: {
          kind: "accepted",
          acceptedBid: C,
          bidderMarketState: D,
        },
      }),
    ).rejects.toThrow(/exactly one worker/);
  });
});

describe("closeTask facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await closeTask({
      task: A,
      hireRecord: B,
      listing: C,
      // creatorCompletionBond is now REQUIRED (audit F12): close_task refuses to close
      // while a live completion bond exists, so the Task PDA reclaim path is preserved.
      creatorCompletionBond: D,
      authority: signerA,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    // taskJobSpec derives by default, but normal terminal close omits the
    // already-closed escrow slot unless a still-live drained escrow is passed.
    expect(names[2]).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts[2]?.role).toBe(AccountRole.READONLY);
    expect(names).toContain(B); // hireRecord
    expect(names).toContain(C); // listing
    expect(names).toContain(D); // creatorCompletionBond
    expect(names).toContain(signerA.address); // authority

    const decoded = getCloseTaskInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator).toHaveLength(8);
  });

  it("puts the BidExclusive book before structured child-sweep accounts", async () => {
    const ix = await closeTask({
      task: A,
      hireRecord: B,
      creatorCompletionBond: D,
      authority: signerA,
      bidExclusive: true,
      children: [
        { kind: "creatorFunded", account: B },
        { kind: "namedRecipient", account: A, recipient: C },
        {
          kind: "workerSubmission",
          submission: C,
          workerAgent: D,
          rentRecipient: signerB.address,
        },
      ],
    });
    const [bidBook] = await findBidBookPda({ task: A });
    expect(ix.accounts.slice(-7).map((account) => account.address)).toEqual([
      bidBook,
      B,
      A,
      C,
      C,
      D,
      signerB.address,
    ]);
    expect(ix.accounts.at(-2)?.role).toBe(AccountRole.READONLY);
    expect(ix.accounts.at(-1)?.role).toBe(AccountRole.WRITABLE);
  });

});

describe("reclaimOrphanTaskChild facade instruction", () => {
  it("uses the frozen five-meta wire for a directly authenticated recipient", async () => {
    const ix = await reclaimOrphanTaskChild({
      child: A,
      parentTask: B,
      workerAgent: C,
      rentRecipient: D,
      authority: signerA,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((account) => account.address)).toEqual([
      A,
      B,
      C,
      D,
      signerA.address,
    ]);
    expect(ix.accounts.map((account) => account.role)).toEqual([
      AccountRole.WRITABLE,
      AccountRole.READONLY,
      AccountRole.READONLY,
      AccountRole.WRITABLE,
      AccountRole.READONLY_SIGNER,
    ]);
    expect(
      getReclaimOrphanTaskChildInstructionDataDecoder().decode(ix.data)
        .discriminator,
    ).toHaveLength(8);
  });

  it("aliases the fixed recipient to treasury and appends the exact recovery suffix", async () => {
    const ix = await reclaimOrphanTaskChild({
      child: A,
      parentTask: B,
      workerAgent: C,
      authority: signerA,
      recovery: { treasury: D },
    });
    const [protocolConfig] = await findProtocolConfigPda();

    expect(ix.accounts.map((account) => account.address)).toEqual([
      A,
      B,
      C,
      D,
      signerA.address,
      protocolConfig,
      D,
    ]);
    expect(ix.accounts.map((account) => account.role)).toEqual([
      AccountRole.WRITABLE,
      AccountRole.READONLY,
      AccountRole.READONLY,
      AccountRole.WRITABLE,
      AccountRole.READONLY_SIGNER,
      AccountRole.READONLY,
      AccountRole.WRITABLE,
    ]);
  });
});

describe("expireClaim facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await expireClaim({
      authority: signerA,
      task: A,
      worker: B,
      rentRecipient: C,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(signerA.address); // authority
    expect(names[1]).toBe(A); // task
    // escrow, claim auto-derived (2..3).
    expect(names[4]).toBe(B); // worker
    // protocolConfig, validationConfig, submission auto-derived (5..7).
    expect(names[8]).toBe(C); // rentRecipient

    const decoded = getExpireClaimInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator).toHaveLength(8);
  });

  it("orders a dependency parent before the four-account BidExclusive suffix", async () => {
    const ix = await expireClaim({
      authority: signerA,
      task: A,
      worker: B,
      rentRecipient: C,
      dependencyParent: D,
      bidSettlement: {
        acceptedBid: C,
        bidderMarketState: B,
        creator: signerA.address,
      },
    });
    const [bidBook] = await findBidBookPda({ task: A });
    expect(ix.accounts.slice(-5).map((account) => account.address)).toEqual([
      D,
      bidBook,
      C,
      B,
      signerA.address,
    ]);
  });
});

describe("configureTaskValidation facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await configureTaskValidation({
      task: A,
      creator: signerA,
      mode: 1,
      reviewWindowSecs: 3600n,
      validatorQuorum: 2,
      attestor: B,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    // taskValidationConfig, taskAttestorConfig, protocolConfig, hireRecord auto-derived (1..4).
    expect(names[5]).toBe(signerA.address); // creator
    expect(names[6]).toBe(SYSTEM_PROGRAM);

    const decoded =
      getConfigureTaskValidationInstructionDataDecoder().decode(ix.data);
    expect(decoded.mode).toBe(1);
    expect(decoded.reviewWindowSecs).toBe(3600n);
    expect(decoded.validatorQuorum).toBe(2);
  });
});

describe("setTaskJobSpec facade instruction", () => {
  it("targets the program, orders accounts (P1.2: 9 with the BLOCK floor), and round-trips data", async () => {
    const ix = await setTaskJobSpec({
      task: A,
      creator: signerA,
      jobSpecHash: HASH32,
      jobSpecUri: "ipfs://job-spec",
      moderator: D, // P1.2: the caller names the moderator whose record it consumes
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // P1.2 pins the gate at 9 accounts: WP-A1's 8 + the REQUIRED moderationBlock (5).
    expect(ix.accounts.length).toBe(9);
    const names = ix.accounts.map((a) => a.address);
    // protocolConfig auto-derived (0).
    expect(names[1]).toBe(A); // task
    // moderationConfig auto-derived (2); taskModeration (3) is the facade-derived v2
    // moderator-keyed record PDA ["task_moderation_v2", task, hash, moderator].
    const [expectedModeration] = await findTaskModerationPda({
      task: A,
      jobSpecHash: HASH32,
      moderator: D,
    });
    expect(names[3]).toBe(expectedModeration);
    // moderationAttestor (4): global-authority path -> program-id placeholder (None).
    expect(names[4]).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // moderationBlock (5): REQUIRED BLOCK-floor PDA ["moderation_block", jobSpecHash].
    const [expectedBlock] = await findModerationBlockPda({ contentHash: HASH32 });
    expect(names[5]).toBe(expectedBlock);
    expect(names[7]).toBe(signerA.address); // creator
    expect(names[8]).toBe(SYSTEM_PROGRAM);

    const decoded = getSetTaskJobSpecInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.jobSpecHash)).toEqual(Array.from(HASH32));
    expect(decoded.jobSpecUri).toBe("ipfs://job-spec");
    expect(decoded.moderator).toBe(D); // P1.2: new 3rd arg
  });

  it("derives the roster-entry PDA when moderatorIsAttestor is set (P1.2 roster path)", async () => {
    const ix = await setTaskJobSpec({
      task: A,
      creator: signerA,
      jobSpecHash: HASH32,
      jobSpecUri: "ipfs://job-spec",
      moderator: D,
      moderatorIsAttestor: true,
    });
    const [expectedAttestor] = await findModerationAttestorPda({ attestor: D });
    expect(ix.accounts[4].address).toBe(expectedAttestor);
  });
});

describe("contest constants (Batch 3 WS-CONTEST)", () => {
  it("mirror the on-chain values", () => {
    // programs/agenc-coordination/src/instructions/constants.rs
    expect(CONTEST_ENTRY_DEPOSIT_LAMPORTS).toBe(10_000_000n);
    expect(CONTEST_SELECTION_WINDOW_SECS).toBe(172_800n);
  });
});

describe("createContestTask facade bundle", () => {
  const base = {
    creatorAgent: A,
    authority: signerA,
    creator: signerA,
    taskId: ID32,
    requiredCapabilities: 5n,
    description: DESC64,
    rewardAmount: 1000n,
    maxWorkers: 3,
    deadline: 9999n,
    constraintHash: null,
    minReputation: 0,
    reviewWindowSecs: 3600n,
  };

  it("returns the derived task plus create+configure instructions", async () => {
    const { task, instructions } = await createContestTask(base);

    const [expectedTask] = await findTaskPda({
      creator: signerA.address,
      taskId: ID32,
    });
    expect(task).toBe(expectedTask);
    expect(instructions).toHaveLength(2);

    // Ix 0: create_task pinned to the contest rails — Competitive + SOL-only.
    const [createIx, configureIx] = instructions;
    expect(createIx.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const created = getCreateTaskInstructionDataDecoder().decode(createIx.data);
    expect(created.taskType).toBe(2); // TaskType::Competitive
    expect(created.rewardMint).toEqual({ __option: "None" }); // SOL-only
    expect(created.deadline).toBe(9999n);
    // Referrer defaults to the no-leg skip path.
    expect(created.referrer).toEqual({ __option: "None" });
    expect(created.referrerFeeBps).toBe(0);

    // Ix 1: configure_task_validation — CreatorReview on the derived task.
    expect(configureIx.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(configureIx.accounts[0].address).toBe(expectedTask);
    const configured = getConfigureTaskValidationInstructionDataDecoder().decode(
      configureIx.data,
    );
    expect(configured.mode).toBe(1); // ValidationMode::CreatorReview
    expect(configured.reviewWindowSecs).toBe(3600n);
    expect(configured.validatorQuorum).toBe(0);
    expect(configured.attestor).toEqual({ __option: "None" });
  });

  it("passes an explicit referral leg through to create_task", async () => {
    const { instructions } = await createContestTask({
      ...base,
      referrer: D,
      referrerFeeBps: 50,
    });
    const created = getCreateTaskInstructionDataDecoder().decode(
      instructions[0].data,
    );
    expect(created.referrer).toEqual({ __option: "Some", value: D });
    expect(created.referrerFeeBps).toBe(50);
  });

  it("fails fast on a non-positive deadline (contests are deadline-bearing)", async () => {
    await expect(
      createContestTask({ ...base, deadline: 0n }),
    ).rejects.toThrow(/deadline > 0/);
  });
});

describe("distributeGhostShare facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await distributeGhostShare({
      task: A,
      worker: B,
      treasury: C,
      creator: D,
      workerAuthority: signerB.address,
      cranker: signerA,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    // claim, escrow, validation config, submission auto-derived (1..4).
    expect(names[5]).toBe(B); // worker
    // protocolConfig auto-derived (6).
    expect(names[7]).toBe(C); // treasury
    expect(names[8]).toBe(D); // creator
    expect(names[9]).toBe(signerB.address); // workerAuthority
    // operator (10) / referrer (11) omitted -> program-id placeholders (None).
    expect(names[12]).toBe(signerA.address); // cranker (permissionless signer)
    expect(names[13]).toBe(SYSTEM_PROGRAM);

    const decoded = getDistributeGhostShareInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.discriminator).toHaveLength(8);
  });
});

describe("reclaimTerminalClaim facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await reclaimTerminalClaim({
      authority: signerA,
      task: A,
      worker: B,
      treasury: C,
      rentRecipient: D,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(signerA.address); // authority (permissionless signer)
    expect(names[1]).toBe(A); // task
    // claim, submission, optional validation config auto-derived (2..4).
    expect(names[5]).toBe(B); // worker
    // protocolConfig auto-derived (6).
    expect(names[7]).toBe(C); // treasury (forfeited deposit surplus, never creator)
    expect(names[8]).toBe(D); // rentRecipient

    const decoded = getReclaimTerminalClaimInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.discriminator).toHaveLength(8);
  });
});
