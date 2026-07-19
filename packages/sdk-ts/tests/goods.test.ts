import { describe, expect, it } from "vitest";
import { address, createNoopSigner } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  getPurchaseGoodInstructionDataDecoder,
} from "../src/index.js";
import { purchaseGood } from "../src/facade/goods.js";

describe("purchaseGood facade", () => {
  it("appends the reviewed metadata hash to the serial/price CAS", async () => {
    const good = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
    const sellerAgent = address("So11111111111111111111111111111111111111112");
    const sellerWallet = address("Vote111111111111111111111111111111111111111");
    const treasury = address("SysvarRent111111111111111111111111111111111");
    const moderationBlock = address(
      "ComputeBudget111111111111111111111111111111",
    );
    const authority = createNoopSigner(
      address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    );
    const expectedMetadataHash = new Uint8Array(32).fill(19);

    const ix = await purchaseGood({
      good,
      sellerAgent,
      sellerWallet,
      treasury,
      moderationBlock,
      authority,
      expectedSerial: 3n,
      expectedPrice: 25_000n,
      expectedMetadataHash,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts[0]?.address).toBe(good);
    expect(ix.accounts[2]?.address).toBe(sellerAgent);
    expect(ix.accounts[3]?.address).toBe(sellerWallet);
    expect(ix.accounts[5]?.address).toBe(treasury);
    expect(ix.accounts[6]?.address).toBe(moderationBlock);
    expect(ix.accounts[7]?.address).toBe(authority.address);
    const decoded = getPurchaseGoodInstructionDataDecoder().decode(ix.data);
    expect(decoded.expectedSerial).toBe(3n);
    expect(decoded.expectedPrice).toBe(25_000n);
    expect(Array.from(ix.data.slice(-32))).toEqual(
      Array.from(expectedMetadataHash),
    );
  });
});
