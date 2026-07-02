# @tetsuo-ai/marketplace-moderation

Open, **MIT-licensed** reference of the AgenC task-moderation **payload
canonicalization** — canonicalization version **`agenc-task-moderation-c14n-v1`**.

When a marketplace asks the AgenC moderation attestation service to policy-check
and attest a task, it sends a `text` blob together with a
`moderationPayloadHash`. **The backend re-derives that hash from the `text` it
receives, using the exact algorithm in this package, and rejects the request if
the two do not match** (`payloadHash ... does not match scanned input`). The raw
job-spec sha-256 is **not** that hash.

So any third party who wants to request attestation from AgenC — without the
closed kit — must compute `moderationPayloadHash` byte-for-byte the same way.
This package publishes exactly that algorithm as an open interoperability
contract. It carries **no** proprietary policy, entitlement, or signing logic —
only the canonical hashing every side must agree on.

> **Licensing.** This is a clean-room, MIT publication of the
> `agenc-task-moderation-c14n-v1` canonicalization spec and algorithm, published
> under WP-C1 so third parties can interoperate. The private
> `@tetsuo-ai/marketplace-moderation@0.1.0` inside the closed agent kit remains
> under its own EULA; this open package is the interoperability surface, not that
> kit code.

## Install

```bash
npm install @tetsuo-ai/marketplace-moderation
```

Zero runtime dependencies (only Node's built-in `node:crypto`). Requires Node
`>=20.18.0`.

## Usage

```ts
import { normalizeTaskModerationInput } from "@tetsuo-ai/marketplace-moderation";

const { text, inputKind, payloadHash } = normalizeTaskModerationInput(jobSpecText);

// POST to the moderation attestation service:
//   {
//     text,
//     moderationInputKind: inputKind,       // "job_spec_semantic_v1" | "plain_text"
//     moderationPayloadHash: payloadHash,   // the backend re-derives + compares this
//     ...task/jobSpec binding fields
//   }
```

`normalizeTaskModerationInput` is **idempotent**: normalizing the returned `text`
again yields the same `payloadHash`. That is precisely why the backend can
re-derive the hash from the `text` it receives.

## The `agenc-task-moderation-c14n-v1` spec

An interoperable, language-agnostic description. Implement it in any language and
you will reproduce the same `moderationPayloadHash`.

### 1. Choose the `payload` and `inputKind`

Given the input job-spec string:

1. Trim it. If the trimmed string starts with `{`, try to `JSON.parse` it:
   - If the parsed value is an object whose `kind` is
     `agenc.marketplace.jobSpecSemanticModerationPayload`, the `payload` is that
     parsed object and `inputKind = "job_spec_semantic_v1"`.
   - Else, run **semantic extraction** (step 2). If it yields a payload, that is
     the `payload` and `inputKind = "job_spec_semantic_v1"`.
   - If parsing throws (malformed JSON), fall through to plain text.
2. Otherwise, the `payload` is the **raw input string** (unmodified — not the
   trimmed one) and `inputKind = "plain_text"`.

The `text` you transmit is:
- the raw input string, for `plain_text`; or
- `JSON.stringify(payload)` (the reduced semantic object), for
  `job_spec_semantic_v1`.

### 2. Semantic extraction (`moderationPayloadFromJobSpecLike`)

Accept either a bare `agenc.marketplace.jobSpec` or an
`agenc.marketplace.jobSpecEnvelope` whose `payload` is one. If the (unwrapped)
object's `kind` is not `agenc.marketplace.jobSpec`, extraction fails (returns
nothing). Otherwise build an object with these fields, then **drop every entry
that is `undefined` or `null`**:

| Output field         | Source field(s) (first defined wins)              | Kept when                     |
| -------------------- | ------------------------------------------------- | ----------------------------- |
| `kind`               | literal `agenc.marketplace.jobSpecSemanticModerationPayload` | always            |
| `schemaVersion`      | literal `1`                                       | always                        |
| `title`              | `title`                                           | defined                       |
| `shortDescription`   | `shortDescription`, `short_description`           | defined                       |
| `fullDescription`    | `fullDescription`, `full_description`             | defined                       |
| `acceptanceCriteria` | `acceptanceCriteria`, `acceptance_criteria`       | non-empty array of strings    |
| `deliverables`       | `deliverables`                                    | non-empty array of strings    |
| `attachments`        | `attachments`                                     | defined                       |
| `context`            | `context`                                         | defined                       |
| `custom`             | `custom`                                          | defined                       |

Array fields (`acceptanceCriteria`, `deliverables`) keep only the string members
and are omitted entirely if none remain. Anything not listed above (e.g.
`creator`, `integrity`, secrets) is **dropped** — moderation only sees
creator-controlled semantic content.

### 3. Canonical JSON (`canonicalJson`)

Deterministic encoding of the hash preimage:

- `undefined` → the literal `null`.
- `null`, string, number, boolean → `JSON.stringify(value)`.
- `bigint` → `JSON.stringify(value.toString())` (decimal string).
- `Uint8Array` → encoded as a plain array of its byte values.
- array → `[` + comma-joined `canonicalJson` of each element + `]`.
- object → `{` + comma-joined `"key":value` pairs + `}`, where keys are **sorted
  lexicographically** and any key whose value is `undefined` or a function is
  omitted. Keys are emitted with `JSON.stringify(key)`.

### 4. Hash

```
preimage        = canonicalJson({ canonicalizationVersion: "agenc-task-moderation-c14n-v1", payload })
moderationPayloadHash = sha256(preimage) as lowercase hex
```

Note the preimage object has exactly two keys, and canonical sorting emits
`canonicalizationVersion` before `payload`.

## Pinned test vector

The single canonical vector, asserted in this package's tests **and** in
agenc.ag's `apps/web/lib/__tests__/moderation-canon.test.ts`:

| input `text` (plain_text)   | `moderationPayloadHash`                                            |
| --------------------------- | ----------------------------------------------------------------- |
| `{"title":"x","summary":"y"}` | `83d7572f8239823a30dc57a4f6bb3451d14312ff69a8a3647a4efa734fa05fb4` |

Its exact preimage is:

```
{"canonicalizationVersion":"agenc-task-moderation-c14n-v1","payload":"{\"title\":\"x\",\"summary\":\"y\"}"}
```

If your independent implementation reproduces that hash, it is wire-compatible
with the AgenC moderation backend.

## API

- `normalizeTaskModerationInput(input: string): NormalizedModerationInput` —
  returns `{ text, inputKind, payloadHash }`.
- `computeTaskModerationPayloadHash(payload: unknown): string` — the lowercase
  hex hash.
- `canonicalizeTaskModerationPayload(payload: unknown): string` — the exact
  canonical preimage that gets hashed.
- `moderationPayloadFromJobSpecLike(jobSpec: unknown): Record<string, unknown> | null`
  — semantic extraction (step 2).
- `isJobSpecSemanticModerationPayload(value: unknown): boolean`.
- `canonicalJson(value: unknown): string` — the deterministic encoder (step 3).
- `CANONICALIZATION_VERSION` — the pinned `"agenc-task-moderation-c14n-v1"`
  string.

## Versioning

If the backend ever bumps the canonicalization version, this package bumps in
lockstep and the pinned vectors change with it. Depend on a compatible major and
watch the `CANONICALIZATION_VERSION` constant.

## License

MIT © Tetsuo AI
