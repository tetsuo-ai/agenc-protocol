/**
 * Shared types for `@tetsuo-ai/marketplace-react`.
 *
 * Re-exported from the package root so hooks/components agents (and consumers)
 * bind to one canonical set. SDK types are referenced by import, not copied.
 *
 * @module types
 */
import type {
  Address,
  Rpc,
  GetProgramAccountsApi,
  TransactionSigner,
} from "@solana/kit";
import type {
  CreateIndexerClientOptions,
  DecodedProgramAccount,
  IndexerAgentTrackRecord,
  IndexerHire,
  IndexerListing,
  ListActiveListingsOptions,
  MarketplaceClient,
  ProgramAccountsTransport,
  ServiceListing,
} from "@tetsuo-ai/marketplace-sdk";

/**
 * Indexer connection config for the read transport. Mirrors the SDK's
 * {@link CreateIndexerClientOptions} subset the provider needs (baseUrl is
 * what flips the transport into indexer-first mode).
 */
export interface IndexerConfig {
  /** Base URL of the hosted indexer/storefront API. Presence = indexer-first. */
  baseUrl: string;
  /** Optional API key (`X-Agenc-Api-Key`). Anonymous reads work without it. */
  apiKey?: string;
}

/**
 * A kit RPC capable of `getProgramAccounts`, or any SDK
 * {@link ProgramAccountsTransport} — the gPA fallback read source.
 */
export type GpaReadSource =
  | Rpc<GetProgramAccountsApi>
  | ProgramAccountsTransport;

/**
 * The unified read interface the provider exposes (indexer-first, gPA
 * fallback). Both backends return parity shapes by SDK design, so a hook never
 * branches on which one is live.
 *
 * - `listActiveListings` returns the SAME `Array<{ address, account }>` shape
 *   from both the indexer and the gPA path.
 * - `getListing` returns the indexer's rich `IndexerListing` when available;
 *   the gPA fallback synthesizes the same shape from a decoded account.
 * - `listingHires` / `agentTrackRecord` are indexer-native; the gPA fallback
 *   throws a descriptive {@link ReadTransportUnsupportedError} (no trustless
 *   gPA equivalent exists for an aggregated track record).
 */
export interface ReadTransport {
  /** Which backend is in use — for diagnostics and conditional UI. */
  readonly kind: "indexer" | "gpa";
  /** List active service listings (parity shape across both backends). */
  listActiveListings(
    options?: ListActiveListingsOptions,
  ): Promise<Array<DecodedProgramAccount<ServiceListing>>>;
  /** Fetch one listing by PDA. */
  getListing(pda: Address | string): Promise<ReadListingResult>;
  /** Hires of a listing (indexer-native; gPA fallback is unsupported). */
  listingHires(pda: Address | string): Promise<IndexerHire[]>;
  /** Agent track record (indexer-native; gPA fallback is unsupported). */
  agentTrackRecord(pda: Address | string): Promise<IndexerAgentTrackRecord>;
}

/**
 * The unified `getListing` result. When the indexer backend is live this is the
 * full {@link IndexerListing}; under the gPA fallback the `decoded` projection
 * is absent and `account` carries the decoded on-chain bytes.
 */
export interface ReadListingResult {
  /** The listing PDA. */
  address: Address;
  /** The decoded on-chain account (always present). */
  account: ServiceListing;
  /** The indexer's rich projection, when the indexer backend served this. */
  indexer?: IndexerListing;
}

/**
 * Options for `createReadTransport`. Supplying `queryTransport` (a mock or a
 * pre-built transport) overrides everything — this is the public test seam the
 * provider re-exposes via `config.queryTransport`.
 */
export interface CreateReadTransportConfig {
  /** Indexer connection (presence of `baseUrl` selects the indexer backend). */
  indexer?: IndexerConfig;
  /** gPA fallback read source (kit RPC or a ProgramAccountsTransport). */
  rpc?: GpaReadSource;
  /**
   * Full override: a ready-made {@link ReadTransport} (tests/mocks/SSR
   * fixtures). Wins over `indexer` and `rpc`.
   */
  queryTransport?: ReadTransport;
  /** Override the SDK's indexer client factory options (advanced/tests). */
  indexerClientOptions?: Partial<CreateIndexerClientOptions>;
}

/** Target Solana cluster for the provider's default endpoint resolution. */
export type AgencNetwork = "localnet" | "devnet" | "mainnet";

