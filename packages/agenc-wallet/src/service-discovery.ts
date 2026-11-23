import { randomUUID } from "node:crypto";
import type { ListingTerms } from "./market.js";
import { isAddress } from "@solana/kit";
import type { DiscoveryQuery, DiscoveryPage, ServiceSort } from "./client/discovery.js";
import { SERVICE_STATES, SERVICE_SORTS } from "./client/discovery.js";
import type { ProviderView, ServiceView } from "./client/types.js";
import { WalletError } from "./errors.js";
import type { KnownRecord, RecordRow } from "./records.js";
import { distinctOffers, type CatalogRow, type MarketServices } from "./services.js";
import { sellerProceeds } from "./seller-terms.js";
import { microcents } from "./job-money.js";
import { priceCeiling } from "./price-ceiling.js";
import { compareRecords, EMPTY_RECORD, type TrustRecord } from "./trust.js";
import { money } from "./views.js";

/** The most services one page of a search holds. */
const MAX_FIND_LIMIT = 50;

/**
 * Words that say nothing about what is wanted. A person asks "find someone
 * to write a haiku about my garden", and so does an agent; only "write",
 * "haiku" and "garden" say what to look for.
 */
const SEARCH_FILLER = new Set([
  "a", "an", "and", "any", "are", "about", "can", "do", "for", "find", "from", "get", "have", "i", "in", "is",
  "it", "like", "looking", "me", "my", "need", "of", "on", "or", "our", "please", "some", "someone", "something",
  "that", "the", "this", "to", "want", "who", "will", "with", "you", "your",
]);

/** A search word with the other forms it may take in a description. */
interface SearchWord {
  /** "memes" also finds "meme"; "summary" also finds "summaries". */
  forms: string[];
  /** A short word has to stand alone: "ai" is not in "maintain". */
  whole: boolean;
}

/**
 * The words of a search. Deliberately small: filler is dropped unless it is
 * all there is, a plural does not hide a match, and a word of three letters
 * or fewer only matches as a word of its own.
 */
function searchWords(query: string): SearchWord[] {
  const all = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0))];
  const telling = all.filter((word) => !SEARCH_FILLER.has(word));
  const words: SearchWord[] = [];
  for (const word of (telling.length > 0 ? telling : all).slice(0, 12)) {
    const forms = new Set([word]);
    if (word.length > 4 && word.endsWith("ies")) forms.add(`${word.slice(0, -3)}y`);
    else if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) forms.add(word.slice(0, -1));
    if (word.length > 4 && word.endsWith("y")) forms.add(`${word.slice(0, -1)}ies`);
    words.push({ forms: [...forms], whole: word.length <= 3 });
  }
  return words;
}

/** Text to search in, as it is and as the set of its words. */
function searchable(text: string): { text: string; words: Set<string> } {
  const lower = text.toLowerCase();
  return { text: lower, words: new Set(lower.split(/[^a-z0-9]+/)) };
}

function found(word: SearchWord, place: { text: string; words: Set<string> }): boolean {
  return word.forms.some((form) => (word.whole ? place.words.has(form) : place.text.includes(form)));
}
/** What a list of services is described with: the record, the dollar rate, the fee rate, who offers what. */
export interface ServiceContext {
  known: KnownRecord;
  rate: number | null;
  feeBps: number | null;
  /** Every service on the list, by the agent that offers it. */
  byProvider: Map<string, { listing: string; name: string }[]>;
}

export function recordRow(row: CatalogRow): RecordRow {
  return { listing: row.listing, providerAgent: row.providerAgent, specHashHex: row.specHashHex };
}

/**
 * A service's record, or null when it is not known: not read yet, or its
 * agent's finished jobs could not be read the last time.
 */
function knownRecord(known: KnownRecord, row: CatalogRow): TrustRecord | null {
  if (row.recordPending) return null;
  const record = known.record;
  if (record === null || !record.facts.has(row.providerAgent) || record.unread.has(row.providerAgent)) return null;
  return record.listings.get(row.listing) ?? EMPTY_RECORD;
}

