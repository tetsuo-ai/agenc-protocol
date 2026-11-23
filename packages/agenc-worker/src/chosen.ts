// The picker and the executor use the same verified spec, policy filters and claim instruction.
import { unwrapOption, type Address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS, facade, findClaimPda, findWorkerStatsPda, findEscrowPda, findProtocolConfigPda, findTaskSubmissionPda,
  findTaskValidationConfigPda, getAgentRegistrationDecoder, getProtocolConfigDecoder,
  getReleaseClaimToInstructionAsync, getTaskClaimDecoder, getTaskSubmissionDecoder, getTaskValidationConfigDecoder,
  listDirectClaimableTasks, SubmissionStatus, TaskStatus, TaskType, ValidationMode, values, type Task,
} from "@tetsuo-ai/marketplace-sdk";
import {
  FEE_HEADROOM_LAMPORTS, claimFundingRequirement, claimDepositFor, expectedWorkerPayout, jobTitle, processCandidate,
  readClaimAccountRentMinimums, workerRecordShortfall, resumeOpenClaim, RELEASE_LANDING_MARGIN_SECS,
  type VerifiedCandidate, type WorkerAgent, type WorkerContext, type WorkSimulation,
} from "./runtime.js";
import { readTaskAccount } from "./upkeep.js";
import { bytesToHex, hexToBytes, loadState, type SubmissionIntent } from "./state.js";
import { decodeHostedBrief } from "./hosted-brief.js";
import { resultDataFromHashHex, resultPlaceholderUri, uploadResult } from "./result.js";

export type WorkerAction = "claim" | "submit" | "release";

async function taskTerms(ctx: WorkerContext, agent: WorkerAgent, task: Address, data: Task, claimed = false) {
  const [validation] = await findTaskValidationConfigPda({ task });
  const [protocol] = await findProtocolConfigPda();
  const [configBytes, workerBytes, protocolBytes] = await Promise.all([
    ctx.readAccount(validation), ctx.readAccount(agent.agentPda), ctx.readAccount(protocol),
  ]);
  if (!workerBytes || !protocolBytes) return null;
  const config = configBytes?.length ? getTaskValidationConfigDecoder().decode(configBytes) : null;
  if (config && config.task !== task) return null;
  const direct = data.constraintHash.every(b => b === 0);
  if (direct ? config && config.mode !== ValidationMode.Auto : !config || config.mode === ValidationMode.Auto) return null;
  const worker = getAgentRegistrationDecoder().decode(workerBytes);
  const now = await ctx.clusterTime!();
  const periods = Math.max(0, Math.floor((now - Number(worker.lastActive)) / 2592000));
  const reputation = !claimed && worker.reputation > 1000 ? Math.max(1000, worker.reputation - periods * 50) : worker.reputation;
  const discount = reputation >= 9500 ? 15 : reputation >= 9000 ? 10 : reputation >= 8000 ? 5 : 0;
  const protocolFeeBps = data.protocolFeeBps === 0 ? 0 : Math.max(1, data.protocolFeeBps - discount);
  const contest = data.taskType === TaskType.Competitive && (data.reserved[0] ?? 0) >= 1;
  const [claimAccount] = await findClaimPda({ task, bidder: agent.agentPda });
  return {
    claimAccount, recordAccount: (await findWorkerStatsPda({ worker: agent.agentPda }))[0],
    escrowAccount: (await findEscrowPda({ task }))[0],
    submissionAccount: (await findTaskSubmissionPda({ claim: claimAccount }))[0],
    task, reward: data.rewardAmount.toString(), payout: expectedWorkerPayout({ ...data, protocolFeeBps }).toString(),
    worker: ctx.signer.address, buyer: data.creator, treasury: getProtocolConfigDecoder().decode(protocolBytes).treasury,
    direct, contest, selectionDeadline: contest ? Number(data.deadline + facade.CONTEST_SELECTION_WINDOW_SECS) : null,
    deposit: claimDepositFor(data).toString(), deadline: Number(data.deadline), reviewSeconds: Number(config?.reviewWindowSecs ?? 0),
  };
}

