/**
 * `@tetsuo-ai/marketplace-sdk/sandbox` — the **sandbox** surface (PLAN.md
 * P2.4): seeded fixtures at known addresses, one-call funded sandbox
 * clients, and the P2.3 moderation auto-attestor helper.
 *
 * ## LOCALNET/DEVNET ONLY
 *
 * Everything in this module targets the documented localnet stack
 * (`scripts/localnet-up.mjs` at the repo root — the shipped default) or
 * public devnet through the environment seam
 * ({@link resolveSandboxEnvironment}) — with throwaway keys and faucet play
 * money. Never point it at mainnet and never send real funds to a sandbox
 * signer.
 *
 * ## The environment seam
 *
 * {@link resolveSandboxEnvironment} is the single switchover point between
 * localnet (the shipped default), public devnet, and a hosted surface
 * (later): explicit options beat the `AGENC_SANDBOX_*` environment
 * variables, which beat the shipped localnet defaults. `createSandboxClient`
 * and `requestSandboxAttestation` route their defaults through it.
 *
 * Browser-safe: built on `fetch` + `@solana/kit` only — no Node built-ins
 * (unlike `./testing`, which needs the litesvm native module). `process` is
 * read behind `typeof` guards, and the `AGENC_SANDBOX_FIXTURES` file path is
 * only ever read through a guarded dynamic import in Node.
 *
 * @module sandbox
 */
export {
  assertSandboxSeeded,
  SANDBOX_FIXTURES,
  SandboxNotSeededError,
  sandboxListings,
  sandboxProviders,
  type SandboxFixtures,
  type SandboxFixturesCluster,
  type SandboxListingFixture,
  type SandboxProviderFixture,
} from "./fixtures.js";
export {
  DEFAULT_HOSTED_MODERATION_LISTINGS_URL,
  resolveSandboxEnvironment,
  SANDBOX_CLUSTERS,
  SANDBOX_DEVNET_RPC_SUBSCRIPTIONS_URL,
  SANDBOX_DEVNET_RPC_URL,
  SANDBOX_LOCALNET_RPC_SUBSCRIPTIONS_URL,
  SANDBOX_LOCALNET_RPC_URL,
  type ResolveSandboxEnvironmentOptions,
  type SandboxCluster,
  type SandboxEnvironment,
} from "./environment.js";
export {
  createSandboxClient,
  DEFAULT_SANDBOX_AIRDROP_LAMPORTS,
  SandboxAirdropError,
  SandboxClusterError,
  type CreateSandboxClientOptions,
  type SandboxAirdropRpc,
  type SandboxClient,
  type SandboxRpc,
} from "./client.js";
export {
  requestSandboxAttestation,
  SandboxAttestationError,
  type RequestSandboxAttestationInput,
  type SandboxAttestationKind,
  type SandboxAttestationResponse,
  type SandboxFetchLike,
} from "./attest.js";
export {
  ListingModerationError,
  requestListingModeration,
  type ListingModerationAttestation,
  type ListingModerationResult,
  type ListingModerationVerdict,
  type RequestListingModerationInput,
} from "./moderation.js";
