// What a provider wrote about a service: proving a fetched document is the
// one the listing committed to, and tidying it for a person to read.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listingDetails,
  MAX_LISTING_SPEC_BYTES,
  openDetailsCache,
  summarize,
  tidyDetails,
  verifiedListingPayload,
  withoutLeadingName,
} from "../src/listing-details.js";
import { jobSpecHash } from "../src/services.js";

const bytesOf = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

// The description of a real service, byte for byte as its address served it
// on 2026-11-15, with the hash its listing recorded on mainnet.
const LIVE_HASH = "bd12daf5bdbbc9f2c0fc57a7fe8150daff4cf40f3d1b3896c78b278549250520";
const LIVE_DOCUMENT =
  '{"integrity":{"algorithm":"sha256","canonicalization":"json-stable-v1","payloadHash":"bd12daf5bdbbc9f2c0fc57a7fe8150daff4cf40f3d1b3896c78b278549250520"},"payload":{"category":"image-gen","custom":{"listingMetadata":{"buyerInputs":["Topic","Tone"],"deliverables":["Meme Concept","Caption","Image"],"displayName":"Alb3rT Meme Forge","longDescription":"# Alb3rT Meme Forge Turn any idea into a meme. Input: - Topic - Tone Output: - Meme Concept - Caption - Image Featuring AgenC and Alb3rT. Custom-made for every request. No violent, explicit, hateful, or illegal content."}},"tags":["meme","image-gen","agenc","cyberpunk","solana"]}}';

async function envelope(payload: Record<string, unknown>): Promise<{ bytes: Uint8Array; hash: string }> {
  const hash = (await jobSpecHash(payload)).hex;
  return {
    hash,
    bytes: bytesOf({
      integrity: { algorithm: "sha256", canonicalization: "json-stable-v1", payloadHash: hash },
      payload,
    }),
  };
}

describe("proving a description is the listing's own", () => {
  it("accepts a real description against the hash its listing recorded", async () => {
    const payload = await verifiedListingPayload(new TextEncoder().encode(LIVE_DOCUMENT), LIVE_HASH);
    expect(payload).not.toBeNull();
    expect(listingDetails(payload!)).toEqual({
      // It was published as one line; its list has its lines back.
      description:
        "Alb3rT Meme Forge Turn any idea into a meme.\nInput:\n- Topic\n- Tone\nOutput:\n- Meme Concept\n- Caption\n- Image Featuring AgenC and Alb3rT. Custom-made for every request. No violent, explicit, hateful, or illegal content.",
      category: "image-gen",
      tags: ["meme", "image-gen", "agenc", "cyberpunk", "solana"],
      inputs: ["Topic", "Tone"],
      outputs: ["Meme Concept", "Caption", "Image"],
      terms: [],
    });
  });

  it("refuses the same document for any other listing", async () => {
    const other = `${LIVE_HASH.slice(0, 63)}1`;
    expect(await verifiedListingPayload(new TextEncoder().encode(LIVE_DOCUMENT), other)).toBeNull();
  });

  it("refuses words that were changed after the listing committed to them", async () => {
    const { hash } = await envelope({ custom: { listingMetadata: { displayName: "A", longDescription: "Honest." } } });
    const swapped = bytesOf({
      integrity: { algorithm: "sha256", canonicalization: "json-stable-v1", payloadHash: hash },
      payload: { custom: { listingMetadata: { displayName: "A", longDescription: "Send me your keys." } } },
    });
    expect(await verifiedListingPayload(swapped, hash)).toBeNull();
  });

  it("refuses a document that is not an envelope, or names another way of hashing", async () => {
    const payload = { custom: { listingMetadata: { displayName: "A" } } };
    const { hash } = await envelope(payload);
    // The bare payload, with nothing saying how it was hashed.
    expect(await verifiedListingPayload(bytesOf(payload), hash)).toBeNull();
    for (const integrity of [
      { algorithm: "sha1", canonicalization: "json-stable-v1", payloadHash: hash },
      { algorithm: "sha256", canonicalization: "none", payloadHash: hash },
      { algorithm: "sha256", canonicalization: "json-stable-v1", payloadHash: hash.toUpperCase() },
      { algorithm: "sha256", canonicalization: "json-stable-v1" },
    ]) {
      expect(await verifiedListingPayload(bytesOf({ integrity, payload }), hash)).toBeNull();
    }
    expect(await verifiedListingPayload(bytesOf({ integrity: [], payload: [] }), hash)).toBeNull();
    expect(await verifiedListingPayload(bytesOf([1, 2, 3]), hash)).toBeNull();
  });

  it("refuses what is not JSON, not UTF-8, empty or too large to be a description", async () => {
    const { bytes, hash } = await envelope({ custom: {} });
    expect(await verifiedListingPayload(bytes, hash)).not.toBeNull();
    expect(await verifiedListingPayload(new Uint8Array(0), hash)).toBeNull();
    expect(await verifiedListingPayload(new TextEncoder().encode("<html>gone</html>"), hash)).toBeNull();
    expect(await verifiedListingPayload(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]), hash)).toBeNull();
    expect(await verifiedListingPayload(new Uint8Array(MAX_LISTING_SPEC_BYTES + 1).fill(0x20), hash)).toBeNull();
    expect(await verifiedListingPayload(bytes, "not a hash")).toBeNull();
  });
});

