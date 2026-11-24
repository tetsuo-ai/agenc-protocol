import type { Money } from "./types.js";

export const SELLER_CATEGORIES = [
  "code-generation",
  "translation",
  "data-labeling",
  "research",
  "image-gen",
  "audio",
  "video",
  "marketing",
  "data-analysis",
  "scraping",
  "devops",
  "security",
  "legal",
  "finance",
  "design",
  "writing",
  "support",
  "search",
  "automation",
  "other",
] as const;

/** Hash of the host's immutable, successful production room rehearsal. */
export interface ServicePin {
  digest: string;
  runtimeDigest: string;
  permissionDigest: string;
  capabilities: "1" | "5";
}

export interface SellerFundingRows {
  price?: Money;
  alreadyStaked?: Money;
  lockedStake: Money;
  claimDeposits: Money;
  registrationRent: Money;
  listingRent: Money;
  moderationRent: Money;
  firstClaimRecordRent: Money;
  setupFees: Money;
  refundableClaimRent: Money;
  reclaimNow: Money;
  feeReserve: Money;
}

export interface ServiceUsage {
  reservedCents: number;
  unknownReservedCents?: number;
  costUsd: number | null;
  runs: number;
}

declare module "./types.js" {
  interface JobView { modelUsage?: ServiceUsage; settledSellerCredit?: Money | null }
  interface EarnFundingQuote {
    sellerFunding?: SellerFundingRows;
    serviceAdmission?: { minimumPriceLamports: string; modelBudgetCents: number; capabilities: string };
  }
}

export function validServicePin(pin: unknown): pin is ServicePin {
  if (!pin || typeof pin !== "object") return false;
  const p = pin as ServicePin;
  return Object.keys(pin).length === 4 && [p.digest, p.runtimeDigest, p.permissionDigest].every(
    value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
  ) && (p.capabilities === "1" || p.capabilities === "5");
}

export interface SellerDependency {
  allowedListings: string[];
  maxDebitLamports: string;
  /** Seconds to keep for the parent after the child's delivery and review. */
  returnBeforeSecs: number;
  reviewWindowSecs: number;
  sharing: "public-brief" | "buyer-approved-input";
}
export interface SellerTerms {
  childPolicy?: SellerDependency | null;
  servicePin?: ServicePin;
  minimumMarginCents?: number;
  modelCapCents?: number;
  category: string;
  tags: string[];
  inputs: string[];
  outputs: string[];
  maxOpenJobs: number;
  deliverySecs: number;
  operator: string | null;
  operatorFeeBps: number;
}

export interface SellerProceeds {
  marketFee?: Money | null;
  operatorFee: Money;
  sellerNetIfForfeited?: Money | null;
  /** Estimate at the current marketplace rate, before reputation discounts. */
  sellerNet: Money | null;
}

export const DEFAULT_SELLER_TERMS: SellerTerms = {
  category: "other",
  tags: [],
  inputs: [],
  outputs: [],
  maxOpenJobs: 1,
  deliverySecs: 3600,
  operator: null,
  operatorFeeBps: 0,
};

/** Also used on local drafts, which do not reach the wallet until publication. */
export function sellerTermsProblem(terms: SellerTerms): string | null {
  if (terms.servicePin !== undefined && !validServicePin(terms.servicePin)) return "Rehearse this service in the job room.";
  if (terms.minimumMarginCents !== undefined && (!Number.isSafeInteger(terms.minimumMarginCents) || terms.minimumMarginCents < 0))
    return "Enter the minimum margin in whole cents.";
  if (terms.modelCapCents !== undefined && (!Number.isSafeInteger(terms.modelCapCents) || terms.modelCapCents < 1))
    return "Enter a positive model spending limit in whole cents.";
  if (!SELLER_CATEGORIES.some((category) => category === terms.category))
    return "Choose a marketplace category.";
  if (
    !Array.isArray(terms.tags) ||
    terms.tags.length > 8 ||
    terms.tags.some(
      (tag) =>
        typeof tag !== "string" ||
        tag.length > 32 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag),
    ) ||
    terms.tags.join(",").length > 64 ||
    new Set(terms.tags).size !== terms.tags.length
  ) {
    return "Use up to eight distinct lowercase tags, up to 64 characters including commas.";
  }
  for (const lines of [terms.inputs, terms.outputs]) {
    if (
      !Array.isArray(lines) ||
      lines.length > 8 ||
      lines.some(
        (line) =>
          typeof line !== "string" ||
          !line.trim() ||
          line.length > 160 ||
          /[\r\n]/.test(line),
      )
    ) {
      return "Use up to eight inputs and eight outputs, each one line of up to 160 characters.";
    }
  }
  if (
    !Number.isInteger(terms.maxOpenJobs) ||
    terms.maxOpenJobs < 0 ||
    terms.maxOpenJobs > 65535
  )
    return "Capacity must be 0 to 65535 open hires. Zero selects the funded default of five hires.";
  if (
    !Number.isInteger(terms.deliverySecs) ||
    terms.deliverySecs < 1 ||
    terms.deliverySecs > 31536000
  )
    return "Delivery must be between one second and one year.";
  if (
    !Number.isInteger(terms.operatorFeeBps) ||
    terms.operatorFeeBps < 0 ||
    terms.operatorFeeBps > 2000
  )
    return "The operator fee must be 0 to 2000 basis points.";
  if (
    terms.operator !== null &&
    (typeof terms.operator !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(terms.operator))
  )
    return "Enter a Solana address for the operator.";
  if (
    terms.operatorFeeBps &&
    (!terms.operator || terms.operator === "11111111111111111111111111111111")
  )
    return "Name the operator who receives the fee.";
  return null;
}
