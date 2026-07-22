import { describe, it, expect } from "vitest";
import {
  AccountRole,
  address,
  createNoopSigner,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  getConfigureTaskModerationInstruction,
  getConfigureTaskModerationInstructionDataDecoder,
  getRecordTaskModerationInstruction,
  getRecordTaskModerationInstructionDataDecoder,
  getRecordListingModerationInstruction,
  getRecordListingModerationInstructionDataDecoder,
  getAssignModerationAttestorInstructionDataDecoder,
  getRevokeModerationAttestorInstructionDataDecoder,
  getSetModerationBlockInstructionDataDecoder,
  getSetDefaultTrustListInstructionDataDecoder,
  findModerationAttestorPda,
  findModerationConfigPda,
  findModerationBlockPda,
  findDefaultTrustListPda,
  findProtocolConfigPda,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";
import {
  configureTaskModeration,
  recordTaskModeration,
  recordListingModeration,
  assignModerationAttestor,
  revokeModerationAttestor,
  registerModerationAttestor,
  requestAttestorExit,
  finalizeAttestorExit,
  setModerationBlock,
  clearModerationBlock,
  setDefaultTrustList,
} from "../src/facade/moderation.js";

// Structural tests (the facade-loop template): build each instruction and assert program
// address, account order, and that the encoded data round-trips through the matching
// decoder. Deterministic, no VM — validates the generated builder + facade wiring against
// the IDL. The sync builders take explicit accounts so we can assert exact ordering; the
// facade itself prefers the *Async builders (auto-derive the same PDAs).
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

function mutableSigner(initialAddress: Address): {
  signer: TransactionSigner;
  setAddress(nextAddress: Address): void;
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
    setAddress(nextAddress) {
      liveAddress = nextAddress;
    },
  };
}

describe("configureTaskModeration (generated instruction)", () => {
  const protocolConfig = address("So11111111111111111111111111111111111111112");
  const moderationConfig = address(
    "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
  );
  const authority = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );
  const moderationAuthority = address(
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  );

  it("assembles with the right program, account order, and round-trips its data", () => {
    const ix = getConfigureTaskModerationInstruction({
      protocolConfig,
      moderationConfig,
      authority,
      moderationAuthority,
      enabled: true,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      protocolConfig,
      moderationConfig,
      authority.address,
      SYSTEM_PROGRAM,
    ]);
    const decoded = getConfigureTaskModerationInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.moderationAuthority).toBe(moderationAuthority);
    expect(decoded.enabled).toBe(true);
  });
});

describe("recordTaskModeration (generated instruction)", () => {
  const moderationConfig = address(
    "So11111111111111111111111111111111111111112",
  );
  const task = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
  const taskModeration = address(
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  );
  const moderator = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("assembles with the right program, account order, and round-trips its data", () => {
    const jobSpecHash = new Uint8Array(32).fill(3);
    const policyHash = new Uint8Array(32).fill(5);
    const scannerHash = new Uint8Array(32).fill(9);
    const ix = getRecordTaskModerationInstruction({
      moderationConfig,
      task,
      taskModeration,
      moderator,
      jobSpecHash,
      status: 1,
      riskScore: 42,
      categoryMask: 6n,
      policyHash,
      scannerHash,
      expiresAt: 1700000000n,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      moderationConfig,
      task,
      // P1.2: `moderator` now precedes the record account (the v2 record PDA is
      // seeded by the moderator, so the account must be declared first on-chain).
      moderator.address,
      taskModeration,
      // P6.8: optional moderation-attestor roster account. Omitted here, so the
      // generated builder fills it with the program ID placeholder (codama's
      // optionalAccountStrategy: "programId").
      AGENC_COORDINATION_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM,
    ]);
    expect(ix.accounts[2]?.role).toBe(AccountRole.WRITABLE_SIGNER);
    expect(ix.accounts[2]?.signer).toBe(moderator);

    const decoded = getRecordTaskModerationInstructionDataDecoder().decode(
      ix.data,
    );
    expect(Array.from(decoded.jobSpecHash)).toEqual(Array.from(jobSpecHash));
    expect(decoded.status).toBe(1);
    expect(decoded.riskScore).toBe(42);
    expect(decoded.categoryMask).toBe(6n);
    expect(Array.from(decoded.policyHash)).toEqual(Array.from(policyHash));
    expect(Array.from(decoded.scannerHash)).toEqual(Array.from(scannerHash));
    expect(decoded.expiresAt).toBe(1700000000n);
  });
});

