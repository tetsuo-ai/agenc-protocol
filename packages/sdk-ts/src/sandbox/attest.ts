// SDK half of the P2.3 sandbox moderation auto-attestor: a fetch-based,
// browser-safe client for a self-hosted attestor service that records CLEAN
// ListingModeration / TaskModeration attestations so the fail-closed
// moderation gate passes without a human moderator.
import type { Address } from "@solana/kit";
import { resolveSandboxEnvironment } from "./environment.js";
import { SANDBOX_FIXTURES } from "./fixtures.js";

/** What the attestor is asked to moderate: a service listing or a task. */
export type SandboxAttestationKind = "listing" | "task";

/**
 * Minimal structural slice of `fetch` used by
 * {@link requestSandboxAttestation}. The global `fetch` satisfies it; tests
 * inject a fake.
 */
export type SandboxFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
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
  if (typeof bodyValue === "number" && Number.isFinite(bodyValue) && bodyValue >= 0) {
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
  // Wrapped so the global fetch keeps its expected receiver in browsers.
  const fetchImpl: SandboxFetchLike =
    input.fetch ?? ((url, init) => globalThis.fetch(url, init));

  let response: Awaited<ReturnType<SandboxFetchLike>>;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: input.kind, address: input.address, specHash }),
    });
  } catch (cause) {
    // Network-layer rejection (DNS failure, refused connection, no network):
    // there is no HTTP status, so report 0 and keep the raw error as `cause`.
    throw new SandboxAttestationError(
      `sandbox attestor at ${endpoint} could not be reached (the fetch ` +
        `itself failed before any HTTP response). Check that the attestor ` +
        `service is actually running at that URL, or point the \`endpoint\` ` +
        `option / AGENC_SANDBOX_ATTESTOR_URL at a live self-hosted attestor.`,
      { status: 0, cause },
    );
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => null);
    let bodyRetryAfter: unknown;
    if (bodyText !== null) {
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
      `sandbox attestor at ${endpoint} responded ${response.status} for ` +
        `${input.kind} ${input.address}` +
        (rateLimited
          ? ` (rate-limited${retryAfterSeconds !== null ? `; retry after ${retryAfterSeconds}s` : ""})`
          : "") +
        (bodyText ? `: ${bodyText}` : ""),
      { status: response.status, retryAfterSeconds, body: bodyText },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new SandboxAttestationError(
      `sandbox attestor at ${endpoint} returned ${response.status} but the body is not JSON`,
      { status: response.status, cause },
    );
  }
  const signature =
    payload !== null && typeof payload === "object"
      ? (payload as { signature?: unknown }).signature
      : undefined;
  if (typeof signature !== "string" || signature.length === 0) {
    throw new SandboxAttestationError(
      `sandbox attestor at ${endpoint} returned ${response.status} but no ` +
        `"signature" string in the body`,
      { status: response.status, body: JSON.stringify(payload) },
    );
  }
  return { signature };
}
