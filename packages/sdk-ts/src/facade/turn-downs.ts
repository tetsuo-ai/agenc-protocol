// Facade: revision 9 readers for turn-downs (disputable freezes), dispute
// bonds and creator records.
//
// A turn-down on a single-worker review task is a `reject_and_freeze`. On a
// revision 9 freeze (`freeze_kind == 1`) the worker may dispute it inside the
// dispute window by posting a bond; with no dispute the buyer is refunded when
// the window ends; a disputed turn-down is ruled by the 2-of-3 multisig, and an
// unruled one also refunds the buyer and returns the bond. A revision 8 freeze
// (`freeze_kind == 0`) keeps its old rules: after its review time the worker is
// paid. These readers tell the two apart so no client reports a refund as a
// payment, or the reverse.
//
// "No bond" is decided by ownership, never by balance: anyone can send lamports
// to the canonical bond address, so a system-owned account there is "no bond".
import {
  fetchEncodedAccount,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findClaimPda,
  findCreatorStatsPda,
  findDisputeBondPda,
  findDisputeRejectionDisputeBondPda,
  findTaskSubmissionPda,
  findWorkerStatsPda,
  getAgentStatsDiscriminatorBytes,
  getAgentStatsSize,
  getCreatorStatsDecoder,
  getCreatorStatsDiscriminatorBytes,
  getCreatorStatsSize,
  getDisputeBondDecoder,
  getDisputeBondDiscriminatorBytes,
  getTaskDecoder,
  getTaskDiscriminatorBytes,
  getTaskSubmissionDecoder,
  getTaskSubmissionDiscriminatorBytes,
  TaskStatus,
  type CreatorStats,
  type DisputeBond,
  type Task,
  type TaskSubmission,
} from "../generated/index.js";
import {
  disputeBondForTask,
  isDisputableFreeze,
  submissionFreezeKind,
} from "../values/protocol-limits.js";

/** The owner and bytes of an account, as any RPC `getAccountInfo` returns them. */
export type ProgramAccountSnapshot = {
  readonly owner: Address;
  readonly data: Uint8Array | ReadonlyUint8Array;
};

/** Reads one account with its owner, or `null` when it does not exist. */
export type ReadAccountSnapshot = (
  account: Address,
) => Promise<ProgramAccountSnapshot | null>;

/**
 * Adapt a `@solana/kit` RPC into a {@link ReadAccountSnapshot}. Clients that
 * already read accounts with their owner (a wallet's chain, a worker's
 * `readAccountInfo`) can pass their own reader instead.
 */
export function accountSnapshotReader(
  rpc: Parameters<typeof fetchEncodedAccount>[0],
): ReadAccountSnapshot {
  return async (account) => {
    const encoded = await fetchEncodedAccount(rpc, account);
    if (!encoded.exists) return null;
    return { owner: encoded.programAddress, data: encoded.data };
  };
}

function startsWith(
  data: Uint8Array | ReadonlyUint8Array,
  prefix: ReadonlyUint8Array,
): boolean {
  if (data.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (data[index] !== prefix[index]) return false;
  }
  return true;
}

function decodeProgramAccount<T>(
  account: ProgramAccountSnapshot | null,
  discriminator: ReadonlyUint8Array,
  decode: (data: Uint8Array) => T,
  label: string,
): T | null {
  if (account === null) return null;
  if (account.owner !== AGENC_COORDINATION_PROGRAM_ADDRESS) return null;
  if (account.data.length === 0) return null;
  if (!startsWith(account.data, discriminator)) {
    throw new Error(
      `${label}: a program account at this address is not a ${label}`,
    );
  }
  return decode(new Uint8Array(account.data));
}

/**
 * Decode a `DisputeBond`, or `null` when the address holds no bond (missing,
 * or a system-owned account, which anyone may fund).
 */
export function decodeDisputeBond(
  account: ProgramAccountSnapshot | null,
): DisputeBond | null {
  return decodeProgramAccount(
    account,
    getDisputeBondDiscriminatorBytes(),
    (data) => getDisputeBondDecoder().decode(data),
    "DisputeBond",
  );
}

/** Decode a `CreatorStats`, or `null` when the record does not exist yet. */
export function decodeCreatorStats(
  account: ProgramAccountSnapshot | null,
): CreatorStats | null {
  return decodeProgramAccount(
    account,
    getCreatorStatsDiscriminatorBytes(),
    (data) => getCreatorStatsDecoder().decode(data),
    "CreatorStats",
  );
}

/** `DisputeBond.kind` for a dispute of a turn-down, at `["dispute_bond", task]`. */
export const DISPUTE_BOND_KIND_REJECTION = 0;

/** `DisputeBond.kind` for a task dispute, at `["dispute_bond", dispute]`. */
export const DISPUTE_BOND_KIND_TASK_DISPUTE = 1;

