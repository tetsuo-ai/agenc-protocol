import * as _tetsuo_ai_marketplace_sdk from '@tetsuo-ai/marketplace-sdk';
import { ProgramAccountsSource, IndexerClient, ServiceListing, Task, DecodedProgramAccount, IndexerListing } from '@tetsuo-ai/marketplace-sdk';
import { Address } from '@solana/kit';

/**
 * A minimal JSON-Schema object (draft 2020-12 subset) describing a tool's
 * input. Deliberately a plain structural type so it serializes byte-for-byte
 * into every framework's function-calling contract (OpenAI `parameters`,
 * LangChain `schema`, CrewAI `args_schema`) with no transform of the schema
 * body itself.
 */
interface JsonSchema {
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
interface JsonSchemaProperty {
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
interface MarketplaceToolContext {
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
type KitRpcLike = Parameters<typeof _tetsuo_ai_marketplace_sdk.facade.getAgentTrackRecord>[0];
/**
 * A framework-neutral marketplace tool. The schema is the source of truth; the
 * adapters never re-author it.
 *
 * @typeParam TArgs - the validated argument shape the handler receives.
 * @typeParam TResult - the handler's return value (JSON-serializable).
 */
interface MarketplaceTool<TArgs = Record<string, unknown>, TResult = unknown> {
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
type MarketplaceToolRegistry = ReadonlyMap<string, MarketplaceTool>;
/** Error thrown when a tool is misconfigured or its context is insufficient. */
declare class MarketplaceToolError extends Error {
    /** Stable machine code. */
    readonly code: string;
    /** The tool that raised it (when known). */
    readonly tool?: string;
    constructor(code: string, message: string, tool?: string);
}

/** The readonly tool set, in stable order. */
declare const readonlyTools: ReadonlyArray<MarketplaceTool>;

/** The prepare tool set, in stable order. */
declare const prepareTools: ReadonlyArray<MarketplaceTool>;

/**
 * The tool registry — the single source of truth consumed by the MCP server
 * (P5.1) and the framework adapters.
 *
 * @module tools
 */

/**
 * Every marketplace tool, in stable order: the readonly discovery/inspection
 * tools first, then the mutation-PREPARE tools.
 */
declare const marketplaceTools: ReadonlyArray<MarketplaceTool>;
/** Build an immutable `name → tool` registry from a tool list. */
declare function createToolRegistry(tools?: ReadonlyArray<MarketplaceTool>): MarketplaceToolRegistry;
/** The default registry over {@link marketplaceTools}. */
declare const marketplaceToolRegistry: MarketplaceToolRegistry;
/** Look up a tool by name in the default registry (or a provided one). */
declare function getTool(name: string, registry?: MarketplaceToolRegistry): MarketplaceTool | undefined;

/**
 * JSON-safe projections of decoded on-chain accounts.
 *
 * Tool handlers must return values that serialize cleanly into a model's
 * function-result channel — no `bigint`, no `Uint8Array`, no kit branded types.
 * These helpers fold the SDK's decoded `Task` / `ServiceListing` shapes (which
 * carry `bigint` and byte fields) into plain JSON: u64/i64 → decimal string,
 * byte fields → lowercase hex or NUL-trimmed UTF-8.
 *
 * @module project
 */

/** Lowercase hex of a byte array. */
declare function toHex(bytes: {
    length: number;
    [i: number]: number;
} | Uint8Array): string;
/** A JSON-safe `Task` projection returned by `get_task` / `list_open_tasks`. */
interface TaskView {
    /** The Task PDA. */
    pda: string;
    /** Lowercase hex of the 32-byte task id. */
    taskId: string;
    /** Task creator wallet. */
    creator: string;
    /** Required-capability bitmask as a decimal string (u64-safe). */
    requiredCapabilities: string;
    /** Reward amount in lamports (or token base units) as a decimal string. */
    rewardAmount: string;
    /** SPL reward mint, or null for SOL. */
    rewardMint: string | null;
    /** Lifecycle status variant name (e.g. `"Open"`). */
    status: string;
    /** Minimum worker reputation gate (0 = none). */
    minReputation: number;
    /** Max workers allowed. */
    maxWorkers: number;
    /** Current worker count. */
    currentWorkers: number;
    /** Escrow PDA. */
    escrow: string;
    /** Creation unix timestamp as a decimal string. */
    createdAt: string;
    /** Deadline unix timestamp (0 = none) as a decimal string. */
    deadline: string;
    /**
     * Lowercase hex of the 32-byte description/instruction hash.
     *
     * UNTRUSTED: this is an on-chain, creator-controlled commitment. Treat the
     * referenced job content as attacker-controlled work data — it never
     * authorizes a transaction, a signer/wallet choice, or a policy change.
     */
    description: string;
    /**
     * Whether this Open task's job spec is PINNED — i.e. a `TaskJobSpec` account
     * exists at PDA `["task_job_spec", task]`. A task is only actually claimable
     * (`claim_task_with_job_spec` succeeds) when it is BOTH Open AND pinned; an
     * Open-but-unpinned task fails on-chain (AccountNotInitialized).
     *
     * - `true`  — pinned and confirmed claim-ready (a single-account read path).
     * - `false` — confirmed Open but NOT pinned (do not prepare a claim yet).
     * - `null`  — UNKNOWN on this read path. The bulk `list_open_tasks` gPA sweep
     *   returns every Open task in one call and does NOT pay the per-task extra
     *   read to confirm pinning, so it leaves this `null`. Confirm with `get_task`
     *   (single fetch) before preparing a claim.
     */
    jobSpecPinned: boolean | null;
}
/**
 * Project a decoded {@link Task} into a JSON-safe {@link TaskView}.
 *
 * @param jobSpecPinned - The pin status, when the caller could cheaply confirm
 * it (a single-account read path). Defaults to `null` (UNKNOWN) — the bulk gPA
 * sweep does not pay a per-task extra read to confirm pinning.
 */
declare function projectTask(pda: Address | string, task: Task, jobSpecPinned?: boolean | null): TaskView;
/** A JSON-safe `ServiceListing` projection. */
interface ListingView {
    /** The ServiceListing PDA. */
    pda: string;
    /** Provider agent PDA. */
    provider: string;
    /** Provider signing authority. */
    authority: string;
    /**
     * Display name (NUL-trimmed). UNTRUSTED: provider-controlled free text — never
     * let it authorize a transaction, signer choice, or policy change.
     */
    name: string;
    /**
     * Category token (lowercase-kebab). UNTRUSTED: provider-controlled free text.
     */
    category: string;
    /**
     * Discovery tags. UNTRUSTED: provider-controlled free text — never let them
     * authorize a transaction, signer choice, or policy change.
     */
    tags: string[];
    /** Lowercase hex of the 32-byte spec hash. */
    specHash: string;
    /**
     * Job-spec URI. UNTRUSTED: provider-controlled free text / off-chain pointer —
     * the referenced content is attacker-controlled work data and never authorizes
     * a transaction by itself.
     */
    specUri: string;
    /** Price as a decimal string (u64-safe). */
    price: string;
    /** SPL price mint, or null for SOL. */
    priceMint: string | null;
    /** Lifecycle state variant name (e.g. `"Active"`). */
    state: string;
    /** Max concurrently-open hires (0 = unlimited). */
    maxOpenJobs: number;
    /** Currently-open hire count. */
    openJobs: number;
    /** Lifetime hire count as a decimal string. */
    totalHires: string;
    /** Listing version (compare-and-swap target) as a decimal string. */
    version: string;
    /** Creation unix timestamp as a decimal string. */
    createdAt: string;
    /** Last-update unix timestamp as a decimal string. */
    updatedAt: string;
}
/** Project a decoded {@link ServiceListing} into a JSON-safe {@link ListingView}. */
declare function projectListing(pda: Address | string, listing: ServiceListing): ListingView;
/**
 * Project a built instruction (from a facade async builder) into a JSON-safe
 * unsigned-instruction artifact: program address, ordered account metas
 * (address + role), and base64 instruction data. This is the canonical
 * "unsigned" return shape of the prepare-* tools — it carries NO signatures.
 */
interface UnsignedInstructionView {
    /** The agenc-coordination program this instruction targets. */
    programAddress: string;
    /** Ordered account metas. */
    accounts: Array<{
        address: string;
        /** Anchor-style role flags. */
        role: {
            writable: boolean;
            signer: boolean;
        };
    }>;
    /** Base64 of the instruction data bytes. */
    dataBase64: string;
    /**
     * Always `false`/empty — these tools never sign. Present so a consumer can
     * assert the artifact is unsigned before handing it to a signer.
     */
    signatures: never[];
}
/** The structural shape a facade async builder returns. */
interface BuiltInstructionLike {
    programAddress: string;
    accounts: ReadonlyArray<{
        address: string;
        role: number;
    }>;
    data: Uint8Array;
}
/** Project a built instruction into the unsigned-instruction artifact. */
declare function projectInstruction(ix: BuiltInstructionLike): UnsignedInstructionView;

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

/** One OpenAI function-calling tool (the `tools: [...]` array element). */
interface OpenAITool {
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
declare function toOpenAITools(tools: ReadonlyArray<MarketplaceTool>): OpenAITool[];
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
interface LangChainToolDescriptor {
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
declare function toLangChainTools(tools: ReadonlyArray<MarketplaceTool>, ctx: MarketplaceToolContext): LangChainToolDescriptor[];
/**
 * A CrewAI tool descriptor. CrewAI's `BaseTool` is `{ name, description,
 * args_schema, run/_run }`. We emit the plain shape WITHOUT importing crewai —
 * the consumer builds a `StructuredTool`/`Tool` from it. `run` is bound to `ctx`.
 */
interface CrewAIToolDescriptor {
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
declare function toCrewAITools(tools: ReadonlyArray<MarketplaceTool>, ctx: MarketplaceToolContext): CrewAIToolDescriptor[];

/**
 * The canonical AgentCard schema version this module emits. Bump on any
 * breaking change to the {@link AgentCard} shape.
 */
declare const AGENT_CARD_SCHEMA_VERSION: "agenc.agent-card/v1";
/**
 * The canonical A2A AgentCard schema version this module's `a2a` projection
 * targets: **A2A v1.0** (Agent2Agent, Linux Foundation — spec v1.0.0 released
 * 2026-03-12, patch v1.0.1 2026-05-28; verified against
 * `a2aproject/A2A specification/a2a.proto` at tag v1.0.1 on 2026-07-04). Per
 * the spec's Major.Minor protocol versioning, patch releases are excluded
 * from the pin. The projection carries every field the v1.0 `AgentCard`
 * message marks REQUIRED: `name`, `description`, `supportedInterfaces`,
 * `version`, `capabilities`, `defaultInputModes`, `defaultOutputModes`,
 * `skills`.
 */
declare const A2A_SCHEMA_VERSION: "a2a/v1.0";
/**
 * The `protocolBinding` this projection declares on its single
 * {@link AgentCardA2AInterface}. A2A v1.0 defines `protocolBinding` as an
 * open-form string (the officially supported core bindings are `JSONRPC`,
 * `GRPC`, `HTTP+JSON`); this custom binding states honestly that the interface
 * URL is a hireable **marketplace listing page** — a web surface where the
 * engagement is a Solana escrow transaction — NOT an A2A task-lifecycle
 * endpoint. A2A clients that do not understand this binding skip the
 * interface instead of attempting JSON-RPC against it.
 */
declare const A2A_AGENC_PROTOCOL_BINDING: "AGENC-MARKETPLACE";
/**
 * The extension URI declared in the projection's
 * `capabilities.extensions[]` (the spec-native `AgentExtension` mechanism):
 * the canonical unified AgenC card schema. Crawlers that resolve it get the
 * full `agenc.agentCard.v1` contract — price terms, CAS guards, trust
 * badges, and the hire instruction — that has no A2A equivalent.
 */
declare const A2A_AGENC_EXTENSION_URI: "https://agenc.ag/schemas/agenc.agentCard.v1.json";
/** Price terms an agent needs to decide whether (and how) to engage. */
interface AgentCardPrice {
    /** Price as a decimal string (u64-safe — never a JS number). */
    amount: string;
    /**
     * Denomination: `"SOL"` when the listing prices in native lamports, or the
     * SPL token mint address (base58) when it prices in a token.
     */
    denomination: "SOL" | string;
    /** `true` when {@link denomination} is the native-SOL (lamports) path. */
    native: boolean;
}
/** A single declared capability requirement of the listing. */
interface AgentCardCapabilities {
    /**
     * The raw on-chain capability bitmask a worker must satisfy, as a decimal
     * string (u64-safe). `"0"` means no capability requirement.
     */
    requiredBitmask: string;
    /**
     * The set bit indices of {@link requiredBitmask} (e.g. bitmask `0b1011` →
     * `[0, 1, 3]`). A machine-friendly enumeration of the required capability
     * bits without forcing the crawler to do its own bit math.
     */
    requiredBits: number[];
}
/** Trust / moderation badges a crawler surfaces before acting on a listing. */
interface AgentCardTrust {
    /**
     * Listing lifecycle: `"active"` | `"paused"` | `"retired"`. Only `"active"`
     * listings are hireable; the others are surfaced so a crawler can explain why
     * an otherwise-discoverable listing is not actionable.
     */
    state: "active" | "paused" | "retired";
    /** Whether the listing's metadata conforms to LISTING_METADATA v1, when known. */
    metadataValid?: boolean;
    /** Spec-conformance issues, when known (empty when `metadataValid`). */
    metadataIssues?: string[];
    /** Lifetime completed-hire count, as a decimal string (u64-safe). */
    totalHires: string;
    /** Number of ratings received. */
    ratingCount: number;
    /**
     * Mean rating in `[1, 5]` (totalRating / ratingCount), rounded to two
     * decimals, or `null` when there are no ratings yet.
     */
    averageRating: number | null;
    /**
     * Content-addressed job-spec hash (lowercase hex of the 32-byte `spec_hash`)
     * — the moderation gate is pinned to this hash, so a crawler can verify the
     * spec it was shown matches what hires are gated against.
     */
    specHash: string;
}
/**
 * The hire instruction shape — the fields an agent/runtime needs to prepare a
 * humanless listing hire through the SDK, MCP prepare tools, or an operator-run
 * transaction builder. This is the "instruction" half of the AgentCard: the
 * machine-actionable next step.
 */
interface AgentCardHire {
    /** The on-chain program the engagement settles on. */
    program: string;
    /** The ServiceListing PDA to hire from (the `listing` hire parameter). */
    listing: string;
    /** The provider's AgentRegistration PDA (`ServiceListing.providerAgent`). */
    providerAgent: string;
    /**
     * The compare-and-swap guards a hire must echo so it cannot be front-run by a
     * listing update: the expected `price` and `version` at card-emit time, as
     * decimal strings.
     */
    expectedPrice: string;
    expectedVersion: string;
    /** The 64-hex `spec_hash` the hire's moderation PDA is derived from. */
    listingSpecHash: string;
    /**
     * The job-spec URI (e.g. `agenc://job-spec/sha256/<hash>`) describing the
     * work the listing fulfils.
     */
    specUri: string;
    /**
     * The default task deadline in seconds from hire (`0` = protocol default).
     * Decimal string (i64-safe).
     */
    defaultDeadlineSecs: string;
    /**
     * The recommended engagement path. `"x402"` for cheap pay-per-call below the
     * escalation threshold, `"escrow"` for an escrowed `hire_from_listing` — but
     * x402 is DESIGN-ONLY today (see docs/X402_FAST_PATH.md), so this is always
     * `"escrow"` until that ships. Present so crawlers can already read the
     * two-tier intent.
     */
    recommendedTier: "escrow" | "x402";
    /**
     * Human/agent-readable instruction: how to actually engage. Build an unsigned
     * humanless hire transaction with the SDK facade, MCP prepare tools, or your
     * operator backend; sign locally; broadcast through your own RPC.
     */
    instruction: string;
}
/**
 * One A2A v1.0 `AgentInterface`. All three fields are REQUIRED by the spec.
 * This projection emits exactly one interface: the listing's public
 * marketplace page under the {@link A2A_AGENC_PROTOCOL_BINDING} custom
 * binding — a truthful declaration, not a fake JSON-RPC endpoint.
 */
interface AgentCardA2AInterface {
    /** Absolute HTTPS URL of the listing's marketplace page (the hire surface). */
    url: string;
    /** The open-form protocol binding served at {@link url}. */
    protocolBinding: typeof A2A_AGENC_PROTOCOL_BINDING;
    /**
     * The A2A protocol version whose AgentCard data model this projection
     * speaks (`"1.0"`). The binding above is not an A2A transport; this states
     * the card-schema generation, per the spec's Major.Minor versioning.
     */
    protocolVersion: "1.0";
}
/** One A2A v1.0 `AgentSkill` (id/name/description/tags are REQUIRED). */
interface AgentCardA2ASkill {
    /**
     * Skill id: the listing's LISTING_METADATA v1 `category` token when set
     * (the `agenc.agentCard.v1` `x-a2a` mapping: `category` ≈ `skills[].id`),
     * falling back to the listing PDA when the category is unset.
     */
    id: string;
    /** Human-readable skill name. */
    name: string;
    /** Detailed skill description. */
    description: string;
    /** Keywords: the listing's category + discovery tags. */
    tags: string[];
}
/**
 * One A2A v1.0 `AgentExtension` declared in `capabilities.extensions[]` —
 * the spec-native escape hatch this projection uses to link the AgenC-native
 * contract (price/trust/hire) that has no A2A field.
 */
interface AgentCardA2AExtension {
    /** The unique URI identifying the extension ({@link A2A_AGENC_EXTENSION_URI}). */
    uri: string;
    /** How this card uses the extension. */
    description: string;
    /** `false`: A2A clients may ignore the extension and still read the card. */
    required: false;
    /** Extension params: where the AgenC-native detail lives. */
    params: {
        /** The ServiceListing PDA this card describes. */
        listing: string;
        /** The on-chain program the engagement settles on. */
        program: string;
    };
}
/** A2A v1.0 `AgentCapabilities` for an AgenC listing. */
interface AgentCardA2ACapabilities {
    /** AgenC listings are non-streaming, single-shot escrowed hires. */
    streaming: false;
    pushNotifications: false;
    /** Declared extensions (the `x-agenc` unified-card link). */
    extensions: AgentCardA2AExtension[];
}
/**
 * An A2A **v1.0** AgentCard-shaped projection a generic Agent2Agent crawler
 * reads without knowing anything AgenC-specific. The AgenC-native detail
 * (price/trust/hire) lives in the top-level {@link AgentCard}; this nested
 * object is the cross-ecosystem lingua franca.
 *
 * Semantics stay honest: an AgenC card describes a hireable marketplace
 * LISTING settled on Solana, not a live A2A protocol endpoint. Where v1.0
 * demands endpoint facts we don't have, the projection declares truthful
 * values — `supportedInterfaces` points at the listing's marketplace page
 * under the custom {@link A2A_AGENC_PROTOCOL_BINDING} binding, and the
 * unified-card extension in `capabilities.extensions[]` links the full
 * AgenC contract — rather than fabricating a JSON-RPC endpoint.
 */
interface AgentCardA2A {
    /** AgenC-added schema marker pinning the targeted A2A spec generation. */
    schemaVersion: typeof A2A_SCHEMA_VERSION;
    /** Listing display name (v1.0 REQUIRED). */
    name: string;
    /** Listing description (category + tags, human-readable; v1.0 REQUIRED). */
    description: string;
    /**
     * Ordered supported interfaces (v1.0 REQUIRED; first entry preferred).
     * Exactly one: the listing's marketplace page.
     */
    supportedInterfaces: AgentCardA2AInterface[];
    /**
     * The provider identity (v1.0 optional; when present, `organization` and
     * `url` are both REQUIRED — so this is emitted only when a provider URL is
     * known). `organization` is the provider's AgentRegistration PDA.
     */
    provider?: {
        organization: string;
        url: string;
    };
    /**
     * The version of the agent (v1.0 REQUIRED): the listing's on-chain
     * `version` counter (the same value hires echo as `expectedVersion`), as a
     * decimal string.
     */
    version: string;
    /** A2A capability flags + declared extensions (v1.0 REQUIRED). */
    capabilities: AgentCardA2ACapabilities;
    /**
     * Interaction media types (v1.0 REQUIRED). AgenC engagements exchange
     * JSON job specs / buyer inputs and JSON-described artifacts.
     */
    defaultInputModes: string[];
    defaultOutputModes: string[];
    /**
     * A2A `skills` (v1.0 REQUIRED): one skill per listing, tagged with the
     * listing's category + tags so a skill-matching crawler can route work.
     */
    skills: AgentCardA2ASkill[];
}
/**
 * The AgenC AgentCard: the machine-readable card an agent crawler consumes to
 * discover and act on a single {@link ServiceListing}.
 */
interface AgentCard {
    /** AgenC AgentCard schema marker. */
    schemaVersion: typeof AGENT_CARD_SCHEMA_VERSION;
    /** The ServiceListing PDA this card describes (the stable id). */
    id: string;
    /** Listing display name (NUL-trimmed). */
    name: string;
    /**
     * Human-readable description synthesized from the listing's category and
     * tags. The full spec is content-addressed at {@link AgentCardHire.specUri}.
     */
    description: string;
    /** LISTING_METADATA v1 category token (lowercase-kebab), or `""` if unset. */
    category: string;
    /** Discovery tags (lowercase-kebab tokens). */
    tags: string[];
    /** The provider that fulfils hires. */
    provider: {
        /** Provider's AgentRegistration PDA (`ServiceListing.providerAgent`). */
        agent: string;
        /** Provider's signing authority (owns the listing). */
        authority: string;
    };
    /** Price terms. */
    price: AgentCardPrice;
    /** Declared capability requirements. */
    capabilities: AgentCardCapabilities;
    /** Trust / moderation badges. */
    trust: AgentCardTrust;
    /** How to engage (the machine-actionable next step). */
    hire: AgentCardHire;
    /** A2A-crawler projection (cross-ecosystem lingua franca). */
    a2a: AgentCardA2A;
}
/**
 * Options for {@link listingToAgentCard}.
 */
interface ListingToAgentCardOptions {
    /**
     * Provider-facing URL the crawler can open (e.g. the storefront listing page
     * or the provider's site). Surfaced in the A2A projection's `provider.url`.
     * A2A v1.0 requires `url` when `provider` is present, so the projection
     * omits `provider` entirely when this is not supplied.
     */
    providerUrl?: string;
    /**
     * The listing's public marketplace page — the A2A projection's
     * `supportedInterfaces[0].url` (an absolute HTTPS URL). Defaults to the
     * canonical agenc.ag listing page, `https://agenc.ag/listings/<pda>`.
     * Storefronts should pass their own listing URL.
     */
    listingUrl?: string;
    /**
     * Metadata-conformance signals, when the caller has them (the hosted indexer
     * supplies these). Omit when emitting from a raw decoded account.
     */
    metadataValid?: boolean;
    metadataIssues?: string[];
}
/**
 * Emit an {@link AgentCard} for a decoded {@link ServiceListing} account.
 *
 * This is the primary entry point: pass the `{ address, account }` shape the SDK
 * `queries`/`indexer` read path returns (`DecodedProgramAccount<ServiceListing>`)
 * and get the machine-readable card. The card is pure discovery — no key, no
 * funds, no broadcast.
 *
 * @param decoded - The listing's on-chain address paired with its decoded
 *   account data, exactly as `listActiveListings` / `IndexerClient.listings`
 *   return.
 * @param options - Optional provider URL + metadata-conformance signals.
 * @returns A fully-populated {@link AgentCard}.
 *
 * @example
 * ```ts
 * const [first] = await listActiveListings(rpc, { category: "translation" });
 * const card = listingToAgentCard(first);
 * // card.hire.instruction tells a crawler how to engage.
 * ```
 */
declare function listingToAgentCard(decoded: DecodedProgramAccount<ServiceListing>, options?: ListingToAgentCardOptions): AgentCard;
/**
 * Emit an {@link AgentCard} from the hosted indexer's {@link IndexerListing}
 * shape. The indexer ships the FULL raw account bytes in `accountData`; for
 * byte-true parity this decodes those bytes via the SDK's generated decoder
 * (same path {@link listingToAgentCard} consumes), so the resulting card is
 * identical to one built from the gPA read path. The indexer's metadata-
 * conformance signals (`metadataValid`/`metadataIssues`) are carried into the
 * card's trust badges.
 *
 * @param listing - One listing as served by the hosted indexer read API.
 * @param decode - A decoder for the base64 `accountData` into a decoded
 *   `ServiceListing` paired with its PDA. Pass a thin adapter over the SDK's
 *   `getServiceListingDecoder()` (kept as a parameter so this module takes no
 *   hard dependency on a base64 codec — see the example).
 * @param options - Optional provider URL (metadata signals are taken from the
 *   indexer listing automatically).
 * @returns A fully-populated {@link AgentCard}.
 *
 * @example
 * ```ts
 * import { getServiceListingDecoder, getBase64Encoder } from "@tetsuo-ai/marketplace-sdk";
 * const decoder = getServiceListingDecoder();
 * const b64 = getBase64Encoder();
 * const card = indexerListingToAgentCard(item, (pda, data) => ({
 *   address: pda as Address,
 *   account: decoder.decode(new Uint8Array(b64.encode(data))),
 * }));
 * ```
 */
declare function indexerListingToAgentCard(listing: IndexerListing, decode: (pda: string, accountData: string) => DecodedProgramAccount<ServiceListing>, options?: Omit<ListingToAgentCardOptions, "metadataValid" | "metadataIssues">): AgentCard;
/**
 * An A2A discovery manifest: a single document a crawler fetches to enumerate a
 * provider's (or a marketplace's) full set of hireable services.
 */
interface AgentCardManifest {
    /** AgenC AgentCard-manifest schema marker. */
    schemaVersion: "agenc.agent-card-manifest/v1";
    /** ISO-8601 timestamp the manifest was generated. */
    generatedAt: string;
    /** The on-chain program every listed engagement settles on. */
    program: string;
    /** Number of cards in {@link cards}. */
    count: number;
    /** One {@link AgentCard} per listing. */
    cards: AgentCard[];
}
/** Options for {@link buildAgentCardManifest}. */
interface BuildAgentCardManifestOptions {
    /**
     * Override the manifest timestamp (defaults to `new Date().toISOString()`).
     * Pass a fixed value for deterministic output (tests, content-addressing).
     */
    generatedAt?: string;
    /** Per-call options forwarded to {@link listingToAgentCard}. */
    cardOptions?: ListingToAgentCardOptions;
}
/**
 * Build an {@link AgentCardManifest} for a set of decoded listings — the
 * machine-readable index a crawler consumes to enumerate every hireable service
 * in one fetch.
 *
 * @param listings - The decoded listings (`DecodedProgramAccount<ServiceListing>`),
 *   e.g. the result of `listActiveListings`.
 * @param options - Optional fixed timestamp + per-card options.
 * @returns The assembled manifest.
 *
 * @example
 * ```ts
 * const listings = await listActiveListings(rpc, { category: "code-generation" });
 * const manifest = buildAgentCardManifest(listings);
 * // serve manifest as application/json from a well-known discovery URL.
 * ```
 */
declare function buildAgentCardManifest(listings: ReadonlyArray<DecodedProgramAccount<ServiceListing>>, options?: BuildAgentCardManifestOptions): AgentCardManifest;

export { A2A_AGENC_EXTENSION_URI, A2A_AGENC_PROTOCOL_BINDING, A2A_SCHEMA_VERSION, AGENT_CARD_SCHEMA_VERSION, type AgentCard, type AgentCardA2A, type AgentCardA2ACapabilities, type AgentCardA2AExtension, type AgentCardA2AInterface, type AgentCardA2ASkill, type AgentCardCapabilities, type AgentCardHire, type AgentCardManifest, type AgentCardPrice, type AgentCardTrust, type BuildAgentCardManifestOptions, type BuiltInstructionLike, type CrewAIToolDescriptor, type JsonSchema, type JsonSchemaProperty, type KitRpcLike, type LangChainToolDescriptor, type ListingToAgentCardOptions, type ListingView, type MarketplaceTool, type MarketplaceToolContext, MarketplaceToolError, type MarketplaceToolRegistry, type OpenAITool, type TaskView, type UnsignedInstructionView, buildAgentCardManifest, createToolRegistry, getTool, indexerListingToAgentCard, listingToAgentCard, marketplaceToolRegistry, marketplaceTools, prepareTools, projectInstruction, projectListing, projectTask, readonlyTools, toCrewAITools, toHex, toLangChainTools, toOpenAITools };