function candidate(task: Address, data: Task) {
  return { task, creator: data.creator, rewardAmount: data.rewardAmount, rewardMint: unwrapOption(data.rewardMint),
    requiredCapabilities: data.requiredCapabilities, parentTask: unwrapOption(data.dependsOn) };
}

async function openTerms(ctx: WorkerContext, agent: WorkerAgent, task: Address, facts: VerifiedCandidate, reservedCents?: number) {
  if (facts.isHire || facts.task.creator === ctx.signer.address || !ctx.simulateWork) return null;
  const details = await taskTerms(ctx, agent, task, facts.task);
  if (!details) return null;
  const parentTask = unwrapOption(facts.task.dependsOn);
  const ix = await facade.claimTaskWithJobSpec({ task, worker: agent.agentPda, authority: ctx.signer,
    jobSpecHash: facts.spec.jobSpecHash, ...(parentTask && { parentTask }) });
  const [simulation, rents, recordRent, modelBudgetCents] = await Promise.all([
    ctx.simulateWork(ix), readClaimAccountRentMinimums(ctx.getMinimumBalanceForRentExemption!),
    workerRecordShortfall(ctx, agent), reservedCents ?? ctx.modelBudgetForTask?.(facts.task, task),
  ]);
  if (!simulation || !modelBudgetCents || !Number.isSafeInteger(modelBudgetCents) || modelBudgetCents <= 0) return null;
  const claimRent = BigInt(simulation.changes.find(c => c.address === details.claimAccount)?.delta ?? 0) - BigInt(details.deposit);
  const submissionRent = details.direct ? 0n : rents.submission;
  const required = claimFundingRequirement({ claim: claimRent, submission: submissionRent }, {
    depositLamports: BigInt(details.deposit), recordRentLamports: recordRent,
  });
  if (await ctx.getBalance!(ctx.signer.address) < required) return null;
  const brief = decodeHostedBrief(facts.spec.content);
  return {
    ...details, title: jobTitle(facts.spec.content) ?? "Open job", request: brief.request, criteria: brief.acceptance, brief: brief.raw,
    modelBudgetCents, specHash: bytesToHex(facts.spec.jobSpecHash), rent: claimRent.toString(), simulation,
    futureRent: submissionRent.toString(), recordRent: recordRent.toString(), feeReserve: FEE_HEADROOM_LAMPORTS.toString(),
  };
}
export type OpenWork = NonNullable<Awaited<ReturnType<typeof openTerms>>>;

async function inspect(ctx: WorkerContext, agent: WorkerAgent, task: Address) {
  const read = await readTaskAccount(ctx, task);
  if (read.kind !== "task") return null;
  let verified: VerifiedCandidate | undefined;
  await processCandidate({ ...ctx, dryRun: true }, agent, candidate(task, read.task), { inspect: facts => { verified = facts; } });
  return verified ? openTerms(ctx, agent, task, verified) : null;
}

type Page = { addresses: Address[]; index: number; agent: Address; dir: string; created: number };
const pages = new Map<number, Page>();
let cursor = 0;

export async function browseOpenWork(ctx: WorkerContext, agent: WorkerAgent, offset: number, task?: Address) {
  if (task) {
    const exact = await inspect(ctx, agent, task);
    return { jobs: exact ? [exact] : [], next: null };
  }
  const now = Date.now();
  for (const [key, page] of pages) if (page.created < now - 300000) pages.delete(key);
  let page = pages.get(offset);
  if (!offset) {
    const rows = await listDirectClaimableTasks(ctx.gpa, { capabilities: ctx.config.capabilities,
      nowUnixTimestamp: BigInt(await ctx.clusterTime!()), deadlineSafetySeconds: 0n });
    rows.sort((a, b) => a.account.rewardAmount === b.account.rewardAmount ? a.address.localeCompare(b.address, "en")
      : a.account.rewardAmount > b.account.rewardAmount ? -1 : 1);
    page = { addresses: rows.map(r => r.address), index: 0, dir: ctx.stateDir, agent: agent.agentPda, created: now };
  }
  if (!page || page.dir !== ctx.stateDir || page.agent !== agent.agentPda) throw new Error("Refresh the jobs list for a new page.");
  const jobs: OpenWork[] = [];
  let index = page.index;
  // Leave room in the wallet's 1 MiB frame for prices and the response envelope.
  let bytes = 0;
  pageRows: while (jobs.length < 10 && index < page.addresses.length) {
    const batch = page.addresses.slice(index, index + Math.min(4, 10 - jobs.length));
    const results = await Promise.all(batch.map(address => inspect(ctx, agent, address)));
    for (const job of results) {
      if (job !== null) {
        const size = Buffer.byteLength(JSON.stringify(job));
        if (jobs.length && bytes + size > 800 * 1024) break pageRows;
        jobs.push(job);
        bytes += size;
      }
      index++;
    }
  }
  if (index === page.addresses.length) return { jobs, next: null };
  if (pages.size >= 128) pages.delete(pages.keys().next().value!);
  pages.set(++cursor, { ...page, index });
  return { jobs, next: cursor };
}

