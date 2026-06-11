// P7.2 encrypted deliverable handoff — the PUBLIC manifest/preview the buyer
// reviews before accepting, plus the encrypt/decrypt entry points.
//
// Convention: the worker encrypts the full artifact to a per-task symmetric key
// (or wraps that key to the creator's X25519 public key) and publishes a PUBLIC
// manifest { taskPda, ciphertextUri, previewUri?, encAlgo, keyWrap } for review.
// The PUBLIC manifest carries NO raw key in EITHER mode. For symmetric mode the
// raw AES key NEVER enters the manifest: it is delivered OUT-OF-BAND to the
// storefront's GATED key store (host putWrappedKey), and the host serves it
// ONLY when (a) the on-chain task status == Accepted AND (b) the requester is
// the buyer (the on-chain Task creator) proven by wallet — both fail-closed.
// The manifest's symmetric keyWrap is a key-free { mode, gateRef? } descriptor.
//
// Browser-safe: WebCrypto only — no Node built-ins.
import { bytesToHex, hexToBytes } from "../values/hash.js";
import {
  DELIVERY_ENC_ALGO,
  DELIVERY_KEY_AGREEMENT,
  aesGcmDecrypt,
  aesGcmEncrypt,
  generateSymKey,
  unwrapKeyWithPrivateKey,
  wrapKeyToPubkey,
} from "./crypto.js";

/** The two key-wrap modes the manifest can carry. */
export type DeliveryKeyWrap =
  | {
      /**
       * SYMMETRIC mode is FAIR-EXCHANGE GATED: the raw AES key is delivered
       * OUT-OF-BAND to the storefront's gated key store (host `putWrappedKey`)
       * and the host serves it ONLY when the on-chain task status == Accepted
       * AND the requester is the buyer. The PUBLIC manifest therefore carries
       * NO key material at all — only `mode: "symmetric"` plus an OPAQUE,
       * key-free `gateRef` pointing at that gated store. A raw key MUST NEVER
       * appear on this descriptor (see {@link encryptDeliverable}); doing so
       * would defeat the Accepted gate by handing the buyer the key the host is
       * withholding.
       */
      mode: "symmetric";
      /**
       * OPAQUE, key-free reference to the host's gated key store (e.g. a
       * `keyId` or `agenc://wrapped-key/<taskPda>` URI). Carries NO bytes of the
       * AES key. Optional: when omitted the host resolves the gated key by the
       * manifest's `taskPda` alone.
       */
      gateRef?: string;
    }
  | {
      /**
       * The AES key is wrapped to the creator's X25519 public key via
       * ephemeral-static ECDH; anyone may hold the manifest but only the
       * recipient private key unwraps it.
       */
      mode: "x25519";
      /** Key-agreement algorithm (always {@link DELIVERY_KEY_AGREEMENT}). */
      agreement: typeof DELIVERY_KEY_AGREEMENT;
      /** Lowercase-hex of the AES-GCM-wrapped symmetric key. */
      wrappedKey: string;
      /** Lowercase-hex of the ephemeral X25519 public key used for the wrap. */
      ephemeralPublicKey: string;
      /** Lowercase-hex of the recipient X25519 public key the wrap targets. */
      recipientPublicKey: string;
    };

/** The PUBLIC delivery manifest the buyer reviews (P7.2). */
export interface DeliveryManifest {
  /** Manifest version. */
  v: 1;
  /** The Task PDA this deliverable is for (base58). */
  taskPda: string;
  /** URI of the ciphertext blob (`iv || ciphertext`), e.g. an `agenc://` pointer. */
  ciphertextUri: string;
  /** Optional URI of a public, watermarked/lo-fi preview the buyer can review pre-accept. */
  previewUri?: string;
  /** Symmetric algorithm (always {@link DELIVERY_ENC_ALGO}). */
  encAlgo: typeof DELIVERY_ENC_ALGO;
  /** Lowercase-hex sha256 of the plaintext (lets the buyer verify after decrypt). */
  plaintextHash: string;
  /** How the AES key is wrapped/gated. */
  keyWrap: DeliveryKeyWrap;
}

