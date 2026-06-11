/**
 * `useAgentVerification(agentPda, { reader })` — resolve the ON-CHAIN agent
 * verification (P7.3) for a provider.
 *
 * ## Claimed vs verified — the load-bearing distinction
 *
 * A provider's `operatorDomain` from its agent metadata is a CLAIM: the operator
 * typed it; nobody checked it. The trust signal is the on-chain
 * `AgentVerification` PDA (`["agent_verification", agent]`), written by a trusted
 * attestor only after the operator PROVED domain control (DNS `TXT` /
 * `.well-known` + a signed challenge). This module reads THAT account and never
 * conflates the two: a merely-claimed domain resolves to `{ verified: false }`.
 *
 * A verification counts as LIVE only when the account exists AND is not revoked
 * AND has not expired (`expiresAt === 0n` means no expiry). See
 * {@link evaluateAgentVerification}.
 *
 * ## Read path (no `ReadTransport` coupling)
 *
 * The package's indexer/gPA `ReadTransport` has no single-account fetch seam, so
 * this hook reads through an injected `reader` (an `AgentVerificationReader`).
 * The SDK ships the pieces a host wires into one — `findAgentVerificationPda`
 * (the `["agent_verification", agent]` PDA) + `fetchMaybeAgentVerification` (the
 * regenerated decoder) — and {@link agentVerificationReaderFromRpc} assembles
 * exactly that against a kit RPC. Storefront P3 may instead surface a resolved
 * `verified`/`verifiedDomain` on its track-record endpoint; either way the hook
 * consumes the SAME pinned {@link AgentVerificationResult} shape.
 *
 * SSR-safe: pure module, no `window`/`document`, no module-scope side effects.
 * The optional `now` injection keeps the expiry evaluation deterministic in
 * tests and stable across an SSR/CSR boundary.
 *
 * @module components/useAgentVerification
 */
import { useQuery } from "@tanstack/react-query";
import {
  findAgentVerificationPda,
  fetchMaybeAgentVerification,
  type AgentVerification,
} from "@tetsuo-ai/marketplace-sdk";
import type { Address } from "../types.js";

/**
 * The decoded, projected verification result for an agent — the PINNED P7.3(3)
 * shape. When no live verification exists this is `{ verified: false }` (the
 * narrow "absent / revoked / expired" case); otherwise every field is present
 * and `verified` is `true`.
 */
export type AgentVerificationResult =
  | {
      /** A live, on-chain, non-revoked, non-expired verification exists. */
      verified: true;
      /** The on-chain VERIFIED operator domain (proven, not self-claimed). */
      domain: string;
      /** Proof method: `0` = DNS `TXT`, `1` = `.well-known` over HTTPS. */
      method: number;
      /** The attestor/authority that recorded this verification. */
      verifiedBy: Address | string;
      /** Unix-seconds timestamp the verification was recorded. */
      verifiedAt: bigint;
      /** Unix-seconds expiry, or `0n` for no expiry. */
      expiresAt: bigint;
      /** Always `false` here (a revoked record is never `verified: true`). */
      revoked: false;
    }
  | {
      /** No live verification — account absent, revoked, or expired. */
      verified: false;
    };

/** The unverified sentinel (frozen so callers can compare identity cheaply). */
export const UNVERIFIED: AgentVerificationResult = Object.freeze({
  verified: false,
});

/**
 * Decide whether a decoded `AgentVerification` account is a LIVE verification:
 * it must NOT be revoked AND must not be expired (`expiresAt === 0n` = no
 * expiry; otherwise `nowSeconds < expiresAt`). Pure + exported so structural
 * tests assert the revoked/expired/absent boundaries directly.
 *
 * @param account - The decoded account, or `null`/`undefined` when absent.
 * @param nowSeconds - Current unix-seconds (injected for determinism).
 */
export function evaluateAgentVerification(
  account: AgentVerification | null | undefined,
  nowSeconds: bigint,
): AgentVerificationResult {
  if (!account) return UNVERIFIED;
  if (account.revoked) return UNVERIFIED;
  // expiresAt === 0 means "no expiry"; any positive value is a hard deadline.
  if (account.expiresAt !== 0n && nowSeconds >= account.expiresAt) {
    return UNVERIFIED;
  }
  return {
    verified: true,
    domain: account.verifiedDomain,
    method: account.method,
    verifiedBy: account.verifiedBy,
    verifiedAt: account.verifiedAt,
    expiresAt: account.expiresAt,
    revoked: false,
  };
}

