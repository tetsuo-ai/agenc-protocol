/**
 * Structural tests for the legacy `@solana/wallet-adapter` compatibility shim
 * (`signerFromWalletAdapter`).
 *
 * A fake `VersionedTransaction` class (wrapping the shared wire bytes) and a
 * fake wallet-adapter state (signing with a known keypair) stand in for
 * web3.js + wallet-adapter — no real dependency on either. Asserts the shim
 * produces a valid kit `TransactionSigner`, delegates through the v1 round-trip,
 * recovers the correct signature, and errors when disconnected / unsignable.
 */
import {
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionDecoder,
  getTransactionEncoder,
  isTransactionSigner,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type KeyPairSigner,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { signerFromWalletAdapter } from "../../src/signers/index.js";
import type {
  VersionedTransactionCtor,
  VersionedTransactionLike,
  WalletAdapterLike,
} from "../../src/signers/index.js";

const FAKE_BLOCKHASH = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 100n,
} as const;

async function buildTransaction(signer: KeyPairSigner): Promise<Transaction> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(FAKE_BLOCKHASH, m),
    (m) => appendTransactionMessageInstructions([], m),
  );
  return compileTransaction(message);
}

/**
 * A fake web3.js `VersionedTransaction`: just carries wire bytes. `serialize()`
 * returns them; `deserialize()` wraps them. The adapter's `signTransaction`
 * does the real keypair signing via the kit codecs (the wire format is shared).
 */
class FakeVersionedTransaction implements VersionedTransactionLike {
  constructor(public bytes: Uint8Array) {}
  serialize(): Uint8Array {
    return this.bytes;
  }
  static deserialize(bytes: Uint8Array): FakeVersionedTransaction {
    return new FakeVersionedTransaction(bytes);
  }
}

const VersionedTransaction: VersionedTransactionCtor = FakeVersionedTransaction;

/** A fake wallet-adapter state backed by `keyPairSigner`. */
function fakeAdapter(keyPairSigner: KeyPairSigner): WalletAdapterLike {
  const encoder = getTransactionEncoder();
  const decoder = getTransactionDecoder();
  return {
    publicKey: { toBase58: () => keyPairSigner.address },
    async signTransaction<T extends VersionedTransactionLike>(
      transaction: T,
    ): Promise<T> {
      const tx = decoder.decode(new Uint8Array(transaction.serialize()));
      const signed = await partiallySignTransaction(
        [keyPairSigner.keyPair],
        tx,
      );
      return new FakeVersionedTransaction(
        new Uint8Array(encoder.encode(signed)),
      ) as unknown as T;
    },
  };
}

describe("signerFromWalletAdapter", () => {
  it("produces a structurally valid kit TransactionSigner", async () => {
    const backing = await generateKeyPairSigner();
    const signer = signerFromWalletAdapter(fakeAdapter(backing), {
      VersionedTransaction,
    });
    expect(signer.address).toBe(backing.address);
    expect(isTransactionSigner(signer)).toBe(true);
  });

  it("delegates through the v1 round-trip and recovers the signature", async () => {
    const backing = await generateKeyPairSigner();
    const tx = await buildTransaction(backing);
    const reference = await partiallySignTransaction([backing.keyPair], tx);
    const expected = reference.signatures[backing.address];

    const signer = signerFromWalletAdapter(fakeAdapter(backing), {
      VersionedTransaction,
    }) as TransactionPartialSigner;
    const [dictionary] = await signer.signTransactions([tx as never]);
    expect(Array.from(dictionary![backing.address]!)).toEqual(
      Array.from(expected!),
    );
  });

  it("throws when the adapter is disconnected (publicKey null)", () => {
    expect(() =>
      signerFromWalletAdapter(
        { publicKey: null, signTransaction: async (t) => t },
        { VersionedTransaction },
      ),
    ).toThrowError(/not connected/i);
  });

  it("throws when the adapter cannot sign transactions", async () => {
    const backing = await generateKeyPairSigner();
    expect(() =>
      signerFromWalletAdapter(
        { publicKey: { toBase58: () => backing.address } },
        { VersionedTransaction },
      ),
    ).toThrowError(/signTransaction/);
  });
});
