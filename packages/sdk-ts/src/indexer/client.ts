// The hosted indexer API client (PLAN.md P3.2): a thin, typed, fetch-based
// reader over the storefront explorer/listings surface, plus the no-RPC write
// path (`POST /v1/hires` transaction builder) and webhook management.
//
// Decode-parity is the load-bearing requirement: every listing response
// carries `accountData` (base64 of the FULL raw on-chain account bytes), and
// `listActiveListings` decodes those bytes with the SAME generated
// `getServiceListingDecoder` the gPA queries module uses — so it returns the
// IDENTICAL `{ address, account }` shape and drops into existing call sites.
//
// Browser-safe: fetch + `@solana/kit` codecs only — no Node built-ins.
import { getBase64Encoder, type Address } from "@solana/kit";
import {
  getServiceListingDecoder,
  ListingState,
  type ServiceListing,
} from "../generated/index.js";
import type { DecodedProgramAccount } from "../queries/helpers.js";
import { IndexerError } from "./errors.js";

/**
 * Minimal structural slice of `fetch` used by the indexer client. The global
 * `fetch` satisfies it; tests inject a fake.
 */
export type IndexerFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Options for {@link createIndexerClient}. */
export interface CreateIndexerClientOptions {
  /**
   * Base URL of the hosted indexer/storefront API (e.g.
   * `https://marketplace.agenc.tech`). Paths like `/api/explorer/listings`
   * and `/v1/hires` are appended to it.
   */
  baseUrl: string;
  /**
   * API key sent as the `X-Agenc-Api-Key` header (self-served via
   * `POST /v1/api-keys`). Optional: anonymous reads work at a lower rate;
   * webhook management requires a key.
   */
  apiKey?: string;
  /** Override the fetch implementation (tests / custom transports). */
  fetchImpl?: IndexerFetchLike;
}

/**
 * The `decoded` projection the indexer serves alongside the raw account
 * bytes — a human-readable convenience view. For programmatic use prefer
 * decoding `accountData` (what {@link IndexerClient.listActiveListings}
 * does): the bytes are the on-chain truth, the projection is for display.
 */
export interface IndexerListingDecoded {
  /** Provider agent PDA (`ServiceListing.providerAgent`). */
  provider: string;
  /** Provider signing authority. */
  authority: string;
  /** Display name (NUL-trimmed). */
  name: string;
  /** Category token (lowercase-kebab, NUL-trimmed). */
  category: string;
  /** Discovery tags. */
  tags: string[];
  /** Lowercase hex of the 32-byte spec hash. */
  specHash: string;
  /** Job-spec URI. */
  specUri: string;
  /** Price as a decimal string (u64-safe). */
  price: string;
  /** SPL price mint, or `null` for SOL. */
  priceMint: string | null;
  /**
   * Lifecycle state. The wire serialization is the decoded
   * {@link ListingState} value (numeric enum) or its PascalCase variant name;
   * for exact comparisons decode `accountData` instead.
   */
  state: ListingState | keyof typeof ListingState;
  /** Max concurrently-open hires (0 = unlimited). */
  maxOpenJobs: number;
  /** Currently-open hire count. */
  openJobs: number;
  /** Lifetime hire count as a decimal string (u64-safe). */
  totalHires: string;
  /** Listing version (compare-and-swap target) as a decimal string. */
  version: string;
  /** Creation unix timestamp as a decimal string (i64-safe). */
  createdAt: string;
  /** Last-update unix timestamp as a decimal string (i64-safe). */
  updatedAt: string;
}

/** One listing as served by the indexer read API. */
export interface IndexerListing {
  /** The ServiceListing PDA. */
  pda: string;
  /**
   * Base64 of the FULL raw on-chain account bytes — decode with
   * `getServiceListingDecoder()` for byte-true parity with the gPA path.
   */
  accountData: string;
  /** Human-readable projection of the decoded account. */
  decoded: IndexerListingDecoded;
  /** Whether the listing metadata conforms to the LISTING_METADATA v1 spec. */
  metadataValid: boolean;
  /** Spec-conformance issues (empty when `metadataValid`). */
  metadataIssues: string[];
  /** Slot of the last event applied to this read-model row. */
  lastSlot: number;
  /** Signature of the last transaction applied to this read-model row. */
  lastSignature: string;
}