/**
 * Referrer configuration. Accepted + validated + stored ALWAYS; injected into
 * hires only when {@link ReferrerCapability.live} is true. See
 * {@link resolveReferrerCapability}.
 */
export interface ReferrerConfig {
  /** Referrer wallet that earns the fee. Must be a valid base58 address. */
  wallet: string;
  /**
   * Referral fee in basis points (1 bps = 0.01%). Validated against
   * `[REFERRER_FEE_BPS_MIN, REFERRER_FEE_BPS_MAX]`.
   */
  feeBps: number;
}

/**
 * A validated, normalized referrer config (the stored form). `wallet` is a
 * branded kit {@link Address} once validation passes.
 */
export interface ValidatedReferrerConfig {
  /** Validated referrer wallet address. */
  wallet: Address;
  /** Validated referral fee in basis points. */
  feeBps: number;
}

/**
 * The runtime answer to "can a referral fee actually be charged on this
 * cluster?". Returned by `resolveReferrerCapability()`.
 *
 * Referrer settlement is live on the full 84-instruction surface. `live` is true
 * when a validated provider referrer is configured. Aggregated earnings remain a
 * separate indexer-gated read surface.
 */
export interface ReferrerCapability {
  /** Whether referral settlement is live on the target cluster. */
  live: boolean;
  /** Human-readable reason, always set when `live` is false. */
  reason?: string;
  /** The validated referrer config under this provider, if one was supplied. */
  referrer?: ValidatedReferrerConfig;
}

/**
 * Full `<AgencProvider config={...}>` configuration.
 *
 * The `client` and `queryTransport` slots are PUBLIC API: the SDK's
 * `startLocalMarketplace()` litesvm harness exposes a `{ client }` that plugs
 * straight in for hook e2e, and mock read transports use `queryTransport`.
 */
export interface AgencProviderConfig {
  /** Target cluster; drives default RPC/indexer endpoint resolution. */
  network?: AgencNetwork;
  /** HTTP RPC endpoint. Overrides the network default. */
  rpcUrl?: string;
  /** WebSocket RPC endpoint (for subscriptions). Overrides the network default. */
  rpcSubscriptionsUrl?: string;
  /** Indexer connection — presence of `indexer.baseUrl` selects indexer-first. */
  indexer?: IndexerConfig;
  /** Referrer config (accepted + validated; injected into hire transactions). */
  referrer?: ReferrerConfig;
  /** Signer for write operations (the kit `TransactionSigner`). */
  signer?: TransactionSigner;
  /**
   * Pre-built write client override slot. When set, it is used verbatim and the
   * provider builds no client from `rpcUrl`/`signer`. This is how
   * `startLocalMarketplace().client` plugs in for hook e2e.
   */
  client?: MarketplaceClient;
  /**
   * Pre-built read transport override slot (tests/mocks/SSR fixtures). Wins over
   * `indexer`/`rpc` resolution.
   */
  queryTransport?: ReadTransport;
}

/**
 * The value exposed via React context by `<AgencProvider>` and read by
 * `useAgencContext()`. Hooks bind to THIS shape.
 */
export interface AgencContextValue {
  /** Resolved target network. */
  network: AgencNetwork;
  /** The unified read transport (indexer-first, gPA fallback). */
  read: ReadTransport;
  /**
   * The write client, or `null` when neither `client` nor `rpcUrl`+`signer`
   * was supplied. Mutating hooks surface a clear error in that case.
   */
  client: MarketplaceClient | null;
  /**
   * The resolved HTTP RPC endpoint (config override or the network default),
   * or `null` when none resolves. Hooks use it for single-account reads —
   * e.g. resolving the WP-A1 `moderation_attestor` roster account during
   * activation. NOT a gPA/list-query source; the read transport owns those.
   */
  rpcUrl: string | null;
  /** The configured signer, or `null`. */
  signer: TransactionSigner | null;
  /** Validated referrer config, or `null` when none was supplied. */
  referrer: ValidatedReferrerConfig | null;
  /**
   * Resolve whether this provider has a live referral-settlement config.
   */
  resolveReferrerCapability(): ReferrerCapability;
}

export type {
  Address,
  DecodedProgramAccount,
  IndexerAgentTrackRecord,
  IndexerHire,
  IndexerListing,
  ListActiveListingsOptions,
  MarketplaceClient,
  ServiceListing,
  TransactionSigner,
};
