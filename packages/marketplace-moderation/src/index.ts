/**
 * `@tetsuo-ai/marketplace-moderation` — the OPEN, MIT-licensed reference
 * implementation of the AgenC task-moderation **payload canonicalization**
 * (`agenc-task-moderation-c14n-v1`).
 *
 * ## Why this package exists
 *
 * When a marketplace asks the AgenC moderation attestation service to
 * policy-check and attest a task, it sends a `text` blob plus a
 * `moderationPayloadHash`. The backend **re-derives** that hash from the `text`
 * it receives, using the exact algorithm below, and REJECTS the request if the
 * two do not match (`payloadHash ... does not match scanned input`). So any
 * third party that wants to request attestation must compute
 * `moderationPayloadHash` byte-for-byte the same way — the raw job-spec sha-256
 * is NOT it.
 *
 * This is the interoperability contract, published so anyone can integrate. The
 * hashing here is a clean-room, MIT reference of the `agenc-task-moderation-c14n-v1`
 * canonicalization spec (see README); it carries no proprietary or entitlement
 * logic.
 *
 * Sole dependency: `node:crypto` `createHash`.
 *
 * @example Compute the payload hash the backend demands
 * ```ts
 * import { normalizeTaskModerationInput } from "@tetsuo-ai/marketplace-moderation";
 *
 * const { text, inputKind, payloadHash } = normalizeTaskModerationInput(jobSpecText);
 * // POST { text, moderationInputKind: inputKind, moderationPayloadHash: payloadHash, ... }
 * ```
 *
 * @packageDocumentation
 */
import { createHash } from "node:crypto";

/**
 * Canonicalization version. Pinned into every hash preimage. If the backend ever
 * bumps this, third parties must upgrade in lockstep or every attestation
 * request will be rejected.
 */
export const CANONICALIZATION_VERSION = "agenc-task-moderation-c14n-v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectField(value: unknown, ...names: readonly string[]): unknown {
  if (!isRecord(value)) return undefined;
  for (const name of names) {
    if (value[name] !== undefined) return value[name];
  }
  return undefined;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function stringArrayField(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

/**
 * Deterministic JSON encoding: object keys sorted lexicographically, `undefined`
 * and function values dropped, `bigint` rendered as its decimal string, and
 * `Uint8Array` rendered as a plain number array. This is the canonical form the
 * hash is taken over — two structurally-equal payloads always encode to the same
 * bytes regardless of input key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Uint8Array) return canonicalJson(Array.from(value));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined && typeof value[key] !== "function")
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * The exact canonical preimage the moderation payload hash is computed over:
 * `canonicalJson({ canonicalizationVersion, payload })`. Exposed so third
 * parties can inspect/verify the bytes that get hashed.
 */
export function canonicalizeTaskModerationPayload(payload: unknown): string {
  return canonicalJson({ canonicalizationVersion: CANONICALIZATION_VERSION, payload });
}

/**
 * `moderationPayloadHash` = `sha256(canonicalizeTaskModerationPayload(payload))`,
 * lowercase hex. This is the value the backend re-derives and compares.
 */
export function computeTaskModerationPayloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalizeTaskModerationPayload(payload)).digest("hex");
}

/** True when `value` is an already-reduced semantic moderation payload. */
export function isJobSpecSemanticModerationPayload(value: unknown): boolean {
  return isRecord(value) && objectField(value, "kind") === "agenc.marketplace.jobSpecSemanticModerationPayload";
}

/**
 * Extract only the creator-controlled **semantic** fields from a marketplace job
 * spec (accepting either a bare `agenc.marketplace.jobSpec` or an
 * `agenc.marketplace.jobSpecEnvelope` wrapping one). Secrets, integrity blocks,
 * and non-semantic bookkeeping are dropped. Returns `null` when the input is not
 * a recognizable marketplace job spec.
 */
export function moderationPayloadFromJobSpecLike(jobSpec: unknown): Record<string, unknown> | null {
  const rootKind = objectField(jobSpec, "kind");
  const payload = rootKind === "agenc.marketplace.jobSpecEnvelope" ? objectField(jobSpec, "payload") : jobSpec;
  if (!isRecord(payload)) return null;
  if (objectField(payload, "kind") !== "agenc.marketplace.jobSpec") return null;
  return compactRecord({
    kind: "agenc.marketplace.jobSpecSemanticModerationPayload",
    schemaVersion: 1,
    title: objectField(payload, "title"),
    shortDescription: objectField(payload, "shortDescription", "short_description"),
    fullDescription: objectField(payload, "fullDescription", "full_description"),
    acceptanceCriteria: stringArrayField(objectField(payload, "acceptanceCriteria", "acceptance_criteria")),
    deliverables: stringArrayField(objectField(payload, "deliverables")),
    attachments: objectField(payload, "attachments"),
    context: objectField(payload, "context"),
    custom: objectField(payload, "custom"),
  });
}

/**
 * The `(text, inputKind, payloadHash)` triple a caller sends to the moderation
 * attestation service.
 */
export interface NormalizedModerationInput {
  /** Exactly what to send as `text` to the attestation service. */
  readonly text: string;
  /** `moderationInputKind` to send. */
  readonly inputKind: "job_spec_semantic_v1" | "plain_text";
  /** `moderationPayloadHash` to send (the backend re-derives + compares this). */
  readonly payloadHash: string;
}

/**
 * Normalize a creator-supplied job-spec string into the `(text, inputKind,
 * payloadHash)` triple the moderation attestation service expects.
 *
 * A structured `agenc.marketplace.jobSpec` (or a `...jobSpecSemanticModerationPayload`)
 * is reduced to its semantic fields; anything else (free-form JSON or text) is
 * scanned as plain text. Idempotent: feeding the returned `text` back in yields
 * the same `payloadHash`, which is exactly why the backend can re-derive and
 * compare the hash from the `text` it receives.
 */
export function normalizeTaskModerationInput(input: string): NormalizedModerationInput {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isJobSpecSemanticModerationPayload(parsed)) {
        return { text: JSON.stringify(parsed), inputKind: "job_spec_semantic_v1", payloadHash: computeTaskModerationPayloadHash(parsed) };
      }
      const semantic = moderationPayloadFromJobSpecLike(parsed);
      if (semantic) {
        return { text: JSON.stringify(semantic), inputKind: "job_spec_semantic_v1", payloadHash: computeTaskModerationPayloadHash(semantic) };
      }
    } catch {
      // Malformed JSON → scan as plain text.
    }
  }
  return { text: input, inputKind: "plain_text", payloadHash: computeTaskModerationPayloadHash(input) };
}
