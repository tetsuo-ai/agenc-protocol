import type { Money } from "./types.js";
export type TransferRequest = {
  kind: "fund" | "reclaim" | "withdraw";
  agentId?: string;
  to?: string;
  amount: { lamports: string } | { usdCents: number } | "all";
};
export interface TransferQuote {
  id: string; network: string; kind: TransferRequest["kind"]; payer: string; recipient: string;
  credit: Money; fee: Money; retained: Money; maximumDebit: Money; expiresAt: number;
}
export interface RatingQuote {
  id: string; jobId: string; task: string; listing: string; payer: string; score: number;
  fee: Money; rent: Money; maximumDebit: Money; expiresAt: number;
}
export interface AccountChange {
  signature: string; account: string; delta: string; payerFee: string; at: number | null;
  externalSender: string | null; failed: boolean;
  /** The marketplace step this account's own receipt took, when it paid for one. */
  step?: "registration" | "job claim" | "job delivery" | "job release";
}
export interface HistoryCursor { account: string; signature: string }
export interface HistoryQuery { account?: string; jobId?: string; before?: HistoryCursor; limit?: number }

export interface HistoryRow extends AccountChange {
  kind: "deposit" | "fee" | "refund" | "rent" | "transfer" | "settlement" | "job funding" | "job check" | "job update" | "rating" | "stake return" | "service setup" | "other"
    | "registration" | "job claim" | "job delivery" | "job release";
  jobId?: string;
}

export interface ContestStakeQuote {
  id: string; jobId: string; registration: string; authority: string; expiresAt: number; sharedJobs: string[];
  reusedRegistration: boolean; obligations: string[]; stake: Money; retainedRent: Money; fee: Money; credit: Money; netCredit: Money;
}
export interface PaymentOutcome {
  canRetry?: boolean;
  id: string; signature: string; state: "pending" | "confirmed" | "failed";
}

export interface MoneyMethods {
  "wallet.transferQuote": { params: TransferRequest; result: TransferQuote };
  "wallet.confirmTransfer": { params: { id: string }; result: PaymentOutcome };
  "wallet.pendingTransfers": { params: Record<string, never>; result: { quote: TransferQuote; outcome: PaymentOutcome }[] };
  "wallet.operationOutcome": { params: { id: string }; result: PaymentOutcome | null };
  "wallet.moneyHistory": { params: HistoryQuery; result: { query: Omit<HistoryQuery, "before">; next: HistoryCursor | null; rows: HistoryRow[]; gaps: { account: string; message: string }[] } };
  "jobs.ratingQuote": { params: { jobId: string; score: number }; result: RatingQuote };
  "jobs.publishReview": { params: { jobId: string; stars: number; text: string }; result: import("./task-review.js").SignedTaskReview };
  "jobs.contestRegistrations": { params: Record<string, never>; result: { jobId: string; agentId: string }[] };
  "jobs.contestStake": { params: { jobId: string }; result: ContestStakeQuote };
  "jobs.retireRegistration": { params: { id: string }; result: PaymentOutcome & { actualCreditLamports: string | null; actualNetLamports: string | null } };
  "earn.operation": { params: { agentId: string; quoteId: string }; result: SellerOperationReceipt | null };
}

export interface SellerOperationReceipt {
  quoteId: string; seller: string; offerId: string; listingId: string; listing: string | null; terms: string;
  metadataHash: string; priceLamports: string; fundedLamports: string; state: PaymentOutcome["state"];
  fundingSignature: string | null; listingSignature: string | null; network: string;
}