/** The bond of a turn-down dispute: `["dispute_bond", task]`. */
export async function findRejectionDisputeBondPda(
  task: Address,
): Promise<Address> {
  return (await findDisputeRejectionDisputeBondPda({ task }))[0];
}

/** The bond of a task dispute: `["dispute_bond", dispute]`. */
export async function findTaskDisputeBondPda(
  dispute: Address,
): Promise<Address> {
  return (await findDisputeBondPda({ dispute }))[0];
}

/** Where a turned-down task stands. */
export type TurnDownStage =
  /** Revision 9, not disputed: the worker may still dispute it. */
  | "dispute_window"
  /** Revision 9, not disputed, window over: an expiry refunds the buyer. */
  | "refund_due"
  /** Revision 9, disputed: the multisig may rule until the bond's deadline. */
  | "awaiting_ruling"
  /** Revision 9, disputed, not ruled in time: an expiry refunds the buyer and returns the bond. */
  | "unruled_refund_due"
  /** Revision 8 freeze, review time running: the multisig may rule. */
  | "legacy_review"
  /** Revision 8 freeze, review time over: an expiry pays the worker. */
  | "legacy_payout_due";

/** A frozen (turned-down) task, read from its submission and bond. */
export type TurnDown = {
  task: Address;
  claim: Address;
  submission: Address;
  /** `freeze_kind` of the submission: 1 = revision 9, 0 = revision 8. */
  freezeKind: number;
  /** Whether this is a revision 9 turn-down the worker may dispute. */
  disputable: boolean;
  /**
   * Unix seconds. Revision 9: the last second the worker may dispute.
   * Revision 8: the end of the review time, after which the worker is paid.
   */
  reviewDeadlineAt: bigint;
  /** Lamports a dispute would post as its bond (the bond account's rent comes on top and always comes back). */
  bondToDispute: bigint;
  /** The posted bond, when the worker disputed. */
  dispute: {
    bond: Address;
    amount: bigint;
    filer: Address;
    respondent: Address;
    filedAt: bigint;
    /** Unix seconds: the last second the multisig may rule. */
    rulingDeadline: bigint;
  } | null;
};

/**
 * Read a turned-down task: whether it is a revision 9 turn-down, its deadline,
 * the bond a dispute would cost, and the bond if one was posted. Returns `null`
 * unless the task exists, is `RejectFrozen`, and `worker`'s submission is the
 * frozen one.
 *
 * @param read - an owner-aware account reader ({@link accountSnapshotReader}).
 * @param input - the task and the claim's worker agent.
 */
export async function readTurnDown(
  read: ReadAccountSnapshot,
  input: { task: Address; worker: Address },
): Promise<TurnDown | null> {
  const task = decodeProgramAccount<Task>(
    await read(input.task),
    getTaskDiscriminatorBytes(),
    (data) => getTaskDecoder().decode(data),
    "Task",
  );
  if (task === null || task.status !== TaskStatus.RejectFrozen) return null;
  const [claim] = await findClaimPda({ task: input.task, bidder: input.worker });
  const [submissionAddress] = await findTaskSubmissionPda({ claim });
  const submission = decodeProgramAccount<TaskSubmission>(
    await read(submissionAddress),
    getTaskSubmissionDiscriminatorBytes(),
    (data) => getTaskSubmissionDecoder().decode(data),
    "TaskSubmission",
  );
  if (submission === null || submission.task !== input.task) return null;
  const bondAddress = await findRejectionDisputeBondPda(input.task);
  const disputable = isDisputableFreeze(submission);
  const bond = disputable ? decodeDisputeBond(await read(bondAddress)) : null;
  return {
    task: input.task,
    claim,
    submission: submissionAddress,
    freezeKind: submissionFreezeKind(submission),
    disputable,
    reviewDeadlineAt: submission.reviewDeadlineAt,
    bondToDispute: disputeBondForTask(task),
    dispute:
      bond === null
        ? null
        : {
            bond: bondAddress,
            amount: bond.amount,
            filer: bond.filer,
            respondent: bond.respondent,
            filedAt: bond.filedAt,
            rulingDeadline: bond.rulingDeadline,
          },
  };
}

/**
 * The stage of a turn-down at `nowSeconds` (the cluster clock). The windows are
 * inclusive at their last second, as on chain: a dispute or a ruling may land
 * while `now <= deadline`, and the expiry needs `now > deadline`.
 */
export function turnDownStage(
  turnDown: Pick<TurnDown, "disputable" | "reviewDeadlineAt" | "dispute">,
  nowSeconds: bigint | number,
): TurnDownStage {
  const now = BigInt(nowSeconds);
  if (!turnDown.disputable) {
    return now > turnDown.reviewDeadlineAt
      ? "legacy_payout_due"
      : "legacy_review";
  }
  if (turnDown.dispute === null) {
    return now > turnDown.reviewDeadlineAt ? "refund_due" : "dispute_window";
  }
  return now > turnDown.dispute.rulingDeadline
    ? "unruled_refund_due"
    : "awaiting_ruling";
}

