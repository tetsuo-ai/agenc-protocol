#!/usr/bin/env node
"use strict";

// src/bin.ts
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");

// src/config.ts
var DEFAULT_RPC_URL = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899"
};
function envFlag(value) {
  if (value === void 0) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
function parseCluster(raw) {
  const v = (raw ?? "mainnet").trim().toLowerCase();
  if (v === "mainnet" || v === "mainnet-beta") return "mainnet";
  if (v === "devnet") return "devnet";
  if (v === "localnet" || v === "local" || v === "localhost") return "localnet";
  throw new Error(
    `AGENC_MARKETPLACE_CLUSTER must be one of mainnet | devnet | localnet (got ${JSON.stringify(raw)})`
  );
}
function resolveMcpConfig(env = process.env) {
  const cluster = parseCluster(env.AGENC_MARKETPLACE_CLUSTER);
  const explicitRpc = env.AGENC_RPC_URL?.trim();
  const rpcUrl = explicitRpc !== void 0 && explicitRpc.length > 0 ? explicitRpc : DEFAULT_RPC_URL[cluster];
  const indexerUrl = env.AGENC_INDEXER_URL?.trim();
  const indexerApiKey = env.AGENC_INDEXER_API_KEY?.trim();
  const programAddress = env.AGENC_PROGRAM_ADDRESS?.trim();
  const config = {
    cluster,
    rpcUrl,
    rpcUrlExplicit: explicitRpc !== void 0 && explicitRpc.length > 0,
    enableMutations: envFlag(env.AGENC_MCP_ENABLE_MUTATIONS)
  };
  if (indexerUrl !== void 0 && indexerUrl.length > 0) {
    config.indexerUrl = indexerUrl;
  }
  if (indexerApiKey !== void 0 && indexerApiKey.length > 0) {
    config.indexerApiKey = indexerApiKey;
  }
  if (programAddress !== void 0 && programAddress.length > 0) {
    config.programAddress = programAddress;
  }
  return config;
}

// src/context.ts
var import_kit = require("@solana/kit");
var import_marketplace_sdk = require("@tetsuo-ai/marketplace-sdk");
function buildToolContext(config) {
  const rpc = (0, import_kit.createSolanaRpc)(config.rpcUrl);
  let indexer;
  if (config.indexerUrl !== void 0) {
    indexer = (0, import_marketplace_sdk.createIndexerClient)({
      baseUrl: config.indexerUrl,
      ...config.indexerApiKey !== void 0 ? { apiKey: config.indexerApiKey } : {}
    });
  }
  const ctx = {
    // The kit RPC is a valid ProgramAccountsSource (the queries layer wraps it).
    read: rpc,
    rpc
  };
  if (indexer !== void 0) ctx.indexer = indexer;
  if (config.programAddress !== void 0) {
    ctx.programAddress = config.programAddress;
  }
  return ctx;
}

// src/server.ts
var import_server = require("@modelcontextprotocol/sdk/server/index.js");
var import_types = require("@modelcontextprotocol/sdk/types.js");
var import_marketplace_tools = require("@tetsuo-ai/marketplace-tools");

// src/redact.ts
function redactUrl(raw) {
  if (raw === void 0 || raw === null || raw === "") return "none";
  try {
    return new URL(raw).origin;
  } catch {
    return "<unparseable-url-redacted>";
  }
}
function* secretCandidates() {
  for (const raw of [process.env.AGENC_RPC_URL, process.env.AGENC_INDEXER_URL]) {
    if (raw === void 0 || raw === "") continue;
    yield { needle: raw, replacement: redactUrl(raw) };
    const trimmed = raw.trim();
    if (trimmed !== raw && trimmed !== "") {
      yield { needle: trimmed, replacement: redactUrl(trimmed) };
    }
  }
  const apiKey = process.env.AGENC_INDEXER_API_KEY;
  if (apiKey !== void 0 && apiKey !== "") {
    yield { needle: apiKey, replacement: "<redacted>" };
    const trimmed = apiKey.trim();
    if (trimmed !== apiKey && trimmed !== "") {
      yield { needle: trimmed, replacement: "<redacted>" };
    }
  }
}
function sanitizeDiagnostic(text) {
  let out = text;
  for (const { needle, replacement } of secretCandidates()) {
    out = out.split(needle).join(replacement);
  }
  return out;
}

// src/server.ts
var SERVER_NAME = "@tetsuo-ai/marketplace-mcp";
var SERVER_VERSION = "0.4.0";
function selectTools(enableMutations) {
  return enableMutations ? import_marketplace_tools.marketplaceTools : import_marketplace_tools.readonlyTools;
}
function toMcpTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    // The JSON-Schema input envelope passes through verbatim — the same single
    // source of truth the OpenAI/LangChain/CrewAI adapters consume.
    inputSchema: tool.inputSchema,
    annotations: {
      // Surface the readonly/prepare posture to MCP clients that honor hints.
      readOnlyHint: tool.kind === "readonly",
      // prepare_* build (but never send) a tx — they are not "open world" and
      // have no side effects on-chain (the artifact is returned to the caller).
      destructiveHint: false,
      openWorldHint: false
    }
  };
}
function createMarketplaceMcpServer(options) {
  const { context } = options;
  const enableMutations = options.enableMutations ?? false;
  const tools = options.tools ?? selectTools(enableMutations);
  const registry = (0, import_marketplace_tools.createToolRegistry)(tools);
  const server = new import_server.Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(import_types.ListToolsRequestSchema, async () => ({
    tools: tools.map(toMcpTool)
  }));
  server.setRequestHandler(import_types.CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = registry.get(name);
    if (tool === void 0) {
      throw new import_types.McpError(
        import_types.ErrorCode.MethodNotFound,
        `Unknown tool: ${name}. Available: ${[...registry.keys()].join(", ")}`
      );
    }
    try {
      const result = await tool.handler(
        args ?? {},
        context
      );
      const callResult = {
        content: [{ type: "text", text: jsonText(result) }],
        // Structured content lets MCP clients consume the typed result directly.
        structuredContent: toStructured(result)
      };
      return callResult;
    } catch (error) {
      return toErrorResult(name, error);
    }
  });
  return { server, tools, registry, mutationsEnabled: enableMutations };
}
function jsonText(result) {
  return JSON.stringify(result, null, 2);
}
function toStructured(result) {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return result;
  }
  return { result };
}
function toErrorResult(toolName, error) {
  const code = error instanceof import_marketplace_tools.MarketplaceToolError ? error.code : "TOOL_ERROR";
  const message = sanitizeDiagnostic(
    error instanceof Error ? error.message : String(error)
  );
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { tool: toolName, code, message } }, null, 2)
      }
    ]
  };
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
  const transport = new import_stdio.StdioServerTransport();
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
