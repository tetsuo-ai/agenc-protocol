// AGENT_METADATA v1 validator + renderer — the P7.3 versioned agent-identity
// standard. The wire standard itself is documented in docs/AGENT_METADATA.md
// and published as the JSON Schema
// https://agenc.tech/schemas/agent-metadata-v1.schema.json
// (schemas/agent-metadata.schema.json). This module is the reference
// implementation: a self-contained structural validator (no JSON-Schema
// runtime, mirroring the hand-rolled codecs in listing.ts) plus a tiny
// renderer that flattens a *validated* document into a provider-card view
// model.
//
// Browser-safe: no Node built-ins, no `Buffer`. The validator is pure and
// synchronous.
//
// SCOPE: this is an off-chain client/indexer contract. The program never reads
// this document. `operatorDomain` is an unverified *claim* on its own — the
// trustless "verified" signal comes from the on-chain `AgentVerification`
// attestation (P7.3 step 2), NOT from this field. The renderer therefore never
// emits a verified badge; callers fold in on-chain verification separately.

/** The AGENT_METADATA major version this module validates and renders. */
export const AGENT_METADATA_VERSION = 1 as const;

/** Canonical `$id` of the published JSON Schema this validator implements. */
export const AGENT_METADATA_SCHEMA_ID =
  "https://agenc.tech/schemas/agent-metadata-v1.schema.json";

/** Operator contact channels (all optional; unknown channels are preserved). */
export interface AgentContact {
  /** Operator contact email. */
  email?: string;
  /** Contact or support page (https). */
  url?: string;
  /** X / Twitter handle without the leading `@`. */
  x?: string;
  /** Forward-compatible: unknown contact channels are kept verbatim. */
  [extra: string]: unknown;
}

/**
 * A structurally-valid AGENT_METADATA v1 document. `version` and `name` are
 * required; everything else is optional. Unknown top-level fields are
 * preserved (v1 evolves additively — readers MUST ignore unknown fields).
 */
export interface AgentMetadata {
  /** Schema major version; always `1` for a v1 document. */
  version: typeof AGENT_METADATA_VERSION;
  /** Human-facing agent display name (1..120 chars). */
  name: string;
  /** What the agent does (Markdown/plain text, ≤4000 chars). */
  description?: string;
  /**
   * Registrable domain the operator *claims* to control (bare hostname). This
   * claim is UNVERIFIED by itself — see the on-chain AgentVerification
   * attestation for the trustless signal.
   */
  operatorDomain?: string;
  /** Operator contact channels. */
  contact?: AgentContact;
  /** URI to the agent logo (https/ipfs/ar/agenc). */
  logo?: string;
  /** URI to the operator terms-of-service (https/ipfs/ar/agenc). */
  tosUri?: string;
  /** Forward-compatible: unknown top-level fields are kept verbatim. */
  [extra: string]: unknown;
}

/** A single validation failure, keyed by JSON-pointer-ish field path. */
export interface AgentMetadataError {
  /** Dotted path to the offending value, e.g. `"contact.email"` or `"name"`. */
  path: string;
  /** Human-readable explanation of why the value is invalid. */
  message: string;
}

/**
 * Result of {@link validateAgentMetadata}: a discriminated union so callers
 * narrow on `valid`. On success `value` is the input typed as
 * {@link AgentMetadata} (unknown fields preserved); on failure `errors` is a
 * non-empty list and `value` is `undefined`.
 */
export type AgentMetadataResult =
  | { valid: true; value: AgentMetadata; errors: readonly [] }
  | { valid: false; value: undefined; errors: readonly AgentMetadataError[] };

// Bounds mirror schemas/agent-metadata.schema.json EXACTLY — keep in sync.
const NAME_MAX = 120;
const DESCRIPTION_MAX = 4000;
const DOMAIN_MAX = 253;
const EMAIL_MAX = 254;
const URL_MAX = 2048;
const X_HANDLE_MAX = 15;

