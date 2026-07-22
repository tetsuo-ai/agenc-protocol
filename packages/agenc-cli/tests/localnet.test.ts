import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { address, type Address, type ReadonlyUint8Array } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findBidMarketplacePda,
  findModerationConfigPda,
  findProtocolConfigPda,
  getBidMarketplaceConfigEncoder,
  getModerationConfigEncoder,
  getProtocolConfigEncoder,
  SURFACE_REVISION_CURRENT,
} from "@tetsuo-ai/marketplace-sdk";
import {
  assertValidatorProcessBinding,
  bootLocalnet,
  checkLocalnetHealth,
  decodeLocalnetProtocolReadiness,
  localnetProtocolIsMarketplaceReady,
  parseValidatorPidRecord,
  type ValidatorPidRecord,
} from "../src/localnet.js";

const STATE_DIR = path.resolve("/repo/.localnet");
const LEDGER = path.join(STATE_DIR, "ledger");
const PROGRAM_DESCRIPTOR = "/proc/self/fd/5";
const PROGRAM_ID = "Program1111111111111111111111111111111111";
const ARGV = [
  "solana-test-validator",
  "--ledger",
  LEDGER,
  "--rpc-port",
  "8899",
  "--upgradeable-program",
  PROGRAM_ID,
  PROGRAM_DESCRIPTOR,
];
const ARGV_SHA256 = createHash("sha256")
  .update(Buffer.from(`${ARGV.join("\0")}\0`))
  .digest("hex");
const RECORD: ValidatorPidRecord = {
  schemaVersion: 2,
  role: "validator",
  pid: 1234,
  uid: 1000,
  processStartTicks: "123456",
  executable: "/usr/bin/solana-test-validator",
  cwd: STATE_DIR,
  argvSha256: ARGV_SHA256,
  recordedAt: "2026-07-19T00:00:00.000Z",
  rpcPort: 8899,
  programSha256: "ab".repeat(32),
  programSize: 2_000_000,
  programLoadMethod: "private-unlinked-fd-v1",
};

function encodedAccount(
  data: ReadonlyUint8Array,
  override: Record<string, unknown> = {},
): {
  executable: boolean;
  owner: string;
  data: unknown[];
  [key: string]: unknown;
} {
  return {
    executable: false,
    owner: AGENC_COORDINATION_PROGRAM_ADDRESS,
    data: [Buffer.from(data).toString("base64"), "base64"],
    ...override,
  };
}

function encodedProtocolAccount(
  protocolPaused: boolean,
  surfaceRevision: number,
  bump = 1,
) {
  const zero = address("11111111111111111111111111111111");
  const data = getProtocolConfigEncoder().encode({
    authority: zero,
    treasury: zero,
    disputeThreshold: 60,
    protocolFeeBps: 500,
    minArbiterStake: 0n,
    minAgentStake: 1_000_000n,
    maxClaimDuration: 1n,
    maxDisputeDuration: 1n,
    totalAgents: 0n,
    totalTasks: 0n,
    completedTasks: 0n,
    totalValueDistributed: 0n,
    bump,
    multisigThreshold: 2,
    multisigOwnersLen: 3,
    taskCreationCooldown: 0n,
    maxTasksPer24h: 1,
    disputeInitiationCooldown: 0n,
    maxDisputesPer24h: 1,
    minStakeForDispute: 1_000_000n,
    slashPercentage: 0,
    stateUpdateCooldown: 60n,
    votingPeriod: 1n,
    protocolVersion: 1,
    minSupportedVersion: 1,
    protocolPaused,
    disabledTaskTypeMask: 0,
    multisigOwners: [zero, zero, zero, zero, zero],
    surfaceRevision,
  });
  return encodedAccount(data);
}

function encodedModerationAccount(authority: Address, bump: number) {
  return encodedAccount(
    getModerationConfigEncoder().encode({
      authority,
      moderationAuthority: address("11111111111111111111111111111111"),
      enabled: true,
      createdAt: 1n,
      updatedAt: 1n,
      bump,
      reserved: new Uint8Array(6),
    }),
  );
}

