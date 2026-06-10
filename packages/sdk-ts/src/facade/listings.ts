// Facade: ergonomic, named entry points over the generated client. Thin by design —
// the generated client already resolves PDAs and encodes data; the facade adds friendly
// signatures, defaults, and (for multi-PDA flows) bundling. Never import from generated/
// internals other than its public exports.
//
// Domain: service-listing lifecycle (create / update / set-state) + direct hire.
// hire_from_listing is the core embeddable entry point: a buyer hires a provider's
// standing listing, which mints the task + escrow in one instruction.
import {
  getCreateServiceListingInstructionAsync,
  getUpdateServiceListingInstructionAsync,
  getSetServiceListingStateInstructionAsync,
  getHireFromListingInstructionAsync,
  getHireFromListingHumanlessInstructionAsync,
  findListingPda,
  findListingModerationPda,
  type CreateServiceListingAsyncInput,
  type UpdateServiceListingAsyncInput,
  type SetServiceListingStateAsyncInput,
  type HireFromListingAsyncInput,
  type HireFromListingHumanlessAsyncInput,
} from "../generated/index.js";
import {
  LISTING_CATEGORIES,
  isListingCategory,
  encodeListingName,
  encodeListingCategory,
  encodeListingTags,
  type ListingCategory,
} from "../values/index.js";

export { findListingPda, findListingModerationPda };

/**
 * Friendly input for {@link createServiceListing}. Identical to the generated
 * `CreateServiceListingAsyncInput`, except the three fixed-width metadata
 * fields each accept EITHER the raw on-chain byte form (passed through
 * byte-for-byte, for power users) OR the LISTING_METADATA v1 string form,
 * which the facade validates and encodes via the `values` module
 * (see docs/LISTING_METADATA.md).
 */
export type CreateServiceListingInput = Omit<
  CreateServiceListingAsyncInput,
  "name" | "category" | "tags"
> & {
  /** Display name: raw 32-byte field, or a string of at most 32 UTF-8 bytes. */
  name: CreateServiceListingAsyncInput["name"] | string;
  /** Category: raw 32-byte field, or a canonical {@link ListingCategory} token. */
  category: CreateServiceListingAsyncInput["category"] | ListingCategory;
  /** Tags: raw 64-byte field, or lowercase-kebab tokens (comma-joined ≤ 64 UTF-8 bytes). */
  tags: CreateServiceListingAsyncInput["tags"] | readonly string[];
};

/** Runtime split between the raw-bytes and string-array forms of `tags`. */
function isTagStrings(
  tags: CreateServiceListingInput["tags"],
): tags is readonly string[] {
  return Array.isArray(tags);
}

/**
 * Build a create_service_listing instruction. The listing PDA (derived from
 * providerAgent + listingId), protocolConfig, and systemProgram are all
 * auto-derived by the async builder, so callers only supply identity + terms.
 *
 * `name`, `category`, and `tags` accept either form, independently per field:
 *
 * - **Strings** (LISTING_METADATA v1): `name` is any UTF-8 text up to 32
 *   bytes; `category` must be one of the 20 canonical
 *   {@link LISTING_CATEGORIES}; `tags` is an array of lowercase-kebab tokens
 *   whose comma-joined encoding fits 64 bytes. The facade validates and
 *   encodes them with the `values` module codecs (`encodeListingName`,
 *   `encodeListingCategory`, `encodeListingTags`).
 * - **Raw fixed-width bytes** (power users): exactly the generated builder's
 *   `Uint8Array` form, forwarded byte-for-byte with no validation.
 *
 * @param input - {@link CreateServiceListingInput}: identity (providerAgent,
 *   authority), listingId, metadata (name/category/tags in either form),
 *   spec commitment (specHash, specUri), and terms (price, priceMint,
 *   requiredCapabilities, defaultDeadlineSecs, maxOpenJobs, operator,
 *   operatorFeeBps).
 * @returns The assembled `create_service_listing` instruction.
 * @throws TypeError when a string `category` is not a canonical
 *   {@link ListingCategory}, a tag is not lowercase-kebab, or a string field
 *   contains an embedded NUL.
 * @throws RangeError when a string field's UTF-8 encoding overflows its
 *   fixed on-chain width (name/category 32 bytes, joined tags 64 bytes).
 *
 * @example
 * ```ts
 * const ix = await facade.createServiceListing({
 *   providerAgent,
 *   authority,
 *   listingId,
 *   name: "Translation Pro",
 *   category: "translation",
 *   tags: ["english-to-french", "docs"],
 *   specHash,
 *   specUri: "agenc://job-spec/sha256/...",
 *   price: 1_000_000n,
 *   priceMint: null,
 *   requiredCapabilities: 1n,
 *   defaultDeadlineSecs: 3600n,
 *   maxOpenJobs: 0,
 *   operator: null,
 *   operatorFeeBps: 0,
 * });
 * ```
 */
