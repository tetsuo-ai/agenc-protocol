// Browser-safe random-identifier helper. WebCrypto only — no `node:crypto`,
// no `Buffer` — so this module runs unchanged in browsers, workers, and Node.

/**
 * Generates 32 cryptographically secure random bytes via
 * `globalThis.crypto.getRandomValues` (WebCrypto CSPRNG).
 *
 * Use this for every caller-chosen 32-byte protocol identifier — `agentId`,
 * `listingId`, `taskId`, `disputeId` — instead of hand-rolled or constant
 * placeholder bytes. Identifiers seed PDAs, so collisions would make two
 * logical entities share an address; 32 random bytes make that probability
 * negligible.
 *
 * @returns A fresh 32-byte `Uint8Array` of CSPRNG output.
 *
 * @example
 * ```ts
 * const taskId = randomId32();
 * const ix = await facade.createTask({ creator, authority, taskId, ... });
 * ```
 */
export function randomId32(): Uint8Array {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
