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
import { isProxy } from "node:util/types";

/**
 * Canonicalization version. Pinned into every hash preimage. If the backend ever
 * bumps this, third parties must upgrade in lockstep or every attestation
 * request will be rejected.
 */
export const CANONICALIZATION_VERSION = "agenc-task-moderation-c14n-v1";

/**
 * Canonicalization version for the complete, fail-closed structured semantic
 * payload. It is deliberately separate from v1: a backend must explicitly
 * advertise `job_spec_semantic_v2` before callers send this wire format.
 */
export const CANONICALIZATION_VERSION_V2 = "agenc-task-moderation-c14n-v2";

/** Kind of the complete v2 semantic envelope. */
export const JOB_SPEC_SEMANTIC_PAYLOAD_KIND_V2 =
  "agenc.marketplace.jobSpecSemanticModerationPayloadV2";

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

function compactRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) => entry !== undefined && entry !== null,
    ),
  );
}

function stringArrayField(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return strings.length > 0 ? strings : undefined;
}

/**
 * Deterministic encoding of the strict JSON data model: object keys are sorted
 * lexicographically and all non-JSON values, sparse arrays, exotic objects,
 * accessors, and cycles are rejected. This preserves v1 bytes for actual JSON
 * while preventing programmatic values from colliding through JSON's usual
 * omission/coercion rules.
 */
export function canonicalJson(value: unknown): string {
  const active = new WeakSet<object>();
  const encode = (entry: unknown, path: string, depth: number): string => {
    if (depth > 256) {
      throw new TypeError(`Canonical JSON exceeds maximum depth at ${path}`);
    }
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    ) {
      return JSON.stringify(entry);
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new TypeError(`Canonical JSON numbers must be finite at ${path}`);
      }
      return JSON.stringify(entry);
    }
    if (typeof entry !== "object") {
      throw new TypeError(
        `Canonical JSON does not support ${typeof entry} at ${path}`,
      );
    }
    if (isProxy(entry)) {
      throw new TypeError(`Canonical JSON does not support proxies at ${path}`);
    }
    if (active.has(entry)) {
      throw new TypeError(`Canonical JSON does not support cycles at ${path}`);
    }
    active.add(entry);
    try {
      if (Array.isArray(entry)) {
        const descriptors = Object.getOwnPropertyDescriptors(
          entry,
        ) as unknown as Record<PropertyKey, PropertyDescriptor>;
        const lengthDescriptor = descriptors["length"];
        const length = lengthDescriptor?.value as unknown;
        const ownKeys = Reflect.ownKeys(descriptors).filter(
          (key) => key !== "length",
        );
        if (
          !("value" in (lengthDescriptor ?? {})) ||
          !Number.isSafeInteger(length) ||
          (length as number) < 0 ||
          ownKeys.some(
            (key) =>
              typeof key !== "string" ||
              !/^(?:0|[1-9]\d*)$/u.test(key) ||
              Number(key) >= (length as number) ||
              !descriptors[key]?.enumerable ||
              !("value" in descriptors[key]),
          ) ||
          ownKeys.length !== length
        ) {
          throw new TypeError(
            `Canonical JSON arrays must be dense and have no extra properties at ${path}`,
          );
        }
        // Encode the validated descriptor snapshot. Re-reading `entry[index]`
        // (including through Array#map) would let a Proxy change/omit values
        // after validation and collide with a different JSON array.
        return `[${Array.from({ length: length as number }, (_, index) =>
          encode(
            descriptors[String(index)]!.value,
            `${path}[${index}]`,
            depth + 1,
          ),
        ).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`Canonical JSON requires plain objects at ${path}`);
      }
      const object = entry as Record<string, unknown>;
      const descriptors = Object.getOwnPropertyDescriptors(object);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (
        ownKeys.some((key) => typeof key !== "string") ||
        Object.values(descriptors).some(
          (descriptor) =>
            !descriptor.enumerable ||
            !("value" in descriptor) ||
            descriptor.get !== undefined ||
            descriptor.set !== undefined,
        )
      ) {
        throw new TypeError(
          `Canonical JSON objects require enumerable string data properties at ${path}`,
        );
      }
      return `{${ownKeys
        .filter((key): key is string => typeof key === "string")
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${encode(descriptors[key]!.value, `${path}.${key}`, depth + 1)}`,
        )
        .join(",")}}`;
    } finally {
      active.delete(entry);
    }
  };
  return encode(value, "$", 0);
}

/**
 * The exact canonical preimage the moderation payload hash is computed over:
 * `canonicalJson({ canonicalizationVersion, payload })`. Exposed so third
 * parties can inspect/verify the bytes that get hashed.
 */
export function canonicalizeTaskModerationPayload(payload: unknown): string {
  return canonicalJson({
    canonicalizationVersion: CANONICALIZATION_VERSION,
    payload,
  });
}

/**
 * `moderationPayloadHash` = `sha256(canonicalizeTaskModerationPayload(payload))`,
 * lowercase hex. This is the value the backend re-derives and compares.
 */
export function computeTaskModerationPayloadHash(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalizeTaskModerationPayload(payload))
    .digest("hex");
}

