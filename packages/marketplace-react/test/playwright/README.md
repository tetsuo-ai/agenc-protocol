# A3 checkout e2e — Playwright (browser) + jsdom (fallback)

Proves the PLAN_2 **A3** Done-when: the checkout flow completes a REAL hire
`funded -> accepted` against the local sandbox validator, asserting on-chain
settlement (Task reaches `Completed`, the worker is paid).

## What runs where

The checkout splits into a **buyer** half (done in the UI through the headless
hooks) and a **worker** half (no React hook exists for it — a real worker agent
does it off the storefront), so the worker half runs in Node:

```
BUYER (UI):    useHire().hire(humanless)  ............................  Task Open
WORKER (Node): moderate task -> set job spec -> claim -> submit  ...  PendingValidation
BUYER (UI):    useSubmissionReview().accept()  .....................  Completed + worker paid
```

`worker-harness.mjs` is the Node worker side, reused by both the browser spec and
the jsdom fallback. It signs `set_task_job_spec` with the buyer key (the buyer is
the task creator) and `claim`/`submit` with the seeded provider's authority
(`.localnet/keys/seeder.json`), attesting the task CLEAN with the moderator key.

## Browser run (primary Done-when)

```bash
cd test/playwright
npm install
npm run install-browsers          # playwright install chromium (cached if present)
npm test                          # boots sandbox, serves checkout (vite dev), drives Chromium
```

- `global-setup.mjs` boots the sandbox (idempotent), mints a fresh **extractable**
  buyer keypair, funds it, resolves the listing/treasury/worker params from chain,
  and writes both the checkout SPA's `public/sandbox-config.json` (the browser
  adopts the buyer key via the mock embedded wallet) and `.playwright-sandbox.json`
  (the spec's Node-side worker context, with the same buyer key).
- `global-teardown.mjs` stops the validator (`AGENC_KEEP_SANDBOX=1` to keep it).
- The SPA is served with `vite dev` (not `build && preview`) so the just-written
  `sandbox-config.json` is read live — a baked build would race global-setup.
- Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to pin a chromium binary if the managed
  Playwright download is unavailable.

The browser bridge: the page publishes `window.__checkout.taskPda` after the hire
and blocks on `window.__checkout.workerReady`; the spec runs the worker side, sets
that flag, then clicks Accept.

## No-browser fallback (always runs in `npm test` / vitest)

`checkout.e2e.test.tsx` is a **jsdom** vitest test that drives an inline mirror of
`CheckoutFlow` through the identical hook path against the live sandbox (booting
it in `beforeAll` if needed, skipping with a clear message if the validator/`.so`
prerequisites are missing). It exists because Playwright browser binaries may be
unavailable in CI; the on-chain assertions (Task `Completed` + worker balance up)
are the same. `ssr-render.test.tsx` is the jsdom companion for the A1 populated-grid
+ no-hydration-error proof.

> The jsdom test renders an *inline mirror* of `CheckoutFlow`, not the literal
> `test-apps/checkout/src/CheckoutFlow.tsx`, only to avoid the checkout app's
> second React copy pulling a duplicate dispatcher into the parent vitest. The
> literal component is exercised in a real browser by the Playwright spec (single
> React there). Keep the two in lockstep.

## Files

| File | Role |
|---|---|
| `playwright.config.ts` | Playwright config (globalSetup/teardown, vite-dev webServer, chromium). |
| `global-setup.mjs` / `global-teardown.mjs` | sandbox lifecycle + runtime config generation. |
| `checkout.spec.ts` | the browser e2e. |
| `worker-harness.mjs` | Node worker-side scaffolding (shared). |
| `checkout.e2e.test.tsx` | jsdom fallback for the checkout Done-when (vitest). |
| `ssr-render.test.tsx` | jsdom proof of the A1 populated grid + no hydration error (vitest). |
| `tsconfig.playwright.json` | typecheck config for the spec (deliberately NOT named `tsconfig.json` so vitest's esbuild does not pick it up and break the automatic JSX runtime). |
```
