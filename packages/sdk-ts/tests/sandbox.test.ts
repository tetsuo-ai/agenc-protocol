// Tests for the ./sandbox subpath (P2.4): fixture shape + not-seeded guards,
// requestSandboxAttestation against a fake fetch, createSandboxClient wiring
// against a FAKE rpc (no network anywhere), and the pure parts of the
// seed-devnet-sandbox script. Fakes follow the established client.test.ts
// pattern (structural objects cast at the seam).
import { describe, it, expect, vi } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  address,
  createSolanaRpcSubscriptions,
  getBase58Decoder,
  type Blockhash,
  type Instruction,
} from "@solana/kit";

// Spy seam for the ws-derivation tests: wrap createSolanaRpcSubscriptions in
// a pass-through vi.fn so tests can assert WHICH URL createSandboxClient
// dials (constructing kit subscriptions is lazy — no socket is opened until
// the first subscribe — so real URLs are safe here). Everything else in
// @solana/kit stays the real implementation.
vi.mock("@solana/kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/kit")>();
  return {
    ...actual,
    createSolanaRpcSubscriptions: vi.fn(actual.createSolanaRpcSubscriptions),
  };
});
import { AGENC_COORDINATION_PROGRAM_ADDRESS } from "../src/index.js";
import {
  assertSandboxSeeded,
  createSandboxClient,
  DEFAULT_SANDBOX_AIRDROP_LAMPORTS,
  DEFAULT_SANDBOX_ATTESTOR_URL,
  requestSandboxAttestation,
  SANDBOX_DEVNET_RPC_SUBSCRIPTIONS_URL,
  SANDBOX_FIXTURES,
  SandboxAirdropError,
  SandboxAttestationError,
  SandboxClusterError,
  SandboxNotSeededError,
  sandboxListings,
  sandboxProviders,
  type SandboxFetchLike,
  type SandboxFixtures,
  type SandboxRpc,
} from "../src/sandbox/index.js";
import {
  buildFixturesFile,
  parseSeedArgs,
  SANDBOX_PROVIDER_BLUEPRINTS,
  usage,
} from "../scripts/seed-devnet-sandbox.mjs";
import { LISTING_CATEGORIES } from "../src/values/index.js";

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts",
);

const LISTING_PDA = address("So11111111111111111111111111111111111111112");

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

