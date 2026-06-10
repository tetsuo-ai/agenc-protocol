// Regression tests for the adversarial-review fixes to
// scripts/seed-devnet-sandbox.mjs (findings #4/#8/#9/#10): skip-path
// verification of existing on-chain accounts, atomic fixtures writes, and
// the no-secret-leak keypair parser. Pure helpers only — no network, no fs
// beyond an os.tmpdir round-trip for the atomic writer.
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseKeypairBytes,
  verifyExistingAgent,
  verifyExistingListing,
  verifyExistingModeration,
  writeJsonAtomic,
} from "../scripts/seed-devnet-sandbox.mjs";

// ---------------------------------------------------------------------------
// #10 — malformed keypair files must never echo secret material
// ---------------------------------------------------------------------------

describe("parseKeypairBytes (#10 secret-material leak)", () => {
  const FIXED = "expected a solana-keygen JSON array of 64 bytes";

  it("round-trips a valid solana-keygen 64-byte array", () => {
    const raw = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));
    const bytes = parseKeypairBytes(raw, "/tmp/ok.json");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(64);
    expect(bytes[63]).toBe(63);
  });

  it("throws the fixed message for non-JSON input WITHOUT echoing the contents", () => {
    // A raw base58 private-key export is the dangerous case: V8's JSON.parse
    // error embeds a snippet of the input ("KxSecretBa"...).
    const secret = "KxSecretBase58MaterialThatMustNeverHitTheLogs";
    const failure = (() => {
      try {
        parseKeypairBytes(secret, "/tmp/leaky.json");
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain(FIXED);
    expect(failure!.message).toContain("/tmp/leaky.json");
    // The load-bearing assertions: no fragment of the input anywhere.
    expect(failure!.message).not.toContain("KxSecret");
    expect(failure!.message).not.toContain("Unexpected token");
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("rejects valid JSON of the wrong shape with the same fixed message", () => {
    for (const raw of [
      JSON.stringify({ secretKey: [1, 2, 3] }),
      JSON.stringify(Array.from({ length: 63 }, () => 1)), // 63 bytes
      JSON.stringify(Array.from({ length: 64 }, () => 256)), // out of range
      JSON.stringify(Array.from({ length: 64 }, () => "ff")), // strings
      "null",
    ]) {
      expect(() => parseKeypairBytes(raw, "/tmp/bad.json")).toThrow(FIXED);
    }
  });
});

// ---------------------------------------------------------------------------
// #9 — fixtures.json must be written atomically (tmp + rename)
// ---------------------------------------------------------------------------

describe("writeJsonAtomic (#9 non-atomic fixtures write)", () => {
  it("writes to `${path}.tmp` first, then rename()s over the target", async () => {
    const calls: { op: string; args: string[] }[] = [];
    const fakeFs = {
      writeFile: async (file: string, data: string) => {
        calls.push({ op: "writeFile", args: [file, data] });
      },
      rename: async (from: string, to: string) => {
        calls.push({ op: "rename", args: [from, to] });
      },
    };
    await writeJsonAtomic("/out/fixtures.json", { seeded: true }, fakeFs);
    expect(calls.map((c) => c.op)).toEqual(["writeFile", "rename"]);
    expect(calls[0]!.args[0]).toBe("/out/fixtures.json.tmp");
    expect(calls[0]!.args[1]).toBe('{\n  "seeded": true\n}\n');
    expect(calls[1]!.args).toEqual([
      "/out/fixtures.json.tmp",
      "/out/fixtures.json",
    ]);
  });

  it("produces the final file with no .tmp leftover on a real filesystem", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "seed-fixtures-"));
    const target = path.join(dir, "fixtures.json");
    await writeJsonAtomic(target, { seeded: true, listings: [] });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      seeded: true,
      listings: [],
    });
    expect(await readdir(dir)).toEqual(["fixtures.json"]);
  });
});

// ---------------------------------------------------------------------------
// #4 — existing agents must carry the runner's authority into fixtures
// ---------------------------------------------------------------------------

