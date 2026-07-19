// Facade: ergonomic, named entry points over the generated client. Thin by design —
// the generated client already resolves PDAs and encodes data; the facade adds friendly
// signatures, defaults, and (for multi-PDA flows) bundling. Never import from generated/
// internals other than its public exports.
import {
  getBytesEncoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  fixEncoderSize,
  type Address,
  type ProgramDerivedAddress,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  getConfigureTaskModerationInstructionAsync,
  getRecordTaskModerationInstructionAsync,
  getRecordListingModerationInstructionAsync,
  getAssignModerationAttestorInstructionAsync,
  getRevokeModerationAttestorInstructionAsync,
  getRegisterModerationAttestorInstructionAsync,
  getRequestAttestorExitInstruction,
  getFinalizeAttestorExitInstruction,
  getSetModerationBlockInstructionAsync,
  getClearModerationBlockInstructionAsync,
  getSetDefaultTrustListInstructionAsync,
  getModerationHeartbeatInstructionAsync,
  findModerationConfigPda,
  findTaskModerationPda,
  findListingModerationPda,
  findModerationAttestorPda,
  findModerationBlockPda,
  findDefaultTrustListPda,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  type ConfigureTaskModerationAsyncInput,
  type RecordTaskModerationAsyncInput,
  type RecordListingModerationAsyncInput,
  type AssignModerationAttestorAsyncInput,
  type RevokeModerationAttestorAsyncInput,
  type RegisterModerationAttestorAsyncInput,
  type RequestAttestorExitInput,
  type FinalizeAttestorExitInput,
  type SetModerationBlockAsyncInput,
  type ClearModerationBlockAsyncInput,
  type SetDefaultTrustListAsyncInput,
  type ModerationHeartbeatAsyncInput,
} from "../generated/index.js";

export {
  findModerationConfigPda,
  findTaskModerationPda,
  findListingModerationPda,
  findModerationAttestorPda,
  findModerationBlockPda,
  findDefaultTrustListPda,
};

/**
 * Derive the FROZEN pre-P1.2 task-moderation record PDA
 * `["task_moderation", task, jobSpecHash]`. Post-upgrade, `recordTaskModeration`
 * writes ONLY the v2 moderator-keyed seeds ({@link findTaskModerationPda}), but
 * the consumption gates (`setTaskJobSpec`) still accept records at this legacy
 * address during the grace window — pass it explicitly as `taskModeration` when
 * consuming a pre-upgrade record.
 */
export async function findLegacyTaskModerationPda(seeds: {
  task: Address;
  jobSpecHash: ReadonlyUint8Array;
}): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
    seeds: [
      getUtf8Encoder().encode("task_moderation"),
      getAddressEncoder().encode(seeds.task),
      fixEncoderSize(getBytesEncoder(), 32).encode(seeds.jobSpecHash),
    ],
  });
}

/**
 * Derive the FROZEN pre-P1.2 listing-moderation record PDA
 * `["listing_moderation", listing, jobSpecHash]`. Same grace-window role as
 * {@link findLegacyTaskModerationPda}, consumed by the hire gates via an
 * explicit `listingModeration` override.
 */
export async function findLegacyListingModerationPda(seeds: {
  listing: Address;
  jobSpecHash: ReadonlyUint8Array;
}): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
    seeds: [
      getUtf8Encoder().encode("listing_moderation"),
      getAddressEncoder().encode(seeds.listing),
      fixEncoderSize(getBytesEncoder(), 32).encode(seeds.jobSpecHash),
    ],
  });
}

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
 * v2 moderator-keyed taskModeration PDA (P1.2: seeded by `task` + `jobSpecHash` +
 * `moderator`, so each attestor owns an exclusive record slot) are auto-derived
 * when omitted; pass `task`, the `moderator` signer, and the moderation fields.
 * A registered (non-global-authority) attestor must also pass its
 * `moderationAttestor` roster PDA ({@link findModerationAttestorPda}).
 */
export async function recordTaskModeration(
  input: RecordTaskModerationAsyncInput,
) {
  return getRecordTaskModerationInstructionAsync(input);
}

/**
 * Build a record_listing_moderation instruction. The moderationConfig PDA and the
 * v2 moderator-keyed listingModeration PDA (P1.2: seeded by `listing` +
 * `jobSpecHash` + `moderator`) are auto-derived when omitted; pass `listing`, the
 * `moderator` signer, and the moderation fields. A registered
 * (non-global-authority) attestor must also pass its `moderationAttestor` roster
 * PDA ({@link findModerationAttestorPda}).
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
 * Build a revoke_moderation_attestor instruction (P6.8; P1.2: `assigned_by`-scoped —
 * the authority may revoke only the entries IT deputized, not self-registered ones,
 * which exit via {@link requestAttestorExit}/{@link finalizeAttestorExit}).
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

/**
 * Build a register_moderation_attestor instruction (P1.2 §4.2, PERMISSIONLESS).
 *
 * The `attestor` signer self-registers onto the open moderation-attestor roster,
 * paying rent AND the fixed registration bond onto its own roster PDA (seeded by
 * `attestor`; auto-derived). No authority approval is involved — anyone may
 * register; consumers choose which attestors to trust via edge trust lists. The
 * bond is refunded in full at {@link finalizeAttestorExit} (never confiscatable).
 * Registering an already-rostered wallet fails (`init`); re-registering after a
 * finalized exit re-inits a fresh entry.
 */
export type RegisterModerationAttestorInput =
  RegisterModerationAttestorAsyncInput;

export async function registerModerationAttestor(
  input: RegisterModerationAttestorInput,
) {
  return getRegisterModerationAttestorInstructionAsync(input);
}

