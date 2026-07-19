// Result hashing + delivery: sha256 the executor stdout (that digest IS the
// on-chain proofHash), then resolve the result URI — either by POSTing the
// body to the configured HTTPS uploader (response must be `{ "uri": ... }`)
// or, with no uploader, the documented inline placeholder
// `agenc://result/sha256/<hex>` (content addressed by the on-chain proof
// hash; the body itself is delivered out of band).
import { createHash } from "node:crypto";

/** sha256 of arbitrary bytes → 32 raw bytes. */
export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

/** sha256 of arbitrary bytes → lowercase hex (64 chars). */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The inline placeholder result URI used when no `resultUploader` is
 * configured: `agenc://result/sha256/<hex>`. It names the result by content
 * hash — the creator verifies any out-of-band delivery against the on-chain
 * `proofHash` (the same digest).
 */
export function resultPlaceholderUri(hashHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) {
    throw new Error(
      "resultPlaceholderUri requires a 64-char lowercase sha256 hex",
    );
  }
  return `agenc://result/sha256/${hashHex}`;
}

/**
 * The 64-byte on-chain `resultData` payload: the utf8 bytes of the sha256 hex
 * digest — exactly 64 bytes, so the full result hash rides inline on the
 * submission next to the raw 32-byte `proofHash`.
 */
export function resultDataFromHashHex(hashHex: string): Uint8Array {
  const bytes = new TextEncoder().encode(hashHex);
  if (bytes.length !== 64) {
    throw new Error(
      `resultData must be exactly 64 bytes (got ${bytes.length})`,
    );
  }
  return bytes;
}

/** Thrown when the result uploader rejects or answers with a bad shape. */
export class ResultUploadError extends Error {
  override name = "ResultUploadError";
}

/**
 * POST the result body to the HTTPS uploader; the response must be JSON
 * `{ "uri": "<string>" }`. Fails closed on any non-2xx status or bad shape —
 * the worker then does NOT submit (a lost result URI is not a submission).
 */
export async function uploadResult(options: {
  uploaderUrl: string;
  body: Uint8Array;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const { uploaderUrl, body } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(uploaderUrl);
  if (url.protocol !== "https:") {
    throw new ResultUploadError("resultUploader must be an https: URL");
  }
  let response: Response;
  try {
    response = await fetchImpl(uploaderUrl, {
      method: "POST",
      // Uint8Array is a valid fetch body; the cast keeps DOM lib types out.
      body: body as unknown as NonNullable<RequestInit["body"]>,
      // A crash after the uploader commits but before the response is persisted
      // retries these exact bytes. Uploaders should key this standard header to
      // the content hash and return the same URI for duplicate requests.
      headers: {
        "content-type": "application/octet-stream",
        "idempotency-key": sha256Hex(body),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (error) {
    throw new ResultUploadError(
      `result upload failed: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new ResultUploadError(
      `result uploader answered ${response.status} ${response.statusText}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ResultUploadError("result uploader response was not JSON");
  }
  const uri = (parsed as { uri?: unknown }).uri;
  if (typeof uri !== "string" || uri.length === 0) {
    throw new ResultUploadError(
      'result uploader response must be JSON `{ "uri": "<string>" }`',
    );
  }
  return uri;
}
