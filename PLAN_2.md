# PLAN_2.md — The Embeddable Surface Layer: hooks → components → widget → store templates

> **Historical planning record (banner added 2026-07-17).** This is a dated execution spec, not current state: mainnet has run the full 99-instruction surface (`surface_revision = 4`) since 2026-07-09 — see `docs/MAINNET_MAINLINE.md` for live state and `docs/audit/ENTERPRISE_REMEDIATION_2026-07.md` for the completed remediation record. Dated body claims (including the 2026-06-11 update below) are kept as written.

**Status:** authored 2026-06-09. Detailed execution spec for the embeddable UI surface —
the layer that turns the SDK + program into things third parties actually deploy.
**Update (2026-06-11):** the "until Phase 9" mainnet gates below are now SATISFIED — the
full 84-instruction surface is live on mainnet (`surface_revision = FULL`, listings/hire
live, bid marketplace live, `ZkConfig` deferred). Mainnet mode no longer needs to wait on
Phase 9; the `getDeployedSurface` capability check still governs whether each surface is
advertised (it now returns `listings: true` on mainnet).
**Relationship to PLAN.md:** PLAN.md is the MASTER roadmap and keeps authority over
sequencing, gates, standing rules, and traceability. This document is the expanded
"how" for PLAN.md Phase 4 (P4.1–P4.4) and the new **P4.5 (store templates)** anchored
there. If the two documents conflict, PLAN.md's standing rules and phase gates win.
All PLAN.md standing rules apply verbatim here — especially rule 1 (LOCAL ONLY; every
publish/deploy/DNS/vendor/key action is **[HUMAN]**) and rule 4 (revert-sensitive tests).
**Audience:** an AI agent executing part by part. Every task has "Done when" criteria.

---

## 0. Why this layer decides the company

The market-evidence pass (PLAN.md Track D) established that the referral flywheel is
the entire embeddable go-to-market: a third party integrates only if it earns. The
four-tier ladder below progressively lowers the cost of becoming an earning embedder:

```
Tier 1  SDK / hosted API            integration cost: days      (PLAN.md Phases 1–3)
Tier 2  React hooks + components    integration cost: hours     (Part A)
Tier 3  Drop-in widget              integration cost: minutes   (Part B)
Tier 4  Store templates             integration cost: ~15 min,  (Part C — NEW)
        ("deploy your own agent      zero code, instantly
         store, earn bps")           revenue-generating
```

