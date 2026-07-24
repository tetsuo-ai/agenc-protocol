// Facade: P6.5 surface-versioning contract.
//
// One program ID historically served the restricted 25-instruction canary surface on
// mainnet and the full surface on dev/devnet. Mainnet is live on the revision-5
// 101-instruction deployment; this source tree contains the revision-6
// 103-instruction direct-assignment candidate.
// `getDeployedSurface` lets a client ask, against a live RPC, WHICH surface a given
// cluster actually exposes — so the facade/client can fail-closed (throw
// `SurfaceNotDeployedError`) before building a transaction that calls an instruction
// the deployed program does not have.
//
// CRITICAL TOLERANCE REQUIREMENT (do not "simplify" away):
// A pre-migration `ProtocolConfig` can use the PRE-P6.5 layout (349 bytes, no
// `surface_revision`). The generated `getProtocolConfigDecoder()` is a FIXED-size
// decoder for the new 351-byte layout and THROWS on the 349-byte account. So this
// module never feeds the old account through the generated codec — it reads the raw
// bytes and decodes `surface_revision` by hand, treating an account shorter than the
// new layout (or a missing account) as `surface_revision = 0` (= "unstamped /
// conservative"). On an old-layout account this returns `listings: false`
// WITHOUT throwing.
import { fetchEncodedAccount, getU16Decoder, type Address } from "@solana/kit";
import {
  findProtocolConfigPda,
  getStampReleaseSurfaceInstructionAsync,
  type StampReleaseSurfaceAsyncInput,
} from "../generated/index.js";
import { snapshotFixedBytes } from "../values/fixed-bytes.js";
import type { MultisigSignersInput } from "./governance.js";
import {
  appendMultisigSignerMetas,
  snapshotMultisigFacadeInput,
} from "./wire.js";

/**
 * Byte offset of the appended `surface_revision: u16` in the P6.5 `ProtocolConfig`
 * layout. The pre-P6.5 account is exactly {@link OLD_PROTOCOL_CONFIG_SIZE} bytes, and
 * `surface_revision` is the only field appended after it — so it lives at bytes
 * `[OLD_PROTOCOL_CONFIG_SIZE, NEW_PROTOCOL_CONFIG_SIZE)`.
 */
export const SURFACE_REVISION_OFFSET = 349;

/** On-chain byte size of the pre-P6.5 `ProtocolConfig` (no `surface_revision`). */
export const OLD_PROTOCOL_CONFIG_SIZE = 349;

/** On-chain byte size of the P6.5 `ProtocolConfig` (with `surface_revision: u16`). */
export const NEW_PROTOCOL_CONFIG_SIZE = 351;

/**
 * `surface_revision` value meaning "the full surface stamp is live" (historical
 * Phase-9 84-ix surface; later additive batches keep or raise the stamp).
 * Mirrors the on-chain `ProtocolConfig::SURFACE_REVISION_FULL`. `0` means the surface
 * is unstamped — treated as the conservative canary surface.
 */
export const SURFACE_REVISION_FULL = 1;

/**
 * `surface_revision` value meaning "the batch-4 GOODS market is live". Mirrors
 * the on-chain `ProtocolConfig::SURFACE_REVISION_BATCH4`. Unlike the other
 * capabilities (present since `SURFACE_REVISION_FULL`), the goods market is the
 * FIRST revision-gated capability: the on-chain handlers require
 * `surface_revision >= 4` (`require_goods_enabled`), so the SDK must NOT
 * advertise `goods` below revision 4.
 */
export const SURFACE_REVISION_BATCH4 = 4;

/**
 * Audit-hardening release revision. Mainnet's 101-instruction production inventory
 * includes stricter remaining-account conventions on existing instructions.
 * Mirrors `ProtocolConfig::SURFACE_REVISION_AUDIT_HARDENING` on-chain.
 */
export const SURFACE_REVISION_AUDIT_HARDENING = 5;

/**
 * Bilateral direct-assignment release revision. This is the first revision
 * whose program contains the creator-and-worker co-signed assignment rail.
 */
export const SURFACE_REVISION_DIRECT_ASSIGNMENT = 6;

/** Highest surface revision understood by this SDK build. */
export const SURFACE_REVISION_CURRENT = SURFACE_REVISION_DIRECT_ASSIGNMENT;

/**
 * Reviewed release evidence plus the current ProtocolConfig approval set.
 * The five hashes are detached before PDA derivation can yield so a caller
 * cannot change the release evidence while the instruction is being built.
 */
export type StampReleaseSurfaceInput = StampReleaseSurfaceAsyncInput &
  MultisigSignersInput;

