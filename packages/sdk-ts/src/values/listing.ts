// LISTING_METADATA v1 wire codecs for the fixed-width `ServiceListing`
// string fields (`name`, `category`, `tags`). The standard itself is
// documented in docs/LISTING_METADATA.md (P1.5); this module is the reference
// implementation. Browser-safe: TextEncoder/TextDecoder only, no `Buffer`.
//
// Wire rules (v1):
//   name     — UTF-8, NUL-padded to exactly 32 bytes, no embedded NUL.
//   category — same 32-byte rule PLUS lowercase-kebab (`[a-z0-9]+(-[a-z0-9]+)*`).
//   tags     — lowercase-kebab tokens joined with ",", UTF-8, NUL-padded to
//              exactly 64 bytes.
// Decoders strip trailing NUL padding and validate the same constraints.

/** Exact on-chain byte width of `ServiceListing.name`. */
export const LISTING_NAME_BYTES = 32;
/** Exact on-chain byte width of `ServiceListing.category`. */
export const LISTING_CATEGORY_BYTES = 32;
/** Exact on-chain byte width of `ServiceListing.tags`. */
export const LISTING_TAGS_BYTES = 64;

/**
 * Lowercase-kebab token rule used by LISTING_METADATA v1 categories and tags:
 * one or more `[a-z0-9]` runs separated by single hyphens — no uppercase, no
 * leading/trailing/double hyphen, no empty token.
 */
export const LISTING_KEBAB_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Shared UTF-8 codecs. `fatal: true` rejects malformed on-chain bytes. */
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * UTF-8 encodes `value` and NUL-pads it to exactly `size` bytes.
 * Throws `TypeError` on embedded NUL (it would be indistinguishable from
 * padding) and `RangeError` when the UTF-8 byte length exceeds `size`.
 */
function encodeFixedUtf8(value: string, size: number, field: string): Uint8Array {
  if (value.includes("\u0000")) {
    throw new TypeError(`${field}: embedded NUL characters are not allowed`);
  }
  const bytes = utf8Encoder.encode(value);
  if (bytes.length > size) {
    throw new RangeError(
      `${field}: UTF-8 encoding is ${bytes.length} bytes, exceeds the ${size}-byte field`,
    );
  }
  const out = new Uint8Array(size);
  out.set(bytes);
  return out;
}

/**
 * Strips trailing NUL padding from an exactly-`size`-byte field and decodes
 * the remainder as UTF-8. Throws `RangeError` on a wrong-length input and
 * `TypeError` on malformed UTF-8.
 */
function decodeFixedUtf8(bytes: Uint8Array, size: number, field: string): string {
  if (bytes.length !== size) {
    throw new RangeError(`${field}: expected exactly ${size} bytes, got ${bytes.length}`);
  }
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return utf8Decoder.decode(bytes.subarray(0, end));
}

/**
 * Encodes a listing display name into the LISTING_METADATA v1 wire form:
 * UTF-8, NUL-padded to exactly 32 bytes.
 *
 * @param name - The listing name (any UTF-8 text up to 32 encoded bytes; an
 *   empty string encodes an unset name as all-NUL).
 * @returns A 32-byte `Uint8Array` ready for `facade.createServiceListing`.
 * @throws RangeError when the UTF-8 byte length exceeds 32 (note: multibyte
 *   characters count by **bytes**, not characters).
 * @throws TypeError when the name contains an embedded NUL character.
 *
 * @example
 * ```ts
 * const name = encodeListingName("translation-service"); // 32 bytes
 * ```
 */
export function encodeListingName(name: string): Uint8Array {
  return encodeFixedUtf8(name, LISTING_NAME_BYTES, "listing name");
}

/**
 * Decodes a 32-byte on-chain listing name back to a string by stripping
 * trailing NUL padding.
 *
 * @param bytes - Exactly 32 bytes of on-chain `ServiceListing.name` data.
 * @returns The decoded name (empty string for an all-NUL field).
 * @throws RangeError when `bytes` is not exactly 32 bytes long.
 * @throws TypeError when the unpadded bytes are not valid UTF-8.
 */
export function decodeListingName(bytes: Uint8Array): string {
  return decodeFixedUtf8(bytes, LISTING_NAME_BYTES, "listing name");
}

