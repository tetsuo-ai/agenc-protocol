import { describe, it, expect } from "vitest";
import { AccountRole, address, createNoopSigner } from "@solana/kit";
import {
  getPostCompletionBondInstructionDataDecoder,
  getReclaimCompletionBondInstructionDataDecoder,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findClaimPda,
  findProtocolConfigPda,
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
const worker = address("Vote111111111111111111111111111111111111111");

describe("postCompletionBond (facade)", () => {
  const authority = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("assembles creator role with readonly task/config and None worker placeholders", async () => {
    const ix = await postCompletionBond({ task, authority, role: 0 });

    // PDA auto-derived from (task, signing authority).
    const [bond] = await findCompletionBondPda({
      task,
      party: authority.address,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [protocolConfig] = await findProtocolConfigPda();
    expect(ix.accounts.map((a) => a.address)).toEqual([
      task,
      protocolConfig,
      bond,
      AGENC_COORDINATION_PROGRAM_ADDRESS,
      AGENC_COORDINATION_PROGRAM_ADDRESS,
      authority.address,
      SYSTEM_PROGRAM,
    ]);
    expect(ix.accounts.map((a) => a.role)).toEqual([
      AccountRole.READONLY,
      AccountRole.READONLY,
      AccountRole.WRITABLE,
      AccountRole.READONLY,
      AccountRole.READONLY,
      AccountRole.WRITABLE_SIGNER,
      AccountRole.READONLY,
    ]);

    const decoded = getPostCompletionBondInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.role).toBe(0);
  });

  it("requires a worker identity and derives its canonical claim for worker role", async () => {
    const ix = await postCompletionBond({
      task,
      authority,
      role: 1,
      worker,
    });
    const [claim] = await findClaimPda({ task, bidder: worker });
    expect(ix.accounts[3]?.address).toBe(worker);
    expect(ix.accounts[4]?.address).toBe(claim);
    expect(ix.accounts[3]?.role).toBe(AccountRole.READONLY);
    expect(ix.accounts[4]?.role).toBe(AccountRole.READONLY);
  });

  it("appends canonical dependency evidence after the typed account surface", async () => {
    const parentTask = party;
    const ix = await postCompletionBond({
      task,
      authority,
      role: 0,
      dependencyParent: parentTask,
    });
    expect(ix.accounts.at(-1)).toEqual({
      address: parentTask,
      role: AccountRole.READONLY,
    });
  });

  it("fails before construction on role/account mismatches", async () => {
    await expect(
      postCompletionBond({ task, authority, role: 1 } as never),
    ).rejects.toThrow(/worker role requires/);
    await expect(
      postCompletionBond({ task, authority, role: 0, worker } as never),
    ).rejects.toThrow(/creator role must omit/);
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
