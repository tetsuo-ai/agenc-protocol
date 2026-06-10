// Tests for the indexer module (PLAN.md P3.2): the hosted-indexer client
// against a fake fetch (no network anywhere).
//
// The load-bearing case is DECODE PARITY: a fixture ServiceListing built with
// the generated encoder, served through the fake fetch as base64
// `accountData`, must decode to DEEP-EQUAL results from
// `indexer.listActiveListings()` and the gPA queries module's
// `listActiveListings()` over the same bytes.
import { describe, it, expect } from "vitest";
import { getAddressDecoder, getBase64Decoder, type Address } from "@solana/kit";
import {
  createIndexerClient,
  IndexerError,
  ListingState,
  getServiceListingEncoder,
  type IndexerFetchLike,
  type ServiceListingArgs,
} from "../src/index.js";
import {
  listActiveListings,
  type ProgramAccountsTransport,
} from "../src/queries/index.js";

// ---------------------------------------------------------------------------
// Fixtures + fake fetch
// ---------------------------------------------------------------------------

const addressDecoder = getAddressDecoder();
const base64Decoder = getBase64Decoder();

function addrFromByte(b: number): Address {
  return addressDecoder.decode(new Uint8Array(32).fill(b));
}

function bytes32(b: number): Uint8Array {
  return new Uint8Array(32).fill(b);
}

/** NUL-pad a string into a fixed-size byte field. */
function paddedBytes(text: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(new TextEncoder().encode(text));
  return out;
}

const DEFAULT_ADDR = "11111111111111111111111111111111" as Address;

function listingFixtureArgs(
  overrides: Partial<ServiceListingArgs> = {},
): ServiceListingArgs {
  return {
    providerAgent: addrFromByte(0xa1),
    authority: addrFromByte(0xa2),
    listingId: bytes32(0x10),
    name: paddedBytes("Parity Fixture", 32),
    category: paddedBytes("code-generation", 32),
    tags: paddedBytes("rust,solana", 64),
    specHash: bytes32(0x13),
    specUri: "agenc://job-spec/sha256/abc",
    price: 1_000_000n,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: 3600n,
    operator: DEFAULT_ADDR,
    operatorFeeBps: 9,
    state: ListingState.Active,
    maxOpenJobs: 7,
    openJobs: 1,
    totalHires: 3n,
    totalRating: 12n,
    ratingCount: 4,
    version: 2n,
    createdAt: 1_700_000_000n,
    updatedAt: 1_700_000_100n,
    bump: 254,
    reserved: bytes32(0),
    ...overrides,
  };
}

/** Encode a fixture and wrap it as the indexer's Listing JSON. */
function asIndexerItem(pda: Address, args: ServiceListingArgs) {
  const bytes = getServiceListingEncoder().encode(args);
  return {
    item: {
      pda,
      accountData: base64Decoder.decode(bytes),
      decoded: {
        provider: args.providerAgent,
        authority: args.authority,
        name: "Parity Fixture",
        category: "code-generation",
        tags: ["rust", "solana"],
        specHash: "13".repeat(32),
        specUri: args.specUri,
        price: String(args.price),
        priceMint: null,
        state: args.state,
        maxOpenJobs: args.maxOpenJobs,
        openJobs: args.openJobs,
        totalHires: String(args.totalHires),
        version: String(args.version),
        createdAt: String(args.createdAt),
        updatedAt: String(args.updatedAt),
      },
      metadataValid: true,
      metadataIssues: [],
      lastSlot: 1234,
      lastSignature: "5sig".padEnd(16, "x"),
    },
    bytes: new Uint8Array(bytes),
  };
}

type FakeRoute = (
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: string },
) => { status?: number; payload: unknown };

