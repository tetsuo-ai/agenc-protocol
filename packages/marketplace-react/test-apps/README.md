# `@tetsuo-ai/marketplace-react` test apps + proof harnesses

The committed fixtures that prove the PLAN_2 Part A Done-whens against the
**localnet** stack (localnet-first: no devnet/deploy required). Two apps plus a
Playwright suite, all driven by one local validator booted from the repo-built
program `.so` + injected ProtocolConfig/ModerationConfig.

## Layout

| Path | What |
|---|---|
| `../test/sandbox-up.mjs` | The committed bootstrap. Reuses `scripts/localnet-up.mjs` (validator + protocol/moderation config + `.localnet/env.json`) then `packages/sdk-ts/scripts/seed-devnet-sandbox.mjs` (10 Active listings, attested CLEAN, into `.localnet/fixtures.json`). Exposes `start()`/`stop()`/`readSandboxEnv()` + a CLI. |
| `next-ssr/` | Next.js 15 App Router SSR fixture (PLAN_2 **A1** Done-when): `<AgencProvider>` + `useListings` + the real `<ListingGrid>` in a 30-line page. SSR-safe, no hydration errors. |
| `checkout/` | Vite + React checkout fixture (PLAN_2 **A3** Done-when): drives a REAL hire `funded -> accepted` through `useHire` + `useSubmissionReview`, using the mock embedded-wallet seam (no browser extension). |
| `../test/playwright/` | Playwright browser e2e that drives `checkout/` through a real hire in Chromium, plus the worker-side Node scaffolding and a jsdom fallback. |

## The sandbox bootstrap

```bash
# from packages/marketplace-react/
node test/sandbox-up.mjs up        # boot + init + seed (idempotent; converges)
node test/sandbox-up.mjs env       # print the resolved sandbox env JSON
node test/sandbox-up.mjs down      # stop the validator
node test/sandbox-up.mjs down --purge   # stop + wipe the ledger
```

Prerequisites (same as `scripts/localnet-up.mjs`):
- `solana-test-validator` + `solana-keygen` on PATH,
- `anchor build` output at `programs/agenc-coordination/target/deploy/agenc_coordination.so` (full surface),
- the built SDK at `packages/sdk-ts/dist` (`cd packages/sdk-ts && npm run build`).

After `up`, browser apps read the RPC + program id from `.localnet/env.json` and
the seeded listing addresses from `.localnet/fixtures.json`. There is no local
indexer, so reads use the SDK **gPA** read transport over the validator RPC
(`createReadTransport({ rpc })`), and writes use a client built **without
`rpcSubscriptions`** so confirmation is by `getSignatureStatuses` polling
(solana-test-validator's PubSub is not reliably reachable from a headless-browser
origin).

## A1 — Next.js SSR fixture (`next-ssr/`)

```bash
cd test-apps/next-ssr
npm install
node scripts/capture-fixtures.mjs   # snapshot REAL seeded listing bytes (needs sandbox up)
npx next build                      # Done-when: builds with no error
node scripts/check-ssr.mjs --port 3100   # Done-when: page+provider+grid SSR shell, no error boundary
```

- `app/fixture-transport.ts` decodes the **real** seeded `ServiceListing` bytes
  captured by `scripts/capture-fixtures.mjs`, so the SSR app renders the genuine
  `<ListingGrid>` with NO validator at build/test time. Set
  `NEXT_PUBLIC_AGENC_RPC_URL` to read live from a running sandbox via gPA instead.
- `check-ssr.mjs` asserts the server HTML contains the `<h1>`, the
  `agenc-listing-grid` root, and the loading `StateMessage` (the grid SSRs in its
  loading state — server and first client render match, so no hydration
  mismatch). The POPULATED grid (post-hydration) is proven by the jsdom test
  `../test/playwright/ssr-render.test.tsx` and the Playwright browser run.

## A3 — checkout fixture (`checkout/`) + Playwright

See `../test/playwright/README.md`.

## Regenerating the captured SSR fixtures

The SSR app renders committed real listing bytes. After re-seeding the sandbox
(addresses change), refresh them:

```bash
node test/sandbox-up.mjs up
cd test-apps/next-ssr && node scripts/capture-fixtures.mjs
```
