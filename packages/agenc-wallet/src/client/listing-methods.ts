import type { ListingExchangeView, ListingHeartbeat, ListingQuestion, ListingReply, SignedListing } from "./listing-exchange.js";

export interface ListingMethods {
  "listings.preferences": { params: { agentId: string; listing: string; inquiries: boolean }; result: { inquiries: boolean } };
  "listings.inquiries": { params: { listing: string }; result: ListingExchangeView };
  "listings.message": { params: { agentId: string; message: ListingQuestion | ListingReply }; result: SignedListing };
  "listings.heartbeat": { params: { agentId: string; message: ListingHeartbeat }; result: SignedListing };
}
