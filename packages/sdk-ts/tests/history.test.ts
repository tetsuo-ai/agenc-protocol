import { address, type ReadonlyUint8Array } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  HIRE_FROM_LISTING_DISCRIMINATOR,
  HIRE_FROM_LISTING_HUMANLESS_DISCRIMINATOR,
  SET_TASK_JOB_SPEC_DISCRIMINATOR,
  getHireFromListingHumanlessInstructionDataEncoder,
  getHireFromListingInstructionDataEncoder,
  getSetTaskJobSpecInstructionDataEncoder,
  history,
} from "../src/index.js";
import revision4Dispatcher from "./fixtures/revision4-dispatcher-baseline.json";

function bytesFromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(hex)) {
    throw new TypeError("invalid test hex");
  }
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

// Frozen byte-for-byte vectors from the deployed revision-4 Borsh ABI. These
// are literals rather than output from the decoder's own codec so schema drift
// cannot make both the fixture and implementation change together.
const REVISION_4_HIRE_FROM_LISTING = bytesFromHex(
  "aee15144ac1361c2" +
    "11".repeat(32) +
    "0100000000000000" +
    "0200000000000000" +
    "00" +
    "1900" +
    "00".repeat(32),
);

const REVISION_4_HIRE_FROM_LISTING_HUMANLESS = bytesFromHex(
  "5a8e27e196a1d931" +
    "22".repeat(32) +
    "0300000000000000" +
    "0400000000000000" +
    "100e000000000000" +
    "01" +
    "01".repeat(32) +
    "3200" +
    "00".repeat(32),
);

const REVISION_4_SET_TASK_JOB_SPEC = bytesFromHex(
  "866666561fa4cac1" +
    "33".repeat(32) +
    "09000000" +
    "697066733a2f2fc3a9" + // UTF-8: ipfs://é
    "00".repeat(32),
);

const ZERO_ADDRESS = address("11111111111111111111111111111111");
const ONE_BYTE_ADDRESS = address("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi");

