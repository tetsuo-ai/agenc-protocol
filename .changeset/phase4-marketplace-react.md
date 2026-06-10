---
"@tetsuo-ai/marketplace-react": minor
---

Initial release of @tetsuo-ai/marketplace-react (PLAN.md Phase 4 / PLAN_2 Part A):
`<AgencProvider>` (indexer-first reads with gPA fallback, client/queryTransport
override slots), headless hooks (useListings, useListing, useHire, useTaskStatus,
useSubmissionReview, useAgentTrackRecord, useDispute, useWalletSigner,
useReferrerEarnings), themable components (ListingCard, ListingGrid, HireButton,
HireCheckoutModal, TaskTimeline, ReviewPanel, DisputeBanner, ProviderCard,
PoweredByAgenC) with structural accessibility, vendored --agenc-* brand tokens,
and wallet signer adapters (Wallet Standard via @solana/react + a test-only
embedded-wallet mock on the ./testing subpath). The referrer config is validated
and disclosed but injection is gated behind a capability resolver until the
on-chain referrer leg (P6.2) ships — never injected, never faked.