describe("recordListingModeration (generated instruction)", () => {
  const moderationConfig = address(
    "So11111111111111111111111111111111111111112",
  );
  const listing = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
  const listingModeration = address(
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  );
  const moderator = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("assembles with the right program, account order, and round-trips its data", () => {
    const jobSpecHash = new Uint8Array(32).fill(4);
    const policyHash = new Uint8Array(32).fill(7);
    const scannerHash = new Uint8Array(32).fill(11);
    const ix = getRecordListingModerationInstruction({
      moderationConfig,
      listing,
      listingModeration,
      moderator,
      jobSpecHash,
      status: 2,
      riskScore: 99,
      categoryMask: 12n,
      policyHash,
      scannerHash,
      expiresAt: 1800000000n,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      moderationConfig,
      listing,
      // P1.2: `moderator` now precedes the record account (v2 moderator-keyed seed).
      moderator.address,
      listingModeration,
      // P6.8: optional moderation-attestor roster account (omitted -> program ID
      // placeholder, codama's optionalAccountStrategy: "programId").
      AGENC_COORDINATION_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM,
    ]);

    const decoded = getRecordListingModerationInstructionDataDecoder().decode(
      ix.data,
    );
    expect(Array.from(decoded.jobSpecHash)).toEqual(Array.from(jobSpecHash));
    expect(decoded.status).toBe(2);
    expect(decoded.riskScore).toBe(99);
    expect(decoded.categoryMask).toBe(12n);
    expect(Array.from(decoded.policyHash)).toEqual(Array.from(policyHash));
    expect(Array.from(decoded.scannerHash)).toEqual(Array.from(scannerHash));
    expect(decoded.expiresAt).toBe(1800000000n);
  });
});

