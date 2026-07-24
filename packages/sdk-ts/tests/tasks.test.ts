import { runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";
import {
  AccountRole,
  address,
  createNoopSigner,
  generateKeyPairSigner,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionSize,
  type Address,
  type Blockhash,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  SET_TASK_JOB_SPEC_DISCRIMINATOR,
  findTaskModerationPda,
  findModerationAttestorPda,
  findModerationBlockPda,
  findAcceptTaskResultClaimPda,
  getCreateTaskInstructionDataDecoder,
  getCreateDirectAssignmentTaskInstructionDataDecoder,
  getCreateTaskHumanlessInstructionDataDecoder,
  getCreateDependentTaskInstructionDataDecoder,
  getClaimTaskWithJobSpecInstructionDataDecoder,
  getAcceptDirectAssignmentWithJobSpecInstructionDataDecoder,
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
  DependencyType,
  createMarketplaceClient,
  type SignedTransaction,
  type Transport,
} from "../src/index.js";
import {
  createTask,
  createDirectAssignmentTask,
  createTaskHumanless,
  createDependentTask,
  claimTaskWithJobSpec,
  acceptDirectAssignmentWithJobSpec,
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

function taskAddressFromSeed(seed: number): Address {
  return getBase58Decoder().decode(new Uint8Array(32).fill(seed)) as Address;
}

function mutableTaskSigner(initialAddress: TransactionSigner["address"]): {
  signer: TransactionSigner;
  setAddress: (next: TransactionSigner["address"]) => void;
} {
  const base = createNoopSigner(initialAddress);
  let liveAddress = initialAddress;
  const signer = Object.create(base) as TransactionSigner;
  Object.defineProperty(signer, "address", {
    configurable: true,
    enumerable: true,
    get: () => liveAddress,
  });
  return {
    signer,
    setAddress(next) {
      liveAddress = next;
    },
  };
}

function invalidTaskFixedByteViews(): Uint8Array[] {
  const detached = new Uint8Array(32).fill(1);
  structuredClone(detached, { transfer: [detached.buffer] });
  return [
    new Proxy(new Uint8Array(32).fill(1), {}),
    detached,
    new Uint8Array(new SharedArrayBuffer(32)).fill(1),
  ];
}

describe("task facade async intent boundaries", () => {
  it("snapshots create bytes and collapses equal mutable signer roles synchronously", async () => {
    const original = signerA.address;
    const moved = signerB.address;
    const authority = mutableTaskSigner(original);
    const creator = mutableTaskSigner(original);
    const taskId = new Uint8Array(32).fill(0x21);
    const description = new Uint8Array(64).fill(0x22);
    const constraintBytes = new Uint8Array(32).fill(0x23);
    const constraintHash = {
      __option: "Some" as const,
      value: constraintBytes,
    };

    const pending = createTask({
      creatorAgent: A,
      authority: authority.signer,
      creator: creator.signer,
      taskId,
      requiredCapabilities: 1n,
      description,
      rewardAmount: 1n,
      maxWorkers: 1,
      deadline: 1n,
      taskType: 0,
      constraintHash,
      minReputation: 0,
      rewardMintArg: null,
    });
    taskId.fill(0x91);
    description.fill(0x92);
    constraintBytes.fill(0x93);
    constraintHash.value = new Uint8Array(32).fill(0x94);
    authority.setAddress(moved);
    creator.setAddress(moved);

    const instruction = await pending;
    const decoded = getCreateTaskInstructionDataDecoder().decode(
      instruction.data,
    );
    expect(decoded.taskId).toEqual(new Uint8Array(32).fill(0x21));
    expect(decoded.description).toEqual(new Uint8Array(64).fill(0x22));
    expect(decoded.constraintHash).toEqual({
      __option: "Some",
      value: new Uint8Array(32).fill(0x23),
    });
    expect(instruction.accounts[5].address).toBe(original);
    expect(instruction.accounts[6].address).toBe(original);
    expect(
      "signer" in instruction.accounts[5]
        ? instruction.accounts[5].signer
        : undefined,
    ).toBe(
      "signer" in instruction.accounts[6]
        ? instruction.accounts[6].signer
        : undefined,
    );
  });

  it("snapshots create-task referrer and reward-mint Option wrappers", async () => {
    const rewardMint: { __option: "Some"; value: Address } = {
      __option: "Some",
      value: A,
    };
    const referrer: { __option: "Some"; value: Address } = {
      __option: "Some",
      value: B,
    };
    const pending = createTask({
      creatorAgent: A,
      authority: signerA,
      creator: signerA,
      taskId: new Uint8Array(32).fill(0x24),
      requiredCapabilities: 1n,
      description: new Uint8Array(64).fill(0x25),
      rewardAmount: 1n,
      maxWorkers: 1,
      deadline: 1n,
      taskType: 0,
      constraintHash: null,
      minReputation: 0,
      rewardMintArg: rewardMint,
      referrer,
      referrerFeeBps: 25,
    });
    rewardMint.value = C;
    referrer.value = D;

    const decoded = getCreateTaskInstructionDataDecoder().decode(
      (await pending).data,
    );
    expect(decoded.rewardMint).toEqual({ __option: "Some", value: A });
    expect(decoded.referrer).toEqual({ __option: "Some", value: B });
  });

  it("snapshots humanless referrer and dependent reward-mint wrappers", async () => {
    const referrer: { __option: "Some"; value: Address } = {
      __option: "Some",
      value: B,
    };
    const humanlessPending = createTaskHumanless({
      creator: signerA,
      taskId: new Uint8Array(32).fill(0x26),
      requiredCapabilities: 1n,
      description: new Uint8Array(64).fill(0x27),
      rewardAmount: 1n,
      deadline: 1n,
      minReputation: 0,
      reviewWindowSecs: 60n,
      referrer,
      referrerFeeBps: 25,
    });
    referrer.value = C;

    const rewardMint: { __option: "Some"; value: Address } = {
      __option: "Some",
      value: A,
    };
    const dependentPending = createDependentTask({
      parentTask: B,
      creatorAgent: A,
      authority: signerA,
      creator: signerA,
      taskId: new Uint8Array(32).fill(0x28),
      requiredCapabilities: 1n,
      description: new Uint8Array(64).fill(0x29),
      rewardAmount: 1n,
      maxWorkers: 1,
      deadline: 1n,
      taskType: 0,
      constraintHash: null,
      dependencyType: DependencyType.Data,
      minReputation: 0,
      rewardMintArg: rewardMint,
    });
    rewardMint.value = D;

    const humanless = getCreateTaskHumanlessInstructionDataDecoder().decode(
      (await humanlessPending).data,
    );
    const dependent = getCreateDependentTaskInstructionDataDecoder().decode(
      (await dependentPending).data,
    );
    expect(humanless.referrer).toEqual({ __option: "Some", value: B });
    expect(dependent.rewardMint).toEqual({ __option: "Some", value: A });
  });

  it("snapshots nested completion settlement records for every facade", async () => {
    const cases = [
      {
        name: "acceptTaskResult",
        build: (bidSettlement: {
          bidBook: Address;
          acceptedBid: Address;
          bidderMarketState: Address;
          bidderAuthority: Address;
        }) =>
          acceptTaskResult({
            task: A,
            worker: B,
            treasury: C,
            creator: signerA,
            workerAuthority: D,
            hireRecord: A,
            bidSettlement,
          }),
      },
      {
        name: "autoAcceptTaskResult",
        build: (bidSettlement: {
          bidBook: Address;
          acceptedBid: Address;
          bidderMarketState: Address;
          bidderAuthority: Address;
        }) =>
          autoAcceptTaskResult({
            task: A,
            worker: B,
            treasury: C,
            creator: D,
            workerAuthority: A,
            authority: signerA,
            hireRecord: A,
            bidSettlement,
          }),
      },
      {
        name: "validateTaskResult",
        build: (bidSettlement: {
          bidBook: Address;
          acceptedBid: Address;
          bidderMarketState: Address;
          bidderAuthority: Address;
        }) =>
          validateTaskResult({
            task: A,
            worker: B,
            treasury: C,
            creator: D,
            workerAuthority: A,
            reviewer: signerA,
            approved: true,
            bidSettlement,
          }),
      },
      {
        name: "completeTask",
        build: (bidSettlement: {
          bidBook: Address;
          acceptedBid: Address;
          bidderMarketState: Address;
          bidderAuthority: Address;
        }) =>
          completeTask({
            task: A,
            creator: C,
            worker: B,
            treasury: D,
            authority: signerA,
            hireRecord: A,
            proofHash: HASH32,
            resultData: null,
            bidSettlement,
          }),
      },
    ] as const;

    for (const testCase of cases) {
      const bidSettlement = {
        bidBook: A as Address,
        acceptedBid: B as Address,
        bidderMarketState: C as Address,
        bidderAuthority: D as Address,
      };
      const pending = testCase.build(bidSettlement);
      bidSettlement.bidBook = SYSTEM_PROGRAM;
      bidSettlement.acceptedBid = SYSTEM_PROGRAM;
      bidSettlement.bidderMarketState = SYSTEM_PROGRAM;
      bidSettlement.bidderAuthority = SYSTEM_PROGRAM;

      expect(
        (await pending).accounts.slice(-4).map((account) => account.address),
        testCase.name,
      ).toEqual([A, B, C, D]);
    }
  });

  it("locks the preferred signer before a facade-input Proxy can reflect", async () => {
    const selected = mutableTaskSigner(signerA.address);
    const plainInput = {
      creatorAgent: A,
      authority: selected.signer,
      creator: selected.signer,
      taskId: new Uint8Array(32).fill(0x2a),
      requiredCapabilities: 1n,
      description: new Uint8Array(64).fill(0x2b),
      rewardAmount: 1n,
      maxWorkers: 1,
      deadline: 1n,
      taskType: 0,
      constraintHash: null,
      minReputation: 0,
      rewardMintArg: null,
    };
    const input = new Proxy(plainInput, {
      ownKeys(target) {
        selected.setAddress(signerB.address);
        return Reflect.ownKeys(target);
      },
    });

    const instruction = await createTask(input);
    expect(instruction.accounts[5].address).toBe(signerA.address);
    expect(instruction.accounts[6].address).toBe(signerA.address);
    expect(selected.signer.address).toBe(signerA.address);
  });

  it("explicitly locks a secondary signer even if Proxy classification is stateful", async () => {
    const selected = mutableTaskSigner(signerB.address);
    let hidSigningMethod = false;
    const creator = new Proxy(selected.signer, {
      get(target, key, receiver) {
        if (
          !hidSigningMethod &&
          (key === "signTransactions" ||
            key === "modifyAndSignTransactions" ||
            key === "signAndSendTransactions")
        ) {
          hidSigningMethod = true;
          selected.setAddress(D);
          return undefined;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const pending = createTask({
      creatorAgent: A,
      authority: signerA,
      creator,
      taskId: new Uint8Array(32).fill(0x2c),
      requiredCapabilities: 1n,
      description: new Uint8Array(64).fill(0x2d),
      rewardAmount: 1n,
      maxWorkers: 1,
      deadline: 1n,
      taskType: 0,
      constraintHash: null,
      minReputation: 0,
      rewardMintArg: null,
    });
    selected.setAddress(D);

    const instruction = await pending;
    expect(hidSigningMethod).toBe(true);
    expect(instruction.accounts[6].address).toBe(signerB.address);
    expect(creator.address).toBe(signerB.address);
  });

  it("snapshots every single-hash review facade before its PDA await", async () => {
    const cases = [
      {
        name: "rejectTaskResult",
        build: (bytes: Uint8Array) =>
          rejectTaskResult({
            task: A,
            claim: C,
            worker: B,
            creator: createNoopSigner(signerA.address),
            workerAuthority: D,
            rejectionHash: bytes,
          }),
        decode: (data: ReadonlyUint8Array) =>
          getRejectTaskResultInstructionDataDecoder().decode(data)
            .rejectionHash,
      },
      {
        name: "requestChanges",
        build: (bytes: Uint8Array) =>
          requestChanges({
            task: A,
            claim: C,
            creator: createNoopSigner(signerA.address),
            changesHash: bytes,
          }),
        decode: (data: ReadonlyUint8Array) =>
          getRequestChangesInstructionDataDecoder().decode(data).changesHash,
      },
      {
        name: "rejectAndFreeze",
        build: (bytes: Uint8Array) =>
          rejectAndFreeze({
            task: A,
            claim: C,
            creator: createNoopSigner(signerA.address),
            rejectionHash: bytes,
          }),
        decode: (data: ReadonlyUint8Array) =>
          getRejectAndFreezeInstructionDataDecoder().decode(data).rejectionHash,
      },
    ] as const;

    for (const testCase of cases) {
      const bytes = new Uint8Array(32).fill(0x31);
      const pending = testCase.build(bytes);
      bytes.fill(0x99);
      expect(testCase.decode((await pending).data), testCase.name).toEqual(
        new Uint8Array(32).fill(0x31),
      );
    }
  });

  it("snapshots required and optional result bytes for submit and complete", async () => {
    const submitProof = new Uint8Array(32).fill(0x41);
    const submitResult = new Uint8Array(64).fill(0x42);
    const submitPending = submitTaskResult({
      task: A,
      worker: B,
      authority: createNoopSigner(signerA.address),
      proofHash: submitProof,
      resultData: { __option: "Some", value: submitResult },
    });
    submitProof.fill(0x91);
    submitResult.fill(0x92);
    const submitted = getSubmitTaskResultInstructionDataDecoder().decode(
      (await submitPending).data,
    );
    expect(submitted.proofHash).toEqual(new Uint8Array(32).fill(0x41));
    expect(submitted.resultData).toEqual({
      __option: "Some",
      value: new Uint8Array(64).fill(0x42),
    });

    const completeProof = new Uint8Array(32).fill(0x51);
    const completeResult = new Uint8Array(64).fill(0x52);
    const completePending = completeTask({
      task: A,
      creator: C,
      worker: B,
      treasury: D,
      authority: createNoopSigner(signerA.address),
      hireRecord: A,
      proofHash: completeProof,
      resultData: completeResult,
    });
    completeProof.fill(0xa1);
    completeResult.fill(0xa2);
    const completed = getCompleteTaskInstructionDataDecoder().decode(
      (await completePending).data,
    );
    expect(completed.proofHash).toEqual(new Uint8Array(32).fill(0x51));
    expect(completed.resultData).toEqual({
      __option: "Some",
      value: new Uint8Array(64).fill(0x52),
    });
  });

  it("rejects unsafe fixed-byte views at direct facade boundaries", async () => {
    for (const bad of invalidTaskFixedByteViews()) {
      await expect(
        rejectTaskResult({
          task: A,
          claim: C,
          worker: B,
          creator: createNoopSigner(signerA.address),
          workerAuthority: D,
          rejectionHash: bad,
        }),
      ).rejects.toThrow(/exactly 32 bytes/);
    }
  });
});

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

  it("rejects worker counts outside the revision-5 dispute-safe range", async () => {
    const input = {
      creatorAgent: A,
      authority: signerA,
      creator: signerA,
      taskId: ID32,
      requiredCapabilities: 5n,
      description: DESC64,
      rewardAmount: 1000n,
      deadline: 9999n,
      taskType: 1,
      constraintHash: null,
      minReputation: 0,
      rewardMintArg: null,
    } as const;
    await expect(createTask({ ...input, maxWorkers: 0 })).rejects.toThrow(
      /between 1 and 4/,
    );
    await expect(createTask({ ...input, maxWorkers: 5 })).rejects.toThrow(
      /between 1 and 4/,
    );
    await expect(createTask({ ...input, maxWorkers: 1.5 })).rejects.toThrow(
      /between 1 and 4/,
    );
  });
});

describe("direct-assignment task facade instructions", () => {
  it("creates only the private Exclusive single-worker shape", async () => {
    const ix = await createDirectAssignmentTask({
      creatorAgent: A,
      authority: signerA,
      creator: signerA,
      taskId: ID32,
      requiredCapabilities: 5n,
      description: DESC64,
      rewardAmount: 1000n,
      deadline: 9999n,
      constraintHash: null,
      minReputation: 0,
      rewardMintArg: null,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((account) => account.address);
    expect(names[3]).toBe(A); // creator agent
    expect(names[5]).toBe(signerA.address); // authority
    expect(names[6]).toBe(signerA.address); // creator / funder
    expect(names[7]).toBe(SYSTEM_PROGRAM);

    const decoded = getCreateDirectAssignmentTaskInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.taskType).toBe(0); // Exclusive
    expect(decoded.maxWorkers).toBe(1);
    expect(decoded.referrer).toEqual({ __option: "None" });
    expect(decoded.referrerFeeBps).toBe(0);
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

    const decoded = getCreateTaskHumanlessInstructionDataDecoder().decode(
      ix.data,
    );
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

    const decoded = getCreateDependentTaskInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.rewardAmount).toBe(2000n);
    expect(decoded.dependencyType).toBe(2);
    expect(decoded.taskType).toBe(0);
  });

  it("rejects dependency tasks above the dispute-safe worker cap", async () => {
    await expect(
      createDependentTask({
        parentTask: B,
        creatorAgent: A,
        authority: signerA,
        creator: signerA,
        taskId: ID32,
        requiredCapabilities: 7n,
        description: DESC64,
        rewardAmount: 2000n,
        maxWorkers: 5,
        deadline: 7777n,
        taskType: 1,
        constraintHash: null,
        dependencyType: 2,
        minReputation: 0,
        rewardMintArg: null,
      }),
    ).rejects.toThrow(/between 1 and 4/);
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
    const decoded = getClaimTaskWithJobSpecInstructionDataDecoder().decode(
      ix.data,
    );
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

describe("acceptDirectAssignmentWithJobSpec facade instruction", () => {
  it("pins the moderated spec, attestor, and both consent signatures", async () => {
    const expectedJobSpecHash = new Uint8Array(32).fill(0x44);
    const [moderationBlock] = await findModerationBlockPda({
      contentHash: expectedJobSpecHash,
    });
    const ix = await acceptDirectAssignmentWithJobSpec({
      task: A,
      worker: B,
      creator: signerA,
      workerAuthority: signerB,
      expectedJobSpecHash,
      expectedJobSpecUpdatedAt: 42n,
      expectedAttestor: D,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const names = ix.accounts.map((account) => account.address);
    const [claim] = await findAcceptTaskResultClaimPda({ task: A, worker: B });
    expect(names[0]).toBe(A); // task
    expect(names[5]).toBe(moderationBlock); // job-spec hash BLOCK floor
    expect(names[6]).toBe(claim); // canonical ["claim", task, worker] PDA
    expect(names[8]).toBe(B); // worker agent
    expect(names[9]).toBe(signerA.address); // task funder consent
    expect(names[10]).toBe(signerB.address); // intended worker consent
    expect(names[11]).toBe(SYSTEM_PROGRAM);

    const decoded =
      getAcceptDirectAssignmentWithJobSpecInstructionDataDecoder().decode(
        ix.data,
      );
    expect(decoded.expectedJobSpecHash).toEqual(expectedJobSpecHash);
    expect(decoded.expectedJobSpecUpdatedAt).toBe(42n);
    expect(decoded.expectedAttestor).toBe(D);
  });

  it("copies the signed job-spec hash before deriving the moderation PDA", async () => {
    const expectedJobSpecHash = new Uint8Array(32).fill(0x51);
    const pending = acceptDirectAssignmentWithJobSpec({
      task: A,
      worker: B,
      creator: signerA,
      workerAuthority: signerB,
      expectedJobSpecHash,
      expectedJobSpecUpdatedAt: 42n,
      expectedAttestor: D,
    });
    expectedJobSpecHash.fill(0xa1);

    const decoded =
      getAcceptDirectAssignmentWithJobSpecInstructionDataDecoder().decode(
        (await pending).data,
      );
    expect(decoded.expectedJobSpecHash).toEqual(new Uint8Array(32).fill(0x51));
  });

  it("rejects an all-zero direct-assignment job-spec hash", async () => {
    await expect(
      acceptDirectAssignmentWithJobSpec({
        task: A,
        worker: B,
        creator: signerA,
        workerAuthority: signerB,
        expectedJobSpecHash: new Uint8Array(32),
        expectedJobSpecUpdatedAt: 42n,
        expectedAttestor: D,
      }),
    ).rejects.toThrow(/must not be all zeroes/);
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

  it.each([
    { dependencyType: DependencyType.None, includesParent: false },
    { dependencyType: DependencyType.Data, includesParent: false },
    { dependencyType: DependencyType.Ordering, includesParent: false },
    { dependencyType: DependencyType.Proof, includesParent: true },
  ])(
    "appends the exact three-account BidExclusive rejection suffix for dependency $dependencyType",
    async ({ dependencyType, includesParent }) => {
      const settlement = {
        bidBook: B as Address,
        acceptedBid: C as Address,
        bidderMarketState: D as Address,
      };
      const pending = rejectTaskResult({
        task: A,
        claim: C,
        worker: B,
        creator: signerA,
        workerAuthority: signerB.address,
        rejectionHash: HASH32,
        dependencyType,
        ...(includesParent ? { dependencyParent: A } : {}),
        bidSettlement: settlement,
      });
      settlement.bidBook = SYSTEM_PROGRAM;
      settlement.acceptedBid = SYSTEM_PROGRAM;
      settlement.bidderMarketState = SYSTEM_PROGRAM;

      // reject_task_result has 11 generated accounts. Rust consumes an
      // optional Proof parent followed by exactly three settlement accounts;
      // the named workerAuthority receives the refund and is not repeated.
      expect(
        (await pending).accounts.slice(11).map((meta) => meta.address),
      ).toEqual([...(includesParent ? [A] : []), B, C, D]);
    },
  );

  it("rejects ambiguous or caller-selected BidExclusive rejection recipients", async () => {
    const base = {
      task: A,
      claim: C,
      worker: B,
      creator: signerA,
      workerAuthority: D,
      rejectionHash: HASH32,
    } as const;
    await expect(
      rejectTaskResult({
        ...base,
        bidSettlement: { acceptedBid: B, bidderMarketState: C },
      }),
    ).rejects.toThrow(/dependencyType is required/);
    await expect(
      rejectTaskResult({
        ...base,
        dependencyType: DependencyType.Proof,
        bidSettlement: { acceptedBid: B, bidderMarketState: C },
      }),
    ).rejects.toThrow(/dependencyParent is required/);
    await expect(
      rejectTaskResult({
        ...base,
        dependencyType: DependencyType.Data,
        dependencyParent: D,
        bidSettlement: { acceptedBid: B, bidderMarketState: C },
      }),
    ).rejects.toThrow(/must be omitted unless.*Proof/);
    await expect(
      rejectTaskResult({
        ...base,
        dependencyType: DependencyType.None,
        bidSettlement: {
          acceptedBid: B,
          bidderMarketState: C,
          bidderAuthority: D,
        } as never,
      }),
    ).rejects.toThrow(/bidderAuthority must be omitted/);
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

    const decoded = getAutoAcceptTaskResultInstructionDataDecoder().decode(
      ix.data,
    );
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

    const decoded = getValidateTaskResultInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.approved).toBe(true);
  });

  it.each([
    {
      dependencyType: DependencyType.None,
      approved: true,
      includesParent: false,
    },
    {
      dependencyType: DependencyType.None,
      approved: false,
      includesParent: false,
    },
    {
      dependencyType: DependencyType.Data,
      approved: true,
      includesParent: true,
    },
    {
      dependencyType: DependencyType.Data,
      approved: false,
      includesParent: false,
    },
    {
      dependencyType: DependencyType.Ordering,
      approved: true,
      includesParent: true,
    },
    {
      dependencyType: DependencyType.Ordering,
      approved: false,
      includesParent: false,
    },
    {
      dependencyType: DependencyType.Proof,
      approved: true,
      includesParent: true,
    },
    {
      dependencyType: DependencyType.Proof,
      approved: false,
      includesParent: true,
    },
  ])(
    "lays out BidExclusive dependency $dependencyType with approved=$approved",
    async ({ dependencyType, approved, includesParent }) => {
      const [bidBook] = await findBidBookPda({ task: A });
      const acceptedBid = B;
      const bidderMarketState = C;
      const bidderAuthority = D;
      const dependent = dependencyType !== DependencyType.None;
      const suppliesParent = approved ? dependent : includesParent;
      const bidSettlement = approved
        ? {
            acceptedBid,
            bidderMarketState,
            bidderAuthority,
          }
        : { acceptedBid, bidderMarketState };
      const ix = await validateTaskResult({
        task: A,
        worker: B,
        treasury: C,
        creator: D,
        workerAuthority: A,
        reviewer: signerA,
        approved,
        dependencyType,
        ...(suppliesParent ? { dependencyParent: D } : {}),
        bidSettlement,
      });

      // validate_task_result has 22 generated accounts; everything after that
      // is the facade-owned remaining-account wire consumed by Rust.
      expect(ix.accounts.slice(22).map((meta) => meta.address)).toEqual([
        ...(includesParent ? [D] : []),
        bidBook,
        acceptedBid,
        bidderMarketState,
        ...(approved ? [bidderAuthority] : []),
      ]);
    },
  );

  it("rejects an ambiguous BidExclusive rejection dependency layout", async () => {
    await expect(
      validateTaskResult({
        task: A,
        worker: B,
        treasury: C,
        creator: D,
        workerAuthority: A,
        reviewer: signerA,
        approved: false,
        dependencyParent: D,
        bidSettlement: {
          acceptedBid: B,
          bidderMarketState: C,
        },
      }),
    ).rejects.toThrow(/dependencyType/);

    await expect(
      validateTaskResult({
        task: A,
        worker: B,
        treasury: C,
        creator: D,
        workerAuthority: A,
        reviewer: signerA,
        approved: false,
        dependencyType: DependencyType.None,
        dependencyParent: D,
        bidSettlement: {
          acceptedBid: B,
          bidderMarketState: C,
        },
      }),
    ).rejects.toThrow(/must be omitted unless.*Proof/);
  });

  it("requires a parent for declared dependent acceptance and Proof rejection", async () => {
    const base = {
      task: A,
      worker: B,
      treasury: C,
      creator: D,
      workerAuthority: A,
      reviewer: signerA,
      bidSettlement: {
        acceptedBid: B,
        bidderMarketState: C,
      },
    } as const;

    await expect(
      validateTaskResult({
        ...base,
        approved: true,
        dependencyType: DependencyType.Data,
      }),
    ).rejects.toThrow(/dependencyParent/);
    await expect(
      validateTaskResult({
        ...base,
        approved: false,
        dependencyType: DependencyType.Proof,
      }),
    ).rejects.toThrow(/dependencyParent/);
  });

  it("rejects a fourth caller-selected settlement recipient on validation rejection", async () => {
    await expect(
      validateTaskResult({
        task: A,
        worker: B,
        treasury: C,
        creator: D,
        workerAuthority: A,
        reviewer: signerA,
        approved: false,
        dependencyType: DependencyType.None,
        bidSettlement: {
          acceptedBid: B,
          bidderMarketState: C,
          bidderAuthority: D,
        },
      }),
    ).rejects.toThrow(/bidderAuthority must be omitted/);
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
    expect(
      ix.accounts
        .slice(-6)
        .every((account) => account.role === AccountRole.WRITABLE),
    ).toBe(true);
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

  it("rejects sparse worker arrays and ignores callback-poisoned methods", async () => {
    await expect(
      cancelTask({
        task: A,
        authority: signerA,
        workerBondAuthority: signerB.address,
        workerAccounts: new Array(1),
        bidSettlement: {
          kind: "accepted",
          acceptedBid: C,
          bidderMarketState: D,
        },
      }),
    ).rejects.toThrow(/dense/);

    let flatMapCalls = 0;
    const workers = [
      { claim: B, workerAgent: C, workerAuthority: signerB.address },
    ];
    Object.defineProperty(workers, "flatMap", {
      value() {
        flatMapCalls += 1;
        return [];
      },
    });
    const instruction = await cancelTask({
      task: A,
      authority: signerA,
      workerBondAuthority: signerB.address,
      workerAccounts: workers,
    });
    expect(flatMapCalls).toBe(0);
    expect(
      instruction.accounts.slice(-3).map((account) => account.address),
    ).toEqual([B, C, signerB.address]);
  });

  it("snapshots worker and accepted-bid account records before derivation", async () => {
    const worker = {
      claim: B as Address,
      workerAgent: C as Address,
      workerAuthority: signerB.address as Address,
    };
    const settlement = {
      kind: "accepted" as const,
      bidBook: A as Address,
      acceptedBid: C as Address,
      bidderMarketState: D as Address,
    };
    const pending = cancelTask({
      task: A,
      authority: signerA,
      workerBondAuthority: signerB.address,
      workerAccounts: [worker],
      bidSettlement: settlement,
    });
    worker.claim = SYSTEM_PROGRAM;
    worker.workerAgent = SYSTEM_PROGRAM;
    worker.workerAuthority = SYSTEM_PROGRAM;
    settlement.bidBook = SYSTEM_PROGRAM;
    settlement.acceptedBid = SYSTEM_PROGRAM;
    settlement.bidderMarketState = SYSTEM_PROGRAM;

    expect(
      (await pending).accounts.slice(-6).map((account) => account.address),
    ).toEqual([B, C, signerB.address, A, C, D]);
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

  it("snapshots child records and rejects malformed worker-recipient shapes", async () => {
    const child = {
      kind: "namedRecipient" as const,
      account: B as Address,
      recipient: C as Address,
    };
    const pending = closeTask({
      task: A,
      taskJobSpec: null,
      hireRecord: B,
      creatorCompletionBond: D,
      authority: signerA,
      children: [child],
    });
    child.account = SYSTEM_PROGRAM;
    child.recipient = SYSTEM_PROGRAM;
    expect(
      (await pending).accounts.slice(-2).map((account) => account.address),
    ).toEqual([B, C]);

    await expect(
      closeTask({
        task: A,
        taskJobSpec: null,
        hireRecord: B,
        creatorCompletionBond: D,
        authority: signerA,
        children: [
          {
            kind: "workerSubmission",
            submission: B,
            workerAgent: C,
          } as never,
        ],
      }),
    ).rejects.toThrow(/exactly one rent recipient/);
  });

  it("keeps expanded child sweeps within the standalone transaction wire budget", async () => {
    const atLimit = await closeTask({
      task: A,
      taskJobSpec: null,
      hireRecord: B,
      creatorCompletionBond: D,
      authority: signerA,
      bidExclusive: true,
      children: Array.from({ length: 18 }, () => ({
        kind: "creatorFunded" as const,
        account: B,
      })),
    });
    expect(atLimit.accounts).toHaveLength(28);

    await expect(
      closeTask({
        task: A,
        taskJobSpec: null,
        hireRecord: B,
        creatorCompletionBond: D,
        authority: signerA,
        children: [
          ...Array.from({ length: 6 }, () => ({
            kind: "workerSubmission" as const,
            submission: B,
            workerAgent: C,
            rentRecipient: D,
          })),
          { kind: "namedRecipient", account: B, recipient: C },
        ],
      }),
    ).rejects.toThrow(/20 remaining account metas.*at most 19.*28 total/);

    await expect(
      closeTask({
        task: A,
        taskJobSpec: null,
        hireRecord: B,
        creatorCompletionBond: D,
        authority: signerA,
        bidExclusive: true,
        children: Array.from({ length: 19 }, () => ({
          kind: "creatorFunded" as const,
          account: B,
        })),
      }),
    ).rejects.toThrow(/20 remaining account metas.*at most 19.*28 total/);
  });

  it("serializes the 28-meta distinct-key boundary to exactly 1,219 bytes", async () => {
    const authority = await generateKeyPairSigner();
    const feePayer = await generateKeyPairSigner();
    let captured: SignedTransaction | undefined;
    const transport: Transport = {
      async getLatestBlockhash() {
        return {
          blockhash: getBase58Decoder().decode(
            new Uint8Array(32).fill(0xa5),
          ) as Blockhash,
          lastValidBlockHeight: 100n,
        };
      },
      async sendAndConfirm(transaction) {
        captured = transaction;
        return {
          signature: getSignatureFromTransaction(transaction),
          logs: [],
        };
      },
    };
    const instruction = await closeTask({
      task: taskAddressFromSeed(0x10),
      taskJobSpec: taskAddressFromSeed(0x11),
      escrow: taskAddressFromSeed(0x12),
      hireRecord: taskAddressFromSeed(0x13),
      listing: taskAddressFromSeed(0x14),
      creatorCompletionBond: taskAddressFromSeed(0x15),
      workerCompletionBond: taskAddressFromSeed(0x16),
      authority,
      bidExclusive: taskAddressFromSeed(0x17),
      children: Array.from({ length: 18 }, (_, index) => ({
        kind: "creatorFunded" as const,
        account: taskAddressFromSeed(0x20 + index),
      })),
    });
    expect(instruction.accounts).toHaveLength(28);

    const client = createMarketplaceClient({
      transport,
      signer: feePayer,
      computeUnitPrice: 1n,
    });
    await client.send([instruction]);
    expect(captured).toBeDefined();
    expect(getTransactionSize(captured!)).toBe(1_219);
    expect(captured!.messageBytes).toHaveLength(1_090);

    const message = getCompiledTransactionMessageDecoder().decode(
      captured!.messageBytes,
    );
    if (!("instructions" in message) || !("staticAccounts" in message)) {
      throw new Error("expected a compiled v0 transaction message");
    }
    expect(message.staticAccounts).toHaveLength(31);
    expect(
      "addressTableLookups" in message ? message.addressTableLookups : [],
    ).toHaveLength(0);
    expect(
      message.instructions.map((item) => [
        item.accountIndices?.length ?? 0,
        item.data?.length ?? 0,
      ]),
    ).toEqual([
      [0, 5],
      [0, 9],
      [28, 8],
    ]);
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

  it("snapshots recovery treasury and protocol config before PDA derivation", async () => {
    const recovery = {
      protocolConfig: A as Address,
      treasury: D as Address,
    };
    const pending = reclaimOrphanTaskChild({
      child: A,
      parentTask: B,
      workerAgent: C,
      authority: signerA,
      recovery,
    });
    recovery.protocolConfig = SYSTEM_PROGRAM;
    recovery.treasury = SYSTEM_PROGRAM;
    const accounts = (await pending).accounts.map((account) => account.address);
    expect(accounts[3]).toBe(D);
    expect(accounts.slice(-2)).toEqual([A, D]);
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

  it("snapshots expiry settlement accounts before its generated builder awaits", async () => {
    const settlement = {
      bidBook: A as Address,
      acceptedBid: C as Address,
      bidderMarketState: B as Address,
      creator: D as Address,
    };
    const pending = expireClaim({
      authority: signerA,
      task: A,
      worker: B,
      rentRecipient: C,
      bidSettlement: settlement,
    });
    settlement.bidBook = SYSTEM_PROGRAM;
    settlement.acceptedBid = SYSTEM_PROGRAM;
    settlement.bidderMarketState = SYSTEM_PROGRAM;
    settlement.creator = SYSTEM_PROGRAM;
    expect(
      (await pending).accounts.slice(-4).map((account) => account.address),
    ).toEqual([A, C, B, D]);
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

    const decoded = getConfigureTaskValidationInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.mode).toBe(1);
    expect(decoded.reviewWindowSecs).toBe(3600n);
    expect(decoded.validatorQuorum).toBe(2);
  });

  it("snapshots an explicit attestor Option wrapper", async () => {
    const attestor: { __option: "Some"; value: Address } = {
      __option: "Some",
      value: B,
    };
    const pending = configureTaskValidation({
      task: A,
      creator: signerA,
      mode: 1,
      reviewWindowSecs: 3600n,
      validatorQuorum: 2,
      attestor,
    });
    attestor.value = D;
    const decoded = getConfigureTaskValidationInstructionDataDecoder().decode(
      (await pending).data,
    );
    expect(decoded.attestor).toEqual({ __option: "Some", value: B });
  });
});

describe("setTaskJobSpec facade instruction", () => {
  it("targets the program, orders accounts (revision 5: 10 with the hire commitment), and round-trips data", async () => {
    const ix = await setTaskJobSpec({
      task: A,
      creator: signerA,
      jobSpecHash: HASH32,
      jobSpecUri: "ipfs://job-spec",
      moderator: D, // P1.2: the caller names the moderator whose record it consumes
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // Revision 5 appends the canonical HireRecord proof to the 9-account P1.2 shape.
    expect(ix.accounts.length).toBe(10);
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
    const [expectedBlock] = await findModerationBlockPda({
      contentHash: HASH32,
    });
    expect(names[5]).toBe(expectedBlock);
    expect(names[7]).toBe(signerA.address); // creator
    expect(names[8]).toBe(SYSTEM_PROGRAM);
    const [expectedHireRecord] = await findHireRecordPda({ task: A });
    expect(names[9]).toBe(expectedHireRecord);

    const decoded = getSetTaskJobSpecInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.discriminator)).toEqual(
      Array.from(SET_TASK_JOB_SPEC_DISCRIMINATOR),
    );
    expect(Array.from(decoded.discriminator)).toEqual([
      118, 9, 99, 58, 215, 87, 58, 59,
    ]);
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

  it("rejects hashes the generated fixed encoder would pad, truncate, or zero", async () => {
    for (const bad of [
      new Uint8Array(31).fill(1),
      new Uint8Array(33).fill(1),
      new Uint8Array(32),
    ]) {
      await expect(
        setTaskJobSpec({
          task: A,
          creator: signerA,
          jobSpecHash: bad,
          jobSpecUri: "ipfs://job-spec",
          moderator: D,
        }),
      ).rejects.toThrow(/exactly 32 bytes|all zeroes/);
    }
  });

  it("snapshots the hash and signer address before its first PDA await", async () => {
    const originalAddress = address(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    const movedAddress = address("Stake11111111111111111111111111111111111111");
    const selected = mutableTaskSigner(originalAddress);
    const hash = new Uint8Array(32).fill(0x61);
    const expectedHash = hash.slice();

    const pending = setTaskJobSpec({
      task: A,
      creator: selected.signer,
      jobSpecHash: hash,
      jobSpecUri: "ipfs://snapshotted",
      moderator: D,
    });
    hash.fill(0x71);
    selected.setAddress(movedAddress);

    const ix = await pending;
    const decoded = getSetTaskJobSpecInstructionDataDecoder().decode(ix.data);
    const [expectedModeration] = await findTaskModerationPda({
      task: A,
      jobSpecHash: expectedHash,
      moderator: D,
    });
    expect(decoded.jobSpecHash).toEqual(expectedHash);
    expect(ix.accounts[3].address).toBe(expectedModeration);
    expect(ix.accounts[7].address).toBe(originalAddress);
    expect("signer" in ix.accounts[7] ? ix.accounts[7].signer : undefined).toBe(
      selected.signer,
    );
  });

  it("accepts cross-realm hashes by value and rejects proxy/shared/detached hashes", async () => {
    const ForeignUint8Array = runInNewContext(
      "Uint8Array",
    ) as Uint8ArrayConstructor;
    const foreign = new ForeignUint8Array(32).fill(0x44);
    const expected = new Uint8Array(foreign);
    const pending = setTaskJobSpec({
      task: A,
      creator: signerA,
      jobSpecHash: foreign,
      jobSpecUri: "ipfs://foreign",
      moderator: D,
    });
    foreign.fill(0x55);
    expect(
      getSetTaskJobSpecInstructionDataDecoder().decode((await pending).data)
        .jobSpecHash,
    ).toEqual(expected);

    for (const bad of invalidTaskFixedByteViews()) {
      await expect(
        setTaskJobSpec({
          task: A,
          creator: signerA,
          jobSpecHash: bad,
          jobSpecUri: "ipfs://invalid",
          moderator: D,
        }),
      ).rejects.toThrow(/exactly 32 bytes/);
    }
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
    const configured =
      getConfigureTaskValidationInstructionDataDecoder().decode(
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

  it("uses one synchronous task-id and signer snapshot for both bundled instructions", async () => {
    const authority = mutableTaskSigner(signerA.address);
    const creator = mutableTaskSigner(signerA.address);
    const taskId = new Uint8Array(32).fill(0x61);
    const expectedTaskId = new Uint8Array(taskId);
    const pending = createContestTask({
      ...base,
      authority: authority.signer,
      creator: creator.signer,
      taskId,
    });
    taskId.fill(0xe1);
    authority.setAddress(signerB.address);
    creator.setAddress(signerB.address);

    const { task, instructions } = await pending;
    const [expectedTask] = await findTaskPda({
      creator: signerA.address,
      taskId: expectedTaskId,
    });
    const created = getCreateTaskInstructionDataDecoder().decode(
      instructions[0].data,
    );
    expect(created.taskId).toEqual(expectedTaskId);
    expect(task).toBe(expectedTask);
    expect(instructions[1].accounts[0].address).toBe(expectedTask);
    expect(instructions[1].accounts[5].address).toBe(signerA.address);
  });

  it("fails fast on a non-positive deadline (contests are deadline-bearing)", async () => {
    await expect(createContestTask({ ...base, deadline: 0n })).rejects.toThrow(
      /deadline > 0/,
    );
  });

  it("fails fast above the dispute-safe contest worker cap", async () => {
    await expect(createContestTask({ ...base, maxWorkers: 5 })).rejects.toThrow(
      /between 1 and 4/,
    );
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
