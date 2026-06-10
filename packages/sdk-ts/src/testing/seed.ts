// NODE-ONLY (see ./index.ts module doc): direct-injection seeding of the two
// config singletons. Their real initializers require an upgradeable
// ProgramData account that litesvm does not model, so the sandbox writes the
// accounts directly with the SDK's own generated encoders — the same approach
// the repo's e2e suites use.
import {
  address,
  lamports,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import type { LiteSVM } from "litesvm";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findModerationConfigPda,
  findProtocolConfigPda,
  getModerationConfigEncoder,
  getProtocolConfigEncoder,
} from "../generated/index.js";

const DEFAULT_ADDR = address("11111111111111111111111111111111");

function writeAccount(
  svm: LiteSVM,
  pda: Address,
  data: ReadonlyUint8Array,
): void {
  svm.setAccount({
    address: pda,
    data: data as Uint8Array,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
    space: BigInt(data.length),
  });
}

/** Tunable knobs for {@link seedProtocolConfig}. */
export interface SeedProtocolConfigOptions {
  /** Minimum arbiter stake (lamports). Defaults to `0n`. */
  minArbiterStake?: bigint;
}

/**
 * Seed the `ProtocolConfig` singleton directly (rent-exempt, program-owned),
 * using the SDK's generated encoder. `authority` and `treasury` are both set
 * to `admin`; fees 100 bps, dispute threshold 50, no cooldowns or rate limits,
 * protocol live (not paused), version 1.
 *
 * @param svm - The litesvm VM to write into.
 * @param admin - Address installed as protocol authority AND treasury.
 * @param opts - Optional overrides (e.g. `minArbiterStake`).
 * @returns The `ProtocolConfig` PDA address.
 */
export async function seedProtocolConfig(
  svm: LiteSVM,
  admin: Address,
  opts: SeedProtocolConfigOptions = {},
): Promise<Address> {
  const [pda, bump] = await findProtocolConfigPda();
  const data = getProtocolConfigEncoder().encode({
    authority: admin,
    treasury: admin,
    disputeThreshold: 50,
    protocolFeeBps: 100,
    minArbiterStake: opts.minArbiterStake ?? 0n,
    minAgentStake: 0n,
    maxClaimDuration: 604800n,
    maxDisputeDuration: 604800n,
    totalAgents: 0n,
    totalTasks: 0n,
    completedTasks: 0n,
    totalValueDistributed: 0n,
    bump,
    multisigThreshold: 0,
    multisigOwnersLen: 0,
    taskCreationCooldown: 0n,
    maxTasksPer24h: 0,
    disputeInitiationCooldown: 0n,
    maxDisputesPer24h: 0,
    minStakeForDispute: 0n,
    slashPercentage: 50,
    stateUpdateCooldown: 0n,
    votingPeriod: 86400n,
    protocolVersion: 1,
    minSupportedVersion: 1,
    protocolPaused: false,
    disabledTaskTypeMask: 0,
    multisigOwners: [
      DEFAULT_ADDR,
      DEFAULT_ADDR,
      DEFAULT_ADDR,
      DEFAULT_ADDR,
      DEFAULT_ADDR,
    ],
  });
  writeAccount(svm, pda, data);
  return pda;
}

/**
 * Seed the `ModerationConfig` singleton directly (the hire/moderation paths
 * require it to exist), using the SDK's generated encoder.
 *
 * @param svm - The litesvm VM to write into.
 * @param admin - Address installed as the config authority.
 * @param moderationAuthority - The signer allowed to record attestations.
 * @param enabled - Whether the fail-closed moderation gate is on. Defaults to
 * `true` (matching mainnet posture — attestations are then REQUIRED before
 * hire/claim).
 * @returns The `ModerationConfig` PDA address.
 */
export async function seedModerationConfig(
  svm: LiteSVM,
  admin: Address,
  moderationAuthority: Address,
  enabled = true,
): Promise<Address> {
  const [pda, bump] = await findModerationConfigPda();
  const data = getModerationConfigEncoder().encode({
    authority: admin,
    moderationAuthority,
    enabled,
    createdAt: 0n,
    updatedAt: 0n,
    bump,
    reserved: new Uint8Array(6),
  });
  writeAccount(svm, pda, data);
  return pda;
}