/**
 * Build a request_attestor_exit instruction (P1.2 §4.5). Only the attestor
 * itself may start its exit; from this moment its records are rejected at BOTH
 * the record and consumption gates (the exit window closes at request, not
 * finalize). The on-chain roster PDA seed reads the stored `attestor`, so the
 * generated builder does not derive it; the facade derives it from the
 * `attestor` signer when `moderationAttestor` is not passed explicitly.
 */
export async function requestAttestorExit(
  input: Omit<RequestAttestorExitInput, "moderationAttestor"> & {
    /** Optional pre-derived override for the roster PDA. */
    moderationAttestor?: Address;
  },
) {
  const { moderationAttestor, ...rest } = input;
  const roster =
    moderationAttestor ??
    (await findModerationAttestorPda({ attestor: rest.attestor.address }))[0];
  return getRequestAttestorExitInstruction({
    ...rest,
    moderationAttestor: roster,
  });
}

/**
 * Build a finalize_attestor_exit instruction (P1.2 §4.5). After the exit
 * cooldown, closes the roster PDA and refunds ALL lamports on it (rent + the
 * registration bond) to the attestor — the full, non-confiscatable refund. Only
 * the attestor itself may finalize. The roster PDA derives from the `attestor`
 * signer when `moderationAttestor` is not passed explicitly.
 */
export async function finalizeAttestorExit(
  input: Omit<FinalizeAttestorExitInput, "moderationAttestor"> & {
    /** Optional pre-derived override for the roster PDA. */
    moderationAttestor?: Address;
  },
) {
  const { moderationAttestor, ...rest } = input;
  const roster =
    moderationAttestor ??
    (await findModerationAttestorPda({ attestor: rest.attestor.address }))[0];
  return getFinalizeAttestorExitInstruction({
    ...rest,
    moderationAttestor: roster,
  });
}

/**
 * Build a set_moderation_block instruction (P1.2 §5.2 BLOCK floor,
 * multisig-gated). Records a hard content takedown for `contentHash`: every
 * consumption gate (`setTaskJobSpec`, `hireFromListing`,
 * `hireFromListingHumanless`) derives `["moderation_block", hash]` in-handler
 * and rejects a blocked hash regardless of any CLEAN attestation presented. The
 * moderationBlock PDA auto-derives from `contentHash`; protocolConfig defaults
 * to its PDA. `rationaleHash`/`rationaleUri` commit the takedown rationale to
 * the on-chain audit trail.
 *
 * On-chain approval is the multisig threshold over `remaining_accounts`
 * (exactly like `update_protocol_fee`): the facade only builds the instruction —
 * append the co-signer accounts to `ix.accounts` and have them sign the
 * transaction.
 */
export async function setModerationBlock(input: SetModerationBlockAsyncInput) {
  return getSetModerationBlockInstructionAsync(input);
}

/**
 * Build a clear_moderation_block instruction (P1.2 §5.2, multisig-gated — same
 * `remaining_accounts` co-signer convention as {@link setModerationBlock}).
 * Lifts the takedown; the ModerationBlock account STAYS open as audit trail (a
 * cleared block can later be re-set at the same PDA). The on-chain PDA seed
 * reads the stored `content_hash`, so the generated builder does not derive it;
 * the facade derives it from `contentHash` when `moderationBlock` is not passed
 * explicitly.
 */
export async function clearModerationBlock(
  input: Omit<ClearModerationBlockAsyncInput, "moderationBlock"> & {
    /** The blocked content hash (32 bytes). Used to derive the block PDA. */
    contentHash?: ReadonlyUint8Array;
    /** Optional pre-derived override for the block PDA. */
    moderationBlock?: Address;
  },
) {
  const { contentHash, moderationBlock, ...rest } = input;
  let block = moderationBlock;
  if (!block) {
    if (!contentHash) {
      throw new Error(
        "clearModerationBlock: provide contentHash (or moderationBlock) so the block PDA can be derived",
      );
    }
    block = (await findModerationBlockPda({ contentHash }))[0];
  }
  return getClearModerationBlockInstructionAsync({
    ...rest,
    moderationBlock: block,
  });
}

/**
 * Build a set_default_trust_list instruction (P1.2 §5.1, multisig-gated — same
 * `remaining_accounts` co-signer convention as {@link setModerationBlock}).
 * Points the singleton `["default_trust_list"]` PDA (auto-derived;
 * `init_if_needed` so the first update creates it) at the published default
 * attestor trust list (`listHash` + `listUri`). ADVISORY defaults for surfaces —
 * consumption gates never read it; key-death freezes only these defaults, never
 * publishing (fail-open).
 */
export async function setDefaultTrustList(input: SetDefaultTrustListAsyncInput) {
  return getSetDefaultTrustListInstructionAsync(input);
}

/**
 * Build a moderation_heartbeat instruction (batch-2 A2, P1.3 moderation
 * liveness). The config authority or the moderation authority bumps the
 * deadman timestamp on `ModerationConfig` (PDA auto-derived); the config
 * authority may also retune the liveness window via `newWindowSecs`
 * (floored at 1 day on-chain — pass `none()` to leave it unchanged).
 *
 * Silence past the window relaxes the moderation ALLOW gates to
 * moderation-optional (docs/MODERATION_LIVENESS.md), so a censoring-by-
 * abandonment authority cannot freeze the marketplace; the multisig BLOCK
 * floor never relaxes.
 */
export async function moderationHeartbeat(input: ModerationHeartbeatAsyncInput) {
  return getModerationHeartbeatInstructionAsync(input);
}
