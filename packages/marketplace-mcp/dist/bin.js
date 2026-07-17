#!/usr/bin/env node
import {
  buildToolContext,
  createMarketplaceMcpServer,
  resolveMcpConfig
} from "./chunk-GUITTOSW.js";

// src/bin.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
function redactUrl(raw) {
  if (raw === void 0 || raw === null || raw === "") return "none";
  try {
    return new URL(raw).origin;
  } catch {
    return "<unparseable-url-redacted>";
  }
}
function sanitizeDiagnostic(text) {
  let out = text;
  for (const raw of [process.env.AGENC_RPC_URL, process.env.AGENC_INDEXER_URL]) {
    if (raw !== void 0 && raw !== "") out = out.split(raw).join(redactUrl(raw));
  }
  const apiKey = process.env.AGENC_INDEXER_API_KEY;
  if (apiKey !== void 0 && apiKey !== "") out = out.split(apiKey).join("<redacted>");
  return out;
}
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
main().catch((error) => {
  const text = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(
    `[agenc-marketplace-mcp] fatal: ${sanitizeDiagnostic(text)}
`
  );
  process.exitCode = 1;
});
