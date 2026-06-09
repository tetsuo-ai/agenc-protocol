// Facade: ergonomic, named entry points over the generated client for the dispute
// lifecycle. Thin by design — the generated client already resolves most PDAs and
// encodes data; the facade adds friendly signatures, defaults, and (for the multi-PDA
// settlement flows) derives the completion-bond accounts so callers cannot omit them.
// Never import from generated/ internals other than its public exports.
import type { Address } from "@solana/kit";
import {
  // builders
  getInitiateDisputeInstructionAsync,
  getVoteDisputeInstructionAsync,
  getResolveDisputeInstructionAsync,
  getExpireDisputeInstructionAsync,
  getCancelDisputeInstructionAsync,
  getApplyDisputeSlashInstructionAsync,
  getApplyInitiatorSlashInstructionAsync,
  getResolveRejectFrozenInstructionAsync,
  getExpireRejectFrozenInstructionAsync,
  getAssignDisputeResolverInstructionAsync,
  getRevokeDisputeResolverInstructionAsync,
  // input types
  type AssignDisputeResolverAsyncInput,
  type RevokeDisputeResolverAsyncInput,
  type InitiateDisputeAsyncInput,
  type VoteDisputeAsyncInput,
  type ResolveDisputeAsyncInput,
  type ExpireDisputeAsyncInput,
  type CancelDisputeAsyncInput,
  type ApplyDisputeSlashAsyncInput,
  type ApplyInitiatorSlashAsyncInput,
  type ResolveRejectFrozenAsyncInput,
  type ExpireRejectFrozenAsyncInput,
  // PDA helpers
  findDisputePda,
  findDisputeResolverPda,
  findCreatorCompletionBondPda,
  findWorkerCompletionBondPda,
} from "../generated/index.js";

export {
  findDisputePda,
  findDisputeResolverPda,
  findCreatorCompletionBondPda,
  findWorkerCompletionBondPda,
};

/**
 * Build an initiate_dispute instruction. The dispute, rate-limit, protocol-config,
 * and initiator-claim PDAs all auto-derive from the supplied ids/accounts.
 */
export async function initiateDispute(input: InitiateDisputeAsyncInput) {
  return getInitiateDisputeInstructionAsync(input);
}

/**
 * Build a vote_dispute instruction. The arbiter's per-dispute vote, the Sybil-guard
 * authority vote, and protocol-config PDAs all auto-derive.
 */
export async function voteDispute(input: VoteDisputeAsyncInput) {
  return getVoteDisputeInstructionAsync(input);
}

/**
 * Build a resolve_dispute instruction.
 *
 * The completion-bond accounts are REQUIRED by the program and are NOT auto-derived
 * by the generated builder, so the facade derives the creator/worker completion-bond
 * PDAs here (seeded by [task, creator] and [task, worker-authority]) and passes them
 * — callers cannot accidentally omit them and dodge the bond forfeit. The bond
 * treasury (where forfeited bonds land) must be provided explicitly. Escrow,
 * protocol-config, hire-record, and the token/system programs still auto-derive.
 *
 * Pass the worker's *authority* (wallet) that posted the bond as `workerBondAuthority`;
 * it defaults to `workerWallet` when present, since that is the SOL recipient leg.
 */
export async function resolveDispute(
  input: Omit<
    ResolveDisputeAsyncInput,
    "creatorCompletionBond" | "workerCompletionBond"
  > & {
    /** Authority (wallet) that posted the worker completion bond. */
    workerBondAuthority?: Address;
    /** Optional pre-derived overrides; derived from task/creator/worker when omitted. */
    creatorCompletionBond?: Address;
    workerCompletionBond?: Address;
  },
) {
  const { workerBondAuthority, creatorCompletionBond, workerCompletionBond, ...rest } =
    input;

  const workerAuthority =
    workerBondAuthority ?? (rest.workerWallet as Address | undefined);
  if (!workerAuthority) {
    throw new Error(
      "resolveDispute: provide workerBondAuthority (or workerWallet) so the worker completion-bond PDA can be derived",
    );
  }

  const creatorBond =
    creatorCompletionBond ??
    (await findCreatorCompletionBondPda({
      task: rest.task,
      creator: rest.creator,
    }))[0];
  const workerBond =
    workerCompletionBond ??
    (await findWorkerCompletionBondPda({
      task: rest.task,
      workerAuthority,
    }))[0];

  return getResolveDisputeInstructionAsync({
    ...rest,
    creatorCompletionBond: creatorBond,
    workerCompletionBond: workerBond,
  });
}

/**
 * Build an expire_dispute instruction.
 *
 * Like resolve_dispute, the completion-bond accounts are REQUIRED and NOT
 * auto-derived, so the facade derives the creator/worker completion-bond PDAs and
 * passes them. Escrow, protocol-config, hire-record, and token program auto-derive.
 *
 * Pass the worker's *authority* (wallet) that posted the bond as `workerBondAuthority`;
 * it defaults to `workerWallet` when present.
 */
