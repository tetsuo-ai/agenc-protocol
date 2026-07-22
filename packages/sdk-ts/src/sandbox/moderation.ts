// SDK half of the Phase-3 public moderation API (PLAN.md P3.4): a fetch-based,
// browser-safe client for the storefront `POST /api/moderation/listings`
// endpoint — submit a job spec (or its URI), get a scan verdict, and (when the
// service holds a moderation-authority signer and the verdict is CLEAN) the
// recorded on-chain attestation.
//
// NOT DEVNET-ONLY (despite living beside the devnet sandbox helpers): this
// helper targets whatever moderation endpoint the environment seam resolves —
// including the configured PRODUCTION/mainnet hosted moderation API. It holds
// no key, sends no funds, and broadcasts nothing; it only POSTs a spec. It is
// re-exported from the package root (`@tetsuo-ai/marketplace-sdk`) so mainnet
// integrators need not reach for the "DEVNET ONLY" `/sandbox` subpath.
//
// Browser-safe: fetch only — no Node built-ins anywhere in this module.
import type { Address } from "@solana/kit";
import { resolveSandboxEnvironment } from "./environment.js";
import { SANDBOX_FIXTURES } from "./fixtures.js";
import type { SandboxFetchLike } from "./attest.js";
export type { SandboxFetchLike } from "./attest.js";

/** The three moderation verdicts the scan endpoint can return. */
export type ListingModerationVerdict = "clean" | "suspicious" | "blocked";

/**
 * The on-chain attestation recorded for a CLEAN verdict, when the moderation
 * service holds a signer and the request named a listing PDA; `null` when the
 * scan was verdict-only (no `listing`, no signer configured, or a non-clean
 * verdict).
 */
export interface ListingModerationAttestation {
  /** Signature of the transaction that recorded the `ListingModeration`. */
  signature: string;
  /** ISO-8601 timestamp of when the attestation was recorded. */
  recordedAt: string;
}

/** Input for {@link requestListingModeration}. */
export interface RequestListingModerationInput {
  /**
   * The job-spec envelope payload object to scan, posted as-is. Exactly one
   * of `spec` / `specUri` must be provided.
   */
  spec?: Record<string, unknown>;
  /**
   * URI of the job spec to scan (the service fetches and hashes it). Exactly
   * one of `spec` / `specUri` must be provided.
   */
  specUri?: string;
  /**
   * Optional ServiceListing PDA. When provided and the verdict is `"clean"`
   * and the service holds a moderation-authority signer, the service records
   * the on-chain `ListingModeration` and returns the attestation.
   */
  listing?: Address;
  /**
   * Override the moderation endpoint. Default: the environment seam's
   * resolved `moderationUrl` (`AGENC_SANDBOX_MODERATION_URL` / the env-file
   * `moderationUrl` field). There is NO shipped default endpoint — when
   * nothing resolves, this function throws a descriptive error instead of
   * dialing a dead URL.
   */
  endpoint?: string;
  /** Override the fetch implementation (tests / custom transports). */
  fetch?: SandboxFetchLike;
}

/**
 * The moderation response: scan verdict + risk score, the canonical spec hash
 * the verdict applies to, the attestation (when recorded), and the hash of
 * the policy document the verdict committed to (served at
 * `GET /api/moderation/policy`).
 */
export interface ListingModerationResult {
  /** Scan verdict: `"clean"`, `"suspicious"`, or `"blocked"`. */
  verdict: ListingModerationVerdict;
  /** Risk score in `[0, 100]` (higher = riskier). */
  riskScore: number;
  /** Lowercase hex sha256 of the canonical job spec the verdict applies to. */
  specHash: string;
  /** Recorded on-chain attestation, or `null` (see the field docs). */
  attestation: ListingModerationAttestation | null;
  /** Lowercase hex sha256 of the moderation policy document. */
  policyHash: string;
}

/**
 * Typed failure from the moderation endpoint: a network-layer fetch rejection
 * (`status` 0 — DNS failure, refused connection, no network), any non-2xx
 * HTTP response, or a 2xx response whose body is not the expected moderation
 * JSON.
 */
export class ListingModerationError extends Error {
  /**
   * HTTP status code of the moderation response, or `0` when the request
   * never produced an HTTP response at all (network-layer fetch failure).
   */
  readonly status: number;
  /** Raw response body text (when readable), for diagnostics. */
  readonly body: string | null;

