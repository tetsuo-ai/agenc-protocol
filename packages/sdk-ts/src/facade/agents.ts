// Facade: ergonomic, named entry points over the generated client. Thin by design —
// the generated client already resolves PDAs and encodes data; the facade adds friendly
// signatures, defaults, and (for multi-PDA flows) bundling. Never import from generated/
// internals other than its public exports.
import {
  AccountRole,
  some,
  none,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  getRegisterAgentInstructionAsync,
  getUpdateAgentInstruction,
  getDeregisterAgentInstructionAsync,
  getSuspendAgentInstructionAsync,
  getUnsuspendAgentInstructionAsync,
  findAgentPda,
  // P6.6: AgentStats track-record aggregate. Codama derives the canonical
  // `["agent_stats", <agent pubkey>]` PDA from the FIRST instruction that declares it
  // (cancel_task), so the generated `findAgentStatsPda` seed field is named
  // `creatorAgent`. The derivation is identical for every AgentStats handler (the seed
  // is just the agent PDA), so the facade wraps it below under a stable `{ agent }`
  // signature rather than leaking the instruction-specific seed name. The account
  // (`AgentStats` type / `fetchMaybeAgentStats`) is generated likewise. Never hand-edit
  // generated/ — verified after `npm run sdk:generate`.
  findAgentStatsPda as findAgentStatsPdaGenerated,
  fetchMaybeAgentStats,
  fetchMaybeAgentRegistration,
  // P7.3(3): on-chain agent verification (the AgentVerification PDA recorded by
  // a trusted attestor — the TRUST signal, distinct from the self-claimed
  // operatorDomain). The PDA is seeded `["agent_verification", agent]`.
  findAgentVerificationPda,
  fetchMaybeAgentVerification,
  findBidderMarketStatePda,
  type AgentStats,
  type RegisterAgentAsyncInput,
  type DeregisterAgentAsyncInput,
  type SuspendAgentAsyncInput,
  type UnsuspendAgentAsyncInput,
} from "../generated/index.js";

export { findAgentPda };

/**
 * Derive the canonical `["agent_stats", agent]` track-record PDA for an agent (P6.6).
 * Stable `{ agent }` signature over the Codama-generated derivation (whose seed field is
 * named after the cancel_task `creatorAgent` account but resolves identically for every
 * AgentStats handler).
 */
export function findAgentStatsPda(seeds: { agent: Address }) {
  return findAgentStatsPdaGenerated({ creatorAgent: seeds.agent });
}

/** Build a register_agent instruction; the agent PDA is auto-derived from agentId. */
export async function registerAgent(input: RegisterAgentAsyncInput) {
  return getRegisterAgentInstructionAsync(input);
}

/**
 * Friendly input for {@link updateAgent}. Every mutable field is optional: omit a field
 * to leave it unchanged on-chain (the generated builder takes an Option per field, so we
 * map `undefined` -> `none()` and a provided value -> `some(value)`).
 */
export type UpdateAgentInput = {
  /** The agent account PDA being updated (writable). */
  agent: Address;
  /** The agent authority signer. */
  authority: TransactionSigner;
  /** New capabilities bitmask; omit to leave unchanged. */
  capabilities?: number | bigint;
  /** New endpoint URI; omit to leave unchanged. */
  endpoint?: string;
  /** New metadata URI; omit to leave unchanged. */
  metadataUri?: string;
  /** New status code; omit to leave unchanged. */
  status?: number;
};

/**
 * Build an update_agent instruction. Only the fields you pass are updated; the rest are
 * encoded as `none` (no-op). update_agent has no PDA-deriving Async builder — the agent
 * address is supplied directly — so this wraps the sync builder and wraps each field in
 * the Option the generated encoder expects.
 */
export function updateAgent(input: UpdateAgentInput) {
  return getUpdateAgentInstruction({
    agent: input.agent,
    authority: input.authority,
    capabilities:
      input.capabilities === undefined ? none() : some(input.capabilities),
    endpoint: input.endpoint === undefined ? none() : some(input.endpoint),
    metadataUri:
      input.metadataUri === undefined ? none() : some(input.metadataUri),
    status: input.status === undefined ? none() : some(input.status),
  });
}

