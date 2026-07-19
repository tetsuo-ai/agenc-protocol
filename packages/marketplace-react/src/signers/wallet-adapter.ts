/**
 * LEGACY `@solana/wallet-adapter` compatibility shim (PLAN.md P4.1).
 *
 * The supported, robust path for browser wallets is the Wallet Standard bridge
 * ({@link signerFromWalletAccount} via `@solana/react`): every modern wallet —
 * including all wallet-adapter wallets — registers as a Wallet Standard wallet,
 * so a wallet-adapter app can migrate by reading the selected account through
 * `@solana/react` and dropping it into `signerFromWalletAccount`. PREFER THAT.
 *
 * This shim exists for apps still holding a raw wallet-adapter
 * `WalletContextState` (web3.js v1 `signTransaction`). It bridges WITHOUT a hard
 * dependency on `@solana/wallet-adapter-*` OR `@solana/web3.js` (1.x): the
 * caller injects the web3.js `VersionedTransaction` class (the only piece we
 * cannot reconstruct), and we round-trip through the shared wire format — a kit
 * {@link Transaction} and a web3.js `VersionedTransaction` serialize to the SAME
 * bytes, so no semantic re-encoding is needed.
 *
 * SSR-safe: no browser globals at module scope.
 *
 * @module signers/wallet-adapter
 */
import {
  address,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  verifySignature,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import { ts } from "./strings.js";
import type { TransactionSigner } from "./types.js";

/**
 * The web3.js v1 `VersionedTransaction` surface this shim needs: a static
 * `deserialize(bytes)` and an instance `serialize()`. Pass the real class from
 * `@solana/web3.js` — typed structurally so this module never imports it.
 */
export interface VersionedTransactionLike {
  serialize(): Uint8Array;
}

/** The static side of the injected `VersionedTransaction` class. */
export interface VersionedTransactionCtor {
  deserialize(bytes: Uint8Array): VersionedTransactionLike;
}

/**
 * The minimal slice of a wallet-adapter `WalletContextState` this shim consumes.
 * Both `publicKey` (anything with a base58 `toString()`/`toBase58()`) and the
 * v1 `signTransaction` are required; a connected adapter exposes both.
 */
export interface WalletAdapterLike {
  /** The connected account's public key (base58 via `toBase58()`/`toString()`). */
  readonly publicKey:
    | { toBase58(): string }
    | { toString(): string }
    | string
    | null;
  /** web3.js v1 sign — returns the same transaction type, signed. */
  signTransaction?: <T extends VersionedTransactionLike>(
    transaction: T,
  ) => Promise<T>;
}

/** Options for {@link signerFromWalletAdapter}. */
export interface SignerFromWalletAdapterOptions {
  /**
   * The web3.js `VersionedTransaction` class (`import { VersionedTransaction }
   * from "@solana/web3.js"`). Required — it is the one piece this no-dep shim
   * cannot supply itself.
   */
  VersionedTransaction: VersionedTransactionCtor;
}

function resolveAdapterAddress(adapter: WalletAdapterLike): string {
  const { publicKey } = adapter;
  if (publicKey == null) {
    throw new Error(ts("signer.walletAdapterDisconnected"));
  }
  if (typeof publicKey === "string") return publicKey;
  if ("toBase58" in publicKey && typeof publicKey.toBase58 === "function") {
    return publicKey.toBase58();
  }
  return String(publicKey);
}

function bytesEqual(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Bridge a LEGACY `@solana/wallet-adapter` `WalletContextState` into a kit
 * {@link TransactionSigner}.
 *
 * Use only when you cannot reach the wallet through `@solana/react`. The result
 * is a {@link TransactionPartialSigner} (the SDK client owns submission), built
 * by serializing the kit transaction to wire bytes, rehydrating it as a web3.js
 * `VersionedTransaction`, handing THAT to the adapter's `signTransaction`, then
 * decoding the signed wire bytes back to a kit transaction to extract this
 * account's signature.
 *
 * @param adapter - A connected wallet-adapter state (`publicKey` + `signTransaction`).
 * @param options - Must inject the web3.js `VersionedTransaction` class.
 * @returns A kit {@link TransactionSigner} usable as `config.signer`.
 * @throws Error if the adapter is disconnected or lacks `signTransaction`.
 *
 * @example
 * ```ts
 * import { VersionedTransaction } from "@solana/web3.js";
 * import { useWallet } from "@solana/wallet-adapter-react";
 *
 * const wallet = useWallet();
 * const signer = signerFromWalletAdapter(wallet, { VersionedTransaction });
 * // -> pass `signer` to <AgencProvider config={{ signer, rpcUrl }}>.
 * ```
 */
export function signerFromWalletAdapter(
  adapter: WalletAdapterLike,
  options: SignerFromWalletAdapterOptions,
): TransactionSigner {
  const signerAddress = address(resolveAdapterAddress(adapter));
  const { signTransaction } = adapter;
  if (typeof signTransaction !== "function") {
    throw new Error(ts("signer.walletAdapterNoSign"));
  }
  const { VersionedTransaction } = options;
  const encoder = getTransactionEncoder();
  const decoder = getTransactionDecoder();
  let publicKeyPromise: ReturnType<typeof getPublicKeyFromAddress> | undefined;

  async function signOne(transaction: Transaction): Promise<SignatureBytes> {
    const wireBytes = new Uint8Array(encoder.encode(transaction));
    const legacyTx = VersionedTransaction.deserialize(wireBytes);
    const signed = await signTransaction!(legacyTx);
    const signedTx = decoder.decode(new Uint8Array(signed.serialize()));
    if (!bytesEqual(transaction.messageBytes, signedTx.messageBytes)) {
      throw new Error(
        ts("signer.walletModifiedTransaction", { address: signerAddress }),
      );
    }
    const signature = signedTx.signatures[signerAddress];
    if (!signature) {
      throw new Error(
        ts("signer.walletNoSignature", { address: signerAddress }),
      );
    }
    publicKeyPromise ??= getPublicKeyFromAddress(signerAddress);
    const valid = await verifySignature(
      await publicKeyPromise,
      signature,
      transaction.messageBytes,
    );
    if (!valid) {
      throw new Error(
        ts("signer.walletInvalidSignature", { address: signerAddress }),
      );
    }
    return signature as SignatureBytes;
  }

  return {
    address: signerAddress,
    async signTransactions(transactions) {
      const signatures = [];
      // Legacy wallet-adapter is unary and many implementations are
      // single-flight. Serialize prompts in input order.
      for (const transaction of transactions) {
        signatures.push({
          [signerAddress]: await signOne(transaction),
        });
      }
      return signatures;
    },
  } satisfies TransactionSigner;
}
