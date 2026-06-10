// Tests for the P3.4 moderation helper (src/sandbox/moderation.ts):
// endpoint-resolution matrix (option > AGENC_SANDBOX_MODERATION_URL > throw)
// and fake-fetch happy/error paths. No network anywhere.
import { describe, it, expect, vi, afterEach } from "vitest";
import { address } from "@solana/kit";
import {
  ListingModerationError,
  requestListingModeration,
  type SandboxFetchLike,
} from "../src/sandbox/index.js";
import * as rootBarrel from "../src/index.js";

const LISTING = address("So11111111111111111111111111111111111111112");

const CLEAN_RESPONSE = {
  success: true,
  verdict: "clean",
  riskScore: 3,
  specHash: "ab".repeat(32),
  attestation: { signature: "5sigxxxx", recordedAt: "2026-06-10T12:00:00.000Z" },
  policyHash: "cd".repeat(32),
};

type FetchCall = { url: string; init: Parameters<SandboxFetchLike>[1] };

/** Recording fake fetch returning one canned JSON response. */
function fakeFetch(status: number, payload: unknown) {
  const calls: FetchCall[] = [];
  const impl: SandboxFetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  return { impl, calls };
}

describe("requestListingModeration — public export surface (finding #12)", () => {
  it("is re-exported from the package root, not only the DEVNET-ONLY /sandbox subpath", () => {
    // The P3.4 mainnet moderation helper must be reachable from
    // `@tetsuo-ai/marketplace-sdk` (the root barrel) alongside
    // createIndexerClient / verifyAgencWebhookSignature, so integrators do not
    // import a mainnet helper through the "DEVNET ONLY" sandbox banner.
    expect(typeof rootBarrel.requestListingModeration).toBe("function");
    expect(rootBarrel.requestListingModeration).toBe(requestListingModeration);
    expect(rootBarrel.ListingModerationError).toBe(ListingModerationError);
    // Companion root exports the helper is documented next to.
    expect(typeof rootBarrel.createIndexerClient).toBe("function");
    expect(typeof rootBarrel.verifyAgencWebhookSignature).toBe("function");
  });
});

describe("requestListingModeration — endpoint resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("explicit endpoint beats AGENC_SANDBOX_MODERATION_URL", async () => {
    vi.stubEnv("AGENC_SANDBOX_MODERATION_URL", "http://env.example/mod");
    const { impl, calls } = fakeFetch(200, CLEAN_RESPONSE);
    await requestListingModeration({
      spec: { title: "x" },
      endpoint: "http://option.example/mod",
      fetch: impl,
    });
    expect(calls[0]!.url).toBe("http://option.example/mod");
  });

  it("falls back to AGENC_SANDBOX_MODERATION_URL when no option is given", async () => {
    vi.stubEnv(
      "AGENC_SANDBOX_MODERATION_URL",
      "http://127.0.0.1:4173/api/moderation/listings",
    );
    const { impl, calls } = fakeFetch(200, CLEAN_RESPONSE);
    await requestListingModeration({ spec: { title: "x" }, fetch: impl });
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:4173/api/moderation/listings",
    );
  });

  it("throws a descriptive error naming the option AND the env var when neither is set", async () => {
    const { impl, calls } = fakeFetch(200, CLEAN_RESPONSE);
    const failure = await requestListingModeration({
      spec: { title: "x" },
      fetch: impl,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ListingModerationError);
    expect((failure as Error).message).toContain("endpoint");
    expect((failure as Error).message).toContain(
      "AGENC_SANDBOX_MODERATION_URL",
    );
    expect((failure as Error).message).toContain("moderationUrl");
    expect(calls).toHaveLength(0); // never dialed anything
  });
});

