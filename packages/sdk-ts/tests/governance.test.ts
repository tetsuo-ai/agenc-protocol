import { describe, it, expect } from "vitest";
import {
  AccountRole,
  address,
  createNoopSigner,
  type AccountMeta,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  getCreateProposalInstructionDataDecoder,
  getVoteProposalInstructionDataDecoder,
  getCancelProposalInstructionDataDecoder,
  getExecuteProposalInstructionDataDecoder,
  getInitializeGovernanceInstructionDataDecoder,
  getUpdateMultisigInstructionDataDecoder,
  getUpdateTreasuryInstructionDataDecoder,
  getUpdateProtocolFeeInstructionDataDecoder,
  getUpdateRateLimitsInstructionDataDecoder,
  getUpdateMinVersionInstructionDataDecoder,
  getUpdateStateInstructionDataDecoder,
  getUpdateLaunchControlsInstructionDataDecoder,
  getInitializeProtocolInstructionDataDecoder,
  getMigrateTaskInstructionDataDecoder,
  getMigrateProtocolInstructionDataDecoder,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";
import {
  createProposal,
  voteProposal,
  cancelProposal,
  executeProposal,
  initializeGovernance,
  updateMultisig,
  updateTreasury,
  updateProtocolFee,
  updateRateLimits,
  updateMinVersion,
  updateState,
  updateLaunchControls,
  initializeProtocol,
  findAgencProgramDataPda,
  migrateTask,
  migrateProtocol,
} from "../src/facade/governance.js";

// Structural tests (the facade loop pattern): build each instruction through the
// facade and assert (1) program address, (2) account order, and (3) that the
// encoded data round-trips through the matching generated decoder. Deterministic,
// no VM — validates the facade wiring + generated builder against the IDL.

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

// Reusable valid base58 placeholder addresses.
const A = {
  proposal: address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK"),
  protocolConfig: address("So11111111111111111111111111111111111111112"),
  governanceConfig: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  state: address("Stake11111111111111111111111111111111111111"),
  vote: address("Vote111111111111111111111111111111111111111"),
  treasury: address("SysvarRent111111111111111111111111111111111"),
  recipient: address("SysvarC1ock11111111111111111111111111111111"),
  newTreasury: address("Sysvar1nstructions1111111111111111111111111"),
  agent: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
  task: address("Config1111111111111111111111111111111111111"),
  ownerA: address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK"),
  ownerB: address("So11111111111111111111111111111111111111112"),
};

const authority = createNoopSigner(
  address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
);
const secondSigner = createNoopSigner(
  address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
);
const newTreasury = createNoopSigner(A.newTreasury);
const payer = createNoopSigner(
  address("Config1111111111111111111111111111111111111"),
);
const treasury = createNoopSigner(A.treasury);
const multisigSignerA = createNoopSigner(
  address("E5AhdYwQJK5hnHKveTJ3abMcNqWZXVtDNHuugdxFPjn4"),
);
const multisigSignerB = createNoopSigner(
  address("EFN2MEp3EduDRkn6x7h8NQX3Z9n2S8hwX1B8LUWDHgnx"),
);
const multisigSigners = [multisigSignerA, multisigSignerB] as const;
const multisigSignerAddresses = multisigSigners.map((signer) => signer.address);

function expectMultisigSignerSuffix(accounts: readonly AccountMeta[]) {
  const suffix = accounts.slice(-multisigSigners.length);
  expect(suffix.map((account) => account.address)).toEqual(
    multisigSignerAddresses,
  );
  for (const [index, account] of suffix.entries()) {
    expect(account.role).toBe(AccountRole.READONLY_SIGNER);
    expect(account).toHaveProperty("signer", multisigSigners[index]);
  }
}

function createMutableAddressSigner(initialAddress: Address): {
  signer: TransactionSigner;
  setLiveAddress(nextAddress: Address): void;
} {
  let liveAddress = initialAddress;
  const signer = {
    ...createNoopSigner(initialAddress),
  } as TransactionSigner;
  Object.defineProperty(signer, "address", {
    configurable: true,
    enumerable: true,
    get: () => liveAddress,
  });
  return {
    signer,
    setLiveAddress(nextAddress) {
      liveAddress = nextAddress;
    },
  };
}

describe("governance facade — proposals", () => {
  it("createProposal: program, account order, data round-trip", async () => {
    const titleHash = new Uint8Array(32).fill(1);
    const descriptionHash = new Uint8Array(32).fill(2);
    const payload = new Uint8Array(64).fill(3);
    const ix = await createProposal({
      proposal: A.proposal,
      proposer: authority.address,
      protocolConfig: A.protocolConfig,
      governanceConfig: A.governanceConfig,
      authority,
      nonce: 9n,
      proposalType: 4,
      titleHash,
      descriptionHash,
      payload,
      votingPeriod: 86_400n,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.proposal,
      authority.address,
      A.protocolConfig,
      A.governanceConfig,
      authority.address,
      SYSTEM_PROGRAM,
    ]);

    const decoded = getCreateProposalInstructionDataDecoder().decode(ix.data);
    expect(decoded.nonce).toBe(9n);
    expect(decoded.proposalType).toBe(4);
    expect(decoded.votingPeriod).toBe(86_400n);
    expect(Array.from(decoded.titleHash)).toEqual(Array.from(titleHash));
    expect(Array.from(decoded.descriptionHash)).toEqual(
      Array.from(descriptionHash),
    );
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  });

  it("createProposal snapshots signer identity and fixed data before derivation yields", async () => {
    const mutableAuthority = createMutableAddressSigner(authority.address);
    const titleHash = new Uint8Array(32).fill(31);
    const descriptionHash = new Uint8Array(32).fill(32);
    const payload = new Uint8Array(64).fill(33);
    const instructionPromise = createProposal({
      proposer: authority.address,
      authority: mutableAuthority.signer,
      nonce: 77n,
      proposalType: 4,
      titleHash,
      descriptionHash,
      payload,
      votingPeriod: 86_400n,
    });

    mutableAuthority.setLiveAddress(A.ownerB);
    titleHash.fill(91);
    descriptionHash.fill(92);
    payload.fill(93);

    const ix = await instructionPromise;
    const decoded = getCreateProposalInstructionDataDecoder().decode(ix.data);
    expect(ix.accounts[4]).toMatchObject({
      address: authority.address,
      signer: mutableAuthority.signer,
    });
    expect(decoded.titleHash).toEqual(new Uint8Array(32).fill(31));
    expect(decoded.descriptionHash).toEqual(new Uint8Array(32).fill(32));
    expect(decoded.payload).toEqual(new Uint8Array(64).fill(33));
  });

  it("voteProposal: program, account order, data round-trip", async () => {
    const ix = await voteProposal({
      proposal: A.proposal,
      vote: A.vote,
      voter: authority.address,
      protocolConfig: A.protocolConfig,
      authority,
      approve: true,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.proposal,
      A.vote,
      authority.address,
      A.protocolConfig,
      authority.address,
      SYSTEM_PROGRAM,
    ]);

    const decoded = getVoteProposalInstructionDataDecoder().decode(ix.data);
    expect(decoded.approve).toBe(true);
  });

  it("cancelProposal: program, account order, data round-trip", () => {
    const ix = cancelProposal({ proposal: A.proposal, authority });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.proposal,
      authority.address,
    ]);

    // Discriminator-only payload still decodes cleanly.
    const decoded = getCancelProposalInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator.length).toBe(8);
  });

  it("executeProposal: program, account order, data round-trip", async () => {
    const ix = await executeProposal({
      proposal: A.proposal,
      protocolConfig: A.protocolConfig,
      governanceConfig: A.governanceConfig,
      authority,
      treasury,
      recipient: A.recipient,
      multisigSigners,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.proposal,
      A.protocolConfig,
      A.governanceConfig,
      authority.address,
      A.treasury,
      A.recipient,
      SYSTEM_PROGRAM,
      ...multisigSignerAddresses,
    ]);
    expectMultisigSignerSuffix(ix.accounts);

    const decoded = getExecuteProposalInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator.length).toBe(8);
  });

  it("executeProposal: permits no approvals for proposal kinds without dual control", async () => {
    const ix = await executeProposal({
      proposal: A.proposal,
      protocolConfig: A.protocolConfig,
      governanceConfig: A.governanceConfig,
      authority,
      treasury,
      recipient: A.recipient,
    });

    expect(ix.accounts.map((account) => account.address)).toEqual([
      A.proposal,
      A.protocolConfig,
      A.governanceConfig,
      authority.address,
      A.treasury,
      A.recipient,
      SYSTEM_PROGRAM,
    ]);
  });
});