export async function expireDispute(
  input: Omit<
    ExpireDisputeAsyncInput,
    "creatorCompletionBond" | "workerCompletionBond"
  > & {
    /** Authority (wallet) that posted the worker completion bond. */
    workerBondAuthority?: Address;
    /** Optional pre-derived overrides; derived from task/creator/worker when omitted. */
    creatorCompletionBond?: Address;
    workerCompletionBond?: Address;
  },
) {
  const { workerBondAuthority, creatorCompletionBond, workerCompletionBond, ...rest } =
    input;

  const workerAuthority =
    workerBondAuthority ?? (rest.workerWallet as Address | undefined);
  if (!workerAuthority) {
    throw new Error(
      "expireDispute: provide workerBondAuthority (or workerWallet) so the worker completion-bond PDA can be derived",
    );
  }

  const creatorBond =
    creatorCompletionBond ??
    (await findCreatorCompletionBondPda({
      task: rest.task,
      creator: rest.creator,
    }))[0];
  const workerBond =
    workerCompletionBond ??
    (await findWorkerCompletionBondPda({
      task: rest.task,
      workerAuthority,
    }))[0];

  return getExpireDisputeInstructionAsync({
    ...rest,
    creatorCompletionBond: creatorBond,
    workerCompletionBond: workerBond,
  });
}

/** Build a cancel_dispute instruction (initiator-only). protocol-config auto-derives. */
export async function cancelDispute(input: CancelDisputeAsyncInput) {
  return getCancelDisputeInstructionAsync(input);
}

/** Build an apply_dispute_slash instruction. protocol-config + token program auto-derive. */
export async function applyDisputeSlash(input: ApplyDisputeSlashAsyncInput) {
  return getApplyDisputeSlashInstructionAsync(input);
}

/** Build an apply_initiator_slash instruction. protocol-config auto-derives. */
export async function applyInitiatorSlash(input: ApplyInitiatorSlashAsyncInput) {
  return getApplyInitiatorSlashInstructionAsync(input);
}

/**
 * Build a resolve_reject_frozen instruction. The completion-bond PDAs here ARE
 * auto-derived by the generated builder (from task/creator and task/worker-authority),
 * along with escrow, the task submission, and protocol-config.
 */
export async function resolveRejectFrozen(
  input: ResolveRejectFrozenAsyncInput,
) {
  return getResolveRejectFrozenInstructionAsync(input);
}

/**
 * Build an expire_reject_frozen instruction. Escrow, task submission, and
 * protocol-config auto-derive in the generated builder, but — unlike
 * resolve_reject_frozen — the completion-bond PDAs are NOT auto-derived there, so the
 * facade derives them from [task, creator] / [task, workerAuthority] and passes them.
 * This keeps the bond forfeit un-bypassable: callers cannot omit a live bond. (settle
 * no-ops when only the empty PDA exists.)
 */
export async function expireRejectFrozen(input: ExpireRejectFrozenAsyncInput) {
  const creatorCompletionBond =
    input.creatorCompletionBond ??
    (await findCreatorCompletionBondPda({
      task: input.task,
      creator: input.creator,
    }))[0];
  const workerCompletionBond =
    input.workerCompletionBond ??
    (await findWorkerCompletionBondPda({
      task: input.task,
      workerAuthority: input.workerAuthority,
    }))[0];

  return getExpireRejectFrozenInstructionAsync({
    ...input,
    creatorCompletionBond,
    workerCompletionBond,
  });
}

/**
 * Build an assign_dispute_resolver instruction (authority-only).
 *
 * Adds `resolver` to the dispute-resolver roster so that wallet can resolve disputes
 * directly (no vote tally, no quorum). The `disputeResolver` roster PDA (seeded by
 * `resolver`), `protocolConfig`, and `systemProgram` all auto-derive in the generated
 * builder — the caller supplies only the `authority` signer and the `resolver` pubkey.
 */
export async function assignDisputeResolver(
  input: AssignDisputeResolverAsyncInput,
) {
  return getAssignDisputeResolverInstructionAsync(input);
}

/**
 * Build a revoke_dispute_resolver instruction (authority-only).
 *
 * Removes a wallet from the dispute-resolver roster, closing its assignment PDA. The
 * generated builder does NOT derive the roster PDA (its on-chain seed reads the stored
 * `resolver`), so the facade derives it from the `resolver` pubkey when `disputeResolver`
 * is not passed explicitly. protocolConfig still auto-derives.
 */
export async function revokeDisputeResolver(
  input: Omit<RevokeDisputeResolverAsyncInput, "disputeResolver"> & {
    /** The roster member being removed. Used to derive the assignment PDA. */
    resolver?: Address;
    /** Optional pre-derived override for the assignment PDA. */
    disputeResolver?: Address;
  },
) {
  const { resolver, disputeResolver, ...rest } = input;
  let roster = disputeResolver;
  if (!roster) {
    if (!resolver) {
      throw new Error(
        "revokeDisputeResolver: provide resolver (or disputeResolver) so the roster PDA can be derived",
      );
    }
    roster = (await findDisputeResolverPda({ resolver }))[0];
  }
  return getRevokeDisputeResolverInstructionAsync({
    ...rest,
    disputeResolver: roster,
  });
}
