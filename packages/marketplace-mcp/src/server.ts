/**
 * The AgenC marketplace MCP server.
 *
 * An open-source, framework-neutral Model Context Protocol server built on the
 * PUBLIC `@tetsuo-ai/marketplace-sdk` + the `@tetsuo-ai/marketplace-tools`
 * registry. It exposes the marketplace discovery/inspection/track-record tools
 * over MCP so any MCP-capable agent runtime can find and vet AgenC listings,
 * tasks, and agents.
 *
 * ## Security posture (read this)
 *
 * - **READONLY BY DEFAULT.** A fresh server exposes ONLY the readonly tools
 *   (`list_listings`, `get_listing`, `list_open_tasks`, `get_task`,
 *   `get_agent_track_record`, `search`). They read public on-chain state and
 *   return JSON; they never mutate anything.
 * - **KEYLESS, ALWAYS.** The process holds NO private key, loads NO wallet, and
 *   NEVER signs or broadcasts a transaction. There is no code path here that
 *   can move funds.
 * - **MUTATIONS ARE OPT-IN AND STILL KEYLESS.** When
 *   `AGENC_MCP_ENABLE_MUTATIONS=1` (or {@link CreateMcpServerOptions.enableMutations}),
 *   the `prepare_*` tools are added. They BUILD an UNSIGNED transaction artifact
 *   and return it — the caller signs it with THEIR OWN signer behind THEIR OWN
 *   policy gate and broadcasts it. This mirrors the AgenC kit's signer-local,
 *   policy-gated philosophy: the server is a tx builder, never a signer.
 *
 * @module server
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  marketplaceTools,
  readonlyTools,
  prepareTools,
  createToolRegistry,
  MarketplaceToolError,
  type MarketplaceTool,
  type MarketplaceToolContext,
  type MarketplaceToolRegistry,
} from "@tetsuo-ai/marketplace-tools";
import { sanitizeDiagnostic } from "./redact.js";

/** This package's name + version, surfaced in the MCP `serverInfo`. */
export const SERVER_NAME = "@tetsuo-ai/marketplace-mcp";
export const SERVER_VERSION = "0.5.0";

/** Options for {@link createMarketplaceMcpServer}. */
export interface CreateMcpServerOptions {
  /**
   * The tool runtime context (read transport + optional indexer/program).
   * Required — the server holds no key, only this readonly/prepare context.
   */
  context: MarketplaceToolContext;
  /**
   * Expose the keyless `prepare_*` (unsigned-mutation) tools. Defaults to
   * `false` — readonly only. Even when `true`, the server never signs or sends.
   */
  enableMutations?: boolean;
  /**
   * Override the tool set entirely (advanced/testing). When provided, this
   * exact list is registered and `enableMutations` is ignored. Defaults to the
   * readonly set (+ prepare set when `enableMutations`).
   */
  tools?: ReadonlyArray<MarketplaceTool>;
}

/** The result of {@link createMarketplaceMcpServer}: the wired MCP server. */
export interface MarketplaceMcpServer {
  /** The low-level MCP {@link Server}; `connect(transport)` to start serving. */
  readonly server: Server;
  /** The exact tool set registered (stable order). */
  readonly tools: ReadonlyArray<MarketplaceTool>;
  /** The `name → tool` registry the CallTool handler dispatches through. */
  readonly registry: MarketplaceToolRegistry;
  /** Whether the keyless prepare tools are exposed. */
  readonly mutationsEnabled: boolean;
}

/**
 * Select the active tool set: readonly always; the prepare tools only when
 * mutations are explicitly enabled.
 */
export function selectTools(
  enableMutations: boolean,
): ReadonlyArray<MarketplaceTool> {
  return enableMutations ? marketplaceTools : readonlyTools;
}

/** Map a {@link MarketplaceTool} to the MCP `Tool` advertised in `tools/list`. */
function toMcpTool(tool: MarketplaceTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    // The JSON-Schema input envelope passes through verbatim — the same single
    // source of truth the OpenAI/LangChain/CrewAI adapters consume.
    inputSchema: tool.inputSchema as unknown as Tool["inputSchema"],
    annotations: {
      // Surface the readonly/prepare posture to MCP clients that honor hints.
      readOnlyHint: tool.kind === "readonly",
      // prepare_* build (but never send) a tx — they are not "open world" and
      // have no side effects on-chain (the artifact is returned to the caller).
      destructiveHint: false,
      openWorldHint: false,
    },
  };
}

/**
 * Build (but do not connect) the AgenC marketplace MCP server.
 *
 * Wires the `tools/list` and `tools/call` handlers against the
 * {@link MarketplaceToolRegistry}, running each handler with the provided
 * keyless {@link MarketplaceToolContext}. Call `result.server.connect(transport)`
 * (e.g. a `StdioServerTransport`) to start serving.
 *
 * @param options - The tool context, the mutation opt-in, and an optional
 * tool-set override.
 * @returns A {@link MarketplaceMcpServer}.
 *
 * @example
 * ```ts
 * import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 * import { createMarketplaceMcpServer } from "@tetsuo-ai/marketplace-mcp";
 *
 * const { server } = createMarketplaceMcpServer({ context });
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function createMarketplaceMcpServer(
  options: CreateMcpServerOptions,
): MarketplaceMcpServer {
  const { context } = options;
  const enableMutations = options.enableMutations ?? false;
  const tools = options.tools ?? selectTools(enableMutations);
  const registry = createToolRegistry(tools);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // tools/list — advertise the active tool set.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(toMcpTool),
  }));

  // tools/call — validate the tool exists, run it against the keyless context,
  // and return its JSON result. A tool that builds an unsigned tx returns the
  // unsigned artifact for the caller to sign — the server never signs.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = registry.get(name);
    if (tool === undefined) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${name}. Available: ${[...registry.keys()].join(", ")}`,
      );
    }
    try {
      const result = await tool.handler(
        (args ?? {}) as Record<string, unknown>,
        context,
      );
      const callResult: CallToolResult = {
        content: [{ type: "text", text: jsonText(result) }],
        // Structured content lets MCP clients consume the typed result directly.
        structuredContent: toStructured(result),
      };
      return callResult;
    } catch (error) {
      return toErrorResult(name, error);
    }
  });

  return { server, tools, registry, mutationsEnabled: enableMutations };
}

/** JSON-stringify a tool result for the text content channel. */
function jsonText(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Wrap a tool result as MCP `structuredContent` (must be a JSON object). Tools
 * return objects (e.g. `{ listings: [...] }`); a non-object is boxed under
 * `{ result }` so the field is always a valid object.
 */
function toStructured(result: unknown): Record<string, unknown> {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { result };
}

/**
 * Turn a handler error into a tool-call error result (isError: true) rather
 * than a protocol error — the model sees the message and can recover. A
 * {@link MarketplaceToolError} carries a stable machine code.
 *
 * The message is sanitized (audit F-8): SDK/client errors can embed the
 * configured RPC/indexer URL verbatim (userinfo, `?api-key=`), which would
 * otherwise reach the MCP client and its logs over the protocol channel.
 * Exported for tests.
 */
export function toErrorResult(toolName: string, error: unknown): CallToolResult {
  const code = error instanceof MarketplaceToolError ? error.code : "TOOL_ERROR";
  const message = sanitizeDiagnostic(
    error instanceof Error ? error.message : String(error),
  );
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { tool: toolName, code, message } }, null, 2),
      },
    ],
  };
}

/** The full tool set (readonly + prepare), re-exported for convenience. */
export { marketplaceTools, readonlyTools, prepareTools };
