import { describe, expect, it } from "vitest";
import {
  CANONICALIZATION_VERSION,
  CANONICALIZATION_VERSION_V2,
  UnsupportedStructuredModerationInputError,
  canonicalJson,
  canonicalizeTaskModerationPayload,
  canonicalizeTaskModerationPayloadV2,
  computeTaskModerationPayloadHash,
  moderationPayloadFromJobSpecLikeV2,
  normalizeTaskModerationInput,
  normalizeTaskModerationInputStrict,
} from "../src/index.js";

// These vectors are the interoperability contract with the moderation
// attestation backend: the backend re-derives `moderationPayloadHash` from the
// `text` it receives via this exact canonicalization and REJECTS a mismatch. The
// literal hashes are PINNED and MUST match those in agenc-ag's
// apps/web/lib/__tests__/moderation-canon.test.ts byte-for-byte, or every
// third-party attestation request breaks. Change them only in lockstep with a
// backend canonicalization-version bump.
describe("agenc-task-moderation-c14n-v1", () => {
  it("pins the canonicalization version", () => {
    expect(CANONICALIZATION_VERSION).toBe("agenc-task-moderation-c14n-v1");
  });

  // A free-form (non-structured) job spec is scanned as plain text. The payload
  // hash is sha256 of the canonical {canonicalizationVersion, payload:<raw string>}.
  it("free-form spec → plain_text branch with a pinned payloadHash", () => {
    const spec = '{"title":"x","summary":"y"}';
    const n = normalizeTaskModerationInput(spec);
    expect(n.inputKind).toBe("plain_text");
    expect(n.text).toBe(spec); // plain text is forwarded verbatim
    expect(n.payloadHash).toBe(
      "83d7572f8239823a30dc57a4f6bb3451d14312ff69a8a3647a4efa734fa05fb4",
    );
  });

  // The backend re-runs the same normalization on the `text` it receives, so
  // normalizing the emitted text again MUST yield the same hash.
  it("idempotent: re-normalizing emitted text yields the same payloadHash", () => {
    const spec =
      '{"title":"Find leads","deliverables":["a","b"],"acceptance":["c"]}';
    const n1 = normalizeTaskModerationInput(spec);
    const n2 = normalizeTaskModerationInput(n1.text);
    expect(n2.payloadHash).toBe(n1.payloadHash);
  });

  it("structured agenc.marketplace.jobSpec → semantic extraction, secrets dropped, idempotent", () => {
    const spec = JSON.stringify({
      kind: "agenc.marketplace.jobSpec",
      title: "T",
      shortDescription: "s",
      fullDescription: "f",
      deliverables: ["d1"],
      acceptanceCriteria: ["a1"],
      integrity: { payloadHash: "a".repeat(64) },
      creator: "should-be-dropped",
    });
    const n = normalizeTaskModerationInput(spec);
    expect(n.inputKind).toBe("job_spec_semantic_v1");
    const semantic = JSON.parse(n.text) as Record<string, unknown>;
    expect(semantic.kind).toBe(
      "agenc.marketplace.jobSpecSemanticModerationPayload",
    );
    expect(semantic.title).toBe("T");
    expect("creator" in semantic).toBe(false); // only creator-controlled semantic fields kept
    expect(normalizeTaskModerationInput(n.text).payloadHash).toBe(
      n.payloadHash,
    );
  });

  it("malformed JSON falls back to plain text", () => {
    const n = normalizeTaskModerationInput("{not valid json");
    expect(n.inputKind).toBe("plain_text");
    expect(n.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // Lower-level surface for third parties that build the payload themselves
  // rather than going through normalizeTaskModerationInput.
  it("computeTaskModerationPayloadHash hashes the versioned canonical preimage", () => {
    const spec = '{"title":"x","summary":"y"}';
    // plain_text branch feeds the RAW string as `payload`.
    const preimage = canonicalizeTaskModerationPayload(spec);
    expect(preimage).toBe(
      `{"canonicalizationVersion":${JSON.stringify(CANONICALIZATION_VERSION)},"payload":${JSON.stringify(spec)}}`,
    );
    expect(computeTaskModerationPayloadHash(spec)).toBe(
      "83d7572f8239823a30dc57a4f6bb3451d14312ff69a8a3647a4efa734fa05fb4",
    );
  });

  it("rejects non-finite programmatic values instead of colliding with JSON null", () => {
    expect(() => canonicalizeTaskModerationPayload(Number.NaN)).toThrow(
      /finite/i,
    );
    expect(() =>
      canonicalizeTaskModerationPayload({
        nested: [1, Number.POSITIVE_INFINITY],
      }),
    ).toThrow(/finite/i);
    expect(() =>
      computeTaskModerationPayloadHash({ value: Number.NEGATIVE_INFINITY }),
    ).toThrow(/finite/i);
  });

  it("rejects every non-JSON value, omission/coercion collision, and cycle", () => {
    const unsupported: unknown[] = [
      undefined,
      1n,
      Symbol("x"),
      () => "x",
      new Uint8Array([1]),
      new Date(0),
      new Map([["x", 1]]),
      [undefined],
      { value: undefined },
      { value: () => "x" },
      { value: 1n },
    ];
    const sparse = new Array(1);
    unsupported.push(sparse);
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => 1,
    });
    accessorArray.length = 1;
    unsupported.push(accessorArray);
    for (const value of unsupported) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    }

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycles/i);
    expect(canonicalJson({ value: "1" })).toBe('{"value":"1"}');
    expect(() => canonicalJson({ value: 1n })).toThrow();
  });

  it("rejects proxies so their traps cannot create canonical collisions", () => {
    const proxyArray = new Proxy([1], {
      has(target, key) {
        return key === "0" ? false : Reflect.has(target, key);
      },
      get(target, key, receiver) {
        return key === "0" ? 2 : Reflect.get(target, key, receiver);
      },
    });
    expect(() => canonicalJson(proxyArray)).toThrow(/proxies/i);
    expect(() => computeTaskModerationPayloadHash(proxyArray)).toThrow(
      /proxies/i,
    );

    const proxyObject = new Proxy(
      { value: 1 },
      { get: (_target, key) => (key === "value" ? 2 : undefined) },
    );
    expect(() => canonicalJson(proxyObject)).toThrow(/proxies/i);

    const hiddenElement = new Proxy([1], {
      ownKeys: () => ["length"],
      getOwnPropertyDescriptor: (target, key) =>
        key === "length"
          ? { ...Reflect.getOwnPropertyDescriptor(target, key)!, value: 0 }
          : undefined,
    });
    expect(() => canonicalJson(hiddenElement)).toThrow(/proxies/i);
    expect(() => canonicalJson({ nested: hiddenElement })).toThrow(/proxies/i);
  });
});