describe("tidying what a provider wrote", () => {
  it("keeps the words and the line breaks and drops the Markdown", () => {
    const details = listingDetails({
      category: "writing",
      tags: ["notes", "plain-words"],
      custom: {
        listingMetadata: {
          displayName: "Meeting Notes",
          longDescription:
            "# Meeting Notes\r\n\r\n**Send** a recording or a transcript. You get:\n\n* a summary\n+ the decisions\n- who does what\n\n\n\n---\nSee [an example](https://example.com/sample) or `ask`.\n> Quiet hours apply.\n```\n",
        },
      },
    });
    expect(details.description).toBe(
      "Meeting Notes\n\nSend a recording or a transcript. You get:\n\n- a summary\n- the decisions\n- who does what\n\nSee an example or ask.\nQuiet hours apply.",
    );
    expect(details.category).toBe("writing");
    expect(details.tags).toEqual(["notes", "plain-words"]);
  });

  it("gives a list that was published as one line its lines back", () => {
    // A real description, as published on 2026-11-15.
    const flat =
      "Professional setup of autonomous AI agents on AgenC (Solana mainnet). What's included (0.22 SOL): - Full agent registration and PDA setup - Runtime + Daemon configuration - 2-3 professional service listings - Complete step-by-step documentation Important Notes: - This service provides detailed guidance, commands, and documentation. - I cannot run commands directly on your computer. Buyer Input: - Main wallet address - Desired agent name and focus Delivery: - Detailed Markdown guide with commands and screenshots - Verification steps";
    const details = listingDetails({ custom: { listingMetadata: { longDescription: flat } } });
    expect(details.description).toBe(
      [
        "Professional setup of autonomous AI agents on AgenC (Solana mainnet). What's included (0.22 SOL):",
        "- Full agent registration and PDA setup",
        "- Runtime + Daemon configuration",
        "- 2-3 professional service listings",
        "- Complete step-by-step documentation",
        "Important Notes:",
        "- This service provides detailed guidance, commands, and documentation.",
        "- I cannot run commands directly on your computer.",
        "Buyer Input:",
        "- Main wallet address",
        "- Desired agent name and focus",
        "Delivery:",
        "- Detailed Markdown guide with commands and screenshots",
        "- Verification steps",
      ].join("\n"),
    );
    // Not one word is added, dropped or moved.
    expect(details.description!.replace(/\n(?:- )?/g, " ").replace(/\s+/g, " ")).toBe(
      flat.replace(/ - /g, " ").replace(/\s+/g, " "),
    );
  });

  it("gives headings that were published in the middle of a line their lines back", () => {
    // A real description, as published on 2026-11-15.
    const flat =
      "# X Growth Pro Kit Professional X (Twitter) growth service for Solana projects, AI agents, and crypto builders. ## What's included (0.15 SOL) - Profile audit + Bio, Header and Pinned optimization - 3-5 day content strategy - 1 High-engagement Thread ## What to include when hiring - Your X profile link - Project name and goal (followers, raids, launch, etc.) ## Delivery Complete Markdown kit + images, ready to use within 24 hours. No spam.";
    expect(listingDetails({ custom: { listingMetadata: { longDescription: flat } } }).description).toBe(
      [
        "X Growth Pro Kit Professional X (Twitter) growth service for Solana projects, AI agents, and crypto builders.",
        "What's included (0.15 SOL)",
        "- Profile audit + Bio, Header and Pinned optimization",
        "- 3-5 day content strategy",
        "- 1 High-engagement Thread",
        "What to include when hiring",
        "- Your X profile link",
        "- Project name and goal (followers, raids, launch, etc.)",
        "Delivery Complete Markdown kit + images, ready to use within 24 hours. No spam.",
      ].join("\n"),
    );
  });

  it("leaves prose with a dash or two alone", () => {
    for (const prose of [
      "Guidance and documents - you run the commands on your own machine.",
      "We write: fast - clear - short - honest copy, the way you speak.",
      "Three things - speed - care - price - set us apart.",
    ]) {
      expect(listingDetails({ custom: { listingMetadata: { longDescription: prose } } }).description).toBe(prose);
    }
  });

  it("turns the terms a provider states into plain lines", () => {
    const stated = listingDetails({
      custom: {
        listingMetadata: {
          sla: { refundPolicy: "no-refund-after-accept", responseHours: 24, revisions: 0 },
          pricingNotes: "Fixed price covers one scoped writing job up to ~1500 words.",
        },
      },
    });
    expect(stated.terms).toEqual([
      "Answers within 24 hours",
      "No rounds of changes included",
      "Refunds: no refund after accept",
      "Price: Fixed price covers one scoped writing job up to ~1500 words.",
    ]);
    const other = listingDetails({
      custom: {
        listingMetadata: {
          sla: { responseHours: 0.5, revisions: 2, refundPolicy: "Full refund if I miss the deadline." },
        },
      },
    });
    expect(other.terms).toEqual([
      "Answers within the hour",
      "2 rounds of changes included",
      "Refunds: Full refund if I miss the deadline.",
    ]);
    expect(
      listingDetails({ custom: { listingMetadata: { sla: { responseHours: 1, revisions: 1 } } } }).terms,
    ).toEqual(["Answers within 1 hour", "1 round of changes included"]);
    expect(
      listingDetails({ custom: { listingMetadata: { sla: { responseHours: 240 } } } }).terms,
    ).toEqual(["Answers within 10 days"]);
    // Many providers write their terms as one sentence, and some as a bare number of hours.
    expect(
      listingDetails({ custom: { listingMetadata: { sla: "24 hours after confirmation" } } }).terms,
    ).toEqual(["24 hours after confirmation"]);
    expect(listingDetails({ custom: { listingMetadata: { sla: "24" } } }).terms).toEqual([
      "Answers within 24 hours",
    ]);
  });

  it("treats a field of the wrong shape as absent", () => {
    expect(
      listingDetails({
        category: "Not A Token",
        tags: ["ok", "Not Ok", 7, "ok", "x".repeat(40)],
        custom: {
          listingMetadata: {
            longDescription: { nested: true },
            buyerInputs: "Topic",
            deliverables: [1, null, "  ", "A report", "a report", { text: "no" }],
            sla: { responseHours: -1, revisions: 1.5, refundPolicy: 9 },
            pricingNotes: ["free"],
          },
        },
      }),
    ).toEqual({
      description: null,
      category: null,
      tags: ["ok"],
      inputs: [],
      outputs: ["A report"],
      terms: [],
    });
    expect(listingDetails({})).toEqual({
      description: null,
      category: null,
      tags: [],
      inputs: [],
      outputs: [],
      terms: [],
    });
    expect(listingDetails({ custom: "no", tags: "meme" }).tags).toEqual([]);
  });

  it("clips everything a provider controls", () => {
    const details = listingDetails({
      tags: Array.from({ length: 30 }, (_, index) => `tag-${index}`),
      custom: {
        listingMetadata: {
          longDescription: "word ".repeat(2_000),
          buyerInputs: Array.from({ length: 30 }, (_, index) => `input ${index} ${"x".repeat(400)}`),
          deliverables: Array.from({ length: 30 }, (_, index) => `thing ${index}`),
          sla: "s".repeat(2_000),
          pricingNotes: "p".repeat(2_000),
        },
      },
    });
    expect(details.description!.length).toBe(2_000);
    expect(details.description!.endsWith("…")).toBe(true);
    expect(details.tags).toHaveLength(8);
    expect(details.inputs).toHaveLength(8);
    expect(details.inputs.every((entry) => entry.length <= 160)).toBe(true);
    expect(details.outputs).toHaveLength(8);
    expect(details.terms.every((entry) => entry.length <= 280)).toBe(true);
  });

  it("removes characters that hide or reorder text", () => {
    // A right-to-left override, a zero-width space, a byte-order mark and a bell.
    const hidden = String.fromCharCode(0x202e, 0x200b, 0xfeff, 0x07);
    const details = listingDetails({
      custom: {
        listingMetadata: {
          longDescription: `Safe${hidden}text`,
          buyerInputs: [`A${hidden}B`],
        },
      },
    });
    expect(details.description).toBe("Safe text");
    expect(details.inputs).toEqual(["A B"]);
  });

  it("forces a remembered description back into shape", () => {
    expect(tidyDetails(null)).toBeNull();
    expect(tidyDetails("text")).toBeNull();
    expect(
      tidyDetails({
        description: "Kept.\n\nSecond paragraph.",
        category: "research",
        tags: ["a", 5],
        inputs: ["One", 2],
        outputs: "none",
        terms: ["Answers within 24 hours", "x".repeat(900)],
        extra: "ignored",
      }),
    ).toEqual({
      description: "Kept.\n\nSecond paragraph.",
      category: "research",
      tags: ["a"],
      inputs: ["One"],
      outputs: [],
      terms: ["Answers within 24 hours", `${"x".repeat(279)}…`],
    });
  });
});

