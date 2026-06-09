import { describe, it, expect } from "vitest";
import { address, createNoopSigner } from "@solana/kit";
import {
  // generated sync builders (used as the structural ground truth for account order)
  getInitiateDisputeInstructionDataDecoder,
  getVoteDisputeInstructionDataDecoder,
  getResolveDisputeInstructionDataDecoder,
  getExpireDisputeInstructionDataDecoder,
  getCancelDisputeInstructionDataDecoder,
  getApplyDisputeSlashInstructionDataDecoder,
  getApplyInitiatorSlashInstructionDataDecoder,
  getResolveRejectFrozenInstructionDataDecoder,
  getExpireRejectFrozenInstructionDataDecoder,
  getAssignDisputeResolverInstructionDataDecoder,
  getRevokeDisputeResolverInstructionDataDecoder,
  // PDA helpers (to assert the facade really derived the bond accounts)
  findCreatorCompletionBondPda,
  findWorkerCompletionBondPda,
  findDisputeResolverPda,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";
// Import the facade module directly: the orchestrator wires re-exports into
// facade/index.ts separately, so this test must not depend on that wiring.
import * as facade from "../src/facade/disputes.js";

// Structural tests for the dispute facade: build each instruction through the facade
// and assert the program address, the account order, and that the encoded data
// round-trips through the matching generated decoder. Deterministic, no VM.
//
// Valid base58 placeholders; reused across cases for readability.
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const a = (s: string) => address(s);

// A handful of distinct valid addresses.
const TASK = a("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const AGENT = a("So11111111111111111111111111111111111111112");
const CREATOR = a("BPFLoaderUpgradeab1e11111111111111111111111");
const WORKER_AGENT = a("Stake11111111111111111111111111111111111111");
const WORKER_WALLET = a("Vote111111111111111111111111111111111111111");
const TREASURY = a("SysvarRent111111111111111111111111111111111");
const ARBITER = a("SysvarC1ock11111111111111111111111111111111");
const CLAIM = a("SysvarS1otHashes111111111111111111111111111");
const DISPUTE = a("SysvarStakeHistory1111111111111111111111111");
const AUTHORITY_ADDR = a("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const AUTHORITY = createNoopSigner(AUTHORITY_ADDR);

const programOf = (ix: { programAddress: string }) => ix.programAddress;
const order = (ix: { accounts: readonly { address: string }[] }) =>
  ix.accounts.map((acc) => acc.address);

describe("disputes facade (structural)", () => {
  it("initiateDispute: program, account order, data round-trip", async () => {
    const disputeId = new Uint8Array(32).fill(1);
    const taskId = new Uint8Array(32).fill(2);
    const evidenceHash = new Uint8Array(32).fill(3);
    const ix = await facade.initiateDispute({
      task: TASK,
      agent: AGENT,
      authority: AUTHORITY,
      disputeId,
      taskId,
      evidenceHash,
      resolutionType: 1,
      evidence: "ipfs://evidence",
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // Account order per the generated builder: dispute, task, agent, authorityRateLimit,
    // protocolConfig, initiatorClaim, workerAgent(optional), workerClaim(optional),
    // taskSubmission(optional), authority, systemProgram.
    const accs = order(ix);
    expect(accs[1]).toBe(TASK);
    expect(accs[2]).toBe(AGENT);
    expect(accs[accs.length - 2]).toBe(AUTHORITY_ADDR);
    expect(accs[accs.length - 1]).toBe(SYSTEM_PROGRAM);

    const decoded = getInitiateDisputeInstructionDataDecoder().decode(ix.data);
    expect(decoded.resolutionType).toBe(1);
    expect(decoded.evidence).toBe("ipfs://evidence");
    expect(Array.from(decoded.disputeId)).toEqual(Array.from(disputeId));
    expect(Array.from(decoded.taskId)).toEqual(Array.from(taskId));
    expect(Array.from(decoded.evidenceHash)).toEqual(Array.from(evidenceHash));
  });

  it("voteDispute: program, account order, data round-trip", async () => {
    const ix = await facade.voteDispute({
      dispute: DISPUTE,
      task: TASK,
      arbiter: ARBITER,
      authority: AUTHORITY,
      approve: true,
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // dispute, task, workerClaim?, defendantAgent?, vote, authorityVote, arbiter,
    // protocolConfig, authority, systemProgram
    const accs = order(ix);
    expect(accs[0]).toBe(DISPUTE);
    expect(accs[1]).toBe(TASK);
    expect(accs).toContain(ARBITER);
    expect(accs[accs.length - 2]).toBe(AUTHORITY_ADDR);
    expect(accs[accs.length - 1]).toBe(SYSTEM_PROGRAM);

    const decoded = getVoteDisputeInstructionDataDecoder().decode(ix.data);
    expect(decoded.approve).toBe(true);
  });

  it("resolveDispute: program, derives + passes both bond PDAs in order, data round-trips", async () => {
    const ix = await facade.resolveDispute({
      dispute: DISPUTE,
      task: TASK,
      authority: AUTHORITY,
      approve: true,
      creator: CREATOR,
      worker: WORKER_AGENT,
      workerWallet: WORKER_WALLET,
      bondTreasury: TREASURY,
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);

    const accs = order(ix);
    expect(accs[0]).toBe(DISPUTE);
    expect(accs[1]).toBe(TASK);

    // The bond PDAs must be present and equal to what the facade should have derived.
    const [creatorBond] = await findCreatorCompletionBondPda({
      task: TASK,
      creator: CREATOR,
    });
    const [workerBond] = await findWorkerCompletionBondPda({
      task: TASK,
      workerAuthority: WORKER_WALLET,
    });
    // Last three accounts are creatorCompletionBond, workerCompletionBond, bondTreasury.
    expect(accs[accs.length - 3]).toBe(creatorBond);
    expect(accs[accs.length - 2]).toBe(workerBond);
    expect(accs[accs.length - 1]).toBe(TREASURY);
    // And they are genuinely included (the hint: callers cannot omit them).
    expect(accs).toContain(creatorBond);
    expect(accs).toContain(workerBond);

    // resolve_dispute carries no args beyond the discriminator.
    expect(() =>
      getResolveDisputeInstructionDataDecoder().decode(ix.data),
    ).not.toThrow();
  });

  it("expireDispute: program, derives + passes both bond PDAs in order, data round-trips", async () => {
    const ix = await facade.expireDispute({
      dispute: DISPUTE,
      task: TASK,
      creator: CREATOR,
      authority: AUTHORITY,
      worker: WORKER_AGENT,
      workerWallet: WORKER_WALLET,
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);

    const accs = order(ix);
    expect(accs[0]).toBe(DISPUTE);
    expect(accs[1]).toBe(TASK);

    const [creatorBond] = await findCreatorCompletionBondPda({
      task: TASK,
      creator: CREATOR,
    });
    const [workerBond] = await findWorkerCompletionBondPda({
      task: TASK,
      workerAuthority: WORKER_WALLET,
    });
    // Last two accounts are creatorCompletionBond, workerCompletionBond.
    expect(accs[accs.length - 2]).toBe(creatorBond);
    expect(accs[accs.length - 1]).toBe(workerBond);
    expect(accs).toContain(creatorBond);
    expect(accs).toContain(workerBond);

    expect(() =>
      getExpireDisputeInstructionDataDecoder().decode(ix.data),
    ).not.toThrow();
  });

  it("resolveDispute: throws when worker bond authority cannot be inferred", async () => {
    await expect(
      facade.resolveDispute({
        dispute: DISPUTE,
        task: TASK,
        authority: AUTHORITY,
        approve: true,
        creator: CREATOR,
        bondTreasury: TREASURY,
      }),
    ).rejects.toThrow(/workerBondAuthority/);
  });

  it("cancelDispute: program, account order, data round-trip", async () => {
    const ix = await facade.cancelDispute({
      dispute: DISPUTE,
      task: TASK,
      authority: AUTHORITY,
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // protocolConfig, dispute, task, authority
    const accs = order(ix);
    expect(accs[1]).toBe(DISPUTE);
    expect(accs[2]).toBe(TASK);
    expect(accs[3]).toBe(AUTHORITY_ADDR);

    expect(() =>
      getCancelDisputeInstructionDataDecoder().decode(ix.data),
    ).not.toThrow();
  });

  it("applyDisputeSlash: program, account order, data round-trip", async () => {
    const ix = await facade.applyDisputeSlash({
      dispute: DISPUTE,
      task: TASK,
      workerClaim: CLAIM,
      workerAgent: WORKER_AGENT,
      treasury: TREASURY,
      authority: AUTHORITY,
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // dispute, task, workerClaim, workerAgent, protocolConfig, treasury, authority, ...
    const accs = order(ix);
    expect(accs[0]).toBe(DISPUTE);
    expect(accs[1]).toBe(TASK);
    expect(accs[2]).toBe(CLAIM);
    expect(accs[3]).toBe(WORKER_AGENT);
    expect(accs[5]).toBe(TREASURY);
    expect(accs[6]).toBe(AUTHORITY_ADDR);
    expect(accs).toContain(TOKEN_PROGRAM);

    expect(() =>
      getApplyDisputeSlashInstructionDataDecoder().decode(ix.data),
    ).not.toThrow();
  });

  it("applyInitiatorSlash: program, account order, data round-trip", async () => {
    const ix = await facade.applyInitiatorSlash({
      dispute: DISPUTE,
      task: TASK,
      initiatorAgent: AGENT,
      treasury: TREASURY,
      authority: AUTHORITY,
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // dispute, task, initiatorAgent, protocolConfig, treasury, authority
    const accs = order(ix);
    expect(accs[0]).toBe(DISPUTE);
    expect(accs[1]).toBe(TASK);
    expect(accs[2]).toBe(AGENT);
    expect(accs[4]).toBe(TREASURY);
    expect(accs[5]).toBe(AUTHORITY_ADDR);

    expect(() =>
      getApplyInitiatorSlashInstructionDataDecoder().decode(ix.data),
    ).not.toThrow();
  });

  it("resolveRejectFrozen: program, derives bond PDAs, account order, data round-trip", async () => {
    const ix = await facade.resolveRejectFrozen({
      task: TASK,
      claim: CLAIM,
      worker: WORKER_AGENT,
      treasury: TREASURY,
      creator: CREATOR,
      workerAuthority: WORKER_WALLET,
      authority: AUTHORITY,
      approveCompletion: true,
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);

    const accs = order(ix);
    expect(accs[0]).toBe(TASK);
    expect(accs[1]).toBe(CLAIM);

    // Generated builder auto-derives the bonds; assert they made it in (positions
    // [-3], [-2] before systemProgram at [-1]).
    const [creatorBond] = await findCreatorCompletionBondPda({
      task: TASK,
      creator: CREATOR,
    });
    const [workerBond] = await findWorkerCompletionBondPda({
      task: TASK,
      workerAuthority: WORKER_WALLET,
    });
    expect(accs[accs.length - 3]).toBe(creatorBond);
    expect(accs[accs.length - 2]).toBe(workerBond);
    expect(accs[accs.length - 1]).toBe(SYSTEM_PROGRAM);

    const decoded = getResolveRejectFrozenInstructionDataDecoder().decode(ix.data);
    expect(decoded.approveCompletion).toBe(true);
  });

  it("expireRejectFrozen: program, derives bond PDAs, account order, data round-trip", async () => {
    const ix = await facade.expireRejectFrozen({
      task: TASK,
      claim: CLAIM,
      worker: WORKER_AGENT,
      treasury: TREASURY,
      creator: CREATOR,
      workerAuthority: WORKER_WALLET,
      authority: AUTHORITY,
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);

    const accs = order(ix);
    expect(accs[0]).toBe(TASK);
    expect(accs[1]).toBe(CLAIM);

    const [creatorBond] = await findCreatorCompletionBondPda({
      task: TASK,
      creator: CREATOR,
    });
    const [workerBond] = await findWorkerCompletionBondPda({
      task: TASK,
      workerAuthority: WORKER_WALLET,
    });
    expect(accs[accs.length - 3]).toBe(creatorBond);
    expect(accs[accs.length - 2]).toBe(workerBond);
    expect(accs[accs.length - 1]).toBe(SYSTEM_PROGRAM);

    expect(() =>
      getExpireRejectFrozenInstructionDataDecoder().decode(ix.data),
    ).not.toThrow();
  });

  it("assignDisputeResolver: program, auto-derives the roster PDA, data round-trips", async () => {
    const ix = await facade.assignDisputeResolver({
      authority: AUTHORITY,
      resolver: AGENT,
    });
    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const accs = order(ix);
    const [roster] = await findDisputeResolverPda({ resolver: AGENT });
    // protocolConfig(0, derived), disputeResolver(1, derived), authority(2), systemProgram(3)
    expect(accs[1]).toBe(roster);
    expect(accs[2]).toBe(AUTHORITY_ADDR);
    expect(accs[3]).toBe(SYSTEM_PROGRAM);

    const decoded = getAssignDisputeResolverInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.resolver).toBe(AGENT);
  });

  it("revokeDisputeResolver: derives the roster PDA from resolver, data round-trips", async () => {
    const ix = await facade.revokeDisputeResolver({
      authority: AUTHORITY,
      resolver: AGENT,
    });
    const accs = order(ix);
    const [roster] = await findDisputeResolverPda({ resolver: AGENT });
    // protocolConfig(0, derived), disputeResolver(1, facade-derived), authority(2)
    expect(accs[1]).toBe(roster);
    expect(accs[2]).toBe(AUTHORITY_ADDR);
    expect(() =>
      getRevokeDisputeResolverInstructionDataDecoder().decode(ix.data),
    ).not.toThrow();
  });

  it("revokeDisputeResolver: throws when neither resolver nor disputeResolver is given", async () => {
    await expect(
      facade.revokeDisputeResolver({ authority: AUTHORITY }),
    ).rejects.toThrow(/resolver/);
  });
});
