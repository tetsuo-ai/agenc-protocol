/**
 * `<ProviderCard>` — a provider's reputation + trust summary.
 *
 * Renders the agent's track record (completion rate, dispute rate, completions,
 * dispute count) plus an on-chain VERIFIED badge and the operator domain.
 * Presentational: it takes the projected `AgentTrackRecord | null` (from
 * `useAgentTrackRecord().trackRecord`) and the resolved
 * `AgentVerificationResult` (from `useAgentVerification().verification`) +
 * loading/error, so it renders under SSR and in Ladle.
 *
 * ## P7.3(3) claimed vs verified — the trust distinction
 *
 * The provider may CLAIM an `operatorDomain` in its agent metadata; that is
 * self-reported and unproven. The trust signal is the on-chain
 * `AgentVerification` PDA, written by a trusted attestor only after the operator
 * PROVED domain control. This card NEVER conflates the two:
 * - a live verification (`verification.verified === true`) renders a "Verified:
 *   <domain>" badge using the ON-CHAIN `verification.domain` (a success pill);
 * - otherwise, the merely-CLAIMED `operatorDomain` (when supplied) renders as a
 *   visibly distinct "Claims: <domain>" pill — never styled or labelled as
 *   verified.
 * An unverified claimed domain therefore can never read as verified, even when
 * the claimed string happens to equal a domain someone else verified.
 *
 * ## P6.6 honesty
 *
 * Rates are PROVISIONAL until P6.6 supplies true denominators. When the
 * `partial` flag is set the card marks the rates "(provisional)"; a `null` rate
 * renders as "—" (no denominator), never as a fabricated 0% or 100%.
 *
 * @module components/ProviderCard
 */
import type { ReactNode } from "react";
import type { AgentTrackRecord } from "../hooks/useAgentTrackRecord.js";
import type { Address } from "../types.js";
import { formatRate, tc, truncateAddress } from "./format.js";
import { VerifiedBadge } from "./badges.js";
import { Badge, StateMessage, rootClass, type ThemableProps } from "./primitives.js";
import type { AgentVerificationResult } from "./useAgentVerification.js";
import { UNVERIFIED } from "./useAgentVerification.js";

/** Props for {@link ProviderCard}. */
export interface ProviderCardProps extends ThemableProps {
  /** The provider's agent PDA (for the heading). */
  agent?: Address | string | null;
  /** The projected track record (from `useAgentTrackRecord().trackRecord`). */
  trackRecord: AgentTrackRecord | null;
  /**
   * The resolved ON-CHAIN verification (from
   * `useAgentVerification().verification`). Defaults to the unverified result,
   * so omitting it renders the provider as NOT verified — verified state is
   * opt-in and only ever driven by a live attestation.
   */
  verification?: AgentVerificationResult;
  /**
   * The provider's CLAIMED operator domain (from agent metadata). Self-reported
   * and UNPROVEN — shown as a clearly-distinct "claimed" pill, and only when no
   * on-chain verification supersedes it. Never rendered as verified.
   */
  operatorDomain?: string | null;
  /**
   * Deprecated boolean verified flag (pre-P7.3). When `verification` is omitted,
   * a `true` here still shows the legacy verified badge, but WITHOUT a domain
   * (no on-chain domain is available from a bare boolean). Prefer `verification`.
   */
  verified?: boolean;
  /** True while loading the track record. */
  isLoading?: boolean;
  /**
   * A read error. Under the gPA fallback the track record is unsupported; the
   * card shows the "unavailable on this transport" copy for that case.
   */
  error?: Error | null;
  /** Retry handler for the error state. */
  onRetry?: () => void;
}

/**
 * The on-chain verified-domain pill: a success-tone badge carrying the PROVEN
 * domain. Distinct copy + an accessible label that names it as on-chain
 * verified.
 */
function VerifiedDomainBadge({
  domain,
  unstyled,
}: {
  domain: string;
  unstyled?: boolean;
}): ReactNode {
  return (
    <Badge
      tone="success"
      unstyled={unstyled}
      className={unstyled ? undefined : "agenc-provider__domain agenc-provider__domain--verified"}
      label={tc("components.provider.verifiedDomainLabel", { domain })}
    >
      {tc("components.provider.verifiedDomain", { domain })}
    </Badge>
  );
}

/**
 * The CLAIMED-domain pill: a neutral-tone badge whose copy ("Claims: …") and
 * accessible label both mark it as unverified, so it can never be mistaken for
 * the on-chain verified badge.
 */
