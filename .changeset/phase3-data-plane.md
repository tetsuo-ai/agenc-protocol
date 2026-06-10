---
"@tetsuo-ai/marketplace-sdk": minor
---

Phase 3 data-plane SDK surfaces: `createIndexerClient()` (a hosted-indexer read
transport with decode-parity against the `queries` gPA module — drop-in for the
default valid-only listing view), `verifyAgencWebhookSignature()` (WebCrypto
HMAC verification of the storefront's `X-Agenc-Signature` deliveries), and
`requestListingModeration()` exposed at the package root (the production P3.4
moderation helper, resolved through the `AGENC_SANDBOX_MODERATION_URL`
environment seam). Adds the README RPC-strategy section (bring-your-own-RPC
guidance, gPA limits, the indexer client as the scale path).
