/**
 * `@tetsuo-ai/marketplace-react/testing` — TEST-ONLY helpers.
 *
 * This subpath isolates helpers that must NEVER ship to production from the
 * package root + `./signers` barrels. Currently it exposes the local-keypair
 * MOCK embedded wallet, which holds a private key IN-PROCESS to stand in for a
 * real vendor (Privy / Dynamic / Web3Auth) during tests and the walletless
 * Done-when. Importing it requires the explicit `/testing` subpath, and it
 * warns once if invoked under `NODE_ENV === "production"`.
 *
 * Do NOT import anything from here in production code. Use
 * {@link signerFromEmbeddedWallet} (from the root or `./signers`) with a real
 * vendor adapter instead.
 *
 * @module testing
 */

// Local-keypair MOCK embedded-wallet adapter (the walletless test seam).
export {
  createMockEmbeddedWallet,
  type MockEmbeddedWalletConnection,
  type MockEmbeddedWalletOptions,
  type MockEmbeddedWalletProvider,
} from "../signers/embedded-wallet-mock.js";
