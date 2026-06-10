/**
 * Shared status badges: moderation attestation + provider-verified.
 *
 * ## Moderation (P6.8 boundary — read before extending)
 *
 * Per PLAN_2 A3, `ListingCard`/`Checkout` surface moderation aggressively, but
 * the UNATTESTED-listing render toggle is gated on the PLAN.md P6.8 [HUMAN]
 * neutrality decision and is NOT built here. This badge therefore only ever
 * SHOWS the attestation STATE (attested / pending / issues); it never gates
 * whether a listing renders. The v1 read model does not project a standalone
 * attestation verdict, so "attested" is inferred from the indexer listing
 * projection's `metadataValid` (the strongest signal available today); a
 * dedicated verdict slots in later without changing this surface.
 *
 * @module components/badges
 */
import type { ReactNode } from "react";
import type { IndexerListing } from "../types.js";
import { tc } from "./format.js";
import { Badge, type ThemableProps } from "./primitives.js";

/** The moderation state a badge can show (never a render gate). */
export type ModerationState = "attested" | "pending" | "issues";

/**
 * Derive a moderation display state from the indexer listing projection.
 *
 * - `null` projection (gPA fallback, no indexer) → `"pending"` (unknown, shown
 *   honestly as pending — never asserted as attested);
 * - `metadataValid === true` → `"attested"`;
 * - `metadataValid === false` (issues present) → `"issues"`.
 */
export function moderationStateOf(
  moderation: IndexerListing | null | undefined,
): ModerationState {
  if (!moderation) return "pending";
  return moderation.metadataValid ? "attested" : "issues";
}

/** Props for {@link ModerationBadge}. */
export interface ModerationBadgeProps extends ThemableProps {
  /** The indexer listing projection (carries `metadataValid`/`metadataIssues`). */
  moderation: IndexerListing | null | undefined;
  /** Pre-resolved state (overrides `moderation`-derived state). */
  state?: ModerationState;
}

const MODERATION_TONE = {
  attested: "success",
  pending: "neutral",
  issues: "warning",
} as const;

const MODERATION_STRING = {
  attested: "components.hire.moderationAttested",
  pending: "components.hire.moderationPending",
  // Distinct from `pending` ("Moderation pending") so a buyer can textually
  // tell "we found problems" apart from "we haven't checked", not just by tone.
  issues: "components.hire.moderationIssues",
} as const;

/**
 * Show the listing's moderation attestation STATE (never a render gate).
 */
export function ModerationBadge({
  moderation,
  state,
  unstyled,
  className,
}: ModerationBadgeProps): ReactNode {
  const resolved = state ?? moderationStateOf(moderation);
  const label = tc(MODERATION_STRING[resolved]);
  const issues =
    resolved === "issues" && moderation?.metadataIssues?.length
      ? moderation.metadataIssues.join("; ")
      : undefined;
  return (
    <Badge
      tone={MODERATION_TONE[resolved]}
      unstyled={unstyled}
      className={className}
      label={issues ?? label}
    >
      {label}
    </Badge>
  );
}

/** Props for {@link VerifiedBadge}. */
export interface VerifiedBadgeProps extends ThemableProps {
  /** Whether the entity is verified. */
  verified: boolean;
}

/**
 * A provider-verified pill (used by ProviderCard). Shows verified/unverified
 * state with the appropriate tone.
 */
export function VerifiedBadge({
  verified,
  unstyled,
  className,
}: VerifiedBadgeProps): ReactNode {
  return (
    <Badge
      tone={verified ? "success" : "neutral"}
      unstyled={unstyled}
      className={className}
    >
      {verified
        ? tc("components.common.verified")
        : tc("components.common.unverified")}
    </Badge>
  );
}
