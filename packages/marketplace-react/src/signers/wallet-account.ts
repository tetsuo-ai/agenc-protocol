/**
 * Wallet Standard → kit `TransactionSigner` bridge (PLAN.md P4.1 / PLAN_2 D-1).
 *
 * Turns a connected browser wallet into the {@link TransactionSigner} the SDK's
 * `createMarketplaceClient` consumes. The SDK client signs via
 * `signTransactionMessageWithSigners(...)` and submits through its OWN transport
 * — so it needs a PARTIAL signer (one that returns signatures without sending),
 * NOT a `TransactionSendingSigner` (which `signTransactionMessageWithSigners`
 * deliberately ignores). This bridge therefore produces a
 * {@link TransactionPartialSigner}: it batches transactions through the
 * wallet's variadic `solana:signTransaction` feature, requires byte-identical
 * returned messages, and recovers THIS account's verified signatures.
 *
 * @see {@link signerFromWalletAccount}
 * @module signers/wallet-account
 */
import {
  address,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  verifySignature,
  type Address,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import { ts } from "./strings.js";
import type {
  ChainBoundTransactionSigner,
  SignerFromWalletAccountOptions,
  SolanaWalletNetwork,
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

/** Map an AgenC provider network to the Wallet Standard chain identifier. */
export function walletStandardChainForNetwork(
  network: SolanaWalletNetwork,
): string {
  return `solana:${network}`;
}

/** Resolve and validate the CAIP-2 chain forwarded to the wallet. */
function resolveChain(
  account: WalletStandardAccountLike,
  options: SignerFromWalletAccountOptions,
): string {
  const networkChain = options.network
    ? walletStandardChainForNetwork(options.network)
    : undefined;
  if (options.chain && networkChain && options.chain !== networkChain) {
    throw new Error(
      ts("signer.walletChainNetworkMismatch", {
        chain: options.chain,
        network: options.network!,
        expected: networkChain,
      }),
    );
  }

  const solanaChains =
    account.chains?.filter((chain) => chain.startsWith("solana:")) ?? [];
  const requested = options.chain ?? networkChain;
  const chain =
    requested ?? (solanaChains.length === 1 ? solanaChains[0] : undefined);
  if (!chain) {
    throw new Error(
      ts("signer.walletChainRequired", {
        address: account.address,
        count: solanaChains.length,
      }),
    );
  }
  if (
    !chain.startsWith("solana:") ||
    (account.chains !== undefined && !account.chains.includes(chain))
  ) {
    throw new Error(
      ts("signer.walletChainUnsupported", {
        address: account.address,
        chain,
      }),
    );
  }
  return chain;
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
 * Bridge a Wallet Standard account into a kit {@link TransactionSigner}.
 *
 * Accepts either a real `UiWalletAccount` (the `@solana/react` path — pass the
 * account and a `chain`, or pass the hook's feature via
 * {@link SignerFromWalletAccountOptions.signTransaction}) or any object exposing
 * the `solana:signTransaction` feature. The returned signer is a
 * {@link TransactionPartialSigner}, the exact shape the SDK client expects.
 *
 * The SDK client re-assembles and submits the ORIGINAL transaction. This bridge
 * therefore accepts only byte-identical returned message bytes and verifies the
 * extracted signature over them.
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
): ChainBoundTransactionSigner {
  const signerAddress: Address = address(account.address);
  const signTransaction = resolveSignTransaction(account, options);
  const chain = resolveChain(account, options);
  const encoder = getTransactionEncoder();
  const decoder = getTransactionDecoder();
  let publicKeyPromise: ReturnType<typeof getPublicKeyFromAddress> | undefined;

  async function extractSignature(
    transaction: Transaction,
    signedTransaction: Uint8Array,
  ): Promise<SignatureBytes> {
    const signed = decoder.decode(signedTransaction);
    if (!bytesEqual(transaction.messageBytes, signed.messageBytes)) {
      throw new Error(
        ts("signer.walletModifiedTransaction", { address: account.address }),
      );
    }
    const signature = signed.signatures[signerAddress];
    if (!signature) {
      throw new Error(ts("signer.walletNoSignature", { address: account.address }));
    }
    publicKeyPromise ??= getPublicKeyFromAddress(signerAddress);
    const valid = await verifySignature(
      await publicKeyPromise,
      signature,
      transaction.messageBytes,
    );
    if (!valid) {
      throw new Error(
        ts("signer.walletInvalidSignature", { address: account.address }),
      );
    }
    return signature as SignatureBytes;
  }

  return {
    address: signerAddress,
    chain,
    async signTransactions(transactions) {
      if (transactions.length === 0) return [];
      // Wallet Standard is variadic: one call preserves single-flight approval
      // behavior and output ordering.
      const outputs = await signTransaction(
        ...transactions.map((transaction) => ({
          account,
          chain,
          transaction: new Uint8Array(encoder.encode(transaction)),
        })),
      );
      if (outputs.length !== transactions.length) {
        throw new Error(
          ts("signer.walletResponseCount", {
            got: outputs.length,
            expected: transactions.length,
          }),
        );
      }
      return Promise.all(
        outputs.map(async (output, index) => ({
          [signerAddress]: await extractSignature(
            transactions[index]!,
            output.signedTransaction,
          ),
        })),
      );
    },
  } satisfies ChainBoundTransactionSigner;
}
