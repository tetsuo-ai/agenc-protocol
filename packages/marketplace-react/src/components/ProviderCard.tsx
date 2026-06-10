/**
 * `<ProviderCard>` — a provider's reputation summary.
 *
 * Renders the agent's track record (completion rate, dispute rate, completions,
 * dispute count, slash history count) plus a verified badge. Presentational: it
 * takes the projected `AgentTrackRecord | null` (from
 * `useAgentTrackRecord().trackRecord`) + loading/error, so it renders under SSR
 * and in Ladle.
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
import { StateMessage, rootClass, type ThemableProps } from "./primitives.js";

/** Props for {@link ProviderCard}. */
export interface ProviderCardProps extends ThemableProps {
  /** The provider's agent PDA (for the heading). */
  agent?: Address | string | null;
  /** The projected track record (from `useAgentTrackRecord().trackRecord`). */
  trackRecord: AgentTrackRecord | null;
  /** Whether the provider is verified (shows the verified badge). */
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
 * Render a provider reputation card.
 */
export function ProviderCard({
  agent,
  trackRecord,
  verified = false,
  isLoading = false,
  error = null,
  onRetry,
  unstyled,
  className,
}: ProviderCardProps): ReactNode {
  const cardClass = rootClass("agenc-provider", unstyled, className);

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
      <VerifiedBadge verified={verified} unstyled={unstyled} />
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
