/**
 * WP-D6 orchestration unit coverage.
 *
 * The moderation-account resolvers decide which P1.2 gate accounts a
 * transaction carries (roster PDA / legacy record override), so their
 * branching is money-path-adjacent: attach the roster entry only when it
 * verifiably exists, prefer v2 records, honor the legacy grace window only
 * for the SAME moderator, and degrade to "no overrides" on any read failure.
 * The generated account fetchers are mocked at the module seam (the react
 * suite's proven pattern); PDA derivation is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const chain = vi.hoisted(() => ({
  records: {} as Record<string, { moderator: string }>,
  attestors: {} as Record<string, true>,
  moderationConfig: null as null | { moderationAuthority: string },
  throwOnFetch: false,
}));

vi.mock("../src/generated/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/generated/index.js")>();
  const fetchRecord = async (_rpc: unknown, addr: unknown) => {
    if (chain.throwOnFetch) throw new Error("rpc unavailable");
    const data = chain.records[addr as string];
    return data
      ? { exists: true, address: addr, data }
      : { exists: false, address: addr };
  };
  return {
    ...actual,
    fetchMaybeTaskModeration: vi.fn(fetchRecord),
    fetchMaybeListingModeration: vi.fn(fetchRecord),
    fetchMaybeModerationAttestor: vi.fn(
      async (_rpc: unknown, addr: unknown) => {
        if (chain.throwOnFetch) throw new Error("rpc unavailable");
        return chain.attestors[addr as string]
          ? { exists: true, address: addr, data: {} }
          : { exists: false, address: addr };
      },
    ),
    fetchMaybeModerationConfig: vi.fn(async (_rpc: unknown, addr: unknown) => {
      if (chain.throwOnFetch) throw new Error("rpc unavailable");
      return chain.moderationConfig
        ? { exists: true, address: addr, data: chain.moderationConfig }
        : { exists: false, address: addr };
    }),
  };
});

import { address, type Address } from "@solana/kit";
import {
  findListingModerationPda,
  findModerationAttestorPda,
  findTaskModerationPda,
} from "../src/generated/index.js";
import * as facade from "../src/facade/index.js";
import {
  hireAndActivate,
  resolveActivationModerationAccounts,
  resolveHireListingModerationAccounts,
  type ModerationAccountReadRpc,
} from "../src/orchestration/index.js";

const RPC = {} as ModerationAccountReadRpc;
const GLOBAL_AUTHORITY = address("11111111111111111111111111111111");
const ROSTER_MODERATOR = address(
  "So11111111111111111111111111111111111111112",
);
const TASK = address("SysvarC1ock11111111111111111111111111111111");
const LISTING = address("SysvarRent111111111111111111111111111111111");
const HASH = new Uint8Array(32).fill(9);

beforeEach(() => {
  chain.records = {};
  chain.attestors = {};
  chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
  chain.throwOnFetch = false;
});

describe("resolveActivationModerationAccounts", () => {
  it("attaches nothing on the global-authority path with a v2 record", async () => {
    const [v2] = await findTaskModerationPda({
      task: TASK,
      jobSpecHash: HASH,
      moderator: GLOBAL_AUTHORITY,
    });
    chain.records[v2] = { moderator: GLOBAL_AUTHORITY };
    await expect(
      resolveActivationModerationAccounts({
        rpc: RPC,
        task: TASK,
        jobSpecHash: HASH,
        moderator: GLOBAL_AUTHORITY,
      }),
    ).resolves.toEqual({});
  });

  it("attaches the roster PDA only when the entry exists on-chain", async () => {
    const [rosterPda] = await findModerationAttestorPda({
      attestor: ROSTER_MODERATOR,
    });
    // No roster entry -> no attach (a set-but-missing account fails harder).
    await expect(
      resolveActivationModerationAccounts({
        rpc: RPC,
        task: TASK,
        jobSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({});
    // Entry exists -> attach.
    chain.attestors[rosterPda] = true;
    await expect(
      resolveActivationModerationAccounts({
        rpc: RPC,
        task: TASK,
        jobSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({ moderationAttestor: rosterPda });
  });

  it("points at the legacy record ONLY when authored by the same moderator", async () => {
    const [legacyPda] = await facade.findLegacyTaskModerationPda({
      task: TASK,
      jobSpecHash: HASH,
    });
    chain.records[legacyPda] = { moderator: ROSTER_MODERATOR };
    const [rosterPda] = await findModerationAttestorPda({
      attestor: ROSTER_MODERATOR,
    });
    chain.attestors[rosterPda] = true;
    await expect(
      resolveActivationModerationAccounts({
        rpc: RPC,
        task: TASK,
        jobSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({
      moderationAttestor: rosterPda,
      taskModeration: legacyPda,
    });
    // Different author -> the override must NOT be attached.
    chain.records[legacyPda] = { moderator: GLOBAL_AUTHORITY };
    await expect(
      resolveActivationModerationAccounts({
        rpc: RPC,
        task: TASK,
        jobSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({ moderationAttestor: rosterPda });
  });

  it("degrades to no overrides on read failure and without an rpc", async () => {
    chain.throwOnFetch = true;
    await expect(
      resolveActivationModerationAccounts({
        rpc: RPC,
        task: TASK,
        jobSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({});
    await expect(
      resolveActivationModerationAccounts({
        task: TASK,
        jobSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({});
  });
});

describe("resolveHireListingModerationAccounts", () => {
  it("prefers the v2 listing record and returns the legacy override otherwise", async () => {
    const [rosterPda] = await findModerationAttestorPda({
      attestor: ROSTER_MODERATOR,
    });
    chain.attestors[rosterPda] = true;
    const [v2] = await findListingModerationPda({
      listing: LISTING,
      jobSpecHash: HASH,
      moderator: ROSTER_MODERATOR,
    });
    chain.records[v2] = { moderator: ROSTER_MODERATOR };
    await expect(
      resolveHireListingModerationAccounts({
        rpc: RPC,
        listing: LISTING,
        listingSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({ moderationAttestor: rosterPda });

    delete chain.records[v2];
    const [legacyPda] = await facade.findLegacyListingModerationPda({
      listing: LISTING,
      jobSpecHash: HASH,
    });
    chain.records[legacyPda] = { moderator: ROSTER_MODERATOR };
    await expect(
      resolveHireListingModerationAccounts({
        rpc: RPC,
        listing: LISTING,
        listingSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({
      moderationAttestor: rosterPda,
      listingModeration: legacyPda,
    });
  });
});

describe("hireAndActivate moderation-result validation", () => {
  function stubClient(calls: string[]) {
    return {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        calls.push("hire");
        return { signature: "sig-hire", logs: [] };
      },
      setTaskJobSpec: async () => {
        calls.push("activate");
        return { signature: "sig-activate", logs: [] };
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
  }
  const hire = {
    listing: LISTING,
    taskId: new Uint8Array(32).fill(1),
    expectedPrice: 1n,
    expectedVersion: 1n,
    reviewWindowSecs: 3600n,
    moderator: GLOBAL_AUTHORITY,
  };

  it.each([
    [
      "unattested moderation",
      { moderationAttested: false, jobSpecHash: HASH, jobSpecUri: "u", moderator: GLOBAL_AUTHORITY as string },
      /was not attested/i,
    ],
    [
      "invalid jobSpecHash",
      { moderationAttested: true, jobSpecHash: new Uint8Array(31), jobSpecUri: "u", moderator: GLOBAL_AUTHORITY as string },
      /invalid jobSpecHash/i,
    ],
    [
      "empty jobSpecUri",
      { moderationAttested: true, jobSpecHash: HASH, jobSpecUri: "  ", moderator: GLOBAL_AUTHORITY as string },
      /empty jobSpecUri/i,
    ],
    [
      "missing moderator",
      { moderationAttested: true, jobSpecHash: HASH, jobSpecUri: "u", moderator: "" },
      /no moderator/i,
    ],
  ])("refuses to sign activation after %s", async (_name, moderation, error) => {
    const calls: string[] = [];
    await expect(
      hireAndActivate(stubClient(calls), {
        hire,
        jobSpec: null,
        hostAndModerateJobSpec: async () =>
          moderation as never,
      }),
    ).rejects.toThrow(error);
    // The hire signed, activation did NOT.
    expect(calls).toEqual(["hire"]);
  });

  it("threads the callback's moderator into activation by default", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => ({ signature: "s1", logs: [] }),
      setTaskJobSpec: async (input: Record<string, unknown>) => {
        seen.push(input);
        return { signature: "s2", logs: [] };
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const result = await hireAndActivate(client, {
      hire,
      jobSpec: null,
      hostAndModerateJobSpec: async () => ({
        jobSpecHash: HASH,
        jobSpecUri: "agenc://job-spec/sha256/u",
        moderationAttested: true,
        moderator: ROSTER_MODERATOR as Address,
      }),
    });
    expect(seen[0]?.moderator).toBe(ROSTER_MODERATOR);
    expect(result.activationSignature).toBe("s2");
  });
});
