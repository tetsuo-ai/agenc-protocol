import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { address, createNoopSigner } from "@solana/kit";
import {
  getCreateServiceListingInstructionDataDecoder,
  getCreateServiceListingInstructionAsync,
} from "../src/generated/index.js";
import {
  createServiceListing,
  type CreateServiceListingInput,
} from "../src/facade/listings.js";
import {
  LISTING_CATEGORIES,
  isListingCategory,
  LISTING_KEBAB_PATTERN,
  LISTING_NAME_BYTES,
  LISTING_CATEGORY_BYTES,
  LISTING_TAGS_BYTES,
  encodeListingName,
  encodeListingCategory,
  encodeListingTags,
  decodeListingName,
  decodeListingCategory,
  decodeListingTags,
  type ListingCategory,
} from "../src/values/index.js";

// LISTING_METADATA v1 (P1.5) structural tests: the canonical category taxonomy,
// the in-package JSON Schema, the string<->bytes round-trip, and the facade's
// dual-form createServiceListing (strings validated+encoded via src/values; the
// raw fixed-width path untouched, byte-for-byte).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, "../schemas/listing-metadata.schema.json");

const providerAgent = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const authority = createNoopSigner(
  address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
);

/** Shared non-metadata createServiceListing inputs. */
function baseInput() {
  return {
    providerAgent,
    authority,
    listingId: new Uint8Array(32).fill(3),
    specHash: new Uint8Array(32).fill(9),
    specUri: "agenc://job-spec/sha256/test",
    price: 1000n,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: 3600n,
    maxOpenJobs: 0,
    operator: null,
    operatorFeeBps: 0,
  };
}

describe("LISTING_CATEGORIES taxonomy", () => {
  it("has exactly the 20 canonical v1 tokens, unique, kebab-valid, and encodable", () => {
    expect(LISTING_CATEGORIES).toHaveLength(20);
    expect(new Set(LISTING_CATEGORIES).size).toBe(20);
    expect(LISTING_CATEGORIES).toContain("code-generation");
    expect(LISTING_CATEGORIES).toContain("other");
    for (const token of LISTING_CATEGORIES) {
      expect(token).toMatch(LISTING_KEBAB_PATTERN);
      // Every canonical token must fit the 32-byte on-chain field.
      const bytes = encodeListingCategory(token);
      expect(bytes).toHaveLength(LISTING_CATEGORY_BYTES);
      expect(decodeListingCategory(bytes)).toBe(token);
    }
  });

  it("isListingCategory accepts every canonical token and rejects everything else", () => {
    for (const token of LISTING_CATEGORIES) {
      expect(isListingCategory(token)).toBe(true);
    }
    expect(isListingCategory("nlp")).toBe(false); // kebab-valid but non-canonical
    expect(isListingCategory("Translation")).toBe(false); // case-sensitive
    expect(isListingCategory(" translation ")).toBe(false);
    expect(isListingCategory("")).toBe(false);
    expect(isListingCategory(42)).toBe(false);
    expect(isListingCategory(null)).toBe(false);
    expect(isListingCategory(undefined)).toBe(false);
  });
});

describe("listing-metadata.schema.json", () => {
  it("parses as valid JSON with the published draft-2020-12 $id and the v1 shape", () => {
    const raw = readFileSync(SCHEMA_PATH, "utf8");
    const schema = JSON.parse(raw) as Record<string, unknown>;

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe(
      "https://agenc.tech/schemas/listing-metadata-v1.schema.json",
    );
    expect(schema.type).toBe("object");

    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props).sort()).toEqual(
      ["displayName", "links", "longDescription", "pricingNotes", "sampleOutputs", "sla"],
    );
    expect(props.displayName.type).toBe("string");
    expect(props.sampleOutputs.type).toBe("array");

    const sla = props.sla.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(sla).sort()).toEqual(["refundPolicy", "responseHours", "revisions"]);
    const links = props.links.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(links).sort()).toEqual(["docs", "website"]);

    expect(schema.required).toEqual(["displayName"]);
    // v1 evolves additively: readers must tolerate unknown fields.
    expect(schema.additionalProperties).toBe(true);
  });
});

describe("embedded NUL rejection (non-canonical padding)", () => {
  /** `size`-byte field: `prefix` bytes, one NUL, `suffix` bytes, zero-padded. */
  function fieldWithEmbeddedNul(prefix: string, suffix: string, size: number): Uint8Array {
    const out = new Uint8Array(size);
    const head = new TextEncoder().encode(prefix);
    out.set(head);
    out.set(new TextEncoder().encode(suffix), head.length + 1); // out[head.length] stays NUL
    return out;
  }

  /** Canonical layout: `text` UTF-8 bytes, zero-padded to `size`. */
  function canonicalField(text: string, size: number): Uint8Array {
    const out = new Uint8Array(size);
    out.set(new TextEncoder().encode(text));
    return out;
  }

  it("decodeListingName throws TypeError on a non-NUL byte after the first NUL", () => {
    // encodeListingName rejects embedded NULs, so bytes like these can only
    // come from a non-SDK writer; a name of "ab", NUL, "cd" would render like
    // "abcd" in most UIs while being a different value.
    const spoofed = fieldWithEmbeddedNul("ab", "cd", LISTING_NAME_BYTES);
    expect(() => decodeListingName(spoofed)).toThrow(TypeError);
    expect(() => decodeListingName(spoofed)).toThrow(/embedded NUL/);
  });

  it("decodeListingCategory and decodeListingTags reject the same layouts", () => {
    expect(() =>
      decodeListingCategory(fieldWithEmbeddedNul("code", "generation", LISTING_CATEGORY_BYTES)),
    ).toThrow(/embedded NUL/);
    expect(() =>
      decodeListingTags(fieldWithEmbeddedNul("docs", ",same-day", LISTING_TAGS_BYTES)),
    ).toThrow(/embedded NUL/);
  });

  it("still decodes canonical layouts: padded, exactly-full, and all-NUL fields", () => {
    expect(decodeListingName(canonicalField("ab", LISTING_NAME_BYTES))).toBe("ab");
    expect(decodeListingName(new Uint8Array(LISTING_NAME_BYTES))).toBe("");
    const full = "x".repeat(LISTING_NAME_BYTES); // no NUL anywhere
    expect(decodeListingName(canonicalField(full, LISTING_NAME_BYTES))).toBe(full);
  });
});

