import { describe, it, expect } from "vitest";
import {
  getServiceListingEncoder,
  getServiceListingDecoder,
  ListingState,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  type ServiceListing,
  type ServiceListingArgs,
  type DecodedProgramAccount,
  type IndexerListing,
} from "@tetsuo-ai/marketplace-sdk";
import { values } from "@tetsuo-ai/marketplace-sdk";
import { getBase64Decoder, getBase64Encoder, type Address } from "@solana/kit";
import {
  listingToAgentCard,
  indexerListingToAgentCard,
  buildAgentCardManifest,
  AGENT_CARD_SCHEMA_VERSION,
  A2A_SCHEMA_VERSION,
} from "./agent-card.js";

// A deterministic on-chain-shaped fixture. We round-trip it through the SDK's
// generated encoder/decoder so the bytes are real on-chain bytes (byte-true
// parity with what the gPA / indexer read path produces).
// Real 32-byte base58 addresses (derived from all-N byte arrays) so the SDK's
// address codec accepts them when the fixture is round-tripped through the
// generated ServiceListing encoder/decoder.
const LISTING_PDA = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" as Address;
const PROVIDER_AGENT =
  "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR" as Address;
const AUTHORITY = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8" as Address;
const PRICE_MINT = "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq" as Address;
const LISTING_PDA_2 = "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY" as Address;

function makeFixture(overrides: Partial<ServiceListingArgs> = {}): ServiceListingArgs {
  return {
    providerAgent: PROVIDER_AGENT,
    authority: AUTHORITY,
    listingId: new Uint8Array(32).fill(7),
    name: values.encodeListingName("Translation Pro"),
    category: values.encodeListingCategory("translation"),
    tags: values.encodeListingTags(["english-to-french", "docs"]),
    specHash: new Uint8Array(32).fill(0xab),
    specUri: "agenc://job-spec/sha256/abc123",
    price: 1_000_000n,
    priceMint: null, // SOL
    requiredCapabilities: 0b1011n, // bits 0, 1, 3
    defaultDeadlineSecs: 3600n,
    operator: AUTHORITY, // any address; not surfaced on the card
    operatorFeeBps: 0,
    state: ListingState.Active,
    maxOpenJobs: 0,
    openJobs: 0,
    totalHires: 12n,
    totalRating: 45n, // mean = 45/10 = 4.5 over 10 ratings
    ratingCount: 10,
    version: 3n,
    createdAt: 1_700_000_000n,
    updatedAt: 1_700_000_500n,
    bump: 254,
    reserved: new Uint8Array(32),
    ...overrides,
  };
}

function decodedFrom(
  args: ServiceListingArgs,
  pda: Address = LISTING_PDA,
): DecodedProgramAccount<ServiceListing> {
  const bytes = getServiceListingEncoder().encode(args);
  const account = getServiceListingDecoder().decode(new Uint8Array(bytes));
  return { address: pda, account };
}

