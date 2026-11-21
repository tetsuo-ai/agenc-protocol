// Turn the journal's records into what a person reads.
import { formatMoney, formatSol, formatWait } from "./client/format.js";
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

/** A revision 9 turn-down the job is under, or null for any other job. */
function revision9TurnDown(job: JobRecord): NonNullable<JobRecord["turnDown"]> | null {
  return job.turnDown !== undefined && job.turnDown.disputable ? job.turnDown : null;
}

/** The provider's side of a turn-down. */
function workingTurnDownText(job: JobRecord, now: number, usdPerSol: number | null): string {
  const turnDown = revision9TurnDown(job);
  if (turnDown === null) {
    // A turn-down made before revision 9 keeps its old rule.
    return job.reviewDeadlineAt !== null
      ? `The buyer turned this down, so the price is on hold while it is reviewed. If nobody rules, your agent is paid ${formatWait(job.reviewDeadlineAt * 1000, now)}.`
      : "The buyer turned this down, so the price is on hold while it is reviewed.";
  }
  if (turnDown.rulingUntil === null) {
    if (turnDown.disputeOpen) {
      const bond = formatMoney(money(turnDown.bondLamports, usdPerSol));
      return `The buyer turned this down. You can dispute that for a bond of ${bond}. The time to dispute it ends ${formatWait(turnDown.disputeUntil * 1000, now)}. If you do not dispute it, the price goes back to the buyer.`;
    }
    return "The buyer turned this down and nobody disputed it in time, so the price goes back to the buyer.";
  }
  return `You disputed the buyer's turn-down. The reviewers' time to rule ends ${formatWait(turnDown.rulingUntil * 1000, now)}. If they rule for you, you are paid and your bond comes back. If they rule for the buyer, the buyer gets the bond. If nobody rules, the price goes back to the buyer and your bond comes back.`;
}

/** The buyer's side of a turn-down; `what` is "price" or "reward". */
function buyingTurnDownText(job: JobRecord, now: number, what: "price" | "reward"): string {
  const turnDown = revision9TurnDown(job);
  if (turnDown === null) {
    // A turn-down made before revision 9 keeps its old rule.
    return job.reviewDeadlineAt !== null
      ? `You turned this down, so the ${what} is on hold while it is reviewed. If the reviewer agrees with you it comes back. If nobody rules, ${what === "price" ? "the provider" : "it"} is paid ${formatWait(job.reviewDeadlineAt * 1000, now)}.`
      : `You turned this down, so the ${what} is on hold while it is reviewed.`;
  }
  if (turnDown.rulingUntil === null) {
    return turnDown.disputeOpen
      ? `You turned this down. The time to dispute it ends ${formatWait(turnDown.disputeUntil * 1000, now)}. If nobody disputes it, the ${what} comes back then.`
      : `You turned this down and nobody disputed it in time. The ${what} is coming back.`;
  }
  return `Your turn-down was disputed. The reviewers' time to rule ends ${formatWait(turnDown.rulingUntil * 1000, now)}. If they rule for you, the ${what} comes back with the bond. If nobody rules, the ${what} comes back.`;
}

/** A refund that is due but cannot be paid yet: what to add. */
function blockedRefundText(job: JobRecord, blocked: string): string {
  const what = job.kind === "request" ? "reward" : "price";
  return `This job is due for its refund, which needs ${formatSol(blocked)} more in this wallet: a first cancel starts the wallet's marketplace record. Add it and the ${what} comes back.`;
}

