/**
 * Signer-adapter contracts for `@tetsuo-ai/marketplace-react`.
 *
 * Two browser → kit `TransactionSigner` bridges live in this subtree:
 *
 * - **Wallet Standard** ({@link signerFromWalletAccount}): wraps a connected
 *   browser wallet (the `@solana/react` /
 *   `useWalletAccountTransactionSendingSigner` Wallet Standard path, or any
 *   object exposing the `solana:signTransaction` feature) into the kit
 *   {@link TransactionSigner} the SDK's `createMarketplaceClient` consumes.
 * - **Embedded / walletless** ({@link signerFromEmbeddedWallet}): the
 *   PLAN_2 D-1 "no wallet, no SOL" path. Defines the vendor-neutral
 *   {@link EmbeddedWalletProvider} interface ONE chosen vendor (Privy / Dynamic
 *   / Web3Auth — `[HUMAN]`-gated) implements, plus a working local-keypair MOCK
 *   so the walletless Done-when is testable against localnet without a vendor.
 *
 * SSR-safe: nothing here touches `window`/`document` at module scope. The
 * adapters are plain factory functions; only `provider.connect()` (a user
 * gesture) is browser-bound, and that is the vendor's concern, not ours.
 *
 * @module signers/types
 */
import type {
  Address,
  SignatureBytes,
  Transaction,
  TransactionSigner,
} from "@solana/kit";

/**
 * The kit `TransactionSigner` returned by both bridges.
 *
 * Re-exported so consumers (and the hooks/components agents) can type their
 * `signer` slot against one symbol without importing `@solana/kit` directly.
 */
export type { Address, SignatureBytes, Transaction, TransactionSigner };

/**
 * A Wallet Standard `solana:signTransaction` feature method, narrowed to the
 * single shape {@link signerFromWalletAccount} needs.
 *
 * This mirrors `@solana/wallet-standard-features`'s `SolanaSignTransactionMethod`
 * structurally so callers can pass either the real feature function or a test
 * double without a hard dependency on that package's exact version.
 *
 * Given one or more `{ transaction }` wire-format inputs, it returns one
 * `{ signedTransaction }` output per input (a fully serialized, signed
 * transaction. The bridge rejects a returned message that differs from the
 * requested message because the SDK submits the original transaction bytes.
 */
export type WalletStandardSignTransaction = (
  ...inputs: ReadonlyArray<{
    /** Serialized transaction (wire format) to sign. */
    readonly transaction: Uint8Array;
    /** CAIP-2 chain id (e.g. `"solana:devnet"`); forwarded to the wallet. */
    readonly chain?: string;
    /** Optional Wallet Standard account handle (forwarded verbatim). */
    readonly account?: unknown;
  }>
) => Promise<
  ReadonlyArray<{
    /** Serialized, signed transaction (wire format). */
    readonly signedTransaction: Uint8Array;
  }>
>;

/**
 * The minimal Wallet Standard account shape {@link signerFromWalletAccount}
 * consumes. A real `UiWalletAccount` (from `@solana/react` /
 * `@wallet-standard/ui`) is structurally assignable to this; a test double only
 * needs `address` plus a `solana:signTransaction` feature.
 *
 * The feature may be supplied two ways:
 * - inline under `features["solana:signTransaction"].signTransaction`
 *   (the raw Wallet Standard layout), or
 * - via the {@link SignerFromWalletAccountOptions.signTransaction} override.
 */
export interface WalletStandardAccountLike {
  /** Base58 account address (becomes the signer's `address`). */
  readonly address: string;
  /** CAIP-2 chains this account supports (used to validate chain selection). */
  readonly chains?: readonly string[];
  /** Raw Wallet Standard feature bag, when resolvable off the account. */
  readonly features?: Readonly<
    Record<
      string,
      { readonly signTransaction?: WalletStandardSignTransaction } | unknown
    >
  >;
}

/** Provider networks that map to Wallet Standard Solana chain identifiers. */
export type SolanaWalletNetwork = "localnet" | "devnet" | "mainnet";

/** A kit signer whose Wallet Standard chain can be validated by a provider. */
export type ChainBoundTransactionSigner = TransactionSigner & {
  readonly chain: string;
};

/** Options for {@link signerFromWalletAccount}. */
export interface SignerFromWalletAccountOptions {
  /**
   * CAIP-2 chain id forwarded to the wallet on each sign (e.g.
   * `"solana:devnet"`, `"solana:mainnet"`). When omitted, `network` maps to a
   * chain; otherwise the account must expose exactly one `solana:*` chain.
   * Ambiguous or unsupported selections fail closed.
   */
  chain?: string;
  /** Provider network to bind to a Wallet Standard chain. */
  network?: SolanaWalletNetwork;
  /**
   * Explicit `solana:signTransaction` feature method. Overrides any feature
   * resolved off `account.features`. This is the seam tests and non-Wallet-
   * Standard wrappers use, and the recommended way to pass the result of
   * `@solana/react`'s wallet hooks when you hold the feature directly.
   */
  signTransaction?: WalletStandardSignTransaction;
}

/**
 * Vendor-neutral embedded-wallet provider — the PLAN_2 D-1 walletless seam.
 *
 * ONE `[HUMAN]`-chosen vendor (Privy / Dynamic / Web3Auth) implements this
 * behind their email/social login + key custody. The marketplace layer only
 * ever sees this interface, so templates/widget toggle the vendor by config
 * (the C2 `payments.embedded` boolean) without an API break.
 *
 * The {@link createMockEmbeddedWallet} local-keypair adapter implements it for
 * tests so the "no wallet, no SOL" Done-when runs against localnet today.
 */
export interface EmbeddedWalletProvider {
  /**
   * Trigger the vendor's login/onboarding (email, social, passkey, …) and
   * return a ready signer. Idempotent: calling it again after a connection
   * resolves the existing wallet rather than provisioning a new one.
   *
   * This is the ONLY browser-bound method (it runs behind a user gesture); the
   * factory that wraps the provider stays SSR-safe.
   */
  connect(): Promise<EmbeddedWalletConnection>;
  /** Whether a wallet is currently connected (for headless gating/SSR). */
  isConnected(): boolean;
  /** The connected wallet, or `null` before {@link connect}. */
  getConnection(): EmbeddedWalletConnection | null;
  /** Tear down the session (sign out). Optional — not all vendors expose it. */
  disconnect?(): Promise<void>;
}

/**
 * A live embedded-wallet connection: the funded account address plus the
 * primitive that produces signatures.
 *
 * `signTransactions` is the lowest-honest-common-denominator across vendors:
 * given kit {@link Transaction} objects, return this account's
 * {@link SignatureBytes} for each (a partial-signer contract — the vendor never
 * broadcasts, the SDK client's transport does). {@link signerFromEmbeddedWallet}
 * lifts it into a kit {@link TransactionSigner}.
 */
export interface EmbeddedWalletConnection {
  /** The embedded wallet's base58 address. */
  readonly address: string;
  /**
   * Produce this account's signature over each provided transaction WITHOUT
   * sending it. One {@link SignatureBytes} per input, in order.
   */
  signTransactions(
    transactions: readonly Transaction[],
  ): Promise<readonly SignatureBytes[]>;
}
