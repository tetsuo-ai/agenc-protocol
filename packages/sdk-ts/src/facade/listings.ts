// Facade: ergonomic, named entry points over the generated client. Thin by design —
// the generated client already resolves PDAs and encodes data; the facade adds friendly
// signatures, defaults, and (for multi-PDA flows) bundling. Never import from generated/
// internals other than its public exports.
//
// Domain: service-listing lifecycle (create / update / set-state) + listing hire.
// `hire_from_listing` is the registered-buyer path. `hire_from_listing_humanless`
// is the human-wallet storefront checkout path used by the reference marketplace.
// Both mint the task + escrow in one instruction.
import { AccountRole, type Address } from "@solana/kit";
import {
  getCreateServiceListingInstructionAsync,
  getUpdateServiceListingInstructionAsync,
  getSetServiceListingStateInstructionAsync,
  getHireFromListingInstructionAsync,
  getHireFromListingHumanlessInstructionAsync,
  getRateHireInstructionAsync,
  findListingPda,
  findListingModerationPda,
  findModerationAttestorPda,
  findModerationBlockPda,
  type CreateServiceListingAsyncInput,
  type UpdateServiceListingAsyncInput,
  type SetServiceListingStateAsyncInput,
  type HireFromListingAsyncInput,
  type HireFromListingHumanlessAsyncInput,
  type RateHireAsyncInput,
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
 * pass `null` to leave a field unchanged and a value to overwrite it. The spec
 * hash and URI are one atomic pair: update both or neither. The protocolConfig
 * is auto-derived.
 */
export type UpdateServiceListingInput = Omit<
  UpdateServiceListingAsyncInput,
  "specHash" | "specUri"
> &
  (
    | {
        specHash: NonNullable<UpdateServiceListingAsyncInput["specHash"]>;
        specUri: string;
      }
    | { specHash: null; specUri: null }
  );

export async function updateServiceListing(input: UpdateServiceListingInput) {
  const hasHash = input.specHash !== null;
  const hasUri = input.specUri !== null;
  if (hasHash !== hasUri) {
    throw new Error(
      "updateServiceListing: specHash and specUri must be updated together",
    );
  }
  return getUpdateServiceListingInstructionAsync(input);
}

/** Listing lifecycle states (matches the on-chain `newState` u8 enum). */
export const ListingState = {
  Active: 0,
  Paused: 1,
  Retired: 2,
  /** @deprecated The on-chain/public state name is `Retired`. */
  Closed: 2,
} as const;
export type ListingStateName = keyof typeof ListingState;

/**
 * Build a set_service_listing_state instruction (activate / pause / retire).
 * Accepts either the raw u8 `newState` or a friendly `state` name; protocolConfig
 * is auto-derived.
 */
export async function setServiceListingState(
  input: Omit<SetServiceListingStateAsyncInput, "newState"> & {
    /**
     * Required only for reactivation. Pause/retire deliberately retain the
     * three-account revision-4 wire and ignore this compatibility field.
     */
    providerAgent?: Address;
  } &
    ({ newState: number } | { state: ListingStateName }),
) {
  const newState =
    "state" in input ? ListingState[input.state] : input.newState;
  const { state: _state, providerAgent, ...rest } = input as {
    state?: ListingStateName;
    providerAgent?: Address;
  } & Omit<SetServiceListingStateAsyncInput, "newState">;
  const instruction = await getSetServiceListingStateInstructionAsync({
    ...rest,
    newState,
  });

  if (newState !== ListingState.Active) return instruction;
  if (providerAgent === undefined) {
    throw new Error(
      "setServiceListingState: providerAgent is required to reactivate a listing",
    );
  }
  return Object.freeze({
    ...instruction,
    accounts: [
      ...instruction.accounts,
      { address: providerAgent, role: AccountRole.READONLY },
    ],
  });
}

/**
 * P1.2 moderation inputs shared by both hire wrappers: the facade derives the
 * v2 listing-moderation record PDA and the REQUIRED BLOCK-floor PDA from the
 * listing's pinned `spec_hash`, so callers pass the hash they already know
 * instead of computing PDAs.
 */
type HireModerationInputs = {
  /**
   * The listing's pinned `spec_hash` (32 bytes). Used to derive BOTH:
   * `listingModeration` (the v2 record `["listing_moderation_v2", listing,
   * specHash, moderator]` — only when `listingModeration` is not passed and the
   * moderation gate needs it) AND the REQUIRED `moderationBlock` BLOCK-floor
   * PDA `["moderation_block", specHash]`. Required unless `moderationBlock` is
   * passed explicitly (the block account is mandatory on-chain even with the
   * moderation gate disabled; an empty account at the canonical address passes).
   */
  listingSpecHash?: HireFromListingAsyncInput["taskId"];
  /**
   * Override for the BLOCK-floor PDA (rarely needed — it derives from
   * `listingSpecHash`).
   */
  moderationBlock?: Address;
  /**
   * P1.2 roster path switch. Set `true` when `moderator` is a REGISTERED
   * moderation attestor (not the global moderation authority): the facade then
   * derives and attaches the `["moderation_attestor", moderator]` roster entry
   * the hire gate requires. Leave unset/false for the global-authority path —
   * the roster account is then omitted (`None`). Ignored when
   * `moderationAttestor` is passed explicitly.
   */
  moderatorIsAttestor?: boolean;
};

/** Derive the P1.2 moderation accounts both hire wrappers need. */
async function resolveHireModerationAccounts(input: {
  wrapper: "hireFromListing" | "hireFromListingHumanless";
  listing: Address;
  moderator: Address;
  listingSpecHash?: HireFromListingAsyncInput["taskId"];
  listingModeration?: Address;
  moderationAttestor?: Address;
  moderationBlock?: Address;
  moderatorIsAttestor?: boolean;
}): Promise<{
  listingModeration?: Address;
  moderationAttestor?: Address;
  moderationBlock: Address;
}> {
  let moderationBlock = input.moderationBlock;
  if (moderationBlock === undefined) {
    if (input.listingSpecHash === undefined) {
      throw new Error(
        `${input.wrapper}: provide listingSpecHash (the listing's pinned spec_hash) ` +
          "or an explicit moderationBlock — the BLOCK-floor account " +
          '["moderation_block", spec_hash] is required on-chain (P1.2 §5.2)',
      );
    }
    moderationBlock = (
      await findModerationBlockPda({ contentHash: input.listingSpecHash })
    )[0];
  }
  let listingModeration = input.listingModeration;
  if (listingModeration === undefined && input.listingSpecHash !== undefined) {
    listingModeration = (
      await findListingModerationPda({
        listing: input.listing,
        jobSpecHash: input.listingSpecHash,
        moderator: input.moderator,
      })
    )[0];
  }
  let moderationAttestor = input.moderationAttestor;
  if (moderationAttestor === undefined && input.moderatorIsAttestor) {
    moderationAttestor = (
      await findModerationAttestorPda({ attestor: input.moderator })
    )[0];
  }
  return { listingModeration, moderationAttestor, moderationBlock };
}

/**
 * Friendly input for {@link hireFromListing}. Mirrors the generated async input,
 * but lets the caller pass `listingSpecHash` so the facade can derive the
 * listing-moderation attestation PDA (bound to the listing's pinned spec hash and
 * the presented `moderator` — P1.2 v2 seeds) and the required BLOCK-floor PDA,
 * instead of requiring the caller to compute them.
 */
export type HireFromListingInput = Omit<
  HireFromListingAsyncInput,
  "referrer" | "referrerFeeBps" | "moderationBlock"
> &
  HireModerationInputs & {
    /**
     * Optional P6.2 demand-side referral leg. Omit (the default) for the exact
     * pre-referrer behavior: the facade defaults `referrer` to `null` (the
     * Option::None the program treats as "no referrer") and `referrerFeeBps` to
     * `0`, which the on-chain `resolve_referrer_snapshot` maps to the no-leg/skip
     * path — no funds are ever routed to a default/wrong address. Pass a real
     * `referrer` with a non-zero `referrerFeeBps` to opt a demand-side embedder
     * into the 4-way settlement split.
     */
    referrer?: HireFromListingAsyncInput["referrer"];
    referrerFeeBps?: HireFromListingAsyncInput["referrerFeeBps"];
  };

/**
 * Build a hire_from_listing instruction — the registered-buyer entry point.
 *
 * The async builder auto-derives task, escrow, hireRecord, protocolConfig,
 * moderationConfig, authorityRateLimit, and systemProgram. The caller must
 * supply `listing` and `creatorAgent` (not derivable), plus the P1.2 `moderator`
 * argument — the pubkey whose listing attestation the hire consumes (the global
 * moderation authority, or a registered attestor with
 * `moderatorIsAttestor: true`). If the caller passes `listingSpecHash`, the
 * facade derives `listingModeration` (v2: listing + specHash + moderator) and
 * the REQUIRED `moderationBlock` BLOCK-floor PDA from it.
 */
export async function hireFromListing(input: HireFromListingInput) {
  const {
    listingSpecHash,
    moderatorIsAttestor,
    referrer,
    referrerFeeBps,
    ...rest
  } = input;
  const moderation = await resolveHireModerationAccounts({
    wrapper: "hireFromListing",
    listing: rest.listing,
    moderator: rest.moderator,
    listingSpecHash,
    listingModeration: rest.listingModeration,
    moderationAttestor: rest.moderationAttestor,
    moderationBlock: rest.moderationBlock,
    moderatorIsAttestor,
  });
  return getHireFromListingInstructionAsync({
    ...rest,
    ...moderation,
    referrer: referrer ?? null,
    referrerFeeBps: referrerFeeBps ?? 0,
  });
}

/**
 * Friendly input for {@link hireFromListingHumanless}. Mirrors the generated
 * async input but lets the caller pass `listingSpecHash` so the facade derives
 * the listing-moderation attestation PDA (bound to the listing's pinned spec
 * hash and the presented `moderator` — P1.2 v2 seeds) and the required
 * BLOCK-floor PDA, instead of requiring the caller to compute them.
 */
export type HireFromListingHumanlessInput = Omit<
  HireFromListingHumanlessAsyncInput,
  "referrer" | "referrerFeeBps" | "moderationBlock"
> &
  HireModerationInputs & {
    /**
     * Optional P6.2 demand-side referral leg. Omit (the default) for the exact
     * pre-referrer behavior: defaults to the no-leg/skip path (`referrer: null`,
     * `referrerFeeBps: 0`), so no funds are ever routed to a default/wrong address.
     */
    referrer?: HireFromListingHumanlessAsyncInput["referrer"];
    referrerFeeBps?: HireFromListingHumanlessAsyncInput["referrerFeeBps"];
  };

/**
 * Build a hire_from_listing_humanless instruction — the human-visitor storefront
 * entry point. Identical to {@link hireFromListing} except the buyer is a plain
 * wallet with NO registered agent (no `creatorAgent` account), and the task is
 * always pinned to CreatorReview so the human reviews before funds release. The
 * async builder auto-derives task, escrow, hireRecord, taskValidationConfig,
 * protocolConfig, moderationConfig, authorityRateLimit, and systemProgram; the
 * caller supplies `listing`, the `creator` wallet, and the P1.2 `moderator`
 * argument. `listingModeration` (v2) and the REQUIRED `moderationBlock` are
 * derived from `listingSpecHash` when given and not passed explicitly.
 */
export async function hireFromListingHumanless(
  input: HireFromListingHumanlessInput,
) {
  const {
    listingSpecHash,
    moderatorIsAttestor,
    referrer,
    referrerFeeBps,
    ...rest
  } = input;
  const moderation = await resolveHireModerationAccounts({
    wrapper: "hireFromListingHumanless",
    listing: rest.listing,
    moderator: rest.moderator,
    listingSpecHash,
    listingModeration: rest.listingModeration,
    moderationAttestor: rest.moderationAttestor,
    moderationBlock: rest.moderationBlock,
    moderatorIsAttestor,
  });
  return getHireFromListingHumanlessInstructionAsync({
    ...rest,
    ...moderation,
    referrer: referrer ?? null,
    referrerFeeBps: referrerFeeBps ?? 0,
  });
}

/**
 * Build a rate_hire instruction (P6.1) — the buyer scores a completed listing
 * hire (1..=5) and folds the score into the listing's `total_rating`/
 * `rating_count` aggregate.
 *
 * The async builder auto-derives `task` (from creator + taskId), `hireRecord`
 * (`["hire", task]`), the init-once `hireRating` PDA (`["hire_rating", task]`),
 * `protocolConfig`, and `systemProgram`. The caller supplies `listing` (not
 * derivable from the task alone), the `task`/identity inputs the generated input
 * requires, and the `buyer` signer (must equal the task's recorded creator).
 *
 * `reviewHash` defaults to `null` and `reviewUri` to `""` (no written review),
 * matching {@link rateSkill}'s optional-review convention. The program enforces
 * the score range, terminal-Completed status, buyer identity, and one-rating-
 * per-hire (the init-once PDA) on-chain.
 */
export async function rateHire(
  input: Omit<RateHireAsyncInput, "reviewHash" | "reviewUri"> & {
    reviewHash?: RateHireAsyncInput["reviewHash"];
    reviewUri?: RateHireAsyncInput["reviewUri"];
  },
) {
  return getRateHireInstructionAsync({
    reviewHash: null,
    reviewUri: "",
    ...input,
  });
}