describe("moderation facade async transaction intent boundaries", () => {
  const originalSignerAddress = address(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  );
  const changedSignerAddress = address(
    "Stake11111111111111111111111111111111111111",
  );
  const subject = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");

  it("binds configure authority before hostile whole-input reflection", async () => {
    const authority = mutableSigner(originalSignerAddress);
    const target = {
      authority: authority.signer,
      moderationAuthority: changedSignerAddress,
      enabled: true,
    };
    const adversarialInput = new Proxy(target, {
      ownKeys(currentTarget) {
        authority.setAddress(changedSignerAddress);
        return Reflect.ownKeys(currentTarget);
      },
    });

    const ix = await configureTaskModeration(adversarialInput);
    expect(ix.accounts[2]).toMatchObject({
      address: originalSignerAddress,
      signer: authority.signer,
    });
  });

  it("detaches every task-moderation commitment before PDA derivation", async () => {
    const moderator = createNoopSigner(originalSignerAddress);
    const jobSpecHash = new Uint8Array(32).fill(31);
    const policyHash = new Uint8Array(32).fill(32);
    const scannerHash = new Uint8Array(32).fill(33);
    const pending = recordTaskModeration({
      task: subject,
      moderator,
      jobSpecHash,
      status: 1,
      riskScore: 10,
      categoryMask: 2n,
      policyHash,
      scannerHash,
      expiresAt: 1_800_000_000n,
    });
    jobSpecHash.fill(91);
    policyHash.fill(92);
    scannerHash.fill(93);

    const ix = await pending;
    const decoded = getRecordTaskModerationInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.jobSpecHash).toEqual(new Uint8Array(32).fill(31));
    expect(decoded.policyHash).toEqual(new Uint8Array(32).fill(32));
    expect(decoded.scannerHash).toEqual(new Uint8Array(32).fill(33));
    expect(ix.accounts[2]).toMatchObject({
      address: originalSignerAddress,
      signer: moderator,
    });
  });

  it("detaches every listing-moderation commitment before PDA derivation", async () => {
    const moderator = createNoopSigner(originalSignerAddress);
    const jobSpecHash = new Uint8Array(32).fill(41);
    const policyHash = new Uint8Array(32).fill(42);
    const scannerHash = new Uint8Array(32).fill(43);
    const pending = recordListingModeration({
      listing: subject,
      moderator,
      jobSpecHash,
      status: 2,
      riskScore: 20,
      categoryMask: 4n,
      policyHash,
      scannerHash,
      expiresAt: 1_900_000_000n,
    });
    jobSpecHash.fill(94);
    policyHash.fill(95);
    scannerHash.fill(96);

    const decoded = getRecordListingModerationInstructionDataDecoder().decode(
      (await pending).data,
    );
    expect(decoded.jobSpecHash).toEqual(new Uint8Array(32).fill(41));
    expect(decoded.policyHash).toEqual(new Uint8Array(32).fill(42));
    expect(decoded.scannerHash).toEqual(new Uint8Array(32).fill(43));
  });

  it("builds authority-managed roster assign/revoke with Rust account order", async () => {
    const authority = createNoopSigner(originalSignerAddress);
    const attestor = changedSignerAddress;
    const [moderationConfig] = await findModerationConfigPda();
    const [roster] = await findModerationAttestorPda({ attestor });

    const assign = await assignModerationAttestor({ authority, attestor });
    expect(assign.accounts.map((account) => account.address)).toEqual([
      moderationConfig,
      roster,
      originalSignerAddress,
      SYSTEM_PROGRAM,
    ]);
    expect(
      getAssignModerationAttestorInstructionDataDecoder().decode(assign.data)
        .attestor,
    ).toBe(attestor);

    const revoke = await revokeModerationAttestor({ authority, attestor });
    expect(revoke.accounts.map((account) => account.address)).toEqual([
      moderationConfig,
      roster,
      originalSignerAddress,
    ]);
    expect(
      getRevokeModerationAttestorInstructionDataDecoder().decode(revoke.data)
        .discriminator,
    ).toHaveLength(8);
  });

  it("locks each open-roster lifecycle signer before its derivation await", async () => {
    const cases = [
      {
        build: registerModerationAttestor,
        signerAccountIndex: 1,
      },
      { build: requestAttestorExit, signerAccountIndex: 1 },
      { build: finalizeAttestorExit, signerAccountIndex: 1 },
    ] as const;

    for (const testCase of cases) {
      const attestor = mutableSigner(originalSignerAddress);
      const pending = testCase.build({ attestor: attestor.signer });
      attestor.setAddress(changedSignerAddress);
      const ix = await pending;
      expect(ix.accounts[testCase.signerAccountIndex]).toMatchObject({
        address: originalSignerAddress,
        signer: attestor.signer,
      });
    }
  });

  it("rejects malformed moderation commitments synchronously", async () => {
    await expect(
      recordTaskModeration({
        task: subject,
        moderator: createNoopSigner(originalSignerAddress),
        jobSpecHash: new Uint8Array(31),
        status: 1,
        riskScore: 1,
        categoryMask: 0n,
        policyHash: new Uint8Array(32),
        scannerHash: new Uint8Array(32),
        expiresAt: 0n,
      }),
    ).rejects.toThrow(/exactly 32 bytes/u);
  });
});

// ---------------------------------------------------------------------------
// P1.2 hardened open roster — structural pins for the NEW instructions
// (account counts + arg lists), same facade-loop template as above.
// ---------------------------------------------------------------------------

