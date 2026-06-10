/**
 * Embedded / walletless → kit `TransactionSigner` bridge (PLAN_2 D-1).
 *
 * The "no wallet, no SOL" buyer path. A vendor-neutral
 * {@link EmbeddedWalletProvider} (Privy / Dynamic / Web3Auth — `[HUMAN]`-gated)
 * handles email/social login + key custody; this module lifts a live
 * {@link EmbeddedWalletConnection} into the kit {@link TransactionSigner} the SDK
 * client consumes. As with the Wallet Standard bridge, the result is a PARTIAL
 * signer — the vendor signs, the SDK client's transport broadcasts.
 *
 * @see {@link signerFromEmbeddedWallet}
 * @see {@link createMockEmbeddedWallet} — the local-keypair test adapter.
 * @module signers/embedded-wallet
 */
import { address, type SignatureBytes, type Transaction } from "@solana/kit";
import { ts } from "./strings.js";
import type {
  EmbeddedWalletConnection,
  TransactionSigner,
} from "./types.js";

/**
 * Bridge a CONNECTED embedded-wallet connection into a kit
 * {@link TransactionSigner}.
 *
 * Call this AFTER `provider.connect()` resolves — it needs the live
 * {@link EmbeddedWalletConnection} (address + `signTransactions`). The hooks
 * layer (`useWalletSigner`) is expected to own the connect lifecycle and call
 * this once a connection exists.
 *
 * @param connection - A live embedded-wallet connection.
 * @returns A kit {@link TransactionSigner} usable as `config.signer`.
 *
 * @example
 * ```ts
 * const connection = await provider.connect();    // vendor login
 * const signer = signerFromEmbeddedWallet(connection);
 * // -> pass `signer` to <AgencProvider config={{ signer, rpcUrl }}>.
 * ```
 */
export function signerFromEmbeddedWallet(
  connection: EmbeddedWalletConnection,
): TransactionSigner {
  const signerAddress = address(connection.address);

  return {
    address: signerAddress,
    async signTransactions(transactions: readonly Transaction[]) {
      const signatures: readonly SignatureBytes[] =
        await connection.signTransactions(transactions);
      if (signatures.length !== transactions.length) {
        throw new Error(
          ts("signer.embeddedSignatureCount", {
            expected: transactions.length,
            got: signatures.length,
          }),
        );
      }
      return transactions.map((_, i) => ({
        [signerAddress]: signatures[i] as SignatureBytes,
      }));
    },
  } satisfies TransactionSigner;
}
