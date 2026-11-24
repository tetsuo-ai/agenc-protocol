// Inputs from a room are deliberately narrower than the authenticated host context.
import type { ApprovalView, JobStatus, Money } from "./types.js";

export interface ChildHirePolicy {
  allowedListings: string[];
  maxDebitLamports: string;
  /** Seconds to keep for the parent after the child's delivery and review. */
  returnBeforeSecs: number;
  reviewWindowSecs: number;
  sharing: "public-brief" | "buyer-approved-input";
}
export interface ChildRoomGrant {
  parentTask: string;
  sellerAgentId: string;
  claimedAt: string;
  roomId: string;
}
export interface ChildHireRequest {
  listing: string;
  brief: string;
  /** "text" or an agreed delivery filename. */
  outputs: string[];
  privateCommitment?: string;
}
/** Canonical fields for the buyer-approved public criterion. File names remain behind the hash. */
export function childSharePayload(supplier: string, request: ChildHireRequest) {
  return JSON.stringify([
    supplier,
    {
      listing: request.listing,
      brief: request.brief.trim(),
      outputs: request.outputs,
      ...(request.privateCommitment && { privateCommitment: request.privateCommitment }),
    },
  ]);
}
export const CHILD_SHARE_PREFIX = "Share the approved input with supplier under grant ";
export interface ChildPayout {
  listingVersion: string;
  price: Money;
  operator: string | null;
  operatorFeeBps: number;
  operatorFee: Money;
  marketplaceFeeBps: number;
  maximumMarketplaceFee: Money;
  minimumSellerNet: Money;
  minimumSellerNetIfOperatorCannotReceive: Money;
}
export interface ChildEscrow {
  jobId: string;
  task: string | null;
  status: JobStatus | "unknown";
  deadline: number | null;
  reviewEndsAt: number | null;
  action: string | null;
  signature: string | null;
}
export interface ChildHireView {
  parent: ChildEscrow;
  child: ChildEscrow;
  phase: "approval" | "declined" | "dispatching" | "funded" | "imported" | "expired" | "failed";
  purchaseKey: string;
  payer: string;
  sellerAgentId: string;
  parentSellerNet: Money;
  supplier: string;
  supplierAuthority: string;
  treasury: string;
  policy: ChildHirePolicy;
  request: ChildHireRequest;
  quote: ApprovalView;
  payout: ChildPayout;
  reviewReserve: Money;
  maxDebit: Money;
  dailyAvailable: Money;
  cap: Money;
  cutoff: number;
  importReceipt: string | null;
}
export interface ChildResult {
  parentTask: string;
  roomId: string;
  claimedAt: string;
  childTask: string;
  purchaseKey: string;
  round: number;
  deliveryHash: string;
  text: string;
  files: { name: string; bytes: number; sha256: string; base64: string }[];
  receipt: string;
}

export interface ChildResultManifest extends Omit<ChildResult, "text" | "files"> {
  textBytes: number;
  files: Omit<ChildResult["files"][number], "base64">[];
}

/** Register on the trusted Market host socket only. A room gets request_supplier, never an owner RPC. */
export interface ChildHireMethods {
  "child.policy": {
    params: { sellerAgentId: string; listing: string; policy: ChildHirePolicy | null };
    result: ChildHirePolicy | null;
  };
  "child.request": { params: { grant: ChildRoomGrant; request: ChildHireRequest }; result: ChildHireView };
  "child.timeline": { params: { parentTask: string }; result: ChildHireView };
  "child.decide": { params: { parentTask: string; quoteId: string; approve: boolean }; result: ChildHireView };
  "child.delivery": { params: { grant: ChildRoomGrant }; result: ChildResultManifest };
  "child.part": {
    params: { grant: ChildRoomGrant; receipt: string; part: string; offset: number };
    result: { base64: string; total: number };
  };
  "child.imported": { params: { grant: ChildRoomGrant; receipt: string }; result: { imported: true } };
}