describe("registerModerationAttestor (P1.2, facade)", () => {
  const attestor = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("assembles the roster, signer, protocol config, and system program", async () => {
    const ix = await registerModerationAttestor({ attestor });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [expectedRoster] = await findModerationAttestorPda({
      attestor: attestor.address,
    });
    const [protocolConfig] = await findProtocolConfigPda();
    expect(ix.accounts.map((a) => a.address)).toEqual([
      expectedRoster,
      attestor.address,
      protocolConfig,
      SYSTEM_PROGRAM,
    ]);
    // No args: the data is exactly the 8-byte discriminator.
    expect(ix.data.length).toBe(8);
  });
});

describe("requestAttestorExit / finalizeAttestorExit (P1.2, facade)", () => {
  const attestor = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("requestAttestorExit assembles 2 accounts (roster PDA derived from the attestor signer) with no args", async () => {
    const ix = await requestAttestorExit({ attestor });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [expectedRoster] = await findModerationAttestorPda({
      attestor: attestor.address,
    });
    expect(ix.accounts.map((a) => a.address)).toEqual([
      expectedRoster,
      attestor.address,
    ]);
    expect(ix.data.length).toBe(8); // no args
  });

  it("finalizeAttestorExit assembles 2 accounts (roster PDA derived from the attestor signer) with no args", async () => {
    const ix = await finalizeAttestorExit({ attestor });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [expectedRoster] = await findModerationAttestorPda({
      attestor: attestor.address,
    });
    expect(ix.accounts.map((a) => a.address)).toEqual([
      expectedRoster,
      attestor.address,
    ]);
    expect(ix.data.length).toBe(8); // no args
  });
});

