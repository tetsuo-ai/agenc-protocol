import { expect, it, vi } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { purchaseAdmission, purchaseCriteria } from "../src/purchase-admission.js";
import { listingDetails, tidyDetails } from "../src/listing-details.js";

it("reads the normalized seller-funded policy from the verified listing and preserves it in the cache", async () => {
  const { address } = await generateKeyPairSigner();
  const supplier = { version: 1, payingSeller: address, policy: { maxDebitLamports: "5000", allowedListings: [address],
    returnBeforeSecs: 600, reviewWindowSecs: 90, sharing: "public-brief" } };
  const details = listingDetails({ custom: { listingMetadata: { childHire: supplier,
    fulfilment: { minimumMarginCents: 4, privateInputs: true, childPolicyDigest: "0".repeat(64) } } } });
  const checked = details.fulfilment!.supplier!;
  expect(checked).toMatchObject(supplier);
  expect(checked.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(tidyDetails(details)).toEqual(details);
  expect(await purchaseAdmission({}, {}, true, checked.digest)).toEqual({});
  const admission = await purchaseAdmission({ childPolicyDigest: checked.digest }, {}, true, checked.digest);
  expect(purchaseCriteria(["One file"], admission)).toEqual(["One file", "Allow one seller-funded supplier under policy " + checked.digest]);
  await expect(purchaseAdmission({ childPolicyDigest: "0".repeat(64) }, {}, true, checked.digest)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  expect(() => listingDetails({ custom: { listingMetadata: { childHire: { ...supplier, payingSeller: "unknown" } } } })).toThrow();
});

it("requires approved local staging for a commitment and rejects a fabricated public criterion", async () => {
  const commitment = "a".repeat(64);
  const requirement = { required: true, version: 1, commitment } as const;
  const stage = { approvedJobInputs: vi.fn(async () => requirement) };
  const admission = await purchaseAdmission({ privateCommitment: commitment }, stage, true, undefined);
  expect(stage.approvedJobInputs).toHaveBeenCalledWith(commitment);
  expect(purchaseCriteria([], admission)).toEqual(["Private input handoff v1: " + commitment]);
  expect(() => purchaseCriteria(purchaseCriteria([], admission), {})).toThrow();
  await expect(purchaseAdmission({ privateCommitment: commitment }, {}, true, undefined)).rejects.toThrow();
  await expect(purchaseAdmission({ privateCommitment: commitment }, stage, false, undefined)).rejects.toThrow();
  await expect(purchaseAdmission({ privateCommitment: "b".repeat(64) }, stage, true, undefined)).rejects.toThrow();
});
