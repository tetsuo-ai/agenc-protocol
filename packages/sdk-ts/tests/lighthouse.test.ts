import { describe, expect, it } from "vitest";
import { AccountRole, address, compileTransactionMessage, createTransactionMessage, appendTransactionMessageInstructions, setTransactionMessageFeePayer } from "@solana/kit";
import * as lighthouse from "../src/lighthouse.js";

const target = address("So11111111111111111111111111111111111111112");
const clock = address("SysvarC1ock11111111111111111111111111111111");
const payer = address("Vote111111111111111111111111111111111111111");

describe("Lighthouse assertion accounts", () => {
  it("declares only the inspected account, read-only and without a signer", () => {
    const builders = {
      assertClockBefore: [lighthouse.assertClockBefore(1), clock],
      assertClockAtLeast: [lighthouse.assertClockAtLeast(1), clock],
      assertLamports: [lighthouse.assertLamports(target, 1n), target],
      assertLamportsAtLeast: [lighthouse.assertLamportsAtLeast(target, 1n), target],
      assertDataHash: [lighthouse.assertDataHash(target, new Uint8Array(32), 0), target],
      assertBytes: [lighthouse.assertBytes(target, 0, new Uint8Array([1])), target],
    } as const;
    // New builders must join the privilege test.
    expect(Object.keys(builders).sort()).toEqual(Object.keys(lighthouse).filter(k => k.startsWith("assert")).sort());
    for (const [ix, key] of Object.values(builders)) {
      expect(ix.programAddress).toBe(lighthouse.LIGHTHOUSE);
      expect(ix.accounts).toEqual([{ address: key, role: AccountRole.READONLY }]);
    }
  });

  it("passes no signer or fee payer even when a sibling writes the target", () => {
    const guard = lighthouse.assertBytes(target, 0, new Uint8Array([1]));
    const sibling = { programAddress: address("11111111111111111111111111111111"),
      accounts: [{ address: target, role: AccountRole.WRITABLE }] };
    const message = compileTransactionMessage(appendTransactionMessageInstructions([guard, sibling],
      setTransactionMessageFeePayer(payer, createTransactionMessage({ version: 0 }))));
    const indices = message.instructions[0]!.accountIndices!;
    expect(indices).toHaveLength(1);
    expect(message.staticAccounts[indices[0]!]).toBe(target);
    expect(indices[0]!).toBeGreaterThanOrEqual(message.header.numSignerAccounts);
    expect(message.staticAccounts[indices[0]!]).not.toBe(payer);
  });
});
