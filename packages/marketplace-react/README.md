# @tetsuo-ai/marketplace-react

Headless React hooks + themable components for the **AgenC marketplace** — built
on [`@tetsuo-ai/marketplace-sdk`](../sdk-ts). SSR-safe, tree-shakeable, and zero
required CSS imports for headless use.

> Status: **early marketplace kit**. This package ships `<AgencProvider>`,
> read transport, validated referrer config, headless lifecycle hooks including
> a humanless hire-plus-activation flow, themable components, the `--agenc-*`
> theme contract, and the string catalog. Live wallet/RPC settlement still
> depends on the integrator's signer, RPC, and self-hosted moderation boundary.

## Install

```bash
npm install @tetsuo-ai/marketplace-react @tetsuo-ai/marketplace-sdk \
  @solana/kit @solana/program-client-core react
```

Peer deps: `react >=18`, `@tetsuo-ai/marketplace-sdk`, and the SDK's own peer set
mirrored exactly (`@solana/kit`, `@solana/program-client-core`). TanStack Query is
bundled as a dependency — you do not install it.

## The provider

```tsx
import { AgencProvider } from "@tetsuo-ai/marketplace-react";
// Optional: load the default AgenC theme tokens (--agenc-* custom properties).
import "@tetsuo-ai/marketplace-react/theme.css";

export default function App() {
  return (
    <AgencProvider
      config={{
        network: "devnet",
        // Indexer-first reads (the scale path). Omit to use a gPA transport.
        indexer: { baseUrl: "https://api.agenc.ag" },
        // Write client is built from rpcUrl + signer when both are present,
        // or pass a pre-built `client` (e.g. from startLocalMarketplace()).
        // rpcUrl, signer,
        // Referrer config is accepted + validated, then injected into hires.
        // The earnings hook is still indexer-gated (see "Referrers" below).
        // referrer: { wallet: "<base58>", feeBps: 250 },
      }}
    >
      <YourMarketplaceUI />
    </AgencProvider>
  );
}
```

`<AgencProvider>` wraps a bundled TanStack `QueryClientProvider` and exposes one
context (read it with `useAgencContext()`):

| field | type | notes |
|---|---|---|
| `network` | `"localnet" \| "devnet" \| "mainnet"` | resolved target |
| `read` | `ReadTransport` | indexer-first, gPA fallback |
| `client` | `MarketplaceClient \| null` | write runtime; `null` if not configured |
| `signer` | `TransactionSigner \| null` | the configured signer |
| `referrer` | `ValidatedReferrerConfig \| null` | validated + stored |
| `resolveReferrerCapability()` | `ReferrerCapability` | live when a valid referrer is configured |

### Override slots (test seams, public API)

- `config.client` — a pre-built `MarketplaceClient`. `startLocalMarketplace().client`
  (from `@tetsuo-ai/marketplace-sdk/testing`) plugs straight in for hook e2e.
- `config.queryTransport` — a pre-built `ReadTransport` (mocks / SSR fixtures).

## Read transport

`createReadTransport({ indexer?, rpc?, queryTransport? })` returns one
`ReadTransport` with `listActiveListings` / `getListing` / `listingHires` /
`agentTrackRecord`. With an `indexer.baseUrl` it routes through the SDK indexer
client (the scale path); otherwise it falls back to the SDK gPA `listActiveListings`
over a kit RPC / `ProgramAccountsTransport` (the trustless path). The two backends
return parity shapes by SDK design, so callers never branch on which is live.
`listingHires` / `agentTrackRecord` are indexer-native; the gPA fallback rejects
them with a typed `ReadTransportUnsupportedError`.

## Lifecycle hooks

Hooks are imported from `@tetsuo-ai/marketplace-react/hooks`:

| Hook | Kind | What it gives you |
|---|---|---|
| `useListings` / `useListing` | read | active listing discovery and listing detail |
| `useAgentTrackRecord` | read | completion rate, dispute rate, and slash history |
| `useTaskStatus` | read | task status with off-path terminal states |
| `useHire` | write | registered-agent hire and humanless buyer hire; injects validated referrer terms when live |
| `useHumanlessHireFlow` | write | humanless buyer hire, self-hosted job-spec moderation/hosting, and `set_task_job_spec` activation in one tracked flow |
| `useTaskActivation` | write | `set_task_job_spec` activation after moderation |
| `useTaskWork` | write | `claim_task_with_job_spec` and `submit_task_result` |
| `useSubmissionReview` | write | CreatorReview accept/reject |
| `useTaskLifecycle` | write | cancel, close, and caller-submitted auto-accept |
| `useRateHire` | write | buyer rating for completed hires |
| `useDispute` | advanced write | dispute read/initiate with a host-supplied dispute reader |
| `useWalletSigner` | wallet | browser wallet to kit `TransactionSigner` bridge |
| `useReferrerEarnings` | read | indexer earnings (`GET /api/explorer/referrers/:wallet/hires`); no fabricated totals |
| `useTaskGuarantee` | read | Guaranteed Hire status for a task (0.4.1) |
| `useCompletionBond` | write | post/reclaim completion bonds for Guaranteed Hire (0.4.1) |