export function serviceView(row: CatalogRow, context: ServiceContext, publicNetwork: boolean): ServiceView {
  const { rate, feeBps } = context;
  const record = knownRecord(context.known, row);
  const facts = record === null ? null : context.known.record!.facts.get(row.providerAgent)!;
  const listing = record ?? EMPTY_RECORD;
  let offeredBy: ProviderView | null = null;
  if (record !== null && facts !== null) {
    const provider = context.known.record!.providers.get(row.providerAgent) ?? EMPTY_RECORD;
    const siblings = context.byProvider.get(row.providerAgent) ?? [];
    offeredBy = {
      since: facts.since,
      jobsDone: provider.jobs,
      paid: money(provider.paidLamports, rate),
      buyers: provider.buyers,
      turnedDown: facts.turnedDown,
      disputesLost: facts.disputesLost,
      deposit: facts.depositLamports === null ? null : money(facts.depositLamports, rate),
      otherServices: siblings.slice(0, 9).filter((other) => other.listing !== row.listing).slice(0, 8),
      otherServiceCount: Math.max(0, siblings.length - 1),
    };
  }
  return {
    listing: row.listing,
    ...(row.state ? { state: row.state } : {}),
    ...(publicNetwork ? { listingUrl: `https://agenc.ag/listings/${row.listing}` } : {}),
    name: row.name,
    summary: row.details === "ready" ? row.summary : null,
    ...(row.details === "ready" && row.fulfilment?.supplier && { supplier: row.fulfilment.supplier }),
    description: row.description,
    category: row.category,
    tags: row.tags,
    inputs: row.inputs,
    outputs: row.outputs,
    terms: row.terms,
    details: row.details,
    ...(row.specHashHex && { specHashHex: row.specHashHex }),
    price: money(row.priceLamports, rate),
    ...(row.listingVersion !== undefined && { listingVersion: row.listingVersion }),
    ...(row.maxOpenJobs !== undefined && { maxOpenJobs: row.maxOpenJobs }),
    ...(row.operatorFeeBps !== undefined && row.operator !== undefined && (!row.operatorFeeBps || row.operator) && { operatorFeeBps: row.operatorFeeBps, operator: row.operator ?? null,
      proceeds: sellerProceeds(row.priceLamports, row.operatorFeeBps, feeBps, rate) }),

    marketFee:
      feeBps === null
        ? null
        : { bps: feeBps, amount: money((row.priceLamports * BigInt(feeBps)) / 10_000n, rate) },
    rating: listing.rating,
    ratingCount: listing.ratings,
    jobsDone: listing.jobs,
    paid: money(listing.paidLamports, rate),
    buyers: listing.buyers,
    record: record !== null ? "ready" : (context.known.reading || row.recordPending) ? "loading" : "unavailable",
    provider: row.providerAgent,
    offeredBy,
    deliverySecs: row.deliverySecs,
  };
}



function selectedOrder(sort: ServiceSort | undefined, a: CatalogRow, b: CatalogRow, trust: (row: CatalogRow) => TrustRecord) {
  if (sort === "price_low" || sort === "price_high") {
    const price = a.priceLamports < b.priceLamports ? -1 : a.priceLamports > b.priceLamports ? 1 : 0;
    return sort === "price_low" ? price : -price;
  }
  if (sort === "rating") return (trust(b).rating ?? 0) - (trust(a).rating ?? 0);
  if (sort === "paid_jobs") return trust(b).jobs - trust(a).jobs;
  return 0;
}

interface Ranking {
  rows: CatalogRow[];
  context: ServiceContext;
  pending: boolean;
  recordsUnavailable: boolean;
}

export class ServiceDiscovery {
  private readonly snapshots = new Map<string, { expires: number; criteria: string; ranking: Ranking }>();
  private readonly recentRows = new Map<string, { row: CatalogRow; view: ServiceView }>();
  constructor(private readonly source: {
    rate: () => Promise<number | null>;
    availability?: (row: CatalogRow) => Promise<ServiceView["availability"]>;
    fillTerms: (page: CatalogRow[]) => Promise<CatalogRow[]>;
    listServices: MarketServices["listServices"];
    ownServices: (listed: CatalogRow[]) => Promise<CatalogRow[]>;
    context: (rows: CatalogRow[], rate: number | null) => Promise<ServiceContext>;
    publicNetwork: boolean;
    now: () => number;
  }) {}

  rememberListing(row: CatalogRow, context: ServiceContext): ServiceView {
    const view = serviceView(row, context, this.source.publicNetwork);
    this.recentRows.delete(row.listing);
    this.recentRows.set(row.listing, { row, view });
    if (this.recentRows.size > 100) this.recentRows.delete(this.recentRows.keys().next().value!);
    return view;
  }

