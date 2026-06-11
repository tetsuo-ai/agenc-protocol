// P7.2 encrypted deliverable handoff (fair exchange): the worker encrypts the
// full artifact to a per-task symmetric key (or wraps it to the creator's
// X25519 public key) and publishes a PUBLIC manifest for review; the buyer
// previews, ACCEPTS on-chain, then the host releases the gated key / object.
//
// The on-chain key-commitment layer (L2) is DESIGN ONLY
// (docs/ENCRYPTED_DELIVERY_L2.md) — not built here.
//
// Browser-safe: WebCrypto only (AES-256-GCM + X25519 ECDH + HKDF) — no Node
// built-ins.
//
// @module delivery
export {
  DELIVERY_ENC_ALGO,
  DELIVERY_KEY_AGREEMENT,
  AES_GCM_IV_BYTES,
  AES_KEY_BYTES,
  X25519_PUBKEY_BYTES,
  generateSymKey,
  generateRecipientKeyPair,
  aesGcmEncrypt,
  aesGcmDecrypt,
  wrapKeyToPubkey,
  unwrapKeyWithPrivateKey,
} from "./crypto.js";
export {
  encryptDeliverable,
  decryptDeliverable,
  buildDeliveryManifest,
  type DeliveryManifest,
  type DeliveryKeyWrap,
  type DeliveryRecipient,
  type DeliveryDecryptKey,
  type EncryptDeliverableResult,
} from "./manifest.js";
