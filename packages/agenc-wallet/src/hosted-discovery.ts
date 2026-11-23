import type { Address } from "@solana/kit";
import type { UriFetcher } from "@tetsuo-ai/agenc-worker";
import { getServiceListingDecoder, getServiceListingDiscriminatorBytes, ListingState } from "@tetsuo-ai/marketplace-sdk";
import { WalletError } from "./errors.js";
import { record, safeAddress, safeBigInt, finite, tidyText } from "./hosted-http.js";
import { NO_DETAILS, listingDetails, openDetailsCache, summarize, verifiedListingPayload, withoutLeadingName, type ListingDetails } from "./listing-details.js";
import type { CatalogRow, DetailsState, HostedServicesOptions, MarketServices } from "./services.js";
import { SERVICE_STATES, type ServiceState } from "./client/discovery.js";
import { createPagedIndex, type ReadJson } from "./paged-index.js";

const HEX64 = /^[0-9a-f]{64}$/;
const CATALOG_TTL_MS = 60_000;

const CATALOG_PAGE_SIZE = 100;
/** How long a provider's list of finished jobs is kept before it is read again. */
const FINISHED_TTL_MS = 10 * 60_000;
/** A provider's finished jobs are read in pages of this many, with no page cutoff. */
const FINISHED_PAGE = 100;

/**
 * The marketplace's read routes refuse a client that asks too often, so the
 * lists of finished jobs are read one at a time, this far apart.
 */
const DEFAULT_FINISHED_GAP_MS = 1_200;

/** A description that could not be read is tried again after this long. */
const DETAILS_RETRY_MS = 10 * 60_000;
/** Descriptions are read from their providers' hosts this many at a time. */
const DETAILS_AT_ONCE = 6;
const DEFAULT_DETAILS_WAIT_MS = 2_500;

/** A service as the marketplace's list gives it: no words yet, only where they are. */
interface ListedService {
  base: Pick<
    CatalogRow,
    | "listing"
    | "providerAgent"
    | "name"
    | "priceLamports"
    | "rating"
    | "ratingCount"
    | "jobsDone"
    | "deliverySecs"
    | "state"
    | "recordPending"
  >;
  listedTags: string[];
  /** Words the list itself carried, used when the description gives none. */
  listedCategory: string | null;
  listedSummary: string | null;
  /** The hash the listing committed its description to. */
  specHashHex: string | null;
  /** Where that description is published, when it is a public https address. */
  specUri: string | null;
}

function describedRow(
  entry: ListedService,
  details: ListingDetails,
  state: DetailsState,
): CatalogRow {
  return {
    ...entry.base,
    specHashHex: entry.specHashHex,
    category: details.category ?? entry.listedCategory,
    summary: summarize(entry.base.name, details.description) ?? entry.listedSummary,
    description:
      details.description === null ? null : withoutLeadingName(entry.base.name, details.description),
    tags: details.tags.length ? details.tags : entry.listedTags,
    inputs: details.inputs,
    outputs: details.outputs,
    terms: details.terms,
    details: state,
  };
}

/** The explorer's display projection omits terms kept in the encoded listing account. */
function explorerTerms(listing: Record<string, unknown>, terms: Record<string, unknown>) {
  const projected = { ...terms, pda: listing.pda, providerAgent: terms.provider, priceLamports: terms.price };
  if (listing.accountData === undefined) return projected;
  try {
    if (typeof listing.accountData !== "string") throw new Error("Missing listing bytes");
    const bytes = Buffer.from(listing.accountData, "base64");
    const [account, end] = getServiceListingDecoder().read(bytes, 0);
    if (end !== bytes.length || !getServiceListingDiscriminatorBytes().every((byte, i) => bytes[i] === byte)) {
      throw new Error("Invalid listing account");
    }
    return {
      ...projected,
      providerAgent: account.providerAgent,
      priceLamports: account.price.toString(),
      priceMint: account.priceMint.__option === "Some" ? account.priceMint.value : null,
      state: account.state,
      maxOpenJobs: account.maxOpenJobs,
      openJobs: account.openJobs,
      specHash: Buffer.from(account.specHash).toString("hex"),
      specUri: account.specUri,
      defaultDeadlineSecs: Number(account.defaultDeadlineSecs),
      ratingCount: account.ratingCount,
      rawRatingAverage: account.ratingCount > 0 ? Number(account.totalRating) / account.ratingCount : null,
    };
  } catch (cause) {
    throw new WalletError("NETWORK", "The service could not be read.", { cause });
  }
}

