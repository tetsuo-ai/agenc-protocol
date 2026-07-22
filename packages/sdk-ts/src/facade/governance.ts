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
import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
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
  AGENC_COORDINATION_PROGRAM_ADDRESS,
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
import { canonicalizeFacadeInputSignerFields } from "../client/signer-identity.js";
import { snapshotFixedBytes } from "../values/fixed-bytes.js";
import { snapshotDenseStructuredArray } from "../values/structured-clone.js";
import {
  appendMultisigSignerMetas,
  snapshotMultisigFacadeInput,
  snapshotMultisigSigners,
} from "./wire.js";

const UPGRADEABLE_LOADER_PROGRAM_ADDRESS = address(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const DEFAULT_PUBLIC_KEY = address("11111111111111111111111111111111");

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
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  return getCreateProposalInstructionAsync({
    ...stableInput,
    titleHash: snapshotFixedBytes(
      stableInput.titleHash,
      32,
      "createProposal: titleHash",
    ),
    descriptionHash: snapshotFixedBytes(
      stableInput.descriptionHash,
      32,
      "createProposal: descriptionHash",
    ),
    payload: snapshotFixedBytes(
      stableInput.payload,
      64,
      "createProposal: payload",
    ),
  });
}

/**
 * Build a vote_proposal instruction. The vote-record PDA is auto-derived from
 * (proposal, authority); protocolConfig defaults to its PDA. `proposal` must be
 * supplied (no canonical seed for it here).
 */
export async function voteProposal(input: VoteProposalAsyncInput) {
  return getVoteProposalInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
}

/**
 * Build a cancel_proposal instruction. Sync-only in the generated client (no
 * PDA derivation): pass the proposal address and the cancelling authority signer.
 */
export function cancelProposal(input: CancelProposalInput) {
  return getCancelProposalInstruction(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
}

/**
 * Build an execute_proposal instruction (permissionless after voting ends).
 * protocolConfig and governanceConfig default to their PDAs. `treasury` and
 * `recipient` are optional and only required for treasury-spend proposals.
 * FeeChange and RateLimitChange additionally require the current ProtocolConfig
 * threshold in `multisigSigners`; other proposal kinds may omit it.
 */
export type ExecuteProposalInput =
  WithOptionalMultisigSigners<ExecuteProposalAsyncInput>;

export async function executeProposal(input: ExecuteProposalInput) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["authority"], {
      multisigRequired: false,
      optionalSignerKeys: ["treasury"],
    });
  const instruction = await getExecuteProposalInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
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
  return getInitializeGovernanceInstructionAsync(
    canonicalizeFacadeInputSignerFields(input, ["authority"]),
  );
}

/**
 * Build update_multisig with current-set approval. Rust also requires enough of
 * the proposed new owner set to sign, so include both approval sets (deduplicated)
 * in `multisigSigners` when rotating keys.
 */
export type UpdateMultisigInput =
  WithRequiredMultisigSigners<UpdateMultisigAsyncInput>;

export async function updateMultisig(input: UpdateMultisigInput) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["authority"]);
  const instruction = await getUpdateMultisigInstructionAsync({
    ...generatedInput,
    newOwners: snapshotDenseStructuredArray(
      generatedInput.newOwners,
      "updateMultisig: newOwners",
      5,
    ),
  });
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
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
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["newTreasury", "authority"]);
  const instruction = await getUpdateTreasuryInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
}

/** Build an update_protocol_fee instruction. protocolConfig defaults to its PDA. */
export type UpdateProtocolFeeInput =
  WithRequiredMultisigSigners<UpdateProtocolFeeAsyncInput>;

export async function updateProtocolFee(input: UpdateProtocolFeeInput) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["authority"]);
  const instruction =
    await getUpdateProtocolFeeInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
}

/** Build an update_rate_limits instruction. protocolConfig defaults to its PDA. */
export type UpdateRateLimitsInput =
  WithRequiredMultisigSigners<UpdateRateLimitsAsyncInput>;

export async function updateRateLimits(input: UpdateRateLimitsInput) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["authority"]);
  const instruction = await getUpdateRateLimitsInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
}

/** Build an update_min_version instruction. protocolConfig defaults to its PDA. */
export type UpdateMinVersionInput =
  WithRequiredMultisigSigners<UpdateMinVersionAsyncInput>;

export async function updateMinVersion(input: UpdateMinVersionInput) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["authority"]);
  const instruction = await getUpdateMinVersionInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
}

/**
 * Build an update_state instruction. The state PDA is auto-derived from
 * (authority, stateKey); protocolConfig defaults to its PDA. `agent` must be
 * supplied (the agent record authorizing the state write).
 */
export async function updateState(input: UpdateStateAsyncInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  return getUpdateStateInstructionAsync({
    ...stableInput,
    stateKey: snapshotFixedBytes(
      stableInput.stateKey,
      32,
      "updateState: stateKey",
    ),
    stateValue: snapshotFixedBytes(
      stableInput.stateValue,
      64,
      "updateState: stateValue",
    ),
  });
}

/** Build update_launch_controls with current ProtocolConfig M-of-N approval. */
export type UpdateLaunchControlsInput =
  WithRequiredMultisigSigners<UpdateLaunchControlsAsyncInput>;

