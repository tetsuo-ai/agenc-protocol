/**
 * `@tetsuo-ai/marketplace-tools` — framework-neutral AgenC marketplace tool
 * definitions for AI agents (PLAN.md P5.2 + the P5.4 A2A AgentCard surface).
 *
 * The ONE source of truth: a registry of {@link MarketplaceTool}s, each carrying
 * a `name`, a JSON-Schema `inputSchema`, a `description`, and a
 * `handler(args, ctx)`. Readonly discovery/inspection tools work with just a
 * read transport; the mutation-PREPARE tools build an UNSIGNED instruction via
 * the SDK facade and return it (they never sign or send).
 *
 * Thin adapters re-shape the same registry for OpenAI function-calling,
 * LangChain, and CrewAI — they never fork the schemas.
 *
 * Built on the PUBLIC `@tetsuo-ai/marketplace-sdk` (clean-room; no EULA kit code).
 *
 * @example Readonly discovery over a kit RPC
 * ```ts
 * import { createSolanaRpc } from "@solana/kit";
 * import { getTool, type MarketplaceToolContext } from "@tetsuo-ai/marketplace-tools";
 *
 * const rpc = createSolanaRpc("https://your-gpa-enabled-rpc");
 * const ctx: MarketplaceToolContext = { read: rpc, rpc };
 * const out = await getTool("list_listings")!.handler({ category: "code-generation" }, ctx);
 * ```
 *
 * @example OpenAI function-calling
 * ```ts
 * import { marketplaceTools, toOpenAITools } from "@tetsuo-ai/marketplace-tools";
 * const tools = toOpenAITools(marketplaceTools);
 * ```
 *
 * @module
 */

// --- P5.2 tool registry, context, projections, adapters -------------------
export {
  type JsonSchema,
  type JsonSchemaProperty,
  type MarketplaceTool,
  type MarketplaceToolContext,
  type MarketplaceToolRegistry,
  type KitRpcLike,
  MarketplaceToolError,
} from "./types.js";

export {
  marketplaceTools,
  readonlyTools,
  prepareTools,
  marketplaceToolRegistry,
  createToolRegistry,
  getTool,
} from "./tools/index.js";

export {
  type ListingView,
  type TaskView,
  type UnsignedInstructionView,
  type BuiltInstructionLike,
  projectListing,
  projectTask,
  projectInstruction,
  toHex,
} from "./project.js";

export {
  type OpenAITool,
  type LangChainToolDescriptor,
  type CrewAIToolDescriptor,
  toOpenAITools,
  toLangChainTools,
  toCrewAITools,
} from "./adapters.js";

// --- P5.4 A2A AgentCard discovery surface (owned by the P5.4 agent) --------
export {
  listingToAgentCard,
  indexerListingToAgentCard,
  buildAgentCardManifest,
  AGENT_CARD_SCHEMA_VERSION,
  A2A_SCHEMA_VERSION,
  type AgentCard,
  type AgentCardPrice,
  type AgentCardCapabilities,
  type AgentCardTrust,
  type AgentCardHire,
  type AgentCardA2A,
  type AgentCardManifest,
  type ListingToAgentCardOptions,
  type BuildAgentCardManifestOptions,
} from "./agent-card.js";
