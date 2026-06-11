/**
 * Build the {@link MarketplaceToolContext} the tool handlers run against, from
 * a resolved {@link McpServerConfig}.
 *
 * The context is the ONLY thing the tools touch — a `read` transport (kit RPC
 * or any `ProgramAccountsSource`), an optional single-account `rpc`, an
 * optional hosted `indexer`, and the `programAddress`. The server is keyless:
 * nothing here holds, loads, or derives a signer.
 *
 * @module context
 */
import { createSolanaRpc } from "@solana/kit";
import {
  createIndexerClient,
  type IndexerClient,
} from "@tetsuo-ai/marketplace-sdk";
import type {
  KitRpcLike,
  MarketplaceToolContext,
} from "@tetsuo-ai/marketplace-tools";
import type { McpServerConfig } from "./config.js";

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
export function buildToolContext(
  config: McpServerConfig,
): MarketplaceToolContext {
  // A kit RPC satisfies both the ProgramAccountsSource `read` seam (it carries
  // getProgramAccounts) and the single-account `rpc` seam.
  const rpc = createSolanaRpc(config.rpcUrl) as unknown as KitRpcLike;

  let indexer: IndexerClient | undefined;
  if (config.indexerUrl !== undefined) {
    indexer = createIndexerClient({
      baseUrl: config.indexerUrl,
      ...(config.indexerApiKey !== undefined
        ? { apiKey: config.indexerApiKey }
        : {}),
    });
  }

  const ctx: MarketplaceToolContext = {
    // The kit RPC is a valid ProgramAccountsSource (the queries layer wraps it).
    read: rpc as unknown as MarketplaceToolContext["read"],
    rpc,
  };
  if (indexer !== undefined) ctx.indexer = indexer;
  if (config.programAddress !== undefined) {
    ctx.programAddress = config.programAddress;
  }
  return ctx;
}
