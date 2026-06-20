/**
 * Referrer config validation + the live referral-settlement capability.
 *
 * ## REFERRER SETTLEMENT
 *
 * Referrer args + the 4th settlement leg are part of the full 84-instruction
 * surface. The SDK `facade.hireFromListing` and
 * `facade.hireFromListingHumanless` both accept referrer fields. This module:
 * - ACCEPTS + VALIDATES `referrer: { wallet, feeBps }` and stores the normalized
 *   form (validation is real: bad base58 throws, out-of-range bps rejected);
 * - exposes {@link resolveReferrerCapability}, which reports live when a valid
 *   referrer config is present.
 *
 * Aggregated earnings are separate from settlement. `useReferrerEarnings` still
 * remains indexer-gated and must not fabricate totals before that endpoint is
 * published.
 *
 * @module provider/referrer
 */
import { isAddress } from "@solana/kit";
import { t } from "../strings/index.js";
import type {
  Address,
  ReferrerCapability,
  ReferrerConfig,
  ValidatedReferrerConfig,
} from "../types.js";

/** Minimum referral fee, in basis points. */
export const REFERRER_FEE_BPS_MIN = 0;
/**
 * Maximum referral fee, in basis points. Mirrors the on-chain per-leg cap
 * (`MAX_REFERRER_FEE_BPS = 2000`) so invalid provider config fails before the
 * user signs a transaction.
 */
export const REFERRER_FEE_BPS_MAX = 2_000;

/**
 * Validate + normalize a raw {@link ReferrerConfig} into a
 * {@link ValidatedReferrerConfig}.
 *
 * @throws TypeError when `wallet` is not a valid base58 Solana address.
 * @throws RangeError when `feeBps` is not an integer in
 *   `[REFERRER_FEE_BPS_MIN, REFERRER_FEE_BPS_MAX]`.
 */
export function validateReferrerConfig(
  config: ReferrerConfig,
): ValidatedReferrerConfig {
  const { wallet, feeBps } = config;
  if (typeof wallet !== "string" || !isAddress(wallet)) {
    throw new TypeError(t("referrer.invalidWallet", { wallet: String(wallet) }));
  }
  if (
    typeof feeBps !== "number" ||
    !Number.isInteger(feeBps) ||
    feeBps < REFERRER_FEE_BPS_MIN ||
    feeBps > REFERRER_FEE_BPS_MAX
  ) {
    throw new RangeError(
      t("referrer.invalidFeeBps", {
        min: REFERRER_FEE_BPS_MIN,
        max: REFERRER_FEE_BPS_MAX,
        feeBps: String(feeBps),
      }),
    );
  }
  return { wallet: wallet as Address, feeBps };
}

/**
 * Resolve whether a referral fee can actually be charged by this provider.
 *
 * @param referrer - The validated referrer config under the provider, or null.
 * @returns A {@link ReferrerCapability}; live only when a referrer is configured.
 */
export function resolveReferrerCapability(
  referrer: ValidatedReferrerConfig | null,
): ReferrerCapability {
  if (!referrer) {
    return {
      live: false,
      reason: t("referrer.notLiveReason"),
    };
  }
  return {
    live: true,
    referrer,
  };
}
