#!/usr/bin/env node
/**
 * `npx @tetsuo-ai/marketplace-mcp` — boot the AgenC marketplace MCP server over
 * stdio.
 *
 * Reads its entire posture from the environment (see {@link resolveMcpConfig}):
 * the read RPC / cluster, an optional hosted indexer, and the
 * `AGENC_MCP_ENABLE_MUTATIONS` opt-in. KEYLESS — it never loads a wallet,
 * signs, or broadcasts. Mutations, when enabled, only BUILD unsigned txs.
 *
 * @module bin
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveMcpConfig } from "./config.js";
import { buildToolContext } from "./context.js";
import { createMarketplaceMcpServer } from "./server.js";
import { redactUrl, sanitizeDiagnostic } from "./redact.js";

async function main(): Promise<void> {
  const config = resolveMcpConfig(process.env);
  const context = buildToolContext(config);
  const { server, tools, mutationsEnabled } = createMarketplaceMcpServer({
    context,
    enableMutations: config.enableMutations,
  });

  // Diagnostics go to STDERR ONLY — STDOUT is the JSON-RPC channel and must
  // carry nothing but protocol frames.
  // NOTE: rpc/indexer URLs are redacted to their origin — an AGENC_RPC_URL or
  // AGENC_INDEXER_URL may embed a provider API key, which must never hit a log file.
  process.stderr.write(
    `[agenc-marketplace-mcp] starting (cluster=${config.cluster}, ` +
      `rpc=${redactUrl(config.rpcUrl)}${config.rpcUrlExplicit ? "" : " [default]"}, ` +
      `indexer=${redactUrl(config.indexerUrl)}, ` +
      `mutations=${mutationsEnabled ? "ENABLED (keyless unsigned-tx builders)" : "off (readonly)"})\n`,
  );
  process.stderr.write(
    `[agenc-marketplace-mcp] tools: ${tools.map((t) => t.name).join(", ")}\n`,
  );
  if (!config.rpcUrlExplicit) {
    process.stderr.write(
      "[agenc-marketplace-mcp] note: using the cluster default RPC. Public RPCs " +
        "often disable getProgramAccounts (the list/search read path). Set " +
        "AGENC_RPC_URL to a gPA-enabled RPC or AGENC_INDEXER_URL to the hosted " +
        "scale path for reliable discovery.\n",
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[agenc-marketplace-mcp] connected (stdio)\n");
}

// Process-level crash paths MUST go through the same sanitizer as the fatal
// handler — Node's default crash print would bypass it entirely (audit F-8).
function fatalText(error: unknown): string {
  return sanitizeDiagnostic(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

process.on("uncaughtException", (error: unknown) => {
  process.stderr.write(`[agenc-marketplace-mcp] fatal(uncaught): ${fatalText(error)}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason: unknown) => {
  process.stderr.write(`[agenc-marketplace-mcp] fatal(unhandled): ${fatalText(reason)}\n`);
  process.exit(1);
});

main().catch((error: unknown) => {
  // Sanitized: provider/client errors can embed the full request URL (userinfo,
  // query-string API keys) in their message/stack — never print those raw.
  process.stderr.write(
    `[agenc-marketplace-mcp] fatal: ${fatalText(error)}\n`,
  );
  process.exitCode = 1;
});
