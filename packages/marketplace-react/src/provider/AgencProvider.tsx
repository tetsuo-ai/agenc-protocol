/**
 * `<AgencProvider>` — the one context that wires reads, writes, and the
 * live referrer config for every AgenC hook/component beneath it.
 *
 * Wraps a bundled TanStack {@link QueryClientProvider} so hooks get
 * caching/refetch/optimistic states with no consumer config. The
 * {@link AgencProviderConfig.client} and {@link AgencProviderConfig.queryTransport}
 * slots are PUBLIC test seams: `startLocalMarketplace().client` plugs straight
 * into `client` for hook e2e, and a mock {@link ReadTransport} plugs into
 * `queryTransport`.
 *
 * SSR-safe: no `window`/`document` access at module scope or during render; all
 * resolution is pure. The provider memoizes the context value and the
 * QueryClient on config identity so SSR + hydration stay stable.
 *
 * @module provider/AgencProvider
 */
import {
  QueryClient,
  QueryClientProvider,
  type QueryClientConfig,
} from "@tanstack/react-query";
import { createMarketplaceClient } from "@tetsuo-ai/marketplace-sdk";
import { useMemo, useState, type ReactNode } from "react";
import { createReadTransport } from "../transport/index.js";
import type {
  AgencContextValue,
  AgencNetwork,
  AgencProviderConfig,
  MarketplaceClient,
  ReadTransport,
  ValidatedReferrerConfig,
} from "../types.js";
import { AgencContext } from "./context.js";
import { resolveEndpoints } from "./network.js";
import {
  resolveReferrerCapability as resolveReferrerCapabilityImpl,
  validateReferrerConfig,
} from "./referrer.js";

/** Props for {@link AgencProvider}. */
export interface AgencProviderProps {
  /** Provider configuration. See {@link AgencProviderConfig}. */
  config: AgencProviderConfig;
  /**
   * Optional pre-built TanStack QueryClient. When omitted, the provider creates
   * one lazily (stable across renders). Pass your own to share a cache with the
   * rest of your app.
   */
  queryClient?: QueryClient;
  /** Override config for the lazily-created QueryClient (ignored if you pass one). */
  queryClientConfig?: QueryClientConfig;
  children: ReactNode;
}

/** Default QueryClient tuning for marketplace reads (sane, overridable). */
const DEFAULT_QUERY_CLIENT_CONFIG: QueryClientConfig = {
  defaultOptions: {
    queries: {
      // Marketplace listings change on-chain slowly relative to a UI session;
      // a short stale window avoids refetch storms while staying fresh.
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
};

/**
 * Build the read transport from config. The `queryTransport` override wins;
 * otherwise indexer-first (when `indexer.baseUrl` is set) with a gPA fallback
 * over the resolved RPC URL.
 *
 * NOTE: the gPA fallback needs a kit `Rpc<GetProgramAccountsApi>`, which we do
 * NOT build here from a bare URL — the SDK write client owns RPC construction.
 * When only a URL (no indexer, no queryTransport) is available, reads require
 * an indexer; the transport factory throws a descriptive error on first use.
 */
function buildReadTransport(
  config: AgencProviderConfig,
): ReadTransport {
  return createReadTransport({
    indexer: config.indexer,
    queryTransport: config.queryTransport,
    // The gPA read source is provided only via queryTransport in v1 (a kit RPC
    // or ProgramAccountsTransport). A future revision can derive a kit RPC from
    // the resolved rpcUrl; for now indexer-first is the supported read path and
    // queryTransport is the test/mocks seam.
  });
}

/**
 * Build the write client from config. The `client` override wins. Otherwise a
 * client is built only when BOTH a resolvable `rpcUrl` and a `signer` exist;
 * absent either, the provider exposes `client: null` and mutating hooks surface
 * a clear error (read-only / indexer-only setups are valid).
 */
function buildWriteClient(
  config: AgencProviderConfig,
  network: AgencNetwork,
): MarketplaceClient | null {
  if (config.client) return config.client;
  if (!config.signer) return null;
  const { rpcUrl, rpcSubscriptionsUrl } = resolveEndpoints(
    network,
    config.rpcUrl,
    config.rpcSubscriptionsUrl,
  );
  if (rpcUrl === null) return null;
  return createMarketplaceClient({
    rpcUrl,
    ...(rpcSubscriptionsUrl ? { rpcSubscriptionsUrl } : {}),
    signer: config.signer,
  });
}

/**
 * The AgenC provider. Place at the root of any tree that uses AgenC hooks or
 * components.
 *
 * @example
 * ```tsx
 * <AgencProvider config={{ network: "devnet", indexer: { baseUrl } }}>
 *   <App />
 * </AgencProvider>
 * ```
 */
export function AgencProvider(props: AgencProviderProps): ReactNode {
  const { config, children } = props;

  // Lazily create (and keep stable) the QueryClient. useState initializer runs
  // once; passing your own `queryClient` overrides it.
  const [internalQueryClient] = useState<QueryClient>(
    () =>
      props.queryClient ??
      new QueryClient(props.queryClientConfig ?? DEFAULT_QUERY_CLIENT_CONFIG),
  );
  const queryClient = props.queryClient ?? internalQueryClient;

  const value = useMemo<AgencContextValue>(() => {
    const network: AgencNetwork = config.network ?? "mainnet";

    // Validate + normalize referrer at provider construction. A bad config
    // throws here, before any hire transaction can be built.
    const referrer: ValidatedReferrerConfig | null = config.referrer
      ? validateReferrerConfig(config.referrer)
      : null;

    const read = buildReadTransport(config);
    const client = buildWriteClient(config, network);

    // The resolved HTTP RPC endpoint, exposed so hooks can make single-account
    // reads (e.g. resolving the WP-A1 roster-attestor account at activation)
    // without an indexer. Not a gPA source — the read transport owns list
    // queries.
    const { rpcUrl } = resolveEndpoints(
      network,
      config.rpcUrl,
      config.rpcSubscriptionsUrl,
    );

    return {
      network,
      read,
      client,
      rpcUrl: rpcUrl ?? null,
      signer: config.signer ?? null,
      referrer,
      resolveReferrerCapability: () => resolveReferrerCapabilityImpl(referrer),
    };
    // Re-resolve when any wiring input changes. Referrer object identity is
    // intentionally part of the deps (a new referrer config must re-validate).
  }, [config]);

  return (
    <QueryClientProvider client={queryClient}>
      <AgencContext.Provider value={value}>{children}</AgencContext.Provider>
    </QueryClientProvider>
  );
}
