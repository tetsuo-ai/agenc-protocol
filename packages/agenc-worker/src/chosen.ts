// Selecting work uses the same canonical reads, candidate filters and claim path as the watcher.
import type { Address } from "@solana/kit";
import {
  findClaimPda, findTaskSubmissionPda, findTaskValidationConfigPda, findWorkerStatsPda,
  getTaskClaimDecoder, getTaskSubmissionDecoder, getTaskValidationConfigDecoder, SubmissionStatus, TaskStatus, TaskType, ValidationMode, values,
  type Task,
} from "@tetsuo-ai/marketplace-sdk";
import {
  AGENT_STATS_ACCOUNT_SIZE, FEE_HEADROOM_LAMPORTS, claimDepositFor, expectedWorkerPayout,
  giveUpJob, jobTitle, listClaimCandidates, processCandidate, readClaimAccountRentMinimums,
  RELEASE_LANDING_MARGIN_SECS, resumeOpenClaim,
  type VerifiedCandidate, type WorkerAgent, type WorkerContext,
} from "./runtime.js";
import { clusterNowSeconds, readTaskAccount, sendReleaseClaim } from "./upkeep.js";
import { bytesToHex, loadState, saveState } from "./state.js";

export type WorkerAction = "claim" | "submit" | "release";

function releaseTerms(task: Task, now: number, releaseBy: number, expiresAt: number) {
  // Revision 9 preserves the deposit after a dispute, including after the first hour.
  const protectedDeposit = (task.reserved[13] ?? 0) !== 0;
  return {
    depositReturns: protectedDeposit || now <= releaseBy,
    enoughTime: now + RELEASE_LANDING_MARGIN_SECS < expiresAt &&
      (protectedDeposit || now > releaseBy || now + RELEASE_LANDING_MARGIN_SECS < releaseBy),
  };
}

async function reviewWindow(ctx: WorkerContext, task: Address) {
  const [pda] = await findTaskValidationConfigPda({ task });
  const data = await ctx.readAccount(pda);
  if (!data) return null;
  const config = getTaskValidationConfigDecoder().decode(data);
  return config.task === task && config.mode !== ValidationMode.Auto ? Number(config.reviewWindowSecs) : null;
}

function terms(address: Address, task: Task, reviewSeconds: number) {
  return {
    task: address, reward: task.rewardAmount.toString(), payout: expectedWorkerPayout(task).toString(),
    contest: task.taskType === TaskType.Competitive && (task.reserved[0] ?? 0) >= 1,
    deposit: claimDepositFor(task).toString(), deadline: Number(task.deadline), reviewSeconds,
  };
}

async function openTerms(ctx: WorkerContext, agent: WorkerAgent, task: Address, facts: VerifiedCandidate, reservedCents?: number): Promise<OpenWork | null> {
  if (facts.isHire || facts.task.taskType === TaskType.BidExclusive)
    return null;
  if (facts.task.deadline > 0n && Number(facts.task.deadline) <= await clusterNowSeconds(ctx))
    return null;
  const reviewSeconds = await reviewWindow(ctx, task);
  if (reviewSeconds === null) return null;
  const rent = ctx.getMinimumBalanceForRentExemption;
  if (!rent || !ctx.modelBudgetForTask) throw new Error("The network could not quote the job deposits.");
  const [pda] = await findWorkerStatsPda({ worker: agent.agentPda });
  const [rents, record] = await Promise.all([
    readClaimAccountRentMinimums(rent), ctx.readAccount(pda),
  ]);
  const recordRent = record === null ? await rent(AGENT_STATS_ACCOUNT_SIZE) : 0n;
  if (typeof recordRent !== "bigint" || recordRent < 0n) throw new Error("Could not price the first worker record.");
  const modelBudgetCents = reservedCents ?? await ctx.modelBudgetForTask(facts.task, task).catch(() => 0);
  if (!Number.isSafeInteger(modelBudgetCents) || modelBudgetCents <= 0) return null;
  const spec = JSON.parse(new TextDecoder().decode(facts.spec.content));
  const criteria = spec.acceptance ?? spec.acceptanceCriteria;
  const request = [spec.instructions, spec.details, spec.summary].find(value => typeof value === "string");
  return {
    ...terms(task, facts.task, reviewSeconds), title: jobTitle(facts.spec.content) ?? "Open job",
    request: request?.slice(0, 4000) ?? "",
    criteria: Array.isArray(criteria) ? criteria.filter((v): v is string => typeof v === "string").slice(0, 8).map((v) => v.slice(0, 300)) : [],
    modelBudgetCents,
    specHash: bytesToHex(facts.spec.jobSpecHash), rent: (rents.claim + rents.submission).toString(),
    recordRent: recordRent.toString(), feeReserve: FEE_HEADROOM_LAMPORTS.toString(),
  };
}

