/**
 * Query layer — typed `getProgramAccounts` helpers (the trustless gPA read path).
 *
 * "List active listings / open tasks / my claims" in one call, decoded with the
 * generated account decoders and filtered with discriminator + field-offset
 * memcmp filters.
 *
 * ## LOUD OPERATIONAL WARNING
 *
 * Raw `getProgramAccounts` is **RPC-provider-dependent**: many public RPC
 * providers disable it outright or restrict it to paid tiers, and even where
 * enabled it scans every program account server-side. It is the **trustless**
 * read path, not the scale path. The **Phase-3 hosted indexer API is the scale
 * path** — it implements the same {@link ProgramAccountsTransport} seam, so
 * every helper here (same call signatures, same return shapes) will work over
 * it unchanged. Build against these helpers now; swap the transport later.
 *
 * @example
 * ```ts
 * import { createSolanaRpc } from "@solana/kit";
 * import { listActiveListings, listOpenTasks } from "@tetsuo-ai/marketplace-sdk";
 *
 * const rpc = createSolanaRpc("https://your-gpa-enabled-rpc");
 * const listings = await listActiveListings(rpc, { category: "code" });
 * const tasks = await listOpenTasks(rpc, { capabilities: 1n });
 * ```
 *
 * @module queries
 */
export {
  createRpcProgramAccountsTransport,
  resolveProgramAccountsTransport,
  type GpaFilter,
  type ProgramAccountsSource,
  type ProgramAccountsTransport,
} from "./transport.js";
export {
  ANCHOR_DISCRIMINATOR_SIZE,
  HIRE_RECORD_TASK_OFFSET,
  SERVICE_LISTING_AUTHORITY_OFFSET,
  SERVICE_LISTING_CATEGORY_OFFSET,
  SERVICE_LISTING_PROVIDER_AGENT_OFFSET,
  TASK_BID_TASK_OFFSET,
  TASK_CLAIM_TASK_OFFSET,
  TASK_CLAIM_WORKER_OFFSET,
  TASK_CREATOR_OFFSET,
  TASK_STATUS_OFFSET,
} from "./offsets.js";
export {
  bidsByTask,
  listActiveListings,
  listClaimsForWorker,
  listHireRecordsForBuyer,
  listingsByProvider,
  listOpenTasks,
  type DecodedProgramAccount,
  type ListActiveListingsOptions,
  type ListOpenTasksOptions,
} from "./helpers.js";
