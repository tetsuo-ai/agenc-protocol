// The picker and the executor use the same verified spec, policy filters and claim instruction.
import { unwrapOption, type Address } from "@solana/kit";
import {
  lighthouse, facade, findClaimPda, findWorkerStatsPda, findEscrowPda, findProtocolConfigPda, findTaskSubmissionPda,
  findTaskValidationConfigPda, getAgentRegistrationDecoder, getProtocolConfigDecoder,
  getTaskClaimDecoder, getTaskEncoder, getTaskSubmissionDecoder, getTaskValidationConfigDecoder,
  directClaimState, listDirectClaimableTasks, SubmissionStatus, TaskStatus, TaskType, ValidationMode, values, type Task,
} from "@tetsuo-ai/marketplace-sdk";
import {
  FEE_HEADROOM_LAMPORTS, claimFundingRequirement, claimDepositFor, expectedWorkerPayout, jobTitle, processCandidate,
  readClaimAccountRentMinimums, workerRecordShortfall, resumeOpenClaim, RELEASE_LANDING_MARGIN_SECS,
  type VerifiedCandidate, type WorkerAgent, type WorkerContext, type WorkSimulation,
} from "./runtime.js";
import { cleanupClaimInstruction, readTaskAccount } from "./upkeep.js";
import { bytesToHex, hexToBytes, loadState, saveState, type SubmissionIntent } from "./state.js";
import { decodeHostedBrief } from "./hosted-brief.js";
import { chosenReleaseWindow, correctionCutoff } from "./chosen-release.js";
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

const eligibilityReasons = {
  available: ["This worker can request a claim.", false],
  missing: ["No task exists at this address. Check the task ID.", false],
  closed: ["This task no longer accepts direct claims.", false],
  expired: ["The claim deadline has passed.", false],
  occupied: ["All claim slots are occupied. Check again if a worker releases one.", true],
  bid_only: ["This task requires an accepted bid.", false],
  capability: ["This worker lacks a required capability. Choose a worker that supports the task.", false],
  reputation: ["This worker's current reputation is below the task minimum.", false],
  registration: ["Register this worker before requesting a claim.", false],
  held: ["Finish or release the worker's current job before choosing another.", true],
  policy: ["This task does not meet the worker's verified job or spending requirements.", false],
  unavailable: ["Market could not verify this task or simulate the claim. Try again.", true],
} as const;

export function workEligibility(task: string, code: keyof typeof eligibilityReasons) {
  const [message, retryable] = eligibilityReasons[code];
  return { task, code, message, retryable };
}

async function inspect(ctx: WorkerContext, agent: WorkerAgent, task: Address) {
  const refused = (code: keyof typeof eligibilityReasons) => ({ job: null, eligibility: workEligibility(task, code) });
  try {
    const read = await readTaskAccount(ctx, task);
    if (read.kind !== "task") return refused(read.kind);
    const now = await ctx.clusterTime!();
    const state = directClaimState(read.task, BigInt(now));
    if (state !== "available") return refused(state);
    const registration = await ctx.readAccount(agent.agentPda);
    if (!registration?.length) return refused("registration");
    const worker = getAgentRegistrationDecoder().decode(registration);
    const effective = worker.capabilities & ctx.config.capabilities;
    if ((read.task.requiredCapabilities & effective) !== read.task.requiredCapabilities) return refused("capability");
    const periods = Math.max(0, Math.floor((now - Number(worker.lastActive)) / 2592000));
    const reputation = worker.reputation > 1000 ? Math.max(1000, worker.reputation - periods * 50) : worker.reputation;
    if (reputation < read.task.minReputation) return refused("reputation");
    let verified: VerifiedCandidate | undefined;
    const outcome = await processCandidate({ ...ctx, dryRun: true }, agent, candidate(task, read.task), { inspect: facts => { verified = facts; } });
    if (!verified) {
      return refused(outcome.status === "skipped" && (outcome.retryable || /error|unreachable/i.test(outcome.reason)) ? "unavailable" : "policy");
    }
    if (verified.isHire || read.task.creator === ctx.signer.address) return refused("policy");
    const job = await openTerms(ctx, agent, task, verified);
    return job ? { job, eligibility: workEligibility(task, "available") } : refused("unavailable");
  } catch {
    return refused("unavailable");
  }
}

type Page = { addresses: Address[]; index: number; agent: Address; dir: string; created: number };
const pages = new Map<number, Page>();
let cursor = 0;

