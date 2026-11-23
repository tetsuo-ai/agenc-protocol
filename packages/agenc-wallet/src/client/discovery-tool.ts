import { formatMoney, formatDuration } from "./format.js";
import type { ServiceView } from "./types.js";
import type { WalletClient } from "./socket-client.js";
import type { MarketToolResult, MarketToolSpec } from "./tools.js";
import { DISCOVERY_CAPABILITY, DISCOVERY_UPDATE, needsDiscovery, SERVICE_STATES, SERVICE_SORTS, type DiscoveryQuery } from "./discovery.js";
import { dollarsToCents, text, ToolInputError } from "./tool-input.js";

export const discoveryTool: MarketToolSpec = {
  name: "market_find",
  description:
    "Search the AgenC marketplace for services other agents offer. Read-only. The search looks at each service's name, description and category. Returns services with an id, what you get, what the provider asks you to send, the price, its record (ratings and paid jobs, each weighed by what the job paid) and how long delivery takes. Leave query empty to see the services with the best record first.",
  readOnly: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        maxLength: 200,
        description: "Search words or the full service ID.",
      },
      max_price_usd: {
        type: "number",
        exclusiveMinimum: 0,
        maximum: 100000,
        description: "Only show services at or below this price in US dollars.",
      },
      provider: { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$", description: "Exact provider ID from a service." },
      min_rating: { type: "number", minimum: 1, maximum: 5, description: "Minimum rating from paying buyers." },
      min_paid_jobs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Minimum verified paid jobs for this service." },
      tag: { type: "string", maxLength: 64, description: "Match this tag exactly." },
      category: { type: "string", maxLength: 64, description: "Match this category exactly." },
      state: { type: "string", enum: SERVICE_STATES, description: "Listing state. Defaults to active." },
      sort: { type: "string", enum: SERVICE_SORTS, description: "Order all matches before paging." },
      cursor: { type: "string", maxLength: 64, description: "Send next_cursor with next_offset and the same filters." },
      offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Use next_offset with next_cursor for the next page." },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
  },
};

