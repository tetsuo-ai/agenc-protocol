import { address } from "@solana/kit";
import type { HeldWork, OpenWork } from "@tetsuo-ai/agenc-worker";
import type { WorkerJobView, WorkAction } from "./client/types.js";
import { WalletError } from "./errors.js";
import { money } from "./views.js";

export function workAddress(task: string) {
  try { return address(task); }
  catch { throw new WalletError("BAD_REQUEST", "Select a job from the list."); }
}

export function workerJob(job: OpenWork | HeldWork, rate: number, defaultFee: bigint, action?: WorkAction): WorkerJobView {
  const open = "specHash" in job;
  const simulation = open ? job.simulation : action === "submit" ? job.submit : job.release ?? job.submit;
  const fee = simulation ? BigInt(simulation.fee) : defaultFee;
  return {
    task: job.task, title: job.title, reward: money(job.reward, rate), payout: money(job.payout, rate),
    deposit: money(job.deposit, rate), deadline: job.deadline, reviewSeconds: job.reviewSeconds,
    request: open ? job.request : "", criteria: open ? job.criteria : [], brief: open ? job.brief : "",
    buyer: job.buyer, treasury: job.treasury, worker: job.worker, selectionDeadline: job.selectionDeadline, direct: job.direct,
    rent: money(open ? job.rent : 0n, rate), recordRent: money(open ? job.recordRent : 0n, rate),
    futureRent: money(open ? job.futureRent : 0n, rate),
    feeReserve: money(open && BigInt(job.feeReserve) > fee ? job.feeReserve : fee, rate),
    modelBudgetCents: open ? job.modelBudgetCents : null, networkFee: money(fee, rate),
    contest: job.contest, depositReturns: open || job.contest ? null : job.depositReturns,
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
    flows.push({ label, from, to, amount: money(amount, rate) });
    changes.set(from, change(from) + amount);
    changes.set(to, change(to) - amount);
  };
  const fee = BigInt(sim.fee);
  transfer("Network fee", job.worker, "Network", fee);
  if (action === "claim") {
    transfer("Claim deposit", job.worker, job.claimAccount, BigInt(job.deposit));
    transfer("Claim rent", job.worker, job.claimAccount, change(job.claimAccount));
  } else {
    const recipient = action === "release" && "depositReturns" in job && !job.depositReturns ? job.buyer : job.worker;
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
