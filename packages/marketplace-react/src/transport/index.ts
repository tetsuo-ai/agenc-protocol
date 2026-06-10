/**
 * The read-transport abstraction — indexer-first with RPC/gPA fallback.
 *
 * `createReadTransport({ indexer?, rpc?, queryTransport? })` returns one
 * {@link ReadTransport}. When an indexer `baseUrl` is set it routes through the
 * SDK's `createIndexerClient` (the scale path); otherwise it falls back to the
 * SDK's gPA `listActiveListings` / account fetch (the trustless path). The two
 * backends return parity shapes BY SDK DESIGN, so callers never branch on which
 * one is live.
 *
 * `queryTransport` is a full override slot — pass a mock/pre-built transport
 * (tests, SSR fixtures) and it is used verbatim.
 *
 * SSR-safe: no `window`/`document` and no Node built-ins at module scope; the
 * SDK's indexer client is browser-safe (fetch + kit codecs only).
 *
 * @module transport
 */
import { address, isAddress } from "@solana/kit";
import {
  createIndexerClient,
  getServiceListingDecoder,
  listActiveListings as gpaListActiveListings,
  type IndexerClient,
} from "@tetsuo-ai/marketplace-sdk";
import { t } from "../strings/index.js";
import type {
  Address,
  CreateReadTransportConfig,
  GpaReadSource,
  IndexerConfig,
  ReadListingResult,
  ReadTransport,
} from "../types.js";
import type { CreateIndexerClientOptions } from "@tetsuo-ai/marketplace-sdk";

/**
 * Thrown when a gPA-fallback transport is asked for an indexer-only capability
 * (aggregated hires / track record have no trustless gPA equivalent).
 */
export class ReadTransportUnsupportedError extends Error {
  /** The unsupported operation name. */
  readonly operation: string;
  constructor(operation: string) {
    super(
      `Read operation "${operation}" requires the indexer backend; the gPA ` +
        `fallback has no trustless equivalent. Configure an indexer baseUrl on ` +
        `<AgencProvider> to use it.`,
    );
    this.name = "ReadTransportUnsupportedError";
    this.operation = operation;
  }
}

/** Coerce a string|Address PDA into a kit Address (validates base58). */
function toAddress(pda: Address | string): Address {
  if (typeof pda !== "string") return pda;
  if (!isAddress(pda)) {
    throw new TypeError(`Not a valid base58 Solana address: ${pda}`);
  }
  return address(pda);
}

/** Build the indexer-backed read transport. */
function indexerReadTransport(
  config: IndexerConfig,
  indexerClientOptions?: Partial<CreateIndexerClientOptions>,
): ReadTransport {
  const client: IndexerClient = createIndexerClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    ...(indexerClientOptions ?? {}),
  });
  return {
    kind: "indexer",
    listActiveListings: (options) => client.listActiveListings(options),
    async getListing(pda): Promise<ReadListingResult> {
      const listing = await client.getListing(pda);
      const account = getServiceListingDecoder().decode(
        base64ToBytes(listing.accountData),
      );
      return {
        address: toAddress(listing.pda),
        account,
        indexer: listing,
      };
    },
    listingHires: (pda) => client.listingHires(pda),
    agentTrackRecord: (pda) => client.agentTrackRecord(pda),
  };
}

/** Build the gPA-fallback read transport over a kit RPC / ProgramAccountsTransport. */
function gpaReadTransport(rpc: GpaReadSource): ReadTransport {
  return {
    kind: "gpa",
    listActiveListings: (options) => gpaListActiveListings(rpc, options),
    async getListing(pda): Promise<ReadListingResult> {
      // No single-account decode helper crosses the transport seam here, so we
      // scope the active-listings query down to the one PDA. (The indexer path
      // is the efficient one; this fallback is the trustless escape hatch.)
      const target = toAddress(pda);
      const all = await gpaListActiveListings(rpc, {});
      const hit = all.find((entry) => entry.address === target);
      if (hit === undefined) {
        throw new Error(
          `Listing ${pda} not found among active listings via the gPA ` +
            `fallback (it may be inactive, or your RPC restricts ` +
            `getProgramAccounts — use an indexer baseUrl for single-listing ` +
            `lookups).`,
        );
      }
      return { address: hit.address, account: hit.account };
    },
    listingHires() {
      return Promise.reject(new ReadTransportUnsupportedError("listingHires"));
    },
    agentTrackRecord() {
      return Promise.reject(
        new ReadTransportUnsupportedError("agentTrackRecord"),
      );
    },
  };
}

/** Browser-safe base64 → bytes (atob in browsers, Buffer in Node). */
function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // Node fallback — Buffer is always present there.
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

/**
 * Create the unified read transport.
 *
 * Resolution order:
 * 1. `queryTransport` override (wins — tests/mocks/SSR fixtures);
 * 2. `indexer.baseUrl` present → indexer-first transport;
 * 3. `rpc` present → gPA fallback transport;
 * 4. nothing configured → throws a descriptive error.
 *
 * @param config - See {@link CreateReadTransportConfig}.
 * @returns A {@link ReadTransport}.
 * @throws Error when no read source is configured.
 */
export function createReadTransport(
  config: CreateReadTransportConfig,
): ReadTransport {
  if (config.queryTransport) return config.queryTransport;
  if (config.indexer?.baseUrl) {
    return indexerReadTransport(config.indexer, config.indexerClientOptions);
  }
  if (config.rpc) return gpaReadTransport(config.rpc);
  throw new Error(t("transport.noReadSource"));
}

export type { ReadTransport } from "../types.js";
