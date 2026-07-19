import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { deflateSync, inflateSync } from "node:zlib";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

export const ANCHOR_IDL_ACCOUNT_HEADER_BYTES = 44;
export const ANCHOR_IDL_SEED = "anchor:idl";
export const ANCHOR_IDL_MAX_GROWTH_BYTES = 60_000;
export const ANCHOR_IDL_MAX_CREATE_DATA_LEN =
  ANCHOR_IDL_MAX_GROWTH_BYTES - ANCHOR_IDL_ACCOUNT_HEADER_BYTES;
export const ANCHOR_IDL_MAX_SAFE_INIT_COMPRESSED_BYTES =
  ANCHOR_IDL_MAX_CREATE_DATA_LEN - ANCHOR_IDL_ACCOUNT_HEADER_BYTES;
// Node zlib and Anchor's Rust flate2 backend need not produce byte-identical
// streams. Requiring twice Node's measured compact size gives this pinned
// release generous implementation headroom (and is enforced before mutation).
export const ANCHOR_IDL_COMPRESSION_SAFETY_FACTOR = 2;
export const ANCHOR_IDL_DISCRIMINATOR = createHash("sha256")
  .update("internal:IdlAccount")
  .digest()
  .subarray(0, 8);
const MAX_INFLATED_IDL_BYTES = 8 * 1024 * 1024;

function asPublicKey(value, label) {
  try {
    return value instanceof PublicKey ? value : new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid public key`);
  }
}

export async function deriveAnchorIdlAddress(programId) {
  const program = asPublicKey(programId, "program id");
  const [base] = PublicKey.findProgramAddressSync([], program);
  return PublicKey.createWithSeed(base, ANCHOR_IDL_SEED, program);
}

/**
 * On-chain consumers do not need human prose. Removing only `docs` produces a
 * deterministic, semantically complete projection while keeping the full
 * reviewed IDL (and generated reference documentation) in the repository.
 */
export function compactIdlForOnChain(value) {
  if (Array.isArray(value)) return value.map(compactIdlForOnChain);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (key !== "docs") result[key] = compactIdlForOnChain(child);
    }
    return result;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error(`IDL contains unsupported value type ${typeof value}`);
}

function canonicalJson(value, location = "$") {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((child, index) => canonicalJson(child, `${location}[${index}]`))
      .join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key], `${location}.${key}`)}`,
      )
      .join(",")}}`;
  }
  throw new Error(`IDL contains an unsupported value at ${location}`);
}

export function prepareOnChainIdl(reviewedIdl) {
  if (!reviewedIdl || typeof reviewedIdl !== "object" || Array.isArray(reviewedIdl)) {
    throw new Error("reviewed IDL must be a JSON object");
  }
  const idl = compactIdlForOnChain(reviewedIdl);
  const jsonBytes = Buffer.from(JSON.stringify(idl));
  const compressedBytes = deflateSync(jsonBytes);
  const conservativeCompressedBytes =
    compressedBytes.length * ANCHOR_IDL_COMPRESSION_SAFETY_FACTOR;
  return {
    idl,
    jsonBytes,
    compressedBytes,
    conservativeCompressedBytes,
    canonicalSha256: createHash("sha256")
      .update(canonicalJson(idl))
      .digest("hex"),
  };
}

export function planAnchorIdlStorage({
  nodeCompressedBytes,
  existingCapacity = null,
}) {
  if (!Number.isSafeInteger(nodeCompressedBytes) || nodeCompressedBytes < 1) {
    throw new Error("Node IDL compression estimate must be a positive safe integer");
  }
  const conservativeCompressedBytes =
    nodeCompressedBytes * ANCHOR_IDL_COMPRESSION_SAFETY_FACTOR;
  if (!Number.isSafeInteger(conservativeCompressedBytes)) {
    throw new Error("conservative IDL compression bound exceeds the safe integer range");
  }
  if (existingCapacity === null) {
    if (
      conservativeCompressedBytes >
      ANCHOR_IDL_MAX_SAFE_INIT_COMPRESSED_BYTES
    ) {
      throw new Error(
        `new canonical IDL needs a conservative ${conservativeCompressedBytes}-byte ` +
          `compressed bound, above Anchor 0.32.1's safe init capacity ` +
          `${ANCHOR_IDL_MAX_SAFE_INIT_COMPRESSED_BYTES}`,
      );
    }
    return {
      canonicalAccountRentBytes: ANCHOR_IDL_MAX_CREATE_DATA_LEN,
      conservativeCompressedBytes,
      mode: "init",
      transientBufferRentBytes: 0,
    };
  }
  if (!Number.isSafeInteger(existingCapacity) || existingCapacity < 0) {
    throw new Error("existing canonical IDL capacity must be a non-negative safe integer");
  }
  if (existingCapacity < conservativeCompressedBytes) {
    throw new Error(
      `canonical IDL capacity ${existingCapacity} is below the conservative ` +
        `${conservativeCompressedBytes}-byte compressed publication bound`,
    );
  }
  return {
    canonicalAccountRentBytes: 0,
    conservativeCompressedBytes,
    mode: "upgrade",
    transientBufferRentBytes:
      ANCHOR_IDL_ACCOUNT_HEADER_BYTES + conservativeCompressedBytes,
  };
}

