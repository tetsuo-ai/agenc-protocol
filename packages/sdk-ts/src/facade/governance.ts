// Facade: ergonomic, named entry points over the generated client for the
// governance + protocol-admin/config surface. Thin by design — the generated
// client already resolves PDAs and encodes data; the facade adds friendly
// signatures and defaults (preferring the Async builders so PDAs auto-derive).
//
// Multisig-gated builders accept `multisigSigners` and append those system-wallet
// approvals after the generated named accounts, matching Rust remaining_accounts.
// A named authority that is also an owner must be repeated in this suffix so
// Rust counts that owner's approval.
//
// Never import from generated/ internals other than its public exports.
import type { TransactionSigner } from "@solana/kit";
import {
  // proposals
  getCreateProposalInstructionAsync,
  getVoteProposalInstructionAsync,
  getCancelProposalInstruction,
  getExecuteProposalInstructionAsync,
  // governance + protocol config
  getInitializeGovernanceInstructionAsync,
  getUpdateMultisigInstructionAsync,
  getUpdateTreasuryInstructionAsync,
  getUpdateProtocolFeeInstructionAsync,
  getUpdateRateLimitsInstructionAsync,
  getUpdateMinVersionInstructionAsync,
  getUpdateStateInstructionAsync,
  getUpdateLaunchControlsInstructionAsync,
  getInitializeProtocolInstructionAsync,
  // migrations
  getMigrateTaskInstruction,
  getMigrateProtocolInstruction,
  // PDA helpers (re-exported for convenience)
  findProposalPda,
  findVoteProposalVotePda,
  findGovernanceConfigPda,
  findProtocolConfigPda,
  findStatePda,
  type CreateProposalAsyncInput,
  type VoteProposalAsyncInput,
  type CancelProposalInput,
  type ExecuteProposalAsyncInput,
  type InitializeGovernanceAsyncInput,
  type UpdateMultisigAsyncInput,
  type UpdateTreasuryAsyncInput,
  type UpdateProtocolFeeAsyncInput,
  type UpdateRateLimitsAsyncInput,
  type UpdateMinVersionAsyncInput,
  type UpdateStateAsyncInput,
  type UpdateLaunchControlsAsyncInput,
  type InitializeProtocolAsyncInput,
  type MigrateTaskInput as GeneratedMigrateTaskInput,
  type MigrateProtocolInput as GeneratedMigrateProtocolInput,
} from "../generated/index.js";
import { appendMultisigSignerMetas } from "./wire.js";

export {
  findProposalPda,
  findVoteProposalVotePda,
  findGovernanceConfigPda,
  findProtocolConfigPda,
  findStatePda,
};

/** System-wallet approvals checked against ProtocolConfig's current M-of-N set. */
export type MultisigSignersInput = {
  readonly multisigSigners: readonly TransactionSigner[];
};

type WithRequiredMultisigSigners<T> = Omit<T, "multisigSigners"> &
  MultisigSignersInput;

type WithOptionalMultisigSigners<T> = Omit<T, "multisigSigners"> & {
  /**
   * Required by Rust only when executing FeeChange or RateLimitChange. The
   * builder cannot infer a proposal account's on-chain type, so the caller must
   * supply the current threshold signers for those proposal kinds.
   */
  readonly multisigSigners?: readonly TransactionSigner[];
};

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/**
 * Build a create_proposal instruction. The proposal PDA is auto-derived from
 * (proposer, nonce); protocolConfig and governanceConfig default to their PDAs.
 */
export async function createProposal(input: CreateProposalAsyncInput) {
  return getCreateProposalInstructionAsync(input);
}

/**
 * Build a vote_proposal instruction. The vote-record PDA is auto-derived from
 * (proposal, authority); protocolConfig defaults to its PDA. `proposal` must be
 * supplied (no canonical seed for it here).
 */
export async function voteProposal(input: VoteProposalAsyncInput) {
  return getVoteProposalInstructionAsync(input);
}

/**
 * Build a cancel_proposal instruction. Sync-only in the generated client (no
 * PDA derivation): pass the proposal address and the cancelling authority signer.
 */
export function cancelProposal(input: CancelProposalInput) {
  return getCancelProposalInstruction(input);
}

/**
 * Build an execute_proposal instruction (permissionless after voting ends).
 * protocolConfig and governanceConfig default to their PDAs. `treasury` and
 * `recipient` are optional and only required for treasury-spend proposals.
 * FeeChange and RateLimitChange additionally require the current ProtocolConfig
 * threshold in `multisigSigners`; other proposal kinds may omit it.
 */
export type ExecuteProposalInput = WithOptionalMultisigSigners<
  ExecuteProposalAsyncInput
>;

export async function executeProposal(input: ExecuteProposalInput) {
  const { multisigSigners = [], ...generatedInput } = input;
  const instruction = await getExecuteProposalInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, multisigSigners);
}

// ---------------------------------------------------------------------------
// Governance + protocol config (multisig-gated on-chain via remaining_accounts)
// ---------------------------------------------------------------------------

/**
 * Build an initialize_governance instruction. governanceConfig and
 * protocolConfig default to their PDAs.
 */
export async function initializeGovernance(
  input: InitializeGovernanceAsyncInput,
) {
  return getInitializeGovernanceInstructionAsync(input);
}