/** The complete v2 canonical preimage, distinct from the published v1 wire. */
export function canonicalizeTaskModerationPayloadV2(payload: unknown): string {
  return canonicalJson({
    canonicalizationVersion: CANONICALIZATION_VERSION_V2,
    payload,
  });
}

/** SHA-256 of {@link canonicalizeTaskModerationPayloadV2}, lowercase hex. */
export function computeTaskModerationPayloadHashV2(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalizeTaskModerationPayloadV2(payload))
    .digest("hex");
}

/** True when `value` is an already-reduced semantic moderation payload. */
export function isJobSpecSemanticModerationPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    objectField(value, "kind") ===
      "agenc.marketplace.jobSpecSemanticModerationPayload"
  );
}

/** True when `value` is a complete v2 semantic moderation envelope. */
export function isJobSpecSemanticModerationPayloadV2(value: unknown): boolean {
  return (
    isRecord(value) &&
    objectField(value, "kind") === JOB_SPEC_SEMANTIC_PAYLOAD_KIND_V2 &&
    objectField(value, "schemaVersion") === 2 &&
    isRecord(objectField(value, "jobSpec")) &&
    objectField(objectField(value, "jobSpec"), "kind") ===
      "agenc.marketplace.jobSpec"
  );
}

/**
 * Extract the legacy c14n-v1 semantic subset from a marketplace job spec
 * (accepting either a bare `agenc.marketplace.jobSpec` or an
 * `agenc.marketplace.jobSpecEnvelope` wrapping one). This byte-compatible v1
 * subset omits `constraints` and `execution`; it must not be treated as a
 * complete safety preimage for current job specs. Use
 * {@link moderationPayloadFromJobSpecLikeV2} for complete worker-visible input.
 * Returns `null` when the input is not a recognizable marketplace job spec.
 */
export function moderationPayloadFromJobSpecLike(
  jobSpec: unknown,
): Record<string, unknown> | null {
  const rootKind = objectField(jobSpec, "kind");
  const payload =
    rootKind === "agenc.marketplace.jobSpecEnvelope"
      ? objectField(jobSpec, "payload")
      : jobSpec;
  if (!isRecord(payload)) return null;
  if (objectField(payload, "kind") !== "agenc.marketplace.jobSpec") return null;
  return compactRecord({
    kind: "agenc.marketplace.jobSpecSemanticModerationPayload",
    schemaVersion: 1,
    title: objectField(payload, "title"),
    shortDescription: objectField(
      payload,
      "shortDescription",
      "short_description",
    ),
    fullDescription: objectField(
      payload,
      "fullDescription",
      "full_description",
    ),
    acceptanceCriteria: stringArrayField(
      objectField(payload, "acceptanceCriteria", "acceptance_criteria"),
    ),
    deliverables: stringArrayField(objectField(payload, "deliverables")),
    attachments: objectField(payload, "attachments"),
    context: objectField(payload, "context"),
    custom: objectField(payload, "custom"),
  });
}

/**
 * Build the complete v2 semantic envelope from a marketplace job spec.
 *
 * Unlike the published v1 reduction, this retains the entire payload consumed
 * by workers, including `constraints`, `execution`, and unknown future
 * extension fields. An outer envelope's integrity/bookkeeping fields are not
 * copied because the worker receives `envelope.payload`, not the envelope.
 */
