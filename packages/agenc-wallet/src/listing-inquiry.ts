import { selectedListingTerms, verifyListingMessage, type ListingAgreement, type ListingIdentity } from "./client/listing-exchange.js";
import { WalletError } from "./errors.js";

import type { Address, KeyPairSigner } from "@solana/kit";
import type { Chain } from "./chain.js";
import { readListing } from "./market.js";
import { requestJson } from "./hosted-http.js";
import { listingMessageText, verifiedExchange, type ListingMessage, type SignedListing, type ListingHeartbeat,
  type ListingExchangeView } from "./client/listing-exchange.js";

declare module "./store.js" {
  interface AgentRecord { inquiryListings?: string[] }
  interface JobRecord { listingAgreement?: ListingAgreement; fulfilment?: import("./listing-details.js").FulfilmentTerms }
}

export async function verifyAgreedTerms(agreement: ListingAgreement, listing: ListingIdentity, buyer: string, now: number) {
  try {
    return await selectedListingTerms(agreement, listing, buyer, now);
  } catch {
    throw new WalletError("PRICE_CHANGED", "The selected inquiry terms could not be verified. Request a fresh reply and quote.");
  }
}

export async function currentListingIdentity(chain: Chain, listing: Address) {
  const current = await readListing(chain, listing);
  if (!current) throw new WalletError("NOT_FOUND", "This listing is unavailable.");
  return { listing, version: current.version.toString(), provider: current.authority };
}
export async function readListingExchange(identity: ListingIdentity, now = Date.now(), read = fetch) {
  const base = "https://agenc.ag/api/listings/" + encodeURIComponent(identity.listing);
  const [signal, inquiries] = await Promise.all(["availability", "inquiries"].map(section =>
    requestJson(read, base + "/" + section, { method: "GET" }, { timeoutMs: 4000, maxBytes: 512 * 1024 })));
  if (signal?.status !== 200 || inquiries?.status !== 200) throw new WalletError("NETWORK", "The provider exchange is unavailable.");
  const heartbeat = (signal.body as { heartbeat: SignedListing<ListingHeartbeat> | null }).heartbeat;
  const threads = (inquiries.body as ListingExchangeView).threads;
  return verifiedExchange({ identity, heartbeat, threads }, identity, now);
}

export async function publishListingMessage(identity: ListingIdentity, message: ListingMessage, signer: KeyPairSigner, now: number, send = fetch) {
  if (identity.listing !== message.listing || identity.version !== message.version || identity.provider !== message.provider ||
      signer.address !== (message.kind === "question" ? message.buyer : identity.provider))
    throw new WalletError("NOT_ALLOWED", "The listing or signing identity changed.");
  const [proof] = await signer.signMessages([{ content: new TextEncoder().encode(listingMessageText(message)), signatures: {} }]);
  const signed = { message, signature: Buffer.from(proof![signer.address]!).toString("base64") };
  await verifyListingMessage(signed, identity, now);
  const section = message.kind === "availability" ? "availability" : "inquiries";
  const response = await requestJson(send, "https://agenc.ag/api/listings/" + encodeURIComponent(identity.listing) + "/" + section,
    { method: "POST", body: signed }, { timeoutMs: 4000, maxBytes: 4096 });
  if (response.status !== 200) throw new WalletError("NOT_AVAILABLE", "The provider exchange did not accept the message. Refresh the listing.");
  return signed;
}

export async function readAvailability(chain: Chain, listing: Address, version: string | undefined, read = fetch) {
  if (chain.network !== "mainnet") return undefined;
  const identity = await currentListingIdentity(chain, listing);
  if (identity.version !== version) return undefined;
  let heartbeat: ListingHeartbeat | null = null;
  try {
    const response = await requestJson(read, "https://agenc.ag/api/listings/" + listing + "/availability",
      { method: "GET" }, { timeoutMs: 2500, maxBytes: 4096 });
    const signed = (response.body as { heartbeat?: SignedListing<ListingHeartbeat> })?.heartbeat;
    if (response.status === 200 && signed?.message.kind === "availability") {
      await verifyListingMessage(signed, identity, Date.now(), true);
      heartbeat = signed.message;
    }
  } catch { /* An offline relay leaves the last check unknown. */ }
  return { identity, heartbeat };
}