function encodedBidMarketplaceAccount(
  authority: Address,
  bump: number,
  override: Partial<{
    minBidBondLamports: bigint;
    bidCreationCooldownSecs: bigint;
    maxBidsPer24h: number;
    maxActiveBidsPerTask: number;
    maxBidLifetimeSecs: bigint;
    acceptedNoShowSlashBps: number;
  }> = {},
) {
  return encodedAccount(
    getBidMarketplaceConfigEncoder().encode({
      authority,
      minBidBondLamports: 1_000_000n,
      bidCreationCooldownSecs: 60n,
      maxBidsPer24h: 50,
      maxActiveBidsPerTask: 20,
      maxBidLifetimeSecs: 604_800n,
      acceptedNoShowSlashBps: 1_000,
      bump,
      ...override,
    }),
  );
}

async function localnetMarketplaceAccounts(
  options: {
    protocolPaused?: boolean;
    surfaceRevision?: number;
    bidPolicy?: Parameters<typeof encodedBidMarketplaceAccount>[2];
  } = {},
) {
  const [[, protocolBump], [, moderationBump], [, bidMarketplaceBump]] =
    await Promise.all([
      findProtocolConfigPda(),
      findModerationConfigPda(),
      findBidMarketplacePda(),
    ]);
  const authority = address("11111111111111111111111111111111");
  return {
    protocol: encodedProtocolAccount(
      options.protocolPaused ?? false,
      options.surfaceRevision ?? SURFACE_REVISION_CURRENT,
      protocolBump,
    ),
    moderation: encodedModerationAccount(authority, moderationBump),
    bidMarketplace: encodedBidMarketplaceAccount(
      authority,
      bidMarketplaceBump,
      options.bidPolicy,
    ),
  };
}

type MockRpcRequest = { method?: unknown };