/**
 * Build `stamp_release_surface` with the current ProtocolConfig M-of-N approval.
 *
 * The named authority, the complete input record, every fixed-width release
 * commitment, and the approval array are stabilized synchronously before the
 * generated async builder derives any default PDA. Approval signers are
 * appended in the remaining-account suffix consumed by the on-chain threshold
 * check.
 */
export async function stampReleaseSurface(input: StampReleaseSurfaceInput) {
  const { generatedInput, multisigSigners } = snapshotMultisigFacadeInput(
    input,
    ["authority"],
  );
  const stableGeneratedInput: StampReleaseSurfaceAsyncInput = {
    ...generatedInput,
    expectedProtocolConfigHash: snapshotFixedBytes(
      generatedInput.expectedProtocolConfigHash,
      32,
      "stampReleaseSurface: expectedProtocolConfigHash",
    ),
    expectedBidConfigHash: snapshotFixedBytes(
      generatedInput.expectedBidConfigHash,
      32,
      "stampReleaseSurface: expectedBidConfigHash",
    ),
    expectedModerationConfigHash: snapshotFixedBytes(
      generatedInput.expectedModerationConfigHash,
      32,
      "stampReleaseSurface: expectedModerationConfigHash",
    ),
    expectedIdlAccountHash: snapshotFixedBytes(
      generatedInput.expectedIdlAccountHash,
      32,
      "stampReleaseSurface: expectedIdlAccountHash",
    ),
    expectedCustodyAccountHash: snapshotFixedBytes(
      generatedInput.expectedCustodyAccountHash,
      32,
      "stampReleaseSurface: expectedCustodyAccountHash",
    ),
  };
  const instruction =
    await getStampReleaseSurfaceInstructionAsync(stableGeneratedInput);
  return appendMultisigSignerMetas(instruction, multisigSigners);
}

/**
 * A typed capability set describing which instruction families a deployed cluster
 * actually exposes. Conservative-by-default: an unstamped / old-layout account yields
 * every capability `false`.
 */
export type CapabilitySet = {
  /** The raw on-chain `surface_revision` (0 = unstamped/canary). */
  readonly surfaceRevision: number;
  /** Whether the program advertises the full surface (`surface_revision >= 1`). */
  readonly fullSurface: boolean;
  /** Service listings + hire-from-listing instructions (full surface only). */
  readonly listings: boolean;
  /** Dispute lifecycle instructions (full surface only). */
  readonly disputes: boolean;
  /** Completion-bond instructions (full surface only). */
  readonly bonds: boolean;
  /** Demand-side referral-fee snapshotting (full surface only). */
  readonly referrals: boolean;
  /** Governance proposal/vote instructions (full surface only). */
  readonly governance: boolean;
  /** Skill registry instructions (full surface only). */
  readonly skills: boolean;
  /** Reputation staking/delegation instructions (full surface only). */
  readonly reputation: boolean;
  /** On-chain bid-marketplace instructions (full surface only). */
  readonly bids: boolean;
  /** Rivalrous goods-market instructions (batch 4 — requires `surface_revision >= 4`). */
  readonly goods: boolean;
  /** Bilateral creator-and-worker task assignment (requires revision 6). */
  readonly directAssignment: boolean;
};

/** The conservative capability set: the canary / unstamped / old-layout surface. */
function canarySurface(surfaceRevision: number): CapabilitySet {
  return {
    surfaceRevision,
    fullSurface: false,
    listings: false,
    disputes: false,
    bonds: false,
    referrals: false,
    governance: false,
    skills: false,
    reputation: false,
    bids: false,
    goods: false,
    directAssignment: false,
  };
}

/** The full capability set. `goods` is revision-gated (batch 4) — it is the one
 * capability NOT implied by `fullSurface`; it needs `surface_revision >= 4`. */
function fullSurface(surfaceRevision: number): CapabilitySet {
  return {
    surfaceRevision,
    fullSurface: true,
    listings: true,
    disputes: true,
    bonds: true,
    referrals: true,
    governance: true,
    skills: true,
    reputation: true,
    bids: true,
    goods: surfaceRevision >= SURFACE_REVISION_BATCH4,
    directAssignment: surfaceRevision >= SURFACE_REVISION_DIRECT_ASSIGNMENT,
  };
}

/**
 * Map a raw `surface_revision` to a typed {@link CapabilitySet}. `SURFACE_REVISION_FULL`
 * (or any higher known value) → full surface; anything else (including `0` = unstamped)
 * → the conservative canary surface.
 *
 * @param surfaceRevision - the raw on-chain u16.
 */
