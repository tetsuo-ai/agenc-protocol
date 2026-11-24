import type { Money } from "./types.js";

export type ReviewAction = "change" | "reject" | "dispute";
export interface ReviewAttachment { uri: string; hash: string }
export interface ReviewDraft {
  action: ReviewAction;
  note: string;
  attachments: ReviewAttachment[];
  quoteId: string;
}
export interface ReviewConfirmation extends ReviewDraft {
  files?: { name: string; base64: string }[];
}
export interface ReviewQuote {
  id: string;
  actions: ReviewAction[];
  fee: Money;
  rejectionTotal: Money;
  disputeTotal: Money;
  rejectionRent: Money;
  disputeRent: Money;
  bond: Money;
  treasury?: string;
  payer?: string;
  dailyLimitCents?: number | null;
  canPay: boolean;
  submissionCount: number;
  deliveryHash: string;
  reviewEndsAt: number;
  reviewWindowSeconds: number;
  estimatedResubmitBy: number | null;
}
export interface ReviewedDelivery { deliveryHash: string; submissionCount: number }
export interface ReviewEntry {
  action: ReviewAction | "approve";
  intendedDelivery?: ReviewedDelivery | undefined;
  appliedDelivery?: ReviewedDelivery | undefined;
  /** From the payment receipt itself, including when the submission history was pruned. */
  paidDeliveryHash?: string;
  deliveryNotice?: string;
  signature: string;
  fee: Money | null;
  rent: Money | null;
  bond: Money | null;
  evidenceUri?: string;
  evidenceVerified?: boolean;
  hash: string;
  at: number;
  deadline: number | null;
  note: string | null;
  attachments: ReviewAttachment[];
}
export interface ReviewRecord {
  entries: ReviewEntry[];
  historyIncomplete?: boolean;
  continuation?: string;
  publication?: { intendedDelivery?: ReviewedDelivery; hashes: string[]; published?: string[]; signature?: string; confirmed: boolean };
  historyAvailable: boolean;
  termsAvailable: boolean;
  resubmitBy: number | null;
  quote: ReviewQuote | null;
  draft: ReviewDraft | null;
}
