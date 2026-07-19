#!/usr/bin/env node
import {
  buildToolContext,
  createMarketplaceMcpServer,
  redactUrl,
  resolveMcpConfig,
  sanitizeDiagnostic
} from "./chunk-5ALOKID7.js";

// src/bin.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
main().catch((error) => {
  process.stderr.write(
    `[agenc-marketplace-mcp] fatal: ${fatalText(error)}
`
  );
  process.exitCode = 1;
});
