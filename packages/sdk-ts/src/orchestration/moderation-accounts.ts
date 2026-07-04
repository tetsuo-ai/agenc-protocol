/**
 * Resolve the P1.2 moderation accounts a consumption gate needs.
 *
 * Post-P1.2 (open roster) every consumption gate — `set_task_job_spec` for
 * activation, `hire_from_listing`/`hire_from_listing_humanless` for hires —
 * names an explicit `moderator` whose attestation it consumes, and the
 * moderation record lives at the v2 moderator-keyed seeds
 * (`["task_moderation_v2", task, hash, moderator]` / the listing mirror). The
 * caller supplies WHO to trust (the `moderator` — reading it from their
 * attestation service, e.g. attest.agenc.ag `GET /v1/info`); these helpers
 * resolve the MECHANICS:
 *
 * - the roster-entry PDA (`["moderation_attestor", moderator]`) the gate
 *   requires whenever the moderator is a registered attestor rather than the
 *   global `moderation_authority`;
 * - the legacy grace window: when no v2 record exists but a PRE-upgrade record
 *   authored by the SAME moderator sits at the frozen legacy seeds, the gate
 *   still accepts it if the transaction points at it explicitly — so the
 *   resolver returns that record override.
 *
 * Any resolution failure degrades to "no overrides" — the program stays the
 * enforcement point; a read hiccup must never make the flow MORE broken than
 * not resolving at all.
 *
 * (This is the SDK home of the logic `marketplace-react`'s
 * `hooks/moderation-attestor` introduced; the plain-TS orchestration in
 * `hireAndActivate` composes it without React.)
 *
 * @module orchestration/moderation-accounts
 */
import { createSolanaRpc, type Address } from "@solana/kit";
import {
  fetchMaybeListingModeration,
  fetchMaybeModerationAttestor,
  fetchMaybeModerationConfig,
  fetchMaybeTaskModeration,
  findListingModerationPda,
  findModerationAttestorPda,
  findModerationConfigPda,
  findTaskModerationPda,
} from "../generated/index.js";
import * as facade from "../facade/index.js";

/** The account-read slice of a kit RPC that the resolvers need. */
export type ModerationAccountReadRpc = Parameters<
  typeof fetchMaybeTaskModeration
>[0];

/** The job-spec hash exactly as the moderation-record PDA seeds accept it. */
type JobSpecHashSeed = Parameters<typeof findTaskModerationPda>[0]["jobSpecHash"];

/** Moderation accounts resolved for a task activation (`set_task_job_spec`). */
export interface ActivationModerationAccounts {
  /** Roster-entry PDA to attach, absent on the global-authority path. */
  moderationAttestor?: Address;
  /**
   * Explicit record override — set only when the attestation predates the
   * P1.2 upgrade and lives at the frozen legacy seeds (grace window).
   */
  taskModeration?: Address;
}

/** Moderation accounts resolved for a hire (`hire_from_listing*`). */
export interface HireListingModerationAccounts {
  /** Roster-entry PDA to attach, absent on the global-authority path. */
  moderationAttestor?: Address;
  /**
   * Explicit record override — set only when the attestation predates the
   * P1.2 upgrade and lives at the frozen legacy seeds (grace window).
   */
  listingModeration?: Address;
}

function readRpc(input: {
  rpcUrl?: string | null;
  rpc?: ModerationAccountReadRpc;
}): ModerationAccountReadRpc | null {
  return (
    input.rpc ??
    (input.rpcUrl
      ? (createSolanaRpc(input.rpcUrl) as unknown as ModerationAccountReadRpc)
      : null)
  );
}

/**
 * Roster vs global-authority: return the `["moderation_attestor", moderator]`
 * roster PDA to attach, or `undefined` when the moderator IS the global
 * moderation authority (the gate's authority branch needs no roster account).
 *
 * The roster PDA is attached ONLY when the entry verifiably exists on-chain:
 * a set-but-uninitialized optional account fails the gate harder than
 * attaching nothing (`AccountNotInitialized` vs the authority branch), so an
 * unreadable/absent entry degrades to "no account" — callers on an exotic
 * setup can still force the roster path with `moderatorIsAttestor`.
 */