export async function browseOpenWork(ctx: WorkerContext, agent: WorkerAgent, offset: number, task?: Address) {
  if (task) {
    const exact = await inspect(ctx, agent, task);
    return { jobs: exact.job ? [exact.job] : [], next: null, eligibility: exact.eligibility };
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
    for (const { job } of results) {
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
  // Leave the two buyer-requested revision slices intact. A crash before this
  // write simply leaves this older claim without a pre-submission repair.
  const state = loadState(ctx.stateDir);
  const marker = state.openClaim;
  const budget = marker?.modelBudget;
  if (marker?.chosen && marker.task === task && marker.phase === "claimed" && ctx.reviewRoom && ctx.modelSpendDir &&
      budget && budget.remainingCents >= 2) {
    const heldBack = Math.max(1, Math.floor(budget.remainingCents / 4));
    budget.remainingCents -= heldBack;
    budget.correctionCents = heldBack;
    saveState(ctx.stateDir, state);
  }
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

function releaseInstruction(ctx: WorkerContext, agent: WorkerAgent, terms: Terms) {
  return facade.releaseClaim({ task: terms.task, worker: agent.agentPda, creator: terms.buyer, authority: ctx.signer,
    ...(terms.direct && { taskValidationConfig: null }) });
}

/**
 * What revision 9's release_claim reads to move the deposit: the landing
 * clock against the grace, this claim (its claimed_at changes when it is
 * released and taken again), the claim's balance and Rent (the surplus above
 * rent is the deposit, and a smaller surplus forfeits nothing), and the task's
 * dispute flag (set, a late release refunds the worker). The quote was
 * computed from exactly these values.
 */
export interface ReleaseState { claimedAt: string; claimLamports: string; rentTerms: string; disputeOffset: number; disputeFlag: number }

function le64(value: bigint) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function rentMinimum(terms: Buffer, space: number) {
  // Rent::minimum_balance, with its 128 bytes of storage overhead.
  const amount = Math.trunc(Number(BigInt(space + 128) * terms.readBigUInt64LE(0)) * terms.readDoubleLE(8));
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("The rent settings are out of range.");
  return BigInt(amount);
}

function releaseGuards(window: ReturnType<typeof chosenReleaseWindow> | null, state: ReleaseState | null,
  accounts: { task: Address; claimAccount: Address }) {
  if (!window || !state) return [];
  return [
    window.phase === "early" ? lighthouse.assertClockBefore(window.resumeAt) : lighthouse.assertClockAtLeast(window.resumeAt),
    lighthouse.assertBytes(accounts.claimAccount, 8 + 32 + 32, le64(BigInt(state.claimedAt))),
    lighthouse.assertLamports(accounts.claimAccount, BigInt(state.claimLamports)),
    lighthouse.assertBytes(lighthouse.RENT, 0, Buffer.from(state.rentTerms, "hex")),
    lighthouse.assertBytes(accounts.task, state.disputeOffset, Buffer.from([state.disputeFlag])),
  ];
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
  if (read.kind !== "task" || !data?.length) return null;
  const claim = getTaskClaimDecoder().decode(data);
  if (claim.worker !== agent.agentPda || claim.task !== task || claim.isCompleted) return null;
  const expiresAt = Number(claim.expiresAt);
  const cleanup = expiresAt > 0 && now > expiresAt;
  const live = read.task.status === TaskStatus.InProgress || read.task.status === TaskStatus.PendingValidation;
  const terminal = read.task.status === TaskStatus.Completed || read.task.status === TaskStatus.Cancelled;
  if (!live && !cleanup) return null;
  if (submitted?.length) {
    const prior = getTaskSubmissionDecoder().decode(submitted);
    if (prior.task !== task || prior.claim !== claimPda || prior.worker !== agent.agentPda ||
      prior.status !== SubmissionStatus.Rejected || (!cleanup && marker.revisionSubmissionCount !== prior.submissionCount)) return null;
  }
  const terms = await taskTerms(ctx, agent, task, read.task, true);
  if (!terms) return null;
  // Revision 9 can forfeit the posted deposit only if the claim still holds
  // that much above rent. A prior delivery normally returned it already.
  let releaseState: ReleaseState | null = null;
  if (!terms.contest || cleanup) {
    const [balance, rent, rentBytes] = await Promise.all([
      ctx.getBalance!(claimPda), ctx.getMinimumBalanceForRentExemption!(data.length), ctx.readAccount(lighthouse.RENT),
    ]);
    if (balance - rent < BigInt(terms.deposit)) terms.deposit = "0";
    if (!terms.contest && !cleanup) {
      if (rentBytes?.length !== 17) throw new Error("The current rent settings could not be verified.");
      const rentTerms = Buffer.from(rentBytes.subarray(0, 16));
      // Transactions assert these Rent bytes, so the quote must use them too.
      if (rentMinimum(rentTerms, data.length) !== rent) throw new Error("The current rent settings could not be verified.");
      const encoded = getTaskEncoder().encode(read.task);
      releaseState = { claimedAt: claim.claimedAt.toString(), claimLamports: balance.toString(), rentTerms: rentTerms.toString("hex"),
        disputeOffset: encoded.length - 32 - 2 - 16 + 13, disputeFlag: read.task.reserved[13] ?? 0 };
    }
  }
  const releaseBy = Number(claim.claimedAt + values.CLAIM_RELEASE_GRACE_SECS);
  const window = chosenReleaseWindow(releaseBy, now);
  // A prior dispute permanently protects the deposit, even on a late release.
  const lateRecipient = read.task.reserved[13] ? terms.worker : terms.buyer;
  const depositReturns = now <= releaseBy || lateRecipient === terms.worker;
  const noPendingSend = !marker.chosenAttempt && !marker.releaseRequestedAt;
  const idle = noPendingSend && (marker.phase === "claimed" || marker.phase === "executed");
  const canDeliver = !cleanup && idle && marker.execution && (terms.deadline === 0 || now <= terms.deadline);
  const room = ctx.checkChosenRoom !== undefined;
  const enoughTime = now + RELEASE_LANDING_MARGIN_SECS < expiresAt;
  const [release, submit] = await Promise.all([
    noPendingSend && cleanup && (live || terminal) ? ctx.simulateWork(await cleanupClaimInstruction(ctx, agent, task, read.task, terms.treasury, terminal)) :
      idle && !terms.contest && enoughTime ? ctx.simulateWork(await releaseInstruction(ctx, agent, terms), releaseGuards(window, releaseState, terms)) : null,
    canDeliver && room ? ctx.simulateWork(await deliveryInstruction(ctx, agent, terms, read.task, marker.execution!.resultHashHex)) : null,
  ]);
  // Expiry can return the deposit to the worker (for example after a dispute),
  // or pay the buyer or contest treasury. Use the simulated movement.
  const forfeiture = terms.contest ? terms.treasury : terms.buyer;
  const cleanupRecipient = cleanup && release && terms.deposit !== "0"
    ? (release.changes.some(c => c.address === forfeiture && BigInt(c.delta) > 0n) ? forfeiture : terms.worker) : null;
  return { ...terms, cleanup, terminal, cleanupRecipient, ownerDecision: marker.ownerDecision === true,
    title: marker.title ?? "Chosen job",
    claimedAt: Number(claim.claimedAt), expiresAt, releaseBy: terms.contest || cleanup ? null : releaseBy, depositReturns,
    releaseWindow: terms.contest || cleanup ? null : { ...window, lateRecipient }, releaseState,
    correctionEndsAt: marker.modelBudget?.correctionCents && !cleanup
      ? correctionCutoff({ expiresAt, deadline: terms.deadline, releaseWindow: terms.contest ? null : window }) : null,
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
    if (!marker.execution || marker.execution.resultHashHex !== held.resultHash) throw new Error("The room result changed. Review it again.");
    const { resultHashHex, rewardAmount, resultBytesBase64 } = marker.execution;
    const resultUri = ctx.config.resultUploader ? await uploadResult({ uploaderUrl: ctx.config.resultUploader,
      body: new Uint8Array(Buffer.from(resultBytesBase64, "base64")), ...(ctx.uploadFetch && { fetchImpl: ctx.uploadFetch }) }) : resultPlaceholderUri(resultHashHex);
    prepare({ resultHashHex, rewardAmount, resultUri, preparedAt: new Date().toISOString() });
    ix = await deliveryInstruction(ctx, agent, held, read.task, resultHashHex);
  } else {
    prepare();
    // Keep the simulated instruction even if a peer just made the task terminal.
    ix = held.cleanup ? await cleanupClaimInstruction(ctx, agent, task, read.task, held.treasury, held.terminal)
      : await releaseInstruction(ctx, agent, held);
  }
  signal.throwIfAborted();
  const guards = action === "release" && !held.cleanup ? releaseGuards(held.releaseWindow, held.releaseState, held) : [];
  await ctx.client.send([...guards, ix], { maxRetries: 0 });
  await resumeOpenClaim(ctx, agent);
}
