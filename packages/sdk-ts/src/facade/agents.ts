// Facade: ergonomic, named entry points over the generated client. Thin by design —
// the generated client already resolves PDAs and encodes data; the facade adds friendly
// signatures, defaults, and (for multi-PDA flows) bundling. Never import from generated/
// internals other than its public exports.
import { some, none, type Address, type TransactionSigner } from "@solana/kit";
import {
  getRegisterAgentInstructionAsync,
  getUpdateAgentInstruction,
  getDeregisterAgentInstructionAsync,
  getSuspendAgentInstructionAsync,
  getUnsuspendAgentInstructionAsync,
  findAgentPda,
  type RegisterAgentAsyncInput,
  type DeregisterAgentAsyncInput,
  type SuspendAgentAsyncInput,
  type UnsuspendAgentAsyncInput,
} from "../generated/index.js";

export { findAgentPda };

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

/** Build a deregister_agent instruction; the protocol config PDA is auto-derived. */
export async function deregisterAgent(input: DeregisterAgentAsyncInput) {
  return getDeregisterAgentInstructionAsync(input);
}

/** Build a suspend_agent instruction; the protocol config PDA is auto-derived. */
export async function suspendAgent(input: SuspendAgentAsyncInput) {
  return getSuspendAgentInstructionAsync(input);
}

/** Build an unsuspend_agent instruction; the protocol config PDA is auto-derived. */
export async function unsuspendAgent(input: UnsuspendAgentAsyncInput) {
  return getUnsuspendAgentInstructionAsync(input);
}
