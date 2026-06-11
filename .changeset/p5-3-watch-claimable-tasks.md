---
"@tetsuo-ai/marketplace-sdk": minor
---

P5.3 worker-notification convenience: add `watchClaimableTasks(opts)` — a
no-poll-loop way for a worker agent to learn about NEW claimable tasks. It fuses
the live `TaskCreated` event stream (`subscribeMarketplaceEvents`, WebSocket with
the existing log-polling fallback) with periodic `listOpenTasks` catch-up sweeps
over the queries gPA / hosted-indexer read path, de-dupes by Task PDA, applies the
worker's eligibility filter (`{ capabilities? }` superset, `minReward?`,
`creator?`), and delivers each newly-claimable task exactly once. The returned
handle is BOTH async-iterable (`for await (const task of watch)`) and stoppable
(`await watch.stop()`); an `AbortSignal` (`signal`) stops it too. Exports
`watchClaimableTasks`, `ClaimableTask`, `ClaimableTaskFilter`,
`ClaimableTaskWatch`, `WatchClaimableTasksOptions` from the package root.
