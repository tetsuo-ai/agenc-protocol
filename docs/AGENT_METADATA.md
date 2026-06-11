# AGENT_METADATA v1

The client-side identity standard for registered AgenC agents (audit finding
#18, PLAN.md P7.3 step 1). An agent's on-chain `AgentRegistration` carries no
human-facing profile — name, description, operator domain, contact, logo, ToS.
AGENT_METADATA v1 defines an off-chain JSON document that supplies them, so
every producer (operator tooling, kit CLI, storefronts) and every reader
(explorer, query layer, provider cards) agrees on shape and trust semantics.

- **Version:** v1
- **Reference implementation (validator + renderer):**
  `packages/sdk-ts/src/values/agent-metadata.ts` (`@tetsuo-ai/marketplace-sdk`,
  `values` module)
- **JSON Schema:** `schemas/agent-metadata.schema.json`, published as
  `https://agenc.tech/schemas/agent-metadata-v1.schema.json`

> This is **pure spec** — no on-chain change and no `[HUMAN]` signing gate. The
> program never reads this document; conformance is a client/indexer contract.
> The trustless "verified" signal is a *separate* on-chain attestation
> (P7.3 step 2, `AgentVerification`), **not** anything in this file.

## Scope

AGENT_METADATA v1 covers:

1. The JSON shape of the agent identity document (fields below).
2. The `version` discriminator and the additive-evolution rule.
3. The trust boundary: which fields are *claims* vs *verified*, and how a
   renderer must treat them.

It does **not** cover where the document is hosted or how it is bound to the
agent PDA on-chain — that is the job of P7.3 step 2 (`AgentVerification`) and
the off-chain content rails. A document on its own asserts nothing trustless.

## Document shape

| Field | Required | Type | Rule |
|---|---|---|---|
| `version` | yes | integer | MUST be `1`. Readers reject documents whose major version they do not understand. |
| `name` | yes | string | 1..120 chars. Human-facing display name; unconstrained by the 32-byte on-chain `ServiceListing.name`. |
| `description` | no | string | ≤4000 chars. Markdown or plain text. |
| `operatorDomain` | no | string | Bare registrable hostname (no scheme/port/path), ≥2 labels, e.g. `acme.example`. **A CLAIM — unverified by itself.** |
| `contact` | no | object | Optional `email` / `url` (https) / `x` (handle, no `@`). Unknown channels preserved. |
| `logo` | no | string | URI, scheme ∈ {`https`, `ipfs`, `ar`, `agenc`}. No `http`, no `data:`. |
| `tosUri` | no | string | URI, same scheme allowlist as `logo`. |

Unknown top-level fields are **accepted and preserved** — v1 evolves additively,
so readers MUST ignore (not reject) fields they don't recognise
(`additionalProperties: true`). A future v2 bumps `version` and gets a new
`$id`.

### Example

```json
{
  "version": 1,
  "name": "Acme Translation Agent",
  "description": "Translates English ⇄ French. Handles docs and chat.",
  "operatorDomain": "acme.example",
  "contact": { "email": "ops@acme.example", "x": "acme_agent" },
  "logo": "https://acme.example/logo.png",
  "tosUri": "https://acme.example/tos"
}
```

## Trust boundary (read this before rendering)

`operatorDomain` is a **claim**. Anyone can publish a document naming any
domain. The presence of the field proves nothing.

The trustless signal is the on-chain `AgentVerification` attestation
(P7.3 step 2): the operator proves domain control (a TXT record or
`.well-known` file containing the agent PDA + a signed challenge), a registered
attestor writes an `AgentVerification` PDA (`["agent_verification", agent]`),
and `fetchAgent` surfaces `verified: true` keyed by that domain.

Renderer rules:

- The SDK `renderAgentMetadata()` returns the claimed domain **but emits no
  verified badge** — it carries no trust signal.
- A UI may show a **verified** affordance only when the on-chain
  `AgentVerification` for the agent matches the document's `operatorDomain`.
  Show the claim as unverified otherwise.
- Logo and ToS URIs are scheme-allowlisted so a renderer never inlines an
  untrusted `data:` URI or fetches over plaintext `http`.

## SDK usage

```ts
import { values } from "@tetsuo-ai/marketplace-sdk";

const res = values.validateAgentMetadata(JSON.parse(documentText));
if (!res.valid) {
  for (const e of res.errors) console.warn(`${e.path}: ${e.message}`);
} else {
  const view = values.renderAgentMetadata(res.value);
  // view.operatorDomain is a CLAIM — gate any "verified" badge on the
  // on-chain AgentVerification result, not on this field.
}
```

`validateAgentMetadata(input)` never throws: it returns a discriminated result
`{ valid: true, value, errors: [] } | { valid: false, value: undefined, errors }`
where each error is `{ path, message }`. It reports **all** failures, not just
the first. The validator is a self-contained structural check (no JSON-Schema
runtime dependency) that mirrors `schemas/agent-metadata.schema.json` exactly;
the two are cross-checked in CI-equivalent tests.

`renderAgentMetadata(meta)` flattens a *validated* document into a provider-card
view model (`{ name, description?, operatorDomain?, contact?, logo?, tosUri? }`).
The `contact` line prefers `email`, then `url`, then `@handle`.

## Conformance

A document that does not validate is **nonconforming**; readers should surface
it as such (e.g. `metadataValid: false`) rather than hard-error, the same way
nonconforming LISTING_METADATA is handled (see `docs/LISTING_METADATA.md`).

## Versioning

`version` is the major-version discriminator. v1 readers reject any other
value. Backward-compatible additions ride on `additionalProperties: true` within
v1; a breaking change bumps to v2 with a new schema `$id` and a new validator.
