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
import {
  address,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionEncoder,
  getTransactionDecoder,
  isNone,
  type Address,
  type Transaction,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  HIRE_RECORD_DISCRIMINATOR,
  HIRE_FROM_LISTING_DISCRIMINATOR,
  SERVICE_LISTING_DISCRIMINATOR,
  findAuthorityRateLimitPda,
  findEscrowPda,
  findHireRecordPda,
  findListingModerationPda,
  findModerationAttestorPda,
  findModerationBlockPda,
  findModerationConfigPda,
  findProtocolConfigPda,
  findTaskPda,
  getHireRecordDecoder,
  getHireFromListingInstructionDataDecoder,
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
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel?(reason?: unknown): Promise<void>;
      releaseLock?(): void;
    };
  } | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Options for {@link createIndexerClient}. */
export interface CreateIndexerClientOptions {
  /**
   * Base URL of the hosted indexer/storefront API (the first-party hosted
   * indexer is `https://api.agenc.ag`). Paths like `/api/explorer/listings`
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
  /** Wall-clock limit for every request. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Maximum streamed response body. Defaults to 1 MiB. */
  maxResponseBytes?: number;
  /** Maximum pages fetched by listActiveListings. Defaults to 100. */
  maxPages?: number;
  /** Maximum listing items collected by listActiveListings. Defaults to 10,000. */
  maxItems?: number;
  /** Optional caller abort signal applied to every request. */
  signal?: AbortSignal;
  /**
   * Mandatory independent policy verifier for the server-built hire path.
   * The SDK verifies the complete wire structure and all locally knowable
   * intent first; this callback must independently verify context unavailable
   * without RPC (notably provider and moderator policy) before the artifact is
   * returned as signable.
   */
  verifyHireTransaction?: IndexerHireTransactionVerifier;
}

/** Context supplied only after the SDK's exact structural verification passes. */
export interface IndexerHireTransactionVerificationContext {
  readonly params: Readonly<BuildHireTransactionParams>;
  readonly result: Readonly<BuildHireTransactionResult>;
  readonly transaction: Transaction;
  readonly instructionAccounts: readonly Address[];
  readonly providerAgent: Address;
  readonly moderator: Address;
}

export type IndexerHireTransactionVerifier = (
  context: IndexerHireTransactionVerificationContext,
) => void | Promise<void>;

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

/**
 * Response of `POST /v1/hires`, returned only after SDK wire verification and
 * the caller's mandatory independent `verifyHireTransaction` policy pass.
 */
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
   * no-key write path. The SDK decodes and verifies the exact wire intent and
   * refuses to return it unless `createIndexerClient` was configured with an
   * independent `verifyHireTransaction` callback for provider/moderator and
   * freshness policy that cannot be established from an untrusted server
   * alone. Only then may callers sign and broadcast it.
   */
  buildHireTransaction(
    params: BuildHireTransactionParams,
  ): Promise<BuildHireTransactionResult>;
  /** Register a webhook endpoint (`POST /v1/webhooks`; API key required). */
  registerWebhook(
    params: RegisterWebhookParams,
  ): Promise<RegisterWebhookResult>;
  /** List registered webhooks, secrets redacted (`GET /v1/webhooks`). */
  listWebhooks(): Promise<IndexerWebhook[]>;
  /** Delete a webhook (`DELETE /v1/webhooks/:id`). */
  deleteWebhook(id: string): Promise<void>;
  /** Replay the key-scoped event log (`GET /v1/events`). */
  listEvents(options?: ListIndexerEventsOptions): Promise<IndexerEvent[]>;
}

/** Page size used by the auto-paginating `listActiveListings`. */
const LIST_ALL_PAGE_SIZE = 100;
const DEFAULT_INDEXER_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_INDEXER_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_INDEXER_PAGES = 100;
const DEFAULT_MAX_INDEXER_ITEMS = 10_000;
const HEX_64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const SIGNED_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/;

function exactPositiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError(
      `createIndexerClient: ${name} must be a positive safe integer no greater than 2147483647`,
    );
  }
  return value;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function decodeCanonicalBase64(value: string): Uint8Array {
  const bytes = new Uint8Array(getBase64Encoder().encode(value));
  if (getBase64Decoder().decode(bytes) !== value) {
    throw new TypeError("base64 is not canonical");
  }
  return bytes;
}

function parseCanonicalAddress(value: unknown): Address {
  if (typeof value !== "string") throw new TypeError("not an address string");
  return address(value);
}

