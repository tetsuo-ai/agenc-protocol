#!/usr/bin/env node
import {
  SERVER_NAME,
  SERVER_VERSION,
  buildToolContext,
  createMarketplaceMcpServer,
  redactUrl,
  resolveMcpConfig,
  sanitizeDiagnostic
} from "./chunk-IUEDOILG.js";

// src/bin.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/cli.ts
function helpText() {
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
    ""
  ].join("\n");
}
function informationalOutput(args) {
  const [first] = args;
  if (first === "--help" || first === "-h") return helpText();
  if (first === "--version" || first === "-v") return `${SERVER_VERSION}
`;
  return void 0;
}

// src/bin.ts
async function main() {
  const config = resolveMcpConfig(process.env);
  const context = buildToolContext(config);
  const { server, tools, mutationsEnabled } = createMarketplaceMcpServer({
    context,
    enableMutations: config.enableMutations
  });
  process.stderr.write(
    `[agenc-marketplace-mcp] starting (cluster=${config.cluster}, rpc=${redactUrl(config.rpcUrl)}${config.rpcUrlExplicit ? "" : " [default]"}, indexer=${redactUrl(config.indexerUrl)}, mutations=${mutationsEnabled ? "ENABLED (keyless unsigned-tx builders)" : "off (readonly)"})
`
  );
  process.stderr.write(
    `[agenc-marketplace-mcp] tools: ${tools.map((t) => t.name).join(", ")}
`
  );
  if (!config.rpcUrlExplicit) {
    process.stderr.write(
      "[agenc-marketplace-mcp] note: using the cluster default RPC. Public RPCs often disable getProgramAccounts (the list/search read path). Set AGENC_RPC_URL to a gPA-enabled RPC or AGENC_INDEXER_URL to the hosted scale path for reliable discovery.\n"
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[agenc-marketplace-mcp] connected (stdio)\n");
}
function fatalText(error) {
  return sanitizeDiagnostic(error instanceof Error ? error.stack ?? error.message : String(error));
}
process.on("uncaughtException", (error) => {
  process.stderr.write(`[agenc-marketplace-mcp] fatal(uncaught): ${fatalText(error)}
`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[agenc-marketplace-mcp] fatal(unhandled): ${fatalText(reason)}
`);
  process.exit(1);
});
var informational = informationalOutput(process.argv.slice(2));
if (informational !== void 0) {
  process.stdout.write(informational);
} else {
  main().catch((error) => {
    process.stderr.write(
      `[agenc-marketplace-mcp] fatal: ${fatalText(error)}
`
    );
    process.exitCode = 1;
  });
}
