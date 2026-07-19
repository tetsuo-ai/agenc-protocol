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

async function buildTransaction(
  signer: KeyPairSigner,
  recentBlockhash: {
    readonly blockhash: ReturnType<typeof blockhash>;
    readonly lastValidBlockHeight: bigint;
  } = FAKE_BLOCKHASH,
): Promise<Transaction> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash, m),
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

  it("serializes wallet prompts and preserves result order", async () => {
    const backing = await generateKeyPairSigner();
    const delegate = fakeAdapter(backing).signTransaction!;
    let inFlight = 0;
    let maxInFlight = 0;
    const adapter: WalletAdapterLike = {
      publicKey: backing.address,
      async signTransaction<T extends VersionedTransactionLike>(
        transaction: T,
      ): Promise<T> {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        try {
          return await delegate(transaction);
        } finally {
          inFlight -= 1;
        }
      },
    };
    const transactions = [
      await buildTransaction(backing),
      await buildTransaction(backing, {
        blockhash: blockhash("So11111111111111111111111111111111111111112"),
        lastValidBlockHeight: 101n,
      }),
    ];
    const expected = await Promise.all(
      transactions.map((transaction) =>
        partiallySignTransaction([backing.keyPair], transaction),
      ),
    );
    const signer = signerFromWalletAdapter(adapter, {
      VersionedTransaction,
    }) as TransactionPartialSigner;

    const dictionaries = await signer.signTransactions(
      transactions.map((transaction) => transaction as never),
    );
    expect(maxInFlight).toBe(1);
    expect(Array.from(dictionaries[0]![backing.address]!)).toEqual(
      Array.from(expected[0]!.signatures[backing.address]!),
    );
    expect(Array.from(dictionaries[1]![backing.address]!)).toEqual(
      Array.from(expected[1]!.signatures[backing.address]!),
    );
  });

  it("rejects an adapter-returned transaction whose message differs", async () => {
    const backing = await generateKeyPairSigner();
    const original = await buildTransaction(backing);
    const changed = await buildTransaction(backing, {
      blockhash: blockhash("So11111111111111111111111111111111111111112"),
      lastValidBlockHeight: 101n,
    });
    const signedChanged = await partiallySignTransaction(
      [backing.keyPair],
      changed,
    );
    const encoder = getTransactionEncoder();
    const adapter: WalletAdapterLike = {
      publicKey: backing.address,
      async signTransaction<T extends VersionedTransactionLike>(): Promise<T> {
        return new FakeVersionedTransaction(
          new Uint8Array(encoder.encode(signedChanged)),
        ) as unknown as T;
      },
    };
    const signer = signerFromWalletAdapter(adapter, {
      VersionedTransaction,
    }) as TransactionPartialSigner;
    await expect(
      signer.signTransactions([original as never]),
    ).rejects.toThrowError(/modified.*transaction|message.*differ/i);
  });

  it("rejects a forged signature over an unchanged message", async () => {
    const backing = await generateKeyPairSigner();
    const tx = await buildTransaction(backing);
    const forged = {
      ...tx,
      signatures: {
        ...tx.signatures,
        [backing.address]: new Uint8Array(64).fill(1),
      },
    } as unknown as Transaction;
    const encoder = getTransactionEncoder();
    const adapter: WalletAdapterLike = {
      publicKey: backing.address,
      async signTransaction<T extends VersionedTransactionLike>(): Promise<T> {
        return new FakeVersionedTransaction(
          new Uint8Array(encoder.encode(forged)),
        ) as unknown as T;
      },
    };
    const signer = signerFromWalletAdapter(adapter, {
      VersionedTransaction,
    }) as TransactionPartialSigner;
    await expect(
      signer.signTransactions([tx as never]),
    ).rejects.toThrowError(/invalid signature/i);
  });
});
