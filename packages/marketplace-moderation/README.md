# @tetsuo-ai/marketplace-moderation

Open, **MIT-licensed** reference of the AgenC task-moderation **payload
canonicalization** — canonicalization version **`agenc-task-moderation-c14n-v1`**.

> **Structured job specs:** `job_spec_semantic_v1` is a legacy interoperability
> format and does not include the complete `constraints` and `execution` trees.
> New safety-sensitive integrations should use
> `normalizeTaskModerationInputStrict`, advertise the backend's supported input
> kinds, and enable `job_spec_semantic_v2` only after the backend explicitly
> supports it. Until then, recognized structured specs fail closed instead of
> silently dropping worker-visible instructions.

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

const { text, inputKind, payloadHash } =
  normalizeTaskModerationInput(jobSpecText);

// POST to the moderation attestation service:
//   {
//     text,
//     moderationInputKind: inputKind,       // "job_spec_semantic_v1" | "plain_text"
//     moderationPayloadHash: payloadHash,   // the backend re-derives + compares this
//     ...task/jobSpec binding fields
//   }
```

The call above is the byte-compatible legacy v1 path. The complete structured
path is capability-gated:

```ts
import { normalizeTaskModerationInputStrict } from "@tetsuo-ai/marketplace-moderation";

const normalized = normalizeTaskModerationInputStrict(jobSpecText, {
  // Populate this from the backend's advertised capabilities. Omitting v2
  // makes recognized structured specs throw before any request is sent.
  supportedInputKinds: ["plain_text", "job_spec_semantic_v2"],
});
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

| Output field         | Source field(s) (first defined wins)                         | Kept when                  |
| -------------------- | ------------------------------------------------------------ | -------------------------- |
| `kind`               | literal `agenc.marketplace.jobSpecSemanticModerationPayload` | always                     |
| `schemaVersion`      | literal `1`                                                  | always                     |
| `title`              | `title`                                                      | defined                    |
| `shortDescription`   | `shortDescription`, `short_description`                      | defined                    |
| `fullDescription`    | `fullDescription`, `full_description`                        | defined                    |
| `acceptanceCriteria` | `acceptanceCriteria`, `acceptance_criteria`                  | non-empty array of strings |
| `deliverables`       | `deliverables`                                               | non-empty array of strings |
| `attachments`        | `attachments`                                                | defined                    |
| `context`            | `context`                                                    | defined                    |
| `custom`             | `custom`                                                     | defined                    |

Array fields (`acceptanceCriteria`, `deliverables`) keep only the string members
and are omitted entirely if none remain. Anything not listed above (e.g.
`creator`, `integrity`, `constraints`, or `execution`) is dropped. This exact
reduction remains published for v1 wire compatibility, but it is not a complete
safety preimage for current structured job specs.

### 3. Canonical JSON (`canonicalJson`)

Deterministic encoding of the hash preimage:

- `null`, string, number, boolean → `JSON.stringify(value)`.
- non-finite numbers (`NaN`, infinities) → rejected (they are not valid JSON and
  must not collide with `null`).
- dense JSON arrays → `[` + comma-joined `canonicalJson` of each element + `]`.
- plain objects → `{` + comma-joined `"key":value` pairs + `}`, with keys
  **sorted lexicographically** and emitted with `JSON.stringify(key)`.
- every non-JSON value is rejected, including `undefined`, `bigint`, functions,
  symbols, typed arrays, dates, maps, sparse/extended arrays, exotic objects,
  accessors, cycles, and structures deeper than 256 levels. Values are never
  silently omitted or coerced, preventing distinct programmatic inputs from
  colliding with valid JSON.

### 4. Hash

```
preimage        = canonicalJson({ canonicalizationVersion: "agenc-task-moderation-c14n-v1", payload })
moderationPayloadHash = sha256(preimage) as lowercase hex
```

Note the preimage object has exactly two keys, and canonical sorting emits
`canonicalizationVersion` before `payload`.

## Complete structured v2 and fail-closed negotiation

`moderationPayloadFromJobSpecLikeV2` wraps the entire recognized job-spec
payload under `agenc.marketplace.jobSpecSemanticModerationPayloadV2`. It
therefore retains every field the worker receives, including unknown future
extensions; only an outer envelope's integrity/bookkeeping block is excluded.
Its hash preimage is versioned with `agenc-task-moderation-c14n-v2`.

`normalizeTaskModerationInputStrict(input, { supportedInputKinds })` requires
explicit backend capability negotiation. A recognized job spec is emitted only
when `job_spec_semantic_v2` is advertised. Unknown JSON objects and already
reduced v1 objects are rejected because the complete worker-visible source
cannot be proven. Plain text remains compatible with c14n-v1.

## Pinned test vector

The single canonical vector, asserted in this package's tests **and** in
agenc.ag's `apps/web/lib/__tests__/moderation-canon.test.ts`:

| input `text` (plain_text)     | `moderationPayloadHash`                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `{"title":"x","summary":"y"}` | `83d7572f8239823a30dc57a4f6bb3451d14312ff69a8a3647a4efa734fa05fb4` |

Its exact preimage is:

```
{"canonicalizationVersion":"agenc-task-moderation-c14n-v1","payload":"{\"title\":\"x\",\"summary\":\"y\"}"}
```

If your independent implementation reproduces that hash, it is wire-compatible
with the AgenC moderation backend.

## API

- `normalizeTaskModerationInput(input: string): NormalizedModerationInput` —
  returns the legacy-compatible `{ text, inputKind, payloadHash }`.
- `normalizeTaskModerationInputStrict(input, options)` — capability-gated,
  fail-closed v2 structured normalization.
- `moderationPayloadFromJobSpecLikeV2`,
  `canonicalizeTaskModerationPayloadV2`, and
  `computeTaskModerationPayloadHashV2` — complete structured v2 surfaces.
- `computeTaskModerationPayloadHash(payload: unknown): string` — the lowercase
  hex hash.
- `canonicalizeTaskModerationPayload(payload: unknown): string` — the exact
  canonical preimage that gets hashed.
- `moderationPayloadFromJobSpecLike(jobSpec: unknown): Record<string, unknown> | null`
  — semantic extraction (step 2).
- `isJobSpecSemanticModerationPayload(value: unknown): boolean`.
- `canonicalJson(value: unknown): string` — the deterministic encoder (step 3).
- `CANONICALIZATION_VERSION` / `CANONICALIZATION_VERSION_V2` — pinned v1 and
  v2 preimage versions.

## Versioning

The v1 constant and vectors remain pinned for wire compatibility. Structured v2
must be enabled only after a backend advertises `job_spec_semantic_v2`; depend on
a compatible package major and negotiate the input kind before sending it.

## License

MIT © Tetsuo AI