/**
 * Build update_multisig with current-set approval. Rust also requires enough of
 * the proposed new owner set to sign, so include both approval sets (deduplicated)
 * in `multisigSigners` when rotating keys.
 */
export type UpdateMultisigInput = WithRequiredMultisigSigners<
  UpdateMultisigAsyncInput
>;

export async function updateMultisig(input: UpdateMultisigInput) {
  const { multisigSigners, ...generatedInput } = input;
  const instruction = await getUpdateMultisigInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, multisigSigners);
}

export type UpdateTreasuryInput = Omit<
  UpdateTreasuryAsyncInput,
  "newTreasury" | "multisigSigners"
> & {
  /** The new treasury must sign to prove control of the destination wallet. */
  newTreasury: TransactionSigner;
} & MultisigSignersInput;

/** Build update_treasury with custody consent plus current M-of-N approval. */
export async function updateTreasury(input: UpdateTreasuryInput) {
  const { multisigSigners, ...generatedInput } = input;
  const instruction = await getUpdateTreasuryInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, multisigSigners);
}

/** Build an update_protocol_fee instruction. protocolConfig defaults to its PDA. */
export type UpdateProtocolFeeInput = WithRequiredMultisigSigners<
  UpdateProtocolFeeAsyncInput
>;

export async function updateProtocolFee(input: UpdateProtocolFeeInput) {
  const { multisigSigners, ...generatedInput } = input;
  const instruction = await getUpdateProtocolFeeInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, multisigSigners);
}

/** Build an update_rate_limits instruction. protocolConfig defaults to its PDA. */
export type UpdateRateLimitsInput = WithRequiredMultisigSigners<
  UpdateRateLimitsAsyncInput
>;

export async function updateRateLimits(input: UpdateRateLimitsInput) {
  const { multisigSigners, ...generatedInput } = input;
  const instruction = await getUpdateRateLimitsInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, multisigSigners);
}

/** Build an update_min_version instruction. protocolConfig defaults to its PDA. */
export type UpdateMinVersionInput = WithRequiredMultisigSigners<
  UpdateMinVersionAsyncInput
>;

export async function updateMinVersion(input: UpdateMinVersionInput) {
  const { multisigSigners, ...generatedInput } = input;
  const instruction = await getUpdateMinVersionInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, multisigSigners);
}

/**
 * Build an update_state instruction. The state PDA is auto-derived from
 * (authority, stateKey); protocolConfig defaults to its PDA. `agent` must be
 * supplied (the agent record authorizing the state write).
 */
export async function updateState(input: UpdateStateAsyncInput) {
  return getUpdateStateInstructionAsync(input);
}

/** Build update_launch_controls with current ProtocolConfig M-of-N approval. */
export type UpdateLaunchControlsInput = WithRequiredMultisigSigners<
  UpdateLaunchControlsAsyncInput
>;

export async function updateLaunchControls(
  input: UpdateLaunchControlsInput,
) {
  const { multisigSigners, ...generatedInput } = input;
  const instruction =
    await getUpdateLaunchControlsInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, multisigSigners);
}

/**
 * Build an initialize_protocol instruction. protocolConfig defaults to its PDA.
 * Requires two signers (authority + secondSigner) to prevent single-party setup.
 */
export async function initializeProtocol(input: InitializeProtocolAsyncInput) {
  return getInitializeProtocolInstructionAsync(input);
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Build a migrate_task instruction. `protocolConfig` is the raw (pre-migration)
 * `ProtocolConfig` account — supply it explicitly via {@link findProtocolConfigPda}
 * (a typed `Account<ProtocolConfig>` would reject the 349B pre-`migrate_protocol`
 * config before the handler runs, so the account is an `UncheckedAccount` and the
 * generated client no longer auto-resolves its PDA). `task` is the raw
 * (pre-migration) task account; `payer` funds the rent top-up. This makes
 * `migrate_task` order-independent vs `migrate_protocol`. Rust gates both
 * migrations with the current ProtocolConfig M-of-N.
 */
export type MigrateTaskInput = WithRequiredMultisigSigners<
  GeneratedMigrateTaskInput
>;

export function migrateTask(input: MigrateTaskInput) {
  const { multisigSigners, ...generatedInput } = input;
  const instruction = getMigrateTaskInstruction(generatedInput);
  return appendMultisigSignerMetas(instruction, multisigSigners);
}

/**
 * Build a migrate_protocol instruction (P6.5 surface-versioning realloc). Sync in
 * the generated client: `migrate_protocol` takes the raw (pre-migration)
 * `ProtocolConfig` account directly — a typed `Account<ProtocolConfig>` would
 * reject the 349B pre-migration layout before the handler runs — so the caller
 * supplies `protocolConfig` (use {@link findProtocolConfigPda}); `payer` funds the
 * +2-byte rent top-up. The appended `surface_revision` is zero-initialized by the
 * handler, not passed as an arg. `multisigSigners` supplies the required current
 * ProtocolConfig threshold.
 */
export type MigrateProtocolInput = WithRequiredMultisigSigners<
  GeneratedMigrateProtocolInput
>;

export function migrateProtocol(input: MigrateProtocolInput) {
  const { multisigSigners, ...generatedInput } = input;
  const instruction = getMigrateProtocolInstruction(generatedInput);
  return appendMultisigSignerMetas(instruction, multisigSigners);
}
