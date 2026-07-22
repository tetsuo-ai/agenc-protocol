import { describe, expect, it } from "vitest";
import { address, none, some } from "@solana/kit";

import {
  findTaskPda,
  getCompleteTaskInstructionDataEncoder,
  getHireFromListingHumanlessInstructionDataEncoder,
  getHireFromListingInstructionDataEncoder,
  getPostToFeedInstructionDataEncoder,
  getSetTaskJobSpecInstructionDataEncoder,
} from "../src/generated/index.js";
import { getFixedBytesEncoder } from "../src/generated/codecs/fixedBytes.js";

const moderator = address("11111111111111111111111111111111");
const taskId = new Uint8Array(32).fill(1);

const encoders = [
  {
    encode(hash: Uint8Array) {
      return getHireFromListingInstructionDataEncoder().encode({
        expectedPrice: 1n,
        expectedVersion: 1n,
        moderator,
        referrer: none(),
        referrerFeeBps: 0,
        taskId,
        taskJobSpecHash: hash,
      });
    },
    name: "hireFromListing.taskJobSpecHash",
  },
  {
    encode(hash: Uint8Array) {
      return getHireFromListingHumanlessInstructionDataEncoder().encode({
        expectedPrice: 1n,
        expectedVersion: 1n,
        moderator,
        referrer: none(),
        referrerFeeBps: 0,
        reviewWindowSecs: 60n,
        taskId,
        taskJobSpecHash: hash,
      });
    },
    name: "hireFromListingHumanless.taskJobSpecHash",
  },
  {
    encode(hash: Uint8Array) {
      return getSetTaskJobSpecInstructionDataEncoder().encode({
        jobSpecHash: hash,
        jobSpecUri: "ipfs://reviewed-job-spec",
        moderator,
      });
    },
    name: "setTaskJobSpec.jobSpecHash",
  },
];

describe("generated revision-5 commitment encoders", () => {
  for (const encoder of encoders) {
    it(`${encoder.name} accepts only exact nonzero 32-byte input`, () => {
      expect(() => encoder.encode(new Uint8Array(32).fill(7))).not.toThrow();
      expect(() => encoder.encode(new Uint8Array(31).fill(7))).toThrow(
        /exactly 32 bytes/,
      );
      expect(() => encoder.encode(new Uint8Array(33).fill(7))).toThrow(
        /exactly 32 bytes/,
      );
      expect(() => encoder.encode(new Uint8Array(32))).toThrow(/all zeroes/);
    });
  }
});

describe("all generated fixed-byte encoders", () => {
  it("rejects padding/truncation through a public legacy instruction encoder", () => {
    const encode = (contentHash: Uint8Array) =>
      getPostToFeedInstructionDataEncoder().encode({
        contentHash,
        nonce: new Uint8Array(32).fill(2),
        parentPost: none(),
        topic: new Uint8Array(32).fill(3),
      });
    expect(() => encode(new Uint8Array(32).fill(1))).not.toThrow();
    expect(() => encode(new Uint8Array(31).fill(1))).toThrow(
      /contentHash must be exactly 32 bytes/,
    );
    expect(() => encode(new Uint8Array(33).fill(1))).toThrow(
      /contentHash must be exactly 32 bytes/,
    );
  });

  it("enforces arbitrary IDL array sizes without imposing commitment semantics", () => {
    const encoder = getFixedBytesEncoder(64, "payload");
    expect(() => encoder.encode(new Uint8Array(64))).not.toThrow();
    expect(() => encoder.encode(new Uint8Array(63))).toThrow(
      /payload must be exactly 64 bytes/,
    );
    expect(() => encoder.encode(new Uint8Array(65))).toThrow(
      /payload must be exactly 64 bytes/,
    );
  });

  it("rejects padding/truncation for a fixed array nested inside Option", () => {
    const encode = (resultData: Uint8Array) =>
      getCompleteTaskInstructionDataEncoder().encode({
        proofHash: new Uint8Array(32).fill(1),
        resultData: some(resultData),
      });
    expect(() => encode(new Uint8Array(64).fill(2))).not.toThrow();
    expect(() => encode(new Uint8Array(63).fill(2))).toThrow(
      /exactly 64 bytes/,
    );
    expect(() => encode(new Uint8Array(65).fill(2))).toThrow(
      /exactly 64 bytes/,
    );
  });

  it("rejects padding/truncation in a caller-supplied PDA seed", async () => {
    await expect(
      findTaskPda({ creator: moderator, taskId: new Uint8Array(32).fill(1) }),
    ).resolves.toBeDefined();
    await expect(
      findTaskPda({ creator: moderator, taskId: new Uint8Array(31).fill(1) }),
    ).rejects.toThrow(/exactly 32 bytes/);
    await expect(
      findTaskPda({ creator: moderator, taskId: new Uint8Array(33).fill(1) }),
    ).rejects.toThrow(/exactly 32 bytes/);
  });
});
