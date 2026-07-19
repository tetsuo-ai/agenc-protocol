// Job-spec verification FAILS CLOSED: only a valid envelope whose canonical
// payload hash matches both integrity.payloadHash and the on-chain commitment
// is ever executed. agenc:// additionally requires an injected trusted
// resolver; it is never treated as an empty-content bypass.
import { describe, expect, it } from "vitest";
import { address, type Address } from "@solana/kit";
import {
  findTaskJobSpecPda,
  getTaskJobSpecEncoder,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import {
  createPublicUriFetcher,
  fetchAndVerifyJobSpec,
  isPublicIpAddress,
  JobSpecError,
} from "../src/job-spec.js";

const TASK = address("F1qYyDAYYS1sLxq5nDprfNknnwGPo7ssyKvhScv6f8Uc");
const CREATOR = address("7Y9dRMi8ZtyDjLdSpzUCsxDgHooZTfp3RyYs2eZWmL39");

const ENCODER = new TextEncoder();
const SPEC_PAYLOAD = { title: "day job", summary: "do it" };
const NETWORK_BODY = ENCODER.encode("network response");

async function jobSpecFixture(
  payload: Record<string, unknown> = SPEC_PAYLOAD,
  integrityOverrides: Partial<{
    algorithm: string;
    canonicalization: string;
    payloadHash: string;
  }> = {},
): Promise<{
  body: Uint8Array;
  canonicalPayload: Uint8Array;
  hash: Uint8Array;
  hex: string;
}> {
  const digest = await values.canonicalJobSpecHash(payload);
  const envelope = {
    integrity: {
      algorithm: "sha256",
      canonicalization: "json-stable-v1",
      payloadHash: digest.hex,
      ...integrityOverrides,
    },
    payload,
  };
  return {
    body: ENCODER.encode(JSON.stringify(envelope)),
    canonicalPayload: ENCODER.encode(values.canonicalJobSpecJson(payload)),
    hash: digest.bytes,
    hex: digest.hex,
  };
}

async function jobSpecAccount(overrides: {
  jobSpecHash?: Uint8Array;
  jobSpecUri?: string;
}): Promise<{ pda: Address; data: Uint8Array }> {
  const defaultHash = (await values.canonicalJobSpecHash(SPEC_PAYLOAD)).bytes;
  const [pda] = await findTaskJobSpecPda({ task: TASK });
  const data = new Uint8Array(
    getTaskJobSpecEncoder().encode({
      task: TASK,
      creator: CREATOR,
      jobSpecHash: overrides.jobSpecHash ?? defaultHash,
      jobSpecUri: overrides.jobSpecUri ?? "https://specs.example/spec.json",
      createdAt: 0n,
      updatedAt: 0n,
      bump: 250,
      reserved: new Uint8Array(7),
    }),
  );
  return { pda, data };
}

function readerFor(pda: Address, data: Uint8Array | null) {
  return async (addr: Address) => (addr === pda ? data : null);
}

describe("fetchAndVerifyJobSpec", () => {
  it("accepts an envelope whose canonical payload hash matches both commitments", async () => {
    const fixture = await jobSpecFixture();
    const { pda, data } = await jobSpecAccount({ jobSpecHash: fixture.hash });
    const verified = await fetchAndVerifyJobSpec({
      task: TASK,
      readAccount: readerFor(pda, data),
      fetchUri: async () => fixture.body,
    });
    expect(verified.content).toEqual(fixture.canonicalPayload);
    expect(verified.jobSpecUri).toBe("https://specs.example/spec.json");
    expect(verified.jobSpecHash).toEqual(fixture.hash);
  });

  it("FAILS CLOSED when a different internally-valid payload is served", async () => {
    const pinned = await jobSpecFixture();
    const tampered = await jobSpecFixture({
      ...SPEC_PAYLOAD,
      extra: "malicious edit",
    });
    const { pda, data } = await jobSpecAccount({ jobSpecHash: pinned.hash });
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, data),
        fetchUri: async () => tampered.body,
      }),
    ).rejects.toThrow(/payload hash mismatch.*on-chain commitment/);
  });

  it("FAILS CLOSED when envelope.integrity.payloadHash disagrees with the payload", async () => {
    const fixture = await jobSpecFixture(SPEC_PAYLOAD, {
      payloadHash: "00".repeat(32),
    });
    const { pda, data } = await jobSpecAccount({ jobSpecHash: fixture.hash });
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, data),
        fetchUri: async () => fixture.body,
      }),
    ).rejects.toThrow(/integrity\.payloadHash mismatch/);
  });

  it.each([
    [{ algorithm: "sha512" }, /integrity\.algorithm/],
    [{ canonicalization: "json-c14n" }, /integrity\.canonicalization/],
    [{ payloadHash: "ABC" }, /integrity\.payloadHash/],
  ] as const)(
    "rejects unsupported or malformed envelope integrity %#",
    async (overrides, error) => {
      const fixture = await jobSpecFixture(SPEC_PAYLOAD, overrides);
      const { pda, data } = await jobSpecAccount({ jobSpecHash: fixture.hash });
      await expect(
        fetchAndVerifyJobSpec({
          task: TASK,
          readAccount: readerFor(pda, data),
          fetchUri: async () => fixture.body,
        }),
      ).rejects.toThrow(error);
    },
  );

  it.each([
    ENCODER.encode(JSON.stringify(SPEC_PAYLOAD)),
    ENCODER.encode('{"integrity":{},"payload":[]}'),
    ENCODER.encode("not json"),
    new Uint8Array([0xff, 0xfe]),
  ])("rejects malformed envelope bytes %#", async (body) => {
    const fixture = await jobSpecFixture();
    const { pda, data } = await jobSpecAccount({ jobSpecHash: fixture.hash });
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, data),
        fetchUri: async () => body,
      }),
    ).rejects.toBeInstanceOf(JobSpecError);
  });

  it("fails when the TaskJobSpec pointer account does not exist", async () => {
    const [pda] = await findTaskJobSpecPda({ task: TASK });
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, null),
        fetchUri: async () => new Uint8Array(),
      }),
    ).rejects.toThrow(/no TaskJobSpec pinned/);
  });

  it("fails on an all-zero (unpinned) hash", async () => {
    const fixture = await jobSpecFixture();
    const { pda, data } = await jobSpecAccount({ jobSpecHash: new Uint8Array(32) });
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, data),
        fetchUri: async () => fixture.body,
      }),
    ).rejects.toThrow(/all zeros/);
  });

  it("fails closed for agenc:// when no trusted resolver is configured", async () => {
    const fixture = await jobSpecFixture();
    const { pda, data } = await jobSpecAccount({
      jobSpecHash: fixture.hash,
      jobSpecUri: `agenc://job-spec/sha256/${fixture.hex}`,
    });
    let fetched = false;
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, data),
        fetchUri: async () => {
          fetched = true;
          return fixture.body;
        },
      }),
    ).rejects.toThrow(/no trusted agenc:\/\/ resolver/);
    expect(fetched).toBe(false);
  });

  it("resolves agenc:// only through the explicit resolver and verifies its envelope", async () => {
    const fixture = await jobSpecFixture();
    const uri = `agenc://job-spec/sha256/${fixture.hex}`;
    const { pda, data } = await jobSpecAccount({
      jobSpecHash: fixture.hash,
      jobSpecUri: uri,
    });
    const resolved: string[] = [];
    const verified = await fetchAndVerifyJobSpec({
      task: TASK,
      readAccount: readerFor(pda, data),
      resolveAgencUri: async (seen) => {
        resolved.push(seen);
        return fixture.body;
      },
    });
    expect(resolved).toEqual([uri]);
    expect(verified.content).toEqual(fixture.canonicalPayload);
  });

  it("rejects an agenc:// URI whose path hash differs before invoking the resolver", async () => {
    const fixture = await jobSpecFixture();
    const wrongHex = `${fixture.hex[0] === "0" ? "1" : "0"}${fixture.hex.slice(1)}`;
    const { pda, data } = await jobSpecAccount({
      jobSpecHash: fixture.hash,
      jobSpecUri: `agenc://job-spec/sha256/${wrongHex}`,
    });
    let resolved = false;
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, data),
        resolveAgencUri: async () => {
          resolved = true;
          return fixture.body;
        },
      }),
    ).rejects.toThrow(/URI hash.*on-chain commitment/);
    expect(resolved).toBe(false);
  });

  it("rejects tampered content returned by a trusted agenc:// resolver", async () => {
    const pinned = await jobSpecFixture();
    const tampered = await jobSpecFixture({ title: "swapped" });
    const { pda, data } = await jobSpecAccount({
      jobSpecHash: pinned.hash,
      jobSpecUri: `agenc://job-spec/sha256/${pinned.hex}`,
    });
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, data),
        resolveAgencUri: async () => tampered.body,
      }),
    ).rejects.toThrow(/payload hash mismatch/);
  });

  it.each(["file:///etc/passwd", "ftp://x/spec", "data:text/plain,hi", "ipfs://abc"])(
    "refuses non-http(s) scheme %s",
    async (uri) => {
      const { pda, data } = await jobSpecAccount({ jobSpecUri: uri });
      await expect(
        fetchAndVerifyJobSpec({
          task: TASK,
          readAccount: readerFor(pda, data),
          fetchUri: async () => new Uint8Array(),
        }),
      ).rejects.toBeInstanceOf(JobSpecError);
    },
  );

  it("fails closed when the download itself fails", async () => {
    const { pda, data } = await jobSpecAccount({});
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, data),
        fetchUri: async () => {
          throw new Error("network down");
        },
      }),
    ).rejects.toThrow(/download failed/);
  });

  it("fails closed when the content exceeds the byte cap", async () => {
    const { pda, data } = await jobSpecAccount({});
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, data),
        fetchUri: async () => new Uint8Array(64),
        maxBytes: 16,
      }),
    ).rejects.toThrow(/byte cap/);
  });
});

