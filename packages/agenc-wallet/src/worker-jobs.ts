import { address } from "@solana/kit";
import { chosenReleaseWindow, type HeldWork, type OpenWork } from "@tetsuo-ai/agenc-worker";
import type { WorkerJobView, WorkAction } from "./client/types.js";
import { WalletError } from "./errors.js";
import { money } from "./views.js";

export function workAddress(task: string) {
  try { return address(task); }
  catch { throw new WalletError("BAD_REQUEST", "Select a job from the list."); }
}

function releaseWindowView(job: HeldWork) {
  const window = job.releaseWindow;
  if (!window || job.releaseBy === null) return null;
  const late = window.lateRecipient === job.worker ? "worker" : "buyer";
  let notice: string;
  if (job.deposit === "0") notice = "This claim holds no deposit to pay out.";
  else if (window.phase === "early") {
    const end = new Date(job.releaseBy * 1000).toISOString();
    notice = `If the release lands at or before ${end}, the worker (${job.worker}) gets the deposit. After that, this release fails. A fresh late release pays the ${late} (${window.lateRecipient}).`;
  } else notice = `The return window has ended. The ${late} (${window.lateRecipient}) gets the deposit.`;
  notice += " A release after the window counts as an expired claim.";
  return { ...window, notice };
}

/** Read the chain clock again after quoting and immediately before broadcast. */
export function releaseQuoteLifetime(job: WorkerJobView, now: number) {
  if (job.cleanup && job.expiresAt !== null && Number.isSafeInteger(now) && now > job.expiresAt) return Infinity;
  if (!job.releaseWindow || job.releaseBy === null) throw new WalletError("NOT_ALLOWED", "This claim cannot be released.");
  const current = chosenReleaseWindow(job.releaseBy, now);
  if (current.phase !== job.releaseWindow.phase) throw new WalletError("NOT_ALLOWED", "The return window changed. Review a new release quote.");
  return current.phase === "early" ? (current.resumeAt - now) * 1000 : Infinity;
}

export function workerJob(job: OpenWork | HeldWork, rate: number, defaultFee: bigint, action?: WorkAction): WorkerJobView {
  const open = "specHash" in job;
  const simulation = open ? job.simulation : action === "submit" ? job.submit : job.release ?? job.submit;
  const fee = simulation ? BigInt(simulation.fee) : defaultFee;
  const releaseWindow = open ? null : releaseWindowView(job);
  return {
    ...(!open && job.ownerDecision && { ownerDecision: true }),
    ...(!open && job.cleanup && { cleanup: true, cleanupRecipient: job.cleanupRecipient }),
    task: job.task, title: job.title, reward: money(job.reward, rate), payout: money(job.payout, rate),
    deposit: money(job.deposit, rate), deadline: job.deadline, reviewSeconds: job.reviewSeconds,
    request: open ? job.request : "", criteria: open ? job.criteria : [], brief: open ? job.brief : "",
    buyer: job.buyer, treasury: job.treasury, worker: job.worker, selectionDeadline: job.selectionDeadline, direct: job.direct,
    rent: money(open ? job.rent : 0n, rate), recordRent: money(open ? job.recordRent : 0n, rate),
    futureRent: money(open ? job.futureRent : 0n, rate),
    feeReserve: money(open && BigInt(job.feeReserve) > fee ? job.feeReserve : fee, rate),
    modelBudgetCents: open ? job.modelBudgetCents : null, networkFee: money(fee, rate),
    contest: job.contest, depositReturns: !open && releaseWindow && job.deposit !== "0" ? job.depositReturns : null,
    releaseWindow,
    releaseBy: open ? null : job.releaseBy, expiresAt: open ? null : job.expiresAt,
    resultHash: open ? null : job.resultHash, resultBytes: open ? null : job.resultBytes,
    preview: open ? null : job.preview, canSubmit: !open && job.canSubmit, canRelease: !open && job.canRelease,
  };
}

/** Itemize transfers and check that they explain every simulated account delta. */
export function quoteTransfers(job: OpenWork | HeldWork, action: WorkAction, rate: number) {
  const sim = "simulation" in job ? job.simulation : action === "submit" ? job.submit : job.release;
  if (!sim) throw new WalletError("NOT_AVAILABLE", "The network could not verify the transaction.");
  const flows: { label: string; from: string; to: string; amount: ReturnType<typeof money> }[] = [];
  const changes = new Map<string, bigint>(sim.changes.map(row => [row.address, BigInt(row.delta)]));
  const change = (addr: string) => changes.get(addr) ?? 0n;
  const transfer = (label: string, from: string, to: string, amount: bigint) => {
    if (amount <= 0n) return;
    const row = { label, from, to, amount: money(amount, rate) };
    flows.push(row);
    changes.set(from, change(from) + amount);
    changes.set(to, change(to) - amount);
  };
  const fee = BigInt(sim.fee);
  transfer("Network fee", job.worker, "Network", fee);
  if (action === "claim") {
    transfer("Claim deposit", job.worker, job.claimAccount, BigInt(job.deposit));
    transfer("Claim rent", job.worker, job.claimAccount, change(job.claimAccount));
  } else {
    const recipient = action === "release" && "depositReturns" in job
      ? job.cleanupRecipient ?? (job.depositReturns ? job.worker : job.buyer) : job.worker;
    if (action === "release" && "cleanup" in job && job.cleanup)
      transfer("Cleanup reward", job.escrowAccount, job.worker, -change(job.escrowAccount));
    const leaving = -change(job.claimAccount);
    const deposit = leaving < BigInt(job.deposit) ? leaving : BigInt(job.deposit);
    transfer("Claim deposit returned or paid", job.claimAccount, recipient, deposit);
    transfer("Claim rent and remaining balance returned", job.claimAccount, job.worker, -change(job.claimAccount));
  }
  transfer("Worker record rent", job.worker, job.recordAccount, change(job.recordAccount));
  transfer("Submission rent", job.worker, job.submissionAccount, change(job.submissionAccount));
  transfer("Submission rent returned", job.submissionAccount, job.worker, -change(job.submissionAccount));
  if (job.direct && action === "submit") {
    for (const [recipient, amount] of changes) {
      if (amount > 0n) transfer(recipient === job.worker ? "Worker payout" : "Escrow payment", job.escrowAccount, recipient, amount);
    }
  }
  if ([...changes].some(([account, amount]) => account !== "Network" && amount !== 0n))
    throw new WalletError("NOT_AVAILABLE", "The wallet could not account for every transfer.");
  const charge = flows.filter(row => row.from === job.worker).reduce((sum, row) => sum + BigInt(row.amount.lamports), 0n);
  return { flows, balances: sim.changes.map(row => ({ account: row.address, net: money(row.delta, rate) })), charge: money(charge, rate) };
}


export function workAuthorizationTerms(job: OpenWork | HeldWork, action: WorkAction): string {
  if (action === "release" && "release" in job) {
    // Whether a separate delivery is possible has no bearing on a refund.
    const { submit, canSubmit, ...releaseTerms } = job;
    return JSON.stringify(releaseTerms);
  }
  return JSON.stringify(job);
}
