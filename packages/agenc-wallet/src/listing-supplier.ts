import { createHash } from "node:crypto";
import { isAddress } from "@solana/kit";
import type { ListedSupplier } from "./client/purchase-input.js";
import { record } from "./hosted-http.js";

/** Normalize the same public policy fields as the child hire before binding a parent quote. */
export function listedSupplier(value: unknown): ListedSupplier {
  const terms = record(value);
  const p = record(terms?.policy);
  const seconds = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 604800;
  if (!terms || terms.version !== 1 || typeof terms.payingSeller !== "string" || !isAddress(terms.payingSeller) || !p ||
      !Array.isArray(p.allowedListings) || p.allowedListings.length < 1 || p.allowedListings.length > 16 ||
      !p.allowedListings.every((v): v is string => typeof v === "string" && isAddress(v)) ||
      new Set(p.allowedListings).size !== p.allowedListings.length || typeof p.maxDebitLamports !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(p.maxDebitLamports) || BigInt(p.maxDebitLamports) > 0xffffffffffffffffn ||
      !seconds(p.returnBeforeSecs) || !seconds(p.reviewWindowSecs) ||
      (p.sharing !== "public-brief" && p.sharing !== "buyer-approved-input"))
    throw new Error("The supplier funding terms are invalid.");
  const policy: ListedSupplier["policy"] = { allowedListings: [...p.allowedListings].sort(), maxDebitLamports: p.maxDebitLamports,
    returnBeforeSecs: p.returnBeforeSecs, reviewWindowSecs: p.reviewWindowSecs, sharing: p.sharing };
  return { version: 1, payingSeller: terms.payingSeller, policy, digest: createHash("sha256").update(JSON.stringify(policy)).digest("hex") };
}
