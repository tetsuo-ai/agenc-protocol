import type { Money } from "./types.js";

/** Snapshot shown for this hire. Settlement can discount the marketplace fee
 * or return an uncreditable operator fee to the seller. */
export interface HirePayoutQuote {
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