export async function takeOpenWork(ctx: WorkerContext, agent: WorkerAgent, signal: AbortSignal, task: Address,
  authorize: (job: OpenWork) => Promise<void>) {
  const read = await readTaskAccount(ctx, task);
  if (read.kind !== "task" || !ctx.withChosenRoom) throw new Error("This job is unavailable.");
  const result = await ctx.withChosenRoom(room => processCandidate({ ...ctx, signal: room }, agent, candidate(task, read.task), {
    signal, authorizeChosen: async (facts, budget) => {
      const job = await openTerms(ctx, agent, task, facts, budget);
      if (!job) throw new Error("The chosen job changed.");
      await authorize(job);
    },
  }));
  if (result.status !== "held") throw new Error("The worker could not confirm the claim. Refresh the jobs list.");
}

type Terms = NonNullable<Awaited<ReturnType<typeof taskTerms>>>;
async function deliveryInstruction(ctx: WorkerContext, agent: WorkerAgent, terms: Terms, data: Task, hash: string) {
  const input = { task: terms.task, worker: agent.agentPda, authority: ctx.signer, proofHash: hexToBytes(hash), resultData: resultDataFromHashHex(hash) };
  if (!terms.direct) return facade.submitTaskResult(input);
  const parent = unwrapOption(data.dependsOn);
  return facade.completeTask({ ...input, creator: data.creator, treasury: terms.treasury,
    ...(data.operatorFeeBps && { operator: data.operator }), ...(data.referrerFeeBps && { referrer: data.referrer }),
    ...(parent && { dependencyParent: parent }) });
}

async function releaseInstruction(ctx: WorkerContext, agent: WorkerAgent, terms: Terms, refund: boolean) {
  return getReleaseClaimToInstructionAsync({ task: terms.task, worker: agent.agentPda, creator: terms.buyer, authority: ctx.signer,
    recipient: refund ? terms.worker : terms.buyer, taskValidationConfig: terms.direct ? AGENC_COORDINATION_PROGRAM_ADDRESS :
      (await findTaskValidationConfigPda({ task: terms.task }))[0] });
}