/**
 * Whether an `expire_reject_frozen` sent at this stage pays the worker (only a
 * revision 8 freeze does). Every revision 9 expiry refunds the buyer.
 */
export function turnDownExpiryPaysWorker(stage: TurnDownStage): boolean {
  return stage === "legacy_payout_due";
}

/** One revision 9 record a transaction would create when it is missing. */
export type RecordCostEntry = {
  address: Address;
  exists: boolean;
  /** Its rent-exempt minimum, read live (0 when it exists). Never returned. */
  lamports: bigint;
};

/** What a sender pays for records that do not exist yet. */
export type MissingRecordCost = {
  /** Total lamports for the missing records, on top of the transaction fee. */
  lamports: bigint;
  creatorRecord: RecordCostEntry | null;
  workerRecord: RecordCostEntry | null;
};

function hasProgramAccount(
  account: ProgramAccountSnapshot | null,
  discriminator: ReadonlyUint8Array,
): boolean {
  return (
    account !== null &&
    account.owner === AGENC_COORDINATION_PROGRAM_ADDRESS &&
    startsWith(account.data, discriminator)
  );
}

/**
 * What a revision 9 instruction charges its sender for records that do not
 * exist yet. The program creates a missing record and the signer pays its rent,
 * which is never returned:
 * - the creator's record (`CreatorStats`, keyed by the task creator's wallet):
 *   at the creator's first `cancelTask` or `rejectAndFreeze`, and on rulings,
 *   expiries and dispute cancels of a creator that has none yet;
 * - the worker's record (`AgentStats`): created at every revision 9 claim, so
 *   only exits of a claim made before revision 9 pay for it.
 *
 * Show this before asking a wallet to sign, and warn when the balance cannot
 * cover it: a nearly empty wallet must add SOL before it can cancel. The rent
 * is read live from `getMinimumBalanceForRentExemption`; never assume an amount.
 */
export async function missingRecordCost(
  read: ReadAccountSnapshot,
  getMinimumBalanceForRentExemption: (space: number) => Promise<bigint>,
  parties: { creator?: Address; workerAgent?: Address },
): Promise<MissingRecordCost> {
  const entry = async (
    address: Address,
    discriminator: ReadonlyUint8Array,
    size: number,
  ): Promise<RecordCostEntry> => {
    const exists = hasProgramAccount(await read(address), discriminator);
    return {
      address,
      exists,
      lamports: exists ? 0n : await getMinimumBalanceForRentExemption(size),
    };
  };
  const creatorRecord =
    parties.creator === undefined
      ? null
      : await entry(
          (await findCreatorStatsPda({ authority: parties.creator }))[0],
          getCreatorStatsDiscriminatorBytes(),
          getCreatorStatsSize(),
        );
  const workerRecord =
    parties.workerAgent === undefined
      ? null
      : await entry(
          (await findWorkerStatsPda({ worker: parties.workerAgent }))[0],
          getAgentStatsDiscriminatorBytes(),
          getAgentStatsSize(),
        );
  return {
    lamports: (creatorRecord?.lamports ?? 0n) + (workerRecord?.lamports ?? 0n),
    creatorRecord,
    workerRecord,
  };
}

/** A task creator's revision 9 record, keyed by its wallet. */
export type CreatorTrackRecord = {
  wallet: Address;
  creatorStats: Address;
  /** Whether the record exists yet (it starts at the first freeze, cancel or dispute). */
  hasStats: boolean;
  counters: {
    rejections: bigint;
    rejectionsContested: bigint;
    disputesWon: bigint;
    disputesLost: bigint;
    cancels: bigint;
    depositsReceived: bigint;
  };
};

/**
 * Read a creator's record (`CreatorStats`). A wallet that has not frozen,
 * cancelled or disputed since revision 9 has none; all counters then read 0.
 */
export async function getCreatorTrackRecord(
  read: ReadAccountSnapshot,
  wallet: Address,
): Promise<CreatorTrackRecord> {
  const [creatorStats] = await findCreatorStatsPda({ authority: wallet });
  const stats = decodeCreatorStats(await read(creatorStats));
  return {
    wallet,
    creatorStats,
    hasStats: stats !== null,
    counters: {
      rejections: stats?.rejections ?? 0n,
      rejectionsContested: stats?.rejectionsContested ?? 0n,
      disputesWon: stats?.disputesWon ?? 0n,
      disputesLost: stats?.disputesLost ?? 0n,
      cancels: stats?.cancels ?? 0n,
      depositsReceived: stats?.depositsReceived ?? 0n,
    },
  };
}
