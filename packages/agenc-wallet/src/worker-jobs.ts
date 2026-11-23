import { address } from "@solana/kit";
import type { HeldWork, OpenWork } from "@tetsuo-ai/agenc-worker";
import type { WorkerJobView } from "./client/types.js";
import { WalletError } from "./errors.js";
import { money } from "./views.js";

export function workAddress(task: string) {
  try { return address(task); }
  catch { throw new WalletError("BAD_REQUEST", "Select a job from the list."); }
}

export function workerJob(job: OpenWork | HeldWork, rate: number, fee: bigint): WorkerJobView {
  const open = "specHash" in job;
  return {
    task: job.task, title: job.title, reward: money(job.reward, rate), payout: money(job.payout, rate),
    deposit: money(job.deposit, rate), deadline: job.deadline, reviewSeconds: job.reviewSeconds,
    request: open ? job.request : "", criteria: open ? job.criteria : [],
    rent: money(open ? job.rent : 0n, rate), recordRent: money(open ? job.recordRent : 0n, rate),
    feeReserve: money(open && BigInt(job.feeReserve) > fee ? job.feeReserve : fee, rate),
    modelBudgetCents: open ? job.modelBudgetCents : null, networkFee: money(fee, rate),
    contest: job.contest, depositReturns: open ? null : job.depositReturns,
    releaseBy: open ? null : job.releaseBy, expiresAt: open ? null : job.expiresAt,
    resultHash: open ? null : job.resultHash, resultBytes: open ? null : job.resultBytes,
    preview: open ? null : job.preview, canSubmit: !open && job.canSubmit, canRelease: !open && job.canRelease,
  };
}
