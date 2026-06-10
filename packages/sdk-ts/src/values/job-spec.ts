// `json-stable-v1` canonical JSON hashing — the content-address scheme used
// by AgenC job-spec envelopes (`integrity.canonicalization: "json-stable-v1"`,
// `integrity.algorithm: "sha256"`, `agenc://job-spec/sha256/<hex>` URIs).
//
// CLEAN-ROOM implementation: written from the published algorithm description
// only (the marketplace kit's job-spec package is EULA-licensed and was not
// consulted), and validated against kit-CLI-generated cross-implementation
// vectors in tests/fixtures/job-spec-vectors.json.
//
// Browser-safe: WebCrypto only, no `Buffer`, no `node:crypto`.

import { sha256 } from "./hash.js";

/** Result of {@link canonicalJobSpecHash}: the digest in both byte and hex form. */
export interface CanonicalJobSpecHash {
  /** The 32-byte SHA-256 digest of the canonical JSON (UTF-8) bytes. */
  bytes: Uint8Array;
  /** The same digest as 64 lowercase hex characters (the form used in job-spec URIs). */
  hex: string;
}

/**
 * Recursively canonicalizes a JSON-compatible value per `json-stable-v1`:
 *
 * - `null`, booleans, strings, and finite numbers pass through unchanged
 *   (strings are NOT Unicode-normalized — the kit applies NFKC only as input
 *   validation, never as part of canonicalization);
 * - non-finite numbers (`NaN`, `±Infinity`) throw `TypeError`;
 * - arrays keep their element order (an `undefined` element serializes as
 *   `null`, matching `JSON.stringify`);
 * - object properties whose value is `undefined` are dropped, and the
 *   remaining keys are sorted by plain JS string comparison (UTF-16 code
 *   units);
 * - anything else (`bigint`, functions, symbols, `undefined` at the root)
 *   throws `TypeError`.
 */
function canonicalize(value: unknown, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`json-stable-v1: non-finite number at ${path}`);
      }
      return value;
    case "object":
      break;
    default:
      throw new TypeError(`json-stable-v1: unsupported ${typeof value} value at ${path}`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      item === undefined ? null : canonicalize(item, `${path}[${index}]`),
    );
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) continue;
    out[key] = canonicalize(item, `${path}.${key}`);
  }
  return out;
}

/**
 * Serializes `spec` to its `json-stable-v1` canonical JSON string: object
 * keys recursively sorted (plain JS string comparison), `undefined`
 * properties dropped, arrays in original order, no whitespace, no Unicode
 * normalization, non-ASCII characters emitted raw (standard
 * `JSON.stringify`).
 *
 * This is the exact byte source for {@link canonicalJobSpecHash}; exposed so
 * integrations can inspect or store the canonical form itself.
 *
 * @param spec - Any JSON-compatible value (plain objects/arrays, strings,
 *   finite numbers, booleans, `null`).
 * @returns The canonical JSON string.
 * @throws TypeError on non-finite numbers, `bigint`s, functions, symbols, or
 *   a root `undefined`.
 *
 * @example
 * ```ts
 * canonicalJobSpecJson({ b: 2, a: 1 }); // '{"a":1,"b":2}'
 * ```
 */
export function canonicalJobSpecJson(spec: unknown): string {
  return JSON.stringify(canonicalize(spec, "$"));
}

/**
 * Computes the `json-stable-v1` SHA-256 content hash of a job-spec payload —
 * the same hash the AgenC marketplace kit publishes as
 * `integrity.payloadHash` and pins on-chain via `set_task_job_spec`, so
 * third-party spec hashes interoperate with moderation and explorer
 * verification.
 *
 * Pipeline: canonicalize (sort object keys, drop `undefined` properties,
 * reject non-finite numbers) → `JSON.stringify` with no whitespace → UTF-8
 * encode → SHA-256. No Unicode normalization is applied at any step.
 *
 * @param spec - The job-spec payload (any JSON-compatible value).
 * @returns The digest as `{ bytes, hex }`: 32 raw bytes for on-chain
 *   `[u8; 32]` fields, lowercase hex for `agenc://job-spec/sha256/<hex>`
 *   URIs.
 * @throws TypeError on non-finite numbers or non-JSON values anywhere in the
 *   tree.
 *
 * @example
 * ```ts
 * const { bytes, hex } = await canonicalJobSpecHash(envelope.payload);
 * // hex === envelope.integrity.payloadHash
 * // bytes goes into facade.setTaskJobSpec({ ..., jobSpecHash: bytes })
 * ```
 */
export async function canonicalJobSpecHash(spec: unknown): Promise<CanonicalJobSpecHash> {
  const bytes = await sha256(canonicalJobSpecJson(spec));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return { bytes, hex };
}
