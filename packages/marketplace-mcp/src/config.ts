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
import type { Address } from "@solana/kit";

/** Marketplace clusters the default-RPC resolver understands. */
export type MarketplaceCluster = "mainnet" | "devnet" | "localnet";

/**
 * Default public RPC endpoints per cluster, used only when `AGENC_RPC_URL` is
 * unset. NOTE: public RPCs frequently disable or rate-limit
 * `getProgramAccounts` (the trustless read path the list/search tools use) —
 * for reliable discovery point `AGENC_RPC_URL` at a gPA-enabled RPC or set
 * `AGENC_INDEXER_URL` to the hosted scale path. The localnet default matches
 * `scripts/localnet-up.mjs`.
 */
export const DEFAULT_RPC_URL: Readonly<Record<MarketplaceCluster, string>> = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};

/** Truthy env-flag parse: `1` / `true` / `yes` / `on` (case-insensitive). */
export function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** The resolved, typed server configuration. */
export interface McpServerConfig {
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
export type EnvLike = Record<string, string | undefined>;

function parseCluster(raw: string | undefined): MarketplaceCluster {
  const v = (raw ?? "mainnet").trim().toLowerCase();
  if (v === "mainnet" || v === "mainnet-beta") return "mainnet";
  if (v === "devnet") return "devnet";
  if (v === "localnet" || v === "local" || v === "localhost") return "localnet";
  throw new Error(
    `AGENC_MARKETPLACE_CLUSTER must be one of mainnet | devnet | localnet (got ${JSON.stringify(raw)})`,
  );
}

/**
 * Resolve the MCP server configuration from an environment.
 *
 * @param env - The environment to read from (defaults to `process.env`).
 * @returns A typed {@link McpServerConfig}.
 */
export function resolveMcpConfig(
  env: EnvLike = process.env,
): McpServerConfig {
  const cluster = parseCluster(env.AGENC_MARKETPLACE_CLUSTER);
  const explicitRpc = env.AGENC_RPC_URL?.trim();
  const rpcUrl =
    explicitRpc !== undefined && explicitRpc.length > 0
      ? explicitRpc
      : DEFAULT_RPC_URL[cluster];

  const indexerUrl = env.AGENC_INDEXER_URL?.trim();
  const indexerApiKey = env.AGENC_INDEXER_API_KEY?.trim();
  const programAddress = env.AGENC_PROGRAM_ADDRESS?.trim();

  const config: McpServerConfig = {
    cluster,
    rpcUrl,
    rpcUrlExplicit: explicitRpc !== undefined && explicitRpc.length > 0,
    enableMutations: envFlag(env.AGENC_MCP_ENABLE_MUTATIONS),
  };
  if (indexerUrl !== undefined && indexerUrl.length > 0) {
    config.indexerUrl = indexerUrl;
  }
  if (indexerApiKey !== undefined && indexerApiKey.length > 0) {
    config.indexerApiKey = indexerApiKey;
  }
  if (programAddress !== undefined && programAddress.length > 0) {
    config.programAddress = programAddress as Address;
  }
  return config;
}
