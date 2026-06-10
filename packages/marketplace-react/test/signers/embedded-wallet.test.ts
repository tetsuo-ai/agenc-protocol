/**
 * Structural tests for the embedded / walletless bridge
 * (`signerFromEmbeddedWallet`) and the local-keypair MOCK provider
 * (`createMockEmbeddedWallet`).
 *
 * Asserts the vendor-neutral seam: the mock provider's connect/disconnect
 * lifecycle, idempotent connect, and that `signerFromEmbeddedWallet` lifts a
 * connection into a valid kit `TransactionSigner` whose signatures match the
 * backing keypair (proving real delegation, not a stub).
 *
 * No RPC / litesvm here — the on-chain walletless Done-when lives in
 * `embedded-wallet.e2e.test.ts`.
 */
import {
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
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
import { signerFromEmbeddedWallet } from "../../src/signers/index.js";
// The test-only MOCK lives behind the ./testing subpath, not the signers barrel.
import { createMockEmbeddedWallet } from "../../src/testing/index.js";

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

describe("createMockEmbeddedWallet", () => {
  it("starts disconnected and provisions a wallet on connect", async () => {
    const provider = createMockEmbeddedWallet();
    expect(provider.isConnected()).toBe(false);
    expect(provider.getConnection()).toBeNull();

    const connection = await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(connection.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(connection.keyPairSigner.address).toBe(connection.address);
  });

  it("connect is idempotent (same wallet, not a new one)", async () => {
    const provider = createMockEmbeddedWallet();
    const a = await provider.connect();
    const b = await provider.connect();
    expect(b.address).toBe(a.address);
    expect(b).toBe(a);
  });

  it("disconnect clears the connection", async () => {
    const provider = createMockEmbeddedWallet();
    await provider.connect();
    await provider.disconnect?.();
    expect(provider.isConnected()).toBe(false);
    expect(provider.getConnection()).toBeNull();
  });

  it("generates a distinct wallet per provider by default", async () => {
    const a = await createMockEmbeddedWallet().connect();
    const b = await createMockEmbeddedWallet().connect();
    expect(b.address).not.toBe(a.address);
  });

  it("adopts a supplied 64-byte secret key (stable address across instances)", async () => {
    // Build a real 64-byte secret key (32-byte private || 32-byte public) from a
    // generated extractable keypair, then prove two mock wallets seeded with it
    // resolve to the SAME address — the vendor-restore path.
    const { generateKeyPairSigner } = await import("@solana/kit");
    const source = await generateKeyPairSigner(true);
    const priv = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", source.keyPair.privateKey),
    ).slice(-32);
    const pub = new Uint8Array(
      await crypto.subtle.exportKey("raw", source.keyPair.publicKey),
    );
    const secretKeyBytes = new Uint8Array(64);
    secretKeyBytes.set(priv, 0);
    secretKeyBytes.set(pub, 32);

    const a = await createMockEmbeddedWallet({ secretKeyBytes }).connect();
    const b = await createMockEmbeddedWallet({ secretKeyBytes }).connect();
    expect(a.address).toBe(source.address);
    expect(b.address).toBe(a.address);
  });
});

describe("signerFromEmbeddedWallet", () => {
  it("produces a structurally valid kit TransactionSigner", async () => {
    const provider = createMockEmbeddedWallet();
    const connection = await provider.connect();
    const signer = signerFromEmbeddedWallet(connection);
    expect(signer.address).toBe(connection.address);
    expect(isTransactionSigner(signer)).toBe(true);
    expect(typeof (signer as TransactionPartialSigner).signTransactions).toBe(
      "function",
    );
  });

  it("signatures match the backing keypair (real delegation)", async () => {
    const provider = createMockEmbeddedWallet();
    const connection = await provider.connect();
    const tx = await buildTransaction(connection.keyPairSigner);

    // Index the signature maps by the branded Address (keyPairSigner.address),
    // which equals connection.address but carries the Address brand the maps need.
    const addr = connection.keyPairSigner.address;
    const reference = await partiallySignTransaction(
      [connection.keyPairSigner.keyPair],
      tx,
    );
    const expected = reference.signatures[addr];

    const signer = signerFromEmbeddedWallet(connection) as TransactionPartialSigner;
    const [dictionary] = await signer.signTransactions([tx as never]);
    expect(dictionary![addr]).toBeDefined();
    expect(Array.from(dictionary![addr]!)).toEqual(Array.from(expected!));
  });

  it("throws when the connection returns a mismatched signature count", async () => {
    const badConnection = {
      address: (await createMockEmbeddedWallet().connect()).address,
      signTransactions: async () => [],
    };
    const signer = signerFromEmbeddedWallet(badConnection) as TransactionPartialSigner;
    const tx = await buildTransaction(
      (await createMockEmbeddedWallet().connect()).keyPairSigner,
    );
    await expect(
      signer.signTransactions([tx as never]),
    ).rejects.toThrowError(/signatures/i);
  });
});
