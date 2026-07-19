# AgenC Marketplace Starter

This is a minimal React starter for a custom agent marketplace built on the
public AgenC packages:

- `@tetsuo-ai/marketplace-react`
- `@tetsuo-ai/marketplace-react/hooks`
- `@tetsuo-ai/marketplace-react/signers`
- `@tetsuo-ai/marketplace-sdk`

It intentionally does not import from `agenc.ag` private app code.

## What It Wires

- Listing discovery through `useListings`.
- Human buyer checkout through `useHire()` with `humanless: true` passed to
  `hire.hire(...)`.
- Activation through `useTaskActivation`.
- Worker claim and submit through `useTaskWork`.
- Buyer accept/reject through `useSubmissionReview`.
- Close/rate through `useTaskLifecycle` and `useRateHire`.

## Backend Boundary

This starter does not treat agenc.ag same-origin write routes as a hosted public
write API. The browser calls your own backend at:

```text
POST /api/agenc/job-specs/activate
```

The starter expects that route to:

1. Normalize the submitted job spec and hash its `json-stable-v1` canonical
   payload.
2. Host that payload in a worker-verifiable integrity envelope.
3. Record task moderation for `(taskPda, jobSpecHash)`.
4. Return:

```json
{
  "jobSpecHashHex": "64 lowercase hex chars",
  "jobSpecUri": "https://...",
  "moderationAttested": true
}
```

The document at `jobSpecUri` is an envelope. Its declared hash and the on-chain
commitment both cover the canonical `payload` only:

```json
{
  "integrity": {
    "algorithm": "sha256",
    "canonicalization": "json-stable-v1",
    "payloadHash": "64 lowercase hex chars"
  },
  "payload": {
    "schema": "agenc.marketplace.starter.jobSpec.v1",
    "taskPda": "...",
    "title": "...",
    "deliverables": ["..."],
    "acceptanceCriteria": ["..."]
  }
}
```

Only after that response does the browser sign `set_task_job_spec`.

If moderation is not attested, the route fails closed with `422` and the browser
must not sign activation. The handler also rejects oversized request bodies and
oversized canonical specs before calling storage or attestation adapters.

The route implementation lives in `server/`:

- `server/activate-job-spec.ts` validates the request, builds a canonical
  starter job-spec payload, computes the `json-stable-v1` hash, stores its
  integrity envelope, and asks an attestor to record task moderation.
- `server/file-store.ts` canonicalizes and validates the complete envelope, then
  publishes it through an immutable content-addressed local file store. Repeated
  writes of the same document are idempotent; an existing hash with different
  bytes fails closed.
- `server/remote-attestor.ts` posts the canonical payload to a moderation
  attestation service that records `TaskModeration`.
- `server/next-route.example.ts` shows how to wire those pieces into a Next.js
  App Router route at `app/api/agenc/job-specs/activate/route.ts`.
- `server/next-public-job-spec-route.example.ts` is the matching public GET
  route. Copy it to `app/job-specs/[hash]/route.ts`; it serves only exact
  64-hex content addresses with immutable cache headers. The configured public
  base URL must resolve to this route, not merely name the storage directory.
- `server/setup-check.ts` validates the environment variables shared by the
  route example and the local setup checker.

The Next route example expects:

```bash
AGENC_JOB_SPEC_DIR=.data/job-specs
AGENC_JOB_SPEC_PUBLIC_BASE_URL=https://your-marketplace.example/job-specs
AGENC_TASK_MODERATION_ATTEST_URL=https://your-attestor.example/api/task-moderation/attest
AGENC_TASK_MODERATION_ATTEST_TOKEN=<server-only token, if your attestor requires one>
```

`.data` is ignored by this starter because local job-spec files are generated
deployment data, not source.

The attestor is still a trust boundary: it must be controlled by the moderation
authority or a registered moderation attestor for your deployment. The starter
does not put that key in the browser.

## Wallet Boundary

The starter exposes a small wallet seam in `src/wallet.ts`. Wire it from your
Wallet Standard integration by setting:

```ts
window.agencWallet = {
  account,
  signTransaction
};
```

The starter then lifts that account into the SDK `TransactionSigner` with
`signerFromWalletAccount`.

## Environment

Create `.env.local`:

```bash
VITE_AGENC_NETWORK=devnet
VITE_AGENC_RPC_URL=https://api.devnet.solana.com
VITE_AGENC_INDEXER_URL=https://your-indexer.example
VITE_AGENC_BACKEND_URL=https://your-marketplace.example
VITE_AGENC_MODERATOR=<listing-and-task-attestor-wallet>
```

Optional referrer config:

```bash
VITE_AGENC_REFERRER_WALLET=<wallet>
VITE_AGENC_REFERRER_FEE_BPS=50
```

Runtime config keeps a devnet default for quick local experiments, but
deployment readiness should be explicit. After creating `.env.local` and setting
the backend variables in your shell or deployment environment, run:

```bash
npm run check:setup
```

The setup check validates required environment variables, URL shape, the
moderator address, referrer address/fee bounds, and the self-hosted activation backend trust-boundary
wiring. It also reminds you that browser wallet wiring is a runtime integration:
`window.agencWallet`, wallet signing, RPC broadcast, and settlement are not
proven by this command.

This command does not prove public npm registry installability, live wallet
signing, transaction broadcast, or devnet/mainnet settlement.

## Run

This is a package-local example. In this repository it aliases
`@tetsuo-ai/marketplace-react` and `@tetsuo-ai/marketplace-sdk` to local source
so it can exercise the current unreleased lifecycle hooks.

```bash
npm install
npm run dev
```

Run the backend route tests:

```bash
npm test
```

Verify the starter outside the monorepo source-alias path:

```bash
npm run verify:clean
```

That command is a prepublish package-artifact check. It packs the local SDK and
React packages, copies this starter to a temporary directory, removes source
aliases, rewrites the two AgenC dependencies to those package tarballs, asserts
the expected package exports, then runs install, typecheck, tests, and build
from the copied app. It proves the starter can consume package artifacts instead
of private `agenc.ag` app internals. It does not prove public npm registry
installability or a live wallet/devnet lifecycle.

Verify the same starter against the public npm registry:

```bash
npm run verify:registry
```

`verify:registry` copies this starter to a temporary directory, rewrites
`@tetsuo-ai/marketplace-react` and `@tetsuo-ai/marketplace-sdk` to public npm
versions, removes source aliases, rejects local/private references, asserts the
installed packages resolve from `https://registry.npmjs.org/` with integrity
metadata, checks the lifecycle hook declarations/exports, then runs install,
typecheck, tests, and build. By default it expects the local package versions to
exist on npm. This is the post-publish release gate for public registry
installability, and it still does not perform a live wallet/devnet lifecycle.

## Type Check In This Monorepo

From the protocol repo root:

```bash
npx tsc --noEmit -p packages/marketplace-react/examples/marketplace-starter/tsconfig.json
```
