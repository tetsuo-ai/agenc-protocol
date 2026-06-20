/**
 * Headless hooks for `@tetsuo-ai/marketplace-react` (PLAN_2 Part A2).
 *
 * Every hook binds to the foundation context (`useAgencContext`) + TanStack
 * Query (bundled), surfaces typed `AgencError`s from the runtime client
 * UNTOUCHED, and is SSR-safe (no `window`/`document` at module scope).
 *
 * Referrer-related surfaces are split deliberately: `useHire` injects a
 * configured referrer into live settlement, while `useReferrerEarnings` remains
 * indexer-gated so no earnings are ever fabricated.
 *
 * @module hooks
 */

// Reads
export {
  useListings,
  type ListingRow,
  type UseListingsFilter,
  type UseListingsOptions,
  type UseListingsResult,
} from "./useListings.js";
export {
  useListing,
  type ListingDetail,
  type UseListingOptions,
  type UseListingResult,
} from "./useListing.js";
export {
  useAgentTrackRecord,
  projectTrackRecord,
  type AgentTrackRecord,
  type TrackRecordOutcome,
  type UseAgentTrackRecordOptions,
  type UseAgentTrackRecordResult,
} from "./useAgentTrackRecord.js";
export {
  useTaskStatus,
  type ObservedEvent,
  type TaskEventsSource,
  type TaskReader,
  type UseTaskStatusOptions,
  type UseTaskStatusResult,
} from "./useTaskStatus.js";

// Writes
export {
  useHire,
  type AnyHireInput,
  type HireInput,
  type HireResult,
  type HireStatus,
  type HumanlessHireInput,
  type UseHireResult,
} from "./useHire.js";
export {
  useSubmissionReview,
  type AcceptInput,
  type RejectInput,
  type RequestChangesInput,
  type ReviewAction,
  type ReviewStatus,
  type UseSubmissionReviewResult,
} from "./useSubmissionReview.js";
export {
  useDispute,
  type DisputeReader,
  type DisputeStatus,
  type InitiateDisputeInput,
  type UseDisputeOptions,
  type UseDisputeResult,
} from "./useDispute.js";

// Wallet bridge
export {
  useWalletSigner,
  type UseWalletSignerOptions,
  type UseWalletSignerResult,
  type WalletSignerAdapter,
} from "./useWalletSigner.js";

// Referrer earnings (indexer-gated)
export {
  useReferrerEarnings,
  type ReferrerHire,
  type UseReferrerEarningsResult,
} from "./useReferrerEarnings.js";

// Shared query-key factory (consumers can invalidate sub-trees).
export { queryKeys, QUERY_KEY_ROOT } from "./internal.js";
