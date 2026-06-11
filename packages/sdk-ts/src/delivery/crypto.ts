// P7.2 encrypted deliverable handoff — the WebCrypto primitives.
//
// Fair exchange: the worker encrypts the full artifact to a per-task symmetric
// key (or to the creator's X25519 public key); the buyer previews a PUBLIC
// manifest, ACCEPTS on-chain, and only then can the storefront serve the
// wrapped key / full object (the host adds a `task status == Accepted`
// read-gate). The on-chain key-commitment layer (L2) is DESIGN ONLY
// (docs/ENCRYPTED_DELIVERY_L2.md) and is NOT built here.
//
// Browser-safe: WebCrypto only (`globalThis.crypto.subtle`) — no `node:crypto`,
// no `Buffer`. AES-256-GCM for the data; X25519 ECDH + HKDF-SHA256 for the
// pubkey wrap.
import { bytesToHex } from "../values/hash.js";

/** Symmetric algorithm pinned for deliverable encryption. */
export const DELIVERY_ENC_ALGO = "AES-256-GCM" as const;
/** Key-agreement algorithm for the pubkey wrap. */
export const DELIVERY_KEY_AGREEMENT = "X25519" as const;
/** AES-GCM IV length in bytes (96-bit nonce, the GCM default). */
export const AES_GCM_IV_BYTES = 12;
/** Raw AES-256 key length in bytes. */
export const AES_KEY_BYTES = 32;
/** X25519 raw public-key length in bytes. */
export const X25519_PUBKEY_BYTES = 32;

/** HKDF `info` string binding the derived key to this protocol + version. */
const HKDF_INFO = new TextEncoder().encode("agenc:delivery:v1:x25519-aesgcm");

const subtle = () => globalThis.crypto.subtle;

/** Generate a fresh random 32-byte AES-256 symmetric key. */
export function generateSymKey(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(AES_KEY_BYTES));
}

/**
 * Generate an X25519 keypair as raw 32-byte arrays. The recipient (creator)
 * keeps `privateKey` secret and publishes `publicKey` (e.g. in agent metadata)
 * so workers can encrypt to it.
 */
export async function generateRecipientKeyPair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  const kp = (await subtle().generateKey({ name: DELIVERY_KEY_AGREEMENT }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await subtle().exportKey("raw", kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", kp.privateKey));
  return { publicKey, privateKey: pkcs8 };
}

/** Import a raw 32-byte AES key for encrypt/decrypt. */
async function importAesKey(
  raw: Uint8Array,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  if (raw.length !== AES_KEY_BYTES) {
    throw new TypeError(
      `delivery: symmetric key must be ${AES_KEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  return subtle().importKey("raw", raw.slice(), { name: "AES-GCM" }, false, [usage]);
}

/**
 * AES-256-GCM encrypt `plaintext` under `symKey`. Returns `iv || ciphertext`
 * (the 12-byte IV is prepended so a single blob round-trips). The GCM auth tag
 * is appended by WebCrypto inside the ciphertext.
 */
export async function aesGcmEncrypt(
  plaintext: Uint8Array,
  symKey: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesKey(symKey, "encrypt");
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv }, key, plaintext.slice()),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

/**
 * AES-256-GCM decrypt an `iv || ciphertext` blob under `symKey`. Throws on a
 * wrong key / tampered ciphertext (GCM tag mismatch surfaces as a WebCrypto
 * `OperationError`).
 */
export async function aesGcmDecrypt(
  blob: Uint8Array,
  symKey: Uint8Array,
): Promise<Uint8Array> {
  if (blob.length < AES_GCM_IV_BYTES) {
    throw new TypeError("delivery: ciphertext shorter than the IV");
  }
  const key = await importAesKey(symKey, "decrypt");
  const iv = blob.slice(0, AES_GCM_IV_BYTES);
  const ct = blob.slice(AES_GCM_IV_BYTES);
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv }, key, ct));
}

/**
 * Derive a 32-byte AES key from an X25519 shared secret via HKDF-SHA256.
 * `info` binds the derivation to this protocol; `salt` is the concatenation of
 * the ephemeral and recipient public keys so each handoff derives a distinct
 * key even if the static keys repeat.
 */
async function deriveAesKeyFromShared(
  sharedSecret: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const ikm = await subtle().importKey("raw", sharedSecret.slice(), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt.slice(), info: HKDF_INFO },
    ikm,
    AES_KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Wrap `symKey` to a recipient X25519 public key. Generates an ephemeral
 * keypair, performs ECDH with the recipient's public key, HKDFs the shared
 * secret to an AES key, and AES-GCM-encrypts `symKey` under it. The returned
 * `ephemeralPublicKey` (hex) goes in the manifest so the recipient can re-derive
 * the wrapping key with their private key.
 */
export async function wrapKeyToPubkey(
  symKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<{ wrappedKey: string; ephemeralPublicKey: string }> {
  if (recipientPublicKey.length !== X25519_PUBKEY_BYTES) {
    throw new TypeError(
      `delivery: recipient public key must be ${X25519_PUBKEY_BYTES} bytes, got ${recipientPublicKey.length}`,
    );
  }
  const recipientKey = await subtle().importKey(
    "raw",
    recipientPublicKey.slice(),
    { name: DELIVERY_KEY_AGREEMENT },
    false,
    [],
  );
  const ephemeral = (await subtle().generateKey({ name: DELIVERY_KEY_AGREEMENT }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const ephemeralPublicKey = new Uint8Array(
    await subtle().exportKey("raw", ephemeral.publicKey),
  );
  const shared = new Uint8Array(
    await subtle().deriveBits(
      { name: DELIVERY_KEY_AGREEMENT, public: recipientKey },
      ephemeral.privateKey,
      256,
    ),
  );
  const salt = concat(ephemeralPublicKey, recipientPublicKey);
  const aesKey = await deriveAesKeyFromShared(shared, salt);
  const wrapped = await aesGcmEncrypt(symKey, aesKey);
  return {
    wrappedKey: bytesToHex(wrapped),
    ephemeralPublicKey: bytesToHex(ephemeralPublicKey),
  };
}

/**
 * Unwrap a pubkey-wrapped `symKey` with the recipient's X25519 private key
 * (PKCS#8, as returned by {@link generateRecipientKeyPair}). Re-derives the
 * wrapping key from the manifest's ephemeral public key and AES-GCM-decrypts.
 */
export async function unwrapKeyWithPrivateKey(
  wrappedKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  recipientPrivateKeyPkcs8: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<Uint8Array> {
  const priv = await subtle().importKey(
    "pkcs8",
    recipientPrivateKeyPkcs8.slice(),
    { name: DELIVERY_KEY_AGREEMENT },
    false,
    ["deriveBits"],
  );
  const ephPub = await subtle().importKey(
    "raw",
    ephemeralPublicKey.slice(),
    { name: DELIVERY_KEY_AGREEMENT },
    false,
    [],
  );
  const shared = new Uint8Array(
    await subtle().deriveBits({ name: DELIVERY_KEY_AGREEMENT, public: ephPub }, priv, 256),
  );
  const salt = concat(ephemeralPublicKey, recipientPublicKey);
  const aesKey = await deriveAesKeyFromShared(shared, salt);
  return aesGcmDecrypt(wrappedKey, aesKey);
}

/** Concatenate two byte arrays. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
