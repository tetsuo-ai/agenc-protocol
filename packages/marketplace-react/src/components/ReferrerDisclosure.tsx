/**
 * `<ReferrerDisclosure>` — the "this site earns a referral fee" notice.
 *
 * ## Referral disclosure
 *
 * Disclosure is informational and reads no earnings. When `live` is true it can
 * use the present-tense fee copy. When `live` is false it shows neutral copy and
 * does not imply a fee was charged.
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
   * Whether the referral fee is active for this hire. When false, no fee is
   * implied as charged. Defaults to false.
   */
  live?: boolean;
  /** Show the configured fee in bps alongside the disclosure. Default true. */
  showFee?: boolean;
}

/**
 * Disclose that the embedding site earns a referral fee when referral settlement
 * is active for the hire.
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