function stubLocalnetRpc(
  accounts: Awaited<ReturnType<typeof localnetMarketplaceAccounts>>,
  override?: (request: MockRpcRequest) => unknown,
) {
  const fetchMock = vi.fn(
    async (_input: unknown, init?: { body?: unknown }) => {
      const request = JSON.parse(String(init?.body)) as MockRpcRequest;
      const overridden = override?.(request);
      if (overridden instanceof Error) throw overridden;
      const payload =
        overridden ??
        (request.method === "getHealth"
          ? { jsonrpc: "2.0", id: 1, result: "ok" }
          : request.method === "getAccountInfo"
            ? {
                jsonrpc: "2.0",
                id: 2,
                result: {
                  value: {
                    executable: true,
                    owner: "BPFLoaderUpgradeab1e11111111111111111111111",
                  },
                },
              }
            : request.method === "getMultipleAccounts"
              ? {
                  jsonrpc: "2.0",
                  id: 3,
                  result: {
                    value: [
                      accounts.protocol,
                      accounts.moderation,
                      accounts.bidMarketplace,
                    ],
                  },
                }
              : { jsonrpc: "2.0", id: null, error: { code: -32601 } });
      return {
        ok: true,
        json: async () => payload,
      };
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("localnet purge identity", () => {
  it("requires both unpaused state and the current surface for marketplace readiness", () => {
    expect(
      localnetProtocolIsMarketplaceReady({
        protocolPaused: false,
        surfaceRevision: SURFACE_REVISION_CURRENT,
      }),
    ).toBe(true);
    expect(
      localnetProtocolIsMarketplaceReady({
        protocolPaused: true,
        surfaceRevision: SURFACE_REVISION_CURRENT,
      }),
    ).toBe(false);
    expect(
      localnetProtocolIsMarketplaceReady({
        protocolPaused: false,
        surfaceRevision: 0,
      }),
    ).toBe(false);
  });

  it("decodes only canonical program-owned ProtocolConfig readiness", () => {
    expect(
      decodeLocalnetProtocolReadiness(
        encodedProtocolAccount(false, SURFACE_REVISION_CURRENT),
        AGENC_COORDINATION_PROGRAM_ADDRESS,
      ),
    ).toEqual({
      marketplaceReady: true,
      protocolPaused: false,
      surfaceRevision: SURFACE_REVISION_CURRENT,
    });
    expect(
      decodeLocalnetProtocolReadiness(
        encodedProtocolAccount(true, 0),
        AGENC_COORDINATION_PROGRAM_ADDRESS,
      ),
    ).toEqual({
      marketplaceReady: false,
      protocolPaused: true,
      surfaceRevision: 0,
    });
    expect(
      decodeLocalnetProtocolReadiness(
        {
          ...encodedProtocolAccount(false, SURFACE_REVISION_CURRENT),
          owner: "11111111111111111111111111111111",
        },
        AGENC_COORDINATION_PROGRAM_ADDRESS,
      ),
    ).toBeNull();
  });

  describe("marketplace health RPC", () => {
    const env = {
      rpcUrl: "http://127.0.0.1:8899",
      programId: AGENC_COORDINATION_PROGRAM_ADDRESS,
    };
    const protocolUnavailable = {
      rpcHealthy: true,
      programDeployed: true,
      marketplaceReady: false,
      protocolPaused: null,
      surfaceRevision: null,
    };

    it("reports ready only for the complete canonical local marketplace", async () => {
      const accounts = await localnetMarketplaceAccounts();
      const fetchMock = stubLocalnetRpc(accounts);

      await expect(checkLocalnetHealth(env)).resolves.toEqual({
        rpcHealthy: true,
        programDeployed: true,
        marketplaceReady: true,
        protocolPaused: false,
        surfaceRevision: SURFACE_REVISION_CURRENT,
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const request = JSON.parse(
        String(fetchMock.mock.calls[2]?.[1]?.body),
      ) as { method: string; params: unknown[] };
      expect(request.method).toBe("getMultipleAccounts");
      expect(request.params[0]).toHaveLength(3);
    });

    it("reports a paused protocol as not marketplace-ready", async () => {
      const accounts = await localnetMarketplaceAccounts({
        protocolPaused: true,
      });
      stubLocalnetRpc(accounts);

      await expect(checkLocalnetHealth(env)).resolves.toMatchObject({
        marketplaceReady: false,
        protocolPaused: true,
        surfaceRevision: SURFACE_REVISION_CURRENT,
      });
    });

    it("reports a non-current surface as not marketplace-ready", async () => {
      const accounts = await localnetMarketplaceAccounts({
        surfaceRevision: SURFACE_REVISION_CURRENT - 1,
      });
      stubLocalnetRpc(accounts);

      await expect(checkLocalnetHealth(env)).resolves.toMatchObject({
        marketplaceReady: false,
        protocolPaused: false,
        surfaceRevision: SURFACE_REVISION_CURRENT - 1,
      });
    });

    it("rejects a ProtocolConfig owned by another program", async () => {
      const accounts = await localnetMarketplaceAccounts();
      accounts.protocol = {
        ...accounts.protocol,
        owner: "11111111111111111111111111111111",
      };
      stubLocalnetRpc(accounts);

      await expect(checkLocalnetHealth(env)).resolves.toEqual(
        protocolUnavailable,
      );
    });

    it("rejects an executable ProtocolConfig account", async () => {
      const accounts = await localnetMarketplaceAccounts();
      accounts.protocol = { ...accounts.protocol, executable: true };
      stubLocalnetRpc(accounts);

      await expect(checkLocalnetHealth(env)).resolves.toEqual(
        protocolUnavailable,
      );
    });

    it("rejects malformed non-canonical base64 account data", async () => {
      const accounts = await localnetMarketplaceAccounts();
      accounts.protocol = {
        ...accounts.protocol,
        data: ["%%%not-base64%%%", "base64"],
      };
      stubLocalnetRpc(accounts);

      await expect(checkLocalnetHealth(env)).resolves.toEqual(
        protocolUnavailable,
      );
    });

    it("rejects a wrong discriminator or canonical PDA bump", async () => {
      const accounts = await localnetMarketplaceAccounts();
      const encoded = accounts.protocol.data[0];
      if (typeof encoded !== "string") throw new Error("invalid test fixture");
      const bytes = Buffer.from(encoded, "base64");
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      accounts.protocol = {
        ...accounts.protocol,
        data: [bytes.toString("base64"), "base64"],
      };
      stubLocalnetRpc(accounts);
      await expect(checkLocalnetHealth(env)).resolves.toEqual(
        protocolUnavailable,
      );

      vi.unstubAllGlobals();
      const [, protocolBump] = await findProtocolConfigPda();
      const wrongBumpAccounts = await localnetMarketplaceAccounts();
      wrongBumpAccounts.protocol = encodedProtocolAccount(
        false,
        SURFACE_REVISION_CURRENT,
        (protocolBump + 1) & 0xff,
      );
      stubLocalnetRpc(wrongBumpAccounts);
      await expect(checkLocalnetHealth(env)).resolves.toEqual(
        protocolUnavailable,
      );
    });

    it("fails closed when the RPC request errors", async () => {
      const accounts = await localnetMarketplaceAccounts();
      stubLocalnetRpc(accounts, (request) =>
        request.method === "getHealth"
          ? new Error("RPC unavailable")
          : undefined,
      );

      await expect(checkLocalnetHealth(env)).resolves.toEqual({
        rpcHealthy: false,
        programDeployed: false,
        marketplaceReady: false,
        protocolPaused: null,
        surfaceRevision: null,
      });
    });

    it("requires a valid enabled ModerationConfig", async () => {
      const accounts = await localnetMarketplaceAccounts();
      accounts.moderation = {
        ...accounts.moderation,
        owner: "11111111111111111111111111111111",
      };
      stubLocalnetRpc(accounts);

      await expect(checkLocalnetHealth(env)).resolves.toMatchObject({
        marketplaceReady: false,
        protocolPaused: false,
        surfaceRevision: SURFACE_REVISION_CURRENT,
      });
    });

    it("requires the exact local BidMarketplaceConfig policy", async () => {
      const accounts = await localnetMarketplaceAccounts({
        bidPolicy: { maxBidsPer24h: 51 },
      });
      stubLocalnetRpc(accounts);

      await expect(checkLocalnetHealth(env)).resolves.toMatchObject({
        marketplaceReady: false,
        protocolPaused: false,
        surfaceRevision: SURFACE_REVISION_CURRENT,
      });
    });
  });

  it("rejects legacy numeric PID files and unknown metadata", () => {
    expect(() => parseValidatorPidRecord("1234")).toThrow(/JSON object/);
    expect(() =>
      parseValidatorPidRecord(JSON.stringify({ ...RECORD, surprise: true })),
    ).toThrow(/unsupported identity/);
    expect(() =>
      parseValidatorPidRecord(JSON.stringify({ ...RECORD, schemaVersion: 1 })),
    ).toThrow(/malformed exact process identity/);
    expect(() =>
      parseValidatorPidRecord(
        JSON.stringify({ ...RECORD, programLoadMethod: "mutable-path" }),
      ),
    ).toThrow(/programLoadMethod is invalid/);
  });

  it("accepts only an exact owner/start/executable/argv/ledger binding", () => {
    expect(() =>
      assertValidatorProcessBinding(
        RECORD,
        {
          uid: 1000,
          executable: "/usr/bin/solana-test-validator",
          argv: ARGV,
          cwd: STATE_DIR,
          processStartTicks: RECORD.processStartTicks,
          argvSha256: RECORD.argvSha256,
        },
        {
          uid: 1000,
          ledger: LEDGER,
          stateDir: STATE_DIR,
          programId: PROGRAM_ID,
        },
      ),
    ).not.toThrow();
  });

  it.each([
    { uid: 2000 },
    { executable: "/usr/bin/node" },
    { cwd: "/other", argvSha256: ARGV_SHA256 },
    {
      argv: [
        "solana-test-validator",
        "--ledger",
        "/other",
        "--rpc-port",
        "8899",
      ],
    },
    {
      argv: ARGV.map((value) =>
        value === PROGRAM_DESCRIPTOR ? "/repo/program.so" : value,
      ),
    },
    { processStartTicks: "123457" },
    { argvSha256: "00".repeat(32) },
  ])("refuses an ambiguous or reused PID %#", (override) => {
    expect(() =>
      assertValidatorProcessBinding(
        RECORD,
        {
          uid: 1000,
          executable: "/usr/bin/solana-test-validator",
          argv: ARGV,
          cwd: STATE_DIR,
          processStartTicks: RECORD.processStartTicks,
          argvSha256: RECORD.argvSha256,
          ...override,
        },
        {
          uid: 1000,
          ledger: LEDGER,
          stateDir: STATE_DIR,
          programId: PROGRAM_ID,
        },
      ),
    ).toThrow(/purge refused/);
  });
});

async function withLocalnetScriptFixture(
  scripts: { down?: string; up?: string },
  run: (fixture: { repoRoot: string; eventsFile: string }) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "agenc-cli-localnet-"));
  const scriptsDirectory = path.join(repoRoot, "scripts");
  const eventsFile = path.join(repoRoot, "events.txt");
  await mkdir(scriptsDirectory);
  try {
    if (scripts.down !== undefined) {
      await writeFile(
        path.join(scriptsDirectory, "localnet-down.mjs"),
        scripts.down.replaceAll("__EVENTS_FILE__", JSON.stringify(eventsFile)),
      );
    }
    if (scripts.up !== undefined) {
      await writeFile(
        path.join(scriptsDirectory, "localnet-up.mjs"),
        scripts.up.replaceAll("__EVENTS_FILE__", JSON.stringify(eventsFile)),
      );
    }
    await run({ repoRoot, eventsFile });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

describe("localnet purge orchestration", () => {
  it("waits for localnet-down --purge to finish before starting localnet-up", async () => {
    await withLocalnetScriptFixture(
      {
        down: `
          import { appendFile } from "node:fs/promises";
          const events = __EVENTS_FILE__;
          if (process.argv[2] !== "--purge") process.exit(91);
          await appendFile(events, "down-start\\n");
          await new Promise((resolve) => setTimeout(resolve, 25));
          await appendFile(events, "down-complete\\n");
        `,
        up: `
          import { appendFile } from "node:fs/promises";
          await appendFile(__EVENTS_FILE__, "up:" + process.argv.slice(2).join(",") + "\\n");
        `,
      },
      async ({ repoRoot, eventsFile }) => {
        await bootLocalnet(repoRoot, { purge: true });
        await expect(readFile(eventsFile, "utf8")).resolves.toBe(
          "down-start\ndown-complete\nup:--dev-ready\n",
        );
      },
    );
  });

  it("does not start localnet-up when localnet-down fails", async () => {
    await withLocalnetScriptFixture(
      {
        down: `
          import { appendFile } from "node:fs/promises";
          await appendFile(__EVENTS_FILE__, "down-failed\\n");
          process.exitCode = 23;
        `,
        up: `
          import { appendFile } from "node:fs/promises";
          await appendFile(__EVENTS_FILE__, "up\\n");
        `,
      },
      async ({ repoRoot, eventsFile }) => {
        await expect(bootLocalnet(repoRoot, { purge: true })).rejects.toThrow(
          /localnet-down\.mjs exited with code 23/u,
        );
        await expect(readFile(eventsFile, "utf8")).resolves.toBe(
          "down-failed\n",
        );
      },
    );
  });

  it("fails before boot when purge tooling is missing", async () => {
    await withLocalnetScriptFixture(
      {
        up: `
          import { appendFile } from "node:fs/promises";
          await appendFile(__EVENTS_FILE__, "up\\n");
        `,
      },
      async ({ repoRoot, eventsFile }) => {
        await expect(bootLocalnet(repoRoot, { purge: true })).rejects.toThrow(
          /no localnet purge tooling/u,
        );
        await expect(readFile(eventsFile, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );
  });

  it("keeps numeric PID signalling out of the CLI purge path", async () => {
    const source = await readFile(
      new URL("../src/localnet.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\bprocess\.kill\s*\(/u);
    expect(source).toContain(
      'runLocalnetScript(repoRoot, downScript, ["--purge"])',
    );
    expect(source).toContain(
      'runLocalnetScript(repoRoot, script, ["--dev-ready"])',
    );
  });
});
