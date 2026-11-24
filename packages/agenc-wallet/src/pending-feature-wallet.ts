// Wallet methods that tracks A (money) and E (listings) implement on their
// own branches. This branch spreads their handlers (money-handlers.ts,
// listing-handlers.ts) unchanged, owner checks included, so the RPC table and
// scope are final. Until the final merge brings the methods, a call answers
// NOT_AVAILABLE after the owner check.
//
// FINAL MERGE: delete this file and the `withPendingFeatures` wrapper in
// feature-dispatch.ts once wallet.ts has every method below.
// tests/feature-dispatch.test.ts fails while a listed method already exists.
import type { MoneyMethods } from "./client/money-operations.js";
import type { ListingMethods } from "./client/listing-methods.js";
import { WalletError } from "./errors.js";
import type { AgencWallet } from "./wallet.js";

type Money<M extends keyof MoneyMethods> = Promise<MoneyMethods[M]["result"]>;
type Listing<M extends keyof ListingMethods> = Promise<ListingMethods[M]["result"]>;

declare module "./wallet.js" {
  interface AgencWallet {
    quoteTransfer(request: MoneyMethods["wallet.transferQuote"]["params"]): Money<"wallet.transferQuote">;
    confirmTransfer(id: string): Money<"wallet.confirmTransfer">;
    pendingTransfers(): Money<"wallet.pendingTransfers">;
    operationOutcome(id: string): Money<"wallet.operationOutcome">;
    moneyHistory(input?: MoneyMethods["wallet.moneyHistory"]["params"] | string): Money<"wallet.moneyHistory">;
    quoteRating(jobId: string, score: number, isOwner: boolean, agentId?: string): Money<"jobs.ratingQuote">;
    publishOrdinaryReview(jobId: string, stars: number, text: string): Money<"jobs.publishReview">;
    contestRegistrations(): Money<"jobs.contestRegistrations">;
    quoteContestRetirement(jobId: string): Money<"jobs.contestStake">;
    retireContestRegistration(id: string): Money<"jobs.retireRegistration">;
    sellerOperation(agentId: string, quoteId: string): Money<"earn.operation">;
    setListingInquiries(agentId: string, listing: string, inquiries: boolean): Listing<"listings.preferences">;
    listingExchange(listing: string): Listing<"listings.inquiries">;
    postListingMessage(
      agentId: string,
      message: ListingMethods["listings.message"]["params"]["message"] | ListingMethods["listings.heartbeat"]["params"]["message"],
    ): Listing<"listings.message">;
  }
}

export const PENDING_FEATURE_METHODS = [
  "quoteTransfer", "confirmTransfer", "pendingTransfers", "operationOutcome", "moneyHistory", "quoteRating",
  "publishOrdinaryReview", "contestRegistrations", "quoteContestRetirement", "retireContestRegistration",
  "sellerOperation", "setListingInquiries", "listingExchange", "postListingMessage",
] as const;

const pending = new Set<string>(PENDING_FEATURE_METHODS);

/** The wallet, with a plain NOT_AVAILABLE answer for a pending feature method it lacks. */
export function withPendingFeatures(wallet: AgencWallet): AgencWallet {
  return new Proxy(wallet, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value === "function") return value.bind(target);
      if (typeof name === "string" && pending.has(name)) {
        return () => Promise.reject(new WalletError("NOT_AVAILABLE", "This wallet needs the updated Market feature."));
      }
      return value;
    },
  });
}
