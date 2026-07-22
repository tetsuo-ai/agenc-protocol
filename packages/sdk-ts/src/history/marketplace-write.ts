/**
 * Frozen marketplace-write history decoder.
 *
 * Revision 5 deliberately changed the discriminators and account layouts of
 * the two listing-hire instructions and `set_task_job_spec`. That prevents an
 * old program from accepting a new payload while silently ignoring the new
 * buyer-specific commitment. Indexers still need to backfill transactions
 * emitted by the deployed revision-4 program, though, so this module preserves
 * those three legacy data/account schemas alongside the current v2 schemas.
 *
 * This surface is decode-only by design. Never use revision-4 shapes to build
 * or replay a transaction; legacy hires do not commit to the buyer's exact job
 * spec and revision 5 rejects their activation/claim path.
 */

import {
  addDecoderSizePrefix,
  fixDecoderSize,
  getAddressDecoder,
  getBytesDecoder,
  getI64Decoder,
  getOptionDecoder,
  getStructDecoder,
  getU16Decoder,
  getU32Decoder,
  getU64Decoder,
  type Address,
  type Decoder,
  type Option,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { getBorshStringDecoder } from "../generated/codecs/borshString.js";
import {
  getHireFromListingInstructionDataDecoder,
  HIRE_FROM_LISTING_DISCRIMINATOR,
  type HireFromListingInstructionData,
} from "../generated/instructions/hireFromListing.js";
import {
  getHireFromListingHumanlessInstructionDataDecoder,
  HIRE_FROM_LISTING_HUMANLESS_DISCRIMINATOR,
  type HireFromListingHumanlessInstructionData,
} from "../generated/instructions/hireFromListingHumanless.js";
import {
  getSetTaskJobSpecInstructionDataDecoder,
  SET_TASK_JOB_SPEC_DISCRIMINATOR,
  type SetTaskJobSpecInstructionData,
} from "../generated/instructions/setTaskJobSpec.js";

const REVISION_4_HIRE_FROM_LISTING_DISCRIMINATOR_BYTES = [
  174, 225, 81, 68, 172, 19, 97, 194,
] as const;
const REVISION_4_HIRE_FROM_LISTING_HUMANLESS_DISCRIMINATOR_BYTES = [
  90, 142, 39, 225, 150, 161, 217, 49,
] as const;
const REVISION_4_SET_TASK_JOB_SPEC_DISCRIMINATOR_BYTES = [
  134, 102, 102, 86, 31, 164, 202, 193,
] as const;

/** Exact Anchor discriminator deployed on revision 4. */
export const REVISION_4_HIRE_FROM_LISTING_DISCRIMINATOR: ReadonlyUint8Array =
  Uint8Array.from(REVISION_4_HIRE_FROM_LISTING_DISCRIMINATOR_BYTES);

/** Exact Anchor discriminator deployed on revision 4. */
export const REVISION_4_HIRE_FROM_LISTING_HUMANLESS_DISCRIMINATOR: ReadonlyUint8Array =
  Uint8Array.from(REVISION_4_HIRE_FROM_LISTING_HUMANLESS_DISCRIMINATOR_BYTES);

/** Exact Anchor discriminator deployed on revision 4. */
export const REVISION_4_SET_TASK_JOB_SPEC_DISCRIMINATOR: ReadonlyUint8Array =
  Uint8Array.from(REVISION_4_SET_TASK_JOB_SPEC_DISCRIMINATOR_BYTES);

export type MarketplaceWriteInstructionName =
  | "hire_from_listing"
  | "hire_from_listing_humanless"
  | "set_task_job_spec";

export type MarketplaceWriteWireVersion = "legacy-v1" | "commitment-v2";

/** Account-meta position and privileges in one frozen instruction ABI. */
export interface MarketplaceWriteAccountSchema {
  readonly name: string;
  readonly writable: boolean;
  readonly signer: boolean;
  readonly optional: boolean;
}

function freezeAccountSchema(
  accounts: readonly MarketplaceWriteAccountSchema[],
): readonly MarketplaceWriteAccountSchema[] {
  return Object.freeze(
    accounts.map((account) => Object.freeze({ ...account })),
  );
}

const ro = (name: string, optional = false): MarketplaceWriteAccountSchema => ({
  name,
  writable: false,
  signer: false,
  optional,
});
const rw = (name: string): MarketplaceWriteAccountSchema => ({
  name,
  writable: true,
  signer: false,
  optional: false,
});
const signer = (
  name: string,
  writable: boolean,
): MarketplaceWriteAccountSchema => ({
  name,
  writable,
  signer: true,
  optional: false,
});

/**
 * Exact revision-4 account order. In particular, both hires predate the
 * explicit `provider_agent` meta and activation predates `hire_record`.
 */
export const REVISION_4_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS = Object.freeze({
  hire_from_listing: freezeAccountSchema([
    rw("task"),
    rw("escrow"),
    rw("hire_record"),
    rw("listing"),
    rw("protocol_config"),
    ro("moderation_config"),
    ro("listing_moderation", true),
    ro("moderation_attestor", true),
    ro("moderation_block"),
    ro("creator_agent"),
    rw("authority_rate_limit"),
    signer("authority", false),
    signer("creator", true),
    ro("system_program"),
  ]),
  hire_from_listing_humanless: freezeAccountSchema([
    rw("task"),
    rw("escrow"),
    rw("hire_record"),
    rw("task_validation_config"),
    rw("listing"),
    rw("protocol_config"),
    ro("moderation_config"),
    ro("listing_moderation", true),
    ro("moderation_attestor", true),
    ro("moderation_block"),
    rw("authority_rate_limit"),
    signer("creator", true),
    ro("system_program"),
  ]),
  set_task_job_spec: freezeAccountSchema([
    ro("protocol_config"),
    ro("task"),
    ro("moderation_config"),
    ro("task_moderation"),
    ro("moderation_attestor", true),
    ro("moderation_block"),
    rw("task_job_spec"),
    signer("creator", true),
    ro("system_program"),
  ]),
});

/** Exact revision-5 commitment-v2 account order. */
export const REVISION_5_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS = Object.freeze({
  hire_from_listing: freezeAccountSchema([
    rw("task"),
    rw("escrow"),
    rw("hire_record"),
    rw("listing"),
    ro("provider_agent"),
    rw("protocol_config"),
    ro("moderation_config"),
    ro("listing_moderation", true),
    ro("moderation_attestor", true),
    ro("moderation_block"),
    ro("creator_agent"),
    rw("authority_rate_limit"),
    signer("authority", false),
    signer("creator", true),
    ro("system_program"),
  ]),
  hire_from_listing_humanless: freezeAccountSchema([
    rw("task"),
    rw("escrow"),
    rw("hire_record"),
    rw("task_validation_config"),
    rw("listing"),
    ro("provider_agent"),
    rw("protocol_config"),
    ro("moderation_config"),
    ro("listing_moderation", true),
    ro("moderation_attestor", true),
    ro("moderation_block"),
    rw("authority_rate_limit"),
    signer("creator", true),
    ro("system_program"),
  ]),
  set_task_job_spec: freezeAccountSchema([
    ro("protocol_config"),
    ro("task"),
    ro("moderation_config"),
    ro("task_moderation"),
    ro("moderation_attestor", true),
    ro("moderation_block"),
    rw("task_job_spec"),
    signer("creator", true),
    ro("system_program"),
    ro("hire_record"),
  ]),
});

export interface Revision4HireFromListingInstructionData {
  readonly discriminator: ReadonlyUint8Array;
  readonly taskId: ReadonlyUint8Array;
  readonly expectedPrice: bigint;
  readonly expectedVersion: bigint;
  readonly referrer: Option<Address>;
  readonly referrerFeeBps: number;
  readonly moderator: Address;
}

export interface Revision4HireFromListingHumanlessInstructionData {
  readonly discriminator: ReadonlyUint8Array;
  readonly taskId: ReadonlyUint8Array;
  readonly expectedPrice: bigint;
  readonly expectedVersion: bigint;
  readonly reviewWindowSecs: bigint;
  readonly referrer: Option<Address>;
  readonly referrerFeeBps: number;
  readonly moderator: Address;
}

export interface Revision4SetTaskJobSpecInstructionData {
  readonly discriminator: ReadonlyUint8Array;
  readonly jobSpecHash: ReadonlyUint8Array;
  readonly jobSpecUri: string;
  readonly moderator: Address;
}

const revision4HireFromListingDecoder: Decoder<Revision4HireFromListingInstructionData> =
  getStructDecoder([
    ["discriminator", fixDecoderSize(getBytesDecoder(), 8)],
    ["taskId", fixDecoderSize(getBytesDecoder(), 32)],
    ["expectedPrice", getU64Decoder()],
    ["expectedVersion", getU64Decoder()],
    ["referrer", getOptionDecoder(getAddressDecoder())],
    ["referrerFeeBps", getU16Decoder()],
    ["moderator", getAddressDecoder()],
  ]);

const revision4HireFromListingHumanlessDecoder: Decoder<Revision4HireFromListingHumanlessInstructionData> =
  getStructDecoder([
    ["discriminator", fixDecoderSize(getBytesDecoder(), 8)],
    ["taskId", fixDecoderSize(getBytesDecoder(), 32)],
    ["expectedPrice", getU64Decoder()],
    ["expectedVersion", getU64Decoder()],
    ["reviewWindowSecs", getI64Decoder()],
    ["referrer", getOptionDecoder(getAddressDecoder())],
    ["referrerFeeBps", getU16Decoder()],
    ["moderator", getAddressDecoder()],
  ]);

const revision4SetTaskJobSpecDecoder: Decoder<Revision4SetTaskJobSpecInstructionData> =
  getStructDecoder([
    ["discriminator", fixDecoderSize(getBytesDecoder(), 8)],
    ["jobSpecHash", fixDecoderSize(getBytesDecoder(), 32)],
    [
      "jobSpecUri",
      addDecoderSizePrefix(getBorshStringDecoder(), getU32Decoder()),
    ],
    ["moderator", getAddressDecoder()],
  ]);

type Identity<
  TName extends MarketplaceWriteInstructionName,
  TWire extends MarketplaceWriteWireVersion,
  TRevision extends 4 | 5,
> = {
  readonly instruction: TName;
  readonly wireVersion: TWire;
  readonly surfaceRevision: TRevision;
  readonly discriminator: ReadonlyUint8Array;
  readonly accountSchema: readonly MarketplaceWriteAccountSchema[];
};

export type MarketplaceWriteInstructionIdentity =
  | Identity<"hire_from_listing", "legacy-v1", 4>
  | Identity<"hire_from_listing_humanless", "legacy-v1", 4>
  | Identity<"set_task_job_spec", "legacy-v1", 4>
  | Identity<"hire_from_listing", "commitment-v2", 5>
  | Identity<"hire_from_listing_humanless", "commitment-v2", 5>
  | Identity<"set_task_job_spec", "commitment-v2", 5>;

export type DecodedMarketplaceWriteInstruction =
  | (Identity<"hire_from_listing", "legacy-v1", 4> & {
      readonly data: Revision4HireFromListingInstructionData;
    })
  | (Identity<"hire_from_listing_humanless", "legacy-v1", 4> & {
      readonly data: Revision4HireFromListingHumanlessInstructionData;
    })
  | (Identity<"set_task_job_spec", "legacy-v1", 4> & {
      readonly data: Revision4SetTaskJobSpecInstructionData;
    })
  | (Identity<"hire_from_listing", "commitment-v2", 5> & {
      readonly data: HireFromListingInstructionData;
    })
  | (Identity<"hire_from_listing_humanless", "commitment-v2", 5> & {
      readonly data: HireFromListingHumanlessInstructionData;
    })
  | (Identity<"set_task_job_spec", "commitment-v2", 5> & {
      readonly data: SetTaskJobSpecInstructionData;
    });

function startsWithDiscriminator(
  data: ReadonlyUint8Array,
  discriminator: ReadonlyUint8Array,
): boolean {
  if (data.length < discriminator.length) return false;
  for (let index = 0; index < discriminator.length; index += 1) {
    if (data[index] !== discriminator[index]) return false;
  }
  return true;
}

const IDENTITIES: readonly MarketplaceWriteInstructionIdentity[] =
  Object.freeze([
    {
      instruction: "hire_from_listing",
      wireVersion: "legacy-v1",
      surfaceRevision: 4,
      discriminator: Uint8Array.from(
        REVISION_4_HIRE_FROM_LISTING_DISCRIMINATOR_BYTES,
      ),
      accountSchema:
        REVISION_4_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS.hire_from_listing,
    },
    {
      instruction: "hire_from_listing_humanless",
      wireVersion: "legacy-v1",
      surfaceRevision: 4,
      discriminator: Uint8Array.from(
        REVISION_4_HIRE_FROM_LISTING_HUMANLESS_DISCRIMINATOR_BYTES,
      ),
      accountSchema:
        REVISION_4_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS.hire_from_listing_humanless,
    },
    {
      instruction: "set_task_job_spec",
      wireVersion: "legacy-v1",
      surfaceRevision: 4,
      discriminator: Uint8Array.from(
        REVISION_4_SET_TASK_JOB_SPEC_DISCRIMINATOR_BYTES,
      ),
      accountSchema:
        REVISION_4_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS.set_task_job_spec,
    },
    {
      instruction: "hire_from_listing",
      wireVersion: "commitment-v2",
      surfaceRevision: 5,
      discriminator: new Uint8Array(HIRE_FROM_LISTING_DISCRIMINATOR),
      accountSchema:
        REVISION_5_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS.hire_from_listing,
    },
    {
      instruction: "hire_from_listing_humanless",
      wireVersion: "commitment-v2",
      surfaceRevision: 5,
      discriminator: new Uint8Array(HIRE_FROM_LISTING_HUMANLESS_DISCRIMINATOR),
      accountSchema:
        REVISION_5_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS.hire_from_listing_humanless,
    },
    {
      instruction: "set_task_job_spec",
      wireVersion: "commitment-v2",
      surfaceRevision: 5,
      discriminator: new Uint8Array(SET_TASK_JOB_SPEC_DISCRIMINATOR),
      accountSchema:
        REVISION_5_MARKETPLACE_WRITE_ACCOUNT_SCHEMAS.set_task_job_spec,
    },
  ] satisfies readonly MarketplaceWriteInstructionIdentity[]);

function copyIdentity(
  identity: MarketplaceWriteInstructionIdentity,
): MarketplaceWriteInstructionIdentity {
  return {
    ...identity,
    discriminator: new Uint8Array(identity.discriminator),
  } as MarketplaceWriteInstructionIdentity;
}

/**
 * Identify one of the three changed marketplace writes by its frozen eight-byte
 * discriminator. Returns `null` for unrelated (or shorter) instruction data.
 * Identification does not imply the remainder of the payload is well formed;
 * call {@link decodeMarketplaceWriteInstruction} for strict decoding.
 */
export function identifyMarketplaceWriteInstruction(
  input: ReadonlyUint8Array | { readonly data: ReadonlyUint8Array },
): MarketplaceWriteInstructionIdentity | null {
  const data = "data" in input ? input.data : input;
  const identity = IDENTITIES.find((candidate) =>
    startsWithDiscriminator(data, candidate.discriminator),
  );
  return identity === undefined ? null : copyIdentity(identity);
}

function cloneDecodedValue<T>(value: T): T {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => cloneDecodedValue(entry)) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        cloneDecodedValue(entry),
      ]),
    ) as T;
  }
  return value;
}