/**
 * A function that resolves the raw verification for an agent PDA to the pinned
 * result shape. Injected so the hook stays decoupled from any specific read
 * backend (kit RPC, the storefront track-record endpoint, a test stub).
 */
export type AgentVerificationReader = (
  agentPda: Address | string,
) => Promise<AgentVerificationResult>;

/** The minimal kit-RPC surface {@link agentVerificationReaderFromRpc} needs. */
export type AgentVerificationRpc = Parameters<
  typeof fetchMaybeAgentVerification
>[0];

/** Options for {@link agentVerificationReaderFromRpc}. */
export interface AgentVerificationReaderOptions {
  /**
   * Clock source (unix seconds) used to evaluate expiry. Defaults to
   * `Date.now()`-derived; inject a fixed value in tests/SSR for determinism.
   */
  now?: () => bigint;
}

/** Default unix-seconds clock. */
function defaultNow(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/**
 * Build an {@link AgentVerificationReader} over a kit RPC using the SDK's
 * `findAgentVerificationPda` (the `["agent_verification", agent]` seed) +
 * `fetchMaybeAgentVerification` (the regenerated decoder). An absent account
 * yields `{ verified: false }` (never throws on absence).
 *
 * @param rpc - A kit RPC capable of `getAccountInfo` (what the SDK fetch needs).
 * @param options - Optional `now` clock injection.
 */
export function agentVerificationReaderFromRpc(
  rpc: AgentVerificationRpc,
  options?: AgentVerificationReaderOptions,
): AgentVerificationReader {
  const now = options?.now ?? defaultNow;
  return async (agentPda) => {
    const [pda] = await findAgentVerificationPda({ agent: agentPda as Address });
    const maybe = await fetchMaybeAgentVerification(rpc, pda);
    return evaluateAgentVerification(maybe.exists ? maybe.data : null, now());
  };
}

/** Options for {@link useAgentVerification}. */
export interface UseAgentVerificationOptions {
  /**
   * The reader that resolves the on-chain verification. When omitted the hook
   * is inert (returns the unverified result, never queries) — a host opts in by
   * passing {@link agentVerificationReaderFromRpc} or a custom resolver.
   */
  reader?: AgentVerificationReader;
  /** Disable the query. Default `true` when `agentPda` and a `reader` are set. */
  enabled?: boolean;
}

/** Return value of {@link useAgentVerification}. */
export interface UseAgentVerificationResult {
  /** The resolved verification (defaults to the unverified result). */
  verification: AgentVerificationResult;
  /** Convenience: `verification.verified`. */
  verified: boolean;
  /** True while the verification read is in flight. */
  isLoading: boolean;
  /** A read error, or `null`. A failed read is NEVER treated as verified. */
  error: Error | null;
  /** Force a refetch. */
  refetch: () => void;
}

/**
 * Read an agent's on-chain verification (P7.3) into the pinned result shape.
 *
 * Defensive by construction: with no `reader`, no resolved data, or a read
 * error, the result is `{ verified: false }` — an agent is shown verified ONLY
 * when a live on-chain attestation is actually read back. A self-claimed
 * `operatorDomain` never reaches this hook.
 *
 * @param agentPda - The AgentRegistration PDA (falsy disables the hook).
 * @param options - The `reader` to resolve with + an `enabled` override.
 * @returns {@link UseAgentVerificationResult}.
 */
export function useAgentVerification(
  agentPda: Address | string | undefined | null,
  options?: UseAgentVerificationOptions,
): UseAgentVerificationResult {
  const reader = options?.reader;
  const enabled =
    (options?.enabled ?? true) && Boolean(agentPda) && Boolean(reader);

  const query = useQuery<AgentVerificationResult, Error>({
    queryKey: ["agenc", "agentVerification", agentPda ? String(agentPda) : ""],
    enabled,
    queryFn: async () => {
      // `enabled` guards reader/agentPda presence; assert for the type narrow.
      return reader!(agentPda as Address | string);
    },
  });

  // Fail CLOSED on error. react-query retains the last successful `query.data`
  // across a failed refetch, so a stale `{ verified: true }` would otherwise
  // outlive a transient RPC error (the exact case where an agent's on-chain
  // verification may have just been revoked). An errored read is NEVER verified
  // — drop the cached data and surface UNVERIFIED whenever `query.error` is set.
  const verification = query.error ? UNVERIFIED : (query.data ?? UNVERIFIED);
  return {
    verification,
    verified: verification.verified,
    isLoading: query.isLoading && enabled,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