function discriminatorHex(bytes: ReadonlyUint8Array): string {
  return Array.from(bytes.subarray(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("frozen marketplace write history decoder", () => {
  it("pins the complete revision-4 IDL dispatcher and excludes every revision-5 discriminator", () => {
    // This is the full discriminator table extracted from the canonical
    // 99-instruction IDL at the verified revision-4 source commit. Keeping the
    // complete table proves that a v2 value did not collide with some unrelated
    // legacy entry; the source IDL hash makes the snapshot independently
    // reproducible. It is deterministic dispatcher evidence, not a substitute
    // for executing the separately verified deployed revision-4 binary.
    expect(revision4Dispatcher.sourceCommit).toBe("097ded1");
    expect(revision4Dispatcher.sourceIdlSha256).toBe(
      "f558e0dc2932bc3ea02d7a32f2b0a2334feb1e30b17d7efe2441dcd8d97e6ca2",
    );
    const revision4Entries = Object.entries(
      revision4Dispatcher.instructionDiscriminators,
    );
    const revision4Values = revision4Entries.map(([, value]) => value);
    expect(revision4Entries).toHaveLength(revision4Dispatcher.instructionCount);
    expect(revision4Entries).toHaveLength(99);
    expect(new Set(revision4Values).size).toBe(99);

    expect(revision4Dispatcher.instructionDiscriminators).toMatchObject({
      hire_from_listing: discriminatorHex(REVISION_4_HIRE_FROM_LISTING),
      hire_from_listing_humanless: discriminatorHex(
        REVISION_4_HIRE_FROM_LISTING_HUMANLESS,
      ),
      set_task_job_spec: discriminatorHex(REVISION_4_SET_TASK_JOB_SPEC),
    });

    const revision5Values = [
      discriminatorHex(HIRE_FROM_LISTING_DISCRIMINATOR),
      discriminatorHex(HIRE_FROM_LISTING_HUMANLESS_DISCRIMINATOR),
      discriminatorHex(SET_TASK_JOB_SPEC_DISCRIMINATOR),
    ];
    expect(revision5Values).toEqual([
      "f15e7f0768aef074",
      "e5a3ab722674d755",
      "7609633ad7573a3b",
    ]);
    for (const discriminator of revision5Values) {
      expect(revision4Values).not.toContain(discriminator);
    }
  });

  it("identifies all three legacy-v1 and commitment-v2 discriminators", () => {
    const current = [
      getHireFromListingInstructionDataEncoder().encode({
        taskId: new Uint8Array(32),
        expectedPrice: 1n,
        expectedVersion: 1n,
        referrer: null,
        referrerFeeBps: 0,
        moderator: ZERO_ADDRESS,
        taskJobSpecHash: new Uint8Array(32).fill(1),
      }),
      getHireFromListingHumanlessInstructionDataEncoder().encode({
        taskId: new Uint8Array(32),
        expectedPrice: 1n,
        expectedVersion: 1n,
        reviewWindowSecs: 1n,
        referrer: null,
        referrerFeeBps: 0,
        moderator: ZERO_ADDRESS,
        taskJobSpecHash: new Uint8Array(32).fill(1),
      }),
      getSetTaskJobSpecInstructionDataEncoder().encode({
        jobSpecHash: new Uint8Array(32).fill(1),
        jobSpecUri: "u",
        moderator: ZERO_ADDRESS,
      }),
    ];

    expect(
      [
        REVISION_4_HIRE_FROM_LISTING,
        REVISION_4_HIRE_FROM_LISTING_HUMANLESS,
        REVISION_4_SET_TASK_JOB_SPEC,
      ].map(
        (data) =>
          history.identifyMarketplaceWriteInstruction(data)?.wireVersion,
      ),
    ).toEqual(["legacy-v1", "legacy-v1", "legacy-v1"]);
    expect(
      current.map(
        (data) =>
          history.identifyMarketplaceWriteInstruction({ data })?.wireVersion,
      ),
    ).toEqual(["commitment-v2", "commitment-v2", "commitment-v2"]);
    expect(
      history.identifyMarketplaceWriteInstruction(new Uint8Array(7)),
    ).toBeNull();
    expect(
      history.identifyMarketplaceWriteInstruction(new Uint8Array(8)),
    ).toBeNull();
  });

  it("isolates classification and decoded bytes from mutable public results", () => {
    const currentWire = getHireFromListingInstructionDataEncoder().encode({
      taskId: new Uint8Array(32).fill(0x41),
      expectedPrice: 1n,
      expectedVersion: 1n,
      referrer: null,
      referrerFeeBps: 0,
      moderator: ZERO_ADDRESS,
      taskJobSpecHash: new Uint8Array(32).fill(0x42),
    });
    const publicLegacy =
      history.REVISION_4_HIRE_FROM_LISTING_DISCRIMINATOR as Uint8Array;
    const publicCurrent = HIRE_FROM_LISTING_DISCRIMINATOR as Uint8Array;
    const originalLegacy = new Uint8Array(publicLegacy);
    const originalCurrent = new Uint8Array(publicCurrent);
    try {
      const identity = history.identifyMarketplaceWriteInstruction(
        REVISION_4_HIRE_FROM_LISTING,
      );
      const decoded = history.decodeMarketplaceWriteInstruction(
        REVISION_4_HIRE_FROM_LISTING,
      );
      if (
        identity === null ||
        decoded?.instruction !== "hire_from_listing" ||
        decoded.wireVersion !== "legacy-v1"
      ) {
        throw new Error("unexpected history fixture identity");
      }

      publicLegacy.fill(0);
      publicCurrent.fill(0);
      (identity.discriminator as Uint8Array).fill(0);
      (decoded.data.discriminator as Uint8Array).fill(0);
      (decoded.data.taskId as Uint8Array).fill(0);

      expect(
        discriminatorHex(
          history.identifyMarketplaceWriteInstruction(
            REVISION_4_HIRE_FROM_LISTING,
          )!.discriminator,
        ),
      ).toBe("aee15144ac1361c2");
      expect(
        history.identifyMarketplaceWriteInstruction(currentWire)?.wireVersion,
      ).toBe("commitment-v2");
      const decodedAgain = history.decodeMarketplaceWriteInstruction(
        REVISION_4_HIRE_FROM_LISTING,
      );
      if (
        decodedAgain?.instruction !== "hire_from_listing" ||
        decodedAgain.wireVersion !== "legacy-v1"
      ) {
        throw new Error("history decoder was corrupted by consumer mutation");
      }
      expect(decodedAgain.data.taskId).toEqual(new Uint8Array(32).fill(0x11));
      expect(REVISION_4_HIRE_FROM_LISTING.slice(0, 8)).toEqual(originalLegacy);
    } finally {
      publicLegacy.set(originalLegacy);
      publicCurrent.set(originalCurrent);
    }
  });

  it("decodes the exact revision-4 hire_from_listing wire", () => {
    const decoded = history.decodeMarketplaceWriteInstruction(
      REVISION_4_HIRE_FROM_LISTING,
    );
    if (
      decoded?.wireVersion !== "legacy-v1" ||
      decoded.instruction !== "hire_from_listing"
    ) {
      throw new Error("unexpected decoded instruction");
    }
    expect(decoded.surfaceRevision).toBe(4);
    expect(decoded.data.taskId).toEqual(new Uint8Array(32).fill(0x11));
    expect(decoded.data.expectedPrice).toBe(1n);
    expect(decoded.data.expectedVersion).toBe(2n);
    expect(decoded.data.referrer).toEqual({ __option: "None" });
    expect(decoded.data.referrerFeeBps).toBe(25);
    expect(decoded.data.moderator).toBe(ZERO_ADDRESS);
    expect("taskJobSpecHash" in decoded.data).toBe(false);
  });

  it("decodes the exact revision-4 humanless wire including Some(pubkey)", () => {
    const decoded = history.decodeMarketplaceWriteInstruction(
      REVISION_4_HIRE_FROM_LISTING_HUMANLESS,
    );
    if (
      decoded?.wireVersion !== "legacy-v1" ||
      decoded.instruction !== "hire_from_listing_humanless"
    ) {
      throw new Error("unexpected decoded instruction");
    }
    expect(decoded.data.taskId).toEqual(new Uint8Array(32).fill(0x22));
    expect(decoded.data.expectedPrice).toBe(3n);
    expect(decoded.data.expectedVersion).toBe(4n);
    expect(decoded.data.reviewWindowSecs).toBe(3600n);
    expect(decoded.data.referrer).toEqual({
      __option: "Some",
      value: ONE_BYTE_ADDRESS,
    });
    expect(decoded.data.referrerFeeBps).toBe(50);
    expect(decoded.data.moderator).toBe(ZERO_ADDRESS);
    expect("taskJobSpecHash" in decoded.data).toBe(false);
  });

  it("decodes the exact revision-4 set_task_job_spec UTF-8 wire", () => {
    const decoded = history.decodeMarketplaceWriteInstruction(
      REVISION_4_SET_TASK_JOB_SPEC,
    );
    if (
      decoded?.wireVersion !== "legacy-v1" ||
      decoded.instruction !== "set_task_job_spec"
    ) {
      throw new Error("unexpected decoded instruction");
    }
    expect(decoded.data.jobSpecHash).toEqual(new Uint8Array(32).fill(0x33));
    expect(decoded.data.jobSpecUri).toBe("ipfs://é");
    expect(decoded.data.moderator).toBe(ZERO_ADDRESS);
  });

  it("strictly decodes commitment-v2 and retains its task commitment", () => {
    const taskJobSpecHash = new Uint8Array(32).fill(0x44);
    const wire = getHireFromListingInstructionDataEncoder().encode({
      taskId: new Uint8Array(32).fill(0x55),
      expectedPrice: 8n,
      expectedVersion: 9n,
      referrer: null,
      referrerFeeBps: 0,
      moderator: ZERO_ADDRESS,
      taskJobSpecHash,
    });
    const decoded = history.decodeMarketplaceWriteInstruction({ data: wire });
    if (
      decoded?.wireVersion !== "commitment-v2" ||
      decoded.instruction !== "hire_from_listing"
    ) {
      throw new Error("unexpected decoded instruction");
    }
    expect(decoded.surfaceRevision).toBe(5);
    expect(decoded.data.taskJobSpecHash).toEqual(taskJobSpecHash);
  });

  it("rejects recognized truncated and trailing-byte payloads", () => {
    expect(() =>
      history.decodeMarketplaceWriteInstruction(
        REVISION_4_HIRE_FROM_LISTING.slice(0, -1),
      ),
    ).toThrow(/Invalid hire_from_listing legacy-v1 instruction data/u);
    const trailing = new Uint8Array(REVISION_4_SET_TASK_JOB_SPEC.length + 1);
    trailing.set(REVISION_4_SET_TASK_JOB_SPEC);
    expect(() => history.decodeMarketplaceWriteInstruction(trailing)).toThrow(
      /trailing byte/u,
    );

    const nonCanonicalOption = REVISION_4_HIRE_FROM_LISTING.slice();
    nonCanonicalOption[56] = 2;
    expect(() =>
      history.decodeMarketplaceWriteInstruction(nonCanonicalOption),
    ).toThrow(/option tag at byte 56 must be 0 or 1/u);
  });

  it("publishes frozen account orders for historical backfills", () => {
    const oldStandard =
      history.REVISION_4_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS.hire_from_listing;
    const newStandard =
      history.REVISION_5_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS.hire_from_listing;
    const oldHumanless =
      history.REVISION_4_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS
        .hire_from_listing_humanless;
    const oldActivation =
      history.REVISION_4_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS.set_task_job_spec;
    const newActivation =
      history.REVISION_5_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS.set_task_job_spec;

    expect(oldStandard.map(({ name }) => name)).toEqual([
      "task",
      "escrow",
      "hire_record",
      "listing",
      "protocol_config",
      "moderation_config",
      "listing_moderation",
      "moderation_attestor",
      "moderation_block",
      "creator_agent",
      "authority_rate_limit",
      "authority",
      "creator",
      "system_program",
    ]);
    expect(oldStandard).toHaveLength(14);
    expect(oldHumanless).toHaveLength(13);
    expect(newStandard).toHaveLength(15);
    expect(newStandard[4]?.name).toBe("provider_agent");
    expect(oldActivation).toHaveLength(9);
    expect(newActivation).toHaveLength(10);
    expect(newActivation.at(-1)?.name).toBe("hire_record");
    expect(oldStandard[11]).toMatchObject({
      name: "authority",
      signer: true,
      writable: false,
    });
    expect(oldStandard[12]).toMatchObject({
      name: "creator",
      signer: true,
      writable: true,
    });
    expect(Object.isFrozen(oldStandard)).toBe(true);
    expect(Object.isFrozen(oldStandard[0])).toBe(true);
  });
});