export function describeService(service: ServiceView) {
  return {
    id: service.listing,
    provider_id: service.provider,
    ...(service.state ? { state: service.state } : {}),
    ...(service.listingUrl ? { url: service.listingUrl } : {}),
    name: service.name,
    ...(service.category !== null ? { category: service.category } : {}),
    // Everything from here to `terms` is the provider's own text.
    what_you_get:
      service.summary ??
      (service.details === "loading"
        ? "The description is still loading. Search again in a moment."
        : service.details === "unavailable"
          ? "The provider's description could not be read."
          : null),
    ...(service.inputs.length > 0 ? { asks_for: service.inputs } : {}),
    ...(service.outputs.length > 0 ? { hands_back: service.outputs } : {}),
    ...(service.terms.length > 0 ? { terms: service.terms } : {}),
    price: formatMoney(service.price),
    ...(service.maxPriceCents !== undefined && { max_price_usd: service.maxPriceCents / 100 }),
    listing_version: service.listingVersion,
    ...(service.maxOpenJobs !== undefined && { max_open_jobs: service.maxOpenJobs, delivery_secs: service.deliverySecs,
      price_lamports: service.price.lamports, tags: service.tags, operator: service.operator,
      operator_fee_bps: service.operatorFeeBps, proceeds: service.proceeds }),
    // A wallet older than this client sends no fee and no record: those are left out, not guessed.
    ...(service.marketFee != null
      ? { marketplace_fee: `${formatMoney(service.marketFee.amount)} of the price (${service.marketFee.bps / 100}%)` }
      : {}),
    ...describeRecord(service),
    delivery:
      service.deliverySecs === null ? null : `within ${formatDuration(service.deliverySecs)}`,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "5 jobs, $2.00 paid by 3 buyers" */
function paidJobs(jobs: number, paid: ServiceView["paid"], buyers: number): string {
  return jobs === 0
    ? "none yet"
    : `${plural(jobs, "job", "jobs")}, ${formatMoney(paid)} paid by ${plural(buyers, "buyer", "buyers")}`;
}

/** A service's record and its provider's, as far as they are known. */
function describeRecord(service: ServiceView): Record<string, unknown> {
  if (service.record !== "ready") {
    return {
      record:
        service.record === "loading"
          ? "Its record is still being read. Search again in a moment."
          : "Its record could not be read right now.",
    };
  }
  const provider = service.offeredBy ?? null;
  return {
    rating:
      service.rating === null
        ? "not rated yet"
        : `${service.rating.toFixed(1)} of 5 from ${plural(service.ratingCount, "rating", "ratings")}`,
    paid_jobs: paidJobs(service.jobsDone, service.paid, service.buyers),
    ...(provider !== null
      ? {
          provider: {
            ...(provider.since !== null
              ? { on_the_marketplace_since: new Date(provider.since).toISOString().slice(0, 10) }
              : {}),
            paid_jobs: paidJobs(provider.jobsDone, provider.paid, provider.buyers),
            ...(provider.otherServiceCount !== undefined ? { other_service_count: provider.otherServiceCount } : {}),
            // A provider without a stats record has not been counted, not cleared.
            turned_down: provider.turnedDown ?? "no record kept",
            disputes_lost: provider.disputesLost ?? "no record kept",
            ...(provider.otherServices.length > 0
              ? {
                  other_services: provider.otherServices.slice(0, 8).map((other) => other.name),
                  related_services: provider.otherServices.slice(0, 8).map((other) => ({ id: other.listing, name: other.name })),
                }
              : {}),
          },
        }
      : {}),
  };
}


function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  const match = choices.find((item) => item === value);
  if (!match) throw new ToolInputError(`Unknown ${name}.`);
  return match;
}

export async function findServices(client: WalletClient, args: Record<string, unknown>, callOptions?: { signal?: AbortSignal }): Promise<MarketToolResult> {
  const query = text(args.query, "query", 200, false);
  const maxPriceCents = dollarsToCents(args.max_price_usd, "max_price_usd", true);
  const limit =
    typeof args.limit === "number" && Number.isInteger(args.limit)
      ? Math.min(20, Math.max(1, args.limit))
      : 8;
  const provider = text(args.provider, "provider", 44, false);
  if (provider !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(provider)) {
    throw new ToolInputError("Enter the full provider ID.");
  }
  const minRating = args.min_rating;
  if (minRating !== undefined && (typeof minRating !== "number" || !Number.isFinite(minRating) || minRating < 1 || minRating > 5)) {
    throw new ToolInputError("min_rating must be between 1 and 5.");
  }
  const minPaidJobs = args.min_paid_jobs;
  if (minPaidJobs !== undefined && (typeof minPaidJobs !== "number" || !Number.isSafeInteger(minPaidJobs) || minPaidJobs < 1)) {
    throw new ToolInputError("min_paid_jobs must be a positive whole number.");
  }
  const offset = args.offset === undefined ? 0 : args.offset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new ToolInputError("offset must be a nonnegative whole number.");
  }
  const cursor = text(args.cursor, "cursor", 64, false);
  if (offset && !cursor) throw new ToolInputError("Start the search again and send next_cursor with next_offset.");
  const tag = text(args.tag, "tag", 64, false);
  const category = text(args.category, "category", 64, false);
  const state = choice(args.state, SERVICE_STATES, "state");
  const sort = choice(args.sort, SERVICE_SORTS, "sort");
  const params: DiscoveryQuery = {
    ...(query !== undefined ? { query } : {}),
    ...(maxPriceCents !== undefined ? { maxPriceCents } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(minRating !== undefined ? { minRating } : {}),
    ...(minPaidJobs !== undefined ? { minPaidJobs } : {}),
    ...(offset > 0 ? { offset } : {}),
    ...(cursor ? { cursor } : {}),
    ...(tag ? { tag } : {}),
    ...(category ? { category } : {}),
    ...(state ? { state } : {}),
    ...(sort ? { sort } : {}),
    limit,
  };
  const answer = await client.call("market.find", params, callOptions);
  if (needsDiscovery(params) && answer.discovery !== DISCOVERY_CAPABILITY) throw new ToolInputError(DISCOVERY_UPDATE);
  const { services, total, networkFee, pending, recordsUnavailable } = answer;
  const end = offset + services.length;
  const messages: string[] = [];
  if (services.length > 0) {
    messages.push(offset === 0 && end === total
      ? `Found ${plural(total, "service", "services")}.`
      : `Showing services ${offset + 1} to ${end} of ${total}.`);
    messages.push(`Each job also costs about ${formatMoney(networkFee)} in network fees, which are not returned even if the job is cancelled. Tell the user the name and price before hiring.`);
  } else {
    messages.push(total > 0 ? "There are no more services on this page." : "No matching services found.");
  }
  if (!answer.cursor && end < total) messages.push(DISCOVERY_UPDATE);
  if (maxPriceCents !== undefined) messages.push("Pass the same max_price_usd to market_hire.");
  if (pending) messages.push("More matches may appear as details load. Search again in a moment.");
  if (recordsUnavailable) messages.push("Some service records could not be checked.");
  return {
    ok: true,
    message: messages.join(" "),
    total,
    next_offset: answer.cursor && services.length > 0 && end < total ? end : null,
    next_cursor: end < total ? answer.cursor ?? null : null,
    ...(maxPriceCents !== undefined ? { max_price_usd: args.max_price_usd as number } : {}),
    services: services.map(describeService),
  };
}
