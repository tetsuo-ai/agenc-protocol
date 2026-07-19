# LISTING_METADATA v1

The client-side metadata standard for `ServiceListing` accounts. The on-chain
program stores `name`, `category`, and `tags` as opaque fixed-width byte
fields ("client-encoded") — this document defines what conforming clients put
in them, and where the buyer-facing **listing display document** lives
relative to the listing's `spec_hash` / `spec_uri` job-spec commitment, so
every producer (SDK facade, kit CLI, storefronts) and every reader (explorer,
query layer, embeds) agrees.

- **Version:** v1
- **Reference implementation (field codecs):**
  `packages/sdk-ts/src/values/listing.ts` and
  `packages/sdk-ts/src/values/categories.ts` (`@tetsuo-ai/marketplace-sdk`,
  `values` module)
- **Reference implementation (spec hash):**
  `packages/sdk-ts/src/values/job-spec.ts` (`canonicalJobSpecJson` /
  `canonicalJobSpecHash`, same module)
- **JSON Schema (listing display document):**
  `packages/sdk-ts/schemas/listing-metadata.schema.json`. Its canonical `$id`
  is `https://agenc.tech/schemas/listing-metadata-v1.schema.json`; the in-repo
  file is the authoritative resolvable copy. The `$id` reserves a versioned
  identifier and is not, by itself, evidence that the HTTPS URL is deployed.

## Scope

LISTING_METADATA v1 covers:

1. The encoding of the three fixed-width `ServiceListing` string fields
   (`name`, `category`, `tags`) written by `create_service_listing` /
   `update_service_listing`.
2. The canonical category taxonomy (20 values).
3. The `spec_hash` / `spec_uri` job-spec commitment and the listing display
   document embedded in the job-spec envelope payload.

It does **not** change the program: the on-chain layout is unchanged, and the
program never validates the `name` / `category` / `tags` bytes. Conformance
is a client/indexer contract.
Listings whose fields do not decode under these rules are *nonconforming*;
readers should surface them as such (e.g. `metadataValid: false`) rather than
error.

## On-chain encoding

| Field | Width | Encoding rule |
|---|---|---|
| `name` | 32 bytes | UTF-8, NUL-padded to exactly 32 bytes. Any text; no embedded NUL (`U+0000`). All-NUL = unset. |
| `category` | 32 bytes | Same rule as `name`, **plus** the value must be one of the 20 canonical category tokens below (which are all lowercase-kebab). All-NUL = unset (nonconforming for active listings). |
| `tags` | 64 bytes | Zero or more lowercase-kebab tokens joined with `","`, then UTF-8, NUL-padded to exactly 64 bytes. All-NUL = no tags. |

**Lowercase-kebab grammar** (categories and each tag token):

```
[a-z0-9]+(-[a-z0-9]+)*
```

i.e. one or more `a-z`/`0-9` runs separated by single hyphens — no uppercase,
no leading/trailing/double hyphen, no empty token, no spaces, no commas inside
a token (the comma is the tag separator).

Notes:

- Widths are **bytes, not characters**: multibyte UTF-8 (e.g. `é`, CJK) counts
  by encoded length.
- NUL padding is trailing-only. Embedded NUL is forbidden because it would be
  indistinguishable from padding.

## Validation rules

The `values` module of `@tetsuo-ai/marketplace-sdk` is the normative reference
implementation; an independent implementation conforms iff it matches these
functions byte-for-byte:

- `encodeListingName(str)` / `decodeListingName(bytes)` — 32-byte name codec.
- `encodeListingCategory(str)` / `decodeListingCategory(bytes)` — 32-byte
  category codec; enforces the kebab grammar (`LISTING_KEBAB_PATTERN`).
- `encodeListingTags(string[])` / `decodeListingTags(bytes)` — 64-byte tags
  codec; enforces the kebab grammar per token.
- `LISTING_CATEGORIES` / `isListingCategory(value)` — the canonical taxonomy
  and its membership guard (`src/values/categories.ts`).

