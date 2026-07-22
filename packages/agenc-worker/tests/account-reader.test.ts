import { address, type Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { createSolanaAccountReaders } from "../src/account-reader.js";

const ACCOUNT = address("F1qYyDAYYS1sLxq5nDprfNknnwGPo7ssyKvhScv6f8Uc");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const OTHER_OWNER = address("SysvarRent111111111111111111111111111111111");

function rpcValue(options: {
  data?: Uint8Array;
  owner?: Address;
  executable?: boolean;
}) {
  return {
    data: [
      Buffer.from(options.data ?? new Uint8Array()).toString("base64"),
      "base64",
    ],
    owner: options.owner ?? SYSTEM_PROGRAM,
    executable: options.executable ?? false,
    lamports: 1n,
    rentEpoch: 0n,
    space: BigInt(options.data?.byteLength ?? 0),
  };
}

describe("Solana CLI account-reader adapter", () => {
  it("preserves an absent account for both compatible reader surfaces", async () => {
    const fetcher = vi.fn(async () => null);
    const readers = createSolanaAccountReaders(fetcher);

    await expect(readers.readAccountInfo(ACCOUNT)).resolves.toBeNull();
    await expect(readers.readAccount(ACCOUNT)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves System ownership, non-executable state, and zero data for dust", async () => {
    const readers = createSolanaAccountReaders(async () => rpcValue({}));

    await expect(readers.readAccountInfo(ACCOUNT)).resolves.toEqual({
      data: new Uint8Array(),
      owner: SYSTEM_PROGRAM,
      executable: false,
    });
    await expect(readers.readAccount(ACCOUNT)).resolves.toEqual(
      new Uint8Array(),
    );
  });

  it("does not erase a wrong owner or executable flag", async () => {
    const wrongOwner = createSolanaAccountReaders(async () =>
      rpcValue({ owner: OTHER_OWNER, data: new Uint8Array([1]) }),
    );
    await expect(wrongOwner.readAccountInfo(ACCOUNT)).resolves.toMatchObject({
      owner: OTHER_OWNER,
      executable: false,
    });

    const executable = createSolanaAccountReaders(async () =>
      rpcValue({ executable: true }),
    );
    await expect(executable.readAccountInfo(ACCOUNT)).resolves.toMatchObject({
      owner: SYSTEM_PROGRAM,
      executable: true,
    });
  });

  it("snapshots accessor-backed RPC fields exactly once", async () => {
    const counts = {
      data: 0,
      encoded: 0,
      encoding: 0,
      owner: 0,
      executable: 0,
    };
    const encoded: unknown[] = [];
    Object.defineProperties(encoded, {
      0: {
        get() {
          counts.encoded += 1;
          return counts.encoded === 1 ? "AQ==" : "Ag==";
        },
      },
      1: {
        get() {
          counts.encoding += 1;
          return counts.encoding === 1 ? "base64" : "base58";
        },
      },
      length: { value: 2 },
    });
    const value = Object.defineProperties(
      {},
      {
        data: {
          get() {
            counts.data += 1;
            return counts.data === 1 ? encoded : null;
          },
        },
        owner: {
          get() {
            counts.owner += 1;
            return counts.owner === 1 ? OTHER_OWNER : SYSTEM_PROGRAM;
          },
        },
        executable: {
          get() {
            counts.executable += 1;
            return counts.executable === 1;
          },
        },
      },
    );
    const readers = createSolanaAccountReaders(async () => value);

    await expect(readers.readAccountInfo(ACCOUNT)).resolves.toEqual({
      data: new Uint8Array([1]),
      owner: OTHER_OWNER,
      executable: true,
    });
    expect(counts).toEqual({
      data: 1,
      encoded: 1,
      encoding: 1,
      owner: 1,
      executable: 1,
    });
  });

  it.each([
    undefined,
    {},
    { data: ["", "base58"], owner: SYSTEM_PROGRAM, executable: false },
    {
      data: ["not base64!", "base64"],
      owner: SYSTEM_PROGRAM,
      executable: false,
    },
  ])("rejects malformed RPC account info %#", async (value) => {
    const readers = createSolanaAccountReaders(async () => value);
    await expect(readers.readAccountInfo(ACCOUNT)).rejects.toThrow(
      /RPC account (?:info|data) is (?:malformed|not canonical base64)/,
    );
  });
});
