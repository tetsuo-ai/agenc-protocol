/**
 * Framework adapters — thin shape-transforms over the ONE schema source.
 *
 * Every adapter reads the same {@link MarketplaceTool} list (name, description,
 * inputSchema, handler) and emits the per-framework shape. None of them forks
 * the JSON-Schema body: the `inputSchema` object is passed through verbatim into
 * each framework's parameters/schema slot, so the schemas can never drift.
 *
 * No framework is a hard dependency — each adapter emits the PLAIN object shape
 * the framework accepts (OpenAI `tools` array, LangChain `StructuredTool`-compatible
 * descriptor, CrewAI tool descriptor). The consumer wires them into their runtime.
 *
 * @module adapters
 */
import type {
  JsonSchema,
  MarketplaceTool,
  MarketplaceToolContext,
} from "./types.js";
import { ensureValidatedMarketplaceTool } from "./types.js";

// ===========================================================================
// OpenAI function-calling
// ===========================================================================

/** One OpenAI function-calling tool (the `tools: [...]` array element). */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

/**
 * Adapt tools to the OpenAI Chat Completions / Responses function-calling shape.
 * The `inputSchema` is passed through as `function.parameters` unchanged.
 */
export function toOpenAITools(
  tools: ReadonlyArray<MarketplaceTool>,
): OpenAITool[] {
  return tools.map((candidate) => {
    const tool = ensureValidatedMarketplaceTool(candidate);
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  });
}

// ===========================================================================
// LangChain (StructuredTool-compatible plain shape)
// ===========================================================================

/**
 * A LangChain `StructuredTool`-compatible descriptor. LangChain's
 * `DynamicStructuredTool` / `tool()` accepts `{ name, description, schema, func }`
 * where `schema` is a JSON-Schema object and `func(input)` runs the tool. We emit
 * that plain shape WITHOUT importing `langchain` — the consumer passes it to
 * `new DynamicStructuredTool(descriptor)` (or `tool(func, descriptor)`).
 *
 * `func` closes over the provided {@link MarketplaceToolContext}, so the
 * resulting tool is directly invocable: `await descriptor.func(args)`.
 */
export interface LangChainToolDescriptor {
  name: string;
  description: string;
  /** JSON-Schema for the tool input (LangChain accepts a JSON-Schema `schema`). */
  schema: JsonSchema;
  /** Bound invocation: validate-then-run against the captured context. */
  func: (input: Record<string, unknown>) => Promise<string>;
}

/**
 * Adapt tools to the LangChain StructuredTool-compatible shape, binding each
 * tool's handler to `ctx`. LangChain tools return a string, so the result is
 * JSON-stringified (LangChain stringifies non-string returns anyway).
 */
export function toLangChainTools(
  tools: ReadonlyArray<MarketplaceTool>,
  ctx: MarketplaceToolContext,
): LangChainToolDescriptor[] {
  return tools.map((candidate) => {
    const tool = ensureValidatedMarketplaceTool(candidate);
    return {
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema,
      func: async (input: Record<string, unknown>) => {
        const result = await tool.handler(input, ctx);
        return typeof result === "string" ? result : JSON.stringify(result);
      },
    };
  });
}

// ===========================================================================
// CrewAI (BaseTool-compatible plain shape)
// ===========================================================================

/**
 * A CrewAI tool descriptor. CrewAI's `BaseTool` is `{ name, description,
 * args_schema, run/_run }`. We emit the plain shape WITHOUT importing crewai —
 * the consumer builds a `StructuredTool`/`Tool` from it. `run` is bound to `ctx`.
 */
export interface CrewAIToolDescriptor {
  name: string;
  description: string;
  /** JSON-Schema for the tool args (CrewAI accepts a JSON-Schema `args_schema`). */
  args_schema: JsonSchema;
  /** Bound invocation returning a string result. */
  run: (input: Record<string, unknown>) => Promise<string>;
}

/**
 * Adapt tools to the CrewAI tool-descriptor shape, binding each handler to `ctx`.
 */
export function toCrewAITools(
  tools: ReadonlyArray<MarketplaceTool>,
  ctx: MarketplaceToolContext,
): CrewAIToolDescriptor[] {
  return tools.map((candidate) => {
    const tool = ensureValidatedMarketplaceTool(candidate);
    return {
      name: tool.name,
      description: tool.description,
      args_schema: tool.inputSchema,
      run: async (input: Record<string, unknown>) => {
        const result = await tool.handler(input, ctx);
        return typeof result === "string" ? result : JSON.stringify(result);
      },
    };
  });
}