/** One page of listings from `GET /api/explorer/listings`. */
export interface IndexerListingsPage {
  /** 1-based page number. */
  page: number;
  /** Effective page size the server applied. */
  pageSize: number;
  /** Total matching listings across all pages. */
  total: number;
  /** The page's listings. */
  items: IndexerListing[];
}

/** Filters + paging for {@link IndexerClient.listings}. */
export interface IndexerListingsQuery {
  /** Category token (exact match). */
  category?: string;
  /** Tags (sent as a CSV `tags=` parameter). */
  tags?: string[];
  /** Provider agent PDA. */
  provider?: string;
  /** Lifecycle state filter (server-side; serialization per the read API). */
  state?: string;
  /** Filter on metadata validity (server default: valid only). */
  metadataValid?: boolean;
  /** 1-based page number (default 1). */
  page?: number;
  /** Page size (server default 50). */
  pageSize?: number;
}

/** One hire as served by `GET /api/explorer/listings/:pda/hires`. */
export interface IndexerHire {
  /** The minted Task PDA. */
  taskPda: string;
  /** The HireRecord PDA. */
  hireRecordPda: string;
  /** Base64 of the FULL raw HireRecord account bytes. */
  accountData: string;
  /** Buyer wallet (the hired task's creator). */
  buyer: string;
  /** The ServiceListing PDA hired from. */
  listing: string;
  /** Price paid as a decimal string (u64-safe). */
  price: string;
  /** Slot of the hire. */
  slot: number;
  /** Transaction signature of the hire. */
  signature: string;
}

/** One slash event in an agent's track record. */
export interface IndexerSlashEvent {
  /** Slot of the slash. */
  slot: number;
  /** Transaction signature of the slash. */
  signature: string;
  /** Slashed amount (lamports) when known. */
  amount?: string | number;
}

/** Agent track record from `GET /api/explorer/agents/:pda/track-record`. */
export interface IndexerAgentTrackRecord {
  /** The agent PDA the record describes. */
  agent: string;
  /** Completed-task count. */
  completions: number;
  /** Disputes the agent initiated. */
  disputesInitiated: number;
  /** Disputes the agent lost. */
  disputesLost: number;
  /** Reconstructed slash history. */
  slashHistory: IndexerSlashEvent[];
  /** Provenance of the numbers — always `"events"` in v1. */
  source: "events";
}

/** Parameters for {@link IndexerClient.buildHireTransaction}. */
export interface BuildHireTransactionParams {
  /** Buyer wallet (fee payer + signer of the returned transaction). */
  buyer: Address | string;
  /** The ServiceListing PDA to hire from. */
  listing: Address | string;
  /** 32-byte task id as 64 hex chars (server generates one when absent). */
  taskId?: string;
  /** Expected listing price (compare-and-swap guard). */
  expectedPrice: bigint | string;
  /** Expected listing version (compare-and-swap guard). */
  expectedVersion: bigint | string;
  /** Expected listing spec hash as 64 hex chars (optional guard). */
  listingSpecHash?: string;
  /** The buyer's creator AgentRegistration PDA. */
  creatorAgent: Address | string;
}

/** Response of `POST /v1/hires` — an UNSIGNED transaction to sign locally. */
export interface BuildHireTransactionResult {
  /** Base64 of the compiled UNSIGNED v0 transaction bytes. */
  transaction: string;
  /** The blockhash the transaction was built against. */
  blockhash: string;
  /** Last block height at which the blockhash is valid. */
  lastValidBlockHeight: number;
  /** The Task PDA the hire will mint. */
  taskPda: string;
  /** The escrow PDA funded by the hire. */
  escrowPda: string;
  /** The HireRecord PDA the hire will create. */
  hireRecordPda: string;
  /** The (possibly server-generated) 32-byte task id as 64 hex chars. */
  taskId: string;
}