Tier 4 is the strategic one: it converts the D1 embedder problem from B2B sales
("integrate our SDK for a rev share") into self-serve ("click Deploy, paste your
wallet, you own a monetized agent store"). Every deployed store is also a distribution
node — more SEO surface, more llms.txt endpoints for agent crawlers, all settling on
the protocol rails. This is the Shopify-theme insight applied to the referral leg.

**North-star metric for this layer: time-to-earning-store** — a stranger goes from
the template README to a deployed, branded store that earns referral bps on a sandbox
hire in **under 15 minutes**.

**The load-bearing dependency, stated once:** every referrer feature in this document
(A1 injection, `useHire` auto-referrer, B1 `data-referrer`, C2 `referrer` config, the
`/earnings` page, and every "earns referral bps" Done-when) requires **PLAN.md P6.2**
(referrer args + 4th settlement leg) to be merged AND live on the target cluster
(devnet sandbox via the P2.2 redeploy cadence). Until then, referrer config is
accepted, validated, and stored — but NOT injected; the capability is checked at
runtime via P6.5 `getDeployedSurface`, and the earning Done-whens are **blocked on
P6.2, never silently waived**. Everything else in Parts A–D builds and tests without
P6.2.

---

## Part A — `@tetsuo-ai/marketplace-react` (PLAN.md P4.2, expanded)

**Location:** `packages/marketplace-react/` in this repo (sibling of `packages/sdk-ts`).
**Release machinery:** the pipeline PLAN.md P0.3–P0.4 establishes (sdk.yml CI,
changesets, tsup ESM+CJS+d.ts) — note it does NOT exist yet; if Part A starts before
Phase 0 lands, build with tsup and join the release machinery when it appears. npm
publish **[HUMAN confirms publish]**; the package cannot publish before
`@tetsuo-ai/marketplace-sdk` itself does (P0.5).
**Peer deps:** `react >=18`, `@tetsuo-ai/marketplace-sdk`, plus the SDK's own declared
peer set mirrored exactly — today that is `@solana/kit` AND `@solana/program-client-core`
(PLAN.md P0.2 exists because omitting the second one broke the SDK README; do not
repeat that here).
**Design constraints:** SSR-safe (no window access at module scope — templates are
Next.js); tree-shakeable; zero CSS imports required for headless use. All user-facing
strings route through a minimal string catalog (English-only at v1) so a future
`locale` can resolve translations without an API break.

### A1 Provider + transport layer
- `<AgencProvider config={{ network, rpcUrl?, indexer?: { baseUrl, apiKey? },
  referrer?: { wallet, feeBps }, signer?, client?, queryTransport? }}>` — one context
  that wires:
  - reads: **indexer-first with RPC/gPA fallback** (the P1.2 `queries` ↔ P3.2
    `createIndexerClient` parity makes them interchangeable transports);
  - writes: the P1.1 `createMarketplaceClient` runtime;
  - the referrer config, injected into every hire built under this provider (the
    one-line-of-config promise in PLAN.md exit criterion #4) — subject to the P6.2
    capability check in §0: absent on the cluster → accepted but not injected;
  - **`client?` and `queryTransport?` are explicit override slots**: the P2.1
    `startLocalMarketplace()` litesvm harness's `{ client }` plugs straight into the
    provider for hook e2e tests, and mock transports use the same slots. Without
    these, the mandated hook tests cannot be built — they are part of the public API.
- Internal fetch/cache layer: wrap TanStack Query (bundled as a dependency, not a
  peer) so hooks get caching/refetch/optimistic states without consumer config.
- **Done when:** a 30-line React app (provider + one hook + one component) renders
  listings — against litesvm via the `client` override in CI, and against the live
  devnet sandbox (P2.2–P2.4, [HUMAN]-deployed) when it exists; SSR render in the
  committed fixture app `packages/marketplace-react/test-apps/next-ssr` (Next.js 15,
  App Router) produces no hydration errors.

### A2 Headless hooks (inventory + contracts)
| Hook | Returns | Notes |
|---|---|---|
| `useListings(filter?)` | `{ listings, isLoading, error, fetchMore }` | category/provider/state filters; paginated |
| `useListing(pda)` | `{ listing, provider, trackRecord, moderation }` | joins listing + agent + attestation state |
| `useHire()` | `{ hire(listing, opts), status, taskPda, signature, error }` | full hire tx via the runtime client; referrer auto-injected (§0 P6.2 gate) |
| `useTaskStatus(taskPda)` | `{ task, status, submission, events }` | P1.3 subscription with poll fallback |
| `useSubmissionReview(taskPda)` | `{ accept(), reject(), requestChanges(), status }` | buyer-side settlement actions |
| `useAgentTrackRecord(agentPda)` | `{ completionRate, disputeRate, slashHistory, recentOutcomes }` | until PLAN.md P6.6 lands: completionRate from existing success-side stats, disputeRate/slashHistory `null`; e2e scoped accordingly |
| `useDispute(taskPda)` | `{ dispute, initiate(), status }` | dispute entry + state |
| `useWalletSigner()` | `{ signer, connected, connect() }` | bridges Wallet Standard / wallet-adapter (P4.1) into the kit `TransactionSigner` |
| `useReferrerEarnings(wallet)` | `{ totalLamports, hires[] }` | for the C3 `/earnings` page; reads the P6.2 referrer fields snapshotted on HireRecord (see C3 for the data path) |
- Every mutating hook surfaces typed `AgencError`s from the runtime client untouched.
- **Done when:** each hook has structural tests (mock transport) + one e2e test
  against the litesvm harness via the A1 `client` override; the full
  hire→review→accept flow runs through hooks alone (no direct SDK calls) in a test
  app.

### A3 Prebuilt components
Inventory (from PLAN.md P4.2, with theming contract):
`ListingCard`, `ListingGrid`, `HireButton`, `HireCheckoutModal` (price + moderation
badge + escrow funding + confirmation states), `TaskTimeline`, `ReviewPanel`
(accept / reject / request-changes), `DisputeBanner`, `ProviderCard` (track record +
verified badge), `PoweredByAgenC` (optional, links the trust page).
- **Theming:** CSS custom properties (`--agenc-*`). The default theme is **vendored**
  from the sibling repo `agenc-ui-design-skill` — copy `tokens/colors.css` (+ the
  tailwind preset) into `packages/marketplace-react/src/theme/agenc-tokens.css` with
  a sync-header comment recording the source commit (cross-repo imports are
  impossible in CI; `store-core` consumes the theme from marketplace-react, never
  from the design-skill repo directly). Every component also accepts `unstyled` for
  full white-label. No CSS-in-JS runtime.
- **Moderation surfaced aggressively:** `ListingCard`/`Checkout` show attestation
  badges. Unattested-listing rendering is **conditional on the PLAN.md P6.8 [HUMAN]
  neutrality decision — do not build the toggle before it**: under option (a) it's a
  flagged opt-in render, under (b) it becomes an attestor selector, under (c) it does
  not exist.
- **Accessibility is structural, not a retrofit:** `HireCheckoutModal` is a
  money-handling modal published to third parties — focus trap, keyboard navigation,
  and ARIA land with the first public version.
- **Done when:** Ladle (lighter, Vite-native; config at
  `packages/marketplace-react/.ladle/`) covers every component state including error,
  loading, and empty; a visual smoke job + axe accessibility check (a11y ≥ 95) runs
  in the sdk.yml matrix; the checkout modal completes a real hire in a Playwright
  test against the devnet sandbox (P2.2–P2.4) — or, for deterministic CI, against a
  local `solana-test-validator` loaded with the repo-built `.so` plus injected
  ProtocolConfig/ModerationConfig via a committed bootstrap script
  (`packages/marketplace-react/test/sandbox-up.mjs`).

---

## Part B — The drop-in widget (PLAN.md P4.3, expanded)

**What:** the Stripe-Checkout equivalent — one `<script>` tag or iframe gives any
website (no React, no build step) a working hire flow.
**Where it's built:** `agenc-services-storefront` (separate repo, Vite + React 19) —
`embed.js` is a NEW Vite lib-mode IIFE entry (`src/embed/loader.ts` → `dist/embed.js`),
and `/embed/:listingPda` is a second HTML entry in the same repo, consuming
`@tetsuo-ai/marketplace-react` **from npm** (until the Part A publish lands, install
the `npm pack` tarball — the storefront cannot workspace-link across repos). Hosted at
`marketplace.agenc.tech/embed/:listingPda` **[HUMAN: deploys]**. The embed page is a
consumer of Part A components, not a parallel implementation.

### B1 Embed page + snippet
- Snippet: `<script async src="https://marketplace.agenc.tech/embed.js"
  data-listing="<pda>" data-referrer="<wallet>" data-theme="dark"></script>` —
  renders a `HireButton` that opens the checkout in an iframe overlay. Direct iframe
  embedding also supported for full-card mode.
- Params: listing PDA, referrer wallet (the site owner earns bps — §0 P6.2 gate
  applies), theme tokens. (`locale` is reserved but inert until the string catalog
  grows a second language.)
- **E2E signing:** Playwright has no wallet extension, and B2 forbids signing
  material crossing the iframe boundary. The embed page therefore supports a
  **test-only local-keypair signer** enabled exclusively in test builds
  (`AGENC_E2E_SIGNER` at build time), funded by devnet airdrop — and a build-output
  assertion proves the test signer is absent from the production bundle.
- **Done when:** a plain static HTML page (fixture in the repo) completes a sandbox
  hire end-to-end via the snippet in a Playwright test using the test-build signer;
  the production-bundle assertion passes.

### B2 postMessage event contract (versioned, documented)
Events emitted to the host page (origin-checked both directions):
`agenc:ready`, `agenc:hire:started`, `agenc:hire:funded {taskPda, signature}`,
`agenc:task:status {status}`, `agenc:task:accepted`, `agenc:closed`,
`agenc:error {code, message}`.
- Host→widget: `agenc:configure {theme}` only. No signing material ever crosses the
  boundary — all wallet interaction happens inside the iframe (P4.1 bridge, or the
  P4.4 embedded-wallet flow for walletless buyers).
- **Security:** strict `targetOrigin` on every postMessage; CSP on the embed page
  (no inline script; frame-ancestors policy decided with the human — default `*`
  for embeddability, with an optional registered-domains mode tied to the embedder's
  API key); referrer wallet is validated as a base58 pubkey and surfaced in the
  checkout UI ("this site earns a referral fee" — disclosure builds trust).
- **Done when:** the event contract is published in docs with a versioned schema;
  cross-origin tests cover origin spoofing and malformed messages.

---

## Part C — Store templates + `create-agenc-store` (NEW — PLAN.md P4.5)

**The product:** "deploy your own agent store" as a self-serve, revenue-generating
artifact. Templates are config-first: curation and branding live in ONE file; the
deployer never touches protocol code.

### C1 Repo + variants **[HUMAN: creates the public repo]**
- **Location:** a NEW public repo `tetsuo-ai/agenc-store-templates` (templates MUST
  be public from day one for one-click deploy buttons — this does not depend on
  P0.6's decision about the protocol repo). Monorepo layout:
  ```
  agenc-store-templates/
  ├── templates/
  │   ├── marketplace-store/     # full catalog: grid, categories, search
  │   ├── provider-storefront/   # single provider: "my agency's agents"
  │   └── vertical-store/        # one curated category, e.g. code review
  ├── packages/create-agenc-store/   # the scaffold CLI (npm)
  └── packages/store-core/           # shared: config schema, SEO, layouts, sandbox-up
  ```
- **Stack (pinned):** Next.js 15.x (App Router) + React 19 + Tailwind 4 +
  `@tetsuo-ai/marketplace-react` + the P3.2 indexer client. Default theme is the
  marketplace-react vendored brand tokens (A3); every brand surface overridable
  (white-label is the point — the "powered by AgenC" footer is optional but on by
  default, doubling as the referral disclosure).
- All three variants share `store-core`; they differ in routing + default curation,
  not in plumbing. The vertical-store variant exists specifically so the PLAN.md D3
  verticals can launch focused stores (quality density over breadth).
- **Architecture rule (enables C7):** ALL protocol/hire logic lives in the versioned
  npm packages (`store-core`, `marketplace-react`) — template code is layout +
  config only, so an instance update is "bump deps + redeploy", never a
  template-code merge.
- **Done when:** all three templates build green in the repo's CI matrix and run
  against the sandbox fixtures.

### C2 `agenc.config.ts` — the single configuration surface
```ts
export default defineStore({
  name: "Acme Agent Store",
  description: "...",                       // SEO + OG + llms.txt
  network: "devnet" | "mainnet",            // mainnet warns loudly until Phase 9 (below)
  api: { baseUrl, apiKey? },                // P3.2 hosted indexer
  referrer: { wallet: "<base58>", feeBps },  // EVERY hire pays the store owner (P6.2; §0 gate)
  branding: { logo, colors?, font?, poweredBy?: boolean },
  curation: {
    categories?: ListingCategory[],          // carry only these
    providers?: Address[],                   // or only these providers
    include?: Address[], exclude?: Address[],// listing-level allow/deny
    minRating?: number,                      // once P6.1 rate_hire is live
    requireModeration: true,                 // shape depends on the P6.8 [HUMAN]
  },                                         //   decision — see A3; default stays ON
  payments: {
    wallets: true,                           // Wallet Standard (P4.1)
    embedded?: boolean,                      // resolved to the ONE D-1 [HUMAN]-chosen
                                             //   vendor; zod rejects if unimplemented
    fiat?: boolean,                          // P4.4 fiat leg, off until it exists
    x402?: boolean,                          // reserved NOW (off until P5.4 ships) so
  },                                         //   adding the fast path isn't a breaking change
  seo: { siteUrl, ogImage?, llmsTxt: true, jsonLd: true, sitemap: true },
});
```
- Validated with zod at build time; misconfiguration fails the build with actionable
  errors. Specifically: `referrer.wallet` must parse as base58 (a wrong wallet must
  never silently drop the owner's fees); `referrer.feeBps` is range-checked and the
  docs explain the P6.2 combined cap (protocol + operator + referrer ≤ 4000 bps) —
  the checkout pre-computes the per-listing combined split and surfaces a clear
  error BEFORE building a transaction that would revert on-chain;
  `network: "mainnet"` fails with an explicit override flag until Phase 9, and at
  boot the store runs P6.5 `getDeployedSurface` — if listings aren't live it renders
  an explicit "mainnet listings are not live yet" page instead of an empty grid
  (the `SurfaceNotDeployedError` path).
- **Done when:** the schema is exported from `store-core` with full TSDoc; a config
  round-trip test covers every field; fixtures for invalid-wallet, over-cap feeBps,
  and un-overridden mainnet each fail the build with the right message.

### C3 Page inventory (per template, from `store-core`)
- `/` — listing grid, category filters, search (indexer-backed).
- `/listings/[pda]` — detail: spec, price, provider `ProviderCard` (track record,
  verified badge, ratings once live), moderation badge, `HireButton`. SSR + JSON-LD
  (schema.org Service/Offer) + OG tags — this page IS the P10.3 SEO surface, shipped
  per-store instead of only on marketplace.agenc.tech. Once P5.4 ships, listings
  priced under the threshold route their CTA to the x402 fast path with escalation
  to escrowed hire.
- `/dashboard` — buyer's tasks: status timeline, `ReviewPanel`, dispute state.
  (Wallet-gated client-side; no server session needed.)
- `/earnings` — **the store OWNER's page**: readonly, keyed to the configured
  `referrer.wallet` (all public on-chain data, no auth): total referral lamports
  earned, per-hire breakdown, recent hires. The Tier-4 pitch is "deploy a store,
  earn bps" — owners must be able to SEE it. Data path: `useReferrerEarnings`,
  backed by an SDK `listHireRecordsForReferrer()` over the P6.2 referrer fields
  snapshotted on HireRecord, with `GET /api/explorer/referrers/:wallet/hires` added
  to PLAN.md P3.1's endpoint list as the indexer transport.
- `/providers/[pda]` — provider profile.
- `/trust` — what protects the buyer: escrow/bond/dispute explainer, moderation
  policy link, fee disclosure (protocol + operator + **this store's referral bps +
  wallet** — mirroring the B2 widget disclosure so the earning party is always
  visible), link to the credible-exit doc (PLAN.md P8.6).
- `sitemap.xml`, `robots.txt`, `llms.txt` + per-listing AgentCard JSON — agent
  crawlers can discover and act on the store's supply (shares implementation with
  P10.3/P5.4's AgentCard work).
- **Empty/error states are specced, not improvised:** empty catalog (pre-Phase-9
  mainnet → the C2 surface-check page; devnet → "no listings match" with seeded-
  fixture hint), zero-match curation filters, and indexer-unreachable (cached/static
  fallback + retry) each have a designed state.
- **Done when:** Lighthouse SEO ≥ 95 AND accessibility ≥ 95 on listing pages;
  JSON-LD validates; llms.txt serves; the dashboard drives a sandbox hire from
  funded → accepted; each specced empty/error state renders in the template CI.

### C4 `create-agenc-store` (scaffold CLI, npm)
- `npx create-agenc-store my-store` → prompts: template variant, store name,
  network (devnet default until Phase 9), referrer wallet, branding basics →
  generates the app with `agenc.config.ts` filled in, `.env.example`, README with
  deploy buttons. `--yes` + flags for non-interactive use (agents will run this).
- **Done when:** scaffold → `npm run dev` → working store against the sandbox in
  under 5 minutes on a clean machine, covered by a CI smoke test
  **[HUMAN confirms npm publish]**.

### C5 One-click deploy + distribution **[HUMAN: vendor/listing actions]**
- Vercel + Netlify deploy buttons on each template README (env-var wiring for
  config overrides). Submit to the Vercel Templates gallery; GitHub topics; a
  showcase page on the docs site listing live stores.
- **Abuse stance (required before gallery submission):** publish an acceptable-use
  policy covering the API keys template stores consume; a report path; and document
  **API-key revocation as the takedown lever** — stores are self-hosted forks that
  cannot be deleted, but every store consumes the hosted indexer via its key. The
  template checkout's referrer disclosure (C3 `/trust` + checkout) keeps the earning
  party visible to buyers.
- **Time-to-earning-store measurement protocol:** a participant who has not seen the
  repo (human recruits — part of this task's [HUMAN] flag), clock from README open
  to the first referral-fee-bearing sandbox hire confirmed, screen-recorded; result
  recorded in the templates repo at `docs/TIME_TO_STORE.md`.
- **Done when:** clicking Deploy on a fork produces a working devnet store with no
  local tooling; the <15-minute metric is measured per the protocol above (this
  Done-when is P6.2-gated per §0); AUP published.

### C6 Dogfood: rebuild the first-party storefront ON the template **[HUMAN: deploys the rebuilt storefront]**
- `agenc-services-storefront`'s catalog UI (today a Vite+React SPA with a
  file-backed catalog) is rebuilt as a `marketplace-store` template instance reading
  the on-chain book via the indexer — making PLAN.md P10.1's "storefront becomes
  operator #1" literally an instance of the same artifact third parties deploy.
  This is a rebuild (Vite SPA → Next.js template), not a refactor — scope it
  honestly.
- **Done when:** the storefront catalog renders from the template + indexer on
  devnet, verified locally; live after the human deploys (mainnet after Phase 9).
  PLAN.md P10.1's Steps already reference this instance.

### C7 Instance upgrade story (deployed stores are forks Renovate never sees)
- One-click deploys create forks that no bot updates. Within this plan's horizon
  every deployed store must absorb at least the Phase 9 devnet→mainnet flip and any
  checkout security fix. Three mechanisms:
  1. The C1 architecture rule: updates are "bump `store-core`/`marketplace-react` +
     redeploy", never a template-code merge.
  2. A staleness check: at build/boot the store compares its `store-core` version
     (and P6.5 `surface_revision`) against current and renders an **owner-visible
     update banner** when behind — security-relevant updates marked as such.
  3. A documented upgrade path in every template README + a changelog feed the
     banner links to.
- **Done when:** a deliberately outdated instance shows the banner in a template CI
  test; the upgrade doc takes a stale scaffold to current with only a dep bump.

---

## Part D — Walletless + fiat onboarding (PLAN.md P4.4, expanded)

- **D-1 Signer adapters:** `signerFromWalletAccount()` (Wallet Standard / P4.1) and
  `signerFromEmbeddedWallet(provider)` wrapping ONE chosen embedded-wallet vendor
  behind a common interface so templates/widget toggle it by config.
  **[HUMAN: vendor selection — evaluation criteria: Solana tx-signing support,
  email/social login, key custody model, pricing, SDK weight].** The C2
  `payments.embedded` boolean resolves to this vendor.
- **D-2 Fiat leg:** two options from PLAN.md P4.4 — on-ramp session in the checkout
  modal, or the custodial hire-on-behalf endpoint (carries a money-transmission-
  shaped regulatory surface; **[HUMAN: compliance decision before any build]**).
  Templates expose `payments.fiat` only after one exists.
- **Done when:** a buyer with no wallet and no SOL completes a sandbox hire via the
  embedded-wallet path — the harness funds the freshly created embedded wallet by
  devnet airdrop behind the scenes; the fiat leg is NOT required for this Done-when.

---

## Part E — Sequencing, dependencies, CI

```
A (marketplace-react)
  build:        P1.1 (client), P1.2 (queries), P1.3 (events), P4.1 (wallet bridge)
  release:      P0.3–P0.5 (sdk.yml, changesets, the SDK itself published first)
  hook e2e:     P2.1 litesvm harness via the A1 `client` override (no RPC needed)
  browser e2e + "live sandbox" Done-whens:
                P2.2–P2.4 [HUMAN deploys] OR the committed local-validator
                bootstrap (test/sandbox-up.mjs)
  referrer leg: P6.2 merged AND live on the target cluster (§0) — gates every
                "earns bps" Done-when in A/B/C
  track record: P6.6 partial (hook returns nulls until it lands)

B (widget)      needs A published to npm (or npm-pack tarball install — the
                storefront is a separate repo and cannot workspace-link) +
                storefront hosting [HUMAN deploy]

C (templates)   needs A + P3.1/P3.2 (indexer with listings endpoints; /earnings
                additionally needs the referrers endpoint added to P3.1) +
                sandbox fixtures; C6 dogfood needs P3.1 indexing live

D (walletless)  needs A; vendor + compliance [HUMAN] gates
```
- **Templates-repo CI sandbox ("pinned"):** a `store-core` script
  (`scripts/sandbox-up.mjs`) extracts the program `.so` from the pinned
  `@tetsuo-ai/marketplace-sdk` npm tarball (P2.1 ships it as the testing fixture),
  boots `solana-test-validator`, injects ProtocolConfig/ModerationConfig and
  P2.4-style listing fixtures. "Pinned" = the exact SDK version the templates
  already pin. Live-devnet runs are a separate nightly job, allowed to be flaky.
- **Track D is not blocked on this layer:** if templates are not ready by D2's
  month-2 target, run D2 on a bare sandbox listing per PLAN.md D2, and re-run it on
  a `vertical-store` instance later as the template proof. Never invert Track D's
  purpose by chaining the demand experiment to the Tier-2–4 stack.
- Templates are deliberately **devnet-first**: stores work fully against the sandbox
  before Phase 9; mainnet flips via C7's upgrade path.
- CI: `marketplace-react` joins the protocol repo's sdk.yml matrix (incl. the Ladle
  visual smoke + axe job); the templates repo gets its own CI (build matrix × 3
  templates, scaffold smoke test, Playwright hire-flow test against the sandbox-up
  validator).
- Versioning: `marketplace-react` semver-locked to a `marketplace-sdk` range;
  templates pin exact minor versions of `@tetsuo-ai/marketplace-react` and
  `@tetsuo-ai/marketplace-sdk`; Renovate keeps those two current in the templates
  repo (deployed instances are covered by C7, not Renovate).

## Part F — Acceptance criteria for the whole layer

1. **React:** provider + 1 hook + 1 component (<30 lines) renders live listings; the
   full hire→accept flow works through hooks alone.
2. **Widget:** a static HTML page completes a sandbox hire via the snippet (test-build
   signer); the postMessage contract is published and versioned; the production
   bundle provably excludes the test signer.
3. **Templates:** time-to-earning-store < 15 minutes, measured per the C5 protocol
   (P6.2-gated); store owners can see their earnings on `/earnings`.
4. **Walletless:** a no-wallet buyer completes a hire via the embedded-wallet path.
5. **Dogfood:** the first-party storefront runs on the public template.
6. **Upgradeability:** a stale deployed instance detects it and upgrades via dep bump
   alone (C7).
7. Every package published with provenance, changelogs, and the same drift/test
   discipline as the SDK **[HUMAN confirms each publish]**.

## Traceability

| This doc | PLAN.md | Audit finding |
|---|---|---|
| Part A | P4.2 | #6, #21 |
| Part B | P4.3 | #21 |
| Part C | **P4.5** (anchor) + P10.1/P10.3 overlap + P3.1 (referrers endpoint) | #21, #11, #12 + Track D (D1 self-serve referral, D2 venue) |
| Part D | P4.4 | #23 |
| §0 P6.2 gate | P6.2, P6.5 | #29, #26 |
