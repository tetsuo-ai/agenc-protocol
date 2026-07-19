/**
 * The tool registry — the single source of truth consumed by the MCP server
 * (P5.1) and the framework adapters.
 *
 * @module tools
 */
import {
  ensureValidatedMarketplaceTool,
  type MarketplaceTool,
  type MarketplaceToolRegistry,
} from "../types.js";
import { readonlyTools } from "./readonly.js";
import { prepareTools } from "./prepare.js";

export { readonlyTools } from "./readonly.js";
export { prepareTools } from "./prepare.js";

/**
 * Every marketplace tool, in stable order: the readonly discovery/inspection
 * tools first, then the mutation-PREPARE tools.
 */
export const marketplaceTools: ReadonlyArray<MarketplaceTool> = [
  ...readonlyTools,
  ...prepareTools,
];

/** Build an immutable `name → tool` registry from a tool list. */
export function createToolRegistry(
  tools: ReadonlyArray<MarketplaceTool> = marketplaceTools,
): MarketplaceToolRegistry {
  const map = new Map<string, MarketplaceTool>();
  for (const candidate of tools) {
    const tool = ensureValidatedMarketplaceTool(candidate);
    if (map.has(tool.name)) {
      throw new Error(`Duplicate marketplace tool name: ${tool.name}`);
    }
    map.set(tool.name, tool);
  }
  return map;
}

/** The default registry over {@link marketplaceTools}. */
export const marketplaceToolRegistry: MarketplaceToolRegistry =
  createToolRegistry();

/** Look up a tool by name in the default registry (or a provided one). */
export function getTool(
  name: string,
  registry: MarketplaceToolRegistry = marketplaceToolRegistry,
): MarketplaceTool | undefined {
  return registry.get(name);
}