export async function createServiceListing(input: CreateServiceListingInput) {
  const { name, category, tags, ...rest } = input;
  if (typeof category === "string" && !isListingCategory(category)) {
    throw new TypeError(
      `listing category: ${JSON.stringify(category)} is not a canonical ` +
        `LISTING_METADATA v1 category (expected one of: ${LISTING_CATEGORIES.join(", ")})`,
    );
  }
  return getCreateServiceListingInstructionAsync({
    ...rest,
    name: typeof name === "string" ? encodeListingName(name) : name,
    category:
      typeof category === "string" ? encodeListingCategory(category) : category,
    tags: isTagStrings(tags) ? encodeListingTags(tags) : tags,
  });
}

/**
 * Build an update_service_listing instruction. Every data field is an Option —
 * pass `null` to leave a field unchanged and a value to overwrite it. The
 * protocolConfig is auto-derived.
 */
export async function updateServiceListing(input: UpdateServiceListingAsyncInput) {
  return getUpdateServiceListingInstructionAsync(input);
}

/** Listing lifecycle states (matches the on-chain `newState` u8 enum). */
export const ListingState = {
  Active: 0,
  Paused: 1,
  Closed: 2,
} as const;
export type ListingStateName = keyof typeof ListingState;

/**
 * Build a set_service_listing_state instruction (activate / pause / close).
 * Accepts either the raw u8 `newState` or a friendly `state` name; protocolConfig
 * is auto-derived.
 */
export async function setServiceListingState(
  input: Omit<SetServiceListingStateAsyncInput, "newState"> &
    ({ newState: number } | { state: ListingStateName }),
) {
  const newState =
    "state" in input ? ListingState[input.state] : input.newState;
  const { state: _state, ...rest } = input as { state?: ListingStateName } & Omit<
    SetServiceListingStateAsyncInput,
    "newState"
  >;
  return getSetServiceListingStateInstructionAsync({ ...rest, newState });
}

/**
 * Friendly input for {@link hireFromListing}. Mirrors the generated async input,
 * but lets the caller pass `listingSpecHash` so the facade can derive the
 * listing-moderation attestation PDA (bound to the listing's pinned spec hash)
 * instead of requiring the caller to compute it.
 */
export type HireFromListingInput = HireFromListingAsyncInput & {
  /**
   * The listing's pinned `spec_hash` (32 bytes). When provided and
   * `listingModeration` is not, the facade derives `listingModeration` from
   * (listing, specHash) so the fail-closed moderation gate resolves. Omit when
   * the moderation gate is disabled, or pass `listingModeration` explicitly.
   */
  listingSpecHash?: HireFromListingAsyncInput["taskId"];
};

/**
 * Build a hire_from_listing instruction — the core embeddable entry point.
 *
 * The async builder auto-derives task, escrow, hireRecord, protocolConfig,
 * moderationConfig, authorityRateLimit, and systemProgram. The caller must
 * supply `listing` and `creatorAgent` (not derivable). `listingModeration` is
 * optional on-chain (required only when the moderation gate is enabled); if the
 * caller passes `listingSpecHash` (and not an explicit `listingModeration`),
 * the facade derives it from (listing, specHash).
 */
export async function hireFromListing(input: HireFromListingInput) {
  const { listingSpecHash, ...rest } = input;
  if (rest.listingModeration === undefined && listingSpecHash !== undefined) {
    const [listingModeration] = await findListingModerationPda({
      listing: rest.listing,
      jobSpecHash: listingSpecHash,
    });
    return getHireFromListingInstructionAsync({ ...rest, listingModeration });
  }
  return getHireFromListingInstructionAsync(rest);
}

/**
 * Friendly input for {@link hireFromListingHumanless}. Mirrors the generated
 * async input but lets the caller pass `listingSpecHash` so the facade derives
 * the listing-moderation attestation PDA (bound to the listing's pinned spec
 * hash) instead of requiring the caller to compute it.
 */
export type HireFromListingHumanlessInput =
  HireFromListingHumanlessAsyncInput & {
    /**
     * The listing's pinned `spec_hash` (32 bytes). When provided and
     * `listingModeration` is not, the facade derives `listingModeration` from
     * (listing, specHash) so the fail-closed moderation gate resolves. Omit when
     * the moderation gate is disabled, or pass `listingModeration` explicitly.
     */
    listingSpecHash?: HireFromListingHumanlessAsyncInput["taskId"];
  };

/**
 * Build a hire_from_listing_humanless instruction — the human-visitor storefront
 * entry point. Identical to {@link hireFromListing} except the buyer is a plain
 * wallet with NO registered agent (no `creatorAgent` account), and the task is
 * always pinned to CreatorReview so the human reviews before funds release. The
 * async builder auto-derives task, escrow, hireRecord, taskValidationConfig,
 * protocolConfig, moderationConfig, authorityRateLimit, and systemProgram; the
 * caller supplies `listing` and the `creator` wallet. `listingModeration` is
 * derived from `listingSpecHash` when given and not passed explicitly.
 */
export async function hireFromListingHumanless(
  input: HireFromListingHumanlessInput,
) {
  const { listingSpecHash, ...rest } = input;
  if (rest.listingModeration === undefined && listingSpecHash !== undefined) {
    const [listingModeration] = await findListingModerationPda({
      listing: rest.listing,
      jobSpecHash: listingSpecHash,
    });
    return getHireFromListingHumanlessInstructionAsync({
      ...rest,
      listingModeration,
    });
  }
  return getHireFromListingHumanlessInstructionAsync(rest);
}