  constructor(
    message: string,
    options: { status: number; body?: string | null; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "ListingModerationError";
    this.status = options.status;
    this.body = options.body ?? null;
  }
}

const VERDICTS: readonly string[] = ["clean", "suspicious", "blocked"];

/** Structurally validate + narrow a parsed 2xx body, or return a problem. */
function parseModerationBody(
  payload: unknown,
): { ok: true; result: ListingModerationResult } | { ok: false; problem: string } {
  if (payload === null || typeof payload !== "object") {
    return { ok: false, problem: "body is not a JSON object" };
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.verdict !== "string" || !VERDICTS.includes(body.verdict)) {
    return {
      ok: false,
      problem: `"verdict" must be one of ${VERDICTS.join("|")}`,
    };
  }
  if (typeof body.riskScore !== "number" || !Number.isFinite(body.riskScore)) {
    return { ok: false, problem: '"riskScore" must be a finite number' };
  }
  if (typeof body.specHash !== "string") {
    return { ok: false, problem: '"specHash" must be a string' };
  }
  if (typeof body.policyHash !== "string") {
    return { ok: false, problem: '"policyHash" must be a string' };
  }
  let attestation: ListingModerationAttestation | null = null;
  if (body.attestation !== null && body.attestation !== undefined) {
    const att = body.attestation as Record<string, unknown>;
    if (
      typeof att !== "object" ||
      typeof att.signature !== "string" ||
      typeof att.recordedAt !== "string"
    ) {
      return {
        ok: false,
        problem:
          '"attestation" must be null or { signature: string, recordedAt: string }',
      };
    }
    attestation = { signature: att.signature, recordedAt: att.recordedAt };
  }
  return {
    ok: true,
    result: {
      verdict: body.verdict as ListingModerationVerdict,
      riskScore: body.riskScore,
      specHash: body.specHash,
      attestation,
      policyHash: body.policyHash,
    },
  };
}

/**
 * Submit a job spec to the Phase-3 public moderation API
 * (`POST /api/moderation/listings`) and get a scan verdict — plus the
 * recorded on-chain `ListingModeration` attestation when the verdict is
 * `"clean"`, a `listing` PDA was provided, and the service holds a
 * moderation-authority signer.
 *
 * POSTs `{ spec | specUri, listing? }` and resolves with the typed
 * {@link ListingModerationResult}.
 *
 * ## Endpoint resolution
 *
 * 1. the explicit `endpoint` option;
 * 2. the environment seam's `moderationUrl`
 *    (`AGENC_SANDBOX_MODERATION_URL` env var — the `.localnet/env.json`
 *    convention carries it as the `moderationUrl` field);
 * 3. otherwise this function **throws** a descriptive error — there is no
 *    shipped default endpoint while the hosted moderation API is
 *    deploy-gated.
 *
 * @param input - Spec (or spec URI), optional listing PDA, and optional
 *   endpoint/fetch overrides.
 * @returns The typed moderation result.
 * @throws TypeError when neither or both of `spec` / `specUri` are provided.
 * @throws Error when no endpoint resolves (pass the `endpoint` option or set
 *   `AGENC_SANDBOX_MODERATION_URL`).
 * @throws {@link ListingModerationError} when the endpoint cannot be reached
 *   (`status` 0), on any non-2xx response, or on a malformed 2xx body.
 *
 * @example
 * ```ts
 * const result = await requestListingModeration({
 *   spec: jobSpecEnvelope.payload,
 *   listing: listingPda,
 * });
 * if (result.verdict === "clean" && result.attestation !== null) {
 *   // the fail-closed hire gate will pass once the PDA appears
 * }
 * ```
 */
export async function requestListingModeration(
  input: RequestListingModerationInput,
): Promise<ListingModerationResult> {
  const hasSpec = input.spec !== undefined;
  const hasSpecUri = input.specUri !== undefined;
  if (hasSpec === hasSpecUri) {
    throw new TypeError(
      hasSpec
        ? "requestListingModeration: pass exactly one of `spec` or `specUri`, not both"
        : "requestListingModeration: one of `spec` (the job-spec envelope " +
          "payload object) or `specUri` is required",
    );
  }

  // Endpoint resolution: explicit option > AGENC_SANDBOX_MODERATION_URL >
  // throw. The shipped fixtures are passed through so moderation never
  // depends on an AGENC_SANDBOX_FIXTURES file it does not use.
  let endpoint = input.endpoint;
  if (endpoint === undefined) {
    const { moderationUrl } = await resolveSandboxEnvironment({
      fixtures: SANDBOX_FIXTURES,
    });
    if (moderationUrl === null) {
      throw new Error(
        "requestListingModeration: no moderation endpoint configured for this " +
          "cluster — pass the `endpoint` option or set the " +
          "AGENC_SANDBOX_MODERATION_URL environment variable (the localnet " +
          "stack's .localnet/env.json carries it as `moderationUrl`). Mainnet " +
          "ships a default (attest.agenc.ag); localnet/devnet point at your " +
          "own attestor.",
      );
    }
    endpoint = moderationUrl;
  }

  // Wrapped so the global fetch keeps its expected receiver in browsers.
  const fetchImpl: SandboxFetchLike =
    input.fetch ?? ((url, init) => globalThis.fetch(url, init));

  const requestBody: Record<string, unknown> = hasSpec
    ? { spec: input.spec }
    : { specUri: input.specUri };
  if (input.listing !== undefined) requestBody.listing = input.listing;

  let response: Awaited<ReturnType<SandboxFetchLike>>;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  } catch (cause) {
    throw new ListingModerationError(
      `moderation endpoint at ${endpoint} could not be reached (the fetch ` +
        `itself failed before any HTTP response)`,
      { status: 0, cause },
    );
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => null);
    throw new ListingModerationError(
      `moderation endpoint at ${endpoint} responded ${response.status}` +
        (bodyText ? `: ${bodyText}` : ""),
      { status: response.status, body: bodyText },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new ListingModerationError(
      `moderation endpoint at ${endpoint} returned ${response.status} but ` +
        `the body is not JSON`,
      { status: response.status, cause },
    );
  }
  const parsed = parseModerationBody(payload);
  if (!parsed.ok) {
    throw new ListingModerationError(
      `moderation endpoint at ${endpoint} returned ${response.status} but ` +
        `the body is not a moderation response: ${parsed.problem}`,
      { status: response.status, body: JSON.stringify(payload) },
    );
  }
  return parsed.result;
}