describe("public-only job-spec downloader", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ])("classifies non-public address %s", (ip) => {
    expect(isPublicIpAddress(ip)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "classifies public address %s",
    (ip) => {
      expect(isPublicIpAddress(ip)).toBe(true);
    },
  );

  it("rejects direct loopback and cloud-metadata literals before opening a socket", async () => {
    let requested = false;
    const fetcher = createPublicUriFetcher({
      maxBytes: 1024,
      requester: async () => {
        requested = true;
        return { kind: "success", bytes: NETWORK_BODY };
      },
    });
    await expect(fetcher("http://127.0.0.1/admin")).rejects.toThrow(/non-public/);
    await expect(fetcher("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /non-public/,
    );
    await expect(fetcher("http://[::1]/admin")).rejects.toThrow(/non-public/);
    await expect(fetcher("http://2130706433/admin")).rejects.toThrow(/non-public/);
    await expect(fetcher("http://0x7f000001/admin")).rejects.toThrow(/non-public/);
    expect(requested).toBe(false);
  });

  it("rejects a mixed public/private DNS answer instead of retrying onto private space", async () => {
    let requested = false;
    const fetcher = createPublicUriFetcher({
      maxBytes: 1024,
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ],
      requester: async () => {
        requested = true;
        return { kind: "success", bytes: NETWORK_BODY };
      },
    });
    await expect(fetcher("https://spec.example/job")).rejects.toThrow(/non-public/);
    expect(requested).toBe(false);
  });

  it("pins the validated DNS answer into the request", async () => {
    const seen: string[] = [];
    const fetcher = createPublicUriFetcher({
      maxBytes: 1024,
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      requester: async ({ address: pinned }) => {
        seen.push(`${pinned.address}/${pinned.family}`);
        return { kind: "success", bytes: NETWORK_BODY };
      },
    });
    await expect(fetcher("https://spec.example/job")).resolves.toEqual(NETWORK_BODY);
    expect(seen).toEqual(["93.184.216.34/4"]);
  });

  it("re-resolves and rejects every redirect target before the next request", async () => {
    const requestedHosts: string[] = [];
    const fetcher = createPublicUriFetcher({
      maxBytes: 1024,
      resolver: async (hostname) =>
        hostname === "public.example"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "169.254.169.254", family: 4 }],
      requester: async ({ url }) => {
        requestedHosts.push(url.hostname);
        return {
          kind: "redirect",
          location: "http://metadata.example/latest/meta-data/iam",
        };
      },
    });
    await expect(fetcher("https://public.example/job")).rejects.toThrow(/non-public/);
    expect(requestedHosts).toEqual(["public.example"]);
  });

  it("rejects credentials and redirect loops", async () => {
    const fetcher = createPublicUriFetcher({
      maxBytes: 1024,
      maxRedirects: 1,
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      requester: async () => ({ kind: "redirect", location: "/again" }),
    });
    await expect(fetcher("https://user:pass@public.example/job")).rejects.toThrow(
      /credentials/,
    );
    await expect(fetcher("https://public.example/job")).rejects.toThrow(/exceeded 1 redirects/);
  });
});