describe("governance facade — governance + protocol config", () => {
  it("initializeGovernance: program, account order, data round-trip", async () => {
    const ix = await initializeGovernance({
      governanceConfig: A.governanceConfig,
      protocolConfig: A.protocolConfig,
      authority,
      votingPeriod: 86_400n,
      executionDelay: 3_600n,
      quorumBps: 2_000,
      approvalThresholdBps: 6_000,
      minProposalStake: 1_000_000n,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.governanceConfig,
      A.protocolConfig,
      authority.address,
      SYSTEM_PROGRAM,
    ]);

    const decoded = getInitializeGovernanceInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.votingPeriod).toBe(86_400n);
    expect(decoded.executionDelay).toBe(3_600n);
    expect(decoded.quorumBps).toBe(2_000);
    expect(decoded.approvalThresholdBps).toBe(6_000);
    expect(decoded.minProposalStake).toBe(1_000_000n);
  });

  it("updateMultisig: program, account order, data round-trip", async () => {
    const newOwners = [A.ownerA, A.ownerB];
    const ix = await updateMultisig({
      protocolConfig: A.protocolConfig,
      authority,
      newThreshold: 2,
      newOwners,
      multisigSigners,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.protocolConfig,
      authority.address,
      ...multisigSignerAddresses,
    ]);
    expectMultisigSignerSuffix(ix.accounts);

    const decoded = getUpdateMultisigInstructionDataDecoder().decode(ix.data);
    expect(decoded.newThreshold).toBe(2);
    expect(decoded.newOwners).toEqual(newOwners);
  });

  it("updateTreasury: program, account order, data round-trip", async () => {
    const ix = await updateTreasury({
      protocolConfig: A.protocolConfig,
      newTreasury,
      authority,
      multisigSigners,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.protocolConfig,
      A.newTreasury,
      authority.address,
      ...multisigSignerAddresses,
    ]);
    expect(ix.accounts[1]?.role).toBe(AccountRole.READONLY_SIGNER);
    expect(ix.accounts[1]).toHaveProperty("signer", newTreasury);
    expectMultisigSignerSuffix(ix.accounts);

    const decoded = getUpdateTreasuryInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator.length).toBe(8);
  });

  it("updateProtocolFee: program, account order, data round-trip", async () => {
    const ix = await updateProtocolFee({
      protocolConfig: A.protocolConfig,
      authority,
      protocolFeeBps: 250,
      multisigSigners,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.protocolConfig,
      authority.address,
      ...multisigSignerAddresses,
    ]);
    expectMultisigSignerSuffix(ix.accounts);

    const decoded = getUpdateProtocolFeeInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.protocolFeeBps).toBe(250);
  });

  it("updateRateLimits: program, account order, data round-trip", async () => {
    const ix = await updateRateLimits({
      protocolConfig: A.protocolConfig,
      authority,
      taskCreationCooldown: 60n,
      maxTasksPer24h: 100,
      disputeInitiationCooldown: 120n,
      maxDisputesPer24h: 10,
      minStakeForDispute: 500_000n,
      multisigSigners,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.protocolConfig,
      authority.address,
      ...multisigSignerAddresses,
    ]);
    expectMultisigSignerSuffix(ix.accounts);

    const decoded = getUpdateRateLimitsInstructionDataDecoder().decode(ix.data);
    expect(decoded.taskCreationCooldown).toBe(60n);
    expect(decoded.maxTasksPer24h).toBe(100);
    expect(decoded.disputeInitiationCooldown).toBe(120n);
    expect(decoded.maxDisputesPer24h).toBe(10);
    expect(decoded.minStakeForDispute).toBe(500_000n);
  });

  it("updateMinVersion: program, account order, data round-trip", async () => {
    const ix = await updateMinVersion({
      protocolConfig: A.protocolConfig,
      authority,
      newMinVersion: 7,
      multisigSigners,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.protocolConfig,
      authority.address,
      ...multisigSignerAddresses,
    ]);
    expectMultisigSignerSuffix(ix.accounts);

    const decoded = getUpdateMinVersionInstructionDataDecoder().decode(ix.data);
    expect(decoded.newMinVersion).toBe(7);
  });

  it("updateState: program, account order, data round-trip", async () => {
    const stateKey = new Uint8Array(32).fill(5);
    // stateValue is a fixed 64-byte field on-chain; use the full width so the
    // encode/decode round-trip is exact (a shorter array is right-padded with 0).
    const stateValue = new Uint8Array(64).fill(7);
    const ix = await updateState({
      state: A.state,
      agent: A.agent,
      authority,
      protocolConfig: A.protocolConfig,
      stateKey,
      stateValue,
      version: 1n,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.state,
      A.agent,
      authority.address,
      A.protocolConfig,
      SYSTEM_PROGRAM,
    ]);

    const decoded = getUpdateStateInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.stateKey)).toEqual(Array.from(stateKey));
    expect(Array.from(decoded.stateValue)).toEqual(Array.from(stateValue));
    expect(decoded.version).toBe(1n);
  });

  it("updateState detaches key and value before its PDA derivation yields", async () => {
    const stateKey = new Uint8Array(32).fill(41);
    const stateValue = new Uint8Array(64).fill(42);
    const instructionPromise = updateState({
      agent: A.agent,
      authority,
      stateKey,
      stateValue,
      version: 3n,
    });

    stateKey.fill(94);
    stateValue.fill(95);

    const decoded = getUpdateStateInstructionDataDecoder().decode(
      (await instructionPromise).data,
    );
    expect(decoded.stateKey).toEqual(new Uint8Array(32).fill(41));
    expect(decoded.stateValue).toEqual(new Uint8Array(64).fill(42));
  });

  it("updateLaunchControls: program, account order, data round-trip", async () => {
    // updateLaunchControls carries a `surfaceRevision: u16` argument, but Rust
    // rejects promotion to CURRENT; only stampReleaseSurface may publish it.
    const ix = await updateLaunchControls({
      protocolConfig: A.protocolConfig,
      authority,
      protocolPaused: true,
      disabledTaskTypeMask: 6,
      surfaceRevision: 1,
      multisigSigners,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.protocolConfig,
      authority.address,
      ...multisigSignerAddresses,
    ]);
    expectMultisigSignerSuffix(ix.accounts);

    const decoded = getUpdateLaunchControlsInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.protocolPaused).toBe(true);
    expect(decoded.disabledTaskTypeMask).toBe(6);
    expect(decoded.surfaceRevision).toBe(1);
  });

  it("initializeProtocol: program, account order, data round-trip", async () => {
    const multisigOwners = [
      authority.address,
      secondSigner.address,
      A.ownerA,
    ];
    const programData = await findAgencProgramDataPda();
    const ix = await initializeProtocol({
      protocolConfig: A.protocolConfig,
      treasury,
      authority,
      secondSigner,
      disputeThreshold: 3,
      protocolFeeBps: 200,
      minStake: 1_000n,
      minStakeForDispute: 2_000n,
      multisigThreshold: 2,
      multisigOwners,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.protocolConfig,
      A.treasury,
      authority.address,
      secondSigner.address,
      SYSTEM_PROGRAM,
      programData,
    ]);

    const decoded = getInitializeProtocolInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.disputeThreshold).toBe(3);
    expect(decoded.protocolFeeBps).toBe(200);
    expect(decoded.minStake).toBe(1_000n);
    expect(decoded.minStakeForDispute).toBe(2_000n);
    expect(decoded.multisigThreshold).toBe(2);
    expect(decoded.multisigOwners).toEqual(multisigOwners);
  });

  it("initializeProtocol snapshots the owner set before derivation yields", async () => {
    const multisigOwners: Address[] = [
      authority.address,
      secondSigner.address,
      A.ownerA,
    ];
    const instructionPromise = initializeProtocol({
      treasury,
      authority,
      secondSigner,
      disputeThreshold: 3,
      protocolFeeBps: 200,
      minStake: 1_000n,
      minStakeForDispute: 2_000n,
      multisigThreshold: 2,
      multisigOwners,
    });

    multisigOwners[0] = A.treasury;
    multisigOwners.push(A.recipient);

    expect(
      getInitializeProtocolInstructionDataDecoder().decode(
        (await instructionPromise).data,
      ).multisigOwners,
    ).toEqual([authority.address, secondSigner.address, A.ownerA]);
  });

  it("initializeProtocol appends the canonical ProgramData account before additional owner signers", async () => {
    const additionalA = createNoopSigner(A.ownerA);
    const additionalB = createNoopSigner(A.ownerB);
    const additionalMultisigSigners: TransactionSigner[] = [
      additionalA,
      additionalB,
    ];
    const ixPromise = initializeProtocol({
      protocolConfig: A.protocolConfig,
      treasury,
      authority,
      secondSigner,
      disputeThreshold: 67,
      protocolFeeBps: 200,
      minStake: 1_000_000n,
      minStakeForDispute: 2_000n,
      multisigThreshold: 4,
      multisigOwners: [
        authority.address,
        secondSigner.address,
        additionalA.address,
        additionalB.address,
        treasury.address,
      ],
      additionalMultisigSigners,
    });

    additionalMultisigSigners.reverse();

    const ix = await ixPromise;
    const programData = await findAgencProgramDataPda();
    expect(ix.accounts.slice(-3).map((account) => account.address)).toEqual([
      programData,
      additionalA.address,
      additionalB.address,
    ]);
    expect(ix.accounts.at(-3)?.role).toBe(AccountRole.READONLY);
    for (const [index, signer] of [additionalA, additionalB].entries()) {
      expect(ix.accounts.at(-2 + index)).toMatchObject({
        role: AccountRole.READONLY_SIGNER,
        signer,
      });
    }
  });

  it("initializeProtocol rejects unnecessary duplicate or oversized additional owner signer suffixes", async () => {
    await expect(
      initializeProtocol({
        treasury,
        authority,
        secondSigner,
        disputeThreshold: 67,
        protocolFeeBps: 200,
        minStake: 1_000_000n,
        minStakeForDispute: 2_000n,
        multisigThreshold: 3,
        multisigOwners: [
          authority.address,
          secondSigner.address,
          A.ownerA,
          A.ownerB,
        ],
        additionalMultisigSigners: [authority],
      }),
    ).rejects.toThrow(/must not repeat named signer/u);

    await expect(
      initializeProtocol({
        treasury,
        authority,
        secondSigner,
        disputeThreshold: 67,
        protocolFeeBps: 200,
        minStake: 1_000_000n,
        minStakeForDispute: 2_000n,
        multisigThreshold: 4,
        multisigOwners: [
          authority.address,
          secondSigner.address,
          A.ownerA,
          A.ownerB,
          multisigSignerA.address,
        ],
        additionalMultisigSigners: [
          createNoopSigner(A.ownerA),
          createNoopSigner(A.ownerB),
          multisigSignerA,
        ],
      }),
    ).rejects.toThrow(/exactly 2 approvals/u);
  });

  it("rejects duplicate ProtocolConfig approval addresses", async () => {
    await expect(
      updateProtocolFee({
        protocolConfig: A.protocolConfig,
        authority,
        protocolFeeBps: 250,
        multisigSigners: [
          multisigSignerA,
          createNoopSigner(multisigSignerA.address),
        ],
      }),
    ).rejects.toThrow(
      `multisigSigners: duplicate signer address ${multisigSignerA.address}`,
    );
  });

  it("repeats an owner used as named authority in the remaining-account suffix", async () => {
    const ix = await updateProtocolFee({
      protocolConfig: A.protocolConfig,
      authority,
      protocolFeeBps: 250,
      multisigSigners: [authority, multisigSignerA],
    });

    // Rust intentionally counts approvals only from remaining_accounts. The
    // second occurrence of authority is therefore required for this owner's
    // approval to count; Solana instruction account indices may repeat a key.
    expect(ix.accounts.map((account) => account.address)).toEqual([
      A.protocolConfig,
      authority.address,
      authority.address,
      multisigSignerA.address,
    ]);
    for (const [index, signer] of [authority, multisigSignerA].entries()) {
      const account = ix.accounts[2 + index];
      expect(account?.role).toBe(AccountRole.READONLY_SIGNER);
      expect(account).toHaveProperty("signer", signer);
    }
  });

  it("snapshots the approval array and signer identity before the async builder yields", async () => {
    const mutable = createMutableAddressSigner(multisigSignerA.address);
    const approvals: TransactionSigner[] = [mutable.signer, multisigSignerB];

    const instructionPromise = updateProtocolFee({
      protocolConfig: A.protocolConfig,
      authority,
      protocolFeeBps: 250,
      multisigSigners: approvals,
    });

    mutable.setLiveAddress(A.ownerB);
    approvals[0] = secondSigner;

    const ix = await instructionPromise;
    expect(ix.accounts.slice(-2).map((account) => account.address)).toEqual([
      multisigSignerA.address,
      multisigSignerB.address,
    ]);
    expect(ix.accounts.at(-2)).toMatchObject({
      role: AccountRole.READONLY_SIGNER,
      signer: mutable.signer,
    });
    expect(Object.isFrozen(mutable.signer)).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(mutable.signer, "address"),
    ).toMatchObject({
      configurable: false,
      writable: false,
      value: multisigSignerA.address,
    });
  });

  it("snapshots the proposed owner array before PDA derivation yields", async () => {
    const proposedOwners: Address[] = [A.ownerA, A.ownerB];
    const instructionPromise = updateMultisig({
      authority,
      newThreshold: 2,
      newOwners: proposedOwners,
      multisigSigners,
    });

    proposedOwners[0] = A.treasury;
    proposedOwners.push(A.recipient);

    const decoded = getUpdateMultisigInstructionDataDecoder().decode(
      (await instructionPromise).data,
    );
    expect(decoded.newThreshold).toBe(2);
    expect(decoded.newOwners).toEqual([A.ownerA, A.ownerB]);
  });
});

