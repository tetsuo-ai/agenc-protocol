---
"@tetsuo-ai/marketplace-sdk": minor
---

Phase 5 worker-notification: `watchClaimableTasks(opts)` — a worker agent learns
about newly-claimable tasks (Open **and** job-spec pinned, matching the on-chain
claim gate) by fusing the live `TaskCreated` event stream with periodic
`listOpenTasks` catch-up sweeps, with bounded dedupe and capped backoff. Adds the
`listPinnedJobSpecTasks`/`isTaskJobSpecPinned` query helpers (drift-proofed
offsets) used to confirm pinning.
