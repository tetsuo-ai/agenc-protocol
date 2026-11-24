import { ed25519 } from "@noble/curves/ed25519.js";
// Wire format shared by the wallet, serving host and public listing routes.
export interface ListingIdentity {
  listing: string;
  version: string;
  provider: string; // Signing authority of the listing, not its registration PDA.
}
export interface ListingHeartbeat extends ListingIdentity {
  kind: "availability";
  issued: number;
  expires: number;
  roomChecked: number;
  startSeconds: number;
  inquiries: boolean;
}
export interface ListingQuestion extends ListingIdentity {
  kind: "question";
  issued: number;
  expires: number;
  buyer: string;
  question: string;
}
export interface ListingReply extends ListingIdentity {
  kind: "reply";
  issued: number;
  expires: number;
  buyer: string;
  questionSignature: string;
  reply: string;
  terms: string[];
}
export type ListingMessage = ListingHeartbeat | ListingQuestion | ListingReply;
export interface SignedListing<T extends ListingMessage = ListingMessage> { message: T; signature: string }
export interface ListingAgreement {
  question: SignedListing<ListingQuestion>;
  reply: SignedListing<ListingReply>;
  selected: number[];
}

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function publicKey(address: string) {
  if (typeof address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error("Invalid listing identity.");
  let n = 0n;
  for (const digit of address) n = n * 58n + BigInt(alphabet.indexOf(digit));
  const bytes = [];
  while (n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of address) { if (c !== "1") break; bytes.unshift(0); }
  if (bytes.length !== 32) throw new Error("Invalid listing identity.");
  return Uint8Array.from(bytes);
}
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max && value.trim().length > 0;
const signature = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9+/]{85}[AQgw]==$/.test(value);
export const HEARTBEAT_TTL = 120_000;
export function listingMessageText(m: ListingMessage) {
  const common = ["kind", "listing", "version", "provider", "issued", "expires"];
  const keys = m.kind === "availability" ? ["roomChecked", "startSeconds", "inquiries"]
    : m.kind === "question" ? ["buyer", "question"] : ["buyer", "questionSignature", "reply", "terms"];
  if (Object.keys(m).some(key => !common.includes(key) && !keys.includes(key)))
    throw new Error("Unexpected listing message fields.");
  publicKey(m.listing);
  publicKey(m.provider);
  if (typeof m.version !== "string" || !/^(0|[1-9]\d{0,19})$/.test(m.version) || BigInt(m.version) > 0xffffffffffffffffn ||
      !Number.isSafeInteger(m.issued) || m.issued <= 0 || !Number.isSafeInteger(m.expires) ||
      m.expires <= m.issued || m.expires - m.issued > (m.kind === "availability" ? HEARTBEAT_TTL : 7 * 86400_000))
    throw new Error("Invalid listing version or validity period.");
  const fields: unknown[] = ["agenc.ag/listing-exchange/v1/mainnet", m.kind, m.listing, m.version, m.provider, m.issued, m.expires];
  if (m.kind === "availability") {
    if (!Number.isSafeInteger(m.roomChecked) || m.roomChecked > m.issued || m.expires > m.roomChecked + HEARTBEAT_TTL ||
        !Number.isSafeInteger(m.startSeconds) || m.startSeconds < 0 || m.startSeconds > 86400 || typeof m.inquiries !== "boolean")
      throw new Error("A recent room check and an estimated start are required.");
    fields.push(m.roomChecked, m.startSeconds, m.inquiries);
  } else {
    publicKey(m.buyer);
    fields.push(m.buyer);
    if (m.kind === "question" && text(m.question, 1000)) fields.push(m.question);
    else if (m.kind === "reply" && signature(m.questionSignature) && text(m.reply, 1000) && Array.isArray(m.terms) &&
      m.terms.length <= 8 && m.terms.every(term => text(term, 300))) fields.push(m.questionSignature, m.reply, m.terms);
    else throw new Error("Invalid listing inquiry.");
  }
  return JSON.stringify(fields);
}

