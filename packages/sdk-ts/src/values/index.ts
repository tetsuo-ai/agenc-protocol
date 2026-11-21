// Domain-value helpers (`values` module): random 32-byte protocol ids,
// WebCrypto SHA-256 + the NFC description-hash convention, LISTING_METADATA
// v1 fixed-width field codecs, the kit-compatible `json-stable-v1` canonical
// job-spec hash, and the AGENT_METADATA v1 identity validator/renderer.
// Everything here is browser-safe (no Node built-ins, no `Buffer`).

export { randomId32 } from "./random.js";
export {
  DISPUTE_SAFE_MAX_WORKERS,
  CLAIM_DEPOSIT_BPS,
  MIN_CLAIM_DEPOSIT_LAMPORTS,
  DISPUTE_BOND_BPS,
  MIN_DISPUTE_BOND_LAMPORTS,
  CLAIM_RELEASE_GRACE_SECS,
  REJECT_DISPUTE_WINDOW_SECS,
  REJECT_RULING_WINDOW_SECS,
  MIN_RESUBMIT_WINDOW_SECS,
  MAX_REVIEW_WINDOW_SECS,
  assertCreatorReviewWindow,
  FREEZE_KIND_DISPUTABLE,
  SUBMISSION_FREEZE_KIND_INDEX,
  workerShareLamports,
  claimDepositLamports,
  claimDepositForTask,
  disputeBondLamports,
  disputeBondForTask,
  submissionFreezeKind,
  isDisputableFreeze,
  type WorkerShareTask,
} from "./protocol-limits.js";
export {
  snapshotByteArray,
  snapshotFixedBytes,
  snapshotOptionalFixedBytes,
} from "./fixed-bytes.js";
export {
  snapshotOptionOrNullable,
  snapshotOptionalAddress,
  type ExplicitOption,
} from "./options.js";
export {
  assertNoReachableSharedMemory,
  snapshotStructuredClone,
} from "./structured-clone.js";
export {
  assertCanonicalHash32,
  sha256,
  descriptionHash,
  bytesToHex,
  hexToBytes,
} from "./hash.js";
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
  STORE_HANDLE_BYTES,
  STORE_HANDLE_MIN_LEN,
  STORE_HANDLE_MAX_LEN,
  STORE_HANDLE_PATTERN,
  encodeStoreHandle,
  decodeStoreHandle,
} from "./store.js";
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
export {
  AGENT_METADATA_VERSION,
  AGENT_METADATA_SCHEMA_ID,
  validateAgentMetadata,
  renderAgentMetadata,
  type AgentMetadata,
  type AgentContact,
  type AgentMetadataError,
  type AgentMetadataResult,
  type AgentMetadataView,
} from "./agent-metadata.js";