function isCanonicalSignature(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const bytes = new Uint8Array(getBase58Encoder().encode(value));
    return bytes.length === 64 && getBase58Decoder().decode(bytes) === value;
  } catch {
    return false;
  }
}

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
  if (category.length !== 32) {
    throw new TypeError(
      `indexer: raw category must contain exactly 32 bytes, got ${category.length}`,
    );
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
 *   baseUrl: "https://api.agenc.ag",
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
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(options.baseUrl);
  } catch {
    throw new TypeError(
      "createIndexerClient: baseUrl must be an absolute HTTP(S) URL",
    );
  }
  if (
    (parsedBaseUrl.protocol !== "https:" &&
      parsedBaseUrl.protocol !== "http:") ||
    parsedBaseUrl.username !== "" ||
    parsedBaseUrl.password !== "" ||
    parsedBaseUrl.search !== "" ||
    parsedBaseUrl.hash !== ""
  ) {
    throw new TypeError(
      "createIndexerClient: baseUrl must be HTTP(S) without credentials, query, or fragment",
    );
  }
  const baseUrl = parsedBaseUrl.href.replace(/\/+$/, "");
  const timeoutMs = exactPositiveBound(
    options.timeoutMs ?? DEFAULT_INDEXER_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxResponseBytes = exactPositiveBound(
    options.maxResponseBytes ?? DEFAULT_MAX_INDEXER_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const maxPages = exactPositiveBound(
    options.maxPages ?? DEFAULT_MAX_INDEXER_PAGES,
    "maxPages",
  );
  const maxItems = exactPositiveBound(
    options.maxItems ?? DEFAULT_MAX_INDEXER_ITEMS,
    "maxItems",
  );
  // Wrapped so the global fetch keeps its expected receiver in browsers.
  const fetchImpl: IndexerFetchLike =
    options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const apiKey = options.apiKey;

  function transportError(
    message: string,
    code: string,
    options: { status?: number; cause?: unknown } = {},
  ): IndexerError {
    return new IndexerError(message, {
      status: options.status ?? 0,
      code,
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
  }

  async function readBoundedText(
    response: Awaited<ReturnType<IndexerFetchLike>>,
    method: string,
    path: string,
  ): Promise<string> {
    const stream = response.body;
    if (
      stream === undefined ||
      stream === null ||
      typeof stream !== "object" ||
      typeof stream.getReader !== "function"
    ) {
      throw transportError(
        `indexer response for ${method} ${path} cannot be safely bounded because it has no readable byte stream`,
        "INVALID_RESPONSE",
        { status: response.status },
      );
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw transportError(
            `indexer response for ${method} ${path} returned a non-byte stream chunk`,
            "INVALID_RESPONSE",
            { status: response.status },
          );
        }
        total += value.byteLength;
        if (total > maxResponseBytes) {
          await reader
            .cancel?.("indexer response exceeds configured byte limit")
            .catch(() => undefined);
          throw transportError(
            `indexer response for ${method} ${path} exceeds the configured limit of ${maxResponseBytes} bytes`,
            "RESPONSE_TOO_LARGE",
            { status: response.status },
          );
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join("");
    } finally {
      reader.releaseLock?.();
    }
  }

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

    const controller = new AbortController();
    const abortedFailure = () =>
      transportError(
        `indexer request was aborted (${method} ${path})`,
        "ABORTED",
      );
    let rejectOuterAbort: ((reason: IndexerError) => void) | undefined;
    const outerAbort = new Promise<never>((_resolve, reject) => {
      rejectOuterAbort = reject;
    });
    const onOuterAbort = () => {
      controller.abort(options.signal?.reason);
      rejectOuterAbort?.(abortedFailure());
    };
    if (options.signal?.aborted) onOuterAbort();
    else
      options.signal?.addEventListener("abort", onOuterAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = () =>
      transportError(
        `indexer request timed out after ${timeoutMs}ms (${method} ${path})`,
        "TIMEOUT",
      );
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutFailure());
      }, timeoutMs);
    });

    const perform = async (): Promise<Record<string, unknown>> => {
      let response: Awaited<ReturnType<IndexerFetchLike>>;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (cause) {
        if (controller.signal.aborted) {
          if (options.signal?.aborted) {
            throw transportError(
              `indexer request was aborted (${method} ${path})`,
              "ABORTED",
              { cause },
            );
          }
          throw timeoutFailure();
        }
        throw transportError(
          `indexer at ${baseUrl} could not be reached (${method} ${path}: the fetch failed before an HTTP response)`,
          "NETWORK_ERROR",
          { cause },
        );
      }
      if (controller.signal.aborted) {
        throw options.signal?.aborted
          ? transportError(
              `indexer request was aborted (${method} ${path})`,
              "ABORTED",
            )
          : timeoutFailure();
      }

      let bodyText: string;
      try {
        bodyText = await readBoundedText(response, method, path);
      } catch (cause) {
        if (cause instanceof IndexerError) throw cause;
        if (controller.signal.aborted) {
          throw options.signal?.aborted ? abortedFailure() : timeoutFailure();
        }
        throw transportError(
          `indexer response for ${method} ${path} could not be read safely`,
          "INVALID_RESPONSE",
          { status: response.status, cause },
        );
      }

      if (!response.ok) {
        let parsed: unknown = null;
        if (bodyText !== "") {
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
              "",
          {
            status: response.status,
            code: envelope?.code ?? `HTTP_${response.status}`,
          },
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(bodyText) as unknown;
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
    };

    try {
      return await Promise.race([perform(), timeout, outerAbort]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onOuterAbort);
    }
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

  function invalidResponse(
    context: string,
    detail: string,
    cause?: unknown,
  ): never {
    throw new IndexerError(
      `indexer returned an invalid ${context} response: ${detail}`,
      {
        status: 200,
        code: "INVALID_RESPONSE",
        ...(cause !== undefined ? { cause } : {}),
      },
    );
  }

  function record(value: unknown, context: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalidResponse(context, "expected a JSON object");
    }
    return value as Record<string, unknown>;
  }

  function stringValue(
    value: unknown,
    context: string,
    allowEmpty = false,
  ): string {
    if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
      return invalidResponse(context, "expected a string");
    }
    return value;
  }

  function integerValue(value: unknown, context: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
      return invalidResponse(context, `expected a safe integer >= ${minimum}`);
    }
    return value as number;
  }

  function addressValue(value: unknown, context: string): Address {
    try {
      return parseCanonicalAddress(value);
    } catch (cause) {
      return invalidResponse(
        context,
        "expected a canonical Solana address",
        cause,
      );
    }
  }

  function signatureValue(value: unknown, context: string): string {
    if (!isCanonicalSignature(value)) {
      return invalidResponse(
        context,
        "expected a canonical 64-byte base58 signature",
      );
    }
    return value;
  }

  function decimalValue(value: unknown, context: string): string {
    if (typeof value !== "string" || !DECIMAL.test(value)) {
      return invalidResponse(
        context,
        "expected an unsigned canonical decimal string",
      );
    }
    return value;
  }

  function signedDecimalValue(value: unknown, context: string): string {
    if (typeof value !== "string" || !SIGNED_DECIMAL.test(value)) {
      return invalidResponse(
        context,
        "expected a canonical signed decimal string",
      );
    }
    return value;
  }

  function hexValue(value: unknown, context: string): string {
    if (typeof value !== "string" || !HEX_64.test(value)) {
      return invalidResponse(context, "expected 64 lowercase hex characters");
    }
    return value;
  }

  function base64Value(value: unknown, context: string): string {
    if (typeof value !== "string") {
      return invalidResponse(context, "expected base64 text");
    }
    try {
      decodeCanonicalBase64(value);
    } catch (cause) {
      return invalidResponse(context, "expected canonical base64", cause);
    }
    return value;
  }

  function stringArray(value: unknown, context: string): string[] {
    if (
      !Array.isArray(value) ||
      !value.every((entry) => typeof entry === "string")
    ) {
      return invalidResponse(context, "expected an array of strings");
    }
    return [...value] as string[];
  }

  function validateListing(
    value: unknown,
    context = "listing",
  ): IndexerListing {
    const item = record(value, context);
    const pda = addressValue(item.pda, `${context}.pda`);
    const accountData = base64Value(item.accountData, `${context}.accountData`);
    let decodedAccount: ServiceListing;
    try {
      const bytes = decodeCanonicalBase64(accountData);
      const [decoded, offset] = getServiceListingDecoder().read(bytes, 0);
      if (
        offset !== bytes.length ||
        !bytesEqual(
          new Uint8Array(decoded.discriminator),
          new Uint8Array(SERVICE_LISTING_DISCRIMINATOR),
        )
      ) {
        throw new Error(
          "ServiceListing discriminator or encoded length is invalid",
        );
      }
      decodedAccount = decoded;
    } catch (cause) {
      return invalidResponse(
        `${context}.accountData`,
        "could not decode ServiceListing bytes",
        cause,
      );
    }
    const decodedRaw = record(item.decoded, `${context}.decoded`);
    const state = decodedRaw.state;
    if (
      !(
        (typeof state === "number" &&
          Number.isInteger(state) &&
          state in ListingState) ||
        (typeof state === "string" &&
          Object.prototype.hasOwnProperty.call(ListingState, state) &&
          typeof ListingState[state as keyof typeof ListingState] === "number")
      )
    ) {
      invalidResponse(`${context}.decoded.state`, "unsupported ListingState");
    }
    const decoded: IndexerListingDecoded = {
      provider: addressValue(
        decodedRaw.provider,
        `${context}.decoded.provider`,
      ),
      authority: addressValue(
        decodedRaw.authority,
        `${context}.decoded.authority`,
      ),
      name: stringValue(decodedRaw.name, `${context}.decoded.name`, true),
      category: stringValue(
        decodedRaw.category,
        `${context}.decoded.category`,
        true,
      ),
      tags: stringArray(decodedRaw.tags, `${context}.decoded.tags`),
      specHash: hexValue(decodedRaw.specHash, `${context}.decoded.specHash`),
      specUri: stringValue(decodedRaw.specUri, `${context}.decoded.specUri`),
      price: decimalValue(decodedRaw.price, `${context}.decoded.price`),
      priceMint:
        decodedRaw.priceMint === null
          ? null
          : addressValue(decodedRaw.priceMint, `${context}.decoded.priceMint`),
      state: state as IndexerListingDecoded["state"],
      maxOpenJobs: integerValue(
        decodedRaw.maxOpenJobs,
        `${context}.decoded.maxOpenJobs`,
      ),
      openJobs: integerValue(
        decodedRaw.openJobs,
        `${context}.decoded.openJobs`,
      ),
      totalHires: decimalValue(
        decodedRaw.totalHires,
        `${context}.decoded.totalHires`,
      ),
      version: decimalValue(decodedRaw.version, `${context}.decoded.version`),
      createdAt: signedDecimalValue(
        decodedRaw.createdAt,
        `${context}.decoded.createdAt`,
      ),
      updatedAt: signedDecimalValue(
        decodedRaw.updatedAt,
        `${context}.decoded.updatedAt`,
      ),
    };
    // The projection is convenient but must never contradict the authenticated
    // account bytes it accompanies. Check every directly comparable field.
    const decodedState =
      typeof decoded.state === "number"
        ? decoded.state
        : ListingState[decoded.state as keyof typeof ListingState];
    if (
      decoded.provider !== decodedAccount.providerAgent ||
      decoded.authority !== decodedAccount.authority ||
      decoded.specHash !==
        Array.from(decodedAccount.specHash, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("") ||
      decoded.specUri !== decodedAccount.specUri ||
      decoded.price !== decodedAccount.price.toString() ||
      decoded.priceMint !==
        (isNone(decodedAccount.priceMint)
          ? null
          : decodedAccount.priceMint.value) ||
      decodedState !== decodedAccount.state ||
      decoded.maxOpenJobs !== decodedAccount.maxOpenJobs ||
      decoded.openJobs !== decodedAccount.openJobs ||
      decoded.totalHires !== decodedAccount.totalHires.toString() ||
      decoded.version !== decodedAccount.version.toString() ||
      decoded.createdAt !== decodedAccount.createdAt.toString() ||
      decoded.updatedAt !== decodedAccount.updatedAt.toString()
    ) {
      invalidResponse(
        `${context}.decoded`,
        "projection disagrees with ServiceListing account bytes",
      );
    }
    if (typeof item.metadataValid !== "boolean") {
      invalidResponse(`${context}.metadataValid`, "expected boolean");
    }
    return {
      pda,
      accountData,
      decoded,
      metadataValid: item.metadataValid,
      metadataIssues: stringArray(
        item.metadataIssues,
        `${context}.metadataIssues`,
      ),
      lastSlot: integerValue(item.lastSlot, `${context}.lastSlot`),
      lastSignature: signatureValue(
        item.lastSignature,
        `${context}.lastSignature`,
      ),
    };
  }

  function validateHire(value: unknown, context: string): IndexerHire {
    const hire = record(value, context);
    const accountData = base64Value(hire.accountData, `${context}.accountData`);
    let decodedAccount: ReturnType<
      ReturnType<typeof getHireRecordDecoder>["decode"]
    >;
    try {
      const bytes = decodeCanonicalBase64(accountData);
      const [decoded, offset] = getHireRecordDecoder().read(bytes, 0);
      if (
        offset !== bytes.length ||
        !bytesEqual(
          new Uint8Array(decoded.discriminator),
          new Uint8Array(HIRE_RECORD_DISCRIMINATOR),
        )
      ) {
        throw new Error(
          "HireRecord discriminator or encoded length is invalid",
        );
      }
      decodedAccount = decoded;
    } catch (cause) {
      return invalidResponse(
        `${context}.accountData`,
        "could not decode HireRecord bytes",
        cause,
      );
    }
    const taskPda = addressValue(hire.taskPda, `${context}.taskPda`);
    const listing = addressValue(hire.listing, `${context}.listing`);
    if (decodedAccount.task !== taskPda || decodedAccount.listing !== listing) {
      invalidResponse(
        `${context}.accountData`,
        "HireRecord bytes disagree with taskPda/listing metadata",
      );
    }
    return {
      taskPda,
      hireRecordPda: addressValue(
        hire.hireRecordPda,
        `${context}.hireRecordPda`,
      ),
      accountData,
      buyer: addressValue(hire.buyer, `${context}.buyer`),
      listing,
      price: decimalValue(hire.price, `${context}.price`),
      slot: integerValue(hire.slot, `${context}.slot`),
      signature: signatureValue(hire.signature, `${context}.signature`),
    };
  }

  function validateSlash(value: unknown, context: string): IndexerSlashEvent {
    const slash = record(value, context);
    const amount = slash.amount;
    if (
      amount !== undefined &&
      !(
        (typeof amount === "string" && DECIMAL.test(amount)) ||
        (Number.isSafeInteger(amount) && (amount as number) >= 0)
      )
    ) {
      invalidResponse(
        `${context}.amount`,
        "expected unsigned decimal or safe integer",
      );
    }
    return {
      slot: integerValue(slash.slot, `${context}.slot`),
      signature: signatureValue(slash.signature, `${context}.signature`),
      ...(amount !== undefined ? { amount: amount as string | number } : {}),
    };
  }

  function parseU64Input(value: bigint | string, context: string): bigint {
    let parsed: bigint;
    try {
      if (typeof value === "string" && !DECIMAL.test(value)) throw new Error();
      parsed = BigInt(value);
    } catch {
      throw new TypeError(`${context} must be an unsigned decimal u64`);
    }
    if (parsed < 0n || parsed > 18_446_744_073_709_551_615n) {
      throw new TypeError(`${context} must fit in an unsigned u64`);
    }
    return parsed;
  }

  function parseHexBytes(value: string, context: string): Uint8Array {
    if (!HEX_64.test(value)) {
      throw new TypeError(`${context} must be 64 lowercase hex characters`);
    }
    return Uint8Array.from(value.match(/../g)!, (part) =>
      Number.parseInt(part, 16),
    );
  }

  function validateBuildResult(
    body: Record<string, unknown>,
  ): BuildHireTransactionResult {
    const transaction = base64Value(body.transaction, "hire.transaction");
    const blockhash = stringValue(body.blockhash, "hire.blockhash");
    try {
      const decoded = new Uint8Array(getBase58Encoder().encode(blockhash));
      if (
        decoded.length !== 32 ||
        getBase58Decoder().decode(decoded) !== blockhash
      ) {
        throw new Error();
      }
    } catch (cause) {
      invalidResponse(
        "hire.blockhash",
        "expected a canonical 32-byte base58 blockhash",
        cause,
      );
    }
    return {
      transaction,
      blockhash,
      lastValidBlockHeight: integerValue(
        body.lastValidBlockHeight,
        "hire.lastValidBlockHeight",
        1,
      ),
      taskPda: addressValue(body.taskPda, "hire.taskPda"),
      escrowPda: addressValue(body.escrowPda, "hire.escrowPda"),
      hireRecordPda: addressValue(body.hireRecordPda, "hire.hireRecordPda"),
      taskId: hexValue(body.taskId, "hire.taskId"),
    };
  }

  async function verifyBuiltHireTransaction(
    params: BuildHireTransactionParams,
    result: BuildHireTransactionResult,
  ): Promise<void> {
    const buyer = parseCanonicalAddress(String(params.buyer));
    const listing = parseCanonicalAddress(String(params.listing));
    const creatorAgent = parseCanonicalAddress(String(params.creatorAgent));
    const expectedPrice = parseU64Input(params.expectedPrice, "expectedPrice");
    const expectedVersion = parseU64Input(
      params.expectedVersion,
      "expectedVersion",
    );
    const taskIdHex = params.taskId ?? result.taskId;
    if (params.taskId !== undefined && params.taskId !== result.taskId) {
      throw transportError(
        "indexer hire metadata taskId disagrees with the requested taskId",
        "INVALID_TRANSACTION",
        { status: 200 },
      );
    }
    const taskId = parseHexBytes(taskIdHex, "taskId");
    const listingSpecHash =
      params.listingSpecHash === undefined
        ? undefined
        : parseHexBytes(params.listingSpecHash, "listingSpecHash");

    let wire: Uint8Array;
    let transaction: Transaction;
    try {
      wire = decodeCanonicalBase64(result.transaction);
      transaction = getTransactionDecoder().decode(wire);
      if (
        !bytesEqual(
          new Uint8Array(getTransactionEncoder().encode(transaction)),
          wire,
        )
      ) {
        throw new Error(
          "transaction codec did not consume the exact wire bytes",
        );
      }
    } catch (cause) {
      throw transportError(
        "indexer returned malformed Solana transaction bytes",
        "INVALID_TRANSACTION",
        { status: 200, cause },
      );
    }

    try {
      const signatureEntries = Object.entries(transaction.signatures);
      if (
        signatureEntries.length !== 1 ||
        signatureEntries[0]?.[0] !== buyer ||
        signatureEntries[0]?.[1] !== null
      ) {
        throw new Error(
          "transaction must be unsigned and require only the buyer signature",
        );
      }
      const message = getCompiledTransactionMessageDecoder().decode(
        transaction.messageBytes,
      );
      if (message.version !== 0)
        throw new Error("transaction must use message v0");
      if (message.staticAccounts[0] !== buyer)
        throw new Error("buyer is not fee payer");
      if (String(message.lifetimeToken) !== result.blockhash) {
        throw new Error("wire blockhash disagrees with response metadata");
      }
      if (
        message.addressTableLookups &&
        message.addressTableLookups.length > 0
      ) {
        throw new Error("address table lookups are not allowed");
      }
      if (message.instructions.length !== 1) {
        throw new Error("exactly one instruction is required");
      }
      const instruction = message.instructions[0]!;
      if (
        message.staticAccounts[instruction.programAddressIndex] !==
        AGENC_COORDINATION_PROGRAM_ADDRESS
      ) {
        throw new Error("instruction targets the wrong program");
      }
      const data = instruction.data;
      if (data === undefined || data.length !== 91) {
        throw new Error(
          "instruction has invalid hire_from_listing data length",
        );
      }
      const decoded = getHireFromListingInstructionDataDecoder().decode(data);
      if (
        !bytesEqual(
          new Uint8Array(decoded.discriminator),
          new Uint8Array(HIRE_FROM_LISTING_DISCRIMINATOR),
        )
      ) {
        throw new Error("instruction discriminator is not hire_from_listing");
      }
      if (
        !bytesEqual(new Uint8Array(decoded.taskId), taskId) ||
        decoded.expectedPrice !== expectedPrice ||
        decoded.expectedVersion !== expectedVersion ||
        !isNone(decoded.referrer) ||
        decoded.referrerFeeBps !== 0
      ) {
        throw new Error("instruction terms disagree with requested intent");
      }
      const indices = instruction.accountIndices ?? [];
      if (indices.length !== 15)
        throw new Error("hire instruction must have exactly 15 accounts");
      const instructionAccounts = indices.map((index) => {
        const account = message.staticAccounts[index];
        if (account === undefined)
          throw new Error("instruction account index is out of bounds");
        return account;
      });
      if (
        new Set(message.staticAccounts).size !== message.staticAccounts.length
      ) {
        throw new Error("transaction contains duplicate static accounts");
      }
      const expectedWritable = [
        true,
        true,
        true,
        true,
        false,
        true,
        false,
        false,
        false,
        false,
        false,
        true,
        true,
        true,
        false,
      ];
      for (let position = 0; position < indices.length; position += 1) {
        const staticIndex = indices[position]!;
        const isSigner = staticIndex < message.header.numSignerAccounts;
        const isWritable = isSigner
          ? staticIndex <
            message.header.numSignerAccounts -
              message.header.numReadonlySignerAccounts
          : staticIndex <
            message.staticAccounts.length -
              message.header.numReadonlyNonSignerAccounts;
        const expectedSigner = position === 12 || position === 13;
        if (
          isSigner !== expectedSigner ||
          isWritable !== expectedWritable[position]
        ) {
          throw new Error(
            `instruction account ${position} has unexpected signer/write privileges`,
          );
        }
      }
      const programIndex = instruction.programAddressIndex;
      if (
        programIndex < message.header.numSignerAccounts ||
        programIndex <
          message.staticAccounts.length -
            message.header.numReadonlyNonSignerAccounts
      ) {
        throw new Error("program account must be readonly and non-signing");
      }

      const [taskPda] = await findTaskPda({ creator: buyer, taskId });
      const [
        [escrowPda],
        [hireRecordPda],
        [protocolConfig],
        [moderationConfig],
        [rateLimit],
      ] = await Promise.all([
        findEscrowPda({ task: taskPda }),
        findHireRecordPda({ task: taskPda }),
        findProtocolConfigPda(),
        findModerationConfigPda(),
        findAuthorityRateLimitPda({ authority: buyer }),
      ]);
      const expectedKnown = new Map<number, Address>([
        [0, taskPda],
        [1, escrowPda],
        [2, hireRecordPda],
        [3, listing],
        [5, protocolConfig],
        [6, moderationConfig],
        [10, creatorAgent],
        [11, rateLimit],
        [12, buyer],
        [13, buyer],
        [14, address("11111111111111111111111111111111")],
      ]);
      for (const [index, expected] of expectedKnown) {
        if (instructionAccounts[index] !== expected) {
          throw new Error(
            `instruction account ${index} disagrees with intended PDA/address`,
          );
        }
      }
      if (
        result.taskPda !== taskPda ||
        result.escrowPda !== escrowPda ||
        result.hireRecordPda !== hireRecordPda
      ) {
        throw new Error("response metadata disagrees with derived PDAs");
      }
      const providerAgent = instructionAccounts[4]!;
      const moderator = decoded.moderator;
      if (listingSpecHash !== undefined) {
        const [[listingModeration], [moderationBlock], [moderationAttestor]] =
          await Promise.all([
            findListingModerationPda({
              listing,
              jobSpecHash: listingSpecHash,
              moderator,
            }),
            findModerationBlockPda({ contentHash: listingSpecHash }),
            findModerationAttestorPda({ attestor: moderator }),
          ]);
        if (instructionAccounts[7] !== listingModeration) {
          throw new Error(
            "listing moderation PDA disagrees with listing/spec/moderator",
          );
        }
        if (
          instructionAccounts[8] !== AGENC_COORDINATION_PROGRAM_ADDRESS &&
          instructionAccounts[8] !== moderationAttestor
        ) {
          throw new Error(
            "moderation attestor account is neither canonical path",
          );
        }
        if (instructionAccounts[9] !== moderationBlock) {
          throw new Error(
            "moderation block PDA disagrees with listing spec hash",
          );
        }
      }
      const allowedStatic = new Set<Address>([
        AGENC_COORDINATION_PROGRAM_ADDRESS,
        ...instructionAccounts,
      ]);
      if (
        message.staticAccounts.some((account) => !allowedStatic.has(account))
      ) {
        throw new Error(
          "transaction contains unused or unexplained static accounts",
        );
      }

      try {
        await options.verifyHireTransaction!({
          params,
          result,
          transaction,
          instructionAccounts,
          providerAgent,
          moderator,
        });
      } catch (cause) {
        throw transportError(
          "independent hire transaction verification failed",
          "TRANSACTION_VERIFICATION_FAILED",
          { status: 200, cause },
        );
      }
    } catch (cause) {
      if (cause instanceof IndexerError) throw cause;
      throw transportError(
        "indexer hire transaction does not exactly match the requested intent",
        "INVALID_TRANSACTION",
        { status: 200, cause },
      );
    }
  }

  async function listings(
    query: IndexerListingsQuery = {},
  ): Promise<IndexerListingsPage> {
    if (
      query.page !== undefined &&
      (!Number.isSafeInteger(query.page) || query.page < 1)
    ) {
      throw new TypeError(
        "indexer.listings: page must be a positive safe integer",
      );
    }
    if (
      query.pageSize !== undefined &&
      (!Number.isSafeInteger(query.pageSize) ||
        query.pageSize < 1 ||
        query.pageSize > 1000)
    ) {
      throw new TypeError(
        "indexer.listings: pageSize must be a safe integer in 1..1000",
      );
    }
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
    const page = integerValue(body.page, "listings.page", 1);
    const pageSize = integerValue(body.pageSize, "listings.pageSize");
    const total = integerValue(body.total, "listings.total");
    const rawItems = requireArray(body, "items", "listings");
    if (rawItems.length > pageSize || rawItems.length > total) {
      invalidResponse("listings.items", "item count exceeds pageSize/total");
    }
    if (query.page !== undefined && page !== query.page) {
      throw transportError(
        `indexer pagination did not advance: requested page ${query.page}, received page ${page}`,
        "PAGINATION_NO_PROGRESS",
        { status: 200 },
      );
    }
    return {
      page,
      pageSize,
      total,
      items: rawItems.map((item, index) =>
        validateListing(item, `listings.items[${index}]`),
      ),
    };
  }

  return {
    listings,

    async getListing(pda) {
      const body = await request(
        "GET",
        `/api/explorer/listings/${encodeURIComponent(String(pda))}`,
      );
      const listing = validateListing(body.listing);
      if (listing.pda !== String(pda)) {
        invalidResponse("listing.pda", "does not match the requested listing");
      }
      return listing;
    },

    async listingHires(pda) {
      const body = await request(
        "GET",
        `/api/explorer/listings/${encodeURIComponent(String(pda))}/hires`,
      );
      return requireArray(body, "items", "listing-hires").map((item, index) => {
        const hire = validateHire(item, `listing-hires.items[${index}]`);
        if (hire.listing !== String(pda)) {
          invalidResponse(
            `listing-hires.items[${index}].listing`,
            "does not match the requested listing",
          );
        }
        return hire;
      });
    },

    async agentTrackRecord(pda) {
      const body = await request(
        "GET",
        `/api/explorer/agents/${encodeURIComponent(String(pda))}/track-record`,
      );
      if (body.source !== "events") {
        invalidResponse("track-record.source", 'expected "events"');
      }
      const agent = addressValue(body.agent, "track-record.agent");
      if (agent !== String(pda)) {
        invalidResponse("track-record.agent", "does not match requested agent");
      }
      return {
        agent,
        completions: integerValue(body.completions, "track-record.completions"),
        disputesInitiated: integerValue(
          body.disputesInitiated,
          "track-record.disputesInitiated",
        ),
        disputesLost: integerValue(
          body.disputesLost,
          "track-record.disputesLost",
        ),
        slashHistory: requireArray(body, "slashHistory", "track-record").map(
          (item, index) =>
            validateSlash(item, `track-record.slashHistory[${index}]`),
        ),
        source: "events",
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
      const collectedAddresses = new Set<string>();
      let previousTotal: number | undefined;
      for (let page = 1; page <= maxPages; page += 1) {
        const result = await listings({ ...params, page });
        if (result.page !== page) {
          throw transportError(
            `indexer pagination did not advance: requested page ${page}, received page ${result.page}`,
            "PAGINATION_NO_PROGRESS",
            { status: 200 },
          );
        }
        if (previousTotal !== undefined && result.total !== previousTotal) {
          throw transportError(
            `indexer pagination total changed from ${previousTotal} to ${result.total}`,
            "PAGINATION_NO_PROGRESS",
            { status: 200 },
          );
        }
        previousTotal = result.total;
        if (result.total > maxItems) {
          throw transportError(
            `indexer pagination total ${result.total} exceeds maxItems ${maxItems}`,
            "PAGINATION_LIMIT",
            { status: 200 },
          );
        }
        for (const item of result.items) {
          if (collectedAddresses.has(item.pda)) {
            throw transportError(
              `indexer pagination repeated listing ${item.pda}`,
              "PAGINATION_NO_PROGRESS",
              { status: 200 },
            );
          }
          collectedAddresses.add(item.pda);
          collected.push({
            address: item.pda as Address,
            account: decoder.decode(
              new Uint8Array(base64Encoder.encode(item.accountData)),
            ),
          });
          if (collected.length > maxItems) {
            throw transportError(
              `indexer pagination exceeded maxItems ${maxItems}`,
              "PAGINATION_LIMIT",
              { status: 200 },
            );
          }
        }
        if (collected.length > result.total) {
          throw transportError(
            `indexer pagination returned ${collected.length} items for total ${result.total}`,
            "PAGINATION_NO_PROGRESS",
            { status: 200 },
          );
        }
        if (collected.length === result.total) {
          break;
        }
        if (result.items.length === 0 || result.pageSize === 0) {
          throw transportError(
            `indexer pagination made no progress at page ${page}`,
            "PAGINATION_NO_PROGRESS",
            { status: 200 },
          );
        }
        if (page === maxPages) {
          throw transportError(
            `indexer pagination exceeded maxPages ${maxPages}`,
            "PAGINATION_LIMIT",
            { status: 200 },
          );
        }
      }
      // State is refined CLIENT-SIDE over the decoded bytes — identical
      // semantics (and default) to the queries module.
      const wantState = options.state ?? ListingState.Active;
      return collected.filter(({ account }) => account.state === wantState);
    },

    async buildHireTransaction(params) {
      if (options.verifyHireTransaction === undefined) {
        throw transportError(
          "buildHireTransaction requires createIndexerClient({ verifyHireTransaction }) so server-built bytes cannot cross the signing boundary unverified",
          "TRANSACTION_VERIFIER_REQUIRED",
        );
      }
      const buyer = parseCanonicalAddress(String(params.buyer));
      const listing = parseCanonicalAddress(String(params.listing));
      const creatorAgent = parseCanonicalAddress(String(params.creatorAgent));
      parseU64Input(params.expectedPrice, "expectedPrice");
      parseU64Input(params.expectedVersion, "expectedVersion");
      if (params.taskId !== undefined) parseHexBytes(params.taskId, "taskId");
      if (params.listingSpecHash !== undefined) {
        parseHexBytes(params.listingSpecHash, "listingSpecHash");
      }
      const body = await request("POST", "/v1/hires", {
        body: {
          buyer,
          listing,
          ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
          expectedPrice: String(params.expectedPrice),
          expectedVersion: String(params.expectedVersion),
          ...(params.listingSpecHash !== undefined
            ? { listingSpecHash: params.listingSpecHash }
            : {}),
          creatorAgent,
        },
      });
      let result: BuildHireTransactionResult;
      try {
        result = validateBuildResult(body);
      } catch (cause) {
        throw transportError(
          "indexer returned malformed hire transaction metadata",
          "INVALID_TRANSACTION",
          { status: 200, cause },
        );
      }
      await verifyBuiltHireTransaction(params, result);
      return result;
    },

    async registerWebhook(params) {
      let webhookUrl: URL;
      try {
        webhookUrl = new URL(params.url);
      } catch {
        throw new TypeError(
          "registerWebhook: url must be an absolute HTTPS URL",
        );
      }
      if (
        webhookUrl.protocol !== "https:" ||
        webhookUrl.username !== "" ||
        webhookUrl.password !== "" ||
        webhookUrl.hash !== ""
      ) {
        throw new TypeError(
          "registerWebhook: url must use HTTPS without credentials or a fragment",
        );
      }
      if (
        params.events !== undefined &&
        (!Array.isArray(params.events) ||
          params.events.length > 100 ||
          params.events.some(
            (event) => typeof event !== "string" || event.length === 0,
          ))
      ) {
        throw new TypeError(
          "registerWebhook: events must be at most 100 non-empty strings",
        );
      }
      const body = await request("POST", "/v1/webhooks", {
        body: {
          url: params.url,
          ...(params.events !== undefined ? { events: params.events } : {}),
        },
      });
      return {
        id: stringValue(body.id, "register-webhook.id"),
        secret: stringValue(body.secret, "register-webhook.secret"),
      };
    },

    async listWebhooks() {
      const body = await request("GET", "/v1/webhooks");
      return requireArray(body, "items", "webhooks").map((value, index) => {
        const webhook = record(value, `webhooks.items[${index}]`);
        const url = stringValue(webhook.url, `webhooks.items[${index}].url`);
        try {
          new URL(url);
        } catch (cause) {
          invalidResponse(
            `webhooks.items[${index}].url`,
            "expected an absolute URL",
            cause,
          );
        }
        return {
          id: stringValue(webhook.id, `webhooks.items[${index}].id`),
          url,
          events: stringArray(
            webhook.events,
            `webhooks.items[${index}].events`,
          ),
        };
      });
    },

    async deleteWebhook(id) {
      if (typeof id !== "string" || id.length === 0 || id.length > 256) {
        throw new TypeError(
          "deleteWebhook: id must be a non-empty string <= 256 chars",
        );
      }
      await request("DELETE", `/v1/webhooks/${encodeURIComponent(id)}`);
    },

    async listEvents(options = {}) {
      if (
        options.limit !== undefined &&
        (!Number.isSafeInteger(options.limit) ||
          options.limit < 1 ||
          options.limit > 1000)
      ) {
        throw new TypeError(
          "listEvents: limit must be a safe integer in 1..1000",
        );
      }
      const body = await request("GET", "/v1/events", {
        params: { after: options.after, limit: options.limit },
      });
      return requireArray(body, "items", "events").map((value, index) => {
        const event = record(value, `events.items[${index}]`);
        const createdAt = stringValue(
          event.createdAt,
          `events.items[${index}].createdAt`,
        );
        if (!Number.isFinite(Date.parse(createdAt))) {
          invalidResponse(
            `events.items[${index}].createdAt`,
            "expected an ISO date-time",
          );
        }
        return {
          id: stringValue(event.id, `events.items[${index}].id`),
          type: stringValue(event.type, `events.items[${index}].type`),
          createdAt,
          data: event.data,
        };
      });
    },
  };
}