async function resolveRosterEntry(
  rpc: ModerationAccountReadRpc,
  moderator: Address,
): Promise<Address | undefined> {
  const [moderationConfigPda] = await findModerationConfigPda();
  const moderationConfig = await fetchMaybeModerationConfig(
    rpc,
    moderationConfigPda,
  );
  if (
    moderationConfig.exists &&
    moderationConfig.data.moderationAuthority === moderator
  ) {
    return undefined;
  }
  const [rosterPda] = await findModerationAttestorPda({ attestor: moderator });
  const roster = await fetchMaybeModerationAttestor(rpc, rosterPda);
  return roster.exists ? rosterPda : undefined;
}

/**
 * Resolve the moderation accounts to attach to `set_task_job_spec`, given the
 * `moderator` whose attestation the activation consumes.
 *
 * @param input.rpcUrl - HTTP RPC endpoint used for the account reads.
 * @param input.task - The task PDA being activated.
 * @param input.jobSpecHash - The 32-byte canonical job-spec hash.
 * @param input.moderator - The attestation signer the gate should consume
 * (e.g. the attestation service's `moderator` from `GET /v1/info`).
 * @param input.rpc - A pre-built account-read RPC; wins over `rpcUrl`.
 */
export async function resolveActivationModerationAccounts(input: {
  rpcUrl?: string | null;
  task: Address;
  jobSpecHash: JobSpecHashSeed;
  moderator: Address;
  rpc?: ModerationAccountReadRpc;
}): Promise<ActivationModerationAccounts> {
  try {
    const rpc = readRpc(input);
    if (!rpc) return {};

    const moderationAttestor = await resolveRosterEntry(rpc, input.moderator);
    const attestorPart =
      moderationAttestor !== undefined ? { moderationAttestor } : {};

    // Prefer the v2 moderator-keyed record (what recordTaskModeration writes
    // post-upgrade); the facade derives it by default, so no override needed.
    const [v2Pda] = await findTaskModerationPda({
      task: input.task,
      jobSpecHash: input.jobSpecHash,
      moderator: input.moderator,
    });
    const v2 = await fetchMaybeTaskModeration(rpc, v2Pda);
    if (v2.exists) return attestorPart;

    // Grace window: a pre-upgrade record at the frozen legacy seeds is still
    // consumable when the transaction points at it explicitly AND it was
    // authored by the same moderator the gate is told to consume.
    const [legacyPda] = await facade.findLegacyTaskModerationPda({
      task: input.task,
      jobSpecHash: input.jobSpecHash,
    });
    const legacy = await fetchMaybeTaskModeration(rpc, legacyPda);
    if (legacy.exists && legacy.data.moderator === input.moderator) {
      return { ...attestorPart, taskModeration: legacyPda };
    }

    return attestorPart;
  } catch {
    // Degrade to "no overrides" — never block the flow on a read failure.
    return {};
  }
}

/**
 * Resolve the moderation accounts to attach to a hire
 * (`hire_from_listing` / `hire_from_listing_humanless`), given the
 * `moderator` whose listing attestation the hire gate should consume.
 *
 * @param input.rpcUrl - HTTP RPC endpoint used for the account reads.
 * @param input.listing - The ServiceListing PDA being hired.
 * @param input.listingSpecHash - The listing's pinned 32-byte `spec_hash`.
 * @param input.moderator - The attestation signer the gate should consume.
 * @param input.rpc - A pre-built account-read RPC; wins over `rpcUrl`.
 */
export async function resolveHireListingModerationAccounts(input: {
  rpcUrl?: string | null;
  listing: Address;
  listingSpecHash: JobSpecHashSeed;
  moderator: Address;
  rpc?: ModerationAccountReadRpc;
}): Promise<HireListingModerationAccounts> {
  try {
    const rpc = readRpc(input);
    if (!rpc) return {};

    const moderationAttestor = await resolveRosterEntry(rpc, input.moderator);
    const attestorPart =
      moderationAttestor !== undefined ? { moderationAttestor } : {};

    const [v2Pda] = await findListingModerationPda({
      listing: input.listing,
      jobSpecHash: input.listingSpecHash,
      moderator: input.moderator,
    });
    const v2 = await fetchMaybeListingModeration(rpc, v2Pda);
    if (v2.exists) return attestorPart;

    const [legacyPda] = await facade.findLegacyListingModerationPda({
      listing: input.listing,
      jobSpecHash: input.listingSpecHash,
    });
    const legacy = await fetchMaybeListingModeration(rpc, legacyPda);
    if (legacy.exists && legacy.data.moderator === input.moderator) {
      return { ...attestorPart, listingModeration: legacyPda };
    }

    return attestorPart;
  } catch {
    // Degrade to "no overrides" — never block the flow on a read failure.
    return {};
  }
}
