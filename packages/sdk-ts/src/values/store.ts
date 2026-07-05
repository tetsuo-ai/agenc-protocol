// Store-identity wire codec for the fixed-width `Store.handle` field (batch-2
// P5.2 on-chain store identity). The on-chain program enforces the same rule
// in `validate_store_handle` (a charset floor for downstream UIs, NOT a
// uniqueness claim); this module is the client-side reference implementation.
// Browser-safe: TextEncoder/TextDecoder only, no `Buffer`.
//
// Wire rule: 3-20 chars of lowercase `[a-z0-9-]`, first char alphanumeric,
// UTF-8 (= ASCII under this charset), NUL-padded to exactly 32 bytes with
// canonical padding (nothing but NULs after the terminator).

/** Exact on-chain byte width of `Store.handle`. */
export const STORE_HANDLE_BYTES = 32;

/** Minimum effective (unpadded) handle length enforced on-chain. */
export const STORE_HANDLE_MIN_LEN = 3;

/** Maximum effective (unpadded) handle length enforced on-chain. */
export const STORE_HANDLE_MAX_LEN = 20;

/**
 * The on-chain store-handle rule (mirror of the program's
 * `validate_store_handle` / the product `HANDLE_RE`): 3-20 chars, lowercase
 * `[a-z0-9-]` only, first char alphanumeric.
 */
export const STORE_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{2,19}$/;

/** Shared UTF-8 decoder. `fatal: true` rejects malformed on-chain bytes. */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Encodes a store handle into its on-chain wire form: validated against
 * {@link STORE_HANDLE_PATTERN} and NUL-padded to exactly 32 bytes.
 *
 * The program re-validates on-chain (`InvalidStoreHandle`), so this is a
 * fail-fast convenience, not the trust boundary.
 *
 * @param handle - The store handle, e.g. `"acme-agents"`.
 * @returns A 32-byte `Uint8Array` ready for `facade.registerStore` /
 *   `facade.updateStore`.
 * @throws TypeError when the handle violates the on-chain rule.
 *
 * @example
 * ```ts
 * const handle = encodeStoreHandle("acme-agents"); // 32 bytes
 * ```
 */
export function encodeStoreHandle(handle: string): Uint8Array {
  if (!STORE_HANDLE_PATTERN.test(handle)) {
    throw new TypeError(
      `store handle: ${JSON.stringify(handle)} must be 3-20 chars of lowercase [a-z0-9-], starting alphanumeric`,
    );
  }
  const out = new Uint8Array(STORE_HANDLE_BYTES);
  out.set(new TextEncoder().encode(handle));
  return out;
}

/**
 * Decodes a 32-byte on-chain `Store.handle` back to a string by stripping
 * trailing NUL padding and validating the handle rule.
 *
 * @param bytes - Exactly 32 bytes of on-chain `Store.handle` data.
 * @returns The decoded handle.
 * @throws RangeError when `bytes` is not exactly 32 bytes long.
 * @throws TypeError when the unpadded bytes violate the handle rule (including
 *   non-canonical padding — any non-NUL byte after the first NUL).
 */
export function decodeStoreHandle(bytes: Uint8Array): string {
  if (bytes.length !== STORE_HANDLE_BYTES) {
    throw new RangeError(
      `store handle: expected exactly ${STORE_HANDLE_BYTES} bytes, got ${bytes.length}`,
    );
  }
  const terminator = bytes.indexOf(0);
  const end = terminator === -1 ? bytes.length : terminator;
  if (bytes.subarray(end).some((b) => b !== 0)) {
    throw new TypeError(
      "store handle: non-canonical padding (non-NUL byte after the first NUL)",
    );
  }
  const handle = utf8Decoder.decode(bytes.subarray(0, end));
  if (!STORE_HANDLE_PATTERN.test(handle)) {
    throw new TypeError(
      `store handle: on-chain value ${JSON.stringify(handle)} violates the handle rule`,
    );
  }
  return handle;
}
