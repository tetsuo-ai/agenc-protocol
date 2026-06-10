/**
 * Local-keypair MOCK embedded-wallet adapter (PLAN_2 D-1 test seam).
 *
 * A WORKING {@link EmbeddedWalletProvider} backed by a freshly generated kit
 * keypair — it stands in for a real vendor (Privy / Dynamic / Web3Auth) so the
 * "no wallet, no SOL" Done-when runs against localnet WITHOUT committing to a
 * vendor. `connect()` mimics "email login provisions a wallet": first call
 * generates (or adopts a supplied) keypair; the address is then fundable by a
 * localnet/devnet airdrop exactly like a real freshly created embedded wallet.
 *
 * NOT for production: it holds the private key in-process. The REAL vendor
 * adapter is `[HUMAN]`-gated (it must NOT live here). The interface it
 * implements is the only contract templates/widget depend on.
 *
 * Published ONLY behind the `@tetsuo-ai/marketplace-react/testing` subpath — it
 * is deliberately NOT in the package root barrel or the `./signers` export, so
 * it cannot reach a production bundle by accident. It also warns once if it is
 * ever invoked under `NODE_ENV === "production"`.
 *
 * SSR-safe: generation is lazy (inside `connect()`); nothing touches `window`.
 *
 * @module signers/embedded-wallet-mock
 */
import {
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  type KeyPairSigner,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import type {
  EmbeddedWalletConnection,
  EmbeddedWalletProvider,
} from "./types.js";

/**
 * One-time production guard. The mock holds a private key IN-PROCESS and must
 * never ship to production; it lives behind the `./testing` subpath (not the
 * root barrel) so it can't be imported by accident. As a second layer, warn
 * loudly (once) if it is ever invoked under `NODE_ENV === "production"`.
 */
let warnedInProduction = false;
function warnIfProduction(): void {
  if (warnedInProduction) return;
  warnedInProduction = true;
  const nodeEnv =
    typeof process !== "undefined" ? process.env?.NODE_ENV : undefined;
  if (nodeEnv === "production") {
    // eslint-disable-next-line no-console
    console.warn(
      "[@tetsuo-ai/marketplace-react] createMockEmbeddedWallet() was called " +
        "with NODE_ENV=production. This mock holds a private key in-process " +
        "and is for tests ONLY — never ship it. Use a real embedded-wallet " +
        "vendor adapter via signerFromEmbeddedWallet().",
    );
  }
}

/** Options for {@link createMockEmbeddedWallet}. */
export interface MockEmbeddedWalletOptions {
  /**
   * Adopt an existing 64-byte secret key instead of generating one (e.g. to
   * reuse a wallet across a test or pre-seed a known address). When omitted,
   * `connect()` generates a fresh keypair on first call — the realistic
   * "new email user" flow.
   */
  secretKeyBytes?: Uint8Array;
}

/**
 * A mock embedded-wallet provider whose connection exposes the backing
 * {@link KeyPairSigner} (test escape hatch — real vendors never leak the key).
 */
export interface MockEmbeddedWalletProvider extends EmbeddedWalletProvider {
  connect(): Promise<MockEmbeddedWalletConnection>;
  getConnection(): MockEmbeddedWalletConnection | null;
}

/** A mock connection that also surfaces the underlying keypair signer. */
export interface MockEmbeddedWalletConnection extends EmbeddedWalletConnection {
  /** The local keypair signer backing this connection (test-only). */
  readonly keyPairSigner: KeyPairSigner;
}

/** Lift a kit {@link KeyPairSigner} into the embedded-wallet connection shape. */
function connectionFromKeyPair(
  keyPairSigner: KeyPairSigner,
): MockEmbeddedWalletConnection {
  const signerAddress = keyPairSigner.address;
  return {
    address: signerAddress,
    keyPairSigner,
    async signTransactions(
      transactions: readonly Transaction[],
    ): Promise<readonly SignatureBytes[]> {
      // KeyPairSigner.signTransactions returns one SignatureDictionary per tx;
      // pull THIS address's signature out of each to match the embedded
      // connection's flat SignatureBytes[] contract.
      const dictionaries = await keyPairSigner.signTransactions(
        transactions as Parameters<KeyPairSigner["signTransactions"]>[0],
      );
      return dictionaries.map((dict, i) => {
        const signature = dict[signerAddress];
        if (!signature) {
          throw new Error(
            `mock embedded wallet: keypair produced no signature for transaction ${i}`,
          );
        }
        return signature;
      });
    },
  };
}

/**
 * Create a local-keypair-backed mock {@link EmbeddedWalletProvider}.
 *
 * Use it to exercise the walletless path end-to-end: `connect()` to provision
 * the wallet, airdrop/fund its `address`, then `signerFromEmbeddedWallet(conn)`
 * to drive a real hire through the SDK client.
 *
 * @param options - Optionally adopt a known secret key.
 * @returns A mock provider (its connection leaks the keypair, for tests only).
 *
 * @example
 * ```ts
 * const provider = createMockEmbeddedWallet();
 * const conn = await provider.connect();        // "email login"
 * svm.airdrop(address(conn.address), lamports(1_000_000_000n)); // fund it
 * const signer = signerFromEmbeddedWallet(conn);
 * ```
 */
export function createMockEmbeddedWallet(
  options: MockEmbeddedWalletOptions = {},
): MockEmbeddedWalletProvider {
  warnIfProduction();
  let connection: MockEmbeddedWalletConnection | null = null;

  return {
    async connect(): Promise<MockEmbeddedWalletConnection> {
      if (connection) return connection;
      const keyPairSigner = options.secretKeyBytes
        ? await createKeyPairSignerFromBytes(options.secretKeyBytes)
        : await generateKeyPairSigner();
      connection = connectionFromKeyPair(keyPairSigner);
      return connection;
    },
    isConnected(): boolean {
      return connection !== null;
    },
    getConnection(): MockEmbeddedWalletConnection | null {
      return connection;
    },
    async disconnect(): Promise<void> {
      connection = null;
    },
  };
}
