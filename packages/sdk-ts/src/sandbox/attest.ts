// SDK half of the P2.3 sandbox moderation auto-attestor: a fetch-based,
// browser-safe client for a self-hosted attestor service that records CLEAN
// ListingModeration / TaskModeration attestations so the fail-closed
// moderation gate passes without a human moderator.
import {
  address,
  getBase58Decoder,
  getBase58Encoder,
  type Address,
} from "@solana/kit";
import type { ContentBodyStream } from "../task-thread/transport.js";
import { resolveSandboxEnvironment } from "./environment.js";
import { SANDBOX_FIXTURES } from "./fixtures.js";

/** What the attestor is asked to moderate: a service listing or a task. */
export type SandboxAttestationKind = "listing" | "task";

/**
 * Minimal structural slice of `fetch` used by
 * the sandbox/public moderation HTTP helpers. The global `fetch` satisfies it;
 * tests and embedders may inject a compatible implementation.
 */
export type SandboxFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body?: ContentBodyStream | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Input for {@link requestSandboxAttestation}. */
export interface RequestSandboxAttestationInput {
  /** Attest a `"listing"` (ListingModeration) or a `"task"` (TaskModeration). */
  kind: SandboxAttestationKind;
  /** The ServiceListing or Task PDA to attest. */
  address: Address;
  /**
   * The spec hash the attestation is pinned to: the listing's `spec_hash` for
   * listings, the job-spec hash for tasks. Either the raw 32 bytes or a
   * 64-char hex string (optionally `0x`-prefixed).
   */
  specHash: Uint8Array | string;
  /**
   * The attestor endpoint. Default: the environment seam's resolved attestor
   * (`AGENC_SANDBOX_ATTESTOR_URL`). There is NO shipped fallback endpoint —
   * when neither this option nor the env var names an attestor, the call
   * throws before any network access.
   */
  endpoint?: string;
  /** Override the fetch implementation (tests / custom transports). */
  fetch?: SandboxFetchLike;
  /** Wall-clock request limit. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Maximum streamed response body. Defaults to 64 KiB. */
  maxResponseBytes?: number;
}

/** Successful attestor response: the devnet transaction signature it landed. */
export interface SandboxAttestationResponse {
  /** Base58 signature of the moderation-recording devnet transaction. */
  signature: string;
}

/**
 * Typed failure from the sandbox attestor: a network-layer fetch rejection
 * (`status` 0 — DNS failure, refused connection, no network), any non-2xx
 * HTTP response, or a 2xx response whose body is not the expected
 * `{ signature }` JSON.
 */
export class SandboxAttestationError extends Error {
  /**
   * HTTP status code of the attestor response, or `0` when the request never
   * produced an HTTP response at all (network-layer fetch failure — e.g. the
   * hosted attestor is not deployed yet).
   */
  readonly status: number;
  /**
   * Seconds to wait before retrying, when the attestor rate-limited the
   * request (HTTP 429 with a `Retry-After` header or a `retryAfter` body
   * field); `null` otherwise.
   */
  readonly retryAfterSeconds: number | null;
  /** Raw response body text (when readable), for diagnostics. */
  readonly body: string | null;

  constructor(
    message: string,
    options: {
      status: number;
      retryAfterSeconds?: number | null;
      body?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "SandboxAttestationError";
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.body = options.body ?? null;
  }
}

const HEX_64 = /^[0-9a-f]{64}$/;
export const DEFAULT_SANDBOX_ATTESTATION_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_SANDBOX_ATTESTATION_RESPONSE_BYTES = 64 * 1024;

function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError(
      `requestSandboxAttestation: ${name} must be a positive safe integer no greater than 2147483647`,
    );
  }
  return value;
}

function parseEndpoint(value: string): { url: string; display: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(
      "requestSandboxAttestation: endpoint must be an absolute HTTP(S) URL",
    );
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError(
      "requestSandboxAttestation: endpoint must be an HTTP(S) URL without credentials or a fragment",
    );
  }
  // Never echo query parameters, which commonly contain access tokens.
  return { url: parsed.href, display: `${parsed.origin}${parsed.pathname}` };
}

function isCanonicalSignature(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const bytes = new Uint8Array(getBase58Encoder().encode(value));
    return bytes.length === 64 && getBase58Decoder().decode(bytes) === value;
  } catch {
    return false;
  }
}