export function assertFetchedOnChainIdlMatchesReviewed(reviewedIdl, fetchedIdl) {
  const expected = prepareOnChainIdl(reviewedIdl);
  const actualCanonical = canonicalJson(fetchedIdl);
  const actualSha256 = createHash("sha256").update(actualCanonical).digest("hex");
  if (actualSha256 !== expected.canonicalSha256) {
    throw new Error(
      `fetched on-chain IDL digest ${actualSha256} != reviewed compact projection ` +
        `${expected.canonicalSha256}`,
    );
  }
  return {
    canonicalSha256: actualSha256,
    compressedBytes: expected.compressedBytes.length,
    jsonBytes: expected.jsonBytes.length,
  };
}

export async function decodeAnchorIdlAccount(
  account,
  address,
  {
    programId,
    expectedAuthority,
    allowEmpty = false,
    allowIncomplete = false,
  } = {},
) {
  const program = asPublicKey(programId, "program id");
  const suppliedAddress = asPublicKey(address, "IDL account address");
  const canonicalAddress = await deriveAnchorIdlAddress(program);
  if (!suppliedAddress.equals(canonicalAddress)) {
    throw new Error(
      `IDL account ${suppliedAddress.toBase58()} is not canonical ${canonicalAddress.toBase58()}`,
    );
  }
  if (!account || typeof account !== "object") {
    throw new Error(`canonical IDL account ${canonicalAddress.toBase58()} is missing`);
  }
  if (!account.owner?.equals?.(program)) {
    throw new Error(
      `IDL account owner ${account.owner?.toBase58?.() ?? "malformed"} != program ${program.toBase58()}`,
    );
  }
  if (account.executable !== false) {
    throw new Error("IDL account must be non-executable");
  }
  const data = Buffer.from(account.data ?? []);
  if (data.length < ANCHOR_IDL_ACCOUNT_HEADER_BYTES) {
    throw new Error(
      `IDL account length ${data.length} < ${ANCHOR_IDL_ACCOUNT_HEADER_BYTES}`,
    );
  }
  if (!data.subarray(0, 8).equals(ANCHOR_IDL_DISCRIMINATOR)) {
    throw new Error("IDL account discriminator mismatch");
  }
  const authority = new PublicKey(data.subarray(8, 40));
  if (authority.equals(PublicKey.default)) {
    throw new Error("IDL authority is erased/default; publication is immutable");
  }
  if (
    expectedAuthority !== undefined &&
    !authority.equals(asPublicKey(expectedAuthority, "expected IDL authority"))
  ) {
    throw new Error(
      `IDL authority ${authority.toBase58()} != expected signer ` +
        `${asPublicKey(expectedAuthority, "expected IDL authority").toBase58()}`,
    );
  }
  const dataLen = data.readUInt32LE(40);
  const capacity = data.length - ANCHOR_IDL_ACCOUNT_HEADER_BYTES;
  if (dataLen > capacity) {
    throw new Error(`IDL compressed data_len ${dataLen} exceeds capacity ${capacity}`);
  }
  if (dataLen === 0) {
    if (!allowEmpty && !allowIncomplete) {
      throw new Error("canonical IDL account contains no published data");
    }
    return {
      authority,
      canonicalAddress,
      capacity,
      dataLen,
      idl: null,
      incompleteReason: "canonical IDL account contains no published data",
    };
  }
  const compressedPayload = data.subarray(
    ANCHOR_IDL_ACCOUNT_HEADER_BYTES,
    ANCHOR_IDL_ACCOUNT_HEADER_BYTES + dataLen,
  );
  const compressedSha256 = createHash("sha256")
    .update(compressedPayload)
    .digest("hex");
  let inflated;
  try {
    inflated = inflateSync(
      compressedPayload,
      { maxOutputLength: MAX_INFLATED_IDL_BYTES },
    );
  } catch (error) {
    const incompleteReason =
      `IDL compressed payload is invalid: ` +
      `${error instanceof Error ? error.message : error}`;
    if (allowIncomplete) {
      return {
        authority,
        canonicalAddress,
        capacity,
        compressedSha256,
        dataLen,
        idl: null,
        incompleteReason,
      };
    }
    throw new Error(incompleteReason);
  }
  let idl;
  try {
    idl = JSON.parse(inflated.toString("utf8"));
  } catch (error) {
    const incompleteReason =
      `IDL inflated payload is not valid JSON: ` +
      `${error instanceof Error ? error.message : error}`;
    if (allowIncomplete) {
      return {
        authority,
        canonicalAddress,
        capacity,
        compressedSha256,
        dataLen,
        idl: null,
        inflatedBytes: inflated.length,
        incompleteReason,
      };
    }
    throw new Error(incompleteReason);
  }
  return {
    authority,
    canonicalAddress,
    capacity,
    compressedSha256,
    dataLen,
    idl,
    inflatedBytes: inflated.length,
  };
}
