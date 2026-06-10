---
"@tetsuo-ai/marketplace-sdk": minor
---

Phase 1 SDK runtime core: `createMarketplaceClient` transaction runtime (transport
seam, compute-budget defaults, blockhash-expiry retry, typed `AgencError`), typed
`queries` getProgramAccounts read path with drift-proofed offsets, event codecs for
all 82 program events plus log parsing/subscriptions/`waitForTaskStatus`, the
`values` module (ids, sha256/descriptionHash, listing-metadata codecs, clean-room
canonical job-spec hash with kit cross-implementation vectors), and the
LISTING_METADATA v1 standard (string inputs on `createServiceListing`, published
JSON Schema).