function decodeExactly<T>(
  decoder: Decoder<T>,
  data: ReadonlyUint8Array,
  label: string,
): T {
  try {
    const [decoded, offset] = decoder.read(data, 0);
    if (offset !== data.length) {
      throw new TypeError(
        `${label} contains ${data.length - offset} trailing byte(s)`,
      );
    }
    return cloneDecodedValue(decoded);
  } catch (cause) {
    if (cause instanceof TypeError && cause.message.startsWith(label)) {
      throw cause;
    }
    throw new TypeError(`Invalid ${label} instruction data`, { cause });
  }
}

function assertCanonicalOptionTag(
  data: ReadonlyUint8Array,
  offset: number,
  label: string,
): void {
  const tag = data[offset];
  // Rust Borsh accepts exactly 0 (None) or 1 (Some). Kit's general Option
  // decoder is intentionally more permissive, so enforce the on-chain wire
  // here before delegating to the generated/current or frozen/legacy decoder.
  if (tag !== 0 && tag !== 1) {
    throw new TypeError(
      `Invalid ${label} instruction data: option tag at byte ${offset} must be 0 or 1`,
    );
  }
}

/**
 * Strictly decode a revision-4 legacy-v1 or revision-5 commitment-v2 write.
 * The complete byte slice must match its selected schema; truncated payloads,
 * non-canonical options/strings, and trailing bytes throw `TypeError`.
 * Unrelated instruction data returns `null`, which is convenient for history
 * scanners that inspect every instruction owned by the program.
 */