/** Parameters for {@link IndexerClient.registerWebhook}. */
export interface RegisterWebhookParams {
  /** Delivery URL (POSTed signed JSON events). */
  url: string;
  /** Event types to deliver (default: all v1 event types). */
  events?: string[];
}

/** Response of `POST /v1/webhooks`. */
export interface RegisterWebhookResult {
  /** Webhook id (use with `deleteWebhook`). */
  id: string;
  /**
   * The signing secret — SHOWN ONCE, never retrievable again. Verify
   * deliveries with `verifyAgencWebhookSignature` from the `webhooks`
   * module.
   */
  secret: string;
}

/** One registered webhook as listed by `GET /v1/webhooks` (secret redacted). */
export interface IndexerWebhook {
  /** Webhook id. */
  id: string;
  /** Delivery URL. */
  url: string;
  /** Subscribed event types. */
  events: string[];
}

/** One event from the key-scoped `GET /v1/events` replay log. */
export interface IndexerEvent {
  /** Event id (`evt_<uuid>`), the `after` cursor for replay. */
  id: string;
  /** Event type (e.g. `"listing.hired"`, `"task.created"`). */
  type: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** Event payload. */
  data: unknown;
}

/** Options for {@link IndexerClient.listEvents}. */
export interface ListIndexerEventsOptions {
  /** Return only events after this event id (replay cursor). */
  after?: string;
  /** Maximum events to return (server default 100). */
  limit?: number;
}

/**
 * Options for {@link IndexerClient.listActiveListings} — the indexer
 * counterpart of the queries module's `ListActiveListingsOptions`.
 */
export interface IndexerListActiveListingsOptions {
  /** The provider's AgentRegistration PDA (server-side filter). */
  provider?: Address;
  /**
   * Category to match (server-side filter). A plain string is validated
   * against the same lowercase-kebab rule the queries module enforces and
   * throws a `TypeError` otherwise (a non-kebab string could only ever match
   * nothing) — drop-in parity with the gPA path, rather than a silent empty
   * set. A raw 32-byte form is accepted for drop-in compatibility with the
   * queries module and converted to its NUL-trimmed UTF-8 string for the
   * wire; raw non-UTF-8 categories cannot be queried over the indexer API
   * (use the gPA path for those).
   */
  category?: Uint8Array | string;
  /**
   * Lifecycle state to keep. Defaults to {@link ListingState.Active}.
   * CLIENT-SIDE filter over the decoded account bytes — identical semantics
   * to the queries module.
   */
  state?: ListingState;
}

/**
 * The hosted indexer API client. Create with {@link createIndexerClient}.
 *
 * Every method maps the house error envelope to a typed
 * {@link IndexerError} (`{ status, code, message }`).
 */
export interface IndexerClient {
  /** One page of listings with filters (`GET /api/explorer/listings`). */
  listings(query?: IndexerListingsQuery): Promise<IndexerListingsPage>;
  /** One listing by PDA (`GET /api/explorer/listings/:pda`). */
  getListing(pda: Address | string): Promise<IndexerListing>;
  /** Hires of a listing (`GET /api/explorer/listings/:pda/hires`). */
  listingHires(pda: Address | string): Promise<IndexerHire[]>;
  /** Agent track record (`GET /api/explorer/agents/:pda/track-record`). */
  agentTrackRecord(pda: Address | string): Promise<IndexerAgentTrackRecord>;
  /**
   * Drop-in counterpart of the queries module's `listActiveListings`: fetches
   * every page, decodes each listing's `accountData` bytes with the generated
   * `getServiceListingDecoder`, and returns the IDENTICAL
   * `Array<{ address, account: ServiceListing }>` shape — swap the transport,
   * keep the call sites.
   *
   * NOTE: the hosted read model excludes metadata-nonconforming listings from
   * default queries, so the result can be a subset of what raw gPA returns.
   */
  listActiveListings(
    options?: IndexerListActiveListingsOptions,
  ): Promise<Array<DecodedProgramAccount<ServiceListing>>>;
  /**
   * Build an UNSIGNED hire transaction server-side (`POST /v1/hires`) — the
   * no-RPC write path. Sign the returned base64 transaction locally and
   * broadcast it yourself; the indexer never sees a key.
   */
  buildHireTransaction(
    params: BuildHireTransactionParams,
  ): Promise<BuildHireTransactionResult>;
  /** Register a webhook endpoint (`POST /v1/webhooks`; API key required). */
  registerWebhook(params: RegisterWebhookParams): Promise<RegisterWebhookResult>;
  /** List registered webhooks, secrets redacted (`GET /v1/webhooks`). */
  listWebhooks(): Promise<IndexerWebhook[]>;
  /** Delete a webhook (`DELETE /v1/webhooks/:id`). */
  deleteWebhook(id: string): Promise<void>;
  /** Replay the key-scoped event log (`GET /v1/events`). */
  listEvents(options?: ListIndexerEventsOptions): Promise<IndexerEvent[]>;
}