export interface OpenWork extends ReturnType<typeof terms> {
  title: string;
  request: string;
  criteria: string[];
  modelBudgetCents: number;
  specHash: string;
  rent: string;
  recordRent: string;
  feeReserve: string;
}

export async function browseOpenWork(ctx: WorkerContext, agent: WorkerAgent, offset: number, task?: Address) {
  const candidates = await listClaimCandidates(ctx, loadState(ctx.stateDir));
  const page = task ? candidates.filter((item) => item.task === task) : candidates.slice(offset, offset + 10);
  const jobs: OpenWork[] = [];
  for (const candidate of page) {
    let verified: VerifiedCandidate | undefined;
    const result = await processCandidate({ ...ctx, dryRun: true }, agent, candidate, { inspect: (facts) => { verified = facts; } });
    if (result.status !== "dry-run" || !verified) continue;
    const job = await openTerms(ctx, agent, candidate.task, verified);
    if (job) jobs.push(job);
  }
  return { jobs, next: !task && candidates.length > offset + page.length ? offset + page.length : null };
}

export async function takeOpenWork(ctx: WorkerContext, agent: WorkerAgent, signal: AbortSignal, task: Address,
  authorize: (job: OpenWork) => Promise<void>) {
  const candidate = (await listClaimCandidates(ctx, loadState(ctx.stateDir))).find((item) => item.task === task);
  if (!candidate) throw new Error("This job is no longer available to this agent.");
  const result = await processCandidate(ctx, agent, candidate, {
    signal,
    authorizeChosen: async (facts, budget) => {
      const job = await openTerms(ctx, agent, task, facts, budget);
      if (!job) throw new Error("The chosen job changed.");
      await authorize(job);
    },
  });
  if (result.status !== "held") throw new Error("The worker could not confirm the claim. Refresh the jobs list.");
}