export async function verifyListingMessage(signed: SignedListing, identity: ListingIdentity, now: number, allowExpired = false) {
  const m = signed.message;
  if (m.listing !== identity.listing || m.version !== identity.version || m.provider !== identity.provider ||
      m.issued > now || (!allowExpired && m.expires <= now) || !signature(signed.signature))
    throw new Error("Listing details changed or the signed message expired.");
  const payload = new TextEncoder().encode(listingMessageText(m));
  const signer = m.kind === "question" ? m.buyer : m.provider;
  const bytes = Uint8Array.from(atob(signed.signature), c => c.charCodeAt(0));
  if (!ed25519.verify(bytes, payload, publicKey(signer), { zip215: false })) throw new Error("Listing signature could not be verified.");
}

export function availabilityView(heartbeat: ListingHeartbeat | null, now: number) {
  const current = heartbeat && now >= heartbeat.issued && now < heartbeat.expires ? heartbeat : null;
  return { status: current ? "available" : "unknown",
    ageSeconds: heartbeat ? Math.max(0, Math.floor((now - heartbeat.issued) / 1000)) : null,
    roomChecked: heartbeat?.roomChecked ?? null, expires: heartbeat?.expires ?? null,
    estimatedStart: current ? current.issued + current.startSeconds * 1000 : null,
    inquiries: current?.inquiries ?? false };
}

export type ListingThread = { question: SignedListing<ListingQuestion>; reply?: SignedListing<ListingReply> };
export interface ListingExchangeView {
  identity: ListingIdentity;
  heartbeat: SignedListing<ListingHeartbeat> | null;
  threads: ListingThread[];
}

export async function verifiedExchange(view: ListingExchangeView, identity: ListingIdentity, now: number) {
  if (!Array.isArray(view.threads) || view.threads.length > 32) throw new Error("The inquiry list is invalid.");
  if (view.heartbeat) {
    if (view.heartbeat.message.kind !== "availability") throw new Error("Invalid availability signal.");
    await verifyListingMessage(view.heartbeat, identity, now, true);
  }
  for (const { question, reply } of view.threads) {
    if (question.message.kind !== "question") throw new Error("Invalid listing question.");
    await verifyListingMessage(question, identity, now);
    if (reply) {
      if (reply.message.kind !== "reply" || reply.message.buyer !== question.message.buyer ||
          reply.message.questionSignature !== question.signature || reply.message.issued < question.message.issued)
        throw new Error("The reply does not belong to this question.");
      await verifyListingMessage(reply, identity, now, true);
    }
  }
  return { identity, heartbeat: view.heartbeat, threads: view.threads };
}

export async function selectedListingTerms(agreement: ListingAgreement, listing: ListingIdentity, buyer: string, now: number) {
  const { question, reply, selected } = agreement;
  if (question.message.kind !== "question" || reply.message.kind !== "reply" ||
      question.message.buyer !== buyer || reply.message.buyer !== buyer ||
      reply.message.questionSignature !== question.signature || reply.message.issued < question.message.issued ||
      !Array.isArray(selected) || selected.length < 1 || selected.length > 8 ||
      selected.some((i, n) => !Number.isInteger(i) || i < 0 || i >= reply.message.terms.length || (n > 0 && i <= selected[n - 1]!)))
    throw new Error();
  await Promise.all([verifyListingMessage(question, listing, now), verifyListingMessage(reply, listing, now)]);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([question.signature, reply.signature, selected])));
  return { ...listing, buyer, terms: selected.map(i => reply.message.terms[i]!),
    agreementHash: [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("") };
}

/** These exact words are preserved by both the hosted and practice brief formats. */
export function publicListingBrief(request: string, agreed: Awaited<ReturnType<typeof selectedListingTerms>>, payingCreator?: string) {
  return [request, "Agreed terms", ...agreed.terms, "Listing " + agreed.listing + " version " + agreed.version,
    "Provider " + agreed.provider, "Buyer " + agreed.buyer,
    // The requester agreed the terms; the paying creator funds and reviews the task. Both are named.
    ...(payingCreator === undefined ? [] : ["Paying creator " + payingCreator]),
    "Agreement " + agreed.agreementHash].join("\n");
}
