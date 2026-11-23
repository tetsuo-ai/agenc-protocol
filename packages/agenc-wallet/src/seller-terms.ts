import { address } from "@solana/kit";
import { values } from "@tetsuo-ai/marketplace-sdk";
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
  return {
    operatorFee: money(operatorFee, rate),
    sellerNet:
      marketBps === null
        ? null
        : money(
            price - operatorFee - (price * BigInt(marketBps)) / 10000n,
            rate,
          ),
  };
}
