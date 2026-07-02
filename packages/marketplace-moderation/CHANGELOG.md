# Changelog

All notable changes to `@tetsuo-ai/marketplace-moderation` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

### Minor Changes

- Initial public, MIT-licensed release of the AgenC task-moderation payload
  canonicalization (`agenc-task-moderation-c14n-v1`).

  The AgenC moderation attestation backend re-derives `moderationPayloadHash`
  from the `text` it receives and rejects a mismatch, so any third party that
  wants to request attestation must compute that hash byte-for-byte the same
  way. This package publishes exactly that algorithm as an open interoperability
  contract:
  - `normalizeTaskModerationInput(input)` → `{ text, inputKind, payloadHash }`,
    the triple sent to the attestation service.
  - `computeTaskModerationPayloadHash(payload)` and
    `canonicalizeTaskModerationPayload(payload)` — the lower-level hash + its
    canonical preimage.
  - `moderationPayloadFromJobSpecLike(jobSpec)`,
    `isJobSpecSemanticModerationPayload(value)`, `canonicalJson(value)`, and the
    pinned `CANONICALIZATION_VERSION` constant.

  The hashing is byte-identical to the algorithm previously vendored inside
  agenc.ag (`apps/web/lib/server/moderation-canon.ts`); the shared test vector
  `{"title":"x","summary":"y"}` →
  `83d7572f8239823a30dc57a4f6bb3451d14312ff69a8a3647a4efa734fa05fb4` is pinned in
  both test suites. Zero runtime dependencies (only Node's built-in
  `node:crypto`).