/**
 * Build a deregister_agent instruction; the protocol config PDA is auto-derived.
 *
 * The handler also requires two seeds-pinned remaining_accounts (audit,
 * 2026-07 swarm), derived and appended here automatically:
 *   [0] the canonical `["bidder_market", agent]` PDA (read-only) — deregistration
 *       is refused while it reports live bids, because every bid-withdrawal path
 *       loads this registration (AgentHasActiveBids);
 *   [1] the canonical `["agent_verification", agent]` PDA (writable) — a live
 *       badge is closed with the registration so it can never attach to a later
 *       re-registration of the same agent_id.
 */
export async function deregisterAgent(input: DeregisterAgentAsyncInput) {
  const ix = await getDeregisterAgentInstructionAsync(input);
  const [bidderMarket] = await findBidderMarketStatePda({
    bidder: input.agent,
  });
  const [verification] = await findAgentVerificationPda({ agent: input.agent });
  return {
    ...ix,
    accounts: [
      ...ix.accounts,
      { address: bidderMarket, role: AccountRole.READONLY },
      { address: verification, role: AccountRole.WRITABLE },
    ],
  };
}

/** Build a suspend_agent instruction; the protocol config PDA is auto-derived. */
export async function suspendAgent(input: SuspendAgentAsyncInput) {
  return getSuspendAgentInstructionAsync(input);
}

/** Build an unsuspend_agent instruction; the protocol config PDA is auto-derived. */
export async function unsuspendAgent(input: UnsuspendAgentAsyncInput) {
  return getUnsuspendAgentInstructionAsync(input);
}

// ===========================================================================
// P7.3(3) — on-chain agent verification reader (fetchAgentVerification)
// ===========================================================================

/**
 * The decoded result of {@link fetchAgentVerification}. `verified` is the TRUST
 * signal — an on-chain `AgentVerification` recorded by a trusted attestor that
 * is not revoked and not expired. This is distinct from (and stronger than) the
 * self-claimed `operatorDomain` on the agent metadata: a UI should surface
 * `domain` as a VERIFIED badge only when `verified` is true.
 */
export type AgentVerificationResult =
  | {
      /** True: the AgentVerification PDA exists, is not revoked, and is not expired. */
      verified: true;
      /** The verified operator domain (lowercased ASCII DNS name). */
      domain: string;
      /** Proof method (`agent_verification_method::*`; 0 = TXT record, 1 = .well-known). */
      method: number;
      /** The attestor/authority that recorded the verification. */
      verifiedBy: Address;
      /** Unix timestamp the verification was recorded. */
      verifiedAt: bigint;
      /** Expiry Unix timestamp; `0n` = no expiry. */
      expiresAt: bigint;
      /** Always false in the `verified: true` branch (kept for a stable shape). */
      revoked: false;
    }
  | {
      /**
       * False: no AgentVerification PDA, or it is revoked / expired. `reason`
       * distinguishes the cases for callers that care.
       */
      verified: false;
      /** Why it is unverified: no record, revoked, or expired. */
      reason: "absent" | "revoked" | "expired";
    };

/**
 * Read an agent's on-chain verification status (P7.3(3)). Fetches the
 * `["agent_verification", agent]` PDA via the regenerated decoder and reports
 * `verified = account exists AND !revoked AND (expiresAt == 0 || now < expiresAt)`.
 *
 * Use this — not the self-claimed `operatorDomain` — as the trust signal when
 * surfacing a provider as "verified".
 *
 * @param rpc - a `@solana/kit` RPC (anything `fetchEncodedAccount` accepts).
 * @param agentPda - the agent's `AgentRegistration` PDA.
 * @param options - optional `nowSeconds` override (defaults to wall-clock) for
 *   deterministic expiry evaluation in tests.
 */
