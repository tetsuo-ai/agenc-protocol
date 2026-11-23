// The hosted-services adapter against stand-ins that enforce the same rules
// as the public endpoints it targets (attest.agenc.ag and the agenc.ag read
// and artifact routes). Nothing here touches the network.
import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  type Address,
} from "@solana/kit";
import {
  artifactUploadMessage,
  buildJobSpec,
  buildListingSpec,
  createHostedServices,
  decodeResultPointer,
  digestFromPointer,
  jobSpecHash,
  sha256Hex,
  specUploadMessage,
  tidyText,
} from "../src/services.js";
import { openDetailsCache } from "../src/listing-details.js";

const MODERATOR = "13tuj7ELwtHmeR22kvaSaa2pKqSscyoHtQBF65aHuo6v";
const LISTING = "AuvhnvakgqfJaBt5CSEnYZGsZYJt5LmCpanZDCWbf9hE";
const PROVIDER = "3PgS4jwwpquqxVotTKkvR8wxNUZrExqtZckHehiABKAg";
const TASK = "HxYCVTLbhbA75KrxMQ7NDQJHnXL81xeTp76z1UeS3s23";
/** The wallet that pays for a safety check (a made-up address). */
const PAYER = getAddressDecoder().decode(new Uint8Array(32).fill(9));

// One item exactly as GET https://agenc.ag/api/listings?hireable=1 returned
// it on 2026-11-14.
const LIVE_ITEM = {
  pda: LISTING,
  providerAgent: PROVIDER,
  authority: "8cJ9HH5JdaqzBYaerVjFEWeoJHFmnqqsM6kPDPH4K5xP",
  name: "Managed Repo Repair",
  specHash: "3e6c3aa608459623427779498087130c21407dbef639fd0e6f220a8659555200",
  specUri: "https://repair.agenc.tech/managed/repo-repair/listing-metadata.json",
  priceLamports: "100000000",
  priceMint: null,
  requiredCapabilities: "1",
  defaultDeadlineSecs: 86400,
  operator: null,
  operatorFeeBps: 0,
  state: 0,
  maxOpenJobs: 4,
  openJobs: 2,
  totalHires: "9",
  ratingCount: 2,
  version: "8",
  createdAtUnix: 1787315150,
  provenance: {
    score: 1.3747,
    settledHireCount: 1,
    weightedRatingAverage: 5,
    rawRatingAverage: 5,
    rawRatingCount: 2,
  },
};