  /** Optional description for a hire. Only reuse text for the currently committed hash. */
  describeHire(terms: ListingTerms, rate: number | null, feeBps: number | null): ServiceView {
    const cached = this.recentRows.get(terms.listing);
    const hash = Buffer.from(terms.specHash).toString("hex");
    const verified = cached?.row.specHashHex === hash && cached.row.providerAgent === terms.providerAgent ? cached : null;
    const row: CatalogRow = {
      summary: null, description: null, tags: [], inputs: [], outputs: [], terms: [], details: "unavailable",
      rating: null, jobsDone: 0, ...verified?.row,
      listing: terms.listing, providerAgent: terms.providerAgent, name: terms.name, category: terms.category,
      listingVersion: terms.version.toString(), maxOpenJobs: terms.maxOpenJobs, operator: terms.operator, operatorFeeBps: terms.operatorFeeBps,
      priceLamports: terms.priceLamports, deliverySecs: terms.deliverySecs, specHashHex: hash, ratingCount: terms.ratingCount,
    };
    if (row.details !== "ready") row.summary = null;
    const result = serviceView(row, { rate, feeBps, known: { reading: false, record: null }, byProvider: new Map() }, this.source.publicNetwork);
    if (!verified) return result;
    const { rating, ratingCount, jobsDone, paid, buyers, offeredBy, record } = verified.view;
    return { ...result, rating, ratingCount, jobsDone, paid, buyers, offeredBy, record };
  }

  currentCatalogRow(terms: ListingTerms) {
    const row = this.recentRows.get(terms.listing)?.row;
    return row?.specHashHex === Buffer.from(terms.specHash).toString("hex") && row.providerAgent === terms.providerAgent ? row : undefined;
  }

  async search(params: DiscoveryQuery): Promise<{ page: Omit<DiscoveryPage, "networkFee">; rate: number | null }> {
    const offset = Math.max(0, Math.trunc(params.offset ?? 0));
    const limit = Math.min(MAX_FIND_LIMIT, Math.max(1, Math.trunc(params.limit ?? 8)));
    const criteria = JSON.stringify([params.query?.trim(), params.provider, params.maxPriceCents, params.minRating,
      params.minPaidJobs, params.tag, params.category, params.state, params.sort]);
    let cursor = params.cursor;
    let ranking: Ranking;
    if (cursor !== undefined) {
      const saved = this.snapshots.get(cursor);
      if (!saved || saved.expires <= this.source.now() || saved.criteria !== criteria) {
        throw new WalletError("BAD_REQUEST", "This search has expired or its filters changed. Start the search again.");
      }
      ranking = saved.ranking;
    } else {
      ranking = await this.rank(params);
      if (offset + limit < ranking.rows.length) {
        cursor = randomUUID();
        for (const [key, saved] of this.snapshots) if (saved.expires <= this.source.now()) this.snapshots.delete(key);
        if (this.snapshots.size >= 16) this.snapshots.delete(this.snapshots.keys().next().value!);
        this.snapshots.set(cursor, { expires: this.source.now() + 5 * 60_000, criteria, ranking });
      }
    }
    const { context, rows } = ranking;
    const slice = await this.source.fillTerms(rows.slice(offset, offset + limit));
    const services = slice.map((row) => {
      const view = this.rememberListing(row, context);
      if (context.rate !== null) view.maxPriceCents = params.maxPriceCents ?? Number(microcents(row.priceLamports, context.rate)) / 1_000_000;
      return view;
    });
    const selected = slice[0];
    if (selected && services[0] && selected.listing === params.query?.trim() && this.source.availability) {
      const availability = await this.source.availability(selected).catch(() => undefined);
      if (availability) services[0].availability = availability;
    }
    return { rate: context.rate, page: {
      services,
      total: rows.length,
      ...(cursor ? { cursor } : {}),
      ...(ranking.pending ? { pending: true } : {}),
      ...(ranking.recordsUnavailable ? { recordsUnavailable: true } : {}),
    } };
  }