export async function updateLaunchControls(input: UpdateLaunchControlsInput) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["authority"]);
  const instruction =
    await getUpdateLaunchControlsInstructionAsync(generatedInput);
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
}

/** Derive the canonical loader-v3 ProgramData PDA for the AgenC program. */
export async function findAgencProgramDataPda(): Promise<Address> {
  return (
    await getProgramDerivedAddress({
      programAddress: UPGRADEABLE_LOADER_PROGRAM_ADDRESS,
      seeds: [
        getAddressEncoder().encode(AGENC_COORDINATION_PROGRAM_ADDRESS),
      ],
    })
  )[0];
}

export type InitializeProtocolInput = InitializeProtocolAsyncInput & {
  /**
   * Additional configured owner wallets needed when `multisigThreshold` is
   * greater than two. `authority` and `secondSigner` are already counted by
   * the program and must not be repeated here.
   */
  readonly additionalMultisigSigners?: readonly TransactionSigner[];
};

/**
 * Build an initialize_protocol instruction. `protocolConfig` defaults to its
 * PDA and the canonical loader-v3 ProgramData account is derived automatically.
 * `authority` and `secondSigner` provide the mandatory two-party bootstrap;
 * include at most two additional configured owner wallets when the requested
 * threshold is three or four.
 */
export async function initializeProtocol(input: InitializeProtocolInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, [
    "treasury",
    "authority",
    "secondSigner",
  ]);
  const { additionalMultisigSigners, ...generatedInput } = stableInput;
  const multisigOwners = snapshotDenseStructuredArray(
    stableInput.multisigOwners,
    "initializeProtocol: multisigOwners",
    5,
  );
  if (
    !Number.isInteger(stableInput.multisigThreshold) ||
    stableInput.multisigThreshold < 2 ||
    stableInput.multisigThreshold >= multisigOwners.length
  ) {
    throw new RangeError(
      "initializeProtocol: multisigThreshold must be an integer of at least two and less than the owner count",
    );
  }
  const ownerAddresses = new Set<Address>();
  for (const owner of multisigOwners) {
    if (owner === DEFAULT_PUBLIC_KEY) {
      throw new Error(
        "initializeProtocol: multisigOwners must not contain the default public key",
      );
    }
    if (ownerAddresses.has(owner)) {
      throw new Error(
        `initializeProtocol: duplicate multisig owner ${owner}`,
      );
    }
    ownerAddresses.add(owner);
  }
  if (stableInput.authority.address === stableInput.secondSigner.address) {
    throw new Error(
      "initializeProtocol: authority and secondSigner must be distinct",
    );
  }
  for (const [label, signer] of [
    ["authority", stableInput.authority],
    ["secondSigner", stableInput.secondSigner],
  ] as const) {
    if (!ownerAddresses.has(signer.address)) {
      throw new Error(
        `initializeProtocol: ${label} must be present in multisigOwners`,
      );
    }
  }

  const stableAdditionalSigners = snapshotMultisigSigners(
    additionalMultisigSigners ?? [],
    [stableInput.authority, stableInput.secondSigner],
  );
  const requiredAdditionalSigners = stableInput.multisigThreshold - 2;
  if (stableAdditionalSigners.length !== requiredAdditionalSigners) {
    throw new TypeError(
      `initializeProtocol: additionalMultisigSigners must contain exactly ${requiredAdditionalSigners} approval${requiredAdditionalSigners === 1 ? "" : "s"} for threshold ${stableInput.multisigThreshold}`,
    );
  }
  for (const signer of stableAdditionalSigners) {
    if (
      signer.address === stableInput.authority.address ||
      signer.address === stableInput.secondSigner.address
    ) {
      throw new Error(
        `initializeProtocol: additionalMultisigSigners must not repeat named signer ${signer.address}`,
      );
    }
    if (!ownerAddresses.has(signer.address)) {
      throw new Error(
        `initializeProtocol: additional signer ${signer.address} must be present in multisigOwners`,
      );
    }
  }
  const programData = await findAgencProgramDataPda();
  const instruction = await getInitializeProtocolInstructionAsync({
    ...generatedInput,
    multisigOwners,
  });
  return appendMultisigSignerMetas(
    {
      ...instruction,
      accounts: [
        ...instruction.accounts,
        { address: programData, role: AccountRole.READONLY },
      ],
    },
    stableAdditionalSigners,
  );
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
export type MigrateTaskInput =
  WithRequiredMultisigSigners<GeneratedMigrateTaskInput>;

export function migrateTask(input: MigrateTaskInput) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["payer", "authority"]);
  const instruction = getMigrateTaskInstruction(generatedInput);
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
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
export type MigrateProtocolInput =
  WithRequiredMultisigSigners<GeneratedMigrateProtocolInput>;

export function migrateProtocol(input: MigrateProtocolInput) {
  const { generatedInput, multisigSigners: stableMultisigSigners } =
    snapshotMultisigFacadeInput(input, ["payer", "authority"]);
  const instruction = getMigrateProtocolInstruction(generatedInput);
  return appendMultisigSignerMetas(instruction, stableMultisigSigners);
}
