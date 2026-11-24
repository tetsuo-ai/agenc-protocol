import type { ChildHireView, ChildRoomGrant, ChildHirePolicy } from "./client/child-hire.js";
import type { ApprovalRecord, JobRecord, WalletState } from "./store.js";

/** Part of the existing atomic, wallet-locked journal. No separate balance or signer. */
export interface ChildHireRecord {
  grant: ChildRoomGrant;
  parentListing: string;
  parentWorker: string;
  fingerprint: string;
  view: ChildHireView;
  /** Private until the exact Market decision. A normal approvals.decide cannot spend this draft. */
  draft?: { job: JobRecord; approval: ApprovalRecord };
  delivered?: { receipt: string; hash: string; round: number };
  send?: import("./transport-scope.js").PendingListingSend;
  approvedAt?: number;
  /** Seller-local B staging, scoped to this original buyer grant and supplier. */
  supplierCommitment?: string;
  reviewSpent?: string;
  reviewDebits?: Record<string, string>;
}
export interface ChildHireState {
  childPolicies?: Record<string, ChildHirePolicy>;
  childHires?: Record<string, ChildHireRecord>;
}
export function childState(state: WalletState): WalletState & ChildHireState {
  return state;
}
export function childForJob(state: WalletState, job: JobRecord) {
  if (!job.idempotencyKey?.startsWith("child/")) return undefined;
  const parent = job.idempotencyKey.split("/")[1];
  if (!parent) return undefined;
  const record = childState(state).childHires?.[parent];
  return record?.view.child.jobId === job.id ? record : undefined;
}

/** A purchase with an unknown signature holds its whole amount across daily rollovers.
 * After confirmation only the unused review provision stays held. jobSpends contains the purchase. */
export interface ChildHold {
  purchase: string;
  review: string;
  rate: number;
  funded: boolean;
}
export function childHolds(agent: import("./store.js").AgentRecord) {
  return agent as typeof agent & { childHolds?: Record<string, ChildHold> };
}

export function childOwnsKey(state: WalletState, key: string | undefined) {
  const parts = key?.trim().split("/");
  if (parts?.length !== 3 || parts[0] !== "child") return false;
  return childState(state).childHires?.[parts[1]!]?.view.purchaseKey === key?.trim();
}

/** F includes these seller-owned pending actions in jobs.inbox. A draft has no funded child job yet. */
export function childHireActions(state: WalletState, now: number, agentId?: string) {
  return Object.values(childState(state).childHires ?? {}).flatMap(({ view, draft }) => {
    if (!draft || view.phase !== "approval" || (agentId && view.sellerAgentId !== agentId)) return [];
    const dueAt = view.quote.expiresAt;
    return [
      {
        id: view.quote.id,
        agentId: view.sellerAgentId,
        jobId: view.parent.jobId,
        role: "working" as const,
        title: dueAt > now ? "Approve supplier hire" : "Refresh supplier quote",
        event: "review" as const,
        dueAt,
        stage: dueAt <= now ? ("due" as const) : ("soon" as const),
      },
    ];
  });
}