describe("SANDBOX_FIXTURES", () => {
  it("ships the unseeded devnet shape today", () => {
    expect(SANDBOX_FIXTURES.seeded).toBe(false);
    expect(SANDBOX_FIXTURES.cluster).toBe("devnet");
    expect(SANDBOX_FIXTURES.programId).toBe(
      AGENC_COORDINATION_PROGRAM_ADDRESS,
    );
    expect(SANDBOX_FIXTURES.seededAtSlot).toBeNull();
    expect(SANDBOX_FIXTURES.providers).toEqual([]);
    expect(SANDBOX_FIXTURES.listings).toEqual([]);
  });

  it("guarded helpers throw a descriptive SandboxNotSeededError while unseeded", () => {
    for (const helper of [sandboxListings, sandboxProviders]) {
      const failure = (() => {
        try {
          helper();
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(failure).toBeInstanceOf(SandboxNotSeededError);
      expect((failure as Error).message).toContain("seed-devnet-sandbox");
      expect((failure as Error).message).toContain("SANDBOX_FIXTURES.seeded");
    }
    expect(() => assertSandboxSeeded()).toThrow(SandboxNotSeededError);
  });

  it("returns the arrays once a fixtures object is seeded", () => {
    const seeded = {
      ...SANDBOX_FIXTURES,
      seeded: true,
      seededAtSlot: 123,
      providers: [
        { authority: LISTING_PDA, agent: LISTING_PDA, name: "P" },
      ],
      listings: [
        {
          address: LISTING_PDA,
          provider: LISTING_PDA,
          name: "P",
          category: "other",
          priceLamports: 1,
        },
      ],
    } as SandboxFixtures;
    expect(sandboxListings(seeded)).toHaveLength(1);
    expect(sandboxProviders(seeded)).toHaveLength(1);
    expect(() => assertSandboxSeeded(seeded)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// requestSandboxAttestation (fake fetch — no network)
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function fakeFetch(
  response: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): { fetch: SandboxFetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const status = response.status ?? 200;
  const headers = new Map(
    Object.entries(response.headers ?? {}).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
  const body = response.body ?? JSON.stringify({ signature: "sig" });
  const fetch: SandboxFetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      json: async () => JSON.parse(body) as unknown,
      text: async () => body,
    };
  };
  return { fetch, calls };
}

const SPEC_HASH_BYTES = new Uint8Array(32).fill(0xab);
const SPEC_HASH_HEX = "ab".repeat(32);

describe("requestSandboxAttestation", () => {
  it("POSTs {kind, address, specHash-hex} to the default endpoint and returns the signature", async () => {
    const { fetch, calls } = fakeFetch({
      body: JSON.stringify({ signature: "devnet-sig" }),
    });
    const result = await requestSandboxAttestation({
      kind: "listing",
      address: LISTING_PDA,
      specHash: SPEC_HASH_BYTES,
      fetch,
    });
    expect(result).toEqual({ signature: "devnet-sig" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(DEFAULT_SANDBOX_ATTESTOR_URL);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({
      kind: "listing",
      address: LISTING_PDA,
      specHash: SPEC_HASH_HEX,
    });
  });

  it("honors an explicit endpoint and accepts hex-string specHash (0x + mixed case)", async () => {
    const { fetch, calls } = fakeFetch();
    await requestSandboxAttestation({
      kind: "task",
      address: LISTING_PDA,
      specHash: `0x${SPEC_HASH_HEX.toUpperCase()}`,
      endpoint: "https://attestor.example/attest",
      fetch,
    });
    expect(calls[0]!.url).toBe("https://attestor.example/attest");
    const body = JSON.parse(calls[0]!.init.body) as { specHash: string };
    expect(body.specHash).toBe(SPEC_HASH_HEX); // normalized lowercase, no 0x
  });

  it("rejects malformed spec hashes with a TypeError before any fetch", async () => {
    const { fetch, calls } = fakeFetch();
    await expect(
      requestSandboxAttestation({
        kind: "task",
        address: LISTING_PDA,
        specHash: new Uint8Array(31),
        fetch,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      requestSandboxAttestation({
        kind: "task",
        address: LISTING_PDA,
        specHash: "not-hex",
        fetch,
      }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("throws a typed SandboxAttestationError on non-2xx", async () => {
    const { fetch } = fakeFetch({ status: 500, body: "boom" });
    const failure = await requestSandboxAttestation({
      kind: "listing",
      address: LISTING_PDA,
      specHash: SPEC_HASH_BYTES,
      fetch,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SandboxAttestationError);
    const error = failure as SandboxAttestationError;
    expect(error.status).toBe(500);
    expect(error.retryAfterSeconds).toBeNull();
    expect(error.body).toBe("boom");
    expect(error.message).toContain("500");
    expect(error.message).toContain(LISTING_PDA);
  });

  it("surfaces retryAfterSeconds from the Retry-After header on 429", async () => {
    const { fetch } = fakeFetch({
      status: 429,
      headers: { "Retry-After": "42" },
      body: JSON.stringify({ error: "rate limited" }),
    });
    const failure = (await requestSandboxAttestation({
      kind: "listing",
      address: LISTING_PDA,
      specHash: SPEC_HASH_BYTES,
      fetch,
    }).catch((e: unknown) => e)) as SandboxAttestationError;
    expect(failure).toBeInstanceOf(SandboxAttestationError);
    expect(failure.status).toBe(429);
    expect(failure.retryAfterSeconds).toBe(42);
    expect(failure.message).toContain("rate-limited");
    expect(failure.message).toContain("retry after 42s");
  });

  it("falls back to a retryAfter body field when the header is absent", async () => {
    const { fetch } = fakeFetch({
      status: 429,
      body: JSON.stringify({ retryAfter: 7 }),
    });
    const failure = (await requestSandboxAttestation({
      kind: "task",
      address: LISTING_PDA,
      specHash: SPEC_HASH_BYTES,
      fetch,
    }).catch((e: unknown) => e)) as SandboxAttestationError;
    expect(failure.retryAfterSeconds).toBe(7);
  });

  it("wraps a network-layer fetch rejection in SandboxAttestationError (status 0)", async () => {
    // The exact failure every default-endpoint caller hits while the hosted
    // P2.3 attestor is not deployed: fetch rejects (NXDOMAIN/refused) before
    // any HTTP response exists.
    const networkFailure = new TypeError("fetch failed");
    const rejectingFetch: SandboxFetchLike = async () => {
      throw networkFailure;
    };
    const failure = await requestSandboxAttestation({
      kind: "listing",
      address: LISTING_PDA,
      specHash: SPEC_HASH_BYTES,
      fetch: rejectingFetch,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SandboxAttestationError);
    const error = failure as SandboxAttestationError;
    expect(error.status).toBe(0);
    expect(error.retryAfterSeconds).toBeNull();
    expect(error.body).toBeNull();
    expect(error.cause).toBe(networkFailure);
    // The message must name the endpoint and point at the not-yet-deployed
    // caveat + the `endpoint` override.
    expect(error.message).toContain(DEFAULT_SANDBOX_ATTESTOR_URL);
    expect(error.message).toContain("may not be deployed yet");
    expect(error.message).toContain("endpoint");
  });

  it("names a custom endpoint in the network-rejection error", async () => {
    const rejectingFetch: SandboxFetchLike = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
    };
    const failure = (await requestSandboxAttestation({
      kind: "task",
      address: LISTING_PDA,
      specHash: SPEC_HASH_BYTES,
      endpoint: "http://127.0.0.1:9999/attest",
      fetch: rejectingFetch,
    }).catch((e: unknown) => e)) as SandboxAttestationError;
    expect(failure).toBeInstanceOf(SandboxAttestationError);
    expect(failure.status).toBe(0);
    expect(failure.message).toContain("http://127.0.0.1:9999/attest");
  });

  it("throws SandboxAttestationError when a 2xx body has no signature", async () => {
    const { fetch } = fakeFetch({ body: JSON.stringify({ ok: true }) });
    const failure = (await requestSandboxAttestation({
      kind: "listing",
      address: LISTING_PDA,
      specHash: SPEC_HASH_BYTES,
      fetch,
    }).catch((e: unknown) => e)) as SandboxAttestationError;
    expect(failure).toBeInstanceOf(SandboxAttestationError);
    expect(failure.status).toBe(200);
    expect(failure.message).toContain('"signature"');
  });
});

// ---------------------------------------------------------------------------
// createSandboxClient (fake rpc — no network)
// ---------------------------------------------------------------------------

/** Valid base58 blockhash (32 zero bytes). */
const FAKE_BLOCKHASH = getBase58Decoder().decode(
  new Uint8Array(32),
) as Blockhash;

const DUMMY_IX: Instruction = {
  programAddress: address("11111111111111111111111111111111"),
  data: new Uint8Array([1, 2, 3]),
};

interface FakeSandboxRpc {
  rpc: SandboxRpc;
  airdrops: { recipient: string; lamports: bigint }[];
  balanceReads: () => number;
  sentTransactions: () => number;
}

/**
 * Structural fake of the devnet RPC at the exact seam SandboxRpc declares:
 * airdrop + balance (sandbox funding), blockhash + send + statuses (the
 * client transport pipeline). Balance becomes the airdropped amount only
 * after requestAirdrop is called, so the bounded confirm-wait is exercised.
 */
function fakeSandboxRpc(options: { neverFund?: boolean; failAirdrop?: boolean } = {}): FakeSandboxRpc {
  const airdrops: { recipient: string; lamports: bigint }[] = [];
  let balance = 0n;
  let balanceReads = 0;
  let sent = 0;
  const thunk = <T>(value: () => T) => ({ send: async () => value() });
  const rpc = {
    requestAirdrop: (recipient: string, amount: bigint) =>
      thunk(() => {
        if (options.failAirdrop) {
          throw new Error("429 Too Many Requests");
        }
        airdrops.push({ recipient, lamports: amount });
        if (!options.neverFund) balance = amount;
        return "airdrop-signature";
      }),
    getBalance: () =>
      thunk(() => {
        balanceReads += 1;
        return { value: balance };
      }),
    getLatestBlockhash: () =>
      thunk(() => ({
        value: { blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 100n },
      })),
    sendTransaction: () =>
      thunk(() => {
        sent += 1;
        return "tx-signature";
      }),
    getSignatureStatuses: () =>
      thunk(() => ({
        value: [{ confirmationStatus: "confirmed", err: null }],
      })),
    getEpochInfo: () => thunk(() => ({ blockHeight: 50n })),
    getAccountInfo: () => thunk(() => ({ value: null })),
  } as unknown as SandboxRpc;
  return {
    rpc,
    airdrops,
    balanceReads: () => balanceReads,
    sentTransactions: () => sent,
  };
}

describe("createSandboxClient", () => {
  it("generates a throwaway signer, airdrops 2 SOL by default, and waits for the balance", async () => {
    const fake = fakeSandboxRpc();
    const sandbox = await createSandboxClient({
      rpc: fake.rpc,
      airdropPollIntervalMs: 1,
    });
    expect(fake.airdrops).toHaveLength(1);
    expect(fake.airdrops[0]!.recipient).toBe(sandbox.signer.address);
    expect(fake.airdrops[0]!.lamports).toBe(DEFAULT_SANDBOX_AIRDROP_LAMPORTS);
    expect(fake.balanceReads()).toBeGreaterThan(0);
    expect(sandbox.rpc).toBe(fake.rpc);
    expect(sandbox.client.signer).toBe(sandbox.signer);
  });

  it("sends through the same pipeline to the fake rpc (client send path reaches the fake)", async () => {
    const fake = fakeSandboxRpc();
    const sandbox = await createSandboxClient({
      rpc: fake.rpc,
      airdropPollIntervalMs: 1,
    });
    const result = await sandbox.client.send([DUMMY_IX]);
    expect(fake.sentTransactions()).toBe(1);
    expect(typeof result.signature).toBe("string");
    expect(result.signature.length).toBeGreaterThan(0);
  });

  it("respects signer + airdropLamports overrides and skipAirdrop", async () => {
    const fake = fakeSandboxRpc();
    const first = await createSandboxClient({
      rpc: fake.rpc,
      airdropLamports: 5n,
      airdropPollIntervalMs: 1,
    });
    expect(fake.airdrops[0]!.lamports).toBe(5n);

    const again = await createSandboxClient({
      rpc: fake.rpc,
      signer: first.signer,
      skipAirdrop: true,
    });
    expect(again.signer).toBe(first.signer);
    expect(fake.airdrops).toHaveLength(1); // no second airdrop
  });

  it("points at https://faucet.solana.com when the airdrop request is rejected", async () => {
    const fake = fakeSandboxRpc({ failAirdrop: true });
    const failure = await createSandboxClient({ rpc: fake.rpc }).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(SandboxAirdropError);
    expect((failure as Error).message).toContain("https://faucet.solana.com");
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });

  it("points at https://faucet.solana.com when the airdrop never lands in time", async () => {
    const fake = fakeSandboxRpc({ neverFund: true });
    const failure = await createSandboxClient({
      rpc: fake.rpc,
      airdropTimeoutMs: 20,
      airdropPollIntervalMs: 1,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SandboxAirdropError);
    expect((failure as Error).message).toContain("https://faucet.solana.com");
    expect((failure as SandboxAirdropError).address).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createSandboxClient — subscriptions URL derivation (spy on the kit seam)
// ---------------------------------------------------------------------------

describe("createSandboxClient subscriptions URL", () => {
  const subscriptionsSpy = vi.mocked(createSolanaRpcSubscriptions);

  it("derives ws:// from a custom http rpcUrl (local validator)", async () => {
    subscriptionsSpy.mockClear();
    await createSandboxClient({
      rpcUrl: "http://127.0.0.1:8899",
      skipAirdrop: true,
    });
    expect(subscriptionsSpy).toHaveBeenCalledTimes(1);
    expect(subscriptionsSpy).toHaveBeenCalledWith("ws://127.0.0.1:8899");
  });

  it("derives wss:// from a custom https rpcUrl, preserving host/port/path", async () => {
    subscriptionsSpy.mockClear();
    await createSandboxClient({
      rpcUrl: "https://my-devnet.example.com:8443/rpc/v1",
      skipAirdrop: true,
    });
    expect(subscriptionsSpy).toHaveBeenCalledWith(
      "wss://my-devnet.example.com:8443/rpc/v1",
    );
  });

  it("an explicit rpcSubscriptionsUrl always wins over derivation", async () => {
    subscriptionsSpy.mockClear();
    await createSandboxClient({
      rpcUrl: "http://127.0.0.1:8899",
      rpcSubscriptionsUrl: "ws://127.0.0.1:9001",
      skipAirdrop: true,
    });
    expect(subscriptionsSpy).toHaveBeenCalledWith("ws://127.0.0.1:9001");
  });

  it("uses the public devnet WebSocket only when rpcUrl is also defaulted", async () => {
    subscriptionsSpy.mockClear();
    await createSandboxClient({ skipAirdrop: true });
    expect(subscriptionsSpy).toHaveBeenCalledWith(
      SANDBOX_DEVNET_RPC_SUBSCRIPTIONS_URL,
    );
  });

  it("dials no WebSocket at all for an injected rpc", async () => {
    subscriptionsSpy.mockClear();
    const fake = fakeSandboxRpc();
    await createSandboxClient({ rpc: fake.rpc, airdropPollIntervalMs: 1 });
    expect(subscriptionsSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createSandboxClient — devnet guard (fail closed before any signing/airdrop)
// ---------------------------------------------------------------------------

describe("createSandboxClient devnet guard", () => {
  it("refuses a mainnet-looking rpcUrl before any key generation or airdrop", async () => {
    const fake = fakeSandboxRpc();
    const failure = await createSandboxClient({
      rpc: fake.rpc,
      rpcUrl: "https://api.mainnet-beta.solana.com",
      airdropPollIntervalMs: 1,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SandboxClusterError);
    const error = failure as SandboxClusterError;
    expect(error.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
    expect(error.message).toContain("DEVNET ONLY");
    expect(error.message).toContain("allowCustomRpc");
    // Refused BEFORE funding: the fake rpc never saw an airdrop request.
    expect(fake.airdrops).toHaveLength(0);
  });

  it("refuses an unparseable rpcUrl (fail closed)", async () => {
    const fake = fakeSandboxRpc();
    const failure = await createSandboxClient({
      rpc: fake.rpc,
      rpcUrl: "not a url at all",
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SandboxClusterError);
    expect(fake.airdrops).toHaveLength(0);
  });

  it("allowCustomRpc: true bypasses the guard explicitly", async () => {
    const fake = fakeSandboxRpc();
    const sandbox = await createSandboxClient({
      rpc: fake.rpc,
      rpcUrl: "https://private-validator.example.com",
      allowCustomRpc: true,
      airdropPollIntervalMs: 1,
    });
    expect(sandbox.signer.address).toBeDefined();
    expect(fake.airdrops).toHaveLength(1);
  });

  it("accepts devnet-ish and local hostnames without any opt-in", async () => {
    for (const rpcUrl of [
      "https://api.devnet.solana.com",
      "https://my-devnet.rpcpool.example.com/abc",
      "http://localhost:8899",
      "http://127.0.0.1:8899",
      "http://[::1]:8899",
    ]) {
      const fake = fakeSandboxRpc();
      await expect(
        createSandboxClient({ rpc: fake.rpc, rpcUrl, airdropPollIntervalMs: 1 }),
      ).resolves.toBeDefined();
      expect(fake.airdrops).toHaveLength(1);
    }
  });

  it("the faucet hint says to confirm rpcUrl points at devnet first", async () => {
    const fake = fakeSandboxRpc({ failAirdrop: true });
    const failure = await createSandboxClient({ rpc: fake.rpc }).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(SandboxAirdropError);
    expect((failure as Error).message).toContain(
      "First confirm rpcUrl points at devnet",
    );
  });
});

// ---------------------------------------------------------------------------
// seed-devnet-sandbox.mjs — pure parts + --help smoke
// ---------------------------------------------------------------------------

describe("seed-devnet-sandbox script", () => {
  it("parseSeedArgs parses a full invocation", () => {
    const args = parseSeedArgs([
      "--keypair",
      "/tmp/funder.json",
      "--rpc",
      "https://devnet.example",
      "--attestor-url",
      "https://attestor.example/attest",
    ]);
    expect(args).toMatchObject({
      help: false,
      keypair: "/tmp/funder.json",
      rpc: "https://devnet.example",
      attestorUrl: "https://attestor.example/attest",
      moderatorKeypair: null,
      errors: [],
    });
  });

  it("parseSeedArgs collects errors for missing requireds and unknown flags", () => {
    const args = parseSeedArgs(["--bogus"]);
    expect(args.errors).toContain("unknown argument: --bogus");
    expect(args.errors).toContain("--keypair is required");
    expect(
      args.errors.some((e) => e.includes("--attestor-url / --moderator-keypair")),
    ).toBe(true);
    // --help always wins: no errors required to print usage
    expect(parseSeedArgs(["--help"]).help).toBe(true);
    expect(parseSeedArgs(["--help"]).errors).toEqual([]);
  });

  it("blueprints: ~10 providers, unique names, canonical categories, >= 5 distinct", () => {
    expect(SANDBOX_PROVIDER_BLUEPRINTS).toHaveLength(10);
    const names = new Set(SANDBOX_PROVIDER_BLUEPRINTS.map((b) => b.name));
    expect(names.size).toBe(10);
    const categories = new Set(
      SANDBOX_PROVIDER_BLUEPRINTS.map((b) => b.category),
    );
    for (const category of categories) {
      expect(LISTING_CATEGORIES).toContain(category);
    }
    expect(categories.size).toBeGreaterThanOrEqual(5);
  });

  it("buildFixturesFile shapes the fixtures.json contract (seeded, sorted, linked)", () => {
    const entries = [
      {
        name: "Zeta",
        category: "writing",
        priceLamports: 2,
        authority: "auth1",
        agent: "agentZ",
        listing: "listZ",
      },
      {
        name: "Alpha",
        category: "research",
        priceLamports: 1,
        authority: "auth1",
        agent: "agentA",
        listing: "listA",
      },
    ];
    const file = buildFixturesFile({
      programId: AGENC_COORDINATION_PROGRAM_ADDRESS,
      seededAtSlot: 1234,
      entries,
    });
    expect(file.seeded).toBe(true);
    expect(file.cluster).toBe("devnet");
    expect(file.programId).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(file.seededAtSlot).toBe(1234);
    // sorted by name for byte-stable rewrites
    expect(file.providers.map((p) => p.name)).toEqual(["Alpha", "Zeta"]);
    expect(file.listings.map((l) => l.address)).toEqual(["listA", "listZ"]);
    // listings[].provider references providers[].agent
    expect(file.listings[0]).toEqual({
      address: "listA",
      provider: "agentA",
      name: "Alpha",
      category: "research",
      priceLamports: 1,
    });
    // the shape matches what SANDBOX_FIXTURES expects
    const keys = Object.keys(file).sort();
    expect(keys).toEqual(
      Object.keys(SANDBOX_FIXTURES).sort(),
    );
  });

  it("usage() and `node scripts/seed-devnet-sandbox.mjs --help` work without a dist build", async () => {
    expect(usage()).toContain("--keypair");
    const { stdout } = await execFileAsync("node", [
      path.join(SCRIPTS_DIR, "seed-devnet-sandbox.mjs"),
      "--help",
    ]);
    expect(stdout).toContain("seed-devnet-sandbox");
    expect(stdout).toContain("--attestor-url");
  });
});