describe("setModerationBlock / clearModerationBlock (P1.2 BLOCK floor, facade)", () => {
  const authority = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );
  const coSigner = createNoopSigner(
    address("SysvarC1ock11111111111111111111111111111111"),
  );
  const multisigSigners = [authority, coSigner] as const;
  const contentHash = new Uint8Array(32).fill(21);
  const rationaleHash = new Uint8Array(32).fill(22);

  it("setModerationBlock assembles 6 accounts including approvals and round-trips its data", async () => {
    const ix = await setModerationBlock({
      authority,
      multisigSigners,
      contentHash,
      rationaleHash,
      rationaleUri: "ipfs://takedown-rationale",
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [expectedConfig] = await findProtocolConfigPda();
    const [expectedBlock] = await findModerationBlockPda({ contentHash });
    expect(ix.accounts.map((a) => a.address)).toEqual([
      expectedConfig,
      expectedBlock,
      authority.address,
      SYSTEM_PROGRAM,
      authority.address,
      coSigner.address,
    ]);
    expect(ix.accounts.slice(-2).map((account) => account.role)).toEqual([
      AccountRole.READONLY_SIGNER,
      AccountRole.READONLY_SIGNER,
    ]);

    const decoded = getSetModerationBlockInstructionDataDecoder().decode(
      ix.data,
    );
    expect(Array.from(decoded.contentHash)).toEqual(Array.from(contentHash));
    expect(Array.from(decoded.rationaleHash)).toEqual(
      Array.from(rationaleHash),
    );
    expect(decoded.rationaleUri).toBe("ipfs://takedown-rationale");
  });

  it("clearModerationBlock assembles 5 accounts including approvals with no args", async () => {
    const ix = await clearModerationBlock({
      authority,
      multisigSigners,
      contentHash,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [expectedConfig] = await findProtocolConfigPda();
    const [expectedBlock] = await findModerationBlockPda({ contentHash });
    expect(ix.accounts.map((a) => a.address)).toEqual([
      expectedConfig,
      expectedBlock,
      authority.address,
      authority.address,
      coSigner.address,
    ]);
    expect(ix.accounts.slice(-2).map((account) => account.role)).toEqual([
      AccountRole.READONLY_SIGNER,
      AccountRole.READONLY_SIGNER,
    ]);
    expect(ix.data.length).toBe(8); // no args
  });

  it("clearModerationBlock throws without contentHash or moderationBlock", async () => {
    await expect(
      clearModerationBlock({ authority, multisigSigners }),
    ).rejects.toThrow(/contentHash|moderationBlock/);
  });

  it("rejects duplicate block-floor multisig approvals", async () => {
    await expect(
      setModerationBlock({
        authority,
        multisigSigners: [authority, authority],
        contentHash,
        rationaleHash,
        rationaleUri: "ipfs://takedown-rationale",
      }),
    ).rejects.toThrow(/duplicate signer address/u);

    await expect(
      clearModerationBlock({
        authority,
        multisigSigners: [authority, authority],
        contentHash,
      }),
    ).rejects.toThrow(/duplicate signer address/u);
  });

  it("detaches block hashes before default PDA derivation yields", async () => {
    const mutableContentHash = new Uint8Array(32).fill(31);
    const mutableRationaleHash = new Uint8Array(32).fill(32);
    const instructionPromise = setModerationBlock({
      authority,
      multisigSigners,
      contentHash: mutableContentHash,
      rationaleHash: mutableRationaleHash,
      rationaleUri: "ipfs://stable-rationale",
    });

    mutableContentHash.fill(91);
    mutableRationaleHash.fill(92);

    const ix = await instructionPromise;
    const decoded = getSetModerationBlockInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.contentHash).toEqual(new Uint8Array(32).fill(31));
    expect(decoded.rationaleHash).toEqual(new Uint8Array(32).fill(32));
    const [expectedBlock] = await findModerationBlockPda({
      contentHash: new Uint8Array(32).fill(31),
    });
    expect(ix.accounts[1]?.address).toBe(expectedBlock);
  });
});

describe("setDefaultTrustList (P1.2, facade)", () => {
  const authority = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );
  const coSigner = createNoopSigner(
    address("SysvarC1ock11111111111111111111111111111111"),
  );

  it("assembles 6 trust-list accounts including approvals and round-trips its data", async () => {
    const listHash = new Uint8Array(32).fill(23);
    const ix = await setDefaultTrustList({
      authority,
      multisigSigners: [authority, coSigner],
      listHash,
      listUri: "ipfs://default-trust-list",
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [expectedConfig] = await findProtocolConfigPda();
    const [expectedList] = await findDefaultTrustListPda();
    expect(ix.accounts.map((a) => a.address)).toEqual([
      expectedConfig,
      expectedList,
      authority.address,
      SYSTEM_PROGRAM,
      authority.address,
      coSigner.address,
    ]);
    expect(ix.accounts.slice(-2).map((account) => account.role)).toEqual([
      AccountRole.READONLY_SIGNER,
      AccountRole.READONLY_SIGNER,
    ]);

    const decoded = getSetDefaultTrustListInstructionDataDecoder().decode(
      ix.data,
    );
    expect(Array.from(decoded.listHash)).toEqual(Array.from(listHash));
    expect(decoded.listUri).toBe("ipfs://default-trust-list");
  });

  it("rejects duplicate trust-list multisig approvals", async () => {
    await expect(
      setDefaultTrustList({
        authority,
        multisigSigners: [authority, authority],
        listHash: new Uint8Array(32).fill(23),
        listUri: "ipfs://default-trust-list",
      }),
    ).rejects.toThrow(/duplicate signer address/u);
  });

  it("detaches the trust-list hash before default PDA derivation yields", async () => {
    const listHash = new Uint8Array(32).fill(41);
    const instructionPromise = setDefaultTrustList({
      authority,
      multisigSigners: [authority, coSigner],
      listHash,
      listUri: "ipfs://stable-default-list",
    });

    listHash.fill(99);

    const ix = await instructionPromise;
    expect(
      getSetDefaultTrustListInstructionDataDecoder().decode(ix.data).listHash,
    ).toEqual(new Uint8Array(32).fill(41));
  });
});