// Bare-hostname (registrable domain) rule: ≥2 labels, each 1..63 of
// [A-Za-z0-9-], no leading/trailing hyphen, no scheme/port/path. Matches the
// schema `pattern`.
const DOMAIN_PATTERN =
  /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;
const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
// Pragmatic email shape (one @, non-empty local + domain, a dot in the domain).
// Deliberately permissive — full RFC 5322 is not the job of a wire validator.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTPS_URL_PATTERN = /^https:\/\/[^\s]+$/;
// Logo / ToS / generic URIs: scheme-allowlisted, no whitespace.
const ASSET_URI_PATTERN = /^(?:https|ipfs|ar|agenc):\/\/[^\s]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkString(
  value: unknown,
  path: string,
  max: number,
  errors: AgentMetadataError[],
  { minLength = 0 }: { minLength?: number } = {},
): value is string {
  if (typeof value !== "string") {
    errors.push({ path, message: `must be a string` });
    return false;
  }
  if (value.length < minLength) {
    errors.push({ path, message: `must be at least ${minLength} character(s)` });
    return false;
  }
  if (value.length > max) {
    errors.push({ path, message: `must be at most ${max} characters (got ${value.length})` });
    return false;
  }
  return true;
}

/**
 * Validates `input` against the AGENT_METADATA v1 standard
 * (schemas/agent-metadata.schema.json) WITHOUT a JSON-Schema runtime.
 *
 * Always returns a result (never throws): on success `valid: true` and `value`
 * is the same object typed as {@link AgentMetadata}; on failure `valid: false`
 * with a non-empty `errors` array. Unknown fields are accepted and preserved
 * (additive evolution). Optional fields are validated only when present;
 * `version` and `name` are required.
 *
 * This does NOT verify domain control: a present `operatorDomain` is a claim,
 * not proof — see docs/AGENT_METADATA.md and the on-chain AgentVerification
 * attestation (P7.3 step 2).
 *
 * @param input - The parsed JSON document (any value).
 * @returns A {@link AgentMetadataResult} discriminated on `valid`.
 *
 * @example
 * ```ts
 * const res = validateAgentMetadata(JSON.parse(text));
 * if (!res.valid) for (const e of res.errors) console.warn(e.path, e.message);
 * else renderAgentMetadata(res.value);
 * ```
 */