describe("verifyExistingAgent (#4 wrong authority on re-run)", () => {
  it("returns the ON-CHAIN authority when it matches the runner", () => {
    expect(
      verifyExistingAgent({
        name: "Sandbox Codegen Co",
        agent: "AgentPda1111",
        onChainAuthority: "Auth1111",
        runnerAuthority: "Auth1111",
      }),
    ).toBe("Auth1111");
  });

  it("fails loudly when the on-chain authority belongs to a different keypair", () => {
    const failure = (() => {
      try {
        verifyExistingAgent({
          name: "Sandbox Codegen Co",
          agent: "AgentPda1111",
          onChainAuthority: "OriginalAuth",
          runnerAuthority: "NewRunnerAuth",
        });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain("Sandbox Codegen Co");
    expect(failure!.message).toContain("AgentPda1111");
    expect(failure!.message).toContain("OriginalAuth");
    expect(failure!.message).toContain("NewRunnerAuth");
    expect(failure!.message).toContain("Refusing to publish fixtures");
  });
});

// ---------------------------------------------------------------------------
// #8 — existing listings must be verified field-by-field, fixtures from chain
// ---------------------------------------------------------------------------

const MATCHING = {
  name: "Sandbox Translate",
  listing: "ListingPda1111",
  onChain: {
    authority: "Auth1111",
    price: 800_000n,
    state: 0, // ListingState.Active
    category: "translation",
    specHashHex: "ab".repeat(32),
  },
  expected: {
    authority: "Auth1111",
    priceLamports: 800_000,
    activeState: 0,
    category: "translation",
    specHashHex: "ab".repeat(32),
  },
};

describe("verifyExistingListing (#8 unverified blueprint fixtures)", () => {
  it("returns fixture fields FROM CHAIN when everything matches", () => {
    expect(verifyExistingListing(MATCHING)).toEqual({
      authority: "Auth1111",
      priceLamports: 800_000,
      category: "translation",
    });
  });

  it.each([
    [
      "authority",
      { onChain: { ...MATCHING.onChain, authority: "OtherAuth" } },
      "authority",
    ],
    [
      "price (blueprint edited between runs)",
      { onChain: { ...MATCHING.onChain, price: 999_999n } },
      "price",
    ],
    [
      "state not Active",
      { onChain: { ...MATCHING.onChain, state: 1 } }, // Paused
      "not Active",
    ],
    [
      "category drift",
      { onChain: { ...MATCHING.onChain, category: "writing" } },
      "category",
    ],
    [
      "spec_hash drift (description edited → unhireable listing)",
      { onChain: { ...MATCHING.onChain, specHashHex: "cd".repeat(32) } },
      "spec_hash",
    ],
  ])("fails loudly on %s", (_label, override, needle) => {
    const failure = (() => {
      try {
        verifyExistingListing({ ...MATCHING, ...override });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain("refusing to publish fixtures");
    expect(failure!.message).toContain("Sandbox Translate");
    expect(failure!.message).toContain(needle);
  });

  it("reports ALL mismatching fields in one error", () => {
    const failure = (() => {
      try {
        verifyExistingListing({
          ...MATCHING,
          onChain: {
            authority: "OtherAuth",
            price: 1n,
            state: 2,
            category: "writing",
            specHashHex: "00".repeat(32),
          },
        });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    for (const field of [
      "authority",
      "price",
      "state",
      "category",
      "spec_hash",
    ]) {
      expect(failure!.message).toContain(field);
    }
  });
});

describe("verifyExistingModeration (#8 non-CLEAN existing attestation)", () => {
  it("passes a CLEAN (0) record", () => {
    expect(() =>
      verifyExistingModeration({
        name: "Sandbox Translate",
        listing: "ListingPda1111",
        onChainStatus: 0,
      }),
    ).not.toThrow();
  });

  it("fails loudly on a non-CLEAN status (fail-closed hire gate would block)", () => {
    const failure = (() => {
      try {
        verifyExistingModeration({
          name: "Sandbox Translate",
          listing: "ListingPda1111",
          onChainStatus: 2,
        });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain("not CLEAN");
    expect(failure!.message).toContain("fail-closed");
  });
});