/** Result of {@link encryptDeliverable}. */
export interface EncryptDeliverableResult {
  /** The encrypted blob (`iv || ciphertext`) to upload to `ciphertextUri`. */
  ciphertext: Uint8Array;
  /**
   * The raw AES key. For the `symmetric` recipient mode this is the GATED key:
   * the caller delivers it OUT-OF-BAND to the host's gated key store (the
   * storefront `putWrappedKey` endpoint), NEVER into the published manifest —
   * the host releases it only when the task is Accepted and the requester is
   * the buyer. For the `x25519` mode it is already wrapped into the manifest
   * and this is returned only for the caller's records.
   */
  symKey: Uint8Array;
  /**
   * The PUBLIC manifest to publish. Carries NO raw key material in EITHER mode:
   * the `x25519` wrap is recipient-encrypted, and the `symmetric` descriptor is
   * key-free (only `mode` + an opaque `gateRef`). Safe to publish verbatim.
   */
  manifest: DeliveryManifest;
}

/** Recipient for {@link encryptDeliverable}: a raw symmetric key OR an X25519 pubkey wrap. */
export type DeliveryRecipient =
  | {
      /** Encrypt under a caller-supplied 32-byte AES key (gated by the host). */
      symKey: Uint8Array;
    }
  | {
      /** Wrap a fresh AES key to this recipient X25519 public key (32 bytes). */
      recipientPublicKey: Uint8Array;
    };

const utf8 = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice());
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Build a PUBLIC delivery manifest from already-computed parts (the bytes the
 * buyer reviews). Used by {@link encryptDeliverable}; exposed so a host can
 * reconstruct a manifest. The symmetric `keyWrap` is a key-free
 * `{ mode, gateRef? }` descriptor — this builder never adds, and callers must
 * never add, raw key bytes to a published manifest (the raw key is gated
 * out-of-band; see {@link encryptDeliverable}).
 */
export function buildDeliveryManifest(input: {
  taskPda: string;
  ciphertextUri: string;
  previewUri?: string;
  plaintextHash: string;
  keyWrap: DeliveryKeyWrap;
}): DeliveryManifest {
  return {
    v: 1,
    taskPda: input.taskPda,
    ciphertextUri: input.ciphertextUri,
    ...(input.previewUri !== undefined ? { previewUri: input.previewUri } : {}),
    encAlgo: DELIVERY_ENC_ALGO,
    plaintextHash: input.plaintextHash,
    keyWrap: input.keyWrap,
  };
}

/**
 * Encrypt a deliverable for fair exchange (P7.2). AES-256-GCM-encrypts
 * `plaintext` under a per-task symmetric key, then either (a) returns the key
 * for the host to gate (`symKey` recipient), or (b) wraps it to the creator's
 * X25519 public key (`recipientPublicKey` recipient) and embeds the wrap in the
 * manifest. Returns the ciphertext blob, the symmetric key, and the PUBLIC
 * manifest to publish.
 *
 * FAIR-EXCHANGE CONTRACT (symmetric mode): the returned `manifest` carries NO
 * key material — its `keyWrap` is a key-free `{ mode: "symmetric", gateRef? }`
 * descriptor. The raw `symKey` is returned SEPARATELY for the worker to upload
 * OUT-OF-BAND to the storefront's gated key store (host `putWrappedKey`); the
 * host serves it ONLY when the on-chain task status == Accepted AND the
 * requester is the buyer. Publishing the raw key in the manifest would defeat
 * the gate, so it is deliberately never placed there.
 *
 * @param plaintext - The full artifact bytes (or a UTF-8 string).
 * @param recipient - `{ symKey }` or `{ recipientPublicKey }`.
 * @param meta - Task PDA + URIs to stamp into the manifest. `ciphertextUri` /
 *   `previewUri` may be filled in after upload; pass placeholders and rebuild
 *   via {@link buildDeliveryManifest} if you prefer. `gateRef` (symmetric mode
 *   only) is an OPAQUE, key-free pointer at the host's gated key store stamped
 *   into the manifest descriptor — never a key.
 */