export function validateAgentMetadata(input: unknown): AgentMetadataResult {
  const errors: AgentMetadataError[] = [];

  if (!isPlainObject(input)) {
    return {
      valid: false,
      value: undefined,
      errors: [{ path: "$", message: "document must be a JSON object" }],
    };
  }

  // version — required, must be the literal 1.
  if (!("version" in input)) {
    errors.push({ path: "version", message: "is required" });
  } else if (input.version !== AGENT_METADATA_VERSION) {
    errors.push({
      path: "version",
      message: `must be ${AGENT_METADATA_VERSION} (got ${JSON.stringify(input.version)})`,
    });
  }

  // name — required, 1..120.
  if (!("name" in input)) {
    errors.push({ path: "name", message: "is required" });
  } else {
    checkString(input.name, "name", NAME_MAX, errors, { minLength: 1 });
  }

  // description — optional, ≤4000.
  if (input.description !== undefined) {
    checkString(input.description, "description", DESCRIPTION_MAX, errors);
  }

  // operatorDomain — optional bare hostname.
  if (input.operatorDomain !== undefined) {
    if (checkString(input.operatorDomain, "operatorDomain", DOMAIN_MAX, errors, { minLength: 1 })) {
      if (!DOMAIN_PATTERN.test(input.operatorDomain)) {
        errors.push({
          path: "operatorDomain",
          message:
            "must be a bare registrable hostname (no scheme/port/path), e.g. \"acme.example\"",
        });
      }
    }
  }

  // contact — optional object with optional channels.
  if (input.contact !== undefined) {
    if (!isPlainObject(input.contact)) {
      errors.push({ path: "contact", message: "must be an object" });
    } else {
      const c = input.contact;
      if (c.email !== undefined && checkString(c.email, "contact.email", EMAIL_MAX, errors)) {
        if (!EMAIL_PATTERN.test(c.email)) {
          errors.push({ path: "contact.email", message: "is not a valid email address" });
        }
      }
      if (c.url !== undefined && checkString(c.url, "contact.url", URL_MAX, errors)) {
        if (!HTTPS_URL_PATTERN.test(c.url)) {
          errors.push({ path: "contact.url", message: "must be an https URL" });
        }
      }
      if (c.x !== undefined && checkString(c.x, "contact.x", X_HANDLE_MAX, errors)) {
        if (!X_HANDLE_PATTERN.test(c.x)) {
          errors.push({
            path: "contact.x",
            message: "must be an X handle (1-15 of [A-Za-z0-9_], no leading @)",
          });
        }
      }
    }
  }

  // logo — optional asset URI.
  if (input.logo !== undefined && checkString(input.logo, "logo", URL_MAX, errors)) {
    if (!ASSET_URI_PATTERN.test(input.logo)) {
      errors.push({
        path: "logo",
        message: "must be an https/ipfs/ar/agenc URI (no http or data: URIs)",
      });
    }
  }

  // tosUri — optional asset URI.
  if (input.tosUri !== undefined && checkString(input.tosUri, "tosUri", URL_MAX, errors)) {
    if (!ASSET_URI_PATTERN.test(input.tosUri)) {
      errors.push({
        path: "tosUri",
        message: "must be an https/ipfs/ar/agenc URI (no http or data: URIs)",
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, value: undefined, errors };
  }
  // Validated: the input matches the AgentMetadata shape (unknown fields kept).
  return { valid: true, value: input as unknown as AgentMetadata, errors: [] };
}

/**
 * A flat, render-ready view of an agent's metadata for a provider card. Every
 * field is a plain string or `undefined`; nothing here implies trust. Domain
 * verification is NOT encoded here — fold in the on-chain AgentVerification
 * result at the call site before showing any "verified" affordance.
 */
export interface AgentMetadataView {
  /** Display name. */
  name: string;
  /** Description, or `undefined` if unset. */
  description?: string;
  /** Claimed operator domain (UNVERIFIED), or `undefined`. */
  operatorDomain?: string;
  /** First available contact line as `"email"` / `"url"` / `"@handle"`, or `undefined`. */
  contact?: string;
  /** Logo URI, or `undefined`. */
  logo?: string;
  /** Terms-of-service URI, or `undefined`. */
  tosUri?: string;
}

/**
 * Flattens a *validated* {@link AgentMetadata} document into a provider-card
 * {@link AgentMetadataView}. Pure and synchronous; does no fetching and adds no
 * trust signal (the claimed `operatorDomain` is passed through as a claim — the
 * caller folds in on-chain verification separately).
 *
 * Pass the `value` from a successful {@link validateAgentMetadata} call; on
 * untrusted input, validate first.
 *
 * @param meta - A validated AGENT_METADATA v1 document.
 * @returns A flat, render-ready view model.
 *
 * @example
 * ```ts
 * const res = validateAgentMetadata(doc);
 * if (res.valid) {
 *   const view = renderAgentMetadata(res.value);
 *   // view.operatorDomain is a CLAIM — gate any badge on on-chain verification.
 * }
 * ```
 */
export function renderAgentMetadata(meta: AgentMetadata): AgentMetadataView {
  let contact: string | undefined;
  if (meta.contact) {
    if (typeof meta.contact.email === "string") contact = meta.contact.email;
    else if (typeof meta.contact.url === "string") contact = meta.contact.url;
    else if (typeof meta.contact.x === "string") contact = `@${meta.contact.x}`;
  }
  return {
    name: meta.name,
    description: meta.description,
    operatorDomain: meta.operatorDomain,
    contact,
    logo: meta.logo,
    tosUri: meta.tosUri,
  };
}
