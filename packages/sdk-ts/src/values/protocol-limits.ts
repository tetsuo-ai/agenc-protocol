// Public client-side mirrors of protocol limits that affect transaction
// construction. Keep these values aligned with the Rust constants and cover
// each mirror with a cross-source drift test.

/**
 * Maximum number of simultaneous workers admitted to a newly-created
 * collaborative or competitive task.
 *
 * Legacy task accounts can still contain a historical `maxWorkers` value up
 * to 100, but revision 5 clamps their live claim capacity to this value. New
 * public facade task builders reject values above this limit.
 */
export const DISPUTE_SAFE_MAX_WORKERS = 4 as const;

// ---------------------------------------------------------------------------
// Revision 9 (accountable review): claim deposits, dispute bonds and windows.
// Mirrors programs/agenc-coordination/src/instructions/constants.rs and the
// pure helpers in claim_deposit_helpers.rs and dispute_bond_helpers.rs.
// ---------------------------------------------------------------------------

/** Basis-point divisor used by every revision 9 rate. */
const BASIS_POINTS_DIVISOR = 10_000n;

/** Claim deposit rate: 10% of the worker's share, in basis points. */
export const CLAIM_DEPOSIT_BPS = 1_000n;

/** Claim deposit floor: 0.005 SOL. */
export const MIN_CLAIM_DEPOSIT_LAMPORTS = 5_000_000n;

/** Dispute bond rate: 10% of the disputed amount, in basis points. */
export const DISPUTE_BOND_BPS = 1_000n;

/** Dispute bond floor: 0.01 SOL. */
export const MIN_DISPUTE_BOND_LAMPORTS = 10_000_000n;

/**
 * Seconds after claiming during which `release_claim` returns the claim
 * deposit to the worker (production build: 1 hour). Later releases send the
 * deposit to the buyer. The `validation-timings` test build uses 60 seconds.
 */
export const CLAIM_RELEASE_GRACE_SECS = 3_600n;

/**
 * Seconds a worker has to dispute a revision 9 turn-down (production build:
 * 72 hours, whatever the buyer's review window was). The live deadline is
 * stored on the frozen `TaskSubmission.reviewDeadlineAt`; read that instead
 * of adding this to a timestamp. The `validation-timings` build uses 300.
 */
export const REJECT_DISPUTE_WINDOW_SECS = 259_200n;

/**
 * Seconds the 2-of-3 multisig has to rule on a disputed turn-down (production
 * build: 72 hours). The live deadline is stored on the `DisputeBond` as
 * `rulingDeadline`. The `validation-timings` build uses 300.
 */
export const REJECT_RULING_WINDOW_SECS = 259_200n;

/**
 * Floor on the resubmit window `request_changes` gives the worker
 * (production build: 24 hours). The `validation-timings` build uses 60.
 */
export const MIN_RESUBMIT_WINDOW_SECS = 86_400n;

/**
 * `TaskSubmission.reserved[2]` (`freeze_kind`) value for a revision 9 freeze
 * the worker may dispute. Zero means a revision 8 freeze, or a submission
 * that was never frozen.
 */
export const FREEZE_KIND_DISPUTABLE = 1;

/** Index of `freeze_kind` inside `TaskSubmission.reserved`. */
export const SUBMISSION_FREEZE_KIND_INDEX = 2;

/** The parts of a Task that decide its worker share. */
export type WorkerShareTask = {
  rewardAmount: bigint;
  /** `TaskType` as stored on chain (0 Exclusive, 1 Collaborative, 2 Competitive, 3 BidExclusive). */
  taskType: number;
  requiredCompletions: number;
  /** The task's reward mint: a kit `Option`, an address, or `null` for SOL. */
  rewardMint: { __option: "Some" | "None" } | string | null;
};

/** `TaskType::Collaborative` as stored on chain. */
const TASK_TYPE_COLLABORATIVE = 1;

