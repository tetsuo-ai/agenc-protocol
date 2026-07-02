# @tetsuo-ai/marketplace-react

## 0.3.0

### Minor Changes (breaking against pre-A1 programs)

- Require `@tetsuo-ai/marketplace-sdk@^0.7.0` as the peer dependency (was
  `^0.4.0 || ^0.5.0 || ^0.6.0`). The mainnet program was upgraded 2026-07-02
  with the WP-A1 roster moderation gates (breaking IDL: an optional
  `moderation_attestor` account on `set_task_job_spec` /
  `hire_from_listing` / `hire_from_listing_humanless`); hooks driving those
  instructions through an older sdk are rejected fail-closed by the deployed
  program, so the old peer range would resolve to broken installs.

## 0.2.0

### Minor Changes

- Add the humanless marketplace lifecycle hook surface under `./hooks`, including
  `useHumanlessHireFlow`, task activation, worker submission, buyer review,
  task close, and hire rating helpers for escrow-backed service-listing flows.
- Add the marketplace starter example with a self-hosted job-spec activation
  route, setup-readiness checks, clean package-artifact verification, public
  registry verification, and a UI lifecycle smoke covering hire, activation,
  claim, submit, accept, rate, and close with injected seams.
- Extend lifecycle tests, signer exports, and referrer handling so builders can
  exercise the same listing-to-settlement path through public SDK and React
  package surfaces.

## 0.1.1

### Patch Changes

- Widen the `@tetsuo-ai/marketplace-sdk` peer range to `^0.4.0 || ^0.5.0 || ^0.6.0`.
  The published 0.1.0 pinned `^0.4.0`, which on a 0.x caret excludes sdk 0.5.0+ and
  made installs alongside the current SDK fail peer resolution.
- Treat protocol referral settlement as live with sdk 0.6.0: provider referrer
  config now injects into hires, while aggregated referrer earnings remain
  indexer-gated.

## 0.1.0

Initial scaffold (PLAN.md P4.2 / PLAN_2.md Part A).

- `<AgencProvider>` context: indexer-first read transport with RPC/gPA fallback,
  the write `MarketplaceClient` (with a `client` override slot), the resolved
  referrer config and `resolveReferrerCapability()`, and the signer. Wraps a
  bundled TanStack Query client.
- `createReadTransport()` unified read interface
  (`listActiveListings` / `getListing` / `listingHires` / `agentTrackRecord`).
- Vendored AgenC brand theme (`--agenc-*` CSS custom properties) +
  side-effect `theme.css` export and a Tailwind preset.
- Minimal English string catalog + `t(id, vars?)` resolver.
- Prebuilt themable components (PLAN_2 A3), exported from the root and the
  tree-shakeable `./components` subpath: `ListingCard`, `ListingGrid`,
  `HireButton` (connected over `useHire`), `HireCheckoutModal` (accessible money
  modal: price + moderation badge + escrow note + referrer disclosure +
  confirmation states, focus trap + ARIA), `TaskTimeline`, `ReviewPanel`,
  `DisputeBanner`, `ProviderCard`, `PoweredByAgenC`, plus shared primitives
  (`Modal`, `Button`, `Badge`, `Spinner`, `StateMessage`) and the
  `ModerationBadge`/`VerifiedBadge`. Each accepts `unstyled` for white-label and
  routes copy through a `components.*` string catalog. The referrer disclosure
  never claims a charged fee while inactive.
- Optional component-recipe stylesheet at `./components.css` (no CSS-in-JS).
- Ladle stories for every component state (`.ladle/`, `npm run ladle`) and an
  axe accessibility check in the test suite (fails on serious/critical).
