// What a worker does for its own jobs so it is paid and stays able to work,
// without depending on anyone else's software:
//
// - A delivery the buyer never reviews is paid by auto-accept once its review
//   window has passed. Anyone may send it; the worker sends it for its own
//   deliveries, so a provider whose buyer goes quiet is still paid.
// - A claim the worker can no longer use (a job it gave up, or one whose
//   time ran out) is released: given back at once while the program allows
//   it (release_claim), expired once its time is over, or reclaimed when the
//   task has already ended. That returns the claim's rent and frees one of
//   the agent's limited active-task slots.
// - A delivery the buyer turned down (revision 9) is shown with its dispute
//   deadline and the bond a dispute would cost. The worker disputes it only
//   when its operator turned that policy on. Once a turn-down's window is
//   over, the worker sends the expiry: that returns its claim and submission
//   rent (and a bond nobody ruled on), or pays it for a revision 8 freeze.
//
// Every step reads the chain first and sends at most one transaction per job,
// signed by the worker's own wallet. Nothing here runs or delivers work.
import { address, unwrapOption, type Address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  AgencError,
  facade,
  findClaimPda,
  findProtocolConfigPda,
  findTaskSubmissionPda,
  findTaskValidationConfigPda,
  findWorkerCompletionBondPda,
  getProtocolConfigDecoder,
  getTaskClaimDecoder,
  getTaskSubmissionDecoder,
  getTaskValidationConfigDecoder,
  SubmissionStatus,
  TaskStatus,
  TaskType,
  type Task,
  type TaskClaim,
  type TaskSubmission,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import { formatDiagnosticError, redactSensitiveText } from "./redact.js";
import type { WorkerAgent, WorkerContext } from "./runtime.js";
import { loadState, saveState, type FailedJob } from "./state.js";

const CLOCK_SYSVAR = address("SysvarC1ock11111111111111111111111111111111");

/** The cluster's clock in unix seconds, as well as this worker can tell. */
export async function clusterNowSeconds(ctx: WorkerContext): Promise<number> {
  if (ctx.clusterTime !== undefined) {
    try {
      const seconds = await ctx.clusterTime();
      if (Number.isFinite(seconds)) return seconds;
    } catch {
      // Fall back to the sysvar below.
    }
  }
  try {
    const data = await ctx.readAccount(CLOCK_SYSVAR);
    if (data !== null && data.byteLength >= 40) {
      return Number(
        new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(
          32,
          true,
        ),
      );
    }
  } catch {
    // Fall back to this computer's clock.
  }
  return Math.floor(Date.now() / 1_000);
}

/** Seconds a failed upkeep transaction waits before it is sent again. */
export const UPKEEP_RETRY_SECONDS = 60;
const DEFAULT_ADDRESS = "11111111111111111111111111111111";

/** What one upkeep pass did, for callers and tests. */
export type UpkeepReport = {
  /** Deliveries this worker auto-accepted (task PDAs). */
  autoAccepted: Address[];
  /** Claims released, and how. */
  released: Array<{
    task: Address;
    how: "released" | "expired" | "reclaimed" | "closed";
  }>;
  /** Turned-down deliveries this worker disputed or collected. */
  turnDowns: Array<{ task: Address; action: "disputed" | "collected" }>;
};

/**
 * Remembers when a transaction for a job was last tried, so a failing one is
 * not sent on every poll. Kept in memory: a restart may try once more early,
 * which costs nothing when it is refused before it is sent.
 */
export type UpkeepMemory = Map<string, number>;

/**
 * What a task's address holds. Revision 9: `close_task` compacts a finished
 * task into a 56-byte TaskMarker, which reads as `closed` instead of
 * failing to decode as a Task.
 */
export async function readTaskAccount(
  ctx: WorkerContext,
  task: Address,
): Promise<facade.TaskAccountRead> {
  // A task lives at a program-derived address, so bytes there can only have
  // been written by the program: read the bytes, as the worker always did.
  const data = await ctx.readAccount(task);
  return facade.decodeTaskAccount(
    data === null || data.byteLength === 0
      ? null
      : { owner: AGENC_COORDINATION_PROGRAM_ADDRESS, data },
  );
}

/** The Task, or null when it is gone or closed (nothing left to upkeep). */
async function readTask(ctx: WorkerContext, task: Address): Promise<Task | null> {
  const read = await readTaskAccount(ctx, task);
  return read.kind === "task" ? read.task : null;
}

async function readClaim(
  ctx: WorkerContext,
  agent: WorkerAgent,
  task: Address,
): Promise<TaskClaim | null> {
  const [claim] = await findClaimPda({ task, bidder: agent.agentPda });
  const data = await ctx.readAccount(claim);
  if (data === null) return null;
  const decoded = getTaskClaimDecoder().decode(data);
  return decoded.task === task && decoded.worker === agent.agentPda ? decoded : null;
}

async function readSubmission(
  ctx: WorkerContext,
  agent: WorkerAgent,
  task: Address,
): Promise<TaskSubmission | null> {
  const [claim] = await findClaimPda({ task, bidder: agent.agentPda });
  const [submission] = await findTaskSubmissionPda({ claim });
  const data = await ctx.readAccount(submission);
  if (data === null) return null;
  const decoded = getTaskSubmissionDecoder().decode(data);
  return decoded.task === task && decoded.worker === agent.agentPda ? decoded : null;
}

async function readTreasury(ctx: WorkerContext): Promise<Address> {
  const [config] = await findProtocolConfigPda();
  const data = await ctx.readAccount(config);
  if (data === null) throw new Error("the protocol config is unavailable");
  return getProtocolConfigDecoder().decode(data).treasury;
}

/**
 * Seconds a task's review clock was stopped (time spent disputed while every
 * creator review action was refused). Auto-accept waits that much longer.
 */
async function reviewDebtSeconds(ctx: WorkerContext, task: Address): Promise<number> {
  const [config] = await findTaskValidationConfigPda({ task });
  const data = await ctx.readAccount(config);
  if (data === null) return 0;
  const reserved = getTaskValidationConfigDecoder().decode(data).reserved;
  if (reserved.length < 7) return 0;
  return (
    reserved[3]! |
    (reserved[4]! << 8) |
    (reserved[5]! << 16) |
    ((reserved[6]! << 24) >>> 0)
  ) >>> 0;
}

function due(memory: UpkeepMemory, key: string, now: number): boolean {
  const last = memory.get(key);
  return last === undefined || now - last >= UPKEEP_RETRY_SECONDS;
}

function failureText(error: unknown): string {
  return redactSensitiveText(
    error instanceof AgencError
      ? `${error.errorName ?? "AgencError"}: ${error.message}`
      : formatDiagnosticError(error),
  );
}

function legs(task: Task): { operator?: Address; referrer?: Address } {
  return {
    ...(task.operator !== DEFAULT_ADDRESS && task.operatorFeeBps > 0
      ? { operator: task.operator }
      : {}),
    ...(task.referrer !== DEFAULT_ADDRESS && task.referrerFeeBps > 0
      ? { referrer: task.referrer }
      : {}),
  };
}

/**
 * Auto-accept this worker's own deliveries whose review window has passed.
 * The settlement itself is then observed by `checkSettlements` as for any
 * accept. Contests cannot be auto-accepted and are left alone.
 */
export async function collectOverdueReviews(
  ctx: WorkerContext,
  agent: WorkerAgent,
  memory: UpkeepMemory = new Map(),
): Promise<Address[]> {
  if (ctx.dryRun || !agent.registered) return [];
  const pending = loadState(ctx.stateDir).submissions.filter((record) => !record.settled);
  if (pending.length === 0) return [];
  const accepted: Address[] = [];
  let now: number | null = null;
  let treasury: Address | null = null;
  for (const record of pending) {
    const task = record.task as Address;
    const decoded = await readTask(ctx, task);
    if (decoded === null || decoded.status !== TaskStatus.PendingValidation) continue;
    if (decoded.taskType === TaskType.Competitive) continue;
    const submission = await readSubmission(ctx, agent, task);
    if (submission === null || submission.status !== SubmissionStatus.Submitted) continue;
    now ??= await clusterNowSeconds(ctx);
    const reviewEnds =
      Number(submission.reviewDeadlineAt) + (await reviewDebtSeconds(ctx, task));
    if (reviewEnds <= 0 || now < reviewEnds) continue;
    const key = `accept:${task}`;
    if (!due(memory, key, now)) continue;
    memory.set(key, now);
    try {
      treasury ??= await readTreasury(ctx);
      const parent = unwrapOption(decoded.dependsOn);
      const { signature } = await ctx.client.autoAcceptTaskResult(
        {
          task,
          worker: agent.agentPda,
          treasury,
          creator: decoded.creator,
          workerAuthority: ctx.signer.address,
          authority: ctx.signer,
          ...legs(decoded),
          ...(parent !== null ? { dependencyParent: parent } : {}),
        },
        { maxRetries: 0 },
      );
      accepted.push(task);
      ctx.log({ event: "settlement.auto-accepted", task, signature });
    } catch (error) {
      ctx.log({
        event: "settlement.auto-accept-failed",
        task,
        reason: failureText(error),
      });
    }
  }
  return accepted;
}

/** An owner-aware reader for the SDK's turn-down readers. */
function snapshotReader(ctx: WorkerContext): facade.ReadAccountSnapshot {
  if (ctx.readAccountInfo !== undefined) {
    const readInfo = ctx.readAccountInfo;
    return async (account) => {
      const info = await readInfo(account);
      return info === null ? null : { owner: info.owner, data: info.data };
    };
  }
  // Without owners, data at a program-derived address can only have been
  // written by the program that owns it; an empty account reads as no account.
  return async (account) => {
    const data = await ctx.readAccount(account);
    return data === null || data.byteLength === 0
      ? null
      : { owner: AGENC_COORDINATION_PROGRAM_ADDRESS, data };
  };
}

/** The live claim's task is a contest or a bid task, which release_claim refuses. */
function releaseRefusedFor(task: Task): boolean {
  return (
    task.taskType === TaskType.Competitive ||
    task.taskType === TaskType.BidExclusive
  );
}

/** The task's validation config, or null when it has none (an Auto task). */
async function validationConfigOrNull(
  ctx: WorkerContext,
  task: Address,
): Promise<Address | null> {
  const [config] = await findTaskValidationConfigPda({ task });
  return (await ctx.readAccount(config)) === null ? null : config;
}

/**
 * Give a live, undelivered claim back now (revision 9 `release_claim`). Within
 * the first hour of the claim the deposit comes back to this worker; later it
 * goes to the buyer, as an expiry would send it, but the slot is free now.
 */
export async function sendReleaseClaim(
  ctx: WorkerContext,
  agent: WorkerAgent,
  task: Address,
  decoded: Task,
): Promise<string> {
  const { signature } = await ctx.client.send(
    [
      await facade.releaseClaim({
        task,
        worker: agent.agentPda,
        creator: decoded.creator,
        authority: ctx.signer,
        taskValidationConfig: await validationConfigOrNull(ctx, task),
      }),
    ],
    { maxRetries: 0 },
  );
  return signature;
}

function markReleased(ctx: WorkerContext, task: Address): void {
  const state = loadState(ctx.stateDir);
  const job = state.failedJobs.find((entry) => entry.task === task);
  if (job === undefined || job.claimReleased) return;
  job.claimReleased = true;
  saveState(ctx.stateDir, state);
}

/** The same revision 9 cleanup instruction for automatic and owner-approved work. */
export async function cleanupClaimInstruction(
  ctx: WorkerContext, agent: WorkerAgent, task: Address, data: Task, treasury: Address, terminal: boolean,
) {
  const accounts = { authority: ctx.signer, task, worker: agent.agentPda, treasury,
    rentRecipient: ctx.signer.address, creator: data.creator,
    ...(data.constraintHash.every(byte => byte === 0) && { taskValidationConfig: AGENC_COORDINATION_PROGRAM_ADDRESS }) };
  if (terminal) return facade.reclaimTerminalClaim(accounts);
  const parent = unwrapOption(data.dependsOn);
  const [workerCompletionBond] = await findWorkerCompletionBondPda({ task, workerAuthority: ctx.signer.address });
  return facade.expireClaim({ ...accounts, workerCompletionBond, ...(parent && { dependencyParent: parent }) });
}

/**
 * Release the claims of jobs this worker gave up. An ended task's claim is
 * reclaimed straight away. A live, undelivered claim is given back at once
 * with release_claim where the program allows it (not contests or bid tasks):
 * within the first hour of the claim its deposit comes back, later it goes to
 * the buyer, as an expiry would send it. Any other live claim is expired once
 * its time is over. Each returns the claim's rent to this worker and frees its
 * slot. Revision 9 requires the worker's own record on every expiry; the
 * worker's first claim created it.
 */
export async function releaseOwnClaims(
  ctx: WorkerContext,
  agent: WorkerAgent,
  memory: UpkeepMemory = new Map(),
): Promise<UpkeepReport["released"]> {
  if (ctx.dryRun || !agent.registered) return [];
  const waiting: FailedJob[] = loadState(ctx.stateDir).failedJobs.filter(
    (job) => !job.claimReleased,
  );
  const released: UpkeepReport["released"] = [];
  let now: number | null = null;
  let treasury: Address | null = null;
  for (const job of waiting) {
    const task = job.task as Address;
    const claim = await readClaim(ctx, agent, task);
    if (claim === null) {
      // Someone else's transaction closed it (a cancel returns it too).
      markReleased(ctx, task);
      released.push({ task, how: "closed" });
      ctx.log({ event: "claim.released", task, how: "closed" });
      continue;
    }
    if (job.chosen) continue; // Only the owner may spend to close this claim.
    const decoded = await readTask(ctx, task);
    if (decoded === null) continue;
    now ??= await clusterNowSeconds(ctx);
    const ended =
      decoded.status === TaskStatus.Completed || decoded.status === TaskStatus.Cancelled;
    const live =
      decoded.status === TaskStatus.InProgress ||
      decoded.status === TaskStatus.PendingValidation;
    const expired = live && claim.expiresAt > 0n && now > Number(claim.expiresAt);
    const releasable = live && !expired && !releaseRefusedFor(decoded);
    if (!ended && !expired && !releasable) continue;
    if (expired || releasable) {
      // A claim with a delivery waiting for review is settled by the review,
      // never expired or released.
      const submission = await readSubmission(ctx, agent, task);
      if (submission !== null && submission.status === SubmissionStatus.Submitted) continue;
    }
    const key = `release:${task}`;
    if (!due(memory, key, now)) continue;
    memory.set(key, now);
    try {
      if (releasable) {
        const signature = await sendReleaseClaim(ctx, agent, task, decoded);
        markReleased(ctx, task);
        released.push({ task, how: "released" });
        ctx.log({
          event: "claim.released",
          task,
          how: "released",
          signature,
          depositBack:
            now <= Number(claim.claimedAt) + Number(values.CLAIM_RELEASE_GRACE_SECS),
        });
        continue;
      }
      treasury ??= await readTreasury(ctx);
      const instruction = await cleanupClaimInstruction(ctx, agent, task, decoded, treasury, ended);
      const { signature } = await ctx.client.send([instruction], { maxRetries: 0 });
      markReleased(ctx, task);
      const how = ended ? "reclaimed" : "expired";
      released.push({ task, how });
      ctx.log({ event: "claim.released", task, how, signature });
    } catch (error) {
      ctx.log({ event: "claim.release-failed", task, reason: failureText(error) });
    }
  }
  return released;
}

/** Lamports kept free for fees when this worker posts a dispute bond. */
const DISPUTE_FEE_HEADROOM_LAMPORTS = 100_000n;
/** On-chain size of a `DisputeBond` account (its rent comes back with it). */
const DISPUTE_BOND_ACCOUNT_SIZE = 186;

/**
 * Handle this worker's deliveries that a buyer turned down (a task in
 * RejectFrozen). A revision 9 turn-down refunds the buyer unless the worker
 * disputes it inside the window and a ruling then goes its way.
 *
 * - Inside the dispute window the turn-down is logged once with its deadline
 *   and the bond a dispute costs. It is disputed only when the operator turned
 *   `disputeTurnDowns` on, and only when the wallet holds the bond, its account
 *   rent and fee headroom. The bond is lost if the ruling goes to the buyer.
 * - Once a window is over (no dispute, an unruled dispute, or a revision 8
 *   freeze's review time) the worker sends the expiry: it gets its claim and
 *   submission rent back, and its bond when nobody ruled. On a revision 8
 *   freeze the expiry pays it. `checkSettlements` then sees the outcome.
 */
export async function collectTurnDowns(
  ctx: WorkerContext,
  agent: WorkerAgent,
  memory: UpkeepMemory = new Map(),
): Promise<UpkeepReport["turnDowns"]> {
  if (ctx.dryRun || !agent.registered) return [];
  const pending = loadState(ctx.stateDir).submissions.filter((record) => !record.settled);
  if (pending.length === 0) return [];
  const read = snapshotReader(ctx);
  const done: UpkeepReport["turnDowns"] = [];
  let now: number | null = null;
  let treasury: Address | null = null;
  for (const record of pending) {
    const task = record.task as Address;
    const decoded = await readTask(ctx, task);
    if (decoded === null || decoded.status !== TaskStatus.RejectFrozen) continue;
    const turnDown = await facade.readTurnDown(read, { task, worker: agent.agentPda });
    if (turnDown === null) continue;
    now ??= await clusterNowSeconds(ctx);
    const stage = facade.turnDownStage(turnDown, now);
    const noted = `turn-down:${task}:${stage}`;
    if (!memory.has(noted)) {
      memory.set(noted, now);
      ctx.log({
        event: "task.turned-down",
        task,
        stage,
        disputeUntil: Number(turnDown.reviewDeadlineAt),
        ...(turnDown.dispute !== null
          ? { rulingUntil: Number(turnDown.dispute.rulingDeadline) }
          : { bondLamports: turnDown.bondToDispute.toString() }),
        disputePolicy: ctx.config.disputeTurnDowns === true ? "on" : "off",
      });
    }
    if (stage === "dispute_window") {
      if (ctx.config.disputeTurnDowns !== true) continue;
      const key = `dispute:${task}`;
      if (!due(memory, key, now)) continue;
      memory.set(key, now);
      try {
        if (ctx.getBalance !== undefined && ctx.getMinimumBalanceForRentExemption !== undefined) {
          const bondRent = await ctx.getMinimumBalanceForRentExemption(DISPUTE_BOND_ACCOUNT_SIZE);
          const needed = turnDown.bondToDispute + bondRent + DISPUTE_FEE_HEADROOM_LAMPORTS;
          const balance = await ctx.getBalance(ctx.signer.address);
          if (balance < needed) {
            ctx.log({
              event: "task.turn-down-dispute-unfunded",
              task,
              neededLamports: needed.toString(),
              balanceLamports: balance.toString(),
            });
            continue;
          }
        }
        const submission = await readSubmission(ctx, agent, task);
        const evidenceHash =
          submission !== null && submission.proofHash.some((byte) => byte !== 0)
            ? new Uint8Array(submission.proofHash)
            : null;
        if (evidenceHash === null) continue;
        const { signature } = await ctx.client.send(
          [
            await facade.disputeRejection({
              task,
              worker: agent.agentPda,
              creator: decoded.creator,
              authority: ctx.signer,
              // The delivery itself is the evidence: its recorded fingerprint.
              evidenceHash,
              evidenceUri: "",
            }),
          ],
          { maxRetries: 0 },
        );
        done.push({ task, action: "disputed" });
        ctx.log({
          event: "task.turn-down-disputed",
          task,
          signature,
          bondLamports: turnDown.bondToDispute.toString(),
        });
      } catch (error) {
        ctx.log({ event: "task.turn-down-dispute-failed", task, reason: failureText(error) });
      }
      continue;
    }
    if (
      stage !== "refund_due" &&
      stage !== "unruled_refund_due" &&
      stage !== "legacy_payout_due"
    ) {
      continue;
    }
    const key = `collect:${task}`;
    if (!due(memory, key, now)) continue;
    memory.set(key, now);
    try {
      treasury ??= await readTreasury(ctx);
      const { signature } = await ctx.client.send(
        [
          await facade.expireRejectFrozen({
            task,
            claim: turnDown.claim,
            worker: agent.agentPda,
            treasury,
            creator: decoded.creator,
            workerAuthority: ctx.signer.address,
            authority: ctx.signer,
            ...legs(decoded),
          }),
        ],
        { maxRetries: 0 },
      );
      done.push({ task, action: "collected" });
      ctx.log({
        event: "task.turn-down-collected",
        task,
        signature,
        paid: facade.turnDownExpiryPaysWorker(stage),
      });
    } catch (error) {
      ctx.log({ event: "task.turn-down-collect-failed", task, reason: failureText(error) });
    }
  }
  return done;
}

/**
 * One upkeep pass: auto-accept what is overdue, handle turned-down
 * deliveries, then release unusable claims. It never fails its caller: a step
 * that cannot read the chain is logged (`upkeep.failed`) and done on a later
 * pass, so the worker's own jobs and its search for new ones go on.
 */
export async function runUpkeep(
  ctx: WorkerContext,
  agent: WorkerAgent,
  memory: UpkeepMemory = new Map(),
): Promise<UpkeepReport> {
  const step = async <T>(name: string, run: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await run();
    } catch (error) {
      ctx.log({ event: "upkeep.failed", step: name, reason: failureText(error) });
      return [];
    }
  };
  const autoAccepted = await step("auto-accept", () =>
    collectOverdueReviews(ctx, agent, memory),
  );
  const turnDowns = await step("turn-downs", () => collectTurnDowns(ctx, agent, memory));
  const released = await step("release", () => releaseOwnClaims(ctx, agent, memory));
  return { autoAccepted, released, turnDowns };
}
