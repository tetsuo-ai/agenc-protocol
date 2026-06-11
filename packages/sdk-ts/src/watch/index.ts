/**
 * Watch layer — worker-notification convenience.
 *
 * {@link watchClaimableTasks} lets a worker agent learn about NEW claimable
 * tasks without writing a bespoke poll loop: it fuses the live
 * `TaskCreated` event stream (`subscribeMarketplaceEvents`) with periodic
 * `listOpenTasks` catch-up sweeps (the queries gPA / indexer read path),
 * de-dupes by Task PDA, applies the worker's eligibility filter (capability
 * superset, minReward, creator), and delivers each newly-claimable task once.
 * The returned handle is both async-iterable and stoppable.
 *
 * Browser-safety is NOT required here — worker bots are node — but this module
 * uses no node built-ins (only `@solana/kit` + the SDK's own events/queries
 * layers), so it stays bundler-portable anyway.
 *
 * @module watch
 */
export {
  watchClaimableTasks,
  type ClaimableTask,
  type ClaimableTaskFilter,
  type ClaimableTaskWatch,
  type WatchClaimableTasksOptions,
} from "./watch.js";
