/**
 * Browser-wallet → kit `TransactionSigner` bridges (PLAN.md P4.1 / PLAN_2 D-1).
 *
 * Two production adapters + one test mock, all producing the
 * {@link TransactionSigner} the SDK's `createMarketplaceClient` consumes (a
 * PARTIAL signer — the SDK client owns submission). SSR-safe, tree-shakeable.
 *
 * - {@link signerFromWalletAccount} — Wallet Standard (`@solana/react`) path.
 * - {@link signerFromEmbeddedWallet} — vendor-neutral embedded/walletless path.
 *
 * The local-keypair test MOCK (`createMockEmbeddedWallet`) is deliberately NOT
 * exported here — it holds a private key in-process and lives behind the
 * `@tetsuo-ai/marketplace-react/testing` subpath so it can't ship to production.
 *
 * @module signers
 */

// Wallet Standard bridge (the supported browser-wallet path).
export {
  signerFromWalletAccount,
  walletStandardChainForNetwork,
} from "./wallet-account.js";

// Legacy @solana/wallet-adapter compatibility shim (optional, no hard dep).
export {
  signerFromWalletAdapter,
  type SignerFromWalletAdapterOptions,
  type VersionedTransactionCtor,
  type VersionedTransactionLike,
  type WalletAdapterLike,
} from "./wallet-adapter.js";

// Embedded / walletless bridge.
export { signerFromEmbeddedWallet } from "./embedded-wallet.js";

// NOTE: the local-keypair MOCK embedded-wallet adapter
// (`createMockEmbeddedWallet`) is NOT exported here — it is test-only and lives
// behind the "./testing" subpath (src/testing/index.ts).

// The signer-adapter contracts (the seam the hooks/components/templates bind to).
export type {
  ChainBoundTransactionSigner,
  EmbeddedWalletConnection,
  EmbeddedWalletProvider,
  SignerFromWalletAccountOptions,
  SolanaWalletNetwork,
  TransactionSigner,
  WalletStandardAccountLike,
  WalletStandardSignTransaction,
} from "./types.js";

// Signer string catalog (so a future locale can extend `signer.*`).
export { EN_SIGNER_STRINGS, type SignerStringId } from "./strings.js";
