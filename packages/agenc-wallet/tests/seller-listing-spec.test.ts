import { expect, it } from "vitest";
import { DEFAULT_SELLER_TERMS } from "../src/client/seller-terms.js";
import { listingDetails } from "../src/listing-details.js";
import { sellerListingSpec } from "../src/seller-terms.js";

const base = { ...DEFAULT_SELLER_TERMS, name: "Studio report", summary: "Prepare a report." };
const fulfilment = (spec: Record<string, unknown>) =>
  (spec.custom as { listingMetadata: Record<string, unknown> }).listingMetadata.fulfilment;

it("advertises private inputs only from a verified isolated room and keeps that sole fulfilment field", () => {
  expect(fulfilment(sellerListingSpec(base))).toBeUndefined();
  expect(fulfilment(sellerListingSpec(base, undefined, false))).toBeUndefined();
  const spec = sellerListingSpec(base, undefined, true);
  expect(fulfilment(spec)).toEqual({ privateInputs: true });
  expect(listingDetails(spec).fulfilment).toEqual({ privateInputs: true });
  expect(fulfilment(sellerListingSpec({ ...base, minimumMarginCents: 5 }, undefined, true))).toEqual({ minimumMarginCents: 5, privateInputs: true });
  // A pinned script needs the guest inbox for its own files.
  const pin = { digest: "a".repeat(64), runtimeDigest: "b".repeat(64), permissionDigest: "c".repeat(64), capabilities: "1" };
  expect(fulfilment(sellerListingSpec({ ...base, servicePin: pin } as never, undefined, true))).not.toHaveProperty("privateInputs");
});
