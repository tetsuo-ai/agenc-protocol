// The hosted-services adapter against stand-ins that enforce the same rules
// as the public endpoints it targets (attest.agenc.ag and the agenc.ag read
// and artifact routes). Nothing here touches the network.
import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, getAddressEncoder, type Address } from "@solana/kit";
import {
  artifactUploadMessage,
  buildJobSpec,
  buildListingSpec,
  createHostedServices,
  decodeResultPointer,
  digestFromPointer,
  jobSpecHash,
  sha256Hex,
  tidyText,
} from "../src/services.js";

const MODERATOR = "13tuj7ELwtHmeR22kvaSaa2pKqSscyoHtQBF65aHuo6v";
const LISTING = "AuvhnvakgqfJaBt5CSEnYZGsZYJt5LmCpanZDCWbf9hE";
const PROVIDER = "3PgS4jwwpquqxVotTKkvR8wxNUZrExqtZckHehiABKAg";
const TASK = "HxYCVTLbhbA75KrxMQ7NDQJHnXL81xeTp76z1UeS3s23";

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
            { ...LIVE_ITEM, priceMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
            { ...LIVE_ITEM, state: 1 },
          ],
        });
      },
    });
    const services = createHostedServices({ fetchImpl: fetch });
    const rows = await services.listServices();
    expect(rows).toEqual([
      {
        listing: LISTING,
        providerAgent: PROVIDER,
        name: "Managed Repo Repair",
        category: null,
        summary: null,
        priceLamports: 100_000_000n,
        rating: 5,
        ratingCount: 2,
        jobsDone: 1,
        deliverySecs: 86_400,
      },
    ]);
  });

  it("says so plainly when the catalog is down", async () => {
    const { fetch } = fakeFetch({});
    await expect(createHostedServices({ fetchImpl: fetch }).listServices()).rejects.toMatchObject({
      code: "NETWORK",
    });
  });
});

describe("the safety check", () => {
  it("names the attestation service's signer as trusted", async () => {
    const { fetch } = fakeFetch({ "GET https://attest.agenc.ag/v1/info": INFO });
    expect(await createHostedServices({ fetchImpl: fetch }).trustedModerators()).toEqual([
      MODERATOR,
    ]);
  });

  it("publishes and attests a job spec for exactly the committed hash", async () => {
    const spec = buildJobSpec({
      title: "Haiku Writer",
      request: "A haiku.",
      acceptance: ["three lines"],
      listing: LISTING as Address,
    });
    const hash = await jobSpecHash(spec);
    const { fetch } = fakeFetch({
      "POST https://attest.agenc.ag/v1/moderation/tasks": ({ init }) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ task: TASK, jobSpecHash: hash.hex, spec });
        return json({
          ok: true,
          attested: true,
          verdict: "clean",
          specHash: hash.hex,
          specRegistryUri: `https://marketplace.agenc.tech/api/job-specs/${hash.hex}`,
        });
      },
    });
    const services = createHostedServices({ fetchImpl: fetch });
    expect(
      await services.attestTask({ task: TASK as Address, jobSpecHashHex: hash.hex, jobSpec: spec }),
    ).toEqual({ jobSpecUri: `https://marketplace.agenc.tech/api/job-specs/${hash.hex}` });
  });

  it("separates a refusal, a busy service and an answer about the wrong request", async () => {
    const input = { task: TASK as Address, jobSpecHashHex: "ab".repeat(32), jobSpec: {} };
    const held = fakeFetch({
      "POST https://attest.agenc.ag/v1/moderation/tasks": () =>
        json({ ok: true, attested: false, verdict: "blocked", specHash: input.jobSpecHashHex }),
    });
    await expect(
      createHostedServices({ fetchImpl: held.fetch }).attestTask(input),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });

    const busy = fakeFetch({
      "POST https://attest.agenc.ag/v1/moderation/tasks": () => json({ ok: false }, 429),
    });
    await expect(
      createHostedServices({ fetchImpl: busy.fetch }).attestTask(input),
    ).rejects.toMatchObject({ code: "NETWORK" });

    const wrong = fakeFetch({
      "POST https://attest.agenc.ag/v1/moderation/tasks": () =>
        json({ ok: true, attested: true, specHash: "cd".repeat(32), specRegistryUri: "https://x.test/a" }),
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

  it("publishes and attests the description of a service this wallet offers", async () => {
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
    const { fetch, calls } = fakeFetch({
      "GET https://attest.agenc.ag/v1/info": INFO,
      "POST https://attest.agenc.ag/v1/moderation/listings": ({ init }) => {
        expect(JSON.parse(String(init?.body))).toEqual({ listing: LISTING, spec });
        return json({ ok: true, attested: true, verdict: "clean", specHash: hash.hex, pinned: true });
      },
    });
    const services = createHostedServices({ fetchImpl: fetch });
    // The address written into the listing is an https one the catalog accepts.
    expect(await services.listingSpecUri(hash.hex)).toBe(
      `https://marketplace.agenc.tech/api/job-specs/${hash.hex}`,
    );
    await services.attestListing({ listing: LISTING as Address, specHashHex: hash.hex, spec });
    expect(calls).toContain("POST https://attest.agenc.ag/v1/moderation/listings");
  });

  it("tells a refused description apart from a check that should be retried", async () => {
    const input = { listing: LISTING as Address, specHashHex: "ab".repeat(32), spec: {} };
    const offer = (route: Route): Promise<void> =>
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

  it("derives where an attested spec lives from the registry", async () => {
    const { fetch } = fakeFetch({ "GET https://attest.agenc.ag/v1/info": INFO });
    expect(await createHostedServices({ fetchImpl: fetch }).jobSpecUriFor("ab".repeat(32))).toBe(
      `https://marketplace.agenc.tech/api/job-specs/${"ab".repeat(32)}`,
    );
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
