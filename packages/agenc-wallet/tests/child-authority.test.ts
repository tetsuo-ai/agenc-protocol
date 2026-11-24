import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { readChildEvidence } from "../src/child-hire.js";
import * as shares from "../src/child-share.js";
import type { JobRecord } from "../src/store.js";

describe("supplier authority", () => {
  it("requires the original buyer's signature for the exact order, supplier, files, brief and outputs", async () => {
    const buyer = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const binding = {
      parentTask: other.address,
      supplier: other.address,
      request: {
        listing: other.address,
        brief: "Summarize",
        outputs: ["text"],
        privateCommitment: "ab".repeat(32),
      },
    };
    const approved = await shares.signChildShare(buyer, binding);
    await shares.verifyChildShare(buyer.address, binding, approved);
    for (const changed of [
      { parentTask: buyer.address },
      { supplier: buyer.address },
      ...[
        { privateCommitment: "ab".repeat(31) + "cd" },
        { brief: "Publish" },
        { outputs: ["x.txt"] },
        { listing: buyer.address },
      ].map((fields) => ({ request: { ...binding.request, ...fields } })),
    ]) {
      await expect(
        shares.verifyChildShare(buyer.address, { ...binding, ...changed }, approved),
      ).rejects.toThrow();
    }
    await expect(shares.verifyChildShare(other.address, binding, approved)).rejects.toThrow();
    await expect(shares.verifyChildShare(buyer.address, binding, "ab".repeat(32))).rejects.toThrow();
  });
  it("reads one room-import snapshot without opening the payer's inspection API", async () => {
    const result = { round: 1, deliveryHash: "a".repeat(64), files: [], text: "complete" };
    const reader = {
      readRoomImportEvidence: vi.fn(async () => result),
      readDeliveryChunk: vi.fn(),
      requireDeliveryInspection: vi.fn(),
    };
    const job = { id: "j", agentId: "a", task: "child" } as JobRecord;
    const grant = { parentTask: "parent", roomId: "room", claimedAt: "123", sellerAgentId: "a" };
    expect(await readChildEvidence(reader, job, ["text"], grant)).toEqual(result);
    expect(reader.readRoomImportEvidence).toHaveBeenCalledWith("j", { kind: "room-import", ...grant }, [
      "text",
    ]);
    expect(reader.readDeliveryChunk).not.toHaveBeenCalled();
    expect(reader.requireDeliveryInspection).not.toHaveBeenCalled();
  });
});