export function capabilitiesForRevision(
  surfaceRevision: number,
): CapabilitySet {
  return surfaceRevision >= SURFACE_REVISION_FULL &&
    surfaceRevision <= SURFACE_REVISION_CURRENT
    ? fullSurface(surfaceRevision)
    : canarySurface(surfaceRevision);
}

/**
 * Read `surface_revision` out of a raw `ProtocolConfig` account buffer, tolerating the
 * pre-P6.5 (349-byte) layout. Returns `0` when the buffer is too short to contain the
 * appended field (the old layout) — NEVER throws on a short buffer.
 *
 * Exported (and pure) so it can be unit-tested with a hand-built old-size buffer.
 *
 * @param data - the raw account data bytes.
 */
export function readSurfaceRevision(data: Uint8Array): number {
  // Old layout (or any buffer that does not reach the appended u16): unstamped.
  if (data.length < SURFACE_REVISION_OFFSET + 2) {
    return 0;
  }
  return getU16Decoder().decode(data, SURFACE_REVISION_OFFSET);
}

/**
 * Query a live RPC for the deployed instruction surface of the agenc-coordination
 * program on that cluster.
 *
 * Tolerates EVERY pre-migration shape without throwing:
 * - the account is the OLD 349-byte layout (a historical/pre-migration deployment) →
 *   `surface_revision = 0` → returns the conservative surface (`listings: false`);
 * - the account does not exist at all (mis-pointed RPC / wrong program) →
 *   `surface_revision = 0` → conservative surface;
 * - the account is the new 351-byte layout with `surface_revision` stamped → the
 *   corresponding capability set (full surface when stamped to
 *   {@link SURFACE_REVISION_FULL}).
 *
 * @param rpc - a `@solana/kit` RPC (anything `fetchEncodedAccount` accepts).
 * @param options - optional `programAddress` override (defaults to the canonical
 * agenc-coordination program), used to derive the `ProtocolConfig` PDA.
 * @returns the typed {@link CapabilitySet} for the cluster behind `rpc`.
 *
 * @example
 * ```ts
 * const surface = await getDeployedSurface(rpc);
 * if (!surface.listings) {
 *   // hire-from-listing is not live on this cluster; do not build that tx.
 * }
 * ```
 */
export async function getDeployedSurface(
  rpc: Parameters<typeof fetchEncodedAccount>[0],
  options: { programAddress?: Address } = {},
): Promise<CapabilitySet> {
  const [protocolConfigPda] = await findProtocolConfigPda(
    options.programAddress ? { programAddress: options.programAddress } : {},
  );
  const account = await fetchEncodedAccount(rpc, protocolConfigPda);
  // A missing account is treated conservatively (NOT an error): a client probing an
  // un-initialized or wrong cluster should fail-closed, not crash.
  const revision = account.exists ? readSurfaceRevision(account.data) : 0;
  return capabilitiesForRevision(revision);
}

/**
 * Thrown by facade/client methods that need a capability the deployed surface does not
 * expose. Carries the missing capability name and the cluster's {@link CapabilitySet}
 * so callers can branch / surface an actionable message instead of letting a raw
 * "instruction not found" transaction failure bubble up.
 */
export class SurfaceNotDeployedError extends Error {
  /** The capability the caller required (e.g. `"listings"`). */
  readonly capability: keyof CapabilitySet;
  /** The full deployed capability set at the time of the check. */
  readonly surface: CapabilitySet;

  /**
   * @param capability - the required capability that is not deployed.
   * @param surface - the deployed capability set.
   */
  constructor(capability: keyof CapabilitySet, surface: CapabilitySet) {
    super(
      `Capability "${String(capability)}" is not deployed on this cluster ` +
        `(surface_revision=${surface.surfaceRevision}). The agenc-coordination ` +
        `program here exposes only the conservative canary surface; this ` +
        `instruction family is not available.`,
    );
    this.name = "SurfaceNotDeployedError";
    this.capability = capability;
    this.surface = surface;
  }
}

/**
 * Assert that a specific boolean capability is live on the deployed surface, throwing
 * {@link SurfaceNotDeployedError} early if it is not. Facade/client methods that build
 * a full-surface-only instruction call this first so they fail-closed against an
 * old-layout / canary cluster with a clear, structured error.
 *
 * @param surface - a {@link CapabilitySet} (typically from {@link getDeployedSurface}).
 * @param capability - the boolean capability to require.
 */
export function assertCapability(
  surface: CapabilitySet,
  capability: Exclude<keyof CapabilitySet, "surfaceRevision">,
): void {
  if (surface[capability] !== true) {
    throw new SurfaceNotDeployedError(capability, surface);
  }
}