export async function fetchAgentVerification(
  rpc: Parameters<typeof fetchMaybeAgentVerification>[0],
  agentPda: Address,
  options: { nowSeconds?: bigint } = {},
): Promise<AgentVerificationResult> {
  const [verificationPda] = await findAgentVerificationPda({ agent: agentPda });
  const maybe = await fetchMaybeAgentVerification(rpc, verificationPda);
  if (!maybe.exists) {
    return { verified: false, reason: "absent" };
  }
  const v = maybe.data;
  if (v.revoked) {
    return { verified: false, reason: "revoked" };
  }
  const now =
    options.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  if (v.expiresAt !== 0n && now >= v.expiresAt) {
    return { verified: false, reason: "expired" };
  }
  return {
    verified: true,
    domain: v.verifiedDomain,
    method: v.method,
    verifiedBy: v.verifiedBy,
    verifiedAt: v.verifiedAt,
    expiresAt: v.expiresAt,
    revoked: false,
  };
}

// ===========================================================================
// P6.6 — track-record reader (getAgentTrackRecord)
// ===========================================================================

/**
 * One slash event drawn from the indexed event stream (P3.1), used to populate
 * {@link AgentTrackRecord.slashHistory} with timestamped detail beyond the raw
 * `disputes_lost` counter. The caller supplies these from their indexer; the helper
 * does not query logs itself.
 */
export type SlashEvent = {
  /** The dispute the slash was applied for. */
  dispute: Address;
  /** Lamports / token base units slashed (as reported by the slash event). */
  amount: bigint;
  /** Unix timestamp of the slash. */
  timestamp: bigint;
};

/** A single recent outcome derived from the on-chain counters. */
export type TrackRecordOutcome =
  | "completed"
  | "rejected"
  | "disputeWon"
  | "disputeLost"
  | "claimExpired"
  | "cancelled";

/**
 * The shape returned by {@link getAgentTrackRecord}. Aggregates the success-side stats
 * on `AgentRegistration` with the negative counters on the P6.6 `AgentStats` PDA, plus
 * (optionally) indexed slash events.
 */
export type AgentTrackRecord = {
  /** The agent PDA this record is for. */
  agent: Address;
  /** The `AgentStats` PDA (may not yet exist on-chain). */
  agentStats: Address;
  /** Whether an `AgentStats` account exists yet (false => all negative counters 0). */
  hasStats: boolean;
  /**
   * Completion rate in `[0, 1]`: `tasks_completed / (tasks_completed + rejected +
   * claims_expired + disputes_lost)`. Returns `null` when there is no decided history
   * (denominator 0) so callers can distinguish "perfect" from "no data".
   */
  completionRate: number | null;
  /**
   * Dispute rate in `[0, 1]`: `disputes_lost / (disputes_won + disputes_lost)`.
   * `null` when the agent has no resolved disputes.
   */
  disputeRate: number | null;
  /**
   * Slash history: the `disputes_lost` count plus any indexed slash events supplied by
   * the caller. `count` is authoritative (on-chain); `events` is best-effort detail.
   */
  slashHistory: { count: bigint; events: SlashEvent[] };
  /** The raw counters, surfaced for callers that want them directly. */
  counters: {
    tasksCompleted: bigint;
    tasksRejected: bigint;
    disputesWon: bigint;
    disputesLost: bigint;
    claimsExpired: bigint;
    totalCancelled: bigint;
  };
  /**
   * A coarse recent-outcome summary: the distinct outcome categories this agent has any
   * nonzero count for. (The counters are aggregates, not a time-ordered log, so this is
   * a presence summary; a precise ordering needs the indexed event stream.)
   */
  recentOutcomes: TrackRecordOutcome[];
  /**
   * P7.3(3) — TRUE when the agent has a live on-chain `AgentVerification`
   * (exists, not revoked, not expired). The trust signal to surface, distinct
   * from the self-claimed operator domain.
   */
  verified: boolean;
  /**
   * The on-chain VERIFIED operator domain when {@link AgentTrackRecord.verified}
   * is true; `null` otherwise. A UI shows this as a verified-domain badge — it
   * is the attestor-proven domain, not the self-claimed `operatorDomain`.
   */
  verifiedDomain: string | null;
};

