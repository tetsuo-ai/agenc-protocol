---
"@tetsuo-ai/marketplace-sdk": minor
---

Phase 7 content rails (SDK): the `taskThread` namespace (hash-anchored buyer↔worker
message envelope whose sha256 matches the on-chain `changes_hash`/`rejection_hash`/
`rationale_hash`, with `postTaskMessage`/`fetchTaskThread`/`resolveChangesRequest`),
the `delivery` namespace (WebCrypto AES-256-GCM + X25519 encrypted deliverables —
the symmetric public manifest is key-free, the raw key is delivered out-of-band to
the accept-gated host), `facade.recordAgentVerification`/`revokeAgentVerification`/
`fetchAgentVerification` over the new on-chain `AgentVerification` PDA, and
`values.validateAgentMetadata`/`renderAgentMetadata` for the agent-metadata v1 schema.
