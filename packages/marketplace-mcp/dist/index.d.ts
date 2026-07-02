import { Address } from '@solana/kit';
import { MarketplaceToolContext, MarketplaceTool, MarketplaceToolRegistry } from '@tetsuo-ai/marketplace-tools';
export { MarketplaceToolContext, marketplaceTools, prepareTools, readonlyTools } from '@tetsuo-ai/marketplace-tools';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * Environment-driven configuration for the AgenC marketplace MCP server.
 *
 * The server is a thin, KEYLESS wrapper: it reads its entire posture from the
 * process environment (no config file, no secrets, no wallet). This module is
 * the single resolution point — the "environment seam" mirroring the SDK's
 * `resolveSandboxEnvironment` — turning env vars into a typed
 * {@link McpServerConfig}.
 *
 * READ TRANSPORT
 * - `AGENC_RPC_URL` — a `getProgramAccounts`-capable Solana RPC. This is the
 *   trustless read path (`list_listings`, `list_open_tasks`, `search`, the
 *   single-account fetches, `get_agent_track_record`). When omitted, the
 *   cluster default for `AGENC_MARKETPLACE_CLUSTER` is used.
 * - `AGENC_INDEXER_URL` — an optional hosted indexer base URL. When set, it
 *   unlocks the richer hosted read model: `get_agent_track_record` and the
 *   listings reads prefer it (the scale path). The MCP context still carries
 *   the RPC for single-account fetches.
 * - `AGENC_INDEXER_API_KEY` — optional API key for the hosted indexer.
 * - `AGENC_MARKETPLACE_CLUSTER` — `mainnet` (default) | `devnet` | `localnet`.
 *   Only used to pick the default RPC URL when `AGENC_RPC_URL` is unset.
 * - `AGENC_PROGRAM_ADDRESS` — override the agenc-coordination program id
 *   (defaults to the canonical address baked into the SDK).
 *
 * MUTATION OPT-IN (off by default)
 * - `AGENC_MCP_ENABLE_MUTATIONS` — when truthy (`1`/`true`/`yes`/`on`), the
 *   keyless `prepare_*` tools (build UNSIGNED transactions; never sign, never
 *   send) are exposed. OFF by default: a fresh `npx` boot is readonly.
 *
 * @module config
 */

/** Marketplace clusters the default-RPC resolver understands. */
type MarketplaceCluster = "mainnet" | "devnet" | "localnet";
/**
 * Default public RPC endpoints per cluster, used only when `AGENC_RPC_URL` is
 * unset. NOTE: public RPCs frequently disable or rate-limit
 * `getProgramAccounts` (the trustless read path the list/search tools use) —
 * for reliable discovery point `AGENC_RPC_URL` at a gPA-enabled RPC or set
 * `AGENC_INDEXER_URL` to the hosted scale path. The localnet default matches
 * `scripts/localnet-up.mjs`.
 */
declare const DEFAULT_RPC_URL: Readonly<Record<MarketplaceCluster, string>>;
/** Truthy env-flag parse: `1` / `true` / `yes` / `on` (case-insensitive). */
declare function envFlag(value: string | undefined): boolean;
/** The resolved, typed server configuration. */
interface McpServerConfig {
    /** The cluster whose default RPC is used when no explicit RPC URL is given. */
    cluster: MarketplaceCluster;
    /** The resolved read RPC URL (explicit `AGENC_RPC_URL` or the cluster default). */
    rpcUrl: string;
    /** Whether `AGENC_RPC_URL` was explicitly provided (vs. a cluster default). */
    rpcUrlExplicit: boolean;
    /** Optional hosted indexer base URL (the scale read path), if configured. */
    indexerUrl?: string;
    /** Optional hosted indexer API key. */
    indexerApiKey?: string;
    /** Optional program-address override (base58); undefined = SDK default. */
    programAddress?: Address;
    /**
     * Whether the keyless `prepare_*` (unsigned-mutation) tools are exposed.
     * `false` by default — a fresh boot is readonly.
     */
    enableMutations: boolean;
}
/** A `process.env`-shaped record (kept structural so tests can inject one). */
type EnvLike = Record<string, string | undefined>;
/**
 * Resolve the MCP server configuration from an environment.
 *
 * @param env - The environment to read from (defaults to `process.env`).
 * @returns A typed {@link McpServerConfig}.
 */
declare function resolveMcpConfig(env?: EnvLike): McpServerConfig;

/**
 * Construct a {@link MarketplaceToolContext} from a server config.
 *
 * - `read` and `rpc` are both the kit RPC at `config.rpcUrl` (the gPA read
 *   path + single-account fetches).
 * - `indexer` is populated only when `config.indexerUrl` is set (the hosted
 *   scale read path).
 * - `programAddress` flows through when overridden.
 *
 * @param config - The resolved server configuration.
 * @returns A ready tool context (no key, no signer).
 */
