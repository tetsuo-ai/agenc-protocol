// Facade: ergonomic, named entry points over the generated client. Thin by design —
// the generated client already resolves PDAs and encodes data; the facade adds friendly
// signatures, defaults, and (for multi-PDA flows) bundling. Never import from generated/
// internals other than its public exports.
import {
  getConfigureTaskModerationInstructionAsync,
  getRecordTaskModerationInstructionAsync,
  getRecordListingModerationInstructionAsync,
  findModerationConfigPda,
  findTaskModerationPda,
  findListingModerationPda,
  type ConfigureTaskModerationAsyncInput,
  type RecordTaskModerationAsyncInput,
  type RecordListingModerationAsyncInput,
} from "../generated/index.js";

export { findModerationConfigPda, findTaskModerationPda, findListingModerationPda };

/**
 * Build a configure_task_moderation instruction. The protocolConfig and moderationConfig
 * PDAs are auto-derived when omitted; only `authority` (signer), `moderationAuthority`,
 * and `enabled` are required.
 */
export async function configureTaskModeration(
  input: ConfigureTaskModerationAsyncInput,
) {
  return getConfigureTaskModerationInstructionAsync(input);
}

/**
 * Build a record_task_moderation instruction. The moderationConfig PDA and the
 * per-task taskModeration PDA (seeded by `task` + `jobSpecHash`) are auto-derived when
 * omitted; pass `task`, the `moderator` signer, and the moderation fields.
 */
export async function recordTaskModeration(
  input: RecordTaskModerationAsyncInput,
) {
  return getRecordTaskModerationInstructionAsync(input);
}

/**
 * Build a record_listing_moderation instruction. The moderationConfig PDA and the
 * per-listing listingModeration PDA (seeded by `listing` + `jobSpecHash`) are auto-derived
 * when omitted; pass `listing`, the `moderator` signer, and the moderation fields.
 */
export async function recordListingModeration(
  input: RecordListingModerationAsyncInput,
) {
  return getRecordListingModerationInstructionAsync(input);
}