describe("listingToAgentCard", () => {
  it("emits a valid AgentCard with the expected fields", () => {
    const card = listingToAgentCard(decodedFrom(makeFixture()));

    expect(card.schemaVersion).toBe(AGENT_CARD_SCHEMA_VERSION);
    expect(card.id).toBe(LISTING_PDA);
    expect(card.name).toBe("Translation Pro");
    expect(card.category).toBe("translation");
    expect(card.tags).toEqual(["english-to-french", "docs"]);
    expect(card.description).toContain("Translation Pro");

    // provider
    expect(card.provider.agent).toBe(PROVIDER_AGENT);
    expect(card.provider.authority).toBe(AUTHORITY);

    // price
    expect(card.price.amount).toBe("1000000");
    expect(card.price.denomination).toBe("SOL");
    expect(card.price.native).toBe(true);

    // capabilities — bitmask 0b1011 = bits 0,1,3
    expect(card.capabilities.requiredBitmask).toBe("11");
    expect(card.capabilities.requiredBits).toEqual([0, 1, 3]);

    // trust
    expect(card.trust.state).toBe("active");
    expect(card.trust.totalHires).toBe("12");
    expect(card.trust.ratingCount).toBe(10);
    expect(card.trust.averageRating).toBe(4.5);
    expect(card.trust.specHash).toBe("ab".repeat(32));

    // hire instruction shape
    expect(card.hire.program).toBe(String(AGENC_COORDINATION_PROGRAM_ADDRESS));
    expect(card.hire.listing).toBe(LISTING_PDA);
    expect(card.hire.providerAgent).toBe(PROVIDER_AGENT);
    expect(card.hire.expectedPrice).toBe("1000000");
    expect(card.hire.expectedVersion).toBe("3");
    expect(card.hire.listingSpecHash).toBe("ab".repeat(32));
    expect(card.hire.specUri).toBe("agenc://job-spec/sha256/abc123");
    expect(card.hire.defaultDeadlineSecs).toBe("3600");
    expect(card.hire.recommendedTier).toBe("escrow");
    expect(card.hire.instruction).toContain("SDK facade");
    expect(card.hire.instruction).toContain("MCP prepare tools");
    expect(card.hire.instruction).toContain(LISTING_PDA);

    // a2a projection
    expect(card.a2a.schemaVersion).toBe(A2A_SCHEMA_VERSION);
    expect(card.a2a.name).toBe("Translation Pro");
    expect(card.a2a.provider.organization).toBe(PROVIDER_AGENT);
    expect(card.a2a.skills).toHaveLength(1);
    expect(card.a2a.skills[0]!.id).toBe(LISTING_PDA);
    expect(card.a2a.skills[0]!.tags).toEqual([
      "translation",
      "english-to-french",
      "docs",
    ]);
    expect(card.a2a.capabilities.streaming).toBe(false);
  });

  it("serializes to JSON with no bigint / non-serializable leaks", () => {
    const card = listingToAgentCard(decodedFrom(makeFixture()));
    // JSON.stringify throws on bigint; a clean round-trip proves the card is
    // fully JSON-serializable (the machine-readable contract).
    const json = JSON.stringify(card);
    const reparsed = JSON.parse(json);
    expect(reparsed.id).toBe(LISTING_PDA);
    expect(reparsed.price.amount).toBe("1000000");
    expect(typeof reparsed.capabilities.requiredBitmask).toBe("string");
  });

  it("prices in the SPL mint when priceMint is set", () => {
    const card = listingToAgentCard(
      decodedFrom(makeFixture({ priceMint: PRICE_MINT })),
    );
    expect(card.price.native).toBe(false);
    expect(card.price.denomination).toBe(PRICE_MINT);
  });

  it("reports averageRating null when there are no ratings", () => {
    const card = listingToAgentCard(
      decodedFrom(makeFixture({ ratingCount: 0, totalRating: 0n })),
    );
    expect(card.trust.averageRating).toBeNull();
    expect(card.trust.ratingCount).toBe(0);
  });

  it("maps paused and retired lifecycle states", () => {
    expect(
      listingToAgentCard(decodedFrom(makeFixture({ state: ListingState.Paused })))
        .trust.state,
    ).toBe("paused");
    expect(
      listingToAgentCard(
        decodedFrom(makeFixture({ state: ListingState.Retired })),
      ).trust.state,
    ).toBe("retired");
  });

  it("carries metadata-conformance signals and provider URL when supplied", () => {
    const card = listingToAgentCard(decodedFrom(makeFixture()), {
      metadataValid: false,
      metadataIssues: ["category not canonical"],
      providerUrl: "https://example.com/provider",
    });
    expect(card.trust.metadataValid).toBe(false);
    expect(card.trust.metadataIssues).toEqual(["category not canonical"]);
    expect(card.a2a.provider.url).toBe("https://example.com/provider");
  });

  it("emits a 0-bitmask card with no required bits", () => {
    const card = listingToAgentCard(
      decodedFrom(makeFixture({ requiredCapabilities: 0n })),
    );
    expect(card.capabilities.requiredBitmask).toBe("0");
    expect(card.capabilities.requiredBits).toEqual([]);
  });
});

describe("indexerListingToAgentCard", () => {
  it("decodes the indexer accountData and carries its metadata signals", () => {
    const args = makeFixture();
    const accountBytes = getServiceListingEncoder().encode(args);
    const accountData = getBase64Decoder().decode(new Uint8Array(accountBytes));
    const decoder = getServiceListingDecoder();

    const indexerListing = {
      pda: LISTING_PDA,
      accountData,
      metadataValid: true,
      metadataIssues: [],
    } as unknown as IndexerListing;

    const b64 = getBase64Encoder();
    const card = indexerListingToAgentCard(
      indexerListing,
      (pda, data) => ({
        address: pda as Address,
        account: decoder.decode(new Uint8Array(b64.encode(data))),
      }),
    );

    expect(card.id).toBe(LISTING_PDA);
    expect(card.name).toBe("Translation Pro");
    expect(card.trust.metadataValid).toBe(true);
    expect(card.trust.metadataIssues).toEqual([]);
  });
});

describe("buildAgentCardManifest", () => {
  it("builds a manifest over a set of listings with a fixed timestamp", () => {
    const a = decodedFrom(makeFixture({ name: values.encodeListingName("A") }));
    const b = decodedFrom(
      makeFixture({ name: values.encodeListingName("B") }),
      LISTING_PDA_2,
    );

    const manifest = buildAgentCardManifest([a, b], {
      generatedAt: "2026-06-10T00:00:00.000Z",
    });

    expect(manifest.schemaVersion).toBe("agenc.agent-card-manifest/v1");
    expect(manifest.generatedAt).toBe("2026-06-10T00:00:00.000Z");
    expect(manifest.program).toBe(String(AGENC_COORDINATION_PROGRAM_ADDRESS));
    expect(manifest.count).toBe(2);
    expect(manifest.cards.map((c) => c.name)).toEqual(["A", "B"]);
    // Fully JSON-serializable.
    expect(() => JSON.stringify(manifest)).not.toThrow();
  });

  it("builds an empty manifest for no listings", () => {
    const manifest = buildAgentCardManifest([]);
    expect(manifest.count).toBe(0);
    expect(manifest.cards).toEqual([]);
  });
});