export function decodeMarketplaceWriteInstruction(
  input: ReadonlyUint8Array | { readonly data: ReadonlyUint8Array },
): DecodedMarketplaceWriteInstruction | null {
  const data = "data" in input ? input.data : input;
  const identity = identifyMarketplaceWriteInstruction(data);
  if (identity === null) return null;
  const label = `${identity.instruction} ${identity.wireVersion}`;
  if (identity.instruction === "hire_from_listing") {
    assertCanonicalOptionTag(data, 56, label);
  } else if (identity.instruction === "hire_from_listing_humanless") {
    assertCanonicalOptionTag(data, 64, label);
  }

  if (identity.wireVersion === "legacy-v1") {
    switch (identity.instruction) {
      case "hire_from_listing":
        return {
          ...identity,
          data: decodeExactly(revision4HireFromListingDecoder, data, label),
        };
      case "hire_from_listing_humanless":
        return {
          ...identity,
          data: decodeExactly(
            revision4HireFromListingHumanlessDecoder,
            data,
            label,
          ),
        };
      case "set_task_job_spec":
        return {
          ...identity,
          data: decodeExactly(revision4SetTaskJobSpecDecoder, data, label),
        };
    }
  }

  switch (identity.instruction) {
    case "hire_from_listing":
      return {
        ...identity,
        data: decodeExactly(
          getHireFromListingInstructionDataDecoder(),
          data,
          label,
        ),
      };
    case "hire_from_listing_humanless":
      return {
        ...identity,
        data: decodeExactly(
          getHireFromListingHumanlessInstructionDataDecoder(),
          data,
          label,
        ),
      };
    case "set_task_job_spec":
      return {
        ...identity,
        data: decodeExactly(
          getSetTaskJobSpecInstructionDataDecoder(),
          data,
          label,
        ),
      };
  }
}
