// LISTING_METADATA v1 canonical category taxonomy (P1.5). The on-chain
// `ServiceListing.category` field carries exactly one of these tokens, encoded
// with `encodeListingCategory` (UTF-8, NUL-padded to 32 bytes). The standard
// itself — encoding rules, taxonomy definitions, and the spec_uri JSON Schema —
// lives in docs/LISTING_METADATA.md; this module is the machine-readable list.
// Browser-safe: pure data, no Node built-ins.

/**
 * The 20 canonical LISTING_METADATA v1 listing categories, in specification
 * order. Every token is lowercase-kebab and at most 32 UTF-8 bytes, so each
 * is always encodable with `encodeListingCategory`. Listings whose on-chain
 * `category` is not one of these values (or all-NUL/unset) are nonconforming
 * under the v1 standard; use `"other"` when nothing else fits.
 *
 * See `docs/LISTING_METADATA.md` for the one-line definition of each category.
 */
export const LISTING_CATEGORIES = [
  "code-generation",
  "translation",
  "data-labeling",
  "research",
  "image-gen",
  "audio",
  "video",
  "marketing",
  "data-analysis",
  "scraping",
  "devops",
  "security",
  "legal",
  "finance",
  "design",
  "writing",
  "support",
  "search",
  "automation",
  "other",
] as const;

/**
 * A canonical LISTING_METADATA v1 category token — exactly one of the 20
 * entries in {@link LISTING_CATEGORIES} (e.g. `"code-generation"`,
 * `"translation"`, `"other"`).
 */
export type ListingCategory = (typeof LISTING_CATEGORIES)[number];

/**
 * Type guard: is `value` one of the 20 canonical LISTING_METADATA v1
 * categories?
 *
 * Matching is exact — the canonical tokens are lowercase-kebab, so
 * `"Translation"` or `" translation "` do not pass; normalize input before
 * checking if you accept free-form text.
 *
 * @param value - Any value (string or otherwise) to test.
 * @returns `true` when `value` is a {@link ListingCategory}, narrowing its
 *   type accordingly; `false` for non-strings and non-canonical strings.
 *
 * @example
 * ```ts
 * if (isListingCategory(userInput)) {
 *   const bytes = encodeListingCategory(userInput); // userInput: ListingCategory
 * }
 * ```
 */
export function isListingCategory(value: unknown): value is ListingCategory {
  return (
    typeof value === "string" &&
    (LISTING_CATEGORIES as readonly string[]).includes(value)
  );
}