/** Normalize a 32-byte spec hash (bytes or hex string) to lowercase hex. */
function specHashToHex(specHash: Uint8Array | string): string {
  if (typeof specHash === "string") {
    const hex = (
      specHash.startsWith("0x") || specHash.startsWith("0X")
        ? specHash.slice(2)
        : specHash
    ).toLowerCase();
    if (!HEX_64.test(hex)) {
      throw new TypeError(
        `requestSandboxAttestation: specHash string must be 64 hex chars ` +
          `(32 bytes, optional 0x prefix); got ${specHash.length} chars`,
      );
    }
    return hex;
  }
  if (specHash.length !== 32) {
    throw new TypeError(
      `requestSandboxAttestation: specHash must be exactly 32 bytes; got ${specHash.length}`,
    );
  }
  let hex = "";
  for (const byte of specHash) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Parse a Retry-After header / body hint into whole seconds, or null. */
function parseRetryAfterSeconds(
  header: string | null,
  bodyValue: unknown,
): number | null {
  if (header !== null) {
    const fromHeader = Number(header);
    if (Number.isFinite(fromHeader) && fromHeader >= 0) {
      return Math.ceil(fromHeader);
    }
  }
  if (
    typeof bodyValue === "number" &&
    Number.isFinite(bodyValue) &&
    bodyValue >= 0
  ) {
    return Math.ceil(bodyValue);
  }
  return null;
}

/**
 * Ask a sandbox moderation auto-attestor (P2.3 — e.g. the storefront's
 * self-hostable `sandboxAttestor`) to record a CLEAN moderation attestation
 * for a listing or task, so the program's fail-closed moderation gate passes
 * without a human moderator.
 *
 * POSTs `{ kind, address, specHash }` (spec hash as lowercase hex) to the
 * attestor and resolves with the transaction signature it landed. The
 * on-chain `ListingModeration` / `TaskModeration` account appears within
 * seconds of a 2xx response — poll the PDA before depending on it.
 *
 * The default endpoint flows through the environment seam
 * (`resolveSandboxEnvironment`): set `AGENC_SANDBOX_ATTESTOR_URL` to point a
 * whole workflow at a self-hosted attestor without touching call sites.
 * There is **no shipped default endpoint** — when nothing names an attestor,
 * this throws before any network access. On the localnet stack you usually
 * need no attestor at all: record moderation directly with the moderator
 * keypair (`facade.recordListingModeration` / `facade.recordTaskModeration`),
 * as `scripts/seed-devnet-sandbox.mjs` and `examples/localnet-first-hire.ts`
 * do.
 *
 * **Localnet/devnet-only.** An attestor holds a sandbox moderation authority
 * key and exists so third parties can exercise the flagship hire flow; there
 * is no mainnet equivalent.
 *
 * @param input - Kind, address, spec hash, and optional endpoint/fetch overrides.
 * @returns The attestor's `{ signature }` response.
 * @throws Error when no attestor endpoint is configured at all (no
 *   `endpoint` option and no `AGENC_SANDBOX_ATTESTOR_URL`).
 * @throws {@link SandboxAttestationError} when the endpoint cannot be reached
 *   at all (`status` 0 — DNS/refused/no network), on any non-2xx response
 *   (with `retryAfterSeconds` populated when rate-limited), or on a
 *   malformed 2xx body.
 * @throws TypeError when `specHash` is not 32 bytes / 64 hex chars.
 *
 * @example
 * ```ts
 * const { signature } = await requestSandboxAttestation({
 *   kind: "listing",
 *   address: listingPda,
 *   specHash,
 * });
 * ```
 */
export async function requestSandboxAttestation(
  input: RequestSandboxAttestationInput,
): Promise<SandboxAttestationResponse> {
  // Validate the input hash first (TypeError before any config/network work).
  const specHash = specHashToHex(input.specHash);
  // Default endpoint comes from the environment seam: an explicit
  // `input.endpoint` beats AGENC_SANDBOX_ATTESTOR_URL. There is no shipped
  // fallback — fail fast (before any fetch) with the escape hatches when
  // nothing names an attestor. The shipped fixtures are passed through so
  // attestation never depends on an AGENC_SANDBOX_FIXTURES file it does not
  // use.
  const endpoint =
    input.endpoint ??
    (await resolveSandboxEnvironment({ fixtures: SANDBOX_FIXTURES }))
      .attestorUrl;
  if (endpoint === null) {
    throw new Error(
      `requestSandboxAttestation: no sandbox attestor endpoint is ` +
        `configured. There is no shipped default endpoint (the old hosted ` +
        `default was never deployed). Pass the \`endpoint\` option or set ` +
        `AGENC_SANDBOX_ATTESTOR_URL to a live attestor — or, on the ` +
        `localnet stack, skip the attestor entirely and record moderation ` +
        `directly with the moderator keypair ` +
        `(.localnet/keys/moderator.json), as scripts/seed-devnet-sandbox.mjs ` +
        `and examples/localnet-first-hire.ts do.`,
    );
  }
  if (input.kind !== "listing" && input.kind !== "task") {
    throw new TypeError(
      'requestSandboxAttestation: kind must be "listing" or "task"',
    );
  }
  try {
    address(String(input.address));
  } catch {
    throw new TypeError(
      "requestSandboxAttestation: address must be a valid Solana address",
    );
  }
  const parsedEndpoint = parseEndpoint(endpoint);
  const timeoutMs = positiveBound(
    input.timeoutMs ?? DEFAULT_SANDBOX_ATTESTATION_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxResponseBytes = positiveBound(
    input.maxResponseBytes ?? DEFAULT_MAX_SANDBOX_ATTESTATION_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  // Wrapped so the global fetch keeps its expected receiver in browsers.
  const fetchImpl: SandboxFetchLike =
    input.fetch ?? ((url, init) => globalThis.fetch(url, init));

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutFailure = () =>
    new SandboxAttestationError(
      `sandbox attestor at ${parsedEndpoint.display} timed out after ${timeoutMs}ms`,
      { status: 0 },
    );
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutFailure());
    }, timeoutMs);
  });

  const perform = async (): Promise<SandboxAttestationResponse> => {
    let response: Awaited<ReturnType<SandboxFetchLike>>;
    try {
      response = await fetchImpl(parsedEndpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: input.kind,
          address: input.address,
          specHash,
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      if (controller.signal.aborted) throw timeoutFailure();
      // Network-layer rejection (DNS failure, refused connection, no network):
      // there is no HTTP status, so report 0 and keep the raw error as `cause`.
      throw new SandboxAttestationError(
        `sandbox attestor at ${parsedEndpoint.display} could not be reached (the fetch ` +
          `itself failed before any HTTP response). Check that the attestor ` +
          `service is actually running at that URL, or point the \`endpoint\` ` +
          `option / AGENC_SANDBOX_ATTESTOR_URL at a live self-hosted attestor.`,
        { status: 0, cause },
      );
    }
    if (controller.signal.aborted) throw timeoutFailure();

    const stream = response.body;
    if (
      stream === null ||
      typeof stream !== "object" ||
      typeof stream.getReader !== "function"
    ) {
      throw new SandboxAttestationError(
        `sandbox attestor at ${parsedEndpoint.display} returned ${response.status} but its body is not a readable byte stream`,
        { status: response.status },
      );
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks: string[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw new TypeError(
            "sandbox attestor response stream returned a non-byte chunk",
          );
        }
        total += value.byteLength;
        if (total > maxResponseBytes) {
          await reader
            .cancel?.("sandbox attestor response exceeds byte limit")
            .catch(() => undefined);
          throw new SandboxAttestationError(
            `sandbox attestor response exceeds the configured limit of ${maxResponseBytes} bytes`,
            { status: response.status },
          );
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } catch (cause) {
      if (cause instanceof SandboxAttestationError) throw cause;
      if (controller.signal.aborted) throw timeoutFailure();
      throw new SandboxAttestationError(
        `sandbox attestor at ${parsedEndpoint.display} returned ${response.status} but its response stream could not be read safely`,
        { status: response.status, cause },
      );
    } finally {
      reader.releaseLock?.();
    }
    const bodyText = chunks.join("");

    if (!response.ok) {
      let bodyRetryAfter: unknown;
      if (bodyText !== "") {
        try {
          const parsed: unknown = JSON.parse(bodyText);
          if (parsed !== null && typeof parsed === "object") {
            bodyRetryAfter = (parsed as { retryAfter?: unknown }).retryAfter;
          }
        } catch {
          // Non-JSON error body — keep the raw text for diagnostics.
        }
      }
      const retryAfterSeconds = parseRetryAfterSeconds(
        response.headers.get("retry-after"),
        bodyRetryAfter,
      );
      const rateLimited = response.status === 429;
      throw new SandboxAttestationError(
        `sandbox attestor at ${parsedEndpoint.display} responded ${response.status} for ` +
          `${input.kind} ${input.address}` +
          (rateLimited
            ? ` (rate-limited${retryAfterSeconds !== null ? `; retry after ${retryAfterSeconds}s` : ""})`
            : "") +
          "",
        { status: response.status, retryAfterSeconds, body: bodyText },
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyText) as unknown;
    } catch (cause) {
      throw new SandboxAttestationError(
        `sandbox attestor at ${parsedEndpoint.display} returned ${response.status} but the body is not JSON`,
        { status: response.status, cause },
      );
    }
    const exactObject =
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      Object.keys(payload).length === 1 &&
      Object.prototype.hasOwnProperty.call(payload, "signature");
    const signature = exactObject
      ? (payload as { signature?: unknown }).signature
      : undefined;
    if (!isCanonicalSignature(signature)) {
      throw new SandboxAttestationError(
        `sandbox attestor at ${parsedEndpoint.display} returned ${response.status} but no valid canonical base58 transaction ` +
          `"signature" in the body`,
        { status: response.status, body: JSON.stringify(payload) },
      );
    }
    return { signature };
  };

  try {
    return await Promise.race([perform(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
