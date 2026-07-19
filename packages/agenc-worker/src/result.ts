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

export const DEFAULT_MAX_RESULT_UPLOAD_RESPONSE_BYTES = 64 * 1024;
export const MAX_RESULT_URI_BYTES = 256;

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ResultUploadError("result uploader response limit is invalid");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ResultUploadError("result uploader returned an invalid content-length");
    }
    if (length > maxBytes) {
      throw new ResultUploadError(
        `result uploader response exceeds ${maxBytes} bytes`,
      );
    }
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ResultUploadError(
          `result uploader response exceeds ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ResultUploadError) throw error;
    throw new ResultUploadError(
      `could not read result uploader response: ${(error as Error).message}`,
    );
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function validateResultUri(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new ResultUploadError(
      'result uploader response must be JSON `{ "uri": "<string>" }`',
    );
  }
  if (
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    new TextEncoder().encode(value).byteLength > MAX_RESULT_URI_BYTES
  ) {
    throw new ResultUploadError("result uploader returned an unsafe result URI");
  }
  if (/^agenc:\/\/result\/sha256\/[0-9a-f]{64}$/.test(value)) return value;
  if (/^ar:\/\/[A-Za-z0-9_-]{43}$/.test(value)) return value;
  if (
    /^ipfs:\/(?:\/)(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58})(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(
      value,
    ) &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return value;
  }
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new ResultUploadError("result uploader returned an invalid result URI");
  }
  if (
    uri.protocol !== "https:" ||
    uri.username !== "" ||
    uri.password !== "" ||
    uri.hostname === "" ||
    uri.hash !== "" ||
    uri.href !== value
  ) {
    throw new ResultUploadError(
      "result uploader returned a non-canonical URI or unsupported content address",
    );
  }
  return value;
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
  maxResponseBytes?: number;
}): Promise<string> {
  const { uploaderUrl, body } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  let url: URL;
  try {
    url = new URL(uploaderUrl);
  } catch {
    throw new ResultUploadError("resultUploader must be an absolute https: URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === ""
  ) {
    throw new ResultUploadError(
      "resultUploader must be a credential-free https: URL",
    );
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
      // A POST redirect can replay the result bytes to an attacker-controlled
      // destination (and can downgrade HTTPS to plaintext). Never delegate
      // redirect handling to fetch; uploaders must answer directly.
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (error) {
    throw new ResultUploadError(
      `result upload failed: ${(error as Error).message}`,
    );
  }
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new ResultUploadError("result uploader redirects are not permitted");
  }
  if (!response.ok) {
    throw new ResultUploadError(
      `result uploader answered ${response.status} ${response.statusText}`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|\s*$)/iu.test(contentType)) {
    throw new ResultUploadError(
      "result uploader response must have an application/json content type",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readBoundedResponse(
        response,
        options.maxResponseBytes ?? DEFAULT_MAX_RESULT_UPLOAD_RESPONSE_BYTES,
      ),
    );
  } catch (error) {
    if (error instanceof ResultUploadError) throw error;
    throw new ResultUploadError("result uploader response was not JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !("uri" in parsed)
  ) {
    throw new ResultUploadError(
      'result uploader response must be JSON `{ "uri": "<string>" }`',
    );
  }
  return validateResultUri((parsed as { uri: unknown }).uri);
}