type Route = (request: { url: URL; init: RequestInit | undefined }) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.origin}${url.pathname}`;
    calls.push(key);
    const route = routes[key];
    if (route === undefined) return new Response("not found", { status: 404 });
    return route({ url, init });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const INFO: Route = () =>
  json({
    ok: true,
    signerConfigured: true,
    moderator: MODERATOR,
    jobSpecRegistry: { url: "https://marketplace.agenc.tech" },
  });

/** A description document for a listing, and the hash that listing would record for it. */
async function describedAt(
  payload: Record<string, unknown>,
): Promise<{ specHash: string; bytes: Uint8Array }> {
  const specHash = (await jobSpecHash(payload)).hex;
  return {
    specHash,
    bytes: new TextEncoder().encode(
      JSON.stringify({
        integrity: { algorithm: "sha256", canonicalization: "json-stable-v1", payloadHash: specHash },
        payload,
      }),
    ),
  };
}

/** Provider hosts, as the wallet reaches them: an address gives bytes, throws, or hangs until released. */
function fakeHosts(pages: Record<string, Uint8Array | Error | Promise<Uint8Array>>): {
  fetcher: (uri: string) => Promise<Uint8Array>;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    fetcher: async (uri) => {
      asked.push(uri);
      const page = pages[uri];
      if (page === undefined) throw new Error("no such host");
      if (page instanceof Error) throw page;
      return page;
    },
  };
}

const REPAIR_PAYLOAD = {
  category: "code-generation",
  tags: ["repair", "ci"],
  custom: {
    listingMetadata: {
      displayName: "Managed Repo Repair",
      longDescription:
        "# Managed Repo Repair\nSend a repository and a failing check. You get a pull request that makes it pass, with the reason for every change.",
      buyerInputs: ["Repository address", "The failing check"],
      deliverables: ["A pull request", "A short report"],
      sla: { responseHours: 24, revisions: 1, refundPolicy: "refund-if-not-fixed" },
    },
  },
};

const listingsRoute = (items: unknown[]): Record<string, Route> => ({
  "GET https://agenc.ag/api/listings": () => json({ total: items.length, items }),
});

describe("the catalog", () => {
  it("reads hireable services and drops anything it cannot hire", async () => {
    const { fetch } = fakeFetch({
      "GET https://agenc.ag/api/listings": ({ url }) => {
        expect(url.searchParams.get("hireable")).toBe("1");
        return json({
          total: 4,
          items: [
            LIVE_ITEM,
            { ...LIVE_ITEM, pda: "not an address" },
            { ...LIVE_ITEM, pda: TASK, priceMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
            { ...LIVE_ITEM, pda: PROVIDER, state: 1 },
          ],
        });
      },
    });
    // The description's host answers nothing, as it did on the day this item was read.
    const hosts = fakeHosts({});
    const services = createHostedServices({ fetchImpl: fetch, publicFetcher: hosts.fetcher });
    const rows = await services.listServices();
    expect(rows).toEqual([
      {
        listing: LISTING,
        listingVersion: "8",
        providerAgent: PROVIDER,
        name: "Managed Repo Repair",
        category: null,
        summary: null,
        description: null,
        tags: [],
        inputs: [],
        outputs: [],
        terms: [],
        details: "unavailable",
        priceLamports: 100_000_000n,
        rating: 5,
        ratingCount: 2,
        jobsDone: 1,
        deliverySecs: 86_400,
        maxOpenJobs: 4, operator: null, operatorFeeBps: 0,
        specHashHex: LIVE_ITEM.specHash,
      },
    ]);
    expect(hosts.asked).toEqual([LIVE_ITEM.specUri]);
  });

  it("loads the whole catalog once, even when two searches cross the former 300-row cutoff", async () => {
    const items = Array.from({ length: 315 }, (_, index) => {
      const bytes = new Uint8Array(32);
      new DataView(bytes.buffer).setUint32(0, index + 1);
      return { ...LIVE_ITEM, pda: getAddressDecoder().decode(bytes), specHash: "", specUri: "" };
    });
    const pages: number[] = [];
    const services = createHostedServices({ fetchImpl: fakeFetch({
      "GET https://agenc.ag/api/listings": ({ url }) => {
        const page = Number(url.searchParams.get("page"));
        pages.push(page);
        return json({ items: items.slice((page - 1) * 100, page * 100), total: items.length });
      },
    }).fetch });
    const [first, second] = await Promise.all([services.listServices(), services.listServices()]);
    expect(first.map((row) => row.listing)).toEqual(items.map((row) => row.pda));
    expect(second).toEqual(first);
    expect(pages).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it("rejects a repeated page and retries without caching a partial list", async () => {
    let repeats = true;
    const services = createHostedServices({ fetchImpl: fakeFetch({
      "GET https://agenc.ag/api/listings": ({ url }) => json({
        total: 2,
        items: [{ ...LIVE_ITEM, specUri: "", pda: repeats || url.searchParams.get("page") === "1" ? LISTING : TASK, specHash: "" }],
      }),
    }).fetch });
    await expect(services.listServices()).rejects.toMatchObject({ code: "NETWORK" });
    repeats = false;
    expect((await services.listServices()).map((row) => row.listing)).toEqual([LISTING, TASK]);
  });

  it("says so plainly when the catalog is down", async () => {
    const { fetch } = fakeFetch({});
    await expect(createHostedServices({ fetchImpl: fetch }).listServices()).rejects.toMatchObject({
      code: "NETWORK",
    });
  });

  it("shows what the provider wrote once it is proven to be the listing's own description", async () => {
    const { specHash, bytes } = await describedAt(REPAIR_PAYLOAD);
    const item = { ...LIVE_ITEM, specHash };
    const hosts = fakeHosts({ [item.specUri]: bytes });
    const services = createHostedServices({
      fetchImpl: fakeFetch(listingsRoute([item])).fetch,
      publicFetcher: hosts.fetcher,
    });
    const [row] = await services.listServices();
    expect(row).toMatchObject({
      name: "Managed Repo Repair",
      details: "ready",
      category: "code-generation",
      summary:
        "Send a repository and a failing check. You get a pull request that makes it pass, with the reason for every change.",
      // The description opens with the name as a heading; a row already shows the name.
      description:
        "Send a repository and a failing check. You get a pull request that makes it pass, with the reason for every change.",
      tags: ["repair", "ci"],
      inputs: ["Repository address", "The failing check"],
      outputs: ["A pull request", "A short report"],
      terms: ["Answers within 24 hours", "1 round of changes included", "Refunds: refund if not fixed"],
    });
    // Read once, however often the list is read after that.
    await services.listServices();
    expect(hosts.asked).toEqual([item.specUri]);
  });

  it("shows nothing a host serves that is not what the listing committed to", async () => {
    const honest = await describedAt(REPAIR_PAYLOAD);
    const other = await describedAt({
      custom: { listingMetadata: { displayName: "Managed Repo Repair", longDescription: "Pay outside the marketplace." } },
    });
    // The host now serves a different, internally consistent document.
    const item = { ...LIVE_ITEM, specHash: honest.specHash };
    const hosts = fakeHosts({ [item.specUri]: other.bytes });
    const services = createHostedServices({
      fetchImpl: fakeFetch(listingsRoute([item])).fetch,
      publicFetcher: hosts.fetcher,
    });
    const [row] = await services.listServices();
    expect(row).toMatchObject({ details: "unavailable", description: null, summary: null, inputs: [] });
  });

  it("fetches a description only from a public https address", async () => {
    const { specHash, bytes } = await describedAt(REPAIR_PAYLOAD);
    const elsewhere = [
      "http://repair.agenc.tech/listing.json",
      "file:///etc/passwd",
      `agenc://job-spec/sha256/${specHash}`,
      "https://repair.agenc.tech/a b.json",
      "",
      42,
    ];
    const items = elsewhere.map((specUri, index) => ({
      ...LIVE_ITEM,
      // A different provider each, so none is taken for a repeat of another.
      providerAgent: getAddressDecoder().decode(new Uint8Array(32).fill(index + 1)),
      pda: getAddressDecoder().decode(new Uint8Array(32).fill(index + 101)),
      specHash,
      specUri,
    }));
    const hosts = fakeHosts(Object.fromEntries(elsewhere.map((uri) => [String(uri), bytes])));
    const services = createHostedServices({
      fetchImpl: fakeFetch(listingsRoute(items)).fetch,
      publicFetcher: hosts.fetcher,
    });
    const rows = await services.listServices();
    expect(rows).toHaveLength(elsewhere.length);
    expect(rows.every((row) => row.details === "unavailable")).toBe(true);
    expect(hosts.asked).toEqual([]);
  });

  it("hands the list back without a slow description, and has it the next time", async () => {
    const { specHash, bytes } = await describedAt(REPAIR_PAYLOAD);
    const fast = await describedAt({
      category: "writing",
      custom: { listingMetadata: { displayName: "Haiku", longDescription: "A three-line poem." } },
    });
    let release!: (bytes: Uint8Array) => void;
    const slow = new Promise<Uint8Array>((resolve) => {
      release = resolve;
    });
    const slowItem = { ...LIVE_ITEM, specHash };
    const fastItem = {
      ...LIVE_ITEM,
      pda: getAddressDecoder().decode(new Uint8Array(32).fill(7)),
      name: "Haiku",
      specHash: fast.specHash,
      specUri: "https://poems.example/haiku.json",
    };
    const hosts = fakeHosts({ [slowItem.specUri]: slow, [fastItem.specUri]: fast.bytes });
    const services = createHostedServices({
      fetchImpl: fakeFetch(listingsRoute([slowItem, fastItem])).fetch,
      publicFetcher: hosts.fetcher,
      detailsWaitMs: 20,
    });
    const first = await services.listServices();
    expect(first.map((row) => [row.name, row.details])).toEqual([
      ["Managed Repo Repair", "loading"],
      ["Haiku", "ready"],
    ]);
    // Asking again while it loads does not ask the host again.
    await services.listServices();
    expect(hosts.asked.filter((uri) => uri === slowItem.specUri)).toHaveLength(1);

    release(bytes);
    await slow;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await services.listServices();
    expect(second.map((row) => [row.name, row.details])).toEqual([
      ["Managed Repo Repair", "ready"],
      ["Haiku", "ready"],
    ]);
    expect(second[0]!.inputs).toEqual(["Repository address", "The failing check"]);
  });

  it("leaves a host that does not answer alone for ten minutes, then asks again", async () => {
    const { specHash, bytes } = await describedAt(REPAIR_PAYLOAD);
    const item = { ...LIVE_ITEM, specHash };
    const pages: Record<string, Uint8Array | Error> = { [item.specUri]: new Error("410 Gone") };
    const hosts = fakeHosts(pages);
    let clock = 1_800_000_000_000;
    const services = createHostedServices({
      fetchImpl: fakeFetch(listingsRoute([item])).fetch,
      publicFetcher: hosts.fetcher,
      now: () => clock,
    });
    expect((await services.listServices())[0]!.details).toBe("unavailable");
    clock += 9 * 60_000;
    expect((await services.listServices())[0]!.details).toBe("unavailable");
    expect(hosts.asked).toHaveLength(1);

    // The host is back.
    pages[item.specUri] = bytes;
    clock += 2 * 60_000;
    expect((await services.listServices())[0]!.details).toBe("ready");
    expect(hosts.asked).toHaveLength(2);
  });

  it("remembers a description by its hash, so another start of the service does not fetch it", async () => {
    const { specHash, bytes } = await describedAt(REPAIR_PAYLOAD);
    const item = { ...LIVE_ITEM, specHash };
    const detailsCache = openDetailsCache();
    const online = fakeHosts({ [item.specUri]: bytes });
    await createHostedServices({
      fetchImpl: fakeFetch(listingsRoute([item])).fetch,
      publicFetcher: online.fetcher,
      detailsCache,
    }).listServices();
    expect(online.asked).toHaveLength(1);

    // Later the provider's host is gone. What was read and checked is still shown.
    const offline = fakeHosts({});
    const [row] = await createHostedServices({
      fetchImpl: fakeFetch(listingsRoute([item])).fetch,
      publicFetcher: offline.fetcher,
      detailsCache,
    }).listServices();
    expect(row).toMatchObject({ details: "ready", category: "code-generation" });
    expect(offline.asked).toEqual([]);
  });

  it("tries the other address when two listings share a description and one host is down", async () => {
    const { specHash, bytes } = await describedAt(REPAIR_PAYLOAD);
    const down = { ...LIVE_ITEM, specHash, specUri: "https://down.example/listing.json" };
    const up = {
      ...LIVE_ITEM,
      pda: getAddressDecoder().decode(new Uint8Array(32).fill(8)),
      providerAgent: getAddressDecoder().decode(new Uint8Array(32).fill(3)),
      specHash,
      specUri: "https://up.example/listing.json",
    };
    const hosts = fakeHosts({ [up.specUri]: bytes });
    const services = createHostedServices({
      fetchImpl: fakeFetch(listingsRoute([down, up])).fetch,
      publicFetcher: hosts.fetcher,
    });
    await services.listServices();
    // Once either address has given the description, both listings have it.
    const rows = await services.listServices();
    expect(rows.map((row) => row.details)).toEqual(["ready", "ready"]);
  });

  it("keeps each listing ID even when the provider, price and description match", async () => {
    const { specHash, bytes } = await describedAt(REPAIR_PAYLOAD);
    const addressOf = (fill: number) => getAddressDecoder().decode(new Uint8Array(32).fill(fill));
    const untried = { ...LIVE_ITEM, specHash, pda: addressOf(11), provenance: { settledHireCount: 0 }, ratingCount: 0 };
    const proven = { ...LIVE_ITEM, specHash, pda: addressOf(12) };
    const dearer = { ...LIVE_ITEM, specHash, pda: addressOf(13), priceLamports: "200000000" };
    const someoneElse = { ...LIVE_ITEM, specHash, pda: addressOf(14), providerAgent: addressOf(15) };
    const hosts = fakeHosts({ [LIVE_ITEM.specUri]: bytes });
    const services = createHostedServices({
      fetchImpl: fakeFetch(listingsRoute([untried, proven, dearer, someoneElse])).fetch,
      publicFetcher: hosts.fetcher,
    });
    const rows = await services.listServices();
    const targeted = await services.listServices({ listing: untried.pda });
    expect(targeted.find((row) => row.listing === untried.pda)?.details).toBe("ready");
    expect(rows.map((row) => row.listing)).toEqual([addressOf(11), addressOf(12), addressOf(13), addressOf(14)]);
  });

  it("keeps listings on later legacy catalog pages when the fee or capacity is missing", async () => {
    const pages: number[] = [];
    const addressOf = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
    const services = createHostedServices({
      fetchImpl: fakeFetch({ "GET https://agenc.ag/api/listings": ({ url }) => {
        const page = Number(url.searchParams.get("page"));
        pages.push(page);
        const items = Array.from({ length: page === 1 ? 100 : 2 }, (_, i) => ({
          ...LIVE_ITEM, pda: addressOf((page - 1) * 100 + i + 1),
          maxOpenJobs: undefined, operatorFeeBps: undefined, operator: undefined,
        }));
        return json({ total: 102, items });
      } }).fetch,
      publicFetcher: fakeHosts({}).fetcher,
    });
    const rows = await services.listServices();
    expect(rows).toHaveLength(102);
    expect(rows.slice(100).map((row) => row.listing)).toEqual([addressOf(101), addressOf(102)]);
    expect(pages).toEqual([1, 2]);
  });

  it("uses words the list itself carries only when the description gives none", async () => {
    const listed = {
      ...LIVE_ITEM,
      category: "research",
      summary: "A summary the list carried.",
    };
    const offline = createHostedServices({
      fetchImpl: fakeFetch(listingsRoute([listed])).fetch,
      publicFetcher: fakeHosts({}).fetcher,
    });
    expect((await offline.listServices())[0]).toMatchObject({
      details: "unavailable",
      category: "research",
      summary: "A summary the list carried.",
      description: null,
    });

    const { specHash, bytes } = await describedAt(REPAIR_PAYLOAD);
    const described = { ...listed, specHash };
    const online = createHostedServices({
      fetchImpl: fakeFetch(listingsRoute([described])).fetch,
      publicFetcher: fakeHosts({ [described.specUri]: bytes }).fetcher,
    });
    expect((await online.listServices())[0]).toMatchObject({
      details: "ready",
      category: "code-generation",
      summary:
        "Send a repository and a failing check. You get a pull request that makes it pass, with the reason for every change.",
    });
  });
});

