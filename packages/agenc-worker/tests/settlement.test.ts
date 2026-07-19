import { getBase58Decoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";

import {
  AGENC_PROGRAM_ID,
  findVerifiedSettlementSignature,
  isVerifiedSettlementTransaction,
} from "../src/settlement.js";

const TASK = "11111111111111111111111111111111" as Address;
const OTHER = "SysvarRent111111111111111111111111111111111" as Address;
const SIGNATURE = "signature-settlement";
const discriminator = getBase58Decoder().decode(
  new Uint8Array([109, 167, 192, 41, 129, 108, 220, 196]),
);

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    meta: { err: null },
    transaction: {
      signatures: [SIGNATURE],
      message: {
        accountKeys: [TASK, AGENC_PROGRAM_ID],
        instructions: [{ programId: AGENC_PROGRAM_ID, accounts: [TASK], data: discriminator }],
      },
    },
    ...overrides,
  };
}

describe("verified settlement receipt attribution", () => {
  it("accepts only a successful AgenC terminal instruction for the exact task", () => {
    expect(isVerifiedSettlementTransaction(transaction(), { task: TASK, signature: SIGNATURE })).toBe(true);
    expect(isVerifiedSettlementTransaction(transaction(), { task: OTHER, signature: SIGNATURE })).toBe(false);
    expect(isVerifiedSettlementTransaction(transaction(), { task: TASK, signature: "different" })).toBe(false);
    expect(isVerifiedSettlementTransaction(transaction({ meta: { err: {} } }), { task: TASK, signature: SIGNATURE })).toBe(false);
    const spam = transaction();
    spam.transaction.message.instructions[0]!.programId = OTHER;
    expect(isVerifiedSettlementTransaction(spam, { task: TASK, signature: SIGNATURE })).toBe(false);
  });

  it("skips spam/newer failed transactions and returns the bounded finalized settlement", async () => {
    const calls: string[] = [];
    const rpc = {
      getSignaturesForAddress: (_task: Address, config: unknown) => ({
        send: async () => {
          expect(config).toEqual({ limit: 20, commitment: "finalized" });
          return [
            { signature: "spam", err: null, confirmationStatus: "finalized" },
            { signature: "failed", err: {}, confirmationStatus: "finalized" },
            { signature: SIGNATURE, err: null, confirmationStatus: "finalized" },
          ];
        },
      }),
      getTransaction: (signature: string, config: unknown) => ({
        send: async () => {
          calls.push(signature);
          expect(config).toEqual({
            commitment: "finalized",
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
          });
          if (signature === "spam") {
            const spam = transaction();
            spam.transaction.signatures = ["spam"];
            spam.transaction.message.instructions[0]!.programId = OTHER;
            return spam;
          }
          return transaction();
        },
      }),
    };
    await expect(findVerifiedSettlementSignature(rpc, TASK)).resolves.toBe(SIGNATURE);
    expect(calls).toEqual(["spam", SIGNATURE]);
  });

  it("returns null when no finalized terminal transaction can be proven", async () => {
    const rpc = {
      getSignaturesForAddress: () => ({
        send: async () => [{ signature: "processed", err: null, confirmationStatus: "processed" }],
      }),
      getTransaction: () => ({ send: async () => null }),
    };
    await expect(findVerifiedSettlementSignature(rpc, TASK)).resolves.toBeNull();
    await expect(findVerifiedSettlementSignature(rpc, TASK, 0)).rejects.toThrow(/1\.\.100/);
  });
});