describe("string <-> bytes round-trip (values codecs)", () => {
  it("round-trips name/category/tags through the fixed-width wire form", () => {
    const name = "Café Translation Pro"; // multibyte UTF-8 on purpose
    const category: ListingCategory = "translation";
    const tags = ["english-to-french", "docs", "same-day"];

    const nameBytes = encodeListingName(name);
    const categoryBytes = encodeListingCategory(category);
    const tagsBytes = encodeListingTags(tags);

    expect(nameBytes).toHaveLength(LISTING_NAME_BYTES);
    expect(categoryBytes).toHaveLength(LISTING_CATEGORY_BYTES);
    expect(tagsBytes).toHaveLength(LISTING_TAGS_BYTES);

    expect(decodeListingName(nameBytes)).toBe(name);
    expect(decodeListingCategory(categoryBytes)).toBe(category);
    expect(decodeListingTags(tagsBytes)).toEqual(tags);
  });
});

describe("createServiceListing (facade, LISTING_METADATA v1 string form)", () => {
  it("validates + encodes string inputs and the instruction data round-trips", async () => {
    const ix = await createServiceListing({
      ...baseInput(),
      name: "Translation Pro",
      category: "translation",
      tags: ["english-to-french", "docs"],
    });

    const decoded = getCreateServiceListingInstructionDataDecoder().decode(ix.data);
    expect(decodeListingName(Uint8Array.from(decoded.name))).toBe("Translation Pro");
    expect(decodeListingCategory(Uint8Array.from(decoded.category))).toBe("translation");
    expect(decodeListingTags(Uint8Array.from(decoded.tags))).toEqual([
      "english-to-french",
      "docs",
    ]);
    expect(decoded.specUri).toBe("agenc://job-spec/sha256/test");
  });

  it("accepts mixed forms (string name, raw category/tags) per field", async () => {
    const rawCategory = encodeListingCategory("research");
    const rawTags = encodeListingTags(["sources"]);
    const ix = await createServiceListing({
      ...baseInput(),
      name: "Deep Research",
      category: rawCategory,
      tags: rawTags,
    });

    const decoded = getCreateServiceListingInstructionDataDecoder().decode(ix.data);
    expect(decodeListingName(Uint8Array.from(decoded.name))).toBe("Deep Research");
    expect(Array.from(decoded.category)).toEqual(Array.from(rawCategory));
    expect(Array.from(decoded.tags)).toEqual(Array.from(rawTags));
  });

  it("rejects a kebab-valid but non-canonical category string with TypeError", async () => {
    const input: CreateServiceListingInput = {
      ...baseInput(),
      name: "NLP Service",
      // @ts-expect-error "nlp" is intentionally not a ListingCategory
      category: "nlp",
      tags: [],
    };
    await expect(createServiceListing(input)).rejects.toThrow(TypeError);
    await expect(createServiceListing(input)).rejects.toThrow(/canonical/);
  });

  it("propagates values-module validation errors (overflow name, bad tag)", async () => {
    await expect(
      createServiceListing({
        ...baseInput(),
        name: "x".repeat(33), // 33 UTF-8 bytes > 32
        category: "other",
        tags: [],
      }),
    ).rejects.toThrow(RangeError);

    await expect(
      createServiceListing({
        ...baseInput(),
        name: "ok",
        category: "other",
        tags: ["Not-Kebab"],
      }),
    ).rejects.toThrow(TypeError);
  });

  it("keeps the raw fixed-width path byte-for-byte identical to the generated builder", async () => {
    const name = new Uint8Array(32).fill(1);
    const category = new Uint8Array(32).fill(2); // NOT valid kebab — raw path must not validate
    const tags = new Uint8Array(64).fill(3);

    const viaFacade = await createServiceListing({
      ...baseInput(),
      name,
      category,
      tags,
    });
    const viaGenerated = await getCreateServiceListingInstructionAsync({
      ...baseInput(),
      name,
      category,
      tags,
    });

    expect(Array.from(viaFacade.data)).toEqual(Array.from(viaGenerated.data));
    expect(viaFacade.accounts.map((a) => a.address)).toEqual(
      viaGenerated.accounts.map((a) => a.address),
    );

    const decoded = getCreateServiceListingInstructionDataDecoder().decode(viaFacade.data);
    expect(Array.from(decoded.name)).toEqual(Array.from(name));
    expect(Array.from(decoded.category)).toEqual(Array.from(category));
    expect(Array.from(decoded.tags)).toEqual(Array.from(tags));
  });
});
