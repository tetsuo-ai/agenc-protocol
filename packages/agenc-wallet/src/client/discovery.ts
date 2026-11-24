import type { Money, ServiceView } from "./types.js";

export const DISCOVERY_CAPABILITY = "service-discovery-v1";
export const SERVICE_STATES = ["active", "paused", "retired"] as const;
export type ServiceState = typeof SERVICE_STATES[number];
export const SERVICE_SORTS = ["relevance", "price_low", "price_high", "rating", "paid_jobs"] as const;
export type ServiceSort = typeof SERVICE_SORTS[number];

export interface DiscoveryQuery {
  query?: string;
  maxPriceCents?: number;
  provider?: string;
  minRating?: number;
  minPaidJobs?: number;
  tag?: string;
  category?: string;
  state?: ServiceState;
  sort?: ServiceSort;
  limit?: number;
  offset?: number;
  /** Identifies a fixed ranking. Send with offset when continuing a search. */
  cursor?: string;
}

export interface DiscoveryPage {
  services: ServiceView[];
  total: number;
  networkFee: Money;
  pending?: boolean;
  recordsUnavailable?: boolean;
  cursor?: string;
  /** Echoed on the read itself so an agent connection needs no owner-only overview. */
  discovery?: typeof DISCOVERY_CAPABILITY;
}

export const DISCOVERY_UPDATE = "This search needs the updated Market wallet. Try again once the updated wallet is running.";
export function needsDiscovery(params: DiscoveryQuery): boolean {
  return Object.entries(params).some(([key, value]) => value !== undefined && !["query", "limit"].includes(key))
    || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(params.query?.trim() ?? "");
}

/** Decimal point shift, including numbers written using scientific notation. */
export function shiftDecimal(value: number, places: number): number {
  const [mantissa, exponent = "0"] = String(value).split("e");
  return Number(`${mantissa}e${Number(exponent) + places}`);
}

/** Normalize decimal digits without converting the input to binary floating point. */
function decimalKey(text: string, shift = 0): string {
  const [mantissa, exponent = "0"] = text.toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const digits = (whole + fraction).replace(/^0+/, "");
  const significant = digits.replace(/0+$/, "");
  return significant + "e" + (Number(exponent) - fraction.length + digits.length - significant.length + shift);
}

/** Refuse a price whose decimal digits would be lost when cents travel over JSON. */
export function discoveryPriceCents(text: string): number | null {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const dollars = Number(text);
  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 100_000) return null;
  const cents = shiftDecimal(dollars, 2);
  return decimalKey(text, 2) === decimalKey(String(cents)) ? cents : null;
}

declare module "./types.js" {
  interface ServiceView {
    supplier?: import("./purchase-input.js").ListedSupplier;
    availability?: { identity: import("./listing-exchange.js").ListingIdentity; heartbeat: import("./listing-exchange.js").ListingHeartbeat | null };
  }
  interface JobTerms {
    inquiry?: Awaited<ReturnType<typeof import("./listing-exchange.js").selectedListingTerms>>;
    admission?: import("./purchase-input.js").PublicPurchaseAdmission;
  }
}