  private async rank(params: DiscoveryQuery): Promise<Ranking> {
    const { provider, minRating, minPaidJobs } = params;
    if (provider !== undefined && (typeof provider !== "string" || !isAddress(provider))) {
      throw new WalletError("BAD_REQUEST", "Enter the full provider ID.");
    }
    if (minRating !== undefined && (!Number.isFinite(minRating) || minRating < 1 || minRating > 5)) {
      throw new WalletError("BAD_REQUEST", "The minimum rating must be between 1 and 5.");
    }
    if (minPaidJobs !== undefined && (!Number.isSafeInteger(minPaidJobs) || minPaidJobs < 1)) {
      throw new WalletError("BAD_REQUEST", "The minimum paid jobs must be a positive whole number.");
    }
    if (params.maxPriceCents !== undefined && (!Number.isFinite(params.maxPriceCents) || params.maxPriceCents < 0)) {
      throw new WalletError("BAD_REQUEST", "Enter a nonnegative maximum price.");
    }
    for (const key of ["tag", "category"] as const) {
      const value = params[key];
      if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 64)) {
        throw new WalletError("BAD_REQUEST", `Enter a ${key} of up to 64 characters.`);
      }
    }
    if (params.state !== undefined && !SERVICE_STATES.includes(params.state)) throw new WalletError("BAD_REQUEST", "Unknown listing state.");
    if (params.sort !== undefined && !SERVICE_SORTS.includes(params.sort)) throw new WalletError("BAD_REQUEST", "Unknown service sort order.");
    const tag = params.tag?.trim().toLowerCase();
    const category = params.category?.trim().toLowerCase();
    const query = (params.query ?? "").trim();
    const exact = isAddress(query);
    const words = exact ? [] : searchWords(query);
    const rate = await this.source.rate();
    let maxLamports: bigint | null = null;
    if (params.maxPriceCents !== undefined) {
      if (rate === null) {
        throw new WalletError(
          "NETWORK",
          "Dollar prices are not available right now. Try again in a moment.",
        );
      }
      // A filter is an upper bound. A fraction of a lamport cannot buy the next one.
      maxLamports = priceCeiling(params.maxPriceCents, rate);
    }
    const listed = await this.source.listServices({
      ...(exact ? { listing: query } : {}),
      ...(params.state ? { state: params.state } : {}),
      ...(provider === undefined ? {} : { provider }),
      ...(maxLamports === null ? {} : { maxLamports }),
    });
    const rows = distinctOffers([...listed, ...(await this.source.ownServices(listed))], (row) => row);
    const context = await this.source.context(rows, rate);
    const trustFiltered = minRating !== undefined || minPaidJobs !== undefined;
    let pending = trustFiltered && (context.known.record?.pending ?? 0) > 0;
    let recordsUnavailable = false;
    const matched = rows
      .filter((row) => !exact || row.listing === query)
      .filter((row) => provider === undefined || row.providerAgent === provider)
      .filter((row) => maxLamports === null || row.priceLamports <= maxLamports)
      .filter((row) => {
        if ((row.state ?? "active") !== (params.state ?? "active")) return false;
        if ((category || tag) && row.details === "loading") pending = true;
        if (category && row.category?.toLowerCase() !== category) return false;
        if (tag && !row.tags.some((value) => value.toLowerCase() === tag)) return false;
        if (!trustFiltered) return true;
        const record = knownRecord(context.known, row);
        if (record === null) {
          if (context.known.reading || row.recordPending) pending = true;
          else recordsUnavailable = true;
          return false;
        }
        return (minPaidJobs === undefined || record.jobs >= minPaidJobs)
          && (minRating === undefined || (record.rating !== null && record.rating >= minRating));
      })
      .map((row) => {
        if (words.length === 0) return { row, hits: 0, inName: 0 };
        if (row.details === "loading") pending = true;
        const name = searchable(row.name);
        const rest = searchable(
          [
            row.summary ?? "",
            row.description ?? "",
            (row.category ?? "").replace(/-/g, " "),
            row.tags.join(" ").replace(/-/g, " "),
            row.inputs.join(" "),
            row.outputs.join(" "),
          ].join(" "),
        );
        let hits = 0;
        let inName = 0;
        for (const word of words) {
          if (found(word, name)) {
            hits += 1;
            inName += 1;
          } else if (found(word, rest)) {
            hits += 1;
          }
        }
        return { row, hits, inName };
      });
    // A search of several words shows the services that match the most of
    // them: all of them when any service does, the nearest ones otherwise.
    // One stray word in a long description does not make a match.
    const most = matched.reduce((best, entry) => Math.max(best, entry.hits), 0);
    const scored = matched.filter((entry) => words.length === 0 || (most > 0 && entry.hits === most));
    // Then by what buyers really paid and said, weighed by money: many good
    // paid jobs rank above one excellent cheap one (trust.ts).
    const recordOf = (row: CatalogRow): TrustRecord => knownRecord(context.known, row) ?? EMPTY_RECORD;
    scored.sort(
      (a, b) =>
        selectedOrder(params.sort, a.row, b.row, recordOf) ||
        b.inName - a.inName ||
        // A service nobody can read about goes below the ones that say what they do.
        Number(a.row.details === "unavailable") - Number(b.row.details === "unavailable") ||
        compareRecords(recordOf(a.row), recordOf(b.row)) ||
        (a.row.priceLamports < b.row.priceLamports ? -1 : a.row.priceLamports > b.row.priceLamports ? 1 : 0) ||
        (a.row.listing < b.row.listing ? -1 : a.row.listing > b.row.listing ? 1 : 0),
    );
    return { rows: scored.map(({ row }) => row), context, pending, recordsUnavailable };
  }
}
