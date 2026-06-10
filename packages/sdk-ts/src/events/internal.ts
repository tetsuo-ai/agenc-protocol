// Internal browser-safe helpers for the events runtime layer. Not part of the
// public API surface (src/events/index.ts does not re-export this module).

/**
 * Decodes a base64 string into bytes using `atob` (available in browsers and
 * Node >= 16), never `Buffer`. Returns `null` for malformed base64 instead of
 * throwing, so log scanners can skip bad lines silently.
 *
 * @param base64 - The base64 string to decode.
 * @returns The decoded bytes, or `null` if the input is not valid base64.
 */
export function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Renders `bytes[start..end)` as lowercase hex (the key format used by the
 * generated `AGENC_EVENT_DECODERS` table).
 *
 * @param bytes - Source bytes.
 * @param start - Inclusive start offset.
 * @param end - Exclusive end offset.
 * @returns Lowercase hex string of the requested slice.
 */
export function bytesToHex(bytes: Uint8Array, start: number, end: number): string {
  let hex = "";
  for (let i = start; i < end; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Sleeps for `ms` milliseconds, resolving early (never rejecting) if
 * `abortSignal` aborts first.
 *
 * @param ms - Milliseconds to sleep.
 * @param abortSignal - Optional signal that cuts the sleep short.
 * @returns A promise that resolves after the delay (or on abort).
 */
export function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      abortSignal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    abortSignal?.addEventListener("abort", done, { once: true });
  });
}
