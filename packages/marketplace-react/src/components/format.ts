/**
 * Pure presentation helpers for the prebuilt components.
 *
 * Everything here is a deterministic, SSR-safe pure function — no React, no
 * `window`/`document`, no `Intl` at module scope. They turn the SDK's raw
 * on-chain shapes (NUL-padded byte fields, lamport `bigint`s, base58
 * `Address`es) into display strings, and centralize the component string
 * resolver so callers don't thread the component catalog by hand.
 *
 * @module components/format
 */
import { values } from "@tetsuo-ai/marketplace-sdk";
import type { ServiceListing } from "../types.js";
import { t, type StringVars, type TranslateOptions } from "../strings/index.js";
import { COMPONENT_CATALOG, type ComponentStringId } from "./strings.js";

/**
 * Resolve a component string id against the merged component catalog by
 * default. A per-call `options.catalog` (e.g. a future locale) still wins.
 *
 * This is the only resolver components call so every literal is overridable in
 * one place.
 */
export function tc(
  id: ComponentStringId | (string & {}),
  vars?: StringVars,
  options?: TranslateOptions,
): string {
  return t(id, vars, { catalog: COMPONENT_CATALOG, ...options });
}

/** Lamports per SOL. */
const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Format a lamports `bigint` as a human SOL string with up to 9 decimal places,
 * trailing zeros trimmed. Pure bigint math — no float rounding, no `Intl`.
 *
 * @example formatSol(1_500_000_000n) // "1.5"
 * @example formatSol(1_000_000n)     // "0.001"
 * @example formatSol(0n)             // "0"
 */
export function formatSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = abs % LAMPORTS_PER_SOL;
  let out: string;
  if (frac === 0n) {
    out = whole.toString();
  } else {
    // Zero-pad the fractional part to 9 digits, then trim trailing zeros.
    const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
    out = `${whole.toString()}.${fracStr}`;
  }
  return negative ? `-${out}` : out;
}

/**
 * A price label like `"1.5 SOL"` (SOL leg) — the only denomination the v1
 * components render (SPL-priced listings surface the raw lamport-equivalent
 * with the configured unit label by the caller; v1 assumes SOL).
 */
export function formatPriceSol(
  lamports: bigint,
  options?: TranslateOptions,
): string {
  return `${formatSol(lamports)} ${t("components.common.sol", undefined, {
    catalog: COMPONENT_CATALOG,
    ...options,
  })}`;
}

/**
 * Truncate a base58 address/string to `head…tail` for compact display.
 *
 * @example truncateAddress("So11111111111111111111111111111111111111112")
 *   // "So1111…1112"
 */
export function truncateAddress(
  value: string | { toString(): string } | null | undefined,
  head = 4,
  tail = 4,
): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/**
 * Decode a listing's NUL-padded `name` byte field to a display string using the
 * SDK's canonical decoder, falling back to an empty string on any decode error
 * (a malformed on-chain name must never crash a card).
 */
export function decodeListingName(listing: Pick<ServiceListing, "name">): string {
  try {
    return values.decodeListingName(Uint8Array.from(listing.name));
  } catch {
    return "";
  }
}

/**
 * Decode a listing's `category` byte field, tolerant of malformed bytes.
 */
export function decodeListingCategory(
  listing: Pick<ServiceListing, "category">,
): string {
  try {
    return values.decodeListingCategory(Uint8Array.from(listing.category));
  } catch {
    return "";
  }
}

/**
 * Decode a listing's `tags` byte field to a string array, tolerant of malformed
 * bytes (returns `[]` on error).
 */
export function decodeListingTags(
  listing: Pick<ServiceListing, "tags">,
): string[] {
  try {
    return values.decodeListingTags(Uint8Array.from(listing.tags));
  } catch {
    return [];
  }
}

/**
 * Lowercase-hex a byte field (e.g. a spec hash) for display / comparison.
 */
export function toHex(bytes: ArrayLike<number>): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Format a `[0,1]` rate as an integer percentage string, or a fallback when the
 * rate is `null` (no denominator — the P6.6 provisional state).
 */
export function formatRate(rate: number | null, fallback = "—"): string {
  if (rate === null || Number.isNaN(rate)) return fallback;
  const pct = Math.round(rate * 100);
  return `${pct}%`;
}
