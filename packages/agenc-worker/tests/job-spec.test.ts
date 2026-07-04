// Job-spec verification FAILS CLOSED: content that doesn't hash to the
// on-chain commitment is never executed; non-http(s) schemes are refused
// (agenc:// means "no fetchable content").
import { describe, expect, it } from "vitest";
import { address, type Address } from "@solana/kit";
import {
  findTaskJobSpecPda,
  getTaskJobSpecEncoder,
} from "@tetsuo-ai/marketplace-sdk";
import { fetchAndVerifyJobSpec, JobSpecError } from "../src/job-spec.js";
import { sha256 } from "../src/result.js";

const TASK = address("F1qYyDAYYS1sLxq5nDprfNknnwGPo7ssyKvhScv6f8Uc");
const CREATOR = address("7Y9dRMi8ZtyDjLdSpzUCsxDgHooZTfp3RyYs2eZWmL39");

const SPEC_BODY = new TextEncoder().encode('{"title":"day job","summary":"do it"}');

async function jobSpecAccount(overrides: {
  jobSpecHash?: Uint8Array;
  jobSpecUri?: string;
}): Promise<{ pda: Address; data: Uint8Array }> {
  const [pda] = await findTaskJobSpecPda({ task: TASK });
  const data = new Uint8Array(
    getTaskJobSpecEncoder().encode({
      task: TASK,
      creator: CREATOR,
      jobSpecHash: overrides.jobSpecHash ?? sha256(SPEC_BODY),
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
  it("accepts content whose sha256 equals the pinned hash", async () => {
    const { pda, data } = await jobSpecAccount({});
    const verified = await fetchAndVerifyJobSpec({
      task: TASK,
      readAccount: readerFor(pda, data),
      fetchUri: async () => SPEC_BODY,
    });
    expect(verified.content).toEqual(SPEC_BODY);
    expect(verified.jobSpecUri).toBe("https://specs.example/spec.json");
    expect(verified.jobSpecHash).toEqual(sha256(SPEC_BODY));
  });

  it("FAILS CLOSED on a hash mismatch (tampered content is never executed)", async () => {
    const { pda, data } = await jobSpecAccount({});
    const tampered = new TextEncoder().encode(
      '{"title":"day job","summary":"do it","extra":"malicious edit"}',
    );
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, data),
        fetchUri: async () => tampered,
      }),
    ).rejects.toThrow(/hash mismatch/);
  });

  it("fails when the TaskJobSpec pointer account does not exist", async () => {
    const [pda] = await findTaskJobSpecPda({ task: TASK });
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, null),
        fetchUri: async () => SPEC_BODY,
      }),
    ).rejects.toThrow(/no TaskJobSpec pinned/);
  });

  it("fails on an all-zero (unpinned) hash", async () => {
    const { pda, data } = await jobSpecAccount({ jobSpecHash: new Uint8Array(32) });
    await expect(
      fetchAndVerifyJobSpec({
        task: TASK,
        readAccount: readerFor(pda, data),
        fetchUri: async () => SPEC_BODY,
      }),
    ).rejects.toThrow(/all zeros/);
  });

  it("treats agenc:// as 'no fetchable content' without calling the fetcher", async () => {
    const { pda, data } = await jobSpecAccount({
      jobSpecUri: "agenc://job-spec/sha256/abc",
    });
    let fetched = false;
    const verified = await fetchAndVerifyJobSpec({
      task: TASK,
      readAccount: readerFor(pda, data),
      fetchUri: async () => {
        fetched = true;
        return SPEC_BODY;
      },
    });
    expect(verified.content).toBeNull();
    expect(fetched).toBe(false);
  });

  it.each(["file:///etc/passwd", "ftp://x/spec", "data:text/plain,hi", "ipfs://abc"])(
    "refuses non-http(s) scheme %s",
    async (uri) => {
      const { pda, data } = await jobSpecAccount({ jobSpecUri: uri });
      await expect(
        fetchAndVerifyJobSpec({
          task: TASK,
          readAccount: readerFor(pda, data),
          fetchUri: async () => SPEC_BODY,
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
