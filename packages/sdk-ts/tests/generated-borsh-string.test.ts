import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  address,
  getAddressEncoder,
  getUtf8Encoder,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  getInitiateDisputeInstructionDataDecoder,
  getInitiateDisputeInstructionDataEncoder,
  getSetTaskJobSpecInstructionDataDecoder,
  getSetTaskJobSpecInstructionDataEncoder,
  getTaskJobSpecDecoder,
  getTaskJobSpecEncoder,
  getTaskJobSpecSetEventDecoder,
} from "../src/generated/index.js";
import {
  getBorshStringDecoder,
  getBorshStringEncoder,
} from "../src/generated/codecs/borshString.js";

const GENERATED_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/generated",
);
const DEFAULT_ADDRESS = address("11111111111111111111111111111111");
const HASH = new Uint8Array(32).fill(0xa5);

const STRING_BEARING_MODULES = [
  "accounts/agentRegistration.ts",
  "accounts/agentVerification.ts",
  "accounts/defaultTrustList.ts",
  "accounts/dispute.ts",
  "accounts/goodsListing.ts",
  "accounts/hireRating.ts",
  "accounts/moderationBlock.ts",
  "accounts/serviceListing.ts",
  "accounts/store.ts",
  "accounts/taskJobSpec.ts",
  "events/agentRegistered.ts",
  "events/agentVerified.ts",
  "events/defaultTrustListUpdated.ts",
  "events/moderationBlockSet.ts",
  "events/taskJobSpecSet.ts",
  "instructions/createGoodsListing.ts",
  "instructions/createServiceListing.ts",
  "instructions/initiateDispute.ts",
  "instructions/rateHire.ts",
  "instructions/recordAgentVerification.ts",
  "instructions/registerAgent.ts",
  "instructions/registerStore.ts",
  "instructions/resolveDispute.ts",
  "instructions/setDefaultTrustList.ts",
  "instructions/setModerationBlock.ts",
  "instructions/setTaskJobSpec.ts",
  "instructions/updateAgent.ts",
  "instructions/updateGoodsListing.ts",
  "instructions/updateServiceListing.ts",
  "instructions/updateStore.ts",
] as const;
const STRING_ENCODER_MODULES = STRING_BEARING_MODULES.filter(
  (module) => !module.startsWith("events/"),
);

function generatedTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return generatedTypeScriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

function concat(...chunks: readonly ReadonlyUint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function i64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}

function taskJobSpecArgs(jobSpecUri: string) {
  return {
    task: DEFAULT_ADDRESS,
    creator: DEFAULT_ADDRESS,
    jobSpecHash: HASH,
    jobSpecUri,
    createdAt: 1n,
    updatedAt: 2n,
    bump: 1,
    reserved: new Uint8Array(7),
  };
}

function setTaskJobSpecArgs(jobSpecUri: string) {
  return {
    jobSpecHash: HASH,
    jobSpecUri,
    moderator: DEFAULT_ADDRESS,
  };
}

function initiateDisputeArgs(evidence: string) {
  return {
    disputeId: HASH,
    taskId: new Uint8Array(32).fill(0xb6),
    evidenceHash: new Uint8Array(32).fill(0xc7),
    resolutionType: 0,
    evidence,
  };
}

function taskJobSpecSetEventPayload(jobSpecUri: string): Uint8Array {
  const utf8 = getUtf8Encoder().encode(jobSpecUri);
  const addressBytes = getAddressEncoder().encode(DEFAULT_ADDRESS as Address);
  return concat(
    addressBytes,
    addressBytes,
    HASH,
    u32(utf8.length),
    utf8,
    new Uint8Array([0]), // moderation_attestor: Option::None
    i64(3n),
  );
}