describe("requestListingModeration — input validation", () => {
  it("requires one of spec / specUri", async () => {
    const { impl } = fakeFetch(200, CLEAN_RESPONSE);
    await expect(
      requestListingModeration({ endpoint: "http://x.example", fetch: impl }),
    ).rejects.toThrow(TypeError);
    await expect(
      requestListingModeration({ endpoint: "http://x.example", fetch: impl }),
    ).rejects.toThrow(/spec/);
  });

  it("rejects BOTH spec and specUri", async () => {
    const { impl } = fakeFetch(200, CLEAN_RESPONSE);
    await expect(
      requestListingModeration({
        spec: { a: 1 },
        specUri: "agenc://job-spec/sha256/ab",
        endpoint: "http://x.example",
        fetch: impl,
      }),
    ).rejects.toThrow(/not both/);
  });
});

describe("requestListingModeration — request/response", () => {
  it("POSTs { spec, listing } as JSON and parses the clean verdict", async () => {
    const { impl, calls } = fakeFetch(200, CLEAN_RESPONSE);
    const result = await requestListingModeration({
      spec: { title: "Build me a parser", price: "1000" },
      listing: LISTING,
      endpoint: "http://mod.example/api/moderation/listings",
      fetch: impl,
    });
    expect(result).toEqual({
      verdict: "clean",
      riskScore: 3,
      specHash: "ab".repeat(32),
      attestation: {
        signature: "5sigxxxx",
        recordedAt: "2026-06-10T12:00:00.000Z",
      },
      policyHash: "cd".repeat(32),
    });
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({
      spec: { title: "Build me a parser", price: "1000" },
      listing: LISTING,
    });
  });

  it("POSTs { specUri } (no listing) and accepts a null attestation", async () => {
    const { impl, calls } = fakeFetch(200, {
      success: true,
      verdict: "suspicious",
      riskScore: 61,
      specHash: "ef".repeat(32),
      attestation: null,
      policyHash: "cd".repeat(32),
    });
    const result = await requestListingModeration({
      specUri: "agenc://job-spec/sha256/" + "ef".repeat(32),
      endpoint: "http://mod.example",
      fetch: impl,
    });
    expect(result.verdict).toBe("suspicious");
    expect(result.riskScore).toBe(61);
    expect(result.attestation).toBeNull();
    expect(JSON.parse(calls[0]!.init.body)).toEqual({
      specUri: "agenc://job-spec/sha256/" + "ef".repeat(32),
    });
  });

  it("throws ListingModerationError with status + body on non-2xx", async () => {
    const { impl } = fakeFetch(429, { error: { code: "RATE_LIMITED" } });
    const failure = await requestListingModeration({
      spec: { a: 1 },
      endpoint: "http://mod.example",
      fetch: impl,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ListingModerationError);
    expect((failure as ListingModerationError).status).toBe(429);
    expect((failure as ListingModerationError).body).toContain("RATE_LIMITED");
  });

  it("throws on a 2xx body with an unknown verdict", async () => {
    const { impl } = fakeFetch(200, { ...CLEAN_RESPONSE, verdict: "fine" });
    const failure = await requestListingModeration({
      spec: { a: 1 },
      endpoint: "http://mod.example",
      fetch: impl,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ListingModerationError);
    expect((failure as Error).message).toContain("verdict");
  });

  it("throws on a 2xx body with a malformed attestation", async () => {
    const { impl } = fakeFetch(200, {
      ...CLEAN_RESPONSE,
      attestation: { signature: 5 },
    });
    await expect(
      requestListingModeration({
        spec: { a: 1 },
        endpoint: "http://mod.example",
        fetch: impl,
      }),
    ).rejects.toThrow(/attestation/);
  });

  it("reports status 0 when the fetch itself rejects (network layer)", async () => {
    const failure = await requestListingModeration({
      spec: { a: 1 },
      endpoint: "http://unreachable.example",
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ListingModerationError);
    expect((failure as ListingModerationError).status).toBe(0);
    expect((failure as Error).message).toContain("unreachable.example");
  });
});
