/**
 * Resolve the OPTIONAL `moderation_attestor` roster account for task
 * activation (WP-A1).
 *
 * Post-A1 the on-chain publish gate (`set_task_job_spec`) accepts a task
 * moderation authored by a registered roster `ModerationAttestor` — but ONLY
 * when the transaction attaches that attestor's roster-entry PDA. Without it
 * the gate falls back to requiring `task_moderation.moderator ==
 * moderation_config.moderation_authority`, so a roster-attested task (the
 * default when the activation backend uses the public attestation service)
 * fails with `UNAUTHORIZED_TASK_MODERATOR` even though the attestation is
 * valid.
 *
 * This helper reads the recorded `TaskModeration`, compares its stored
 * moderator against the global moderation authority, and returns the roster
 * PDA exactly when they differ. Any resolution failure returns `undefined`,
 * degrading to the pre-resolution behavior — the program stays the
 * enforcement point; a read hiccup must never make activation MORE broken
 * than not resolving at all.
 *
 * @module hooks/moderation-attestor
 */
import { createSolanaRpc } from "@solana/kit";
import {
  fetchMaybeModerationConfig,
  fetchMaybeTaskModeration,
  findModerationAttestorPda,
  findModerationConfigPda,
  findTaskModerationPda,
} from "@tetsuo-ai/marketplace-sdk";
import type { Address } from "../types.js";

/** The account-read slice of a kit RPC that the resolver needs. */
type AccountReadRpc = Parameters<typeof fetchMaybeTaskModeration>[0];

/** The job-spec hash exactly as the TaskModeration PDA seeds accept it. */
type JobSpecHashSeed = Parameters<typeof findTaskModerationPda>[0]["jobSpecHash"];

/**
 * Resolve the roster-attestor account to attach to `set_task_job_spec`, or
 * `undefined` when none is needed (global-authority moderation, missing
 * moderation record, or no read endpoint).
 *
 * @param input.rpcUrl - Resolved HTTP RPC endpoint (from provider context).
 * @param input.task - The task PDA being activated.
 * @param input.jobSpecHash - The 32-byte canonical job-spec hash (seeds the
 * `TaskModeration` PDA together with `task`).
 * @param input.rpc - Test seam: a pre-built account-read RPC wins over
 * `rpcUrl`.
 */
export async function resolveActivationModerationAttestor(input: {
  rpcUrl: string | null;
  task: Address;
  jobSpecHash: JobSpecHashSeed;
  rpc?: AccountReadRpc;
}): Promise<Address | undefined> {
  try {
    const rpc =
      input.rpc ??
      (input.rpcUrl
        ? (createSolanaRpc(input.rpcUrl) as unknown as AccountReadRpc)
        : null);
    if (!rpc) return undefined;

    const [taskModerationPda] = await findTaskModerationPda({
      task: input.task,
      jobSpecHash: input.jobSpecHash,
    });
    const taskModeration = await fetchMaybeTaskModeration(
      rpc,
      taskModerationPda,
    );
    if (!taskModeration.exists) return undefined;

    const [moderationConfigPda] = await findModerationConfigPda();
    const moderationConfig = await fetchMaybeModerationConfig(
      rpc,
      moderationConfigPda,
    );
    if (
      moderationConfig.exists &&
      taskModeration.data.moderator ===
        moderationConfig.data.moderationAuthority
    ) {
      // Global-authority moderation: the gate needs no roster account.
      return undefined;
    }

    const [rosterPda] = await findModerationAttestorPda({
      attestor: taskModeration.data.moderator,
    });
    return rosterPda;
  } catch {
    // Degrade to "no account attached" — never block activation on a read
    // failure; the on-chain gate remains the enforcement point.
    return undefined;
  }
}