describe("generated Borsh string codec coverage", () => {
  it("deterministically covers every generated string-bearing module", () => {
    const sources = generatedTypeScriptFiles(GENERATED_ROOT).map((file) => ({
      file,
      relative: path.relative(GENERATED_ROOT, file).replaceAll(path.sep, "/"),
      source: readFileSync(file, "utf8"),
    }));
    const covered = sources
      .filter(
        ({ relative, source }) =>
          relative !== "codecs/borshString.ts" &&
          source.includes("getBorshStringDecoder()"),
      )
      .map(({ relative }) => relative)
      .sort();

    expect(covered).toEqual([...STRING_BEARING_MODULES].sort());
    expect(
      sources.reduce(
        (count, { source }) =>
          count + (source.match(/getBorshStringDecoder\(\)/g)?.length ?? 0),
        0,
      ),
    ).toBe(37);
    expect(
      sources.reduce(
        (count, { source }) =>
          count + (source.match(/getBorshStringEncoder\(\)/g)?.length ?? 0),
        0,
      ),
    ).toBe(32);
    expect(
      sources.filter(({ source }) =>
        /\bgetUtf8(?:Decoder|Encoder)\b/.test(source),
      ),
    ).toEqual([]);
    for (const module of STRING_BEARING_MODULES) {
      const source = readFileSync(path.join(GENERATED_ROOT, module), "utf8");
      expect(source).toContain("getBorshStringDecoder");
      expect(source).toContain('from "../codecs/borshString";');
    }
    for (const module of STRING_ENCODER_MODULES) {
      const source = readFileSync(path.join(GENERATED_ROOT, module), "utf8");
      expect(source).toContain("getBorshStringEncoder");
    }
  });

  it("round-trips Unicode scalars exactly and rejects malformed text/UTF-8", () => {
    const values = [
      "plain",
      "\ufeffplain",
      "ab",
      "a\0b",
      "\0",
      "\ufeff",
      "\u0085",
      "\ufeff\0middle\u0085\0tail",
      "valid surrogate pair: \ud83d\ude00",
    ];
    const decoder = getBorshStringDecoder();
    const encoder = getBorshStringEncoder();
    const decoded = values.map((value) => {
      const bytes = encoder.encode(value);
      const roundTrip = decoder.decode(bytes);
      expect(encoder.encode(roundTrip)).toEqual(bytes);
      return roundTrip;
    });

    expect(decoded).toEqual(values);
    expect(new Set(decoded).size).toBe(values.length);
    expect(decoder.decode(encoder.encode("\ufffd"))).toBe("\ufffd");
    for (const malformed of [
      "\ud800",
      "\udc00",
      "before\ud800after",
      "\ud800\ud800",
      "\udc00\udfff",
    ]) {
      expect(() => encoder.encode(malformed)).toThrow(/unpaired .* surrogate/);
    }
    expect(() => decoder.decode(new Uint8Array([0xc3, 0x28]))).toThrow();
    expect(() => decoder.decode(new Uint8Array([0xed, 0xa0, 0x80]))).toThrow();
  });
});

describe("representative generated Borsh string surfaces", () => {
  const exact = "\ufeffagenc://spec/\0v1\u0085/\ud83d\ude00";

  it("round-trips account strings without collisions or normalization", () => {
    const decoder = getTaskJobSpecDecoder();
    const encoder = getTaskJobSpecEncoder();
    const values = [exact, exact.slice(1), exact.replace("\0", "")];
    const encoded = values.map((value) =>
      encoder.encode(taskJobSpecArgs(value)),
    );

    expect(encoded[0]).not.toEqual(encoded[1]);
    expect(encoded[0]).not.toEqual(encoded[2]);
    expect(encoded.map((bytes) => decoder.decode(bytes).jobSpecUri)).toEqual(
      values,
    );
    expect(() => encoder.encode(taskJobSpecArgs("\ud800"))).toThrow(
      /unpaired high surrogate/,
    );
    expect(
      decoder.decode(encoder.encode(taskJobSpecArgs("\ufffd"))).jobSpecUri,
    ).toBe("\ufffd");

    const invalid = Uint8Array.from(encoder.encode(taskJobSpecArgs("x")));
    invalid[108] = 0xff;
    expect(() => decoder.decode(invalid)).toThrow();
  });

  it("round-trips instruction strings without normalization", () => {
    const decoder = getSetTaskJobSpecInstructionDataDecoder();
    const encoder = getSetTaskJobSpecInstructionDataEncoder();
    const bytes = encoder.encode(setTaskJobSpecArgs(exact));
    expect(decoder.decode(bytes).jobSpecUri).toBe(exact);

    const invalid = Uint8Array.from(encoder.encode(setTaskJobSpecArgs("x")));
    invalid[44] = 0xff;
    expect(() => decoder.decode(invalid)).toThrow();
  });

  it("keeps reachable initiate-dispute evidence strings collision-free", () => {
    const decoder = getInitiateDisputeInstructionDataDecoder();
    const encoder = getInitiateDisputeInstructionDataEncoder();
    const values = [exact, exact.slice(1), exact.replace("\0", "")];
    const encoded = values.map((value) =>
      encoder.encode(initiateDisputeArgs(value)),
    );

    expect(encoded[0]).not.toEqual(encoded[1]);
    expect(encoded[0]).not.toEqual(encoded[2]);
    expect(encoded.map((bytes) => decoder.decode(bytes).evidence)).toEqual(
      values,
    );
    expect(() => encoder.encode(initiateDisputeArgs("\udc00"))).toThrow(
      /unpaired low surrogate/,
    );
    expect(
      decoder.decode(encoder.encode(initiateDisputeArgs("\ufffd"))).evidence,
    ).toBe("\ufffd");

    const invalid = Uint8Array.from(encoder.encode(initiateDisputeArgs("x")));
    invalid[109] = 0xff;
    expect(() => decoder.decode(invalid)).toThrow();
  });

  it("decodes manually-emitted event strings without normalization", () => {
    const decoder = getTaskJobSpecSetEventDecoder();
    expect(decoder.decode(taskJobSpecSetEventPayload(exact)).jobSpecUri).toBe(
      exact,
    );

    const invalid = taskJobSpecSetEventPayload("x");
    invalid[100] = 0xff;
    expect(() => decoder.decode(invalid)).toThrow();
  });
});