function ClaimedDomainBadge({
  domain,
  unstyled,
}: {
  domain: string;
  unstyled?: boolean;
}): ReactNode {
  return (
    <Badge
      tone="neutral"
      unstyled={unstyled}
      className={unstyled ? undefined : "agenc-provider__domain agenc-provider__domain--claimed"}
      label={tc("components.provider.claimedDomainLabel", { domain })}
    >
      {tc("components.provider.claimedDomain", { domain })}
    </Badge>
  );
}

/**
 * Render a provider reputation + trust card.
 */
export function ProviderCard({
  agent,
  trackRecord,
  verification = UNVERIFIED,
  operatorDomain,
  verified = false,
  isLoading = false,
  error = null,
  onRetry,
  unstyled,
  className,
}: ProviderCardProps): ReactNode {
  const cardClass = rootClass("agenc-provider", unstyled, className);

  // Verified state is on-chain-driven. The legacy `verified` boolean is honored
  // ONLY as a fallback when no `verification` is supplied (it carries no domain).
  const isVerified = verification.verified || (verification === UNVERIFIED && verified);
  const verifiedDomain = verification.verified ? verification.domain : null;
  const claimed =
    typeof operatorDomain === "string" && operatorDomain.trim() !== ""
      ? operatorDomain.trim()
      : null;

  // The on-chain verified domain supersedes any claim; the claimed pill only
  // shows when there is NO live verified domain to display.
  const domainBadge = verifiedDomain ? (
    <VerifiedDomainBadge domain={verifiedDomain} unstyled={unstyled} />
  ) : claimed ? (
    <ClaimedDomainBadge domain={claimed} unstyled={unstyled} />
  ) : null;

  const header = (
    <header className={unstyled ? undefined : "agenc-provider__header"}>
      <div className={unstyled ? undefined : "agenc-provider__id"}>
        <span className={unstyled ? undefined : "agenc-provider__label"}>
          {tc("components.provider.title")}
        </span>
        {agent ? (
          <span className={unstyled ? undefined : "agenc-provider__pda"}>
            {truncateAddress(agent)}
          </span>
        ) : null}
      </div>
      <div className={unstyled ? undefined : "agenc-provider__badges"}>
        {domainBadge}
        <VerifiedBadge verified={isVerified} unstyled={unstyled} />
      </div>
    </header>
  );

  if (error) {
    return (
      <section className={cardClass} aria-label={tc("components.provider.title")}>
        {header}
        <StateMessage
          kind="error"
          message={tc("components.provider.unavailable")}
          onRetry={onRetry}
          unstyled={unstyled}
        />
      </section>
    );
  }

  if (isLoading && trackRecord === null) {
    return (
      <section className={cardClass} aria-label={tc("components.provider.title")}>
        {header}
        <StateMessage kind="loading" unstyled={unstyled} />
      </section>
    );
  }

  if (trackRecord === null) {
    return (
      <section className={cardClass} aria-label={tc("components.provider.title")}>
        {header}
        <StateMessage
          kind="empty"
          message={tc("components.provider.noData")}
          unstyled={unstyled}
        />
      </section>
    );
  }

  const provisional = trackRecord.partial;

  return (
    <section className={cardClass} aria-label={tc("components.provider.title")}>
      {header}
      <dl className={unstyled ? undefined : "agenc-provider__stats"}>
        <div className={unstyled ? undefined : "agenc-provider__stat"}>
          <dt>{tc("components.provider.completionRate")}</dt>
          <dd>
            {formatRate(trackRecord.completionRate)}
            {provisional ? (
              <span className={unstyled ? undefined : "agenc-provider__provisional"}>
                {" "}
                ({tc("components.provider.provisional")})
              </span>
            ) : null}
          </dd>
        </div>
        <div className={unstyled ? undefined : "agenc-provider__stat"}>
          <dt>{tc("components.provider.disputeRate")}</dt>
          <dd>
            {formatRate(trackRecord.disputeRate)}
            {provisional ? (
              <span className={unstyled ? undefined : "agenc-provider__provisional"}>
                {" "}
                ({tc("components.provider.provisional")})
              </span>
            ) : null}
          </dd>
        </div>
        <div className={unstyled ? undefined : "agenc-provider__stat"}>
          <dt>{tc("components.provider.completions", {
            count: String(trackRecord.completions),
          })}</dt>
          <dd>
            {tc("components.provider.disputes", {
              count: String(trackRecord.disputesLost),
            })}
          </dd>
        </div>
      </dl>
    </section>
  );
}