export async function encryptDeliverable(
  plaintext: Uint8Array | string,
  recipient: DeliveryRecipient,
  meta: { taskPda: string; ciphertextUri: string; previewUri?: string; gateRef?: string },
): Promise<EncryptDeliverableResult> {
  const pt = typeof plaintext === "string" ? utf8.encode(plaintext) : plaintext;
  const plaintextHash = await sha256Hex(pt);

  let symKey: Uint8Array;
  let keyWrap: DeliveryKeyWrap;
  if ("symKey" in recipient) {
    symKey = recipient.symKey;
    // FAIR EXCHANGE: the PUBLIC manifest carries NO raw key. The host gates the
    // raw symKey, which is returned separately for out-of-band upload to the
    // host's gated key store (putWrappedKey) and released only post-Accept.
    keyWrap = {
      mode: "symmetric",
      ...(meta.gateRef !== undefined ? { gateRef: meta.gateRef } : {}),
    };
  } else {
    symKey = generateSymKey();
    const { wrappedKey, ephemeralPublicKey } = await wrapKeyToPubkey(
      symKey,
      recipient.recipientPublicKey,
    );
    keyWrap = {
      mode: "x25519",
      agreement: DELIVERY_KEY_AGREEMENT,
      wrappedKey,
      ephemeralPublicKey,
      recipientPublicKey: bytesToHex(recipient.recipientPublicKey),
    };
  }

  const ciphertext = await aesGcmEncrypt(pt, symKey);
  const manifest = buildDeliveryManifest({
    taskPda: meta.taskPda,
    ciphertextUri: meta.ciphertextUri,
    ...(meta.previewUri !== undefined ? { previewUri: meta.previewUri } : {}),
    plaintextHash,
    keyWrap,
  });
  return { ciphertext, symKey, manifest };
}

/** Key material for {@link decryptDeliverable}. */
export type DeliveryDecryptKey =
  | {
      /** The raw 32-byte AES key (host-gated `symmetric` mode, or known out-of-band). */
      symKey: Uint8Array;
    }
  | {
      /** Unwrap the manifest's `x25519` wrap with this recipient key material. */
      recipientPrivateKey: Uint8Array;
      recipientPublicKey: Uint8Array;
    };

/**
 * Decrypt a deliverable (P7.2). Either decrypts directly with a raw `symKey`,
 * or unwraps the manifest's `x25519` key with the recipient's private key and
 * decrypts. Verifies nothing about the task status — that gate lives on the
 * host that serves the ciphertext/key — but a wrong key throws (GCM tag
 * mismatch), so a leaked manifest without the gated key cannot decrypt.
 *
 * @param ciphertext - The `iv || ciphertext` blob from `ciphertextUri`.
 * @param key - Raw `symKey`, or recipient key material for the `x25519` wrap.
 * @param manifest - Required for the `x25519` unwrap path (carries the wrap);
 *   optional for the raw-`symKey` path.
 * @returns The recovered plaintext bytes.
 */
export async function decryptDeliverable(
  ciphertext: Uint8Array,
  key: DeliveryDecryptKey,
  manifest?: DeliveryManifest,
): Promise<Uint8Array> {
  if ("symKey" in key) {
    return aesGcmDecrypt(ciphertext, key.symKey);
  }
  if (manifest === undefined || manifest.keyWrap.mode !== "x25519") {
    throw new TypeError(
      "decryptDeliverable: recipient-key path requires a manifest with an x25519 keyWrap",
    );
  }
  const wrap = manifest.keyWrap;
  const symKey = await unwrapKeyWithPrivateKey(
    hexToBytes(wrap.wrappedKey),
    hexToBytes(wrap.ephemeralPublicKey),
    key.recipientPrivateKey,
    key.recipientPublicKey,
  );
  return aesGcmDecrypt(ciphertext, symKey);
}
