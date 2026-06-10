/**
 * Indexer — the typed client for the hosted indexer/read API (PLAN.md P3.2):
 * the **scale path** for reads that raw `getProgramAccounts` cannot serve on
 * restricted RPC providers, plus the no-RPC hire transaction builder and
 * webhook management.
 *
 * Decode parity with the gPA `queries` module is the design invariant: every
 * listing response carries the full raw account bytes (`accountData`,
 * base64), and {@link createIndexerClient}'s `listActiveListings` decodes
 * them with the same generated decoder — same return shape, swap-in
 * transport.
 *
 * SUBSET CAVEAT: the hosted read model excludes metadata-nonconforming
 * listings (`metadataValid: false`) from its default queries, so
 * `listActiveListings` is a drop-in for the default valid-only view but can
 * return a SUBSET of what raw gPA returns. To also see nonconforming
 * listings, query `listings({ metadataValid: false })` or use the gPA
 * `queries` module (which applies no metadata filter).
 *
 * Browser-safe: fetch + `@solana/kit` codecs only — no Node built-ins.
 *
 * @module indexer
 */
export {
  createIndexerClient,
  type BuildHireTransactionParams,
  type BuildHireTransactionResult,
  type CreateIndexerClientOptions,
  type IndexerAgentTrackRecord,
  type IndexerClient,
  type IndexerEvent,
  type IndexerFetchLike,
  type IndexerHire,
  type IndexerListActiveListingsOptions,
  type IndexerListing,
  type IndexerListingDecoded,
  type IndexerListingsPage,
  type IndexerListingsQuery,
  type IndexerSlashEvent,
  type IndexerWebhook,
  type ListIndexerEventsOptions,
  type RegisterWebhookParams,
  type RegisterWebhookResult,
} from "./client.js";
export { IndexerError } from "./errors.js";
