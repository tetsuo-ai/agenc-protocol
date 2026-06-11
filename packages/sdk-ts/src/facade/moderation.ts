// Facade: ergonomic, named entry points over the generated client. Thin by design —
// the generated client already resolves PDAs and encodes data; the facade adds friendly
// signatures, defaults, and (for multi-PDA flows) bundling. Never import from generated/
// internals other than its public exports.
import type { Address } from "@solana/kit";
import {
  getConfigureTaskModerationInstructionAsync,
  getRecordTaskModerationInstructionAsync,
  getRecordListingModerationInstructionAsync,
  getAssignModerationAttestorInstructionAsync,
  getRevokeModerationAttestorInstructionAsync,
  findModerationConfigPda,
  findTaskModerationPda,
  findListingModerationPda,
  findModerationAttestorPda,
  type ConfigureTaskModerationAsyncInput,
  type RecordTaskModerationAsyncInput,
  type RecordListingModerationAsyncInput,
  type AssignModerationAttestorAsyncInput,
  type RevokeModerationAttestorAsyncInput,
} from "../generated/index.js";

export {
  findModerationConfigPda,
  findTaskModerationPda,
  findListingModerationPda,
  findModerationAttestorPda,
};

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

/**
 * Build an assign_moderation_attestor instruction (P6.8, authority-only).
 *
 * Adds `attestor` to the moderation-attestor roster so that wallet may record moderation
 * attestations (`recordTaskModeration` / `recordListingModeration`) in addition to the
 * single global moderation authority. The `moderationAttestor` roster PDA (seeded by
 * `attestor`), `moderationConfig`, and `systemProgram` all auto-derive in the generated
 * builder — the caller supplies only the `authority` signer and the `attestor` pubkey.
 *
 * Registry MECHANISM only: a curated roster adds deputies but does not by itself answer
 * the neutrality objection. See `docs/MODERATION_NEUTRALITY.md` (a [HUMAN] decision).
 */
export async function assignModerationAttestor(
  input: AssignModerationAttestorAsyncInput,
) {
  return getAssignModerationAttestorInstructionAsync(input);
}

/**
 * Build a revoke_moderation_attestor instruction (P6.8, authority-only).
 *
 * Removes a wallet from the moderation-attestor roster, closing its assignment PDA. The
 * generated builder does NOT derive the roster PDA (its on-chain seed reads the stored
 * `attestor`), so the facade derives it from the `attestor` pubkey when `moderationAttestor`
 * is not passed explicitly. moderationConfig still auto-derives.
 */
export async function revokeModerationAttestor(
  input: Omit<RevokeModerationAttestorAsyncInput, "moderationAttestor"> & {
    /** The roster member being removed. Used to derive the assignment PDA. */
    attestor?: Address;
    /** Optional pre-derived override for the assignment PDA. */
    moderationAttestor?: Address;
  },
) {
  const { attestor, moderationAttestor, ...rest } = input;
  let roster = moderationAttestor;
  if (!roster) {
    if (!attestor) {
      throw new Error(
        "revokeModerationAttestor: provide attestor (or moderationAttestor) so the roster PDA can be derived",
      );
    }
    roster = (await findModerationAttestorPda({ attestor }))[0];
  }
  return getRevokeModerationAttestorInstructionAsync({
    ...rest,
    moderationAttestor: roster,
  });
}
