import { describe, it, expect } from "vitest";
import { AccountRole, address, createNoopSigner } from "@solana/kit";
import {
  getConfigureTaskModerationInstruction,
  getConfigureTaskModerationInstructionDataDecoder,
  getRecordTaskModerationInstruction,
  getRecordTaskModerationInstructionDataDecoder,
  getRecordListingModerationInstruction,
  getRecordListingModerationInstructionDataDecoder,
  getSetModerationBlockInstructionDataDecoder,
  getSetDefaultTrustListInstructionDataDecoder,
  findModerationAttestorPda,
  findModerationBlockPda,
  findDefaultTrustListPda,
  findProtocolConfigPda,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";
import {
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
  const contentHash = new Uint8Array(32).fill(21);
  const rationaleHash = new Uint8Array(32).fill(22);

  it("setModerationBlock assembles 4 accounts (block PDA derived from contentHash) and round-trips its data", async () => {
    const ix = await setModerationBlock({
      authority,
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
    ]);

    const decoded = getSetModerationBlockInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.contentHash)).toEqual(Array.from(contentHash));
    expect(Array.from(decoded.rationaleHash)).toEqual(Array.from(rationaleHash));
    expect(decoded.rationaleUri).toBe("ipfs://takedown-rationale");
  });

  it("clearModerationBlock assembles 3 accounts (block PDA derived from contentHash) with no args", async () => {
    const ix = await clearModerationBlock({ authority, contentHash });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [expectedConfig] = await findProtocolConfigPda();
    const [expectedBlock] = await findModerationBlockPda({ contentHash });
    expect(ix.accounts.map((a) => a.address)).toEqual([
      expectedConfig,
      expectedBlock,
      authority.address,
    ]);
    expect(ix.data.length).toBe(8); // no args
  });

  it("clearModerationBlock throws without contentHash or moderationBlock", async () => {
    await expect(clearModerationBlock({ authority })).rejects.toThrow(
      /contentHash|moderationBlock/,
    );
  });
});

describe("setDefaultTrustList (P1.2, facade)", () => {
  const authority = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("assembles 4 accounts (singleton trust-list PDA auto-derived) and round-trips its data", async () => {
    const listHash = new Uint8Array(32).fill(23);
    const ix = await setDefaultTrustList({
      authority,
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
    ]);

    const decoded = getSetDefaultTrustListInstructionDataDecoder().decode(
      ix.data,
    );
    expect(Array.from(decoded.listHash)).toEqual(Array.from(listHash));
    expect(decoded.listUri).toBe("ipfs://default-trust-list");
  });
});
