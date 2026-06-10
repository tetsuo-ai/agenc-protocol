// Domain-value helpers (`values` module): random 32-byte protocol ids,
// WebCrypto SHA-256 + the NFC description-hash convention, LISTING_METADATA
// v1 fixed-width field codecs, and the kit-compatible `json-stable-v1`
// canonical job-spec hash. Everything here is browser-safe (no Node
// built-ins, no `Buffer`).

export { randomId32 } from "./random.js";
export { sha256, descriptionHash } from "./hash.js";
export {
  LISTING_NAME_BYTES,
  LISTING_CATEGORY_BYTES,
  LISTING_TAGS_BYTES,
  LISTING_KEBAB_PATTERN,
  encodeListingName,
  decodeListingName,
  encodeListingCategory,
  decodeListingCategory,
  encodeListingTags,
  decodeListingTags,
} from "./listing.js";
export {
  canonicalJobSpecJson,
  canonicalJobSpecHash,
  type CanonicalJobSpecHash,
} from "./job-spec.js";
export {
  LISTING_CATEGORIES,
  isListingCategory,
  type ListingCategory,
} from "./categories.js";
