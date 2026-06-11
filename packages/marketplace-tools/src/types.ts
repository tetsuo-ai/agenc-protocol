/**
 * Core tool contract — the framework-neutral source of truth.
 *
 * A {@link MarketplaceTool} is a self-describing unit: a stable `name`, a
 * JSON-Schema `inputSchema`, a human/agent-readable `description`, and an async
 * `handler(args, ctx)`. The SCHEMA is the single source of truth; the framework
 * adapters ({@link ../adapters} `toOpenAITools` / `toLangChainTools` /
 * `toCrewAITools`) are thin shape-transforms over the same registry — they never
 * fork the schema.
 *
 * @module types
 */
import type { Address } from "@solana/kit";
import type {
  ProgramAccountsSource,
  ProgramAccountsTransport,
  IndexerClient,
} from "@tetsuo-ai/marketplace-sdk";

/**
 * A minimal JSON-Schema object (draft 2020-12 subset) describing a tool's
 * input. Deliberately a plain structural type so it serializes byte-for-byte
 * into every framework's function-calling contract (OpenAI `parameters`,
 * LangChain `schema`, CrewAI `args_schema`) with no transform of the schema
 * body itself.
 */
export interface JsonSchema {
  /** Always `"object"` for a tool input envelope. */
  type: "object";
  /** Property name → property schema. */
  properties: Record<string, JsonSchemaProperty>;
  /** Names of required properties. */
  required?: string[];
  /** Whether properties beyond `properties` are allowed (default: false). */
  additionalProperties?: boolean;
  /** Optional human description of the whole object. */
  description?: string;
}

/** One property in a {@link JsonSchema}. */
export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  /** For `type: "array"`. */
  items?: JsonSchemaProperty;
  /** Enumerated allowed values. */
  enum?: readonly (string | number)[];
  /** Minimum (numeric). */
  minimum?: number;
  /** Maximum (numeric). */
  maximum?: number;
  /** Default value surfaced to the model. */
  default?: unknown;
  /** Nested object properties (for `type: "object"`). */
  properties?: Record<string, JsonSchemaProperty>;
  /** Required nested props (for `type: "object"`). */
  required?: string[];
  /** Example value. */
  examples?: readonly unknown[];
}

/**
 * The runtime context every tool handler receives.
 *
 * Readonly discovery/inspection tools need only a {@link ProgramAccountsSource}
 * `read` transport (a `@solana/kit` RPC or any
 * {@link ProgramAccountsTransport}, e.g. the hosted indexer client). The
 * mutation-PREPARE tools additionally need either the same `read` source
 * (for account-existence reads) and produce an UNSIGNED instruction via the
 * SDK facade — they NEVER hold a key, sign, or broadcast.
 *
 * An optional {@link IndexerClient} `indexer` unlocks the richer hosted read
 * model (track-record, paged listings, server-built hire transactions) when
 * present; tools degrade to the trustless gPA path when it is absent.
 */
export interface MarketplaceToolContext {
  /**
   * The read transport: a kit `Rpc<GetProgramAccountsApi>` or any
   * {@link ProgramAccountsTransport}. Required by every readonly tool and by
   * the prepare-* tools (which read account state to build instructions).
   */
  read: ProgramAccountsSource;
  /**
   * A kit RPC used for single-account fetches (`fetchMaybeTask` etc.) and as
   * the source for facade async instruction builders that auto-derive PDAs.
   * When omitted, tools that need a single-account read fall back to `read`
   * if it is itself a kit RPC, otherwise they throw a typed error.
   */
  rpc?: KitRpcLike;
  /**
   * Optional hosted indexer client (the scale read path + no-RPC tx builder).
   * When present, `get_agent_track_record` and `search` use it; `prepare_hire`
   * can build the hire transaction server-side instead of locally.
   */
  indexer?: IndexerClient;
  /**
   * The agenc-coordination program address. Defaults to the canonical mainnet/
   * devnet/localnet program id when omitted.
   */
  programAddress?: Address;
}

/**
 * A `@solana/kit` RPC object surface used for single-account fetches and as the
 * driver for facade async instruction builders. Kept structural so callers are
 * not forced to import the full kit `Rpc` generic. Derived from the SDK
 * `facade.getAgentTrackRecord`'s first parameter (anything `fetchEncodedAccount`
 * accepts).
 */
export type KitRpcLike = Parameters<
  typeof import("@tetsuo-ai/marketplace-sdk").facade.getAgentTrackRecord
>[0];

/**
 * A framework-neutral marketplace tool. The schema is the source of truth; the
 * adapters never re-author it.
 *
 * @typeParam TArgs - the validated argument shape the handler receives.
 * @typeParam TResult - the handler's return value (JSON-serializable).
 */
export interface MarketplaceTool<
  TArgs = Record<string, unknown>,
  TResult = unknown,
> {
  /** Stable, namespaced tool name (e.g. `"list_listings"`). */
  readonly name: string;
  /** One-paragraph description for the model. */
  readonly description: string;
  /** JSON-Schema for the tool's input object. */
  readonly inputSchema: JsonSchema;
  /**
   * Whether this tool mutates anything. Discovery/inspection tools are
   * `"readonly"`; the prepare-* tools are `"prepare"` — they BUILD an unsigned
   * instruction/transaction and return it, but still never sign or send.
   * There is intentionally no `"mutate"` kind in this public package: signing
   * and broadcasting are the consumer's responsibility, behind their own
   * policy gate.
   */
  readonly kind: "readonly" | "prepare";
  /**
   * Execute the tool. `args` is the parsed input (callers SHOULD validate
   * against `inputSchema` first; handlers also defend their own invariants).
   */
  handler(args: TArgs, ctx: MarketplaceToolContext): Promise<TResult>;
}

/** An immutable registry: tool name → tool. */
export type MarketplaceToolRegistry = ReadonlyMap<string, MarketplaceTool>;

/**
 * Define a tool with a strongly-typed argument shape, returning it widened to
 * the registry's `MarketplaceTool` element type. This keeps each handler's
 * `args` precisely typed at the definition site while letting the tools live in
 * a homogeneous `MarketplaceTool[]` registry (TypeScript treats the handler's
 * parameter contravariantly, so a narrower `TArgs` is not assignable to the
 * default `Record<string, unknown>` without this seam).
 */
export function defineTool<TArgs, TResult>(
  tool: MarketplaceTool<TArgs, TResult>,
): MarketplaceTool {
  return tool as unknown as MarketplaceTool;
}

/** Error thrown when a tool is misconfigured or its context is insufficient. */
export class MarketplaceToolError extends Error {
  /** Stable machine code. */
  readonly code: string;
  /** The tool that raised it (when known). */
  readonly tool?: string;
  constructor(code: string, message: string, tool?: string) {
    super(message);
    this.name = "MarketplaceToolError";
    this.code = code;
    if (tool !== undefined) this.tool = tool;
  }
}
