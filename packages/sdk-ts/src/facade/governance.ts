// Facade: ergonomic, named entry points over the generated client for the
// governance + protocol-admin/config surface. Thin by design — the generated
// client already resolves PDAs and encodes data; the facade adds friendly
// signatures and defaults (preferring the Async builders so PDAs auto-derive).
//
// Several of these instructions are multisig-gated on-chain (the program checks
// additional co-signers via remaining_accounts). The facade only builds the
// instruction; the caller attaches the extra signer accounts as needed.
//
// Never import from generated/ internals other than its public exports.
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
  // zk config
  getInitializeZkConfigInstructionAsync,
  getUpdateZkImageIdInstructionAsync,
  // migrations
  getMigrateTaskInstruction,
  getMigrateProtocolInstruction,
  // PDA helpers (re-exported for convenience)
  findProposalPda,
  findVoteProposalVotePda,
  findGovernanceConfigPda,
  findProtocolConfigPda,
  findZkConfigPda,
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
  type InitializeZkConfigAsyncInput,
  type UpdateZkImageIdAsyncInput,
  type MigrateTaskInput,
  type MigrateProtocolInput,
} from "../generated/index.js";

export {
  findProposalPda,
  findVoteProposalVotePda,
  findGovernanceConfigPda,
  findProtocolConfigPda,
  findZkConfigPda,
  findStatePda,
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
 */
export async function executeProposal(input: ExecuteProposalAsyncInput) {
  return getExecuteProposalInstructionAsync(input);
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

/** Build an update_multisig instruction. protocolConfig defaults to its PDA. */
export async function updateMultisig(input: UpdateMultisigAsyncInput) {
  return getUpdateMultisigInstructionAsync(input);
}

/** Build an update_treasury instruction. protocolConfig defaults to its PDA. */
export async function updateTreasury(input: UpdateTreasuryAsyncInput) {
  return getUpdateTreasuryInstructionAsync(input);
}

/** Build an update_protocol_fee instruction. protocolConfig defaults to its PDA. */
export async function updateProtocolFee(input: UpdateProtocolFeeAsyncInput) {
  return getUpdateProtocolFeeInstructionAsync(input);
}

/** Build an update_rate_limits instruction. protocolConfig defaults to its PDA. */
export async function updateRateLimits(input: UpdateRateLimitsAsyncInput) {
  return getUpdateRateLimitsInstructionAsync(input);
}

/** Build an update_min_version instruction. protocolConfig defaults to its PDA. */
export async function updateMinVersion(input: UpdateMinVersionAsyncInput) {
  return getUpdateMinVersionInstructionAsync(input);
}

/**
 * Build an update_state instruction. The state PDA is auto-derived from
 * (authority, stateKey); protocolConfig defaults to its PDA. `agent` must be
 * supplied (the agent record authorizing the state write).
 */
export async function updateState(input: UpdateStateAsyncInput) {
  return getUpdateStateInstructionAsync(input);
}

/** Build an update_launch_controls instruction. protocolConfig defaults to its PDA. */
export async function updateLaunchControls(
  input: UpdateLaunchControlsAsyncInput,
) {
  return getUpdateLaunchControlsInstructionAsync(input);
}

/**
 * Build an initialize_protocol instruction. protocolConfig defaults to its PDA.
 * Requires two signers (authority + secondSigner) to prevent single-party setup.
 */
export async function initializeProtocol(input: InitializeProtocolAsyncInput) {
  return getInitializeProtocolInstructionAsync(input);
}

// ---------------------------------------------------------------------------
// ZK config
// ---------------------------------------------------------------------------

/**
 * Build an initialize_zk_config instruction. protocolConfig and zkConfig default
 * to their PDAs.
 */
export async function initializeZkConfig(input: InitializeZkConfigAsyncInput) {
  return getInitializeZkConfigInstructionAsync(input);
}

/**
 * Build an update_zk_image_id instruction. protocolConfig and zkConfig default
 * to their PDAs.
 */
export async function updateZkImageId(input: UpdateZkImageIdAsyncInput) {
  return getUpdateZkImageIdInstructionAsync(input);
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
 * `migrate_task` order-independent vs `migrate_protocol`.
 */
export function migrateTask(input: MigrateTaskInput) {
  return getMigrateTaskInstruction(input);
}

/**
 * Build a migrate_protocol instruction (P6.5 surface-versioning realloc). Sync in
 * the generated client: `migrate_protocol` takes the raw (pre-migration)
 * `ProtocolConfig` account directly — a typed `Account<ProtocolConfig>` would
 * reject the 349B pre-migration layout before the handler runs — so the caller
 * supplies `protocolConfig` (use {@link findProtocolConfigPda}); `payer` funds the
 * +2-byte rent top-up. The appended `surface_revision` is zero-initialized by the
 * handler, not passed as an arg.
 */
export function migrateProtocol(input: MigrateProtocolInput) {
  return getMigrateProtocolInstruction(input);
}
