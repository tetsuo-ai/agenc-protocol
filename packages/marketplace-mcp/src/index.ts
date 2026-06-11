/**
 * `@tetsuo-ai/marketplace-mcp` — an open-source, npx-able Model Context
 * Protocol server for the AgenC marketplace (PLAN.md P5.1).
 *
 * Built on the PUBLIC `@tetsuo-ai/marketplace-sdk` and the
 * `@tetsuo-ai/marketplace-tools` registry (clean-room; no EULA kit code). It
 * opens the MACHINE funnel: any MCP-capable agent runtime can discover, inspect,
 * and vet AgenC listings/tasks/agents, and — behind an explicit opt-in — build
 * UNSIGNED hire/claim/submit transactions to sign with its own signer.
 *
 * ## Security posture
 *
 * - **Readonly by default.** A fresh server exposes only the discovery/
 *   inspection/track-record tools.
 * - **Keyless, always.** No wallet is loaded, nothing is signed, nothing is
 *   broadcast.
 * - **Mutations are opt-in and still keyless.** `AGENC_MCP_ENABLE_MUTATIONS=1`
 *   adds the `prepare_*` tools, which BUILD unsigned transactions for the
 *   caller to sign behind their own policy gate.
 *
 * @example Run over stdio (what the `bin` does)
 * ```ts
 * import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 * import {
 *   resolveMcpConfig,
 *   buildToolContext,
 *   createMarketplaceMcpServer,
 * } from "@tetsuo-ai/marketplace-mcp";
 *
 * const config = resolveMcpConfig();
 * const context = buildToolContext(config);
 * const { server } = createMarketplaceMcpServer({
 *   context,
 *   enableMutations: config.enableMutations,
 * });
 * await server.connect(new StdioServerTransport());
 * ```
 *
 * @module
 */
export {
  DEFAULT_RPC_URL,
  envFlag,
  resolveMcpConfig,
  type EnvLike,
  type MarketplaceCluster,
  type McpServerConfig,
} from "./config.js";

export { buildToolContext } from "./context.js";

export {
  SERVER_NAME,
  SERVER_VERSION,
  createMarketplaceMcpServer,
  selectTools,
  marketplaceTools,
  readonlyTools,
  prepareTools,
  type CreateMcpServerOptions,
  type MarketplaceMcpServer,
} from "./server.js";

// Re-export the tool context type so consumers can build/inject one without a
// direct dependency on the tools package's import path.
export type { MarketplaceToolContext } from "@tetsuo-ai/marketplace-tools";
