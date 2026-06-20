/**
 * Component-layer string catalog (PLAN_2 A3).
 *
 * Every user-facing literal a prebuilt component renders routes through the
 * shared {@link t} resolver and is keyed HERE, namespaced under
 * `components.*` so it never collides with the foundation catalog
 * (`provider.*`, `referrer.*`, `transport.*`, `state.*`, `hire.*`). A future
 * locale extends this object — no component code changes.
 *
 * These are MERGED over `EN_STRINGS` at module load (see `mergedCatalog`) so a
 * component calling `t("components.listingCard.priceLabel")` resolves without
 * the caller threading a catalog. SSR-safe: a plain object literal, no globals.
 *
 * @module components/strings
 */
import { EN_STRINGS, type StringCatalog } from "../strings/index.js";

/**
 * The component-surface English strings. Keys are namespaced by component
 * (`components.<component>.<key>`) plus a few shared `components.common.*`.
 */
export const EN_COMPONENT_STRINGS = {
  // Shared / cross-component.
  "components.common.loading": "Loading…",
  "components.common.empty": "Nothing to show yet.",
  "components.common.error": "Something went wrong.",
  "components.common.retry": "Retry",
  "components.common.close": "Close",
  "components.common.verified": "Verified",
  "components.common.unverified": "Unverified",
  "components.common.sol": "SOL",
  "components.common.lamports": "lamports",

  // ListingCard.
  "components.listingCard.priceLabel": "Price",
  "components.listingCard.byProvider": "by {provider}",
  "components.listingCard.untitled": "Untitled service",
  "components.listingCard.hires": "{count} hires",
  "components.listingCard.category": "Category",

  // ListingGrid.
  "components.listingGrid.empty": "No listings match your filters yet.",
  "components.listingGrid.loadMore": "Load more",
  "components.listingGrid.error": "Could not load listings.",

  // HireButton / Checkout.
  "components.hire.cta": "Hire",
  "components.hire.ctaPrice": "Hire — {price}",
  "components.hire.checkoutTitle": "Confirm hire",
  "components.hire.priceLabel": "You pay",
  "components.hire.escrowNote":
    "Funds are held in protocol escrow and released to the provider only when you accept the result.",
  "components.hire.confirm": "Confirm and fund escrow",
  "components.hire.cancel": "Cancel",
  "components.hire.pending": "Confirming…",
  "components.hire.success": "Escrow funded.",
  "components.hire.successDetail": "Your task is created. Track it below.",
  "components.hire.viewTask": "View task",
  "components.hire.errorTitle": "Hire failed",
  "components.hire.moderationAttested": "Moderation attested",
  "components.hire.moderationPending": "Moderation pending",
  "components.hire.moderationIssues": "Moderation issues found",
  "components.hire.notConnected": "Connect a wallet to hire.",

  // Referrer disclosure.
  "components.referrer.disclosure": "This site earns a referral fee.",
  "components.referrer.disclosurePending":
    "Referral fee is not active for this hire.",
  "components.referrer.feeBps": "{bps} bps",

  // TaskTimeline.
  "components.taskTimeline.title": "Task progress",
  "components.taskTimeline.empty": "No task to track yet.",
  "components.taskTimeline.status.Open": "Open",
  "components.taskTimeline.status.InProgress": "In progress",
  "components.taskTimeline.status.PendingValidation": "Pending review",
  "components.taskTimeline.status.Completed": "Completed",
  "components.taskTimeline.status.Cancelled": "Cancelled",
  "components.taskTimeline.status.Disputed": "Disputed",
  "components.taskTimeline.status.RejectFrozen": "Rejected (frozen)",

  // ReviewPanel.
  "components.review.title": "Review submission",
  "components.review.noSubmission": "Awaiting the worker's submission.",
  "components.review.accept": "Accept and release escrow",
  "components.review.reject": "Reject",
  "components.review.requestChanges": "Request changes",
  "components.review.accepted": "Result accepted. Escrow released.",
  "components.review.rejected": "Result rejected.",
  "components.review.changesRequested": "Changes requested.",
  "components.review.pending": "Submitting…",
  "components.review.errorTitle": "Review action failed",

  // DisputeBanner.
  "components.dispute.title": "This task is in dispute.",
  "components.dispute.body":
    "A dispute has been opened. A protocol resolver decides the outcome; funds stay in escrow until then.",
  "components.dispute.initiate": "Open a dispute",
  "components.dispute.pending": "Opening dispute…",
  "components.dispute.opened": "Dispute opened.",
  "components.dispute.none": "No open dispute.",
  "components.dispute.errorTitle": "Could not open dispute",

  // ProviderCard.
  "components.provider.title": "Provider",
  "components.provider.completionRate": "Completion rate",
  "components.provider.disputeRate": "Dispute rate",
  "components.provider.completions": "{count} completed",
  "components.provider.disputes": "{count} disputes",
  "components.provider.provisional": "provisional",
  "components.provider.noData": "No track record yet.",
  "components.provider.unavailable":
    "Track record is unavailable on this read transport.",
  // Domain trust (P7.3) — VERIFIED is an on-chain attestation; CLAIMED is the
  // operator's self-reported metadata. The copy keeps them distinct so a buyer
  // never reads an unverified claim as a proven one.
  "components.provider.verifiedDomain": "Verified: {domain}",
  "components.provider.verifiedDomainLabel": "Verified domain {domain}",
  "components.provider.claimedDomain": "Claims: {domain}",
  "components.provider.claimedDomainLabel":
    "Claimed domain {domain} (not verified on-chain)",

  // PoweredByAgenC.
  "components.poweredBy.label": "Powered by AgenC",
  "components.poweredBy.trustLink": "Learn how this works",
} as const satisfies StringCatalog;

/** A component-surface message id. */
export type ComponentStringId = keyof typeof EN_COMPONENT_STRINGS;

/**
 * The default catalog every component resolves against: the foundation
 * `EN_STRINGS` merged with {@link EN_COMPONENT_STRINGS}. A host-supplied catalog
 * (`t(id, vars, { catalog })`) still wins per-call.
 */
export const COMPONENT_CATALOG: StringCatalog = {
  ...EN_STRINGS,
  ...EN_COMPONENT_STRINGS,
};
