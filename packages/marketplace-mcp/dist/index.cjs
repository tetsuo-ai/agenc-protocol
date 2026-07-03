"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  DEFAULT_RPC_URL: () => DEFAULT_RPC_URL,
  SERVER_NAME: () => SERVER_NAME,
  SERVER_VERSION: () => SERVER_VERSION,
  buildToolContext: () => buildToolContext,
  createMarketplaceMcpServer: () => createMarketplaceMcpServer,
  envFlag: () => envFlag,
  marketplaceTools: () => import_marketplace_tools.marketplaceTools,
  prepareTools: () => import_marketplace_tools.prepareTools,
  readonlyTools: () => import_marketplace_tools.readonlyTools,
  resolveMcpConfig: () => resolveMcpConfig,
  selectTools: () => selectTools
});
module.exports = __toCommonJS(src_exports);

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
  const message = error instanceof Error ? error.message : String(error);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_RPC_URL,
  SERVER_NAME,
  SERVER_VERSION,
  buildToolContext,
  createMarketplaceMcpServer,
  envFlag,
  marketplaceTools,
  prepareTools,
  readonlyTools,
  resolveMcpConfig,
  selectTools
});
