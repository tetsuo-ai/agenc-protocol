import type { AgencWallet } from "./wallet.js";
import type { ListingMethods } from "./client/listing-methods.js";
import { WalletError } from "./errors.js";

export function listingHandlers(wallet: AgencWallet) {
  return {
    "listings.preferences": (p: ListingMethods["listings.preferences"]["params"], session: { role: string }) => {
      if (session.role !== "owner") throw new WalletError("NOT_ALLOWED", "Only the owner can change inquiry preferences.");
      return wallet.setListingInquiries(p.agentId, p.listing, p.inquiries);
    },
    "listings.inquiries": (p: ListingMethods["listings.inquiries"]["params"]) => wallet.listingExchange(p.listing),
    "listings.message": (p: ListingMethods["listings.message"]["params"], session: { role: string; agentId?: string | null }) => {
      if (p.message?.kind !== "question" && p.message?.kind !== "reply") throw new WalletError("BAD_REQUEST", "Select a question or reply.");
      const id = session.role === "owner" ? p.agentId : session.agentId;
      if (!id) throw new WalletError("NOT_ALLOWED", "Select a buying or serving agent.");
      return wallet.postListingMessage(id, p.message);
    },
    "listings.heartbeat": (p: ListingMethods["listings.heartbeat"]["params"], session: { role: string }) => {
      if (session.role !== "owner" || p.message?.kind !== "availability") throw new WalletError("NOT_ALLOWED", "Only the serving host can report its room check.");
      return wallet.postListingMessage(p.agentId, p.message);
    },
  };
}
