/**
 * Structural tests for the Wallet Standard → kit signer bridge
 * (`signerFromWalletAccount`).
 *
 * These build a real kit {@link Transaction}, drive it through a FAKE Wallet
 * Standard `solana:signTransaction` feature (backed by a known keypair), and
 * assert:
 *  - the bridge produces a structurally valid kit `TransactionSigner`
 *    (address + signTransactions), accepted by `isTransactionSigner`;
 *  - signing DELEGATES to the wallet feature and recovers THIS account's
 *    signature, byte-identical to signing the same transaction with the
 *    backing keypair directly (proves the round-trip encode → wallet → decode
 *    is correct, not faked);
 *  - the chain is forwarded and the no-feature / no-signature errors fire.
 *
 * No RPC, no litesvm, no browser — a fake feature function is the only
 * dependency, exactly the "fake Wallet Standard account" the Done-when names.
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
import { describe, expect, it, vi } from "vitest";
import { signerFromWalletAccount } from "../../src/signers/index.js";
import type { WalletStandardSignTransaction } from "../../src/signers/index.js";

/** A deterministic, valid blockhash lifetime (the bytes are not validated on-chain here). */
const FAKE_BLOCKHASH = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 100n,
} as const;

/** Build a real, compiled kit Transaction whose fee payer is `signer`. */
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
 * A fake Wallet Standard `solana:signTransaction` feature backed by `keyPair`:
 * decodes the wire transaction, signs it with the real keypair, re-encodes, and
 * returns it — exactly what a real wallet does.
 */
function fakeSignTransaction(
  keyPair: CryptoKeyPair,
  spy?: (chain: string | undefined) => void,
): WalletStandardSignTransaction {
  const encoder = getTransactionEncoder();
  const decoder = getTransactionDecoder();
  return async (...inputs) => {
    return Promise.all(
      inputs.map(async (input) => {
        spy?.(input.chain);
        const tx = decoder.decode(input.transaction);
        const signed = await partiallySignTransaction([keyPair], tx);
        return { signedTransaction: new Uint8Array(encoder.encode(signed)) };
      }),
    );
  };
}

describe("signerFromWalletAccount", () => {
  it("produces a structurally valid kit TransactionSigner", async () => {
    const backing = await generateKeyPairSigner();
    const signer = signerFromWalletAccount(
      { address: backing.address, chains: ["solana:devnet"] },
      { signTransaction: fakeSignTransaction(backing.keyPair) },
    );
    expect(signer.address).toBe(backing.address);
    expect(isTransactionSigner(signer)).toBe(true);
    expect(typeof (signer as TransactionPartialSigner).signTransactions).toBe(
      "function",
    );
  });

  it("delegates signing to the wallet and recovers the correct signature", async () => {
    const backing = await generateKeyPairSigner();
    const tx = await buildTransaction(backing);

    // Reference: sign the same tx directly with the backing keypair.
    const reference = await partiallySignTransaction([backing.keyPair], tx);
    const expectedSignature = reference.signatures[backing.address];
    expect(expectedSignature).toBeDefined();

    const signer = signerFromWalletAccount(
      { address: backing.address },
      { signTransaction: fakeSignTransaction(backing.keyPair) },
    ) as TransactionPartialSigner;

    const [dictionary] = await signer.signTransactions([tx as never]);
    expect(dictionary![backing.address]).toBeDefined();
    // Byte-identical to signing directly -> the bridge genuinely delegated.
    expect(Array.from(dictionary![backing.address]!)).toEqual(
      Array.from(expectedSignature!),
    );
  });

  it("forwards the resolved chain to the wallet feature", async () => {
    const backing = await generateKeyPairSigner();
    const tx = await buildTransaction(backing);
    const chainSpy = vi.fn();
    const signer = signerFromWalletAccount(
      { address: backing.address },
      {
        chain: "solana:mainnet",
        signTransaction: fakeSignTransaction(backing.keyPair, chainSpy),
      },
    ) as TransactionPartialSigner;
    await signer.signTransactions([tx as never]);
    expect(chainSpy).toHaveBeenCalledWith("solana:mainnet");
  });

  it("defaults the chain to the account's first solana:* chain", async () => {
    const backing = await generateKeyPairSigner();
    const tx = await buildTransaction(backing);
    const chainSpy = vi.fn();
    const signer = signerFromWalletAccount(
      { address: backing.address, chains: ["solana:testnet", "solana:devnet"] },
      { signTransaction: fakeSignTransaction(backing.keyPair, chainSpy) },
    ) as TransactionPartialSigner;
    await signer.signTransactions([tx as never]);
    expect(chainSpy).toHaveBeenCalledWith("solana:testnet");
  });

  it("resolves the feature off account.features when no override is passed", async () => {
    const backing = await generateKeyPairSigner();
    const tx = await buildTransaction(backing);
    const signer = signerFromWalletAccount({
      address: backing.address,
      features: {
        "solana:signTransaction": {
          signTransaction: fakeSignTransaction(backing.keyPair),
        },
      },
    }) as TransactionPartialSigner;
    const [dictionary] = await signer.signTransactions([tx as never]);
    expect(dictionary![backing.address]).toBeDefined();
  });

  it("throws when no solana:signTransaction feature can be resolved", async () => {
    const backing = await generateKeyPairSigner();
    expect(() =>
      signerFromWalletAccount({ address: backing.address }),
    ).toThrowError(/solana:signTransaction/);
  });

  it("throws when the wallet returns no signature for this account", async () => {
    const backing = await generateKeyPairSigner();
    const tx = await buildTransaction(backing);
    // The wallet returns the transaction UNSIGNED (fee-payer signature is null) —
    // e.g. a wallet that silently declined. The bridge must reject, not emit a
    // bogus signature.
    const encoder = getTransactionEncoder();
    const declineToSign: WalletStandardSignTransaction = async (...inputs) =>
      inputs.map((input) => ({
        signedTransaction: new Uint8Array(
          encoder.encode(getTransactionDecoder().decode(input.transaction)),
        ),
      }));
    const signer = signerFromWalletAccount(
      { address: backing.address },
      { signTransaction: declineToSign },
    ) as TransactionPartialSigner;
    await expect(
      signer.signTransactions([tx as never]),
    ).rejects.toThrowError(/no signature/i);
  });
});
