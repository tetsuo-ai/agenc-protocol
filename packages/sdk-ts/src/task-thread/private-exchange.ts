// The relay sees routing and ciphertext. Wallet signatures authenticate both the
// job-specific recipient key and each message, independently of relay trust.
import { address, getAddressEncoder, type KeyPairSigner } from "@solana/kit";
import { bytesToHex, sha256 } from "../values/hash.js";

export interface ExchangeParties {
  task: string;
  claim: string;
  claimedAt: string;
  worker: string;
  buyer: string;
  authority: string;
  room: string;
}

export type ExchangePurpose = "key" | "inputs" | "output" | "receipt" | "message" | "read";
export interface ExchangeHeader extends ExchangeParties {
  sender: string;
  purpose: ExchangePurpose;
  id: string;
}

export interface SignedPacket {
  header: ExchangeHeader;
  payload: string;
  signature: string;
}

const utf8 = new TextEncoder();
const encode64 = (bytes: Uint8Array) => {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(value);
};

export function decodeExchangeBase64(value: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(maxBytes / 3)) throw new Error("Invalid exchange size.");
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (bytes.length > maxBytes || encode64(bytes) !== value) throw new Error("Invalid exchange encoding.");
  return bytes;
}

export function exchangeContext(h: ExchangeParties): string {
  for (const key of [h.task, h.claim, h.worker, h.buyer, h.authority]) address(key);
  if (h.buyer === h.authority || !/^[0-9]{1,16}$/.test(h.claimedAt) || !/^[a-f0-9]{64}$/.test(h.room)) {
    throw new Error("Invalid exchange parties.");
  }
  return JSON.stringify(["agenc.job-exchange.v1", h.task, h.claim, h.claimedAt, h.worker, h.buyer, h.authority, h.room]);
}

export function exchangeHeader(h: ExchangeHeader): string {
  if (![h.buyer, h.authority].includes(h.sender) || !/^[a-f0-9]{32}$/.test(h.id) ||
      !["key", "inputs", "output", "receipt", "message", "read"].includes(h.purpose)) throw new Error("Invalid exchange header.");
  return JSON.stringify([exchangeContext(h), h.sender, h.purpose, h.id]);
}

async function signingBytes(h: ExchangeHeader, payload: string) {
  if (typeof payload !== "string" || payload.length > 6_000_000) throw new Error("Invalid exchange payload.");
  return utf8.encode(JSON.stringify([exchangeHeader(h), bytesToHex(await sha256(payload))]));
}

export async function signPacket(h: ExchangeHeader, payload: string, signer: KeyPairSigner): Promise<SignedPacket> {
  if (h.sender !== signer.address) throw new Error("Wrong exchange signer.");
  const signature = await crypto.subtle.sign("Ed25519", signer.keyPair.privateKey, await signingBytes(h, payload));
  return { header: h, payload, signature: encode64(new Uint8Array(signature)) };
}

export async function verifyPacket(packet: SignedPacket, parties: ExchangeParties, sender: string, purpose: ExchangePurpose) {
  const h = packet.header;
  if (exchangeContext(parties) !== exchangeContext(h) || h.sender !== sender || h.purpose !== purpose) throw new Error("Wrong job or exchange party.");
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(getAddressEncoder().encode(address(sender))), "Ed25519", false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", key, decodeExchangeBase64(packet.signature, 64), await signingBytes(h, packet.payload))) {
    throw new Error("Invalid exchange signature.");
  }
}

export function newExchangeId() { return bytesToHex(crypto.getRandomValues(new Uint8Array(16))); }

export async function createExchangeKey() {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    privateKey: await crypto.subtle.exportKey("jwk", keys.privateKey),
    publicKey: encode64(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))),
  };
}

async function wrappingKey(privateJwk: JsonWebKey, peerPublic: string, header: ExchangeHeader) {
  const alg = { name: "ECDH", namedCurve: "P-256" };
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, alg, false, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", decodeExchangeBase64(peerPublic, 65), alg, false, []);
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8.encode(exchangeContext(header)), info: utf8.encode(exchangeHeader(header)) },
    hkdf, { name: "AES-KW", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}

export async function sealPacket(header: ExchangeHeader, bytes: Uint8Array, recipient: SignedPacket, signer: KeyPairSigner) {
  const peer = signer.address === header.buyer ? header.authority : header.buyer;
  await verifyPacket(recipient, header, peer, "key");
  const ephemeral = await createExchangeKey();
  const wrapping = await wrappingKey(ephemeral.privateKey, recipient.payload, header);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: utf8.encode(exchangeHeader(header)) }, key, bytes.slice());
  const wrapped = await crypto.subtle.wrapKey("raw", key, wrapping, "AES-KW");
  return signPacket(header, JSON.stringify([ephemeral.publicKey, encode64(new Uint8Array(wrapped)), encode64(nonce), encode64(new Uint8Array(ciphertext))]), signer);
}

export async function openPacket(packet: SignedPacket, parties: ExchangeParties, sender: string, purpose: ExchangePurpose, recipientKey: JsonWebKey) {
  await verifyPacket(packet, parties, sender, purpose);
  const parts: unknown = JSON.parse(packet.payload);
  if (!Array.isArray(parts) || parts.length !== 4 || !parts.every(item => typeof item === "string")) throw new Error("Invalid encrypted packet.");
  const wrapping = await wrappingKey(recipientKey, parts[0], packet.header);
  const key = await crypto.subtle.unwrapKey("raw", decodeExchangeBase64(parts[1], 40), wrapping, "AES-KW", "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeExchangeBase64(parts[2], 12), additionalData: utf8.encode(exchangeHeader(packet.header)) },
    key, decodeExchangeBase64(parts[3], 4_499_000)));
}
