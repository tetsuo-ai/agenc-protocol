/**
 * Referrer config validation + the P6.2 capability gate.
 *
 * ## THE P6.2 GATE (PLAN_2 §0, MANDATORY)
 *
 * Referrer args + the 4th settlement leg are an UNBUILT Phase-6 on-chain change
 * (PLAN.md P6.2). The SDK `facade.hireFromListing` has NO referrer params yet.
 * So this module:
 * - ACCEPTS + VALIDATES `referrer: { wallet, feeBps }` and stores the normalized
 *   form (validation is real: bad base58 throws, out-of-range bps rejected);
 * - exposes {@link resolveReferrerCapability}, which currently returns
 *   `{ live: false, reason: "P6.2 not deployed" }` — HARDCODED false today, with
 *   a clear TODO citing P6.2 / P6.5 `getDeployedSurface` as the future signal.
 *
 * When NOT live (today, always): referrer is NEVER injected into a hire, the
 * earnings hook returns a documented not-live state, and disclosure UI may still
 * SHOW "this site earns a referral fee (pending protocol support)". We NEVER
 * fake earnings or silently inject.
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
 * Maximum referral fee, in basis points. 10000 bps = 100%. The on-chain P6.2
 * leg will enforce its own cap; this client-side bound is a sane outer guard so
 * an obviously-wrong config (e.g. a typo'd 99999) is rejected at provider
 * construction rather than silently stored.
 */
export const REFERRER_FEE_BPS_MAX = 10_000;

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
 * Resolve whether a referral fee can actually be charged on the target cluster.
 *
 * THE P6.2 GATE — returns `live: false` UNCONDITIONALLY today.
 *
 * TODO(P6.2 / P6.5): once the on-chain referrer args + 4th settlement leg
 * (PLAN.md P6.2) are deployed, replace the hardcoded `false` with a real check
 * against P6.5 `getDeployedSurface` for the target cluster. Until then, returning
 * a truthy `live` here would cause silent fee injection against a program that
 * cannot honor it — strictly forbidden by PLAN_2 §0.
 *
 * @param referrer - The validated referrer config under the provider, or null.
 * @returns A {@link ReferrerCapability} (always `{ live: false, ... }` today).
 */
export function resolveReferrerCapability(
  referrer: ValidatedReferrerConfig | null,
): ReferrerCapability {
  // P6.2 GATE: hardcoded not-live. Do NOT make this conditionally true until
  // P6.2 is deployed AND P6.5 getDeployedSurface confirms it on the cluster.
  return {
    live: false,
    reason: t("referrer.notLiveReason"),
    ...(referrer ? { referrer } : {}),
  };
}