/** Options for {@link getAgentTrackRecord}. */
export type GetAgentTrackRecordOptions = {
  /**
   * Indexed slash events (P3.1) for {@link AgentTrackRecord.slashHistory}. Optional —
   * the on-chain `disputes_lost` count is always returned regardless.
   */
  slashEvents?: SlashEvent[];
  /**
   * P7.3(3): override the wall-clock used to evaluate verification expiry
   * (`expiresAt`). Defaults to `Date.now()`; pass for deterministic tests.
   */
  nowSeconds?: bigint;
};

/** Coerce a u64 `bigint` counter to a JS `number` ratio numerator/denominator safely. */
function ratio(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) return null;
  return Number(numerator) / Number(denominator);
}

/**
 * Read an agent's full track record: success stats from `AgentRegistration` folded with
 * the P6.6 negative counters from the `AgentStats` PDA (and optional indexed slash
 * events). Tolerates a not-yet-created `AgentStats` (treats all negative counters as 0),
 * since the aggregate is created lazily on first negative outcome.
 *
 * @param rpc - a `@solana/kit` RPC (anything `fetchEncodedAccount` accepts).
 * @param agentPda - the agent's `AgentRegistration` PDA.
 */
export async function getAgentTrackRecord(
  rpc: Parameters<typeof fetchMaybeAgentStats>[0],
  agentPda: Address,
  options: GetAgentTrackRecordOptions = {},
): Promise<AgentTrackRecord> {
  const [agentStatsPda] = await findAgentStatsPda({ agent: agentPda });

  const [maybeReg, maybeStats, verification] = await Promise.all([
    fetchMaybeAgentRegistration(rpc, agentPda),
    fetchMaybeAgentStats(rpc, agentStatsPda),
    // P7.3(3): fold in the on-chain verification trust signal.
    fetchAgentVerification(rpc, agentPda, options.nowSeconds === undefined ? {} : { nowSeconds: options.nowSeconds }),
  ]);

  const tasksCompleted = maybeReg.exists ? maybeReg.data.tasksCompleted : 0n;

  const stats: Pick<
    AgentStats,
    | "tasksRejected"
    | "disputesWon"
    | "disputesLost"
    | "claimsExpired"
    | "totalCancelled"
  > = maybeStats.exists
    ? maybeStats.data
    : {
        tasksRejected: 0n,
        disputesWon: 0n,
        disputesLost: 0n,
        claimsExpired: 0n,
        totalCancelled: 0n,
      };

  const decided =
    tasksCompleted +
    stats.tasksRejected +
    stats.claimsExpired +
    stats.disputesLost;
  const disputesTotal = stats.disputesWon + stats.disputesLost;

  const recentOutcomes: TrackRecordOutcome[] = [];
  if (tasksCompleted > 0n) recentOutcomes.push("completed");
  if (stats.tasksRejected > 0n) recentOutcomes.push("rejected");
  if (stats.disputesWon > 0n) recentOutcomes.push("disputeWon");
  if (stats.disputesLost > 0n) recentOutcomes.push("disputeLost");
  if (stats.claimsExpired > 0n) recentOutcomes.push("claimExpired");
  if (stats.totalCancelled > 0n) recentOutcomes.push("cancelled");

  return {
    agent: agentPda,
    agentStats: agentStatsPda,
    hasStats: maybeStats.exists,
    completionRate: ratio(tasksCompleted, decided),
    disputeRate: ratio(stats.disputesLost, disputesTotal),
    slashHistory: {
      count: stats.disputesLost,
      events: options.slashEvents ?? [],
    },
    counters: {
      tasksCompleted,
      tasksRejected: stats.tasksRejected,
      disputesWon: stats.disputesWon,
      disputesLost: stats.disputesLost,
      claimsExpired: stats.claimsExpired,
      totalCancelled: stats.totalCancelled,
    },
    recentOutcomes,
    verified: verification.verified,
    verifiedDomain: verification.verified ? verification.domain : null,
  };
}