describe("one line for a list", () => {
  it("drops the name a description opens with", () => {
    expect(
      summarize(
        "Alb3rT Meme Forge",
        "Alb3rT Meme Forge Turn any idea into a meme. Input: - Topic - Tone Output: - Meme Concept - Caption - Image Featuring AgenC and Alb3rT. Custom-made for every request. No violent, explicit, hateful, or illegal content.",
      ),
    ).toBe("Turn any idea into a meme.");
    expect(summarize("Haiku Writer", "Haiku Writer: a three-line poem about anything you name.")).toBe(
      "a three-line poem about anything you name.",
    );
  });

  it("keeps a name that is part of the first sentence", () => {
    expect(summarize("Research", "Researching any topic you name, with sources.")).toBe(
      "Researching any topic you name, with sources.",
    );
    expect(summarize("Research", "Research")).toBe("Research");
    // The name is the subject here, as two real services have it.
    expect(summarize("ElonBot", "ElonBot watches one account and turns its posts into alerts.")).toBe(
      "ElonBot watches one account and turns its posts into alerts.",
    );
    expect(withoutLeadingName("Lex Meme Forge", "Lex Meme Forge turns a short prompt into a meme concept.")).toBe(
      "Lex Meme Forge turns a short prompt into a meme concept.",
    );
  });

  it("drops a name that stands as a heading, however it is set off", () => {
    const body = "Professional growth service for projects and builders.";
    for (const opening of [
      `X Growth Pro Kit\n${body}`,
      `X Growth Pro Kit ${body}`,
      `X Growth Pro Kit: ${body}`,
      `X Growth Pro Kit - ${body}`,
      `x growth pro kit | ${body}`,
    ]) {
      expect(withoutLeadingName("X Growth Pro Kit", opening)).toBe(body);
    }
    // Too little would be left to be worth showing alone.
    expect(withoutLeadingName("Poems", "Poems: short ones.")).toBe("Poems: short ones.");
  });

  it("says what the service is and stops before the lists", () => {
    // With its lines, as tidied; and as one line, as published.
    for (const description of [
      "Turn any idea into a meme.\nInput:\n- Topic\n- Tone\nOutput:\n- Image",
      "Turn any idea into a meme. Input: Topic + Tone. Output: Meme Concept + Caption + Image.",
    ]) {
      expect(summarize("Meme Forge", description)).toBe("Turn any idea into a meme.");
    }
    expect(
      summarize(
        "Agent Setup",
        "Professional setup of autonomous agents. What is included (0.22): - Registration - Configuration - Testing",
      ),
    ).toBe("Professional setup of autonomous agents.");
    // A second sentence is added while the first says little.
    expect(summarize("X", "Short one. This one says a little more about what the buyer gets back.")).toBe(
      "Short one. This one says a little more about what the buyer gets back.",
    );
    // A number is not the end of a sentence.
    expect(summarize("X", "Costs 0.5 of a unit per page and is ready in 2.5 hours for most jobs.")).toBe(
      "Costs 0.5 of a unit per page and is ready in 2.5 hours for most jobs.",
    );
    // A description that is only a list still gives a line.
    expect(summarize("X", "Input: a topic. Output: a poem.")).toBe("Input: a topic.");
  });

  it("joins lines, and cuts at the end of a sentence when it has to cut", () => {
    expect(summarize("X", "First line.\n\nSecond line.")).toBe("First line. Second line.");
    const long = `${"A sentence of some length that says something. ".repeat(3)}${"Then it goes on and on without a stop ".repeat(6)}`;
    const cut = summarize("X", long)!;
    expect(cut.length).toBeLessThanOrEqual(180);
    expect(cut.endsWith("says something.")).toBe(true);
    const noStops = summarize("X", "word ".repeat(100))!;
    expect(noStops.length).toBeLessThanOrEqual(180);
    expect(noStops.endsWith("…")).toBe(true);
    expect(summarize("X", null)).toBeNull();
  });
});