export function hostedDiscovery(options: HostedServicesOptions, read: ReadJson, publicFetcher: UriFetcher):
    Pick<MarketServices, "listServices" | "finishedJobs"> {
  const now = options.now ?? Date.now;
  const detailsCache = options.detailsCache ?? openDetailsCache({ now });
  const detailsWaitMs = Math.max(0, options.detailsWaitMs ?? DEFAULT_DETAILS_WAIT_MS);
  const finishedGapMs = Math.max(0, options.finishedGapMs ?? DEFAULT_FINISHED_GAP_MS);
  const finished = new Map<string, ReturnType<typeof finishedIndex>>();
  /** The last read of finished jobs, which the next one waits for. */
  let finishedTurn: Promise<unknown> = Promise.resolve();
  /** When the marketplace was last asked for a list of finished jobs (the real clock). */
  let finishedAskedAt = Number.NEGATIVE_INFINITY;

  /** When a description last failed to load, by hash and address. */
  const detailsFailedAt = new Map<string, number>();
  /** Descriptions being read right now, by hash and address. */
  const detailsInFlight = new Map<string, Promise<void>>();
  let detailsRunning = 0;
  const detailsWaiting: Array<() => void> = [];

  /**
   * Read one service's description from where its listing says it is and keep
   * it only if it is the text the listing committed to. The address is the
   * provider's own, so it is fetched like any other untrusted address: public
   * hosts only, bounded size, bounded time.
   */
  async function loadDetails(specHashHex: string, uri: string): Promise<void> {
    if (detailsRunning >= DETAILS_AT_ONCE) {
      await new Promise<void>((resolve) => detailsWaiting.push(resolve));
    }
    detailsRunning += 1;
    const key = `${specHashHex} ${uri}`;
    try {
      const payload = await verifiedListingPayload(await publicFetcher(uri), specHashHex);
      if (payload === null) {
        detailsFailedAt.set(key, now());
      } else {
        detailsCache.set(specHashHex, listingDetails(payload));
        detailsFailedAt.delete(key);
      }
    } catch {
      detailsFailedAt.set(key, now());
    } finally {
      detailsRunning -= 1;
      detailsWaiting.shift()?.();
    }
  }

  /** A listed service with whatever is known of its description, starting to read it when nothing is. */
  function describe(entry: ListedService): CatalogRow {
    const { specHashHex, specUri } = entry;
    const known = specHashHex === null ? undefined : detailsCache.get(specHashHex);
    if (known !== undefined) return describedRow(entry, known, "ready");
    if (specHashHex === null || specUri === null) return describedRow(entry, NO_DETAILS, "unavailable");
    const key = `${specHashHex} ${specUri}`;
    const failed = detailsFailedAt.get(key);
    if (failed !== undefined && now() - failed < DETAILS_RETRY_MS) {
      return describedRow(entry, NO_DETAILS, "unavailable");
    }
    if (!detailsInFlight.has(key)) {
      detailsInFlight.set(
        key,
        loadDetails(specHashHex, specUri).finally(() => detailsInFlight.delete(key)),
      );
    }
    return describedRow(entry, NO_DETAILS, "loading");
  }

  function parseRow(value: unknown, state: ServiceState): ListedService | null {
    const item = record(value);
    if (item === null) return null;
    const listing = safeAddress(item.pda);
    const providerAgent = safeAddress(item.providerAgent);
    const price = safeBigInt(item.priceLamports);
    const name = tidyText(item.name, 64);
    if (listing === null || providerAgent === null || price === null || name === null) return null;
    if (item.priceMint !== null && item.priceMint !== undefined) return null;
    const stateNumber = SERVICE_STATES.indexOf(state);
    if (item.state !== stateNumber && item.state !== ListingState[stateNumber]) return null;
    if (state === "active" && Number(item.maxOpenJobs) > 0 && Number(item.openJobs) >= Number(item.maxOpenJobs)) return null;
    const provenance = record(item.provenance);
    const ratingCount = finite(provenance?.rawRatingCount) ?? finite(item.ratingCount) ?? 0;
    const average =
      finite(provenance?.weightedRatingAverage) ?? finite(provenance?.rawRatingAverage) ?? finite(item.rawRatingAverage);
    const rating =
      ratingCount > 0 && average !== null && average >= 1 && average <= 5 ? average : null;
    const settled = finite(provenance?.settledHireCount);
    const deadline = finite(item.defaultDeadlineSecs);
    const specHash = typeof item.specHash === "string" ? item.specHash.toLowerCase() : "";
    const specUri = typeof item.specUri === "string" ? item.specUri.trim() : "";
    return {
      base: {
        listing,
        ...(state === "active" ? {} : { state }),
        providerAgent,
        name,
        priceLamports: price,
        rating,
        ratingCount: Math.max(0, Math.trunc(ratingCount)),
        jobsDone: Math.max(0, Math.trunc(settled ?? 0)),
        deliverySecs: deadline !== null && deadline > 0 ? Math.trunc(deadline) : null,
      },
      // The list does not carry these today. They are kept as a fallback for
      // a list that does, and never override what the description itself says.
      listedTags: (Array.isArray(item.tags) ? item.tags : typeof item.tags === "string" ? item.tags.split(",") : [])
        .flatMap((tag: unknown) => tidyText(tag, 64) ?? []),
      listedCategory: tidyText(item.category, 40),
      listedSummary: tidyText(item.summary ?? item.description, 280),
      specHashHex: HEX64.test(specHash) ? specHash : null,
      specUri: /^https:\/\/[^\s]{1,500}$/.test(specUri) ? specUri : null,
    };
  }

  const indexes = new Map<ServiceState, ReturnType<typeof catalogIndex>>();
  function catalogIndex(state: ServiceState, provider?: string) {
    const query = (state === "active" ? "hireable=1&" : "") + (provider ? `providerAgent=${provider}&` : "");
    return createPagedIndex({
      now, ttl: CATALOG_TTL_MS, budget: options.catalogTimeoutMs ?? 15_000,
      read: (page, timeout) => read(`/api/listings?${query}page=${page}&pageSize=${CATALOG_PAGE_SIZE}`, timeout),
      parse: (item) => parseRow(item, state),
    });
  }

  const providers = new Map<string, ReturnType<typeof catalogIndex>>();

  async function exactListing(id: string, state: ServiceState): Promise<ListedService[]> {
    if (!safeAddress(id)) return [];
    const path = encodeURIComponent(id);
    const detail = await read(`/api/explorer/listings/${path}`, 5_000);
    if (detail.status === 404) return [];
    const listing = record(record(detail.body)?.listing);
    if (detail.status !== 200 || listing?.pda !== id) throw new WalletError("NETWORK", "The service could not be read.");
    const terms = record(listing.decoded);
    if (!terms || listing.metadataValid !== true) return [];
    const row = parseRow(explorerTerms(listing, terms), state);
    if (!row) return [];
    if (state === "active") {
      // The explorer includes diagnostic listings. Require the site's hireability verdict for this ID.
      const reply = await read(`/listings/${path}/agent-card.json`, 5_000);
      const card = record(reply.body);
      if (reply.status !== 200 || card?.id !== id || card.providerAgent !== row.base.providerAgent) {
        throw new WalletError("NETWORK", "The service's availability could not be checked.");
      }
      if (record(card.hireability)?.hireable !== true) return [];
    }
    const key = state + row.base.providerAgent;
    let siblings = providers.get(key);
    if (!siblings) {
      siblings = catalogIndex(state, row.base.providerAgent);
      if (providers.size >= 16) providers.delete(providers.keys().next().value!);
      providers.set(key, siblings);
    }
    const other = siblings.cached();
    if (other) return [row, ...other.filter((entry) => entry.base.listing !== id)];
    // The provider profile also lists its other offers. Load them off the cold ID path.
    void Promise.resolve(siblings.load()).catch(() => {});
    row.base.recordPending = true;
    return [row];
  }

  function finishedIndex(provider: Address) {
    return createPagedIndex({
      now, ttl: FINISHED_TTL_MS, budget: 30_000,
      read: (page, timeout) => read(`/api/tasks?provider=${provider}&pageSize=${FINISHED_PAGE}${page === 1 ? "" : `&page=${page}`}`, timeout),
      parse: (item) => item.status === "settled" && item.providerAgent === provider ? safeAddress(item.pda) : null,
    });
  }

  return {
    async finishedJobs(provider) {
      let index = finished.get(provider);
      if (!index) {
        index = finishedIndex(provider);
        finished.set(provider, index);
      }
      const cached = index.cached();
      if (cached) return cached;
      // One read at a time, and never two closer together than the gap.
      const turn = finishedTurn
        .catch(() => undefined)
        .then(async () => {
          const again = index.cached();
          if (again) return again;
          const wait = finishedAskedAt + finishedGapMs - Date.now();
          if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
          finishedAskedAt = Date.now();
          return index.load();
        });
      finishedTurn = turn;
      return turn;
    },

    async listServices(filters) {
      const state = filters?.state ?? "active";
      let index = indexes.get(state);
      if (!index) {
        index = catalogIndex(state);
        indexes.set(state, index);
      }
      const listed = index.cached() ?? (filters?.listing ? await exactListing(filters.listing, state) : await index.load());
      // Provider profiles use the catalog, even on a narrow search. Fetch provider-hosted
      // descriptions only for candidates that could reach the result page.
      const describeMatch = (entry: ListedService): CatalogRow => {
        if ((filters?.listing !== undefined && entry.base.listing !== filters.listing)
          || (filters?.provider !== undefined && entry.base.providerAgent !== filters.provider)
          || (filters?.maxLamports !== undefined && entry.base.priceLamports > filters.maxLamports)) {
          return describedRow(entry, NO_DETAILS, "unavailable");
        }
        return describe(entry);
      };
      let rows = listed.map(describeMatch);
      if (detailsWaitMs > 0 && rows.some((row) => row.details === "loading")) {
        // Most descriptions are small files that arrive at once. Wait a moment
        // for them, then hand the list back with whatever has come in: the
        // rest keep loading and are there the next time the list is read.
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled(listed.flatMap((entry) => {
            if (filters?.listing && entry.base.listing !== filters.listing) return [];
            const read = detailsInFlight.get(`${entry.specHashHex} ${entry.specUri}`);
            return read ? [read] : [];
          })),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, detailsWaitMs);
            timer.unref();
          }),
        ]);
        clearTimeout(timer);
        rows = listed.map(describeMatch);
      }
      return rows;
    },
  };
}