export async function heldWork(ctx: WorkerContext, agent: WorkerAgent) {
  const marker = loadState(ctx.stateDir).openClaim;
  if (!marker?.chosen) return null;
  const task = marker.task as Address;
  const [claimPda] = await findClaimPda({ task, bidder: agent.agentPda });
  const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
  const [read, data, submitted, now] = await Promise.all([
    readTaskAccount(ctx, task), ctx.readAccount(claimPda), ctx.readAccount(submissionPda), ctx.clusterTime?.(),
  ]);
  if (now === undefined || !Number.isSafeInteger(now)) throw new Error("The marketplace clock is unavailable.");
  if (read.kind !== "task" || ![TaskStatus.InProgress, TaskStatus.PendingValidation].includes(read.task.status) || !data) return null;
  const claim = getTaskClaimDecoder().decode(data);
  if (claim.worker !== agent.agentPda || claim.task !== task || claim.isCompleted || Number(claim.expiresAt) <= now) return null;
  if (submitted) {
    const prior = getTaskSubmissionDecoder().decode(submitted);
    if (prior.task !== task || prior.claim !== claimPda || prior.worker !== agent.agentPda ||
      prior.status !== SubmissionStatus.Rejected || marker.revisionSubmissionCount !== prior.submissionCount) return null;
  }
  const reviewSeconds = await reviewWindow(ctx, task);
  if (reviewSeconds === null) return null;
  const releaseBy = Number(claim.claimedAt + values.CLAIM_RELEASE_GRACE_SECS);
  const expiresAt = Number(claim.expiresAt);
  const release = releaseTerms(read.task, now, releaseBy, expiresAt);
  const ready = marker.phase === "executed" && !!marker.execution;
  return {
    ...terms(task, read.task, reviewSeconds),
    ...(submitted && { deposit: "0" }), title: marker.title ?? "Chosen job",
    claimedAt: Number(claim.claimedAt), expiresAt, releaseBy,
    // Allow time for the release transaction to land inside the refund window.
    depositReturns: release.depositReturns,
    canRelease: (!marker.releaseRequestedAt || Date.now() - Date.parse(marker.releaseRequestedAt) > 120000) && (ready || marker.phase === "claimed") && !(read.task.taskType === TaskType.Competitive && (read.task.reserved[0] ?? 0) >= 1)
      && read.task.taskType !== TaskType.BidExclusive && release.enoughTime,
    canSubmit: !marker.releaseRequestedAt && ready && (read.task.deadline === 0n || Number(read.task.deadline) > now),
    resultHash: marker.execution?.resultHashHex ?? null,
    resultBytes: marker.execution ? Buffer.byteLength(marker.execution.resultBytesBase64, "base64") : null,
    preview: marker.execution ? Buffer.from(marker.execution.resultBytesBase64, "base64").toString("utf8").slice(0, 4000) : null,
  };
}

export type HeldWork = NonNullable<Awaited<ReturnType<typeof heldWork>>>;

export async function finishChosenWork(ctx: WorkerContext, agent: WorkerAgent, signal: AbortSignal,
  task: Address, action: "submit" | "release", authorize: (job: HeldWork) => Promise<void>) {
  if (!ctx.checkChosenRoom) throw new Error("The job room is unavailable.");
  await ctx.checkChosenRoom();
  const held = await heldWork(ctx, agent);
  if (held?.task !== task || !(action === "submit" ? held.canSubmit : held.canRelease))
    throw new Error("This action is no longer available for this claim.");
  const read = await readTaskAccount(ctx, task);
  if (read.kind !== "task") throw new Error("The job has ended.");
  await authorize(held);
  signal.throwIfAborted();
  const state = loadState(ctx.stateDir);
  const marker = state.openClaim;
  if (marker?.task !== task || !marker.chosen) throw new Error("The selected claim changed.");
  if (action === "submit") {
    if (marker.phase !== "executed" || !marker.execution) throw new Error("The room has no result ready.");
    // Persist the approval before upload. Recovery retries only these exact bytes.
    marker.phase = "uploading";
    saveState(ctx.stateDir, state);
    const outcome = await resumeOpenClaim(ctx, agent);
    if (outcome?.status !== "submitted") throw new Error("Delivery is awaiting confirmation. Refresh the jobs list.");
  } else {
    const now = await ctx.clusterTime?.();
    if (now === undefined || !Number.isSafeInteger(now)) throw new Error("The marketplace clock is unavailable.");
    const release = releaseTerms(read.task, now, held.releaseBy, held.expiresAt);
    if (!release.enoughTime || held.depositReturns !== release.depositReturns) throw new Error("The release window changed.");
    signal.throwIfAborted();
    marker.releaseRequestedAt = new Date().toISOString();
    saveState(ctx.stateDir, state);
    const signature = await sendReleaseClaim(ctx, agent, task, read.task);
    giveUpJob(ctx, state, marker, {
      cause: "released", reason: "The worker gave the job back.", claimReleased: true, rewardAmount: held.reward,
    });
    ctx.log({ event: "claim.released", task, how: "released", signature });
  }
}
