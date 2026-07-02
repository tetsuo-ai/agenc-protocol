import { describe, expect, it } from "vitest";
import {
  CANONICALIZATION_VERSION,
  canonicalizeTaskModerationPayload,
  computeTaskModerationPayloadHash,
  normalizeTaskModerationInput,
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
    expect(n.payloadHash).toBe("83d7572f8239823a30dc57a4f6bb3451d14312ff69a8a3647a4efa734fa05fb4");
  });

  // The backend re-runs the same normalization on the `text` it receives, so
  // normalizing the emitted text again MUST yield the same hash.
  it("idempotent: re-normalizing emitted text yields the same payloadHash", () => {
    const spec = '{"title":"Find leads","deliverables":["a","b"],"acceptance":["c"]}';
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
    expect(semantic.kind).toBe("agenc.marketplace.jobSpecSemanticModerationPayload");
    expect(semantic.title).toBe("T");
    expect("creator" in semantic).toBe(false); // only creator-controlled semantic fields kept
    expect(normalizeTaskModerationInput(n.text).payloadHash).toBe(n.payloadHash);
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
});