/**
 * Encodes a listing category into the LISTING_METADATA v1 wire form: a
 * lowercase-kebab token ({@link LISTING_KEBAB_PATTERN}), UTF-8, NUL-padded to
 * exactly 32 bytes.
 *
 * @param category - The category token, e.g. `"code-generation"` or
 *   `"translation"` (see the canonical taxonomy in docs/LISTING_METADATA.md).
 * @returns A 32-byte `Uint8Array` ready for `facade.createServiceListing`.
 * @throws TypeError when the category is not lowercase-kebab (this also
 *   rejects the empty string and embedded NULs).
 * @throws RangeError when the encoding exceeds 32 bytes.
 *
 * @example
 * ```ts
 * const category = encodeListingCategory("code-generation");
 * ```
 */
export function encodeListingCategory(category: string): Uint8Array {
  if (!LISTING_KEBAB_PATTERN.test(category)) {
    throw new TypeError(
      `listing category: ${JSON.stringify(category)} is not lowercase-kebab ([a-z0-9]+(-[a-z0-9]+)*)`,
    );
  }
  return encodeFixedUtf8(category, LISTING_CATEGORY_BYTES, "listing category");
}

/**
 * Decodes a 32-byte on-chain listing category by stripping trailing NUL
 * padding and validating the lowercase-kebab rule.
 *
 * @param bytes - Exactly 32 bytes of on-chain `ServiceListing.category` data.
 * @returns The decoded category token, or `""` for an all-NUL (unset) field.
 * @throws RangeError when `bytes` is not exactly 32 bytes long.
 * @throws TypeError when the decoded value is non-empty and not
 *   lowercase-kebab, or is not valid UTF-8.
 */
export function decodeListingCategory(bytes: Uint8Array): string {
  const category = decodeFixedUtf8(bytes, LISTING_CATEGORY_BYTES, "listing category");
  if (category !== "" && !LISTING_KEBAB_PATTERN.test(category)) {
    throw new TypeError(
      `listing category: on-chain value ${JSON.stringify(category)} is not lowercase-kebab`,
    );
  }
  return category;
}

/**
 * Encodes listing tags into the LISTING_METADATA v1 wire form: each tag a
 * lowercase-kebab token ({@link LISTING_KEBAB_PATTERN}), joined with commas,
 * UTF-8, NUL-padded to exactly 64 bytes. An empty array encodes as all-NUL.
 *
 * @param tags - The tag tokens, e.g. `["english-to-french", "docs"]`.
 * @returns A 64-byte `Uint8Array` ready for `facade.createServiceListing`.
 * @throws TypeError when any tag is not lowercase-kebab.
 * @throws RangeError when the comma-joined encoding exceeds 64 bytes.
 *
 * @example
 * ```ts
 * const tags = encodeListingTags(["translation", "french-language"]);
 * decodeListingTags(tags); // ["translation", "french-language"]
 * ```
 */
export function encodeListingTags(tags: readonly string[]): Uint8Array {
  for (const tag of tags) {
    if (!LISTING_KEBAB_PATTERN.test(tag)) {
      throw new TypeError(
        `listing tags: ${JSON.stringify(tag)} is not lowercase-kebab ([a-z0-9]+(-[a-z0-9]+)*)`,
      );
    }
  }
  return encodeFixedUtf8(tags.join(","), LISTING_TAGS_BYTES, "listing tags");
}

/**
 * Decodes a 64-byte on-chain tags field back into the tag array: strips
 * trailing NUL padding, splits on commas, and validates each token against
 * the lowercase-kebab rule.
 *
 * @param bytes - Exactly 64 bytes of on-chain `ServiceListing.tags` data.
 * @returns The decoded tags; an empty array for an all-NUL field.
 * @throws RangeError when `bytes` is not exactly 64 bytes long.
 * @throws TypeError when any decoded token is not lowercase-kebab, or the
 *   bytes are not valid UTF-8.
 */
export function decodeListingTags(bytes: Uint8Array): string[] {
  const joined = decodeFixedUtf8(bytes, LISTING_TAGS_BYTES, "listing tags");
  if (joined === "") return [];
  const tags = joined.split(",");
  for (const tag of tags) {
    if (!LISTING_KEBAB_PATTERN.test(tag)) {
      throw new TypeError(
        `listing tags: on-chain token ${JSON.stringify(tag)} is not lowercase-kebab`,
      );
    }
  }
  return tags;
}