/** Recording fake fetch with a tiny router. */
function createFakeFetch(route: FakeRoute) {
  const calls: Array<{
    url: URL;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const impl: IndexerFetchLike = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const { status = 200, payload } = route(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  return { impl, calls };
}

/** One-page listings responder. */
function listingsPageRoute(items: unknown[]): FakeRoute {
  return (url) => {
    expect(url.pathname).toBe("/api/explorer/listings");
    return {
      payload: {
        success: true,
        page: Number(url.searchParams.get("page") ?? 1),
        pageSize: items.length,
        total: items.length,
        items: Number(url.searchParams.get("page") ?? 1) === 1 ? items : [],
      },
    };
  };
}

const BASE_URL = "https://indexer.test";

// ---------------------------------------------------------------------------
// Decode parity with the queries module (THE load-bearing contract)
// ---------------------------------------------------------------------------

describe("createIndexerClient().listActiveListings — decode parity", () => {
  it("deep-equals the queries module decode of the same account bytes", async () => {
    const pda = addrFromByte(0x77);
    const { item, bytes } = asIndexerItem(pda, listingFixtureArgs());

    const { impl } = createFakeFetch(listingsPageRoute([item]));
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });
    const viaIndexer = await indexer.listActiveListings();

    // The gPA path over the IDENTICAL raw bytes, through the transport seam.
    const fakeTransport: ProgramAccountsTransport = {
      getProgramAccounts: async () => [{ address: pda, data: bytes }],
    };
    const viaQueries = await listActiveListings(fakeTransport);

    expect(viaQueries).toHaveLength(1);
    expect(viaIndexer).toStrictEqual(viaQueries);
    // Spot-check decoded substance so an empty-vs-empty pass is impossible:
    expect(viaIndexer[0]!.address).toBe(pda);
    expect(viaIndexer[0]!.account.price).toBe(1_000_000n);
    expect(viaIndexer[0]!.account.state).toBe(ListingState.Active);
    expect(viaIndexer[0]!.account.specUri).toBe("agenc://job-spec/sha256/abc");
  });

  it("filters non-Active states client-side by default, like the queries module", async () => {
    const activePda = addrFromByte(0x01);
    const pausedPda = addrFromByte(0x02);
    const active = asIndexerItem(activePda, listingFixtureArgs());
    const paused = asIndexerItem(
      pausedPda,
      listingFixtureArgs({ state: ListingState.Paused }),
    );
    const { impl } = createFakeFetch(
      listingsPageRoute([active.item, paused.item]),
    );
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });

    const fakeTransport: ProgramAccountsTransport = {
      getProgramAccounts: async () => [
        { address: activePda, data: active.bytes },
        { address: pausedPda, data: paused.bytes },
      ],
    };

    // Default: Active only — both paths agree.
    const defaultIndexer = await indexer.listActiveListings();
    const defaultQueries = await listActiveListings(fakeTransport);
    expect(defaultIndexer).toStrictEqual(defaultQueries);
    expect(defaultIndexer.map(({ address }) => address)).toEqual([activePda]);

    // Explicit state: Paused — both paths agree.
    const pausedIndexer = await indexer.listActiveListings({
      state: ListingState.Paused,
    });
    const pausedQueries = await listActiveListings(fakeTransport, {
      state: ListingState.Paused,
    });
    expect(pausedIndexer).toStrictEqual(pausedQueries);
    expect(pausedIndexer.map(({ address }) => address)).toEqual([pausedPda]);
  });

  it("collects every page before filtering", async () => {
    const fixtures = [0x21, 0x22, 0x23].map((b) =>
      asIndexerItem(addrFromByte(b), listingFixtureArgs()),
    );
    const pages = [
      [fixtures[0]!.item, fixtures[1]!.item],
      [fixtures[2]!.item],
    ];
    const { impl, calls } = createFakeFetch((url) => {
      const page = Number(url.searchParams.get("page"));
      return {
        payload: {
          success: true,
          page,
          pageSize: 2, // the server clamped the requested pageSize
          total: 3,
          items: pages[page - 1] ?? [],
        },
      };
    });
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });
    const result = await indexer.listActiveListings();
    expect(result.map(({ address }) => address)).toEqual(
      fixtures.map((f) => f.item.pda),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get("page")).toBe("1");
    expect(calls[1]!.url.searchParams.get("page")).toBe("2");
  });

  it("maps provider and category (string AND raw 32-byte) to query params", async () => {
    const provider = addrFromByte(0xa1);
    const { impl, calls } = createFakeFetch(listingsPageRoute([]));
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await indexer.listActiveListings({ provider, category: "code-generation" });
    expect(calls[0]!.url.searchParams.get("provider")).toBe(provider);
    expect(calls[0]!.url.searchParams.get("category")).toBe("code-generation");

    // The queries module's raw 32-byte category form is converted for the wire.
    await indexer.listActiveListings({
      category: paddedBytes("code-generation", 32),
    });
    expect(calls[1]!.url.searchParams.get("category")).toBe("code-generation");
  });

  it("rejects a raw category that cannot round-trip to a wire string", async () => {
    const { impl } = createFakeFetch(listingsPageRoute([]));
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });
    const interiorNul = paddedBytes("code", 32);
    interiorNul[6] = 0x78; // "code\0\0x..." — interior NUL before content
    await expect(
      indexer.listActiveListings({ category: interiorNul }),
    ).rejects.toThrow(/interior NUL|gPA queries/);
  });

  it("rejects a non-kebab STRING category (drop-in parity with the queries module's TypeError)", async () => {
    // Guards finding #11: a non-kebab string could only ever match nothing, so
    // the indexer client must THROW like queries.listActiveListings rather than
    // silently sending the bad string and returning [].
    const { impl, calls } = createFakeFetch(listingsPageRoute([]));
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await expect(
      indexer.listActiveListings({ category: "Code Generation" }),
    ).rejects.toThrow(TypeError);
    await expect(
      indexer.listActiveListings({ category: "Code Generation" }),
    ).rejects.toThrow(/lowercase-kebab/);
    // It must reject BEFORE dialing the wire (no silent empty-set query).
    expect(calls).toHaveLength(0);

    // The gPA queries path throws on the identical input — parity confirmed.
    const fakeTransport: ProgramAccountsTransport = {
      getProgramAccounts: async () => [],
    };
    await expect(
      listActiveListings(fakeTransport, { category: "Code Generation" }),
    ).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------------

describe("createIndexerClient reads", () => {
  it("listings() passes filters + paging through and returns the page", async () => {
    const { item } = asIndexerItem(addrFromByte(0x31), listingFixtureArgs());
    const { impl, calls } = createFakeFetch((url) => ({
      payload: { success: true, page: 2, pageSize: 10, total: 21, items: [item] },
    }));
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });
    const page = await indexer.listings({
      category: "code-generation",
      tags: ["rust", "solana"],
      provider: "prov",
      state: "Active",
      metadataValid: false,
      page: 2,
      pageSize: 10,
    });
    expect(page).toEqual({ page: 2, pageSize: 10, total: 21, items: [item] });
    const params = calls[0]!.url.searchParams;
    expect(params.get("category")).toBe("code-generation");
    expect(params.get("tags")).toBe("rust,solana");
    expect(params.get("provider")).toBe("prov");
    expect(params.get("state")).toBe("Active");
    expect(params.get("metadataValid")).toBe("false");
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("10");
  });

  it("getListing() unwraps { listing } and hits the pda path", async () => {
    const pda = addrFromByte(0x41);
    const { item } = asIndexerItem(pda, listingFixtureArgs());
    const { impl, calls } = createFakeFetch((url) => {
      expect(url.pathname).toBe(`/api/explorer/listings/${pda}`);
      return { payload: { success: true, listing: item } };
    });
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });
    await expect(indexer.getListing(pda)).resolves.toEqual(item);
    expect(calls[0]!.method).toBe("GET");
  });

  it("listingHires() unwraps { items }", async () => {
    const pda = addrFromByte(0x42);
    const hire = {
      taskPda: "task",
      hireRecordPda: "hire",
      accountData: "AAEC",
      buyer: "buyer",
      listing: pda,
      price: "1000000",
      slot: 9,
      signature: "sig",
    };
    const { impl, calls } = createFakeFetch(() => ({
      payload: { success: true, items: [hire] },
    }));
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });
    await expect(indexer.listingHires(pda)).resolves.toEqual([hire]);
    expect(calls[0]!.url.pathname).toBe(`/api/explorer/listings/${pda}/hires`);
  });

  it("agentTrackRecord() returns the pinned fields", async () => {
    const agent = addrFromByte(0x43);
    const { impl, calls } = createFakeFetch(() => ({
      payload: {
        success: true,
        agent,
        completions: 5,
        disputesInitiated: 1,
        disputesLost: 0,
        slashHistory: [{ slot: 7, signature: "slashsig", amount: "100" }],
        source: "events",
      },
    }));
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });
    await expect(indexer.agentTrackRecord(agent)).resolves.toEqual({
      agent,
      completions: 5,
      disputesInitiated: 1,
      disputesLost: 0,
      slashHistory: [{ slot: 7, signature: "slashsig", amount: "100" }],
      source: "events",
    });
    expect(calls[0]!.url.pathname).toBe(
      `/api/explorer/agents/${agent}/track-record`,
    );
  });
});

