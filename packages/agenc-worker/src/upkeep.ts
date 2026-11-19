// What a worker does for its own jobs so it is paid and stays able to work,
// without depending on anyone else's software:
//
// - A delivery the buyer never reviews is paid by auto-accept once its review
//   window has passed. Anyone may send it; the worker sends it for its own
//   deliveries, so a provider whose buyer goes quiet is still paid.
// - A claim the worker can no longer use (a job it gave up, or one whose
//   time ran out) is released: expired once its time is over, or reclaimed
//   when the task has already ended. That returns the claim's rent and frees
//   one of the agent's limited active-task slots.
//
// Every step reads the chain first and sends at most one transaction per job,
// signed by the worker's own wallet. Nothing here runs or delivers work.
import { address, unwrapOption, type Address } from "@solana/kit";
import {
  AgencError,
  facade,
  findClaimPda,
  findProtocolConfigPda,
  findTaskSubmissionPda,
  findTaskValidationConfigPda,
  findWorkerCompletionBondPda,
  getProtocolConfigDecoder,
  getTaskClaimDecoder,
  getTaskDecoder,
  getTaskSubmissionDecoder,
  getTaskValidationConfigDecoder,
  SubmissionStatus,
  TaskStatus,
  TaskType,
  type Task,
  type TaskClaim,
  type TaskSubmission,
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
  released: Array<{ task: Address; how: "expired" | "reclaimed" | "closed" }>;
};

/**
 * Remembers when a transaction for a job was last tried, so a failing one is
 * not sent on every poll. Kept in memory: a restart may try once more early,
 * which costs nothing when it is refused before it is sent.
 */
export type UpkeepMemory = Map<string, number>;

async function readTask(ctx: WorkerContext, task: Address): Promise<Task | null> {
  const data = await ctx.readAccount(task);
  return data === null ? null : getTaskDecoder().decode(data);
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

function markReleased(ctx: WorkerContext, task: Address): void {
  const state = loadState(ctx.stateDir);
  const job = state.failedJobs.find((entry) => entry.task === task);
  if (job === undefined || job.claimReleased) return;
  job.claimReleased = true;
  saveState(ctx.stateDir, state);
}

/**
 * Release the claims of jobs this worker gave up: an ended task's claim is
 * reclaimed straight away, an open one's is expired once its time is over.
 * Either returns the claim's rent to this worker and frees its slot.
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
    const decoded = await readTask(ctx, task);
    if (decoded === null) continue;
    now ??= await clusterNowSeconds(ctx);
    const ended =
      decoded.status === TaskStatus.Completed || decoded.status === TaskStatus.Cancelled;
    const expired =
      (decoded.status === TaskStatus.InProgress ||
        decoded.status === TaskStatus.PendingValidation) &&
      claim.expiresAt > 0n &&
      now > Number(claim.expiresAt);
    if (!ended && !expired) continue;
    if (expired) {
      // A claim with a delivery waiting for review is settled by the review,
      // never expired.
      const submission = await readSubmission(ctx, agent, task);
      if (submission !== null && submission.status === SubmissionStatus.Submitted) continue;
    }
    const key = `release:${task}`;
    if (!due(memory, key, now)) continue;
    memory.set(key, now);
    try {
      treasury ??= await readTreasury(ctx);
      const parent = unwrapOption(decoded.dependsOn);
      const instruction = ended
        ? await facade.reclaimTerminalClaim({
            authority: ctx.signer,
            task,
            worker: agent.agentPda,
            treasury,
            rentRecipient: ctx.signer.address,
          })
        : await facade.expireClaim({
            authority: ctx.signer,
            task,
            worker: agent.agentPda,
            rentRecipient: ctx.signer.address,
            treasury,
            // An exclusive no-show must show its (possibly absent) bond.
            workerCompletionBond: (
              await findWorkerCompletionBondPda({
                task,
                workerAuthority: ctx.signer.address,
              })
            )[0],
            bondCreator: decoded.creator,
            ...(parent !== null ? { dependencyParent: parent } : {}),
          });
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

/**
 * One upkeep pass: auto-accept what is overdue, then release unusable claims.
 * It never fails its caller: a step that cannot read the chain is logged
 * (`upkeep.failed`) and done on a later pass, so the worker's own jobs and
 * its search for new ones go on.
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
  const released = await step("release", () => releaseOwnClaims(ctx, agent, memory));
  return { autoAccepted, released };
}