/**
 * A stand-in for the marketplace site's publishing route with the same checks
 * the real one makes: JSON only, a fresh wallet-signed message binding the
 * exact bytes, a listing's stated hash re-derived, a job's plain fields
 * turned into the marketplace's own request shape.
 */
function specStore(seen: { uploads: unknown[] } = { uploads: [] }): Route {
  return async ({ init }) => {
    const headers = new Headers(init?.headers);
    if (!/^application\/json\b/i.test(headers.get("content-type") ?? "")) {
      return json({ error: "Content-Type must be application/json" }, 415);
    }
    const wallet = headers.get("x-agenc-wallet") ?? "";
    const ts = Number(headers.get("x-agenc-ts"));
    const received = init?.body as Uint8Array;
    const uploadSha256 = createHash("sha256").update(received).digest("hex");
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(getAddressEncoder().encode(wallet as Address)),
      ]),
      format: "der",
      type: "spki",
    });
    const signed = verify(
      null,
      Buffer.from(specUploadMessage(uploadSha256, wallet, ts)),
      publicKey,
      Buffer.from(headers.get("x-agenc-signature") ?? "", "base64"),
    );
    if (Math.abs(Date.now() - ts) > 600_000) return json({ error: "Upload signature expired. Retry." }, 400);
    if (!signed) return json({ error: "Signature verification failed" }, 401);

    const parsed = JSON.parse(Buffer.from(received).toString("utf8")) as Record<string, any>;
    seen.uploads.push(parsed);
    let payload: Record<string, unknown>;
    if (parsed.payload?.custom?.listingMetadata) {
      payload = parsed.payload;
      const stated = parsed.integrity?.payloadHash;
      if ((await jobSpecHash(payload)).hex !== stated) {
        return json({ error: "Listing job spec payload hash does not match envelope integrity." }, 400);
      }
    } else {
      const description = String(parsed.summary ?? parsed.description ?? parsed.title ?? "").trim();
      if (!description) {
        return json({ error: "Job spec needs a non-empty title, summary, or description string." }, 400);
      }
      payload = {
        schemaVersion: 1,
        kind: "agenc.marketplace.jobSpec",
        title: String(parsed.title ?? description.slice(0, 96)),
        shortDescription: description.slice(0, 240),
        fullDescription: parsed.details ?? null,
        acceptanceCriteria: parsed.acceptance ?? [],
        deliverables: parsed.deliverables ?? [],
        constraints: null,
        attachments: [],
        execution: { sandbox: "default" },
        custom: null,
        context: {},
      };
    }
    const payloadSha256 = (await jobSpecHash(payload)).hex;
    return json({
      uri: `https://blob.example/job-specs/${payloadSha256}.json`,
      sha256: payloadSha256,
      payloadSha256,
      uploadSha256,
      bytes: received.length,
      payload,
      envelopeSha256: "00".repeat(32),
    });
  };
}