// ---------------------------------------------------------------------------
// Transaction builder + webhooks + events
// ---------------------------------------------------------------------------

describe("createIndexerClient writes", () => {
  it("buildHireTransaction() POSTs stringified params and returns the build", async () => {
    const build = {
      transaction: "dHg=",
      blockhash: "BLOCKHASH",
      lastValidBlockHeight: 123_456,
      taskPda: "task",
      escrowPda: "escrow",
      hireRecordPda: "hire",
      taskId: "ab".repeat(32),
    };
    const { impl, calls } = createFakeFetch((url) => {
      expect(url.pathname).toBe("/v1/hires");
      return { payload: { success: true, ...build } };
    });
    const indexer = createIndexerClient({
      baseUrl: BASE_URL,
      apiKey: "ak_test",
      fetchImpl: impl,
    });
    await expect(
      indexer.buildHireTransaction({
        buyer: addrFromByte(0x51),
        listing: addrFromByte(0x52),
        expectedPrice: 1_000_000n,
        expectedVersion: 2n,
        listingSpecHash: "13".repeat(32),
        creatorAgent: addrFromByte(0x53),
      }),
    ).resolves.toEqual(build);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.headers["X-Agenc-Api-Key"]).toBe("ak_test");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      buyer: addrFromByte(0x51),
      listing: addrFromByte(0x52),
      expectedPrice: "1000000",
      expectedVersion: "2",
      listingSpecHash: "13".repeat(32),
      creatorAgent: addrFromByte(0x53),
    });
  });

  it("webhook management hits the pinned routes", async () => {
    const { impl, calls } = createFakeFetch((url, init) => {
      if (init.method === "POST") {
        return { payload: { success: true, id: "wh_1", secret: "whsec_x" } };
      }
      if (init.method === "DELETE") {
        return { payload: { success: true } };
      }
      if (url.pathname === "/v1/webhooks") {
        return {
          payload: {
            success: true,
            items: [{ id: "wh_1", url: "https://h.example", events: ["listing.hired"] }],
          },
        };
      }
      return {
        payload: {
          success: true,
          items: [
            {
              id: "evt_1",
              type: "listing.hired",
              createdAt: "2026-06-10T12:00:00.000Z",
              data: {},
            },
          ],
        },
      };
    });
    const indexer = createIndexerClient({
      baseUrl: BASE_URL,
      apiKey: "ak_test",
      fetchImpl: impl,
    });

    const registered = await indexer.registerWebhook({
      url: "https://h.example",
      events: ["listing.hired"],
    });
    expect(registered).toEqual({ id: "wh_1", secret: "whsec_x" });
    expect(calls[0]!.url.pathname).toBe("/v1/webhooks");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      url: "https://h.example",
      events: ["listing.hired"],
    });

    const hooks = await indexer.listWebhooks();
    expect(hooks).toHaveLength(1);

    await indexer.deleteWebhook("wh_1");
    expect(calls[2]!.method).toBe("DELETE");
    expect(calls[2]!.url.pathname).toBe("/v1/webhooks/wh_1");

    const events = await indexer.listEvents({ after: "evt_0", limit: 50 });
    expect(events[0]!.id).toBe("evt_1");
    expect(calls[3]!.url.pathname).toBe("/v1/events");
    expect(calls[3]!.url.searchParams.get("after")).toBe("evt_0");
    expect(calls[3]!.url.searchParams.get("limit")).toBe("50");
  });
});

