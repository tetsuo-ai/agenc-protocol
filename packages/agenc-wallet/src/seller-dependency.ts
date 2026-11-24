import { address } from "@solana/kit";
import { WalletError } from "./errors.js";
import type { SellerDependency as ChildHirePolicy } from "./client/seller-terms.js";

function refuseChild(message: string): never { throw new WalletError("BAD_REQUEST", message); }

export function checkedChildPolicy(value: ChildHirePolicy): ChildHirePolicy {
  if (
    !value ||
    !Array.isArray(value.allowedListings) ||
    !value.allowedListings.length ||
    value.allowedListings.length > 16 ||
    new Set(value.allowedListings).size !== value.allowedListings.length ||
    typeof value.maxDebitLamports !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value.maxDebitLamports) ||
    BigInt(value.maxDebitLamports) > 0xffffffffffffffffn ||
    ![value.returnBeforeSecs, value.reviewWindowSecs].every(
      (v) => Number.isSafeInteger(v) && v > 0 && v <= 604800,
    ) ||
    !["public-brief", "buyer-approved-input"].includes(value.sharing)
  )
    refuseChild("Check the supplier policy, spending cap and return times.");
  return {
    allowedListings: value.allowedListings.map(address).sort(),
    maxDebitLamports: value.maxDebitLamports,
    returnBeforeSecs: value.returnBeforeSecs,
    reviewWindowSecs: value.reviewWindowSecs,
    sharing: value.sharing,
  };
}

export function withChildDependency(
  spec: Record<string, unknown>,
  payer: string,
  input: ChildHirePolicy,
): Record<string, unknown> {
  const policy = checkedChildPolicy(input);
  const custom = spec.custom as { listingMetadata?: Record<string, unknown> } | undefined;
  if (!custom?.listingMetadata) refuseChild("The supplier terms need a service listing.");
  return {
    ...spec,
    custom: {
      ...custom,
      listingMetadata: {
        ...custom.listingMetadata,
        childHire: { version: 1, payingSeller: address(payer), policy },
      },
    },
  };
}
