// Turn the journal's records into what a person reads.
import { formatMoney, formatWait } from "./client/format.js";
import type {
  ActivityView,
  ApprovalView,
  JobStatus,
  JobView,
  Money,
} from "./client/types.js";
import { lamportsToCents } from "./pricing.js";
import type { ActivityRecord, ApprovalRecord, JobRecord } from "./store.js";

export function money(lamports: bigint | string, usdPerSol: number | null): Money {
  const value = typeof lamports === "bigint" ? lamports : BigInt(lamports);
  return { lamports: value.toString(), usdCents: lamportsToCents(value, usdPerSol) };
}

/** The plain status of a purchase, derived from where the journal says it is. */
export function jobStatus(job: JobRecord): JobStatus {
  switch (job.phase) {
    case "needs_approval":
      return "needs_approval";
    case "declined":
      return "declined";
    case "failed":
      return "failed";
    case "cleared":
    case "hiring":
    case "hired":
      return "starting";
    case "done":
      return job.outcome ?? "problem";
    case "active":
      break;
  }
  if (job.outcome !== null) return job.outcome;
  switch (job.chainStatus) {
    case "in_progress":
      return job.changesRequested ? "changes_requested" : "working";
    case "pending_validation":
      return "delivered";
    case "completed":
      return "paid";
    case "cancelled":
      return "refunded";
    case "disputed":
    case "reject_frozen":
      return "problem";
    case "open":
    case null:
      return "waiting";
  }
}

function statusText(
  job: JobRecord,
  status: JobStatus,
  price: Money,
  now: number,
): string {
  const amount = formatMoney(price);
  if (job.role === "working") {
    switch (status) {
      case "working":
        return "Your agent is working on this job.";
      case "delivered":
        return "Delivered. Waiting for the buyer to approve it.";
      case "paid":
        return `Done. Your agent earned ${amount}.`;
      case "refunded":
        return "The buyer cancelled this job.";
      default:
        return "This job did not complete.";
    }
  }
  switch (status) {
    case "needs_approval":
      return `Waiting for you to approve ${amount}.`;
    case "declined":
      return "Not approved. Nothing was spent.";
    case "starting":
      return "Placing the order.";
    case "waiting":
      return job.autoRefundAt !== null
        ? `Waiting for the provider to start. If nobody does, the job is cancelled and the price comes back ${formatWait(job.autoRefundAt, now)}.`
        : "Waiting for the provider to start.";
    case "working":
      return "The provider is working on it.";
    case "changes_requested":
      return "Changes were asked for. The provider is working on them.";
    case "delivered":
      return job.reviewDeadlineAt !== null
        ? `Delivered. Approve it to pay the provider. If nobody reviews it, it is paid ${formatWait(job.reviewDeadlineAt * 1000, now)}.`
        : "Delivered. Approve it to pay the provider.";
    case "paid":
      return `Done. ${amount} was paid to the provider.`;
    case "refunded":
      return job.error ?? "Cancelled. The price was returned.";
    case "problem":
      return job.error ?? "This job is in dispute on the marketplace.";
    case "failed":
      return job.error ?? "This did not go through. Nothing was spent.";
  }
}

export function receiptUrlFor(job: JobRecord, network: string): string | null {
  const signature = job.signatures.accept;
  if (network !== "mainnet" || signature === undefined) return null;
  return `https://agenc.ag/receipt/${signature}`;
}

export function jobView(
  job: JobRecord,
  context: {
    usdPerSol: number | null;
    now: number;
    network: string;
    isOwner: boolean;
    /** Lamports a rating costs, when known. */
    ratingCostLamports?: bigint | null;
  },
): JobView {
  const status = jobStatus(job);
  const price = money(job.priceLamports, context.usdPerSol);
  const buying = job.role === "buying";
  const canRate = buying && status === "paid" && job.rating === null && !job.tidied;
  return {
    id: job.id,
    role: job.role,
    agentId: job.agentId,
    title: job.title,
    request: job.request,
    price,
    status,
    statusText: statusText(job, status, price, context.now),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    task: job.task,
    listing: job.listing || null,
    provider: job.providerAgent || null,
    result: job.result,
    autoApproveAt:
      status === "delivered" && job.reviewDeadlineAt !== null ? job.reviewDeadlineAt * 1000 : null,
    autoRefundAt: status === "waiting" ? job.autoRefundAt : null,
    canApprove: buying && status === "delivered",
    canAskChanges: buying && status === "delivered",
    canRefund:
      buying &&
      (status === "needs_approval" ||
        status === "waiting" ||
        // Turning down a delivery is a person's call, not an agent's.
        (status === "delivered" && context.isOwner)),
    canRate,
    rating: job.rating,
    ratingCost:
      canRate && context.ratingCostLamports != null
        ? money(context.ratingCostLamports, context.usdPerSol)
        : null,
    receiptUrl: receiptUrlFor(job, context.network),
    error: job.error,
  };
}

export function approvalView(
  approval: ApprovalRecord,
  agentName: string,
  usdPerSol: number | null,
): ApprovalView {
  return {
    id: approval.id,
    jobId: approval.jobId,
    agentId: approval.agentId,
    agentName,
    service: approval.service,
    request: approval.request,
    price: money(approval.priceLamports, usdPerSol),
    deposits: money(approval.depositsLamports, usdPerSol),
    fees: money(approval.keptLamports, usdPerSol),
    fromMain: money(approval.fromMainLamports, usdPerSol),
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  };
}

export function activityView(record: ActivityRecord, usdPerSol: number | null): ActivityView {
  return {
    id: record.id,
    ts: record.ts,
    kind: record.kind,
    text: record.text,
    amount: record.lamports === null ? null : money(record.lamports, usdPerSol),
    agentId: record.agentId,
    jobId: record.jobId,
    signature: record.signature,
  };
}