// ---------------------------------------------------------------------------
// Error mapping (the house envelope -> IndexerError)
// ---------------------------------------------------------------------------

describe("IndexerError mapping", () => {
  it("maps the house error envelope to { status, code, message }", async () => {
    const { impl } = createFakeFetch(() => ({
      status: 404,
      payload: {
        error: { code: "LISTING_NOT_FOUND", message: "No such listing." },
      },
    }));
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });
    const failure = await indexer
      .getListing("missing")
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(IndexerError);
    expect(failure).toMatchObject({
      status: 404,
      code: "LISTING_NOT_FOUND",
      message: "No such listing.",
    });
  });

  it("synthesizes HTTP_<status> when a non-2xx body has no envelope", async () => {
    const { impl } = createFakeFetch(() => ({
      status: 503,
      payload: "down",
    }));
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });
    const failure = await indexer.listings().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(IndexerError);
    expect((failure as IndexerError).status).toBe(503);
    expect((failure as IndexerError).code).toBe("HTTP_503");
  });

  it("reports status 0 / NETWORK_ERROR when the fetch itself rejects", async () => {
    const indexer = createIndexerClient({
      baseUrl: BASE_URL,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const failure = await indexer.listings().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(IndexerError);
    expect((failure as IndexerError).status).toBe(0);
    expect((failure as IndexerError).code).toBe("NETWORK_ERROR");
  });

  it("rejects a 2xx body without the { success: true } envelope", async () => {
    const { impl } = createFakeFetch(() => ({
      payload: { items: [] },
    }));
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });
    const failure = await indexer.listings().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(IndexerError);
    expect((failure as IndexerError).code).toBe("INVALID_RESPONSE");
  });

  it("normalizes a trailing-slash baseUrl", async () => {
    const { impl, calls } = createFakeFetch(listingsPageRoute([]));
    const indexer = createIndexerClient({
      baseUrl: `${BASE_URL}/`,
      fetchImpl: impl,
    });
    await indexer.listings();
    expect(calls[0]!.url.href.startsWith(`${BASE_URL}/api/`)).toBe(true);
  });

  it("sends no X-Agenc-Api-Key header anonymously", async () => {
    const { impl, calls } = createFakeFetch(listingsPageRoute([]));
    const indexer = createIndexerClient({ baseUrl: BASE_URL, fetchImpl: impl });
    await indexer.listings();
    expect(
      Object.keys(calls[0]!.headers).some(
        (h) => h.toLowerCase() === "x-agenc-api-key",
      ),
    ).toBe(false);
  });
});
