import { describe, it, expect } from "vitest";
import { address, createNoopSigner } from "@solana/kit";
import {
  getPostCompletionBondInstructionDataDecoder,
  getReclaimCompletionBondInstructionDataDecoder,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";
import {
  postCompletionBond,
  reclaimCompletionBond,
  findCompletionBondPda,
} from "../src/facade/bonds.js";

// Structural tests: build the facade instruction (async builders auto-derive the bond PDA)
// and assert program address, account order, and that the encoded data round-trips through
// the matching generated decoder. Deterministic, no VM.
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const task = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const party = address("So11111111111111111111111111111111111111112");

describe("postCompletionBond (facade)", () => {
  const authority = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("assembles with the right program, account order, and round-trips its data", async () => {
    const ix = await postCompletionBond({ task, authority, role: 1 });

    // PDA auto-derived from (task, signing authority).
    const [bond] = await findCompletionBondPda({
      task,
      party: authority.address,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      task,
      bond,
      authority.address,
      SYSTEM_PROGRAM,
    ]);

    const decoded = getPostCompletionBondInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.role).toBe(1);
  });
});

describe("reclaimCompletionBond (facade)", () => {
  it("assembles with the right program, account order, and round-trips its data", async () => {
    const ix = await reclaimCompletionBond({ task, party, role: 0 });

    // The completion-bond PDA is derived from (task, party).
    const [bond] = await findCompletionBondPda({
      task,
      party,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      task,
      bond,
      party,
      SYSTEM_PROGRAM,
    ]);

    const decoded = getReclaimCompletionBondInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.role).toBe(0);
  });
});
