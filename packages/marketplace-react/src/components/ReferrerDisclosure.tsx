/**
 * `<ReferrerDisclosure>` — the "this site earns a referral fee" notice.
 *
 * ## THE P6.2 GATE (PLAN_2 §0 / the §0 referrer gate — read before editing)
 *
 * Disclosure is the ONE referrer surface allowed to render while the on-chain
 * referrer leg is not live. It NEVER asserts that a fee was charged: when
 * `live` is false it shows the "(pending protocol support)" copy. It is purely
 * informational and reads no earnings. The actual injection / earnings remain
 * blocked on P6.2 (handled by the hooks, not here). This component only
 * DISCLOSES the configured intent.
 *
 * Render it only when a referrer is configured on the provider.
 *
 * @module components/ReferrerDisclosure
 */
import type { ReactNode } from "react";
import type { ValidatedReferrerConfig } from "../types.js";
import { tc } from "./format.js";
import { cx, type ThemableProps } from "./primitives.js";

/** Props for {@link ReferrerDisclosure}. */
export interface ReferrerDisclosureProps extends ThemableProps {
  /** The validated referrer config (from the provider context). */
  referrer: ValidatedReferrerConfig;
  /**
   * Whether the referral fee is actually live on-chain (the P6.2 capability).
   * ALWAYS false today — when false the copy shows the pending-support note and
   * no fee is implied as charged. Defaults to false.
   */
  live?: boolean;
  /** Show the configured fee in bps alongside the disclosure. Default true. */
  showFee?: boolean;
}

/**
 * Disclose that the embedding site earns a referral fee. Honors the P6.2 gate:
 * shows the pending-support copy until referral settlement is live.
 */
export function ReferrerDisclosure({
  referrer,
  live = false,
  showFee = true,
  unstyled,
  className,
}: ReferrerDisclosureProps): ReactNode {
  const text = live
    ? tc("components.referrer.disclosure")
    : tc("components.referrer.disclosurePending");
  return (
    <p
      className={
        unstyled ? className : cx("agenc-referrer-disclosure", className)
      }
      // Informational, not an alert — a polite, non-interrupting note.
      role="note"
    >
      <span>{text}</span>
      {showFee ? (
        <span className={unstyled ? undefined : "agenc-referrer-disclosure__fee"}>
          {" "}
          {tc("components.referrer.feeBps", { bps: String(referrer.feeBps) })}
        </span>
      ) : null}
    </p>
  );
}
