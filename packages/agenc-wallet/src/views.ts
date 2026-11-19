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
    case "reject_frozen":
      return "in_review";
    case "disputed":
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
      case "in_review":
        return job.reviewDeadlineAt !== null
          ? `The buyer turned this down, so the price is on hold while it is reviewed. If nobody rules, your agent is paid ${formatWait(job.reviewDeadlineAt * 1000, now)}.`
          : "The buyer turned this down, so the price is on hold while it is reviewed.";
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
    case "in_review":
      return job.reviewDeadlineAt !== null
        ? `You turned this down, so the price is on hold while it is reviewed. If the reviewer agrees with you it comes back. If nobody rules, the provider is paid ${formatWait(job.reviewDeadlineAt * 1000, now)}.`
        : "You turned this down, so the price is on hold while it is reviewed.";
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
    /** Lamports the deposit behind a provider's record costs, when known. */
    recordCostLamports?: bigint | null;
    /**
     * Whether a note saying what to change can reach the provider. Sending a
     * delivery back records only the note's fingerprint; the words travel
     * through a message host, and not every network has one.
     */
    changesCanBeSent: boolean;
  },
): JobView {
  const status = jobStatus(job);
  const price = money(job.priceLamports, context.usdPerSol);
  const buying = job.role === "buying";
  const canRate = buying && status === "paid" && job.rating === null && !job.tidied;
  // Turning a delivery down is a person's call.
  const canTurnDown = buying && status === "delivered" && context.isOwner;
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
    // A delivery saved before files could come with one has no list.
    result: job.result === null ? null : { ...job.result, files: job.result.files ?? [] },
    autoApproveAt:
      status === "delivered" && job.reviewDeadlineAt !== null ? job.reviewDeadlineAt * 1000 : null,
    autoRefundAt: status === "waiting" ? job.autoRefundAt : null,
    reviewEndsAt:
      status === "in_review" && job.reviewDeadlineAt !== null ? job.reviewDeadlineAt * 1000 : null,
    canApprove: buying && status === "delivered",
    // Without a way to deliver the words, asking for changes would send a
    // delivery back with a request the provider can never read.
    canAskChanges: buying && status === "delivered" && context.changesCanBeSent,
    canRefund:
      buying &&
      (status === "needs_approval" ||
        status === "waiting" ||
        // Turning down a delivery is a person's call, not an agent's.
        canTurnDown),
    canRate,
    rating: job.rating,
    ratingCost:
      canRate && context.ratingCostLamports != null
        ? money(context.ratingCostLamports, context.usdPerSol)
        : null,
    turnDownCost:
      canTurnDown && job.providerRecorded === false && context.recordCostLamports != null
        ? money(context.recordCostLamports, context.usdPerSol)
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
  // A request saved by an older version knows less about the service than
  // the type says: those records are still on disk.
  const saved: Partial<ApprovalRecord["service"]> = approval.service;
  return {
    id: approval.id,
    jobId: approval.jobId,
    agentId: approval.agentId,
    agentName,
    service: {
      ...approval.service,
      description: saved.description ?? null,
      tags: saved.tags ?? [],
      inputs: saved.inputs ?? [],
      outputs: saved.outputs ?? [],
      terms: saved.terms ?? [],
      details: saved.details ?? (approval.service.summary === null ? "unavailable" : "ready"),
    },
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
