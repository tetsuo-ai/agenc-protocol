import { describe, it, expect } from "vitest";
import { freshSvm, seedProtocolConfig, fundedSigner, send, accountData } from "./harness.js";
import { registerAgent } from "../src/facade/agents.js";
import { createServiceListing, findListingPda } from "../src/facade/listings.js";
import { findAgentPda, getServiceListingDecoder } from "../src/generated/index.js";
import {
  decodeListingName,
  decodeListingCategory,
  decodeListingTags,
  LISTING_NAME_BYTES,
  LISTING_CATEGORY_BYTES,
  LISTING_TAGS_BYTES,
} from "../src/values/index.js";

// REAL on-chain execution of the LISTING_METADATA v1 string form (P1.5):
// createServiceListing with STRING name/category/tags through the facade, then
// fetch the ServiceListing account and prove the exact strings round-trip via
// the values decoders (strings -> facade encoding -> on-chain bytes -> strings).
describe("e2e: LISTING_METADATA v1 string inputs round-trip through the real program", () => {
  it("creates a listing from strings and decodes identical name/category/tags on-chain", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);

    // Register the provider agent (same recipe as listing.e2e.test.ts).
    const provider = await fundedSigner(svm);
    const agentId = new Uint8Array(32).fill(3);
    await send(svm, provider, [
      await registerAgent({
        authority: provider,
        agentId,
        capabilities: 1n,
        endpoint: "http://provider.test",
        metadataUri: null,
        stakeAmount: 0n,
      }),
    ]);
    const [providerAgent] = await findAgentPda({ agentId });

    // LISTING_METADATA v1 string inputs (multibyte UTF-8 in the name on purpose).
    const name = "Café Translation Pro";
    const category = "translation";
    const tags = ["english-to-french", "docs", "same-day"];

    const listingId = new Uint8Array(32).fill(4);
    const ix = await createServiceListing({
      providerAgent,
      authority: provider,
      listingId,
      name,
      category,
      tags,
      specHash: new Uint8Array(32).fill(7),
      specUri: "agenc://job-spec/sha256/test",
      price: 1_000_000n,
      priceMint: null,
      requiredCapabilities: 1n,
      defaultDeadlineSecs: 3600n,
      maxOpenJobs: 0,
      operator: null,
      operatorFeeBps: 0,
    });
    await send(svm, provider, [ix]);

    const [listing] = await findListingPda({ providerAgent, listingId });
    const data = accountData(svm, listing);
    expect(data).not.toBeNull();

    const decoded = getServiceListingDecoder().decode(data!);
    expect(decoded.providerAgent).toBe(providerAgent);
    expect(decoded.authority).toBe(provider.address);
    expect(decoded.price).toBe(1_000_000n);

    // The on-chain fields are exactly the fixed v1 widths...
    expect(decoded.name).toHaveLength(LISTING_NAME_BYTES);
    expect(decoded.category).toHaveLength(LISTING_CATEGORY_BYTES);
    expect(decoded.tags).toHaveLength(LISTING_TAGS_BYTES);

    // ...and the values decoders recover the EXACT input strings.
    expect(decodeListingName(Uint8Array.from(decoded.name))).toBe(name);
    expect(decodeListingCategory(Uint8Array.from(decoded.category))).toBe(category);
    expect(decodeListingTags(Uint8Array.from(decoded.tags))).toEqual(tags);
  });
});
