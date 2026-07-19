import { describe, it, expect } from "vitest";
import { AccountRole, address, createNoopSigner } from "@solana/kit";
import {
  // generated sync builders (used as the structural ground truth for account order)
  getInitiateDisputeInstructionDataDecoder,
  // P6.3: `getVoteDisputeInstructionDataDecoder` retired with `vote_dispute`.
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
  findTaskSubmissionPda,
  findHireRecordPda,
  findBidBookPda,
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
// P6.3: the ARBITER placeholder is gone with the retired `voteDispute` structural test.
const CLAIM = a("SysvarS1otHashes111111111111111111111111111");
const DISPUTE = a("SysvarStakeHistory1111111111111111111111111");
const AUTHORITY_ADDR = a("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const AUTHORITY = createNoopSigner(AUTHORITY_ADDR);
const MULTISIG_APPROVER_A = createNoopSigner(
  a("LoaderV411111111111111111111111111111111111"),
);
const MULTISIG_APPROVER_B = createNoopSigner(
  a("SysvarC1ock11111111111111111111111111111111"),
);
const PEER_CLAIM = a("SysvarRecentB1ockHashes11111111111111111111");
const PEER_WORKER = a("AddressLookupTab1e1111111111111111111111111");
const PARENT_TASK = a("Config1111111111111111111111111111111111111");
const ACCEPTED_BID = a("ComputeBudget111111111111111111111111111111");
const BIDDER_STATE = a("Ed25519SigVerify111111111111111111111111111");

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

  // P6.3: the `voteDispute` structural test is removed — the per-case arbiter
  // vote/quorum model is retired. A threshold-approved protocol authority or
  // threshold-seated assigned resolver decides via `resolveDispute`, covered below.

  it("resolveDispute: program, derives + passes both bond PDAs in order, data round-trips", async () => {
    // P6.4 accountable rulings: rationaleHash (32 bytes) + rationaleUri are now REQUIRED.
    const rationaleHash = new Uint8Array(32).fill(5);
    const rationaleUri = "agenc://ruling/sha256/approve";
    const ix = await facade.resolveDispute({
      dispute: DISPUTE,
      task: TASK,
      authority: AUTHORITY,
      approve: true,
      rationaleHash,
      rationaleUri,
      creator: CREATOR,
      workerClaim: CLAIM,
      worker: WORKER_AGENT,
      workerWallet: WORKER_WALLET,
      bondTreasury: TREASURY,
      dependencyParent: PARENT_TASK,
      peerWorkers: [{ claim: PEER_CLAIM, worker: PEER_WORKER }],
      bidSettlement: {
        acceptedBid: ACCEPTED_BID,
        bidderMarketState: BIDDER_STATE,
      },
      multisigSigners: [MULTISIG_APPROVER_A, MULTISIG_APPROVER_B],
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
    expect(accs).toContain(creatorBond);
    expect(accs).toContain(workerBond);
    expect(accs).toContain(TREASURY);
    const [submission] = await findTaskSubmissionPda({ claim: CLAIM });
    expect(accs).toContain(submission);
    const [peerSubmission] = await findTaskSubmissionPda({ claim: PEER_CLAIM });
    const [bidBook] = await findBidBookPda({ task: TASK });
    expect(accs.slice(-9)).toEqual([
      PARENT_TASK,
      PEER_CLAIM,
      PEER_WORKER,
      peerSubmission,
      bidBook,
      ACCEPTED_BID,
      BIDDER_STATE,
      MULTISIG_APPROVER_A.address,
      MULTISIG_APPROVER_B.address,
    ]);
    for (const [index, signer] of [
      MULTISIG_APPROVER_A,
      MULTISIG_APPROVER_B,
    ].entries()) {
      expect(ix.accounts[ix.accounts.length - 2 + index]).toMatchObject({
        role: AccountRole.READONLY_SIGNER,
        signer,
      });
    }

    // P6.4: the reasoned ruling (approve + rationaleHash + rationaleUri) round-trips.
    const decoded = getResolveDisputeInstructionDataDecoder().decode(ix.data);
    expect(decoded.approve).toBe(true);
    expect(Array.from(decoded.rationaleHash)).toEqual(
      Array.from(rationaleHash),
    );
    expect(decoded.rationaleUri).toBe(rationaleUri);
  });

  it("expireDispute: program, derives + passes both bond PDAs in order, data round-trips", async () => {
    const ix = await facade.expireDispute({
      dispute: DISPUTE,
      task: TASK,
      creator: CREATOR,
      authority: AUTHORITY,
      workerClaim: CLAIM,
      worker: WORKER_AGENT,
      workerWallet: WORKER_WALLET,
      dependencyParent: PARENT_TASK,
      peerWorkers: [{ claim: PEER_CLAIM, worker: PEER_WORKER }],
      bidSettlement: {
        acceptedBid: ACCEPTED_BID,
        bidderMarketState: BIDDER_STATE,
      },
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
    expect(accs).toContain(creatorBond);
    expect(accs).toContain(workerBond);
    const [submission] = await findTaskSubmissionPda({ claim: CLAIM });
    expect(accs).toContain(submission);
    const [peerSubmission] = await findTaskSubmissionPda({ claim: PEER_CLAIM });
    const [bidBook] = await findBidBookPda({ task: TASK });
    expect(accs.slice(-7)).toEqual([
      PARENT_TASK,
      PEER_CLAIM,
      PEER_WORKER,
      peerSubmission,
      bidBook,
      ACCEPTED_BID,
      BIDDER_STATE,
    ]);
    expect(ix.accounts.slice(-7).map((account) => account.role)).toEqual([
      AccountRole.READONLY,
      AccountRole.WRITABLE,
      AccountRole.WRITABLE,
      AccountRole.WRITABLE,
      AccountRole.WRITABLE,
      AccountRole.WRITABLE,
      AccountRole.WRITABLE,
    ]);

    expect(() =>
      getExpireDisputeInstructionDataDecoder().decode(ix.data),
    ).not.toThrow();
  });

  it("cancelDispute: program, account order, data round-trip", async () => {
    const ix = await facade.cancelDispute({
      dispute: DISPUTE,
      task: TASK,
      authority: AUTHORITY,
      defendant: WORKER_AGENT,
      taskValidationConfig: CLAIM,
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // protocolConfig, dispute, task, authority
    const accs = order(ix);
    expect(accs[1]).toBe(DISPUTE);
    expect(accs[2]).toBe(TASK);
    expect(accs[3]).toBe(AUTHORITY_ADDR);
    expect(accs[4]).toBe(WORKER_AGENT);
    expect(ix.accounts[4]?.role).toBe(AccountRole.WRITABLE);
    expect(accs[5]).toBe(CLAIM);
    expect(ix.accounts[5]?.role).toBe(AccountRole.READONLY);

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
      workerAuthority: CREATOR,
      treasury: TREASURY,
      authority: AUTHORITY,
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // dispute, task, workerClaim, workerAgent, workerAuthority, protocolConfig, treasury, authority, ...
    const accs = order(ix);
    expect(accs[0]).toBe(DISPUTE);
    expect(accs[1]).toBe(TASK);
    expect(accs[2]).toBe(CLAIM);
    expect(accs[3]).toBe(WORKER_AGENT);
    expect(accs[4]).toBe(CREATOR);
    expect(accs[6]).toBe(TREASURY);
    expect(accs[7]).toBe(AUTHORITY_ADDR);
    // No token settlement requested: the optional token-program slot MUST be
    // Anchor's None placeholder, not Codama's SPL default (which would make the
    // on-chain handler think a partial settlement was requested).
    expect(accs[12]).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);

    expect(() =>
      getApplyDisputeSlashInstructionDataDecoder().decode(ix.data),
    ).not.toThrow();
  });

  it("applyDisputeSlash: requires + appends creator on the complete token path", async () => {
    const ix = await facade.applyDisputeSlash({
      dispute: DISPUTE,
      task: TASK,
      workerClaim: CLAIM,
      workerAgent: WORKER_AGENT,
      workerAuthority: WORKER_WALLET,
      treasury: TREASURY,
      authority: AUTHORITY,
      escrow: AGENT,
      tokenEscrowAta: CREATOR,
      treasuryTokenAccount: TREASURY,
      rewardMint: TASK,
      creator: AUTHORITY_ADDR,
    });
    const accs = order(ix);
    expect(accs[8]).toBe(AGENT);
    expect(accs[9]).toBe(CREATOR);
    expect(accs[10]).toBe(TREASURY);
    expect(accs[11]).toBe(TASK);
    expect(accs[12]).toBe(TOKEN_PROGRAM);
    expect(accs[13]).toBe(AUTHORITY_ADDR);
    expect(ix.accounts[13]?.role).toBe(AccountRole.WRITABLE);
  });

  it("applyDisputeSlash: fails before construction on a partial token account set", async () => {
    await expect(
      facade.applyDisputeSlash({
        dispute: DISPUTE,
        task: TASK,
        workerClaim: CLAIM,
        workerAgent: WORKER_AGENT,
        workerAuthority: WORKER_WALLET,
        treasury: TREASURY,
        authority: AUTHORITY,
        escrow: AGENT,
        tokenEscrowAta: CREATOR,
      } as never),
    ).rejects.toThrow(/token settlement requires/);
  });

  it("applyInitiatorSlash: program, account order, data round-trip", async () => {
    // Audit F-2: the instruction no longer takes the Task account (the stored
    // dispute.task binding is inherent), so a destroyed Task PDA cannot brick it.
    const ix = await facade.applyInitiatorSlash({
      dispute: DISPUTE,
      initiatorAgent: AGENT,
      treasury: TREASURY,
      authority: AUTHORITY,
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // dispute, initiatorAgent, protocolConfig, treasury, authority (no task — F-2)
    const accs = order(ix);
    expect(accs[0]).toBe(DISPUTE);
    expect(accs[1]).toBe(AGENT);
    expect(accs[3]).toBe(TREASURY);
    expect(accs[4]).toBe(AUTHORITY_ADDR);

    expect(() =>
      getApplyInitiatorSlashInstructionDataDecoder().decode(ix.data),
    ).not.toThrow();
  });

  it("resolveRejectFrozen: derives bonds and appends a nonzero-threshold multisig suffix", async () => {
    const ix = await facade.resolveRejectFrozen({
      task: TASK,
      claim: CLAIM,
      worker: WORKER_AGENT,
      treasury: TREASURY,
      creator: CREATOR,
      workerAuthority: WORKER_WALLET,
      authority: AUTHORITY,
      approveCompletion: true,
      operator: AGENT,
      referrer: DISPUTE,
      multisigSigners: [MULTISIG_APPROVER_A, MULTISIG_APPROVER_B],
    });

    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);

    const accs = order(ix);
    expect(accs).toHaveLength(18);
    expect(accs[0]).toBe(TASK);
    expect(accs[1]).toBe(CLAIM);
    const [hireRecord] = await findHireRecordPda({ task: TASK });
    expect(accs[9]).toBe(hireRecord);
    expect(accs[10]).toBe(AGENT);
    expect(accs[11]).toBe(DISPUTE);
    expect(accs[12]).toBe(AUTHORITY_ADDR);

    // The generated base ends with both derived bonds + systemProgram; the
    // facade-owned multisig approvals follow as signer remaining accounts.
    const [creatorBond] = await findCreatorCompletionBondPda({
      task: TASK,
      creator: CREATOR,
    });
    const [workerBond] = await findWorkerCompletionBondPda({
      task: TASK,
      workerAuthority: WORKER_WALLET,
    });
    expect(accs[13]).toBe(creatorBond);
    expect(accs[14]).toBe(workerBond);
    expect(accs[15]).toBe(SYSTEM_PROGRAM);
    expect(accs.slice(-2)).toEqual([
      MULTISIG_APPROVER_A.address,
      MULTISIG_APPROVER_B.address,
    ]);
    for (const [index, signer] of [
      MULTISIG_APPROVER_A,
      MULTISIG_APPROVER_B,
    ].entries()) {
      expect(ix.accounts[16 + index]).toMatchObject({
        role: AccountRole.READONLY_SIGNER,
        signer,
      });
    }

    const decoded = getResolveRejectFrozenInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.approveCompletion).toBe(true);
  });

  it("resolveRejectFrozen rejects duplicate multisig approvers", async () => {
    await expect(
      facade.resolveRejectFrozen({
        task: TASK,
        claim: CLAIM,
        worker: WORKER_AGENT,
        treasury: TREASURY,
        creator: CREATOR,
        workerAuthority: WORKER_WALLET,
        authority: AUTHORITY,
        approveCompletion: false,
        operator: AGENT,
        referrer: DISPUTE,
        multisigSigners: [MULTISIG_APPROVER_A, MULTISIG_APPROVER_A],
      }),
    ).rejects.toThrow(/duplicate signer address/);
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
    expect(accs).toHaveLength(16);
    expect(accs[0]).toBe(TASK);
    expect(accs[1]).toBe(CLAIM);
    const [hireRecord] = await findHireRecordPda({ task: TASK });
    expect(accs[9]).toBe(hireRecord);
    expect(accs[10]).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(accs[11]).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(accs[12]).toBe(AUTHORITY_ADDR);

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
      multisigSigners: [MULTISIG_APPROVER_A, MULTISIG_APPROVER_B],
    });
    expect(programOf(ix)).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const accs = order(ix);
    const [roster] = await findDisputeResolverPda({ resolver: AGENT });
    // protocolConfig(0, derived), disputeResolver(1, derived), authority(2), systemProgram(3)
    expect(accs[1]).toBe(roster);
    expect(accs[2]).toBe(AUTHORITY_ADDR);
    expect(accs[3]).toBe(SYSTEM_PROGRAM);
    expect(accs.slice(4)).toEqual([
      MULTISIG_APPROVER_A.address,
      MULTISIG_APPROVER_B.address,
    ]);
    expect(ix.accounts.slice(4).map((account) => account.role)).toEqual([
      AccountRole.READONLY_SIGNER,
      AccountRole.READONLY_SIGNER,
    ]);

    const decoded = getAssignDisputeResolverInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.resolver).toBe(AGENT);
  });

  it("revokeDisputeResolver: derives the roster PDA from resolver, data round-trips", async () => {
    const ix = await facade.revokeDisputeResolver({
      authority: AUTHORITY,
      resolver: AGENT,
      multisigSigners: [MULTISIG_APPROVER_A, MULTISIG_APPROVER_B],
    });
    const accs = order(ix);
    const [roster] = await findDisputeResolverPda({ resolver: AGENT });
    // protocolConfig(0, derived), disputeResolver(1, facade-derived), authority(2)
    expect(accs[1]).toBe(roster);
    expect(accs[2]).toBe(AUTHORITY_ADDR);
    expect(accs.slice(3)).toEqual([
      MULTISIG_APPROVER_A.address,
      MULTISIG_APPROVER_B.address,
    ]);
    for (const [index, signer] of [
      MULTISIG_APPROVER_A,
      MULTISIG_APPROVER_B,
    ].entries()) {
      expect(ix.accounts[3 + index]).toMatchObject({
        role: AccountRole.READONLY_SIGNER,
        signer,
      });
    }
    expect(() =>
      getRevokeDisputeResolverInstructionDataDecoder().decode(ix.data),
    ).not.toThrow();
  });

  it("revokeDisputeResolver: throws when neither resolver nor disputeResolver is given", async () => {
    await expect(
      facade.revokeDisputeResolver({
        authority: AUTHORITY,
        multisigSigners: [MULTISIG_APPROVER_A, MULTISIG_APPROVER_B],
      }),
    ).rejects.toThrow(/resolver/);
  });

  it("resolver roster multisig suffix rejects duplicate approvers", async () => {
    await expect(
      facade.assignDisputeResolver({
        authority: AUTHORITY,
        resolver: AGENT,
        multisigSigners: [MULTISIG_APPROVER_A, MULTISIG_APPROVER_A],
      }),
    ).rejects.toThrow(/duplicate signer address/);
  });
});
