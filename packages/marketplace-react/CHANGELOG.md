# @tetsuo-ai/marketplace-react

## 0.1.1

### Patch Changes

- Widen the `@tetsuo-ai/marketplace-sdk` peer range to `^0.4.0 || ^0.5.0 || ^0.6.0`.
  The published 0.1.0 pinned `^0.4.0`, which on a 0.x caret excludes sdk 0.5.0+ and
  made installs alongside the current SDK fail peer resolution.

## 0.1.0

Initial scaffold (PLAN.md P4.2 / PLAN_2.md Part A).

- `<AgencProvider>` context: indexer-first read transport with RPC/gPA fallback,
  the write `MarketplaceClient` (with a `client` override slot), the resolved
  referrer config and `resolveReferrerCapability()` (the P6.2 gate — not-live
  today), and the signer. Wraps a bundled TanStack Query client.
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
  honors the P6.2 gate (pending-support copy; never claims a charged fee).
- Optional component-recipe stylesheet at `./components.css` (no CSS-in-JS).
- Ladle stories for every component state (`.ladle/`, `npm run ladle`) and an
  axe accessibility check in the test suite (fails on serious/critical).