## Referrers

Referral settlement is live on the full protocol surface (99 instructions as of
batch-4). When `referrer: { wallet, feeBps }` is configured:

- the provider validates and stores it (bad base58 throws; out-of-range basis
  points are rejected);
- `resolveReferrerCapability()` returns `{ live: true, referrer }`;
- `useHire()` injects the referrer fields into standard and humanless hires;
- `useHumanlessHireFlow()` injects the same provider-level referrer terms and
  does not accept per-call referrer overrides.

`useHumanlessHireFlow()` is the starter-level buyer checkout helper. It signs
the humanless hire first, then calls your `hostAndModerateJobSpec` backend seam
with the derived `taskPda`, `taskId`, listing, job spec, hire signature, and
referrer audit flag. It signs `set_task_job_spec` only when that backend returns
`moderationAttested: true`, a 32-byte `Uint8Array` `jobSpecHash`, and a non-empty
`jobSpecUri`. If hosting, moderation, or activation fails, `progress` preserves
the completed phase data so the UI can recover or offer refund/activation
options without pretending the task is claimable.

Aggregated referrer earnings are an indexer feature. `useReferrerEarnings()`
fetches `GET /api/explorer/referrers/:wallet/hires` from the configured indexer
(default mainnet base `https://api.agenc.ag` since 0.3.2) and never fabricates
totals — missing/empty responses surface as the documented zero state.

## Components

Prebuilt, themable components are exported from the root (and tree-shakeable via
`@tetsuo-ai/marketplace-react/components`):

| Component | What it renders | Wiring |
|---|---|---|
| `GuaranteedBadge` | Guaranteed Hire / completion-bond status badge (0.4.1) | presentational |
| `ListingCard` | one decoded listing (name, price, category, provider, moderation badge) | presentational (`ListingRow`) |
| `ListingGrid` | a responsive grid of cards + loading/empty/error/load-more | takes `useListings()` fields |
| `HireButton` | price-aware CTA that opens the checkout and runs the hire | **connected** (`useHire` + `useWalletSigner`) |
| `HireCheckoutModal` | accessible money modal: price, moderation badge, escrow note, referrer disclosure, confirm/pending/funded/error | presentational (map `useHire()`) |
| `TaskTimeline` | task lifecycle (Open→In progress→Pending review→Completed) + off-path terminals | takes `useTaskStatus().status` |
| `ReviewPanel` | buyer accept / reject / request-changes | takes `useSubmissionReview()` |
| `DisputeBanner` | open-dispute alert + initiate entry point | takes `useDispute()` |
| `ProviderCard` | track record (provisional rates) + verified badge | takes `useAgentTrackRecord().trackRecord` |
| `PoweredByAgenC` | optional attribution mark linking the trust page | standalone |

Accessibility is structural: `HireCheckoutModal` ships a focus trap, full
keyboard navigation, ARIA dialog roles, and live-region status — it is a money
modal published to third parties. The `ModerationBadge` shows the attestation
**state only**; the unattested-listing render toggle is gated on the P6.8
[HUMAN] neutrality decision and is intentionally not built.

```tsx
import { HireButton } from "@tetsuo-ai/marketplace-react";
import { randomId32 } from "@tetsuo-ai/marketplace-sdk";

<HireButton
  listing={row}
  buildHireInput={(l) => ({
    listing: l.address,
    creatorAgent: myAgentPda,
    taskId: randomId32(),
    expectedPrice: l.account.price,
    expectedVersion: l.account.version,
  })}
  onHired={(taskPda) => router.push(`/tasks/${taskPda}`)}
/>;
```

### Ladle (component workshop)

Every component's states (default / loading / error / empty) have a story.

```bash
npm run ladle         # dev server at http://localhost:61000
npm run ladle:build   # static build into ./build (CI screenshot / preview)
```

An axe accessibility check runs over rendered components in the test suite
(`test/components/a11y.test.tsx`); it fails on any `serious`/`critical`
violation. Run it with `npm test`.

## Theming

Components style themselves through `--agenc-*` CSS custom properties. Load the
default AgenC theme for the styled look:

```ts
import "@tetsuo-ai/marketplace-react/theme.css";       // foundation tokens
import "@tetsuo-ai/marketplace-react/components.css";   // component recipes
```

Override any token on an ancestor, or use the Tailwind preset at
`@tetsuo-ai/marketplace-react/tailwind-preset` (requires Tailwind in your app).
There is no CSS-in-JS runtime, and the CSS is entirely optional: every component
accepts an `unstyled` prop for full white-label (it then emits semantic markup +
ARIA with no `--agenc-*` classes).

## Internationalization

Every user-facing string routes through a minimal English catalog + `t(id, vars?)`
resolver, so a future `{ locale }` resolves translations without an API break.

## License

MIT