export function moderationPayloadFromJobSpecLikeV2(
  jobSpec: unknown,
): Record<string, unknown> | null {
  const rootKind = objectField(jobSpec, "kind");
  const payload =
    rootKind === "agenc.marketplace.jobSpecEnvelope"
      ? objectField(jobSpec, "payload")
      : jobSpec;
  if (!isRecord(payload)) return null;
  if (objectField(payload, "kind") !== "agenc.marketplace.jobSpec") return null;
  return {
    kind: JOB_SPEC_SEMANTIC_PAYLOAD_KIND_V2,
    schemaVersion: 2,
    jobSpec: payload,
  };
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

/** Input kinds a moderation backend may advertise. */
export type ModerationInputKind =
  | "job_spec_semantic_v1"
  | "job_spec_semantic_v2"
  | "plain_text";

/** Explicit backend capabilities required by the fail-closed normalizer. */
export interface StrictModerationInputOptions {
  readonly supportedInputKinds: readonly ModerationInputKind[];
}

/** Result of {@link normalizeTaskModerationInputStrict}. */
export interface StrictNormalizedModerationInput {
  readonly text: string;
  readonly inputKind: "job_spec_semantic_v2" | "plain_text";
  readonly payloadHash: string;
}

/**
 * Stable error raised when structured input cannot be represented without
 * silently omitting worker-visible semantics.
 */
export class UnsupportedStructuredModerationInputError extends Error {
  readonly code = "UNSUPPORTED_STRUCTURED_MODERATION_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "UnsupportedStructuredModerationInputError";
  }
}

function assertBackendSupports(
  options: StrictModerationInputOptions,
  kind: "job_spec_semantic_v2" | "plain_text",
): void {
  if (
    options === null ||
    typeof options !== "object" ||
    !Array.isArray(options.supportedInputKinds) ||
    !options.supportedInputKinds.includes(kind)
  ) {
    throw new UnsupportedStructuredModerationInputError(
      `Moderation backend does not advertise ${kind}`,
    );
  }
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
export function normalizeTaskModerationInput(
  input: string,
): NormalizedModerationInput {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isJobSpecSemanticModerationPayload(parsed)) {
        return {
          text: JSON.stringify(parsed),
          inputKind: "job_spec_semantic_v1",
          payloadHash: computeTaskModerationPayloadHash(parsed),
        };
      }
      const semantic = moderationPayloadFromJobSpecLike(parsed);
      if (semantic) {
        return {
          text: JSON.stringify(semantic),
          inputKind: "job_spec_semantic_v1",
          payloadHash: computeTaskModerationPayloadHash(semantic),
        };
      }
    } catch {
      // Malformed JSON → scan as plain text.
    }
  }
  return {
    text: input,
    inputKind: "plain_text",
    payloadHash: computeTaskModerationPayloadHash(input),
  };
}

/**
 * Normalize input without allowing a structured job spec to downgrade to the
 * incomplete v1 semantic reduction or to plain text.
 *
 * Callers must pass the input kinds advertised by the moderation backend. A
 * recognized job spec is emitted only when `job_spec_semantic_v2` is present;
 * otherwise this function fails before a request can be sent. Unknown JSON
 * objects and already-reduced v1 payloads also fail closed because completeness
 * cannot be established. Plain text remains on the interoperable c14n-v1 hash.
 */
export function normalizeTaskModerationInputStrict(
  input: string,
  options: StrictModerationInputOptions,
): StrictNormalizedModerationInput {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      assertBackendSupports(options, "plain_text");
      return {
        text: input,
        inputKind: "plain_text",
        payloadHash: computeTaskModerationPayloadHash(input),
      };
    }

    if (isRecord(parsed)) {
      assertBackendSupports(options, "job_spec_semantic_v2");
      const semantic = isJobSpecSemanticModerationPayloadV2(parsed)
        ? parsed
        : moderationPayloadFromJobSpecLikeV2(parsed);
      if (semantic === null) {
        throw new UnsupportedStructuredModerationInputError(
          "Structured moderation input is unknown or already incomplete",
        );
      }
      return {
        text: JSON.stringify(semantic),
        inputKind: "job_spec_semantic_v2",
        payloadHash: computeTaskModerationPayloadHashV2(semantic),
      };
    }
  }

  assertBackendSupports(options, "plain_text");
  return {
    text: input,
    inputKind: "plain_text",
    payloadHash: computeTaskModerationPayloadHash(input),
  };
}
