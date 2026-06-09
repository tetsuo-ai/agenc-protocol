import { describe, it, expect } from "vitest";
import { address, createNoopSigner } from "@solana/kit";
import {
  getConfigureTaskModerationInstruction,
  getConfigureTaskModerationInstructionDataDecoder,
  getRecordTaskModerationInstruction,
  getRecordTaskModerationInstructionDataDecoder,
  getRecordListingModerationInstruction,
  getRecordListingModerationInstructionDataDecoder,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";

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
      taskModeration,
      moderator.address,
      SYSTEM_PROGRAM,
    ]);

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
      listingModeration,
      moderator.address,
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
