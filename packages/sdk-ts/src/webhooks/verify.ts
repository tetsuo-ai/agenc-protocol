// Webhook signature verification for AgenC indexer deliveries (PLAN.md P3.3).
//
// Deliveries carry an `X-Agenc-Signature` header of the form
// `t=<unixMillis>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>` — the same
// Stripe-style scheme: the timestamp is signed together with the body, so a
// captured delivery cannot be replayed outside the tolerance window and the
// body cannot be swapped under a valid signature.
//
// Browser-safe: WebCrypto (`globalThis.crypto.subtle`) only — no
// `node:crypto`, no `Buffer`.

/** Input for {@link verifyAgencWebhookSignature}. */
export interface VerifyAgencWebhookSignatureInput {
  /**
   * The EXACT raw request body string as received — re-serializing parsed
   * JSON (`JSON.stringify(req.body)`) can reorder or reformat and break the
   * signature. Read the raw bytes.
   */
  rawBody: string;
  /** The `X-Agenc-Signature` header value (`t=<unixMillis>,v1=<hex>`). */
  signatureHeader: string;
  /** The endpoint's signing secret (returned once at webhook registration). */
  secret: string;
  /**
   * Maximum allowed absolute distance between the signed timestamp and `now`,
   * in milliseconds (replay-window bound, both past AND future skew).
   * Default: `300000` (5 minutes).
   */
  toleranceMs?: number;
  /** Clock override returning unix milliseconds (tests). Default: `Date.now`. */
  now?: () => number;
}

const HEX_PAIR = /^[0-9a-f]+$/;

/** UTF-8 encode into a plain-ArrayBuffer-backed view for WebCrypto. */
function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

/** Lowercase-hex encode a digest. */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Constant-time-ish string comparison: always scans the full length instead
 * of returning at the first mismatch. (Length is checked up front — leaking
 * the expected signature LENGTH is harmless, it is always 64 hex chars.)
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Parse `t=<unixMillis>,v1=<hex>,...` into the timestamp and every `v1`
 * candidate (multiple `v1` entries are allowed, for secret rotation), or
 * `null` when malformed.
 */
function parseSignatureHeader(
  header: string,
): { timestampMs: number; signatures: string[] } | null {
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) return null;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (timestamp !== null) return null; // duplicate t
      if (!/^\d+$/.test(value)) return null;
      timestamp = value;
    } else if (key === "v1") {
      if (value.length === 0 || value.length % 2 !== 0) return null;
      if (!HEX_PAIR.test(value.toLowerCase())) return null;
      signatures.push(value.toLowerCase());
    }
    // Unknown keys are ignored (forward compatibility: a future v2 scheme
    // must not break v1 verifiers).
  }
  if (timestamp === null || signatures.length === 0) return null;
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs)) return null;
  return { timestampMs, signatures };
}

/**
 * Verify an AgenC webhook delivery signature (`X-Agenc-Signature`:
 * `t=<unixMillis>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>`).
 *
 * Returns `false` (never throws) when the header is malformed, the timestamp
 * is outside the tolerance window (default ±5 minutes — replay protection),
 * or no `v1` candidate matches the recomputed HMAC. The hex comparison is
 * constant-time-ish (full-scan, no early exit).
 *
 * Verify against the EXACT raw body string received on the wire — parse the
 * JSON only after this returns `true`.
 *
 * @param input - Raw body, header, secret, and optional tolerance/clock.
 * @returns Whether the delivery is authentic and within tolerance.
 *
 * @example
 * ```ts
 * const ok = await verifyAgencWebhookSignature({
 *   rawBody,
 *   signatureHeader: req.headers["x-agenc-signature"],
 *   secret: process.env.AGENC_WEBHOOK_SECRET,
 * });
 * if (!ok) return res.status(400).end();
 * const event = JSON.parse(rawBody);
 * ```
 */
export async function verifyAgencWebhookSignature(
  input: VerifyAgencWebhookSignatureInput,
): Promise<boolean> {
  const toleranceMs = input.toleranceMs ?? 300_000;
  const parsed = parseSignatureHeader(input.signatureHeader);
  if (parsed === null) return false;

  const nowMs = (input.now ?? Date.now)();
  if (Math.abs(nowMs - parsed.timestampMs) > toleranceMs) return false;

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    utf8(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    utf8(`${parsed.timestampMs}.${input.rawBody}`),
  );
  const expected = toHex(new Uint8Array(mac));

  let anyMatch = false;
  for (const candidate of parsed.signatures) {
    // No early exit: check every candidate to keep timing flat.
    if (timingSafeEqualHex(candidate, expected)) anyMatch = true;
  }
  return anyMatch;
}
