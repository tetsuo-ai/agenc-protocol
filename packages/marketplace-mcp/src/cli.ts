/**
 * Flags the `agenc-marketplace-mcp` bin answers without starting the stdio
 * server: `--help` / `-h` and `--version` / `-v`. Any other invocation boots
 * the server exactly as before.
 *
 * @module cli
 */
import { SERVER_NAME, SERVER_VERSION } from "./server.js";

/** Usage text printed by `agenc-marketplace-mcp --help`. */
export function helpText(): string {
  return [
    `agenc-marketplace-mcp ${SERVER_VERSION} (${SERVER_NAME})`,
    "",
    "Model Context Protocol server for the AgenC marketplace, over stdio.",
    "Readonly and keyless by default: it never loads a wallet, signs or broadcasts.",
    "",
    "Usage:",
    "  agenc-marketplace-mcp            start the MCP server on stdin/stdout",
    "  agenc-marketplace-mcp --help     show this help and exit",
    "  agenc-marketplace-mcp --version  print the version and exit",
    "",
    "Environment:",
    "  AGENC_RPC_URL               a getProgramAccounts-capable Solana RPC",
    "  AGENC_MARKETPLACE_CLUSTER   mainnet (default), devnet or localnet; picks the",
    "                              default RPC when AGENC_RPC_URL is unset",
    "  AGENC_INDEXER_URL           optional hosted indexer base URL",
    "  AGENC_INDEXER_API_KEY       optional API key for the hosted indexer",
    "  AGENC_PROGRAM_ADDRESS       override the agenc-coordination program id",
    "  AGENC_MCP_ENABLE_MUTATIONS  1/true/yes/on exposes the keyless prepare_* tools,",
    "                              which build unsigned transactions only",
    "",
  ].join("\n");
}

/**
 * The text to print for an informational flag, or `undefined` when the bin
 * should start the server. Only the first argument is considered, so flags
 * meant for the server are never swallowed.
 */
export function informationalOutput(args: readonly string[]): string | undefined {
  const [first] = args;
  if (first === "--help" || first === "-h") return helpText();
  if (first === "--version" || first === "-v") return `${SERVER_VERSION}\n`;
  return undefined;
}