/** Page size used by the auto-paginating `listActiveListings`. */
const LIST_ALL_PAGE_SIZE = 100;

/**
 * Lowercase-kebab rule for string categories. Deliberately DUPLICATED from the
 * values module's `LISTING_KEBAB_PATTERN` and the queries module's identical
 * `CATEGORY_KEBAB_PATTERN` (keep all three in lockstep) — the indexer client
 * takes no dependency on either module and must stay browser-safe.
 */
const CATEGORY_KEBAB_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * NUL-trim a raw 32-byte category to its UTF-8 string form, or validate a
 * plain string category against the same lowercase-kebab rule the queries
 * module (`toCategoryBytes`) and the facade write path enforce.
 *
 * A non-kebab string could never match a facade-written listing (those only
 * ever store a canonical lowercase-kebab token), so it throws a `TypeError`
 * here exactly as the gPA queries path does — drop-in parity, rather than
 * silently filtering to an empty set. Use the raw 32-byte form to query
 * non-standard listings written by raw clients.
 */
function categoryToString(category: Uint8Array | string): string {
  if (typeof category === "string") {
    if (!CATEGORY_KEBAB_PATTERN.test(category)) {
      throw new TypeError(
        `indexer: category ${JSON.stringify(category)} is not lowercase-kebab ` +
          "([a-z0-9]+(-[a-z0-9]+)*) — facade-written listings only ever store " +
          "lowercase-kebab categories, so this string could never match; pass " +
          "the raw 32-byte form to query non-standard listings",
      );
    }
    return category;
  }
  let end = category.length;
  while (end > 0 && category[end - 1] === 0) end -= 1;
  const trimmed = category.subarray(0, end);
  if (trimmed.includes(0)) {
    throw new TypeError(
      "indexer: a raw category with interior NUL bytes cannot be queried " +
        "over the indexer API — use the gPA queries module for non-standard " +
        "listings",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(trimmed);
  } catch (cause) {
    throw new TypeError(
      "indexer: a raw non-UTF-8 category cannot be queried over the indexer " +
        "API — use the gPA queries module for non-standard listings",
      { cause },
    );
  }
}

/** Extract `{ code, message }` from a house error envelope body, if present. */
function envelopeError(
  payload: unknown,
): { code: string; message: string } | null {
  if (payload === null || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== "string") return null;
  return {
    code,
    message: typeof message === "string" ? message : code,
  };
}

/**
 * Create a typed client for the hosted indexer API.
 *
 * Reads work anonymously at the house anonymous rate; pass `apiKey` for
 * per-key rate limits and webhook/event access. Browser-safe (fetch only).
 *
 * @param options - Base URL, optional API key, optional fetch override.
 * @returns An {@link IndexerClient}.
 *
 * @example
 * ```ts
 * const indexer = createIndexerClient({
 *   baseUrl: "https://marketplace.agenc.tech",
 * });
 * // Same return shape as the gPA queries module — a drop-in swap for the
 * // default valid-only view. NOTE: the hosted read model excludes
 * // metadata-nonconforming listings, so this can return a SUBSET of raw gPA;
 * // pass `metadataValid: false` (via `listings(...)`) or use the gPA queries
 * // module to also see nonconforming listings.
 * const listings = await indexer.listActiveListings({ category: "code-generation" });
 * ```
 */
export function createIndexerClient(
  options: CreateIndexerClientOptions,
): IndexerClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (baseUrl.length === 0) {
    throw new TypeError("createIndexerClient: baseUrl is required");
  }
  // Wrapped so the global fetch keeps its expected receiver in browsers.
  const fetchImpl: IndexerFetchLike =
    options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const apiKey = options.apiKey;

  /** Perform one request and unwrap the house `{ success: true }` envelope. */
  async function request(
    method: string,
    path: string,
    init: {
      params?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    } = {},
  ): Promise<Record<string, unknown>> {
    let url = `${baseUrl}${path}`;
    if (init.params !== undefined) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(init.params)) {
        if (value !== undefined) search.set(key, String(value));
      }
      const query = search.toString();
      if (query.length > 0) url += `?${query}`;
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey !== undefined) headers["X-Agenc-Api-Key"] = apiKey;
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    let response: Awaited<ReturnType<IndexerFetchLike>>;
    try {
      response = await fetchImpl(url, { method, headers, body });
    } catch (cause) {
      throw new IndexerError(
        `indexer at ${baseUrl} could not be reached (${method} ${path}: the ` +
          `fetch itself failed before any HTTP response)`,
        { status: 0, code: "NETWORK_ERROR", cause },
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => null);
      let parsed: unknown = null;
      if (bodyText !== null) {
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          // Non-JSON error body — fall through to the synthetic code.
        }
      }
      const envelope = envelopeError(parsed);
      throw new IndexerError(
        envelope?.message ??
          `indexer at ${baseUrl} responded ${response.status} for ${method} ${path}` +
            (bodyText ? `: ${bodyText}` : ""),
        {
          status: response.status,
          code: envelope?.code ?? `HTTP_${response.status}`,
        },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new IndexerError(
        `indexer at ${baseUrl} returned ${response.status} for ${method} ` +
          `${path} but the body is not JSON`,
        { status: response.status, code: "INVALID_RESPONSE", cause },
      );
    }
    if (
      payload === null ||
      typeof payload !== "object" ||
      (payload as { success?: unknown }).success !== true
    ) {
      const envelope = envelopeError(payload);
      throw new IndexerError(
        envelope?.message ??
          `indexer at ${baseUrl} returned ${response.status} for ${method} ` +
            `${path} without the expected { success: true } envelope`,
        {
          status: response.status,
          code: envelope?.code ?? "INVALID_RESPONSE",
        },
      );
    }
    return payload as Record<string, unknown>;
  }

  /** Narrow an envelope field to an array, or fail loudly. */
  function requireArray(
    body: Record<string, unknown>,
    field: string,
    context: string,
  ): unknown[] {
    const value = body[field];
    if (!Array.isArray(value)) {
      throw new IndexerError(
        `indexer at ${baseUrl} returned a ${context} response without an ` +
          `"${field}" array`,
        { status: 200, code: "INVALID_RESPONSE" },
      );
    }
    return value;
  }

  async function listings(
    query: IndexerListingsQuery = {},
  ): Promise<IndexerListingsPage> {
    const body = await request("GET", "/api/explorer/listings", {
      params: {
        category: query.category,
        tags:
          query.tags !== undefined && query.tags.length > 0
            ? query.tags.join(",")
            : undefined,
        provider: query.provider,
        state: query.state,
        metadataValid: query.metadataValid,
        page: query.page,
        pageSize: query.pageSize,
      },
    });
    return {
      page: body.page as number,
      pageSize: body.pageSize as number,
      total: body.total as number,
      items: requireArray(body, "items", "listings") as IndexerListing[],
    };
  }

  return {
    listings,

    async getListing(pda) {
      const body = await request(
        "GET",
        `/api/explorer/listings/${encodeURIComponent(String(pda))}`,
      );
      const listing = body.listing;
      if (listing === null || typeof listing !== "object") {
        throw new IndexerError(
          `indexer at ${baseUrl} returned a listing response without a ` +
            `"listing" object`,
          { status: 200, code: "INVALID_RESPONSE" },
        );
      }
      return listing as IndexerListing;
    },

    async listingHires(pda) {
      const body = await request(
        "GET",
        `/api/explorer/listings/${encodeURIComponent(String(pda))}/hires`,
      );
      return requireArray(body, "items", "listing-hires") as IndexerHire[];
    },

    async agentTrackRecord(pda) {
      const body = await request(
        "GET",
        `/api/explorer/agents/${encodeURIComponent(String(pda))}/track-record`,
      );
      return {
        agent: body.agent as string,
        completions: body.completions as number,
        disputesInitiated: body.disputesInitiated as number,
        disputesLost: body.disputesLost as number,
        slashHistory: requireArray(
          body,
          "slashHistory",
          "track-record",
        ) as IndexerSlashEvent[],
        source: body.source as "events",
      };
    },

    async listActiveListings(options = {}) {
      const params: IndexerListingsQuery = {
        pageSize: LIST_ALL_PAGE_SIZE,
      };
      if (options.provider !== undefined) {
        params.provider = options.provider;
      }
      if (options.category !== undefined) {
        params.category = categoryToString(options.category);
      }
      // Collect every page: the queries-module contract returns the full
      // matching set, not one page.
      const base64Encoder = getBase64Encoder();
      const decoder = getServiceListingDecoder();
      const collected: Array<DecodedProgramAccount<ServiceListing>> = [];
      for (let page = 1; ; page += 1) {
        const result = await listings({ ...params, page });
        for (const item of result.items) {
          collected.push({
            address: item.pda as Address,
            account: decoder.decode(
              new Uint8Array(base64Encoder.encode(item.accountData)),
            ),
          });
        }
        if (
          result.items.length === 0 ||
          collected.length >= result.total ||
          result.pageSize <= 0
        ) {
          break;
        }
      }
      // State is refined CLIENT-SIDE over the decoded bytes — identical
      // semantics (and default) to the queries module.
      const wantState = options.state ?? ListingState.Active;
      return collected.filter(({ account }) => account.state === wantState);
    },

    async buildHireTransaction(params) {
      const body = await request("POST", "/v1/hires", {
        body: {
          buyer: String(params.buyer),
          listing: String(params.listing),
          ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
          expectedPrice: String(params.expectedPrice),
          expectedVersion: String(params.expectedVersion),
          ...(params.listingSpecHash !== undefined
            ? { listingSpecHash: params.listingSpecHash }
            : {}),
          creatorAgent: String(params.creatorAgent),
        },
      });
      return {
        transaction: body.transaction as string,
        blockhash: body.blockhash as string,
        lastValidBlockHeight: Number(body.lastValidBlockHeight),
        taskPda: body.taskPda as string,
        escrowPda: body.escrowPda as string,
        hireRecordPda: body.hireRecordPda as string,
        taskId: body.taskId as string,
      };
    },

    async registerWebhook(params) {
      const body = await request("POST", "/v1/webhooks", {
        body: {
          url: params.url,
          ...(params.events !== undefined ? { events: params.events } : {}),
        },
      });
      return { id: body.id as string, secret: body.secret as string };
    },

    async listWebhooks() {
      const body = await request("GET", "/v1/webhooks");
      return requireArray(body, "items", "webhooks") as IndexerWebhook[];
    },

    async deleteWebhook(id) {
      await request("DELETE", `/v1/webhooks/${encodeURIComponent(id)}`);
    },

    async listEvents(options = {}) {
      const body = await request("GET", "/v1/events", {
        params: { after: options.after, limit: options.limit },
      });
      return requireArray(body, "items", "events") as IndexerEvent[];
    },
  };
}