declare function buildToolContext(config: McpServerConfig): MarketplaceToolContext;

/**
 * The AgenC marketplace MCP server.
 *
 * An open-source, framework-neutral Model Context Protocol server built on the
 * PUBLIC `@tetsuo-ai/marketplace-sdk` + the `@tetsuo-ai/marketplace-tools`
 * registry. It exposes the marketplace discovery/inspection/track-record tools
 * over MCP so any MCP-capable agent runtime can find and vet AgenC listings,
 * tasks, and agents.
 *
 * ## Security posture (read this)
 *
 * - **READONLY BY DEFAULT.** A fresh server exposes ONLY the readonly tools
 *   (`list_listings`, `get_listing`, `list_open_tasks`, `get_task`,
 *   `get_agent_track_record`, `search`). They read public on-chain state and
 *   return JSON; they never mutate anything.
 * - **KEYLESS, ALWAYS.** The process holds NO private key, loads NO wallet, and
 *   NEVER signs or broadcasts a transaction. There is no code path here that
 *   can move funds.
 * - **MUTATIONS ARE OPT-IN AND STILL KEYLESS.** When
 *   `AGENC_MCP_ENABLE_MUTATIONS=1` (or {@link CreateMcpServerOptions.enableMutations}),
 *   the `prepare_*` tools are added. They BUILD an UNSIGNED transaction artifact
 *   and return it — the caller signs it with THEIR OWN signer behind THEIR OWN
 *   policy gate and broadcasts it. This mirrors the AgenC kit's signer-local,
 *   policy-gated philosophy: the server is a tx builder, never a signer.
 *
 * @module server
 */

/** This package's name + version, surfaced in the MCP `serverInfo`. */
declare const SERVER_NAME = "@tetsuo-ai/marketplace-mcp";
declare const SERVER_VERSION = "0.2.0";
/** Options for {@link createMarketplaceMcpServer}. */
interface CreateMcpServerOptions {
    /**
     * The tool runtime context (read transport + optional indexer/program).
     * Required — the server holds no key, only this readonly/prepare context.
     */
    context: MarketplaceToolContext;
    /**
     * Expose the keyless `prepare_*` (unsigned-mutation) tools. Defaults to
     * `false` — readonly only. Even when `true`, the server never signs or sends.
     */
    enableMutations?: boolean;
    /**
     * Override the tool set entirely (advanced/testing). When provided, this
     * exact list is registered and `enableMutations` is ignored. Defaults to the
     * readonly set (+ prepare set when `enableMutations`).
     */
    tools?: ReadonlyArray<MarketplaceTool>;
}
/** The result of {@link createMarketplaceMcpServer}: the wired MCP server. */
interface MarketplaceMcpServer {
    /** The low-level MCP {@link Server}; `connect(transport)` to start serving. */
    readonly server: Server;
    /** The exact tool set registered (stable order). */
    readonly tools: ReadonlyArray<MarketplaceTool>;
    /** The `name → tool` registry the CallTool handler dispatches through. */
    readonly registry: MarketplaceToolRegistry;
    /** Whether the keyless prepare tools are exposed. */
    readonly mutationsEnabled: boolean;
}
/**
 * Select the active tool set: readonly always; the prepare tools only when
 * mutations are explicitly enabled.
 */
declare function selectTools(enableMutations: boolean): ReadonlyArray<MarketplaceTool>;
/**
 * Build (but do not connect) the AgenC marketplace MCP server.
 *
 * Wires the `tools/list` and `tools/call` handlers against the
 * {@link MarketplaceToolRegistry}, running each handler with the provided
 * keyless {@link MarketplaceToolContext}. Call `result.server.connect(transport)`
 * (e.g. a `StdioServerTransport`) to start serving.
 *
 * @param options - The tool context, the mutation opt-in, and an optional
 * tool-set override.
 * @returns A {@link MarketplaceMcpServer}.
 *
 * @example
 * ```ts
 * import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 * import { createMarketplaceMcpServer } from "@tetsuo-ai/marketplace-mcp";
 *
 * const { server } = createMarketplaceMcpServer({ context });
 * await server.connect(new StdioServerTransport());
 * ```
 */
declare function createMarketplaceMcpServer(options: CreateMcpServerOptions): MarketplaceMcpServer;

export { type CreateMcpServerOptions, DEFAULT_RPC_URL, type EnvLike, type MarketplaceCluster, type MarketplaceMcpServer, type McpServerConfig, SERVER_NAME, SERVER_VERSION, buildToolContext, createMarketplaceMcpServer, envFlag, resolveMcpConfig, selectTools };
