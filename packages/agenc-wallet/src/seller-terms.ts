import { address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  getServiceListingDecoder,
  getServiceListingDiscriminatorBytes,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import type { Chain } from "./chain.js";
import type { CatalogRow } from "./services.js";
import {
  DEFAULT_SELLER_TERMS,
  sellerTermsProblem,
  type SellerTerms,
} from "./client/seller-terms.js";
import { WalletError } from "./errors.js";
import { money } from "./views.js";
import type { OfferRecord } from "./store.js";

export function storedTerms(offer: OfferRecord): SellerTerms {
  return {
    ...DEFAULT_SELLER_TERMS,
    category: offer.category,
    deliverySecs: offer.deliverySecs,
    ...offer.terms,
  };
}

export function resolveTerms(
  patch: Partial<SellerTerms> | undefined,
  previous?: OfferRecord | null,
): SellerTerms {
  if (
    patch !== undefined &&
    (!patch || typeof patch !== "object" || Array.isArray(patch))
  )
    throw new WalletError("BAD_REQUEST", "Give the service valid terms.");
  if (
    patch &&
    Object.keys(patch).some(
      (field) => !Object.hasOwn(DEFAULT_SELLER_TERMS, field),
    )
  )
    throw new WalletError(
      "BAD_REQUEST",
      "The service contains an unknown term.",
    );
  const terms = {
    ...(previous ? storedTerms(previous) : DEFAULT_SELLER_TERMS),
    ...patch,
  };
  const problem = sellerTermsProblem(terms);
  if (problem) throw new WalletError("BAD_REQUEST", problem);
  if (terms.operator !== null) {
    try {
      address(terms.operator);
    } catch {
      throw new WalletError("BAD_REQUEST", "Enter a valid operator address.");
    }
  }
  if (previous?.listed && previous.category !== terms.category)
    throw new WalletError(
      "BAD_REQUEST",
      "The category is fixed once a service is listed.",
    );
  return terms;
}

export function sameChainTerms(
  account: {
    maxOpenJobs: number;
    defaultDeadlineSecs: bigint;
    operator: string;
    tags: ArrayLike<number>;
    operatorFeeBps: number;
  },
  terms: SellerTerms,
): boolean {
  const tags = values.encodeListingTags(terms.tags);
  return (
    account.maxOpenJobs === terms.maxOpenJobs &&
    account.defaultDeadlineSecs === BigInt(terms.deliverySecs) &&
    account.operator ===
      (terms.operator ?? "11111111111111111111111111111111") &&
    account.operatorFeeBps === terms.operatorFeeBps &&
    tags.every((byte, index) => byte === account.tags[index])
  );
}

export function sellerProceeds(
  price: bigint,
  operatorBps: number,
  marketBps: number | null,
  rate: number | null,
) {
  const operatorFee = (price * BigInt(operatorBps)) / 10000n;
  const marketFee = marketBps === null ? null : (price * BigInt(marketBps)) / 10000n;
  return {
    marketFee: marketFee === null ? null : money(marketFee, rate),
    operatorFee: money(operatorFee, rate),
    sellerNet: marketFee === null ? null : money(price - operatorFee - marketFee, rate),
  };
}

/** Older catalog responses omit the operator and capacity. Read the displayed page in one batch. */
export async function fillCatalogTerms(
  chain: Chain,
  rows: CatalogRow[],
): Promise<CatalogRow[]> {
  const missing = rows.filter(
    (row) =>
      row.maxOpenJobs === undefined ||
      row.operatorFeeBps === undefined ||
      (row.operatorFeeBps > 0 && !row.operator),
  );
  if (missing.length === 0) return rows;
  const accounts = await chain
    .readRawAccounts(missing.map((row) => row.listing))
    .catch(() => []);
  const prefix = getServiceListingDiscriminatorBytes();
  const terms = new Map<string, CatalogRow>();
  for (const [index, row] of missing.entries()) {
    const raw = accounts[index];
    if (
      !raw ||
      raw.owner !== AGENC_COORDINATION_PROGRAM_ADDRESS ||
      !Array.from(prefix).every((byte, i) => raw.data[i] === byte)
    )
      continue;
    try {
      const account = getServiceListingDecoder().decode(raw.data);
      if (
        account.providerAgent !== row.providerAgent ||
        account.price !== row.priceLamports ||
        (row.specHashHex !== null &&
          values.bytesToHex(new Uint8Array(account.specHash)) !==
            row.specHashHex)
      )
        continue;
      terms.set(row.listing, {
        ...row,
        maxOpenJobs: account.maxOpenJobs,
        operatorFeeBps: account.operatorFeeBps,
        deliverySecs:
          account.defaultDeadlineSecs > 0n
            ? Number(account.defaultDeadlineSecs)
            : null,
        operator:
          account.operator === "11111111111111111111111111111111"
            ? null
            : account.operator,
      });
    } catch {
      // An unreadable listing cannot supply a payout estimate.
    }
  }
  return rows.map((row) => terms.get(row.listing) ?? row);
}
