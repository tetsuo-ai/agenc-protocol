// SHA-256 hashing helpers built on WebCrypto (`globalThis.crypto.subtle`).
// Browser-safe: no `node:crypto`, no `Buffer`.
import type { ReadonlyUint8Array } from "@solana/kit";

/** Shared UTF-8 encoder for string inputs. */
const utf8 = new TextEncoder();

/**
 * Reject values that a fixed-size Solana encoder would otherwise silently pad
 * or truncate. Use this at any signing boundary where the caller's exact
 * SHA-256 intent must survive instruction construction byte-for-byte.
 */
export function assertCanonicalHash32(
  hash: ReadonlyUint8Array,
  label = "hash",
): void {
  if (hash.byteLength !== 32) {
    throw new RangeError(
      `${label} must be exactly 32 bytes (got ${hash.byteLength})`,
    );
  }
  if (!hash.some((byte) => byte !== 0)) {
    throw new RangeError(`${label} must not be all zeroes`);
  }
}

/**
 * Computes the SHA-256 digest of `input`.
 *
 * Byte inputs are hashed as-is. String inputs are UTF-8 encoded first with
 * **no Unicode normalization** — when hashing human-entered free text or URIs
 * destined for an on-chain `[u8; 32]` hash field, prefer
 * {@link descriptionHash}, which pins the NFC canonicalization convention so
 * independently-computed hashes agree.
 *
 * @param input - Raw bytes, or a string to UTF-8 encode and hash.
 * @returns The 32-byte SHA-256 digest.
 *
 * @example
 * ```ts
 * const digest = await sha256("abc");
 * // ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
 * ```
 */
export async function sha256(input: Uint8Array | string): Promise<Uint8Array> {
  // `.slice()` copies byte inputs into a fresh, plain-ArrayBuffer-backed view:
  // WebCrypto rejects SharedArrayBuffer-backed views (and TS's generic typed
  // arrays type them out of `BufferSource`), and hash inputs are small.
  const bytes: Uint8Array<ArrayBuffer> =
    typeof input === "string" ? utf8.encode(input) : input.slice();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

/**
 * Hashes a task/listing description (or any free-text / URI commitment) into
 * the 32-byte form the on-chain `[u8; 32]` hash fields expect.
 *
 * **Canonicalization rule (the one convention, for free text AND URIs):**
 * the input string is Unicode-normalized to **NFC**
 * (`String.prototype.normalize("NFC")`), then **UTF-8 encoded**, then hashed
 * with **SHA-256**. NFC means visually-identical text that differs only in
 * composed vs decomposed code points (e.g. `é` as U+00E9 vs `e` + combining
 * U+0301) produces the **same** hash, so two parties hashing "the same"
 * description independently always agree. URIs are treated as plain strings
 * under the same rule — no percent-decoding, case folding, or trailing-slash
 * trimming is applied.
 *
 * Anyone verifying a hash must apply the identical rule:
 * `sha256(utf8(nfc(text)))`.
 *
 * @param input - The description text or URI to commit to.
 * @returns The 32-byte SHA-256 digest of the NFC-normalized UTF-8 bytes.
 *
 * @example
 * ```ts
 * // Composed and decomposed accents hash identically:
 * const a = await descriptionHash("café");       // "café" (NFC)
 * const b = await descriptionHash("café");      // "café" (NFD)
 * // a and b are byte-identical.
 * ```
 */
export async function descriptionHash(input: string): Promise<Uint8Array> {
  return sha256(input.normalize("NFC"));
}

/**
 * Lowercase-hex encode a byte array (e.g. a 32-byte digest -> 64 hex chars).
 * Browser-safe: no `Buffer`. The inverse of {@link hexToBytes}.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Decode a hex string (with or without a `0x` prefix) into bytes. Case-insensitive.
 * Browser-safe: no `Buffer`. The inverse of {@link bytesToHex}.
 *
 * @throws TypeError when the input has an odd length or contains a non-hex character.
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new TypeError(`hexToBytes: odd-length hex string (${clean.length} chars)`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new TypeError(`hexToBytes: non-hex character at byte ${i}`);
    }
    out[i] = byte;
  }
  return out;
}