function statusText(
  job: JobRecord,
  status: JobStatus,
  price: Money,
  now: number,
  usdPerSol: number | null,
): string {
  const amount = formatMoney(price);
  if (
    job.role === "buying" &&
    job.refundBlockedLamports !== undefined &&
    (status === "waiting" || status === "working")
  ) {
    return blockedRefundText(job, job.refundBlockedLamports);
  }
  if (job.role === "buying" && job.kind === "request") return requestText(job, status, amount, now);
  if (job.role === "working") {
    switch (status) {
      case "working":
        return "Your agent is working on this job.";
      case "delivered":
        return "Delivered. Waiting for the buyer to approve it.";
      case "in_review":
        return workingTurnDownText(job, now, usdPerSol);
      case "paid":
        return `Done. Your agent earned ${amount}.`;
      case "refunded":
        return "This job was not paid. The price went back to the buyer.";
      case "failed":
        return job.error ?? "Your agent could not do this job.";
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
      return buyingTurnDownText(job, now, "price");
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

/** The same, for a request posted for anyone to take. */
function requestText(job: JobRecord, status: JobStatus, amount: string, now: number): string {
  switch (status) {
    case "needs_approval":
      return `Waiting for you to approve ${amount}.`;
    case "declined":
      return "Not approved. Nothing was spent.";
    case "starting":
      return "Posting the request.";
    case "waiting":
      return job.autoRefundAt !== null
        ? `Waiting for someone to take it. If nobody does, it is cancelled and the reward comes back ${formatWait(job.autoRefundAt, now)}.`
        : "Waiting for someone to take it.";
    case "working":
      return "Someone took it and is working on it.";
    case "changes_requested":
      return "Changes were asked for. They are being made.";
    case "delivered":
      return job.reviewDeadlineAt !== null
        ? `Delivered. Approve it to pay ${amount}. If nobody reviews it, it is paid ${formatWait(job.reviewDeadlineAt * 1000, now)}.`
        : `Delivered. Approve it to pay ${amount}.`;
    case "in_review":
      return buyingTurnDownText(job, now, "reward");
    case "paid":
      return `Done. ${amount} was paid for it.`;
    case "refunded":
      return job.error ?? "Cancelled. The reward came back.";
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
    /**
     * Whether a note saying what to change can reach the provider. Sending a
     * delivery back records only the note's fingerprint; the words travel
     * through a message host, and not every network has one.
     */
    changesCanBeSent: boolean;
    /**
     * Lamports the paying wallet would spend, once, to start its marketplace
     * record if it turned this down or cancelled it now (0 once it has one).
     * Null when not known.
     */
    firstRecordCostLamports?: bigint | null;
  },
): JobView {
  const status = jobStatus(job);
  const price = money(job.priceLamports, context.usdPerSol);
  const buying = job.role === "buying";
  const kind = job.kind ?? "hire";
  // Only a hired service can be rated: a rating is kept on its listing.
  const canRate = buying && kind === "hire" && status === "paid" && job.rating === null && !job.tidied;
  // Turning a delivery down is a person's call.
  const canTurnDown = buying && status === "delivered" && context.isOwner;
  return {
    id: job.id,
    role: job.role,
    kind,
    agentId: job.agentId,
    title: job.title,
    request: job.request,
    price,
    status,
    statusText: statusText(job, status, price, context.now, context.usdPerSol),
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
    turnDown:
      status === "in_review"
        ? {
            disputable: revision9TurnDown(job) !== null,
            disputeEndsAt:
              revision9TurnDown(job) !== null ? revision9TurnDown(job)!.disputeUntil * 1000 : null,
            disputed: revision9TurnDown(job)?.rulingUntil != null,
            bond:
              revision9TurnDown(job) !== null
                ? money(revision9TurnDown(job)!.bondLamports, context.usdPerSol)
                : null,
            ifNobodyActs: revision9TurnDown(job) !== null ? "buyer_refunded" : "provider_paid",
          }
        : null,
    // Disputing puts a bond at risk: a person's decision, in its window only.
    canDispute:
      !buying &&
      context.isOwner &&
      status === "in_review" &&
      revision9TurnDown(job) !== null &&
      revision9TurnDown(job)!.rulingUntil === null &&
      revision9TurnDown(job)!.disputeOpen,
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
    // Every turn-down is recorded since revision 9.
    turnDownRecorded: canTurnDown,
    firstRecordCost:
      buying && context.firstRecordCostLamports != null && context.firstRecordCostLamports > 0n
        ? money(context.firstRecordCostLamports, context.usdPerSol)
        : null,
    receiptUrl: receiptUrlFor(job, context.network),
    error: job.error,
  };
}

function savedService(
  service: NonNullable<ApprovalRecord["service"]>,
  usdPerSol: number | null,
): ApprovalView["service"] {
  // A request saved by an older version knows less about the service than
  // the type says: those records are still on disk.
  const saved: Partial<NonNullable<ApprovalRecord["service"]>> = service;
  return {
    ...service,
    description: saved.description ?? null,
    tags: saved.tags ?? [],
    inputs: saved.inputs ?? [],
    outputs: saved.outputs ?? [],
    terms: saved.terms ?? [],
    details: saved.details ?? (service.summary === null ? "unavailable" : "ready"),
    marketFee: saved.marketFee ?? null,
    // An older request counted its record another way: it says nothing now.
    paid: saved.paid ?? money(0n, usdPerSol),
    buyers: saved.buyers ?? 0,
    record: saved.record ?? "unavailable",
    offeredBy: saved.offeredBy ?? null,
  };
}

export function approvalView(
  approval: ApprovalRecord,
  agentName: string,
  usdPerSol: number | null,
): ApprovalView {
  const kind = approval.kind ?? "hire";
  return {
    id: approval.id,
    jobId: approval.jobId,
    agentId: approval.agentId,
    agentName,
    kind,
    service:
      kind === "request" || approval.service === null ? null : savedService(approval.service, usdPerSol),
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
