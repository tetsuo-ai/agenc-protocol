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

export { findListingPda, findListingModerationPda };

/**
 * Build a create_service_listing instruction. The listing PDA (derived from
 * providerAgent + listingId), protocolConfig, and systemProgram are all
 * auto-derived by the async builder, so callers only supply identity + terms.
 */
export async function createServiceListing(input: CreateServiceListingAsyncInput) {
  return getCreateServiceListingInstructionAsync(input);
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
