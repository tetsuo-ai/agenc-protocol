---
"@tetsuo-ai/marketplace-sdk": minor
---

Phase 2 test-mode: the `@tetsuo-ai/marketplace-sdk/testing` subpath
(`startLocalMarketplace()` — full marketplace flows against the real compiled
program in-process via litesvm, program binary shipped in the tarball, moderator
attest helpers, per-actor clients) and the `@tetsuo-ai/marketplace-sdk/sandbox`
subpath (`createSandboxClient()` devnet wiring with airdrop + devnet guard,
seeded-fixture constants, `requestSandboxAttestation`), plus the devnet
deploy runbook, the seeding script, and the nightly sandbox canary workflow.
litesvm becomes an optional peer dependency (required only for `./testing`).