describe("publishing", () => {
  it("publishes a job's request through the marketplace, in the marketplace's own shape", async () => {
    const signer = await generateKeyPairSigner();
    const seen = { uploads: [] as unknown[] };
    const { fetch } = fakeFetch({ "POST https://agenc.ag/api/jobspecs": specStore(seen) });
    const services = createHostedServices({ fetchImpl: fetch });
    const long = "Summarise this. ".repeat(40).trim();

    const published = await services.publishJobSpec({
      title: "Plain Summary",
      request: long,
      acceptance: ["Two sentences."],
      listing: LISTING as Address,
      signer,
    });

    // Plain fields went up. The marketplace keeps 240 characters as the
    // summary, so a longer request also goes in whole as the details.
    expect(seen.uploads).toEqual([
      {
        title: "Hire: Plain Summary",
        summary: long,
        details: long,
        acceptance: ["Two sentences."],
        deliverables: [
          "Put the complete result in your submission. The buyer reads exactly what you submit.",
        ],
      },
    ]);
    // What comes back is what a worker will read, and its hash is its own.
    expect(published.spec).toMatchObject({
      schemaVersion: 1,
      kind: "agenc.marketplace.jobSpec",
      title: "Hire: Plain Summary",
      shortDescription: long.slice(0, 240),
      fullDescription: long,
      acceptanceCriteria: ["Two sentences."],
    });
    expect(published.hashHex).toBe((await jobSpecHash(published.spec)).hex);
    expect(published.uri).toBe(`https://blob.example/job-specs/${published.hashHex}.json`);

    // The same request again is the same published request.
    const again = await services.publishJobSpec({
      title: "Plain Summary",
      request: long,
      acceptance: ["Two sentences."],
      listing: LISTING as Address,
      signer,
    });
    expect(again).toEqual(published);

    // A short request needs no separate details.
    const short = await services.publishJobSpec({
      title: "Plain Summary",
      request: "A haiku.",
      acceptance: [],
      listing: LISTING as Address,
      signer,
    });
    expect(seen.uploads.at(-1)).toEqual({
      title: "Hire: Plain Summary",
      summary: "A haiku.",
      deliverables: [
        "Put the complete result in your submission. The buyer reads exactly what you submit.",
      ],
    });
    expect(short.hashHex).not.toBe(published.hashHex);
  });

  it("publishes the description of a service and returns where the listing should point", async () => {
    const signer = await generateKeyPairSigner();
    const spec = buildListingSpec({
      name: "Line Writer",
      summary: "One friendly line about anything you name.",
      category: "other",
    });
    // The shape the marketplace publishes for every listing.
    expect(spec).toEqual({
      category: "other",
      custom: {
        listingMetadata: {
          displayName: "Line Writer",
          longDescription: "One friendly line about anything you name.",
        },
      },
    });
    const hash = await jobSpecHash(spec);
    const seen = { uploads: [] as unknown[] };
    const { fetch } = fakeFetch({ "POST https://agenc.ag/api/jobspecs": specStore(seen) });

    const uri = await createHostedServices({ fetchImpl: fetch }).publishListing({
      spec,
      specHashHex: hash.hex,
      signer,
    });

    expect(uri).toBe(`https://blob.example/job-specs/${hash.hex}.json`);
    expect(seen.uploads).toEqual([
      {
        integrity: { algorithm: "sha256", canonicalization: "json-stable-v1", payloadHash: hash.hex },
        payload: spec,
      },
    ]);
  });

  it("verifies the approved brief even if the publisher returns a self-consistent hash", async () => {
    const job = {
      title: "Proofread", request: "Read my draft.", acceptance: ["Mark every typo."],
      terms: { deadline: 1_800_000_000, reviewWindowSecs: 41, eligibility: null, listingDurationSecs: 3600 },
      listing: LISTING as Address, signer: await generateKeyPairSigner(),
    };
    const host = (route: Route) =>
      createHostedServices({ fetchImpl: fakeFetch({ "POST https://agenc.ag/api/jobspecs": route }).fetch });
    const original = await host(specStore()).publishJobSpec(job);
    expect(original.spec.deliverables).toEqual([expect.stringContaining("41 seconds")]);
    for (const change of [
      { acceptance: ["Other checks."] }, { instructions: "Different work." }, { details: "Another brief." },
      { acceptanceCriteria: [] }, { shortDescription: "Something else." }, { deliverables: [] },
    ]) {
      const payload = { ...original.spec, ...change };
      const payloadSha256 = (await jobSpecHash(payload)).hex;
      const publisher = host(() => json({ uri: original.uri, payload, payloadSha256 }));
      await expect(publisher.publishJobSpec(job)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    }
  });

  it("believes nothing the publisher says that it cannot re-derive", async () => {
    const signer = await generateKeyPairSigner();
    const spec = buildListingSpec({ name: "Line Writer", summary: "A line.", category: "other" });
    const hash = await jobSpecHash(spec);
    const job = { title: "X", request: "Y", acceptance: [], listing: LISTING as Address, signer };
    const using = (route: Route) =>
      createHostedServices({ fetchImpl: fakeFetch({ "POST https://agenc.ag/api/jobspecs": route }).fetch });
    const good = {
      uri: "https://blob.example/job-specs/x.json",
      payloadSha256: hash.hex,
      payload: spec,
    };

    // A payload that does not hash to what the answer claims.
    await expect(
      using(() => json({ ...good, payloadSha256: "cd".repeat(32) })).publishJobSpec(job),
    ).rejects.toMatchObject({ code: "NETWORK" });
    // An address that is not a plain https one.
    for (const uri of ["http://blob.example/x", "javascript:alert(1)", "", 7]) {
      await expect(using(() => json({ ...good, uri })).publishJobSpec(job)).rejects.toMatchObject({
        code: "NETWORK",
      });
    }
    // A description other than the one this wallet committed to.
    await expect(
      using(() => json(good)).publishListing({ spec, specHashHex: "ab".repeat(32), signer }),
    ).rejects.toMatchObject({ code: "NETWORK" });
    // Refused outright, or down.
    await expect(using(() => json({ error: "no" }, 400)).publishJobSpec(job)).rejects.toMatchObject({
      code: "NOT_ALLOWED",
      message: "The marketplace would not publish this request.",
    });
    for (const status of [401, 429, 503]) {
      await expect(using(() => json({ error: "x" }, status)).publishJobSpec(job)).rejects.toMatchObject({
        code: "NETWORK",
      });
    }
  });

  it("says so when a network has nowhere to publish", async () => {
    const signer = await generateKeyPairSigner();
    const services = createHostedServices({ fetchImpl: fakeFetch({}).fetch, specUploadUrl: null });
    expect(await services.publishListing({ spec: {}, specHashHex: "ab".repeat(32), signer })).toBeNull();
    await expect(
      services.publishJobSpec({ title: "X", request: "Y", acceptance: [], listing: LISTING as Address, signer }),
    ).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });
});

describe("the safety check", () => {
  it("names the attestation service's signer as trusted", async () => {
    const { fetch } = fakeFetch({ "GET https://attest.agenc.ag/v1/info": INFO });
    expect(await createHostedServices({ fetchImpl: fetch }).trustedModerators()).toEqual([
      MODERATOR,
    ]);
  });

  it("has a published request approved for exactly the committed hash", async () => {
    const spec = { kind: "agenc.marketplace.jobSpec", title: "Hire: Haiku Writer", shortDescription: "A haiku." };
    const hash = await jobSpecHash(spec);
    const uri = `https://blob.example/job-specs/${hash.hex}.json`;
    const { fetch } = fakeFetch({
      "POST https://attest.agenc.ag/v1/moderation/tasks": ({ init }) => {
        const body = JSON.parse(String(init?.body));
        // The wallet says where the request can be read and who pays for the check.
        expect(body).toEqual({ task: TASK, jobSpecHash: hash.hex, spec, specUri: uri, payer: PAYER });
        return json({ ok: true, attested: true, verdict: "clean", specHash: hash.hex });
      },
    });
    const services = createHostedServices({ fetchImpl: fetch });
    // A service that recorded the approval itself leaves nothing to pay.
    expect(
      await services.attestTask({
        task: TASK as Address,
        jobSpecHashHex: hash.hex,
        jobSpec: spec,
        jobSpecUri: uri,
        payer: PAYER,
      }),
    ).toBeNull();
  });

  it("hands back the approval to pay for when the service does not pay for it", async () => {
    const hashHex = "ab".repeat(32);
    const wire = Uint8Array.from({ length: 300 }, (_, index) => index % 251);
    const answer = (payment: unknown, extra: Record<string, unknown> = {}): Route => () =>
      json({
        ok: true,
        attested: false,
        verdict: "clean",
        specHash: hashHex,
        moderator: MODERATOR,
        attestation: null,
        payment,
        ...extra,
      });
    const ask = (route: Route) =>
      createHostedServices({
        fetchImpl: fakeFetch({ "POST https://attest.agenc.ag/v1/moderation/tasks": route }).fetch,
      }).attestTask({
        task: TASK as Address,
        jobSpecHashHex: hashHex,
        jobSpec: {},
        jobSpecUri: "https://blob.example/job-specs/x.json",
        payer: PAYER,
      });

    // The transaction comes through untouched, for the wallet to check.
    expect(
      await ask(answer({ transaction: Buffer.from(wire).toString("base64"), payer: PAYER })),
    ).toEqual({ transaction: wire, moderator: MODERATOR });

    // Anything that is not plainly a transaction from a named approver is
    // refused as a fault of the service, never as a refusal of the request.
    for (const bad of [
      answer({ transaction: "" }),
      answer({ transaction: "not base64!" }),
      answer({ transaction: 7 }),
      answer({}),
      answer({ transaction: Buffer.alloc(1233).toString("base64") }),
      answer({ transaction: Buffer.from(wire).toString("base64") }, { moderator: "nobody" }),
      answer({ transaction: Buffer.from(wire).toString("base64") }, { moderator: null }),
    ]) {
      await expect(ask(bad)).rejects.toMatchObject({ code: "NETWORK" });
    }
    // An approval for other words is refused even when it comes with a payment.
    await expect(
      ask(answer({ transaction: Buffer.from(wire).toString("base64") }, { specHash: "cd".repeat(32) })),
    ).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("separates a refusal, a busy service and an answer about the wrong request", async () => {
    const input = {
      task: TASK as Address,
      jobSpecHashHex: "ab".repeat(32),
      jobSpec: {},
      jobSpecUri: "https://blob.example/job-specs/x.json",
      payer: PAYER,
    };
    const held = fakeFetch({
      "POST https://attest.agenc.ag/v1/moderation/tasks": () =>
        json({ ok: true, attested: false, verdict: "blocked", specHash: input.jobSpecHashHex }),
    });
    await expect(
      createHostedServices({ fetchImpl: held.fetch }).attestTask(input),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });

    // Busy, or the published request is not readable yet.
    for (const status of [409, 429, 502]) {
      const busy = fakeFetch({
        "POST https://attest.agenc.ag/v1/moderation/tasks": () => json({ ok: false }, status),
      });
      await expect(
        createHostedServices({ fetchImpl: busy.fetch }).attestTask(input),
      ).rejects.toMatchObject({ code: "NETWORK" });
    }

    const wrong = fakeFetch({
      "POST https://attest.agenc.ag/v1/moderation/tasks": () =>
        json({ ok: true, attested: true, specHash: "cd".repeat(32) }),
    });
    await expect(
      createHostedServices({ fetchImpl: wrong.fetch }).attestTask(input),
    ).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("refuses a listing the service blocks", async () => {
    const { fetch } = fakeFetch({
      "POST https://attest.agenc.ag/v1/moderation/listings": () =>
        json({ ok: true, attested: false, verdict: "blocked" }),
    });
    await expect(
      createHostedServices({ fetchImpl: fetch }).acquireListingAttestation(LISTING as Address),
    ).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });

  it("does not pay for the check of somebody else's service", async () => {
    // A buyer names no payer. A service that does not pay for approvals turns
    // the request away, and the buyer is told the service cannot be hired yet.
    const { fetch } = fakeFetch({
      "POST https://attest.agenc.ag/v1/moderation/listings": ({ init }) => {
        expect(JSON.parse(String(init?.body))).toEqual({ listing: LISTING });
        return json({ ok: false, error: "This service does not pay for approvals." }, 402);
      },
    });
    await expect(
      createHostedServices({ fetchImpl: fetch }).acquireListingAttestation(LISTING as Address),
    ).rejects.toMatchObject({
      code: "NOT_AVAILABLE",
      message: expect.stringMatching(/has not been through the marketplace's safety check/),
    });
  });

  it("has the published description of a service approved", async () => {
    const spec = buildListingSpec({
      name: "Line Writer",
      summary: "One friendly line about anything you name.",
      category: "other",
    });
    const hash = await jobSpecHash(spec);
    const uri = `https://blob.example/job-specs/${hash.hex}.json`;
    const { fetch, calls } = fakeFetch({
      "POST https://attest.agenc.ag/v1/moderation/listings": ({ init }) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          listing: LISTING,
          spec,
          specUri: uri,
          payer: PAYER,
        });
        return json({ ok: true, attested: true, verdict: "clean", specHash: hash.hex });
      },
    });
    expect(
      await createHostedServices({ fetchImpl: fetch }).attestListing({
        listing: LISTING as Address,
        specHashHex: hash.hex,
        spec,
        specUri: uri,
        payer: PAYER,
      }),
    ).toBeNull();
    expect(calls).toContain("POST https://attest.agenc.ag/v1/moderation/listings");
  });

  it("hands back a listing's approval to pay for", async () => {
    const hashHex = "ab".repeat(32);
    const wire = Uint8Array.from({ length: 280 }, (_, index) => (index * 7) % 256);
    const { fetch } = fakeFetch({
      "POST https://attest.agenc.ag/v1/moderation/listings": () =>
        json({
          ok: true,
          attested: false,
          verdict: "clean",
          specHash: hashHex,
          moderator: MODERATOR,
          attestation: null,
          payment: { transaction: Buffer.from(wire).toString("base64"), payer: PAYER },
        }),
    });
    expect(
      await createHostedServices({ fetchImpl: fetch }).attestListing({
        listing: LISTING as Address,
        specHashHex: hashHex,
        spec: {},
        specUri: "https://blob.example/job-specs/x.json",
        payer: PAYER,
      }),
    ).toEqual({ transaction: wire, moderator: MODERATOR });
  });

  it("tells a refused description apart from a check that should be retried", async () => {
    const input = {
      listing: LISTING as Address,
      specHashHex: "ab".repeat(32),
      spec: {},
      specUri: "https://blob.example/job-specs/x.json",
      payer: PAYER,
    };
    const offer = (route: Route): Promise<unknown> =>
      createHostedServices({
        fetchImpl: fakeFetch({ "POST https://attest.agenc.ag/v1/moderation/listings": route }).fetch,
      }).attestListing(input);

    await expect(
      offer(() => json({ ok: true, attested: false, verdict: "blocked", specHash: input.specHashHex })),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(offer(() => json({ ok: false }, 422))).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    // Busy, not yet readable, or a listing the checker has not seen yet.
    for (const status of [404, 409, 429, 503]) {
      await expect(offer(() => json({ ok: false }, status))).rejects.toMatchObject({ code: "NETWORK" });
    }
    await expect(
      offer(() => json({ ok: true, attested: true, specHash: "cd".repeat(32) })),
    ).rejects.toMatchObject({ code: "NETWORK" });
  });
});

describe("deliveries", () => {
  const body = new TextEncoder().encode("the finished work");
  const digest = sha256Hex(body);

  it("reads the pointer forms a provider may record", () => {
    const slot = new Uint8Array(64);
    slot.set(new TextEncoder().encode(digest));
    expect(decodeResultPointer(slot)).toBe(digest);
    expect(digestFromPointer(digest)).toBe(digest);
    expect(digestFromPointer(`agenc://result/sha256/${digest}`)).toBe(digest);
    const compact = `ag://a/${Buffer.from(digest, "hex").toString("base64url")}`;
    expect(digestFromPointer(compact)).toBe(digest);
    expect(digestFromPointer("https://example.com/file")).toBeNull();
  });

  it("returns a delivery only when it matches its fingerprint", async () => {
    const pointer = new Uint8Array(64);
    pointer.set(new TextEncoder().encode(digest));
    const good = createHostedServices({
      fetchImpl: fakeFetch({}).fetch,
      artifactBaseUrl: "https://store.example",
      publicFetcher: async (uri) => {
        expect(uri).toBe(`https://store.example/artifacts/${digest}`);
        return body;
      },
    });
    expect(await good.fetchResult({ proofHashHex: digest, resultData: pointer })).toEqual({
      bytes: body,
      uri: `https://store.example/artifacts/${digest}`,
    });

    const swapped = createHostedServices({
      fetchImpl: fakeFetch({}).fetch,
      artifactBaseUrl: "https://store.example",
      publicFetcher: async () => new TextEncoder().encode("something else"),
    });
    expect(await swapped.fetchResult({ proofHashHex: digest, resultData: pointer })).toBeNull();

    const unknown = createHostedServices({ fetchImpl: fakeFetch({}).fetch });
    expect(await unknown.fetchResult({ proofHashHex: digest, resultData: pointer })).toBeNull();
  });

  it("signs an upload the way the artifact route verifies it", async () => {
    const signer = await generateKeyPairSigner();
    let stored: Uint8Array | null = null;
    const { fetch } = fakeFetch({
      "POST https://agenc.ag/api/artifacts": async ({ init }) => {
        // The same checks as the route: server-side hash, wallet-signed
        // message binding hash + wallet + timestamp.
        const headers = new Headers(init?.headers);
        const wallet = headers.get("x-agenc-wallet")!;
        const ts = Number(headers.get("x-agenc-ts"));
        const received = init?.body as Uint8Array;
        const hash = createHash("sha256").update(received).digest("hex");
        const publicKey = createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(getAddressEncoder().encode(wallet as Address)),
          ]),
          format: "der",
          type: "spki",
        });
        const ok = verify(
          null,
          Buffer.from(artifactUploadMessage(hash, wallet, ts)),
          publicKey,
          Buffer.from(headers.get("x-agenc-signature")!, "base64"),
        );
        if (!ok || Math.abs(Date.now() - ts) > 600_000) return json({ error: "bad signature" }, 401);
        stored = received;
        return json({ uri: `https://blob.example/artifacts/${hash}`, sha256: hash, bytes: received.length });
      },
    });
    const services = createHostedServices({
      fetchImpl: fetch,
      artifactUploadUrl: "https://agenc.ag/api/artifacts",
    });
    const uploader = services.resultUploader(signer);
    expect(uploader?.url).toBe("https://agenc.ag/api/artifacts");
    const response = await uploader!.fetch(uploader!.url, { method: "POST", body });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ uri: `agenc://result/sha256/${digest}` });
    expect(stored).toEqual(body);
    expect(createHostedServices({ fetchImpl: fetch }).resultUploader(signer)).toBeNull();
  });
});