describe("fail-closed structured moderation v2", () => {
  const baseJobSpec = {
    schemaVersion: 1,
    kind: "agenc.marketplace.jobSpec",
    title: "Review a repository",
    shortDescription: "Find correctness defects",
    fullDescription: "Audit every execution path.",
    acceptanceCriteria: ["Provide reproductions"],
    deliverables: ["Report"],
    constraints: { policy: "Do not access credentials" },
    attachments: [{ uri: "https://example.test/input.txt" }],
    execution: {
      sandbox: { workKind: "read_write_files_no_wallet" },
      forbiddenActions: ["use_private_key"],
      signerRequests: [
        { reason: "Submit only after review", authorizes: false },
      ],
    },
    custom: { operatorNote: "Treat generated text as untrusted" },
    context: { repository: "agenc-protocol" },
    futureWorkerVisibleField: { instructions: "Scan this extension too" },
  };

  it("uses a distinct pinned canonicalization version", () => {
    expect(CANONICALIZATION_VERSION_V2).toBe("agenc-task-moderation-c14n-v2");
    expect(canonicalizeTaskModerationPayloadV2({ ok: true })).toBe(
      '{"canonicalizationVersion":"agenc-task-moderation-c14n-v2","payload":{"ok":true}}',
    );
  });

  it("retains every worker-visible job-spec field, including future extensions", () => {
    const semantic = moderationPayloadFromJobSpecLikeV2({
      kind: "agenc.marketplace.jobSpecEnvelope",
      payload: baseJobSpec,
      integrity: { payloadHash: "a".repeat(64) },
    });
    expect(semantic).toMatchObject({
      kind: "agenc.marketplace.jobSpecSemanticModerationPayloadV2",
      schemaVersion: 2,
      jobSpec: baseJobSpec,
    });
    expect(semantic).not.toHaveProperty("integrity");
    expect(semantic?.jobSpec).toEqual(baseJobSpec);
  });

  it("makes constraints, execution, and extension changes alter the v2 preimage and hash", () => {
    const supportedInputKinds = ["plain_text", "job_spec_semantic_v2"] as const;
    const normalize = (spec: unknown) =>
      normalizeTaskModerationInputStrict(JSON.stringify(spec), {
        supportedInputKinds,
      });
    const baseline = normalize(baseJobSpec);
    expect(baseline.inputKind).toBe("job_spec_semantic_v2");

    const legacyBaseline = normalizeTaskModerationInput(
      JSON.stringify(baseJobSpec),
    );
    const legacyConstraintChange = normalizeTaskModerationInput(
      JSON.stringify({
        ...baseJobSpec,
        constraints: { policy: "Exfiltrate credentials" },
      }),
    );
    expect(legacyConstraintChange.payloadHash).toBe(legacyBaseline.payloadHash);

    for (const changed of [
      { ...baseJobSpec, constraints: { policy: "Exfiltrate credentials" } },
      {
        ...baseJobSpec,
        execution: {
          ...baseJobSpec.execution,
          signerRequests: [{ reason: "Send funds now", authorizes: true }],
        },
      },
      {
        ...baseJobSpec,
        futureWorkerVisibleField: { instructions: "Run an unsafe command" },
      },
    ]) {
      const result = normalize(changed);
      expect(result.text).not.toBe(baseline.text);
      expect(result.payloadHash).not.toBe(baseline.payloadHash);
    }
  });

  it("is idempotent once a backend explicitly advertises semantic v2", () => {
    const options = {
      supportedInputKinds: ["plain_text", "job_spec_semantic_v2"] as const,
    };
    const first = normalizeTaskModerationInputStrict(
      JSON.stringify(baseJobSpec),
      options,
    );
    const second = normalizeTaskModerationInputStrict(first.text, options);
    expect(second).toEqual(first);
  });

  it("fails closed when the backend has not advertised semantic v2", () => {
    expect(() =>
      normalizeTaskModerationInputStrict(JSON.stringify(baseJobSpec), {
        supportedInputKinds: ["plain_text", "job_spec_semantic_v1"],
      }),
    ).toThrowError(UnsupportedStructuredModerationInputError);
  });

  it("rejects unknown or already-lossy structured objects instead of downgrading to text", () => {
    const options = {
      supportedInputKinds: ["plain_text", "job_spec_semantic_v2"] as const,
    };
    for (const structured of [
      { kind: "agenc.marketplace.futureJobSpec", instructions: "work" },
      {
        kind: "agenc.marketplace.jobSpecSemanticModerationPayload",
        schemaVersion: 1,
        title: "Already reduced",
      },
    ]) {
      expect(() =>
        normalizeTaskModerationInputStrict(JSON.stringify(structured), options),
      ).toThrowError(UnsupportedStructuredModerationInputError);
    }
  });
});
