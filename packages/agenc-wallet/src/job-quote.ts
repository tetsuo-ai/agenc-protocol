import { centsToLamports } from "./pricing.js";
import { FEE_HEADROOM_LAMPORTS } from "./market.js";
import { APPROVAL_FEE_LAMPORTS } from "./approval.js";
import { WalletError } from "./errors.js";
import type { ServiceView } from "./client/types.js";
import type { ApprovalRecord, JobRecord } from "./store.js";

/** Base signatures for creation, pinning, payment, cleanup and moderation. */
export const JOB_TRANSACTION_FEES_LAMPORTS = 20_000n + APPROVAL_FEE_LAMPORTS;

export function jobCosts(deposits: { total: bigint; kept: bigint }) {
  const fees = deposits.kept + JOB_TRANSACTION_FEES_LAMPORTS;
  const returned = deposits.total - FEE_HEADROOM_LAMPORTS - deposits.kept;
  return { fees, returned, extra: returned + fees };
}

export function checkPriceLimit(lamports: bigint, cap: number | undefined, rate: number | null): void {
  if (cap === undefined) return;
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new WalletError("BAD_REQUEST", "Enter the price limit in whole cents.");
  if (rate === null) throw new WalletError("NETWORK", "Dollar prices are not available right now, so the price limit cannot be checked.");
  if (lamports > centsToLamports(cap, rate)) throw new WalletError("PRICE_CHANGED", "The service costs more than the price limit.");
}

/** Snapshot a job and its matching approval together. Both panel and agent requests use this quote. */
export function buildJobQuote(record: JobRecord, input: {
  approvalId: string;
  payer: "main" | "agent";
  service: ServiceView | null;
  deposits: { total: bigint; kept: bigint };
  protocolFeeBps: number;
  rate: number | null;
  now: number;
  expiresAt: number;
}): { job: JobRecord; approval: ApprovalRecord } {
  const { approvalId, payer, service, deposits, protocolFeeBps, rate, now, expiresAt } = input;
  const cost = jobCosts(deposits);
  const job = {
    ...record, payer,
    approvedCosts: { total: deposits.total.toString(), kept: deposits.kept.toString(), protocolFeeBps, expiresAt },
  };
  const approval: ApprovalRecord = {
    id: approvalId,
    jobId: job.id,
    agentId: job.agentId,
    kind: job.kind ?? "hire",
    service,
    request: job.request,
    acceptance: job.acceptance,
    ...(job.terms && { terms: job.terms }),
    ...(job.maxPriceCents !== undefined && { maxPriceCents: job.maxPriceCents }),
    priceLamports: job.priceLamports,
    depositsLamports: cost.extra.toString(),
    keptLamports: cost.fees.toString(),
    fromMainLamports: payer === "main" ? (BigInt(job.priceLamports) + cost.extra).toString() : "0",
    protocolFeeBps,
    quoteRate: rate,
    createdAt: now,
    expiresAt,
    status: "pending",
  };
  return { job, approval };
}
