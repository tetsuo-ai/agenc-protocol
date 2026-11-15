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