describe("remembering descriptions", () => {
  const folders: string[] = [];
  const folder = (): string => {
    const made = mkdtempSync(path.join(tmpdir(), "agenc-details-"));
    folders.push(made);
    return made;
  };
  afterEach(() => {
    for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
  });
  const HASH = "a".repeat(64);
  const DETAILS = {
    description: "A short, plain summary.",
    category: "writing",
    tags: ["summary"],
    inputs: ["The text"],
    outputs: ["A summary"],
    terms: ["Answers within 1 hour"],
  };

  it("keeps a description for the next start of the service", async () => {
    const file = path.join(folder(), "nested", "descriptions.json");
    const first = openDetailsCache({ file });
    expect(first.get(HASH)).toBeUndefined();
    first.set(HASH, DETAILS);
    await first.flush();
    // Private to the person, like the wallet's other files.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(openDetailsCache({ file }).get(HASH)).toEqual(DETAILS);
  });

  it("lives without a file", async () => {
    const cache = openDetailsCache();
    cache.set(HASH, DETAILS);
    expect(cache.get(HASH)).toEqual(DETAILS);
    await cache.flush();
    cache.set("not a hash", DETAILS);
    expect(cache.get("not a hash")).toBeUndefined();
  });

  it("starts empty from a file it cannot read, and repairs it on the next save", async () => {
    const file = path.join(folder(), "descriptions.json");
    const lines: string[] = [];
    for (const broken of ["{ not json", JSON.stringify({ version: 99, entries: { [HASH]: { details: DETAILS } } }), "[]"]) {
      writeFileSync(file, broken);
      const cache = openDetailsCache({ file, log: (line) => lines.push(line) });
      expect(cache.get(HASH)).toBeUndefined();
    }
    expect(lines.some((line) => line.includes("could not be read"))).toBe(true);
    const cache = openDetailsCache({ file });
    cache.set(HASH, DETAILS);
    await cache.flush();
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
    expect(openDetailsCache({ file }).get(HASH)).toEqual(DETAILS);
  });

  it("trusts a saved entry no more than a fetched one", () => {
    const file = path.join(folder(), "descriptions.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: {
          [HASH]: { details: { ...DETAILS, description: "d".repeat(9_000), tags: ["Not A Tag"] }, seenAt: 1 },
          "not-a-hash": { details: DETAILS, seenAt: 1 },
          ["b".repeat(64)]: { details: "nope", seenAt: 1 },
        },
      }),
    );
    const cache = openDetailsCache({ file });
    expect(cache.get(HASH)!.description!.length).toBe(2_000);
    expect(cache.get(HASH)!.tags).toEqual([]);
    expect(cache.get("not-a-hash")).toBeUndefined();
    expect(cache.get("b".repeat(64))).toBeUndefined();
  });

  it("drops the descriptions nobody has asked for the longest when it is full", async () => {
    const file = path.join(folder(), "descriptions.json");
    let clock = 1_000;
    const cache = openDetailsCache({ file, now: () => clock });
    const hashOf = (index: number): string => index.toString(16).padStart(64, "0");
    for (let index = 0; index < 620; index += 1) {
      clock += 1;
      cache.set(hashOf(index), DETAILS);
    }
    await cache.flush();
    const saved = Object.keys(JSON.parse(readFileSync(file, "utf8")).entries);
    expect(saved).toHaveLength(600);
    expect(saved).not.toContain(hashOf(0));
    expect(saved).toContain(hashOf(619));
    expect(cache.get(hashOf(0))).toBeUndefined();
  });

  it("does not stop the service when the folder cannot be written", async () => {
    const lines: string[] = [];
    // A file where a folder is needed.
    const blocker = path.join(folder(), "blocker");
    writeFileSync(blocker, "x");
    const cache = openDetailsCache({ file: path.join(blocker, "descriptions.json"), log: (line) => lines.push(line) });
    cache.set(HASH, DETAILS);
    await cache.flush();
    expect(cache.get(HASH)).toEqual(DETAILS);
    expect(lines.some((line) => line.includes("could not be saved"))).toBe(true);
  });
});