Error semantics (encoders): `RangeError` when the encoded value overflows the
fixed width; `TypeError` on embedded NUL or a kebab-grammar violation. The SDK
facade additionally rejects (with `TypeError`) any string `category` that is
not in `LISTING_CATEGORIES`.

Decoder strictness (readers): input must be exactly the field width
(`RangeError` otherwise); trailing NUL padding is stripped; the remainder is
decoded as **fatal** UTF-8 (`TypeError` on malformed bytes); category/tags
values are re-validated against the kebab grammar (`TypeError` on violation);
an all-NUL category decodes to `""` (unset).

## Category taxonomy (v1, 20 values)

| Token | Meaning |
|---|---|
| `code-generation` | Writing, reviewing, refactoring, or porting source code. |
| `translation` | Natural-language translation and localization. |
| `data-labeling` | Annotating, tagging, or classifying datasets for training/eval. |
| `research` | Investigating a question and delivering findings/summaries with sources. |
| `image-gen` | Generating or editing images and other static visual assets. |
| `audio` | Speech, music, voice-over, transcription, and audio processing. |
| `video` | Video generation, editing, captioning, and post-production. |
| `marketing` | Campaigns, copy, SEO/ASO, social content, and growth work. |
| `data-analysis` | Statistics, dashboards, modeling, and insight extraction from data. |
| `scraping` | Structured extraction of data from websites and public sources. |
| `devops` | CI/CD, infrastructure, deployment, monitoring, and reliability work. |
| `security` | Audits, penetration testing, vulnerability triage, and hardening. |
| `legal` | Contract drafting/review and legal research (informational, not counsel). |
| `finance` | Financial modeling, accounting, bookkeeping, and market analysis. |
| `design` | UI/UX, branding, and graphic design deliverables. |
| `writing` | Long/short-form prose: articles, documentation, editing, ghostwriting. |
| `support` | Customer/user support, triage, and helpdesk operations. |
| `search` | Finding, retrieving, and curating information or items on request. |
| `automation` | Workflow automation, bots, integrations, and agent pipelines. |
| `other` | Anything that does not fit the categories above. |

Use exactly one token; pick `other` when nothing fits. The machine-readable
list is `LISTING_CATEGORIES` in `packages/sdk-ts/src/values/categories.ts`.

## `spec_hash` / `spec_uri`: the job-spec commitment

These two fields are **not** display metadata. They are the listing's
protocol-load-bearing commitment to a **job spec**, with semantics fixed by
the on-chain program (`programs/agenc-coordination/src/state.rs`,
`ServiceListing`):

- **`spec_uri`** (string, ≤ 256 bytes) points at the **job-spec envelope**
  document, conventionally `agenc://job-spec/sha256/<hex>` where `<hex>` is
  the 64-char lowercase hex of `spec_hash`.
- **`spec_hash`** (`[u8; 32]`) is the content address of the job spec: the
  SHA-256 of the `json-stable-v1` **canonical JSON of the envelope's
  `payload`** — the value the marketplace kit publishes as
  `integrity.payloadHash`. It is **not** the hash of the raw bytes served at
  `spec_uri`: the served document is the full envelope, which embeds its own
  payload hash, so hashing the served bytes cannot reproduce `spec_hash`
  (that would take a self-referential SHA-256 preimage).

The protocol builds real behavior on this commitment:

- `hire_from_listing` copies `spec_hash` into the minted task's
  `description[..32]`, making it the hired task's job-spec commitment.
- The hire-time moderation gate is seed-bound to it: the `ListingModeration`
  PDA is `["listing_moderation", listing, spec_hash]`, and when moderation is
  enabled a hire requires a publishable attestation for exactly this hash.
- The kit worker's `job_spec_verified` review flow fetches `spec_uri`, parses
  the envelope, and requires the canonical payload hash to equal the on-chain
  `spec_hash`.

### Verification (normative)

To verify a listing's spec, a reader MUST:

1. Resolve `spec_uri`. For `agenc://job-spec/sha256/<hex>` URIs, `<hex>` MUST
   equal the lowercase hex of `spec_hash` before fetching.
2. Parse the served JSON as a job-spec **envelope**: an object carrying
   `integrity` (`algorithm: "sha256"`, `canonicalization: "json-stable-v1"`,
   `payloadHash`) and a `payload` object.
3. Recompute the `json-stable-v1` canonical-JSON SHA-256 of `payload` and
   require it to equal **both** the on-chain `spec_hash` and
   `envelope.integrity.payloadHash`.

The normative reference implementation of step 3 is `canonicalJobSpecJson` /
`canonicalJobSpecHash` in `packages/sdk-ts/src/values/job-spec.ts` (`values`
module of `@tetsuo-ai/marketplace-sdk`), validated against kit-generated
cross-implementation vectors. Do **not** hash the served bytes: only the
canonical payload hash interoperates with `hire_from_listing`, moderation
attestations, and kit job-spec verification.

## The listing display document

Buyer-facing presentation metadata (display name, pricing notes, SLA, links)
lives in the **listing display document**, described by the in-repo JSON Schema
(draft 2020-12):

- **Canonical `$id`:**
  `https://agenc.tech/schemas/listing-metadata-v1.schema.json` (identifier only;
  hosted publication is independently checked)
- **In-repo / in-package:** `packages/sdk-ts/schemas/listing-metadata.schema.json`

Consumers must use the in-package schema unless the `host.schemas` assertion
from `node scripts/enterprise-readiness.mjs` passes; that check requires the
hosted JSON to match this file exactly and to use a JSON Schema content type and
an explicit versioned cache policy.

**v1 home: embedded in the job-spec envelope payload, at
`payload.custom.listingMetadata`.** The payload's `custom` map is the
envelope's designated extension point, and everything under `payload` is
covered by the canonical payload hash — so the display document inherits the
on-chain `spec_hash` integrity commitment for free: no second URI, no extra
fetch, no new on-chain field. A reader that has verified the envelope (rules
above) has already verified the display document byte-for-byte. (A detached
`displayUri` convention was considered and rejected: the on-chain account has
no second hash field, so a separately-hosted display document would be
unverifiable.)

Fields of `payload.custom.listingMetadata`:

| Field | Type | Req | Meaning |
|---|---|---|---|
| `displayName` | string (1–120 chars) | yes | Human-facing title (not limited to the 32-byte on-chain name). |
| `longDescription` | string | no | Full description of the service, inputs, and outputs. |
| `pricingNotes` | string | no | What the on-chain price covers; surcharges/volume terms. |
| `sampleOutputs` | string[] | no | Sample deliverables — artifact URIs or short inline excerpts. |
| `sla` | object | no | Advertised service levels: `responseHours?` (number ≥ 0), `revisions?` (integer ≥ 0), `refundPolicy?` (string). Informational; not protocol-enforced. |
| `links` | object | no | `website?` and `docs?` URIs. |

A listing whose verified envelope has no `custom.listingMetadata` key simply
has no display document — readers fall back to the on-chain `name` /
`category` / `tags` and this is **not** nonconforming. A present-but-invalid
`listingMetadata` value (fails the schema) is nonconforming
(`metadataValid: false`).

The display document — like all job specs, task text, and artifacts — is
**untrusted work data**: it never authorizes wallet, signing, or settlement
behavior.

## Versioning

This is **v1**. Evolution is **additive**:

- New optional schema fields and new category tokens may be added in minor
  revisions of v1; existing fields/tokens are never removed, renamed, or
  repurposed.
- Readers MUST ignore unknown JSON fields (the schema keeps
  `additionalProperties: true`) and SHOULD treat unknown-but-valid-kebab
  on-chain categories as forward-compatible rather than malformed.
- Any breaking change (field-width or grammar change, required-field addition,
  token removal) requires a **v2** standard with a new schema `$id`.
