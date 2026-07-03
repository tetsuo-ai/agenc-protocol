// Facade: ergonomic, named entry points over the generated client. Thin by design —
// the generated client already resolves PDAs and encodes data; the facade adds friendly
// signatures, defaults, and (for multi-PDA flows) bundling. Never import from generated/
// internals other than its public exports.
//
// P7.3 agent domain verification. The GLOBAL moderation authority records that operator
// domain D was proven to control agent A. (P1.2 §4.6 decoupled this from the now-OPEN
// moderation-attestor roster: a permissionless roster would let anyone mint verified
// badges or clobber a rival's record, so the roster account was REMOVED from these
// instructions — global-authority only until per-attestor-keyed verification ships.)
// The off-chain domain-control proof (TXT record / .well-known + signed challenge) is
// the attestor SERVICE's job; these wrappers only build the on-chain record/revoke
// instructions.
import type { Address } from "@solana/kit";
import {
  getRecordAgentVerificationInstructionAsync,
  getRevokeAgentVerificationInstructionAsync,
  findAgentVerificationPda,
  type RecordAgentVerificationAsyncInput,
  type RevokeAgentVerificationAsyncInput,
} from "../generated/index.js";

export { findAgentVerificationPda };

/**
 * Agent-verification proof methods (mirror the on-chain `agent_verification_method::*`).
 * `method: 0` = the operator proved domain control via a DNS `TXT` record; `method: 1` =
 * via a `.well-known` file served over HTTPS.
 */
export const AgentVerificationMethod = {
  TxtRecord: 0,
  WellKnown: 1,
} as const;
export type AgentVerificationMethod =
  (typeof AgentVerificationMethod)[keyof typeof AgentVerificationMethod];

/**
 * Build a record_agent_verification instruction (P7.3). Records that `verifiedDomain` was
 * proven to control `agent`. The moderationConfig PDA and the per-agent agentVerification
 * PDA (seeded by `agent`) are auto-derived when omitted; pass `agent`, the `attestor`
 * signer (P1.2 §4.6: MUST be the global moderation authority — the roster path was
 * removed when the roster went permissionless), `verifiedDomain`, `method`, and
 * `expiresAt` (0 = no expiry). Re-verification overwrites the same agentVerification PDA
 * in place.
 */
export async function recordAgentVerification(
  input: RecordAgentVerificationAsyncInput,
) {
  return getRecordAgentVerificationInstructionAsync(input);
}

/**
 * Build a revoke_agent_verification instruction (P7.3). Marks an agent's verification
 * `revoked = true` (the record is kept readable, not closed). Same global-authority-only
 * authorization as `recordAgentVerification` (P1.2 §4.6).
 *
 * The on-chain agentVerification PDA seed reads the account's stored `agent`, so the
 * generated builder does NOT auto-derive it; the facade derives it from the `agent` pubkey
 * when `agentVerification` is not passed explicitly. moderationConfig still auto-derives.
 */
export async function revokeAgentVerification(
  input: Omit<RevokeAgentVerificationAsyncInput, "agentVerification"> & {
    /** The agent (AgentRegistration PDA) whose verification is revoked. Used to derive the PDA. */
    agent?: Address;
    /** Optional pre-derived override for the agentVerification PDA. */
    agentVerification?: Address;
  },
) {
  const { agent, agentVerification, ...rest } = input;
  let verification = agentVerification;
  if (!verification) {
    if (!agent) {
      throw new Error(
        "revokeAgentVerification: provide agent (or agentVerification) so the verification PDA can be derived",
      );
    }
    verification = (await findAgentVerificationPda({ agent }))[0];
  }
  return getRevokeAgentVerificationInstructionAsync({
    ...rest,
    agentVerification: verification,
  });
}