export async function heldWork(ctx: WorkerContext, agent: WorkerAgent) {
  const marker = loadState(ctx.stateDir).openClaim;
  if (!marker?.chosen || !ctx.simulateWork) return null;
  const task = marker.task as Address;
  const [claimPda] = await findClaimPda({ task, bidder: agent.agentPda });
  const [submissionPda] = await findTaskSubmissionPda({ claim: claimPda });
  const [read, data, submitted, now] = await Promise.all([
    readTaskAccount(ctx, task), ctx.readAccount(claimPda), ctx.readAccount(submissionPda), ctx.clusterTime?.(),
  ]);
  if (now === undefined || !Number.isSafeInteger(now)) throw new Error("The marketplace clock is unavailable.");
  if (read.kind !== "task" || !data || ![TaskStatus.InProgress, TaskStatus.PendingValidation].includes(read.task.status)) return null;
  const claim = getTaskClaimDecoder().decode(data);
  if (claim.worker !== agent.agentPda || claim.task !== task || claim.isCompleted || Number(claim.expiresAt) <= now) return null;
  if (submitted?.length) {
    const prior = getTaskSubmissionDecoder().decode(submitted);
    if (prior.task !== task || prior.claim !== claimPda || prior.worker !== agent.agentPda ||
      prior.status !== SubmissionStatus.Rejected || marker.revisionSubmissionCount !== prior.submissionCount) return null;
  }
  const terms = await taskTerms(ctx, agent, task, read.task, true);
  if (!terms) return null;
  const releaseBy = Number(claim.claimedAt + values.CLAIM_RELEASE_GRACE_SECS);
  const depositReturns = now <= releaseBy || !!read.task.reserved[13];
  const expiresAt = Number(claim.expiresAt);
  const idle = !marker.chosenAttempt && !marker.releaseRequestedAt && (marker.phase === "claimed" || marker.phase === "executed");
  const canDeliver = idle && marker.execution && (terms.deadline === 0 || now <= terms.deadline);
  const room = ctx.checkChosenRoom !== undefined;
  const enoughTime = now + RELEASE_LANDING_MARGIN_SECS < expiresAt &&
    (now > releaseBy || now + RELEASE_LANDING_MARGIN_SECS < releaseBy || !!read.task.reserved[13]);
  const [release, submit] = await Promise.all([
    idle && !terms.contest && enoughTime ? ctx.simulateWork(await releaseInstruction(ctx, agent, terms, depositReturns)) : null,
    canDeliver && room ? ctx.simulateWork(await deliveryInstruction(ctx, agent, terms, read.task, marker.execution!.resultHashHex)) : null,
  ]);
  return { ...terms, ...(submitted?.length && !terms.contest && { deposit: "0" }), title: marker.title ?? "Chosen job",
    claimedAt: Number(claim.claimedAt), expiresAt, releaseBy: terms.contest ? null : releaseBy, depositReturns,
    release, submit, canRelease: !!release, canSubmit: !!submit, resultHash: marker.execution?.resultHashHex ?? null,
    resultBytes: marker.execution ? Buffer.byteLength(marker.execution.resultBytesBase64, "base64") : null,
    preview: marker.execution ? Buffer.from(marker.execution.resultBytesBase64, "base64").toString("utf8").slice(0, 4000) : null };
}

export type HeldWork = NonNullable<Awaited<ReturnType<typeof heldWork>>>;
export type { WorkSimulation };

export async function finishChosenWork(ctx: WorkerContext, agent: WorkerAgent, signal: AbortSignal,
  task: Address, action: "submit" | "release", authorize: (job: HeldWork) => Promise<void>,
  prepare: (intent?: SubmissionIntent) => void) {
  const held = await heldWork(ctx, agent);
  if (held?.task !== task || !(action === "submit" ? held.canSubmit : held.canRelease))
    throw new Error("This action is no longer available for this claim.");
  const read = await readTaskAccount(ctx, task);
  if (read.kind !== "task") throw new Error("The job has ended.");
  await authorize(held);
  const marker = loadState(ctx.stateDir).openClaim;
  if (marker?.task !== task || !marker.chosen) throw new Error("The selected claim changed.");
  let ix;
  if (action === "submit") {
    if (!marker.execution) throw new Error("The room has no result ready.");
    const { resultHashHex, rewardAmount, resultBytesBase64 } = marker.execution;
    const resultUri = ctx.config.resultUploader ? await uploadResult({ uploaderUrl: ctx.config.resultUploader,
      body: new Uint8Array(Buffer.from(resultBytesBase64, "base64")), ...(ctx.uploadFetch && { fetchImpl: ctx.uploadFetch }) }) : resultPlaceholderUri(resultHashHex);
    prepare({ resultHashHex, rewardAmount, resultUri, preparedAt: new Date().toISOString() });
    ix = await deliveryInstruction(ctx, agent, held, read.task, resultHashHex);
  } else {
    prepare();
    ix = await releaseInstruction(ctx, agent, held, held.depositReturns);
  }
  signal.throwIfAborted();
  await ctx.client.send([ix], { maxRetries: 0 });
  await resumeOpenClaim(ctx, agent);
}
