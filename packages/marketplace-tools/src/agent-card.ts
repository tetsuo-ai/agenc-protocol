// A2A-style AgentCard emitter for AgenC ServiceListings (PLAN.md P5.4 step 3,
// overlaps P10.3's llms.txt/AgentCard work). Pure DISCOVERY: this module turns a
// ServiceListing into a machine-readable card an agent crawler consumes to
// discover and act on a listing. It holds no key, sends no funds, broadcasts
// nothing, and contains no x402 payment code (that is the [HUMAN]-gated design
// in docs/X402_FAST_PATH.md).
//
// Clean-room: the card schema below is derived FRESH from the public program
// surface (the @tetsuo-ai/marketplace-sdk ServiceListing account + the
// LISTING_METADATA v1 codecs). No code is copied from the EULA-licensed kit.
//
// Browser-safe: no Node built-ins. Depends only on the public SDK + @solana/kit.
import { unwrapOption, type Address, type Option } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  ListingState,
  values,
  type ServiceListing,
  type DecodedProgramAccount,
  type IndexerListing,
} from "@tetsuo-ai/marketplace-sdk";

/**
 * The canonical AgentCard schema version this module emits. Bump on any
 * breaking change to the {@link AgentCard} shape.
 */
export const AGENT_CARD_SCHEMA_VERSION = "agenc.agent-card/v1" as const;

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
export const A2A_SCHEMA_VERSION = "a2a/v1.0" as const;

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
export const A2A_AGENC_PROTOCOL_BINDING = "AGENC-MARKETPLACE" as const;

/**
 * The extension URI declared in the projection's
 * `capabilities.extensions[]` (the spec-native `AgentExtension` mechanism):
 * the canonical unified AgenC card schema. Crawlers that resolve it get the
 * full `agenc.agentCard.v1` contract — price terms, CAS guards, trust
 * badges, and the hire instruction — that has no A2A equivalent.
 */
export const A2A_AGENC_EXTENSION_URI =
  "https://agenc.ag/schemas/agenc.agentCard.v1.json" as const;