describe("governance facade — migrations", () => {
  it("migrateTask: program, account order, data round-trip", async () => {
    const ix = await migrateTask({
      protocolConfig: A.protocolConfig,
      task: A.task,
      payer,
      authority,
      dryRun: true,
      multisigSigners,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.protocolConfig,
      A.task,
      payer.address,
      authority.address,
      SYSTEM_PROGRAM,
      ...multisigSignerAddresses,
    ]);
    expectMultisigSignerSuffix(ix.accounts);

    const decoded = getMigrateTaskInstructionDataDecoder().decode(ix.data);
    expect(decoded.dryRun).toBe(true);
  });

  it("migrateProtocol: program, account order, data round-trip", () => {
    // P6.5: migrate_protocol now reallocs the ProtocolConfig (raw UncheckedAccount)
    // and funds the +2-byte growth, so its accounts are
    // [protocolConfig, payer, authority, systemProgram] and the builder is sync.
    const ix = migrateProtocol({
      protocolConfig: A.protocolConfig,
      payer,
      authority,
      targetVersion: 2,
      multisigSigners,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A.protocolConfig,
      payer.address,
      authority.address,
      SYSTEM_PROGRAM,
      ...multisigSignerAddresses,
    ]);
    expectMultisigSignerSuffix(ix.accounts);

    const decoded = getMigrateProtocolInstructionDataDecoder().decode(ix.data);
    expect(decoded.targetVersion).toBe(2);
  });
});