describe("job specs", () => {
  it("are deterministic and readable by a provider", async () => {
    const input = {
      title: "Haiku Writer",
      request: "A haiku.",
      acceptance: [],
      listing: LISTING as Address,
    };
    const first = await jobSpecHash(buildJobSpec(input));
    const second = await jobSpecHash(buildJobSpec({ ...input }));
    expect(first.hex).toBe(second.hex);
    expect(buildJobSpec(input)).toMatchObject({
      kind: "agenc.marketplace.jobSpec",
      instructions: "A haiku.",
      sourceListing: LISTING,
    });
    expect(buildJobSpec(input)).not.toHaveProperty("acceptance");
  });

  it("tidies untrusted display text", () => {
    expect(tidyText("  two\n\nlines\u0000 ", 40)).toBe("two lines");
    expect(tidyText("x".repeat(50), 10)).toHaveLength(10);
    expect(tidyText(42, 10)).toBeNull();
    expect(tidyText("   ", 10)).toBeNull();
  });
});

describe("the jobs a provider finished", () => {
  // Two items exactly as GET https://agenc.ag/api/tasks?provider=... returned
  // them on 2026-11-19, cut to the fields that matter.
  const SETTLED = {
    pda: "GRXsDCi6VA9uyNCD7TGGvADv9Uh2Pe4smn5ZArVBAbdB",
    status: "settled",
    rewardLamports: "100000000",
    protocolFeeBps: 500,
    creatorPda: "ARzC5XuXeUFRUFL3tT65zXA7HCZwVSV8AMoKvk7dCvLw",
    providerAgent: PROVIDER,
  };
  const OPEN = { ...SETTLED, pda: "8yZFpHVBmgTTL1pZEnp3w1QhV39DM3fBqBEmMpJRaY8r", status: "open" };

  it("keeps the paid-out jobs of that provider, and nothing else", async () => {
    const asked: URL[] = [];
    const { fetch } = fakeFetch({
      "GET https://agenc.ag/api/tasks": ({ url }) => {
        asked.push(url);
        return json({
          page: 1,
          pageSize: 100,
          total: 4,
          items: [
            SETTLED,
            OPEN,
            // Someone else's job, and a job with no address.
            { ...SETTLED, pda: TASK, providerAgent: LISTING },
            { ...SETTLED, pda: "not an address" },
          ],
        });
      },
    });
    const services = createHostedServices({ fetchImpl: fetch, finishedGapMs: 0 });
    expect(await services.finishedJobs!(PROVIDER as Address)).toEqual([SETTLED.pda]);
    // Asked for by provider, a page of a hundred, with no "page=1": the
    // route sends that elsewhere, and a redirect is never followed.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.searchParams.get("provider")).toBe(PROVIDER);
    expect(asked[0]!.searchParams.get("pageSize")).toBe("100");
    expect(asked[0]!.searchParams.has("page")).toBe(false);
    expect(asked[0]!.searchParams.has("status")).toBe(false);
  });

  it("reads every page, and keeps the list a while", async () => {
    let now = 1_000_000;
    const pages: Array<string | null> = [];
    const { fetch } = fakeFetch({
      "GET https://agenc.ag/api/tasks": ({ url }) => {
        pages.push(url.searchParams.get("page"));
        const page = Number(url.searchParams.get("page") ?? "1");
        const items = Array.from({ length: page === 1 ? 100 : 20 }, (_, index) => ({
          ...SETTLED,
          pda: getAddressDecoder().decode(new Uint8Array(32).fill(page * 101 + index + 1)),
        }));
        return json({ slot: 1000, page, pageSize: 100, total: 120, items });
      },
    });
    const services = createHostedServices({ fetchImpl: fetch, finishedGapMs: 0, now: () => now });
    expect(await services.finishedJobs!(PROVIDER as Address)).toHaveLength(120);
    expect(pages).toEqual([null, "2"]);
    // Within ten minutes the list is not read again.
    now += 9 * 60_000;
    expect(await services.finishedJobs!(PROVIDER as Address)).toHaveLength(120);
    expect(pages).toHaveLength(2);
    now += 2 * 60_000;
    await services.finishedJobs!(PROVIDER as Address);
    expect(pages).toHaveLength(4);
  });

  it("asks one provider at a time, never two closer together than the gap", async () => {
    const starts: number[] = [];
    const { fetch } = fakeFetch({
      "GET https://agenc.ag/api/tasks": () => {
        starts.push(Date.now());
        return json({ page: 1, pageSize: 100, total: 0, items: [] });
      },
    });
    const services = createHostedServices({ fetchImpl: fetch, finishedGapMs: 150 });
    const other = getAddressDecoder().decode(new Uint8Array(32).fill(7));
    await Promise.all([services.finishedJobs!(PROVIDER as Address), services.finishedJobs!(other)]);
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(140);
  });

  it("says so when the list cannot be read, and a refusal does not stop the next provider", async () => {
    let refuse = true;
    const { fetch } = fakeFetch({
      "GET https://agenc.ag/api/tasks": () =>
        refuse
          ? json({ ok: false, code: "PUBLIC_READ_RATE_LIMITED", retryAfterSeconds: 33 }, 429)
          : json({ page: 1, pageSize: 100, total: 1, items: [SETTLED] }),
    });
    const services = createHostedServices({ fetchImpl: fetch, finishedGapMs: 0 });
    await expect(services.finishedJobs!(PROVIDER as Address)).rejects.toMatchObject({ code: "NETWORK" });
    refuse = false;
    expect(await services.finishedJobs!(PROVIDER as Address)).toEqual([SETTLED.pda]);
  });

  it("does not follow the route when it sends the request elsewhere", async () => {
    const { fetch } = fakeFetch({
      "GET https://agenc.ag/api/tasks": () => {
        throw new TypeError("fetch failed: unexpected redirect");
      },
    });
    const services = createHostedServices({ fetchImpl: fetch, finishedGapMs: 0 });
    await expect(services.finishedJobs!(PROVIDER as Address)).rejects.toMatchObject({ code: "NETWORK" });
  });
});

it("verifies independent public dispute evidence at the submitted HTTPS address", async () => {
  const bytes = Buffer.from("Independent receipt");
  const uri = "https://evidence.example/seller-receipt";
  const services = createHostedServices({ publicFetcher: async address => { expect(address).toBe(uri); return bytes; } });
  expect(await services.fetchReviewEvidence!(uri, sha256Hex(bytes))).toEqual(bytes);
  expect(await services.fetchReviewEvidence!(uri, "a".repeat(64))).toBeNull();
  expect(await services.fetchReviewEvidence!("file:///untrusted", sha256Hex(bytes))).toBeNull();
});