/** Price terms an agent needs to decide whether (and how) to engage. */
export interface AgentCardPrice {
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
export interface AgentCardCapabilities {
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
export interface AgentCardTrust {
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
export interface AgentCardHire {
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
export interface AgentCardA2AInterface {
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
export interface AgentCardA2ASkill {
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
export interface AgentCardA2AExtension {
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
export interface AgentCardA2ACapabilities {
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
export interface AgentCardA2A {
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
  provider?: { organization: string; url: string };
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
export interface AgentCard {
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
export interface ListingToAgentCardOptions {
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

/** Index-set of the bits set in a u64 bitmask. */
function bitsOf(mask: bigint): number[] {
  const bits: number[] = [];
  for (let i = 0; i < 64; i++) {
    if ((mask & (1n << BigInt(i))) !== 0n) bits.push(i);
  }
  return bits;
}

/** Lowercase hex of a 32-byte field. */
function toHex(bytes: ReadonlyUint8ArrayLike): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}

/** Structural alias so this module doesn't depend on kit's exact array type. */
type ReadonlyUint8ArrayLike = { readonly length: number; [index: number]: number };

/** Map the on-chain {@link ListingState} value to the card's state string. */
function stateString(state: ListingState): AgentCardTrust["state"] {
  switch (state) {
    case ListingState.Paused:
      return "paused";
    case ListingState.Retired:
      return "retired";
    case ListingState.Active:
    default:
      return "active";
  }
}

/** Synthesize a one-line description from category + tags. */
function describe(name: string, category: string, tags: string[]): string {
  const parts: string[] = [];
  if (category) parts.push(category.replace(/-/g, " "));
  if (tags.length > 0) parts.push(tags.map((t) => t.replace(/-/g, " ")).join(", "));
  const suffix = parts.length > 0 ? ` — ${parts.join("; ")}` : "";
  return `AgenC service listing: ${name || "(unnamed)"}${suffix}`;
}

/** Round a number to two decimals, returning a finite number. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
export function listingToAgentCard(
  decoded: DecodedProgramAccount<ServiceListing>,
  options: ListingToAgentCardOptions = {},
): AgentCard {
  const { address, account } = decoded;
  const listingPda = String(address);

  const name = values.decodeListingName(account.name as unknown as Uint8Array);
  const category = values.decodeListingCategory(
    account.category as unknown as Uint8Array,
  );
  const tags = values.decodeListingTags(account.tags as unknown as Uint8Array);
  const specHash = toHex(account.specHash as unknown as ReadonlyUint8ArrayLike);

  const priceMint = unwrapOption(account.priceMint as Option<Address>);
  const price: AgentCardPrice = {
    amount: account.price.toString(),
    denomination: priceMint === null ? "SOL" : String(priceMint),
    native: priceMint === null,
  };

  const requiredBitmask = account.requiredCapabilities;
  const averageRating =
    account.ratingCount > 0
      ? round2(Number(account.totalRating) / account.ratingCount)
      : null;

  const description = describe(name, category, tags);

  return {
    schemaVersion: AGENT_CARD_SCHEMA_VERSION,
    id: listingPda,
    name,
    description,
    category,
    tags,
    provider: {
      agent: String(account.providerAgent),
      authority: String(account.authority),
    },
    price,
    capabilities: {
      requiredBitmask: requiredBitmask.toString(),
      requiredBits: bitsOf(requiredBitmask),
    },
    trust: {
      state: stateString(account.state),
      ...(options.metadataValid !== undefined
        ? { metadataValid: options.metadataValid }
        : {}),
      ...(options.metadataIssues !== undefined
        ? { metadataIssues: options.metadataIssues }
        : {}),
      totalHires: account.totalHires.toString(),
      ratingCount: account.ratingCount,
      averageRating,
      specHash,
    },
    hire: {
      program: String(AGENC_COORDINATION_PROGRAM_ADDRESS),
      listing: listingPda,
      providerAgent: String(account.providerAgent),
      expectedPrice: account.price.toString(),
      expectedVersion: account.version.toString(),
      listingSpecHash: specHash,
      specUri: account.specUri,
      defaultDeadlineSecs: account.defaultDeadlineSecs.toString(),
      // x402 is design-only today (docs/X402_FAST_PATH.md); escrow is the only
      // built engagement path.
      recommendedTier: "escrow",
      instruction:
        `To hire: prepare a humanless hire transaction (buyer wallet, listing=${listingPda}, ` +
        `expectedPrice=${account.price.toString()}, expectedVersion=${account.version.toString()}, ` +
        `listingSpecHash=${specHash}, plus the moderator pubkey whose moderation ` +
        `attestation the hire consumes — from your attestation service, e.g. ` +
        `attest.agenc.ag GET /v1/info) with the SDK facade, MCP prepare tools, ` +
        `or your operator transaction builder, sign the unsigned transaction ` +
        `locally, and broadcast it. The humanless hire mints a Task + escrow ` +
        `on program ` +
        `${String(AGENC_COORDINATION_PROGRAM_ADDRESS)}.`,
    },
    a2a: {
      schemaVersion: A2A_SCHEMA_VERSION,
      name,
      description,
      supportedInterfaces: [
        {
          url: options.listingUrl ?? `https://agenc.ag/listings/${listingPda}`,
          protocolBinding: A2A_AGENC_PROTOCOL_BINDING,
          protocolVersion: "1.0",
        },
      ],
      // A2A v1.0 requires provider.url when provider is present — emit the
      // provider block only when the caller supplied a real URL.
      ...(options.providerUrl !== undefined
        ? {
            provider: {
              organization: String(account.providerAgent),
              url: options.providerUrl,
            },
          }
        : {}),
      version: account.version.toString(),
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extensions: [
          {
            uri: A2A_AGENC_EXTENSION_URI,
            description:
              "This card describes a hireable AgenC marketplace listing settled " +
              "on Solana, not a live A2A task-lifecycle endpoint. The unified " +
              "agenc.agentCard.v1 contract (price terms, CAS guards, trust " +
              "badges, hire instruction) is the enclosing card / the schema at " +
              "this URI.",
            required: false,
            params: {
              listing: listingPda,
              program: String(AGENC_COORDINATION_PROGRAM_ADDRESS),
            },
          },
        ],
      },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [
        {
          // x-a2a mapping: category ≈ skills[].id; fall back to the PDA.
          id: category || listingPda,
          name: name || category || "agenc-service",
          description,
          tags: [...(category ? [category] : []), ...tags],
        },
      ],
    },
  };
}

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
export function indexerListingToAgentCard(
  listing: IndexerListing,
  decode: (
    pda: string,
    accountData: string,
  ) => DecodedProgramAccount<ServiceListing>,
  options: Omit<ListingToAgentCardOptions, "metadataValid" | "metadataIssues"> = {},
): AgentCard {
  const decoded = decode(listing.pda, listing.accountData);
  return listingToAgentCard(decoded, {
    ...options,
    metadataValid: listing.metadataValid,
    metadataIssues: listing.metadataIssues,
  });
}

/**
 * An A2A discovery manifest: a single document a crawler fetches to enumerate a
 * provider's (or a marketplace's) full set of hireable services.
 */
export interface AgentCardManifest {
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
export interface BuildAgentCardManifestOptions {
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
export function buildAgentCardManifest(
  listings: ReadonlyArray<DecodedProgramAccount<ServiceListing>>,
  options: BuildAgentCardManifestOptions = {},
): AgentCardManifest {
  const cards = listings.map((l) => listingToAgentCard(l, options.cardOptions));
  return {
    schemaVersion: "agenc.agent-card-manifest/v1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    program: String(AGENC_COORDINATION_PROGRAM_ADDRESS),
    count: cards.length,
    cards,
  };
}
