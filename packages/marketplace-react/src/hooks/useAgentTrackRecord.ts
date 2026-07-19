/**
 * `useAgentTrackRecord(agentPda)` — provider reputation hook (PARTIAL, P6.6).
 *
 * Reads the indexer's reconstructed track record for an agent and projects the
 * `{ completionRate, disputeRate, slashHistory, recentOutcomes }` contract.
 *
 * ## P6.6 scope (honest about what is and isn't available)
 *
 * The v1 indexer record (`IndexerAgentTrackRecord`) is event-reconstructed and
 * exposes raw COUNTS: `completions`, `disputesInitiated`, `disputesLost`, and a
 * `slashHistory`. It does NOT yet expose the denominators a true RATE needs
 * (total tasks taken, total disputes faced) — that aggregation lands in
 * PLAN.md P6.6. So:
 * - `slashHistory` and the dispute COUNTS are real today (passed through);
 * - `completionRate` / `disputeRate` are RATIOS and are only meaningful once a
 *   denominator exists. Today they are computed from the available counts where
 *   a denominator is inferable (completions vs. completions+disputesLost as a
 *   conservative proxy) and otherwise `null`. Treat them as provisional until
 *   P6.6. The `partial` flag is the audit signal — `true` today.
 * - `recentOutcomes` is reconstructed from `slashHistory` (the only per-event
 *   stream in v1); a richer outcome feed lands with P6.6.
 *
 * Indexer-native: the gPA fallback has no aggregated track record, so under it
 * `read.agentTrackRecord` throws `ReadTransportUnsupportedError` and this hook
 * surfaces that error (a track record is not reconstructable trustlessly).
 *
 * @module hooks/useAgentTrackRecord
 */
import { useQuery } from "@tanstack/react-query";
import { useAgencContext } from "../provider/context.js";
import type { Address, IndexerAgentTrackRecord } from "../types.js";
import { pdaKey, queryKeys } from "./internal.js";

/** A reconstructed outcome event (v1: derived from the slash history). */
export interface TrackRecordOutcome {
  /** Outcome kind. v1 only reconstructs slashes from the event stream. */
  kind: "slash";
  /** The raw slash event from the indexer record. */
  event: IndexerAgentTrackRecord["slashHistory"][number];
}

/** The projected track record {@link useAgentTrackRecord} returns. */
export interface AgentTrackRecord {
  /** The agent PDA. */
  agent: Address | string;
  /** Completed-task count (real today). */
  completions: number;
  /** Disputes the agent initiated (real today). */
  disputesInitiated: number;
  /** Disputes the agent lost (real today). */
  disputesLost: number;
  /**
   * Completion rate in `[0,1]`, or `null` when no denominator is inferable.
   * PROVISIONAL until P6.6 supplies the true total-tasks denominator.
   */
  completionRate: number | null;
  /**
   * Dispute rate in `[0,1]`, or `null` when no denominator is inferable.
   * PROVISIONAL until P6.6.
   */
  disputeRate: number | null;
  /** Reconstructed slash history (real today). */
  slashHistory: IndexerAgentTrackRecord["slashHistory"];
  /** Reconstructed recent outcomes (v1: from slash history). */
  recentOutcomes: TrackRecordOutcome[];
  /** True while any rate is provisional/derived (P6.6 audit signal). */
  partial: boolean;
}

/** Options for {@link useAgentTrackRecord}. */
export interface UseAgentTrackRecordOptions {
  /** Disable the query. Default `true` when `agentPda` is set. */
  enabled?: boolean;
}

/** Return value of {@link useAgentTrackRecord}. */
export interface UseAgentTrackRecordResult {
  /** The projected track record, or null until loaded. */
  trackRecord: AgentTrackRecord | null;
  /** Convenience: `trackRecord?.completionRate ?? null`. */
  completionRate: number | null;
  /** Convenience: `trackRecord?.disputeRate ?? null`. */
  disputeRate: number | null;
  /** Convenience: `trackRecord?.slashHistory ?? []`. */
  slashHistory: IndexerAgentTrackRecord["slashHistory"];
  /** Convenience: `trackRecord?.recentOutcomes ?? []`. */
  recentOutcomes: TrackRecordOutcome[];
  /** True while loading. */
  isLoading: boolean;
  /** The error (e.g. `ReadTransportUnsupportedError` under gPA), or null. */
  error: Error | null;
  /** Force a refetch. */
  refetch: () => void;
}

/**
 * Project the raw indexer record into the partial track-record contract. Kept
 * exported + pure so structural tests can assert the projection directly.
 */
export function projectTrackRecord(
  raw: IndexerAgentTrackRecord,
): AgentTrackRecord {
  const completions = raw.completions;
  const disputesLost = raw.disputesLost;
  // Conservative proxy denominator: settled outcomes we can SEE (completions +
  // lost disputes). This is NOT the true total-tasks denominator (P6.6); when
  // it is zero there is nothing to rate, so the rates are null.
  const settledKnown = completions + disputesLost;
  const completionRate =
    settledKnown > 0 ? completions / settledKnown : null;
  const disputeRate =
    settledKnown > 0 ? disputesLost / settledKnown : null;

  return {
    agent: raw.agent,
    completions,
    disputesInitiated: raw.disputesInitiated,
    disputesLost,
    completionRate,
    disputeRate,
    slashHistory: raw.slashHistory,
    recentOutcomes: raw.slashHistory.map((event) => ({
      kind: "slash" as const,
      event,
    })),
    // Always partial in v1: every rate is a proxy until P6.6 lands the real
    // denominators and outcome feed.
    partial: true,
  };
}

/**
 * Read an agent's (partial) track record.
 *
 * @param agentPda - The AgentRegistration PDA (falsy disables the hook).
 * @param options - `enabled` override.
 * @returns {@link UseAgentTrackRecordResult}.
 */
export function useAgentTrackRecord(
  agentPda: Address | string | undefined | null,
  options?: UseAgentTrackRecordOptions,
): UseAgentTrackRecordResult {
  const { read, cacheNamespace } = useAgencContext();
  const enabled = (options?.enabled ?? true) && Boolean(agentPda);

  const query = useQuery<AgentTrackRecord, Error>({
    queryKey: queryKeys.agentTrackRecord(
      agentPda ? pdaKey(agentPda) : "",
      cacheNamespace,
    ),
    enabled,
    queryFn: async () => {
      const raw = await read.agentTrackRecord(agentPda as Address | string);
      return projectTrackRecord(raw);
    },
  });

  const tr = query.data ?? null;
  return {
    trackRecord: tr,
    completionRate: tr?.completionRate ?? null,
    disputeRate: tr?.disputeRate ?? null,
    slashHistory: tr?.slashHistory ?? [],
    recentOutcomes: tr?.recentOutcomes ?? [],
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