function hasTokenReward(rewardMint: WorkerShareTask["rewardMint"]): boolean {
  if (rewardMint === null) return false;
  if (typeof rewardMint === "string") return true;
  return rewardMint.__option === "Some";
}

function assertLamports(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} must be a u64 lamport amount`);
  }
}

/**
 * The worker's share of a task's reward, in lamports: the whole reward on a
 * single-worker task, `rewardAmount / requiredCompletions` (rounded down) on
 * a Collaborative task. A token-reward task has no SOL share and reads as 0,
 * so the SOL floors apply. Mirrors `sol_worker_share_lamports`.
 */
export function workerShareLamports(task: WorkerShareTask): bigint {
  assertLamports(task.rewardAmount, "workerShareLamports: rewardAmount");
  if (hasTokenReward(task.rewardMint)) return 0n;
  if (task.taskType === TASK_TYPE_COLLABORATIVE) {
    const parts = BigInt(Math.max(1, Math.trunc(task.requiredCompletions)));
    return task.rewardAmount / parts;
  }
  return task.rewardAmount;
}

function bpsWithFloor(amount: bigint, rateBps: bigint, floor: bigint): bigint {
  const scaled = (amount * rateBps) / BASIS_POINTS_DIVISOR;
  return scaled > floor ? scaled : floor;
}

/**
 * Claim deposit for a worker share: `max(share x 10%, 0.005 SOL)`. Mirrors
 * `claim_deposit_lamports`.
 */
export function claimDepositLamports(share: bigint): bigint {
  assertLamports(share, "claimDepositLamports: share");
  return bpsWithFloor(share, CLAIM_DEPOSIT_BPS, MIN_CLAIM_DEPOSIT_LAMPORTS);
}

/**
 * The deposit a claim made through `claim_task_with_job_spec` puts down on
 * this task. It comes back on the first delivery; it goes to the buyer when
 * the claim ends without one after its expiry. Contest claims carry their own
 * 0.01 SOL entry deposit instead (see `CONTEST_ENTRY_DEPOSIT_LAMPORTS`), so
 * pass `contest: true` for them and this returns 0.
 */
export function claimDepositForTask(
  task: WorkerShareTask,
  options: { contest?: boolean } = {},
): bigint {
  if (options.contest === true) return 0n;
  return claimDepositLamports(workerShareLamports(task));
}

/**
 * Bond for a disputed amount: `max(amount x 10%, 0.01 SOL)`. Mirrors
 * `dispute_bond_lamports`.
 */
export function disputeBondLamports(disputedAmount: bigint): bigint {
  assertLamports(disputedAmount, "disputeBondLamports: disputedAmount");
  return bpsWithFloor(disputedAmount, DISPUTE_BOND_BPS, MIN_DISPUTE_BOND_LAMPORTS);
}

/**
 * The bond a filer posts to dispute on this task: 10% of the reward on a
 * single-worker task, of the defendant's share on a Collaborative task, with
 * the 0.01 SOL floor. A token-reward task pays the floor. Mirrors
 * `dispute_bond_for_task`. The bond is held above the `DisputeBond` account's
 * rent, which the filer also pays and always gets back.
 */
export function disputeBondForTask(task: WorkerShareTask): bigint {
  return disputeBondLamports(workerShareLamports(task));
}

/** `freeze_kind` of a `TaskSubmission` (its `reserved[2]` byte). */
export function submissionFreezeKind(submission: {
  reserved: ArrayLike<number>;
}): number {
  return submission.reserved[SUBMISSION_FREEZE_KIND_INDEX] ?? 0;
}

/**
 * Whether a frozen submission is a revision 9 turn-down the worker may
 * dispute (`freeze_kind == 1`). A revision 8 freeze (0) keeps the old rules:
 * after `reviewDeadlineAt` the worker is paid, and nobody files a dispute.
 */
export function isDisputableFreeze(submission: {
  reserved: ArrayLike<number>;
}): boolean {
  return submissionFreezeKind(submission) === FREEZE_KIND_DISPUTABLE;
}
