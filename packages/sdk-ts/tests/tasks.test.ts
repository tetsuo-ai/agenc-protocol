import { describe, it, expect } from "vitest";
import { AccountRole, address, createNoopSigner } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
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
  getExpireClaimInstructionDataDecoder,
  getConfigureTaskValidationInstructionDataDecoder,
  getSetTaskJobSpecInstructionDataDecoder,
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
  expireClaim,
  configureTaskValidation,
  setTaskJobSpec,
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
    const ix = await claimTaskWithJobSpec({
      task: A,
      worker: B,
      authority: signerA,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    expect(names[0]).toBe(A); // task
    // taskJobSpec, claim, protocolConfig auto-derived (1..3).
    expect(names[4]).toBe(B); // worker
    expect(names[5]).toBe(signerA.address); // authority
    expect(names[6]).toBe(SYSTEM_PROGRAM);

    // Empty-args instruction: data is just the 8-byte discriminator.
    const decoded =
      getClaimTaskWithJobSpecInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator).toHaveLength(8);
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

    const decoded = getAcceptTaskResultInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator).toHaveLength(8);
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

    const decoded = getRejectTaskResultInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.rejectionHash)).toEqual(Array.from(HASH32));
  });
});

describe("autoAcceptTaskResult facade instruction", () => {
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await autoAcceptTaskResult({
      task: A,
      worker: B,
      treasury: C,
      creator: D,
      workerAuthority: A,
      authority: signerA,
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
    // hireRecord(10), operator(11), referrer(12), creator/workerCompletionBond(13,14)
    // auto-derived (P6.2 inserted the optional referrer leg between operator and bonds).
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
    const ix = await cancelTask({
      task: A,
      authority: signerA,
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
  it("targets the program, orders accounts, and round-trips data", async () => {
    const ix = await setTaskJobSpec({
      task: A,
      creator: signerA,
      jobSpecHash: HASH32,
      jobSpecUri: "ipfs://job-spec",
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((a) => a.address);
    // protocolConfig auto-derived (0).
    expect(names[1]).toBe(A); // task
    // moderationConfig, taskModeration, taskJobSpec auto-derived (2..4).
    expect(names[5]).toBe(signerA.address); // creator
    expect(names[6]).toBe(SYSTEM_PROGRAM);

    const decoded = getSetTaskJobSpecInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.jobSpecHash)).toEqual(Array.from(HASH32));
    expect(decoded.jobSpecUri).toBe("ipfs://job-spec");
  });
});
