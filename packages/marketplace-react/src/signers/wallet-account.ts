/**
 * Wallet Standard → kit `TransactionSigner` bridge (PLAN.md P4.1 / PLAN_2 D-1).
 *
 * Turns a connected browser wallet into the {@link TransactionSigner} the SDK's
 * `createMarketplaceClient` consumes. The SDK client signs via
 * `signTransactionMessageWithSigners(...)` and submits through its OWN transport
 * — so it needs a PARTIAL signer (one that returns signatures without sending),
 * NOT a `TransactionSendingSigner` (which `signTransactionMessageWithSigners`
 * deliberately ignores). This bridge therefore produces a
 * {@link TransactionPartialSigner}: it serializes each transaction, hands it to
 * the wallet's `solana:signTransaction` feature, and diffs the returned signed
 * transaction to recover THIS account's signature.
 *
 * @see {@link signerFromWalletAccount}
 * @module signers/wallet-account
 */
import {
  address,
  getTransactionDecoder,
  getTransactionEncoder,
  type Address,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import { ts } from "./strings.js";
import type {
  SignerFromWalletAccountOptions,
  TransactionSigner,
  WalletStandardAccountLike,
  WalletStandardSignTransaction,
} from "./types.js";

const SOLANA_SIGN_TRANSACTION = "solana:signTransaction";

/** Resolve the wallet's `solana:signTransaction` method from account/options. */
function resolveSignTransaction(
  account: WalletStandardAccountLike,
  options: SignerFromWalletAccountOptions,
): WalletStandardSignTransaction {
  if (options.signTransaction) return options.signTransaction;
  const feature = account.features?.[SOLANA_SIGN_TRANSACTION] as
    | { signTransaction?: WalletStandardSignTransaction }
    | undefined;
  if (feature?.signTransaction) return feature.signTransaction;
  throw new Error(ts("signer.walletNoSignFeature", { address: account.address }));
}

/** Pick the CAIP-2 chain to forward to the wallet. */
function resolveChain(
  account: WalletStandardAccountLike,
  options: SignerFromWalletAccountOptions,
): string | undefined {
  if (options.chain) return options.chain;
  return account.chains?.find((c) => c.startsWith("solana:"));
}

/**
 * Bridge a Wallet Standard account into a kit {@link TransactionSigner}.
 *
 * Accepts either a real `UiWalletAccount` (the `@solana/react` path — pass the
 * account and a `chain`, or pass the hook's feature via
 * {@link SignerFromWalletAccountOptions.signTransaction}) or any object exposing
 * the `solana:signTransaction` feature. The returned signer is a
 * {@link TransactionPartialSigner}, the exact shape the SDK client expects.
 *
 * Wallets may MODIFY a transaction before signing (priority fees, guard
 * instructions). We honor that by decoding the wallet's returned signed
 * transaction and extracting only THIS account's signature; the SDK client then
 * re-assembles and submits. (If a wallet rewrites the message such that the
 * fee-payer's own prior signing is invalidated, that is a wallet contract the
 * SDK's single-fee-payer flow already assumes won't happen for the payer.)
 *
 * SSR-safe: constructs no browser globals; the wallet round-trip only runs when
 * a transaction is actually signed.
 *
 * @param account - The connected Wallet Standard account (needs `address`).
 * @param options - Chain + an optional explicit `signTransaction` override.
 * @returns A kit {@link TransactionSigner} usable as `config.signer`.
 * @throws Error if no `solana:signTransaction` feature can be resolved.
 *
 * @example
 * ```ts
 * // With @solana/react (Wallet Standard):
 * const account = useSelectedWalletAccount();           // UiWalletAccount
 * const signer = signerFromWalletAccount(account, { chain: "solana:devnet" });
 * // -> pass `signer` to <AgencProvider config={{ signer, rpcUrl }}>.
 * ```
 */
export function signerFromWalletAccount(
  account: WalletStandardAccountLike,
  options: SignerFromWalletAccountOptions = {},
): TransactionSigner {
  const signerAddress: Address = address(account.address);
  const signTransaction = resolveSignTransaction(account, options);
  const chain = resolveChain(account, options);
  const encoder = getTransactionEncoder();
  const decoder = getTransactionDecoder();

  async function signOne(transaction: Transaction): Promise<SignatureBytes> {
    const wireBytes = new Uint8Array(encoder.encode(transaction));
    const [output] = await signTransaction({
      transaction: wireBytes,
      ...(chain ? { chain } : {}),
    });
    if (!output) {
      throw new Error(ts("signer.walletNoSignature", { address: account.address }));
    }
    const signed = decoder.decode(output.signedTransaction);
    const signature = signed.signatures[signerAddress];
    if (!signature) {
      throw new Error(ts("signer.walletNoSignature", { address: account.address }));
    }
    return signature as SignatureBytes;
  }

  return {
    address: signerAddress,
    async signTransactions(transactions) {
      // Sign in parallel — partial signers are order-independent (each returns a
      // single-entry SignatureDictionary the caller merges).
      return Promise.all(
        transactions.map(async (transaction) => ({
          [signerAddress]: await signOne(transaction),
        })),
      );
    },
  } satisfies TransactionSigner;
}
