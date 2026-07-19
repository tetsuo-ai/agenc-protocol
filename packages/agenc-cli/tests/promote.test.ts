import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Encoder,
} from "@solana/kit";
import { getProtocolConfigEncoder } from "@tetsuo-ai/marketplace-sdk";
import { describe, expect, it } from "vitest";
import { defaultConfig, serializeConfig } from "../src/config.js";
import {
  gatherPromoteInputAsync,
  REVIEWED_MAINNET_RELEASES,
  runPromoteChecks,
  versionInMatrix,
  type PromoteInput,
} from "../src/promote.js";

function readyInput(): PromoteInput {
  const reviewed = REVIEWED_MAINNET_RELEASES[0];
  const config = defaultConfig("my-shop", "checkout");
  config.network = "mainnet-beta";
  config.rpcUrl = "https://mainnet.helius-rpc.com/";
  config.walletPath = "/home/user/.config/solana/prod.json";
  return {
    config,
    configPath: "/proj/agenc.config.json",
    installedVersions: {
      "@tetsuo-ai/marketplace-sdk": "0.12.0",
    },
    walletExists: true,
    walletValidation: {
      valid: true,
      address: "9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj",
    },
    chainEvidence: {
      genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      finalizedSlot: 431_918_664,
      programExecutable: true,
      programOwner: "BPFLoaderUpgradeab1e11111111111111111111111",
      programDataAddress: reviewed.programDataAddress,
      programDataOwner: "BPFLoaderUpgradeab1e11111111111111111111111",
      programDataExecutable: false,
      programDataSlot: reviewed.programDataSlot,
      upgradeAuthority: reviewed.upgradeAuthority,
      executableHash: reviewed.executableHash,
      releaseCommit: reviewed.sourceCommit,
      protocolConfigAddress: "DeBPkxhzE6MJr66HhEgcHBv5rBFoHWysb6uyK4skufUs",
      protocolConfigOwner: "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
      protocolConfigDecoded: true,
      protocolPaused: false,
      protocolVersion: 1,
      minSupportedVersion: 1,
      surfaceRevision: 4,
    },
  };
}

function statusOf(report: ReturnType<typeof runPromoteChecks>, id: string) {
  return report.checks.find((c) => c.id === id)?.status;
}

const SDK_LINES = ["0.8", "0.9", "0.10", "0.11", "0.12"] as const;

describe("versionInMatrix", () => {
  it("accepts patch releases inside any supported line", () => {
    expect(versionInMatrix("0.8.2", SDK_LINES)).toBe(true);
    expect(versionInMatrix("0.8.11", SDK_LINES)).toBe(true);
    expect(versionInMatrix("0.9.0", SDK_LINES)).toBe(true);
    expect(versionInMatrix("0.9.1", SDK_LINES)).toBe(true);
    expect(versionInMatrix("0.10.0", SDK_LINES)).toBe(true);
    expect(versionInMatrix("0.11.0", SDK_LINES)).toBe(true);
    expect(versionInMatrix("0.12.0", SDK_LINES)).toBe(true);
  });
  it("rejects older and newer lines", () => {
    expect(versionInMatrix("0.7.9", SDK_LINES)).toBe(false);
    expect(versionInMatrix("0.13.0", SDK_LINES)).toBe(false);
    expect(versionInMatrix("0.9.0", ["0.8"])).toBe(false);
    expect(versionInMatrix("1.8.0", SDK_LINES)).toBe(false);
  });
  it("rejects garbage", () => {
    expect(versionInMatrix("not-a-version", ["0.8"])).toBe(false);
  });

  it.each([
    "0.8",
    "0.8.",
    "0.8.2.3",
    "0.8.2garbage",
    "v0.8.2",
    " 0.8.2",
    "00.8.2",
    "0.08.2",
    "0.8.02",
    "0.8.2+build.1",
    "0.8.2-rc.1",
    "0.8.2-01",
  ])("rejects non-canonical, metadata-bearing, or unadmitted version %s", (version) => {
    expect(versionInMatrix(version, ["0.8"])).toBe(false);
  });

  it("admits a prerelease only through an exact matrix entry", () => {
    expect(versionInMatrix("0.12.0-rc.1", ["0.12"])).toBe(false);
    expect(versionInMatrix("0.12.0-rc.1", ["0.12.0-rc.1"])).toBe(true);
    expect(versionInMatrix("0.12.0-rc.2", ["0.12.0-rc.1"])).toBe(false);
  });
});

describe("runPromoteChecks", () => {
  it("passes automated checks but remains fail-closed without production canary evidence", () => {
    const report = runPromoteChecks(readyInput());
    expect(report.ready).toBe(false);
    expect(report.failed).toBe(1);
    expect(statusOf(report, "config")).toBe("pass");
    expect(statusOf(report, "rpc")).toBe("pass");
    expect(statusOf(report, "wallet")).toBe("pass");
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-sdk")).toBe("pass");
    expect(statusOf(report, "rent-exemption")).toBe("warn");
    expect(statusOf(report, "production:checkout-evidence")).toBe("fail");
  });

  it("fails when there is no config at all", () => {
    const report = runPromoteChecks({
      config: null,
      configPath: "/proj/agenc.config.json",
      installedVersions: {},
      walletExists: false,
    });
    expect(report.ready).toBe(false);
    expect(statusOf(report, "config")).toBe("fail");
    const configCheck = report.checks.find((c) => c.id === "config");
    expect(configCheck?.action).toContain("agenc init");
  });

  it("fails an unset or localhost RPC", () => {
    const unset = readyInput();
    unset.config!.rpcUrl = null;
    expect(statusOf(runPromoteChecks(unset), "rpc")).toBe("fail");

    const localhost = readyInput();
    localhost.config!.rpcUrl = "http://127.0.0.1:8899";
    expect(statusOf(runPromoteChecks(localhost), "rpc")).toBe("fail");
  });

  it("rejects dev/local networks, insecure schemes, and URL credentials", () => {
    const devnet = readyInput();
    devnet.config!.network = "devnet";
    expect(statusOf(runPromoteChecks(devnet), "network")).toBe("fail");

    for (const rpcUrl of [
      "http://rpc.example",
      "ftp://rpc.example",
      "https://user:secret@rpc.example",
    ]) {
      const input = readyInput();
      input.config!.rpcUrl = rpcUrl;
      expect(statusOf(runPromoteChecks(input), "rpc")).toBe("fail");
    }
  });

  it("fails closed without mainnet genesis, program, config, and supported surface evidence", () => {
    const missing = readyInput();
    delete missing.chainEvidence;
    const missingReport = runPromoteChecks(missing);
    expect(statusOf(missingReport, "chain:genesis")).toBe("fail");
    expect(statusOf(missingReport, "chain:program")).toBe("fail");
    expect(statusOf(missingReport, "chain:config")).toBe("fail");
    expect(statusOf(missingReport, "chain:surface")).toBe("fail");

    const wrong = readyInput();
    wrong.chainEvidence = {
      ...wrong.chainEvidence!,
      genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      programExecutable: false,
      protocolConfigOwner: "11111111111111111111111111111111",
      protocolPaused: true,
      surfaceRevision: 999,
    };
    const wrongReport = runPromoteChecks(wrong);
    expect(statusOf(wrongReport, "chain:genesis")).toBe("fail");
    expect(statusOf(wrongReport, "chain:program")).toBe("fail");
    expect(statusOf(wrongReport, "chain:config")).toBe("fail");
    expect(statusOf(wrongReport, "chain:surface")).toBe("fail");
  });

  it.each([
    ["programDataAddress", "11111111111111111111111111111111"],
    ["programDataSlot", 1],
    ["upgradeAuthority", "11111111111111111111111111111111"],
    ["executableHash", "00".repeat(32)],
    ["releaseCommit", "0".repeat(40)],
  ])("fails a tampered finalized deployment identity field %s", (field, value) => {
    const input = readyInput();
    input.chainEvidence = { ...input.chainEvidence!, [field]: value };
    expect(statusOf(runPromoteChecks(input), "chain:program")).toBe("fail");
  });

  it("fails a missing wallet, a nonexistent wallet, and a .localnet throwaway", () => {
    const unset = readyInput();
    unset.config!.walletPath = null;
    expect(statusOf(runPromoteChecks(unset), "wallet")).toBe("fail");

    const missing = readyInput();
    missing.walletExists = false;
    expect(statusOf(runPromoteChecks(missing), "wallet")).toBe("fail");

    const throwaway = readyInput();
    throwaway.config!.walletPath = "/repo/.localnet/keys/seeder.json";
    const report = runPromoteChecks(throwaway);
    expect(statusOf(report, "wallet")).toBe("fail");
    expect(report.checks.find((c) => c.id === "wallet")?.detail).toContain("throwaway");
  });

  it("fails an existing wallet that has not passed strict validation", () => {
    const input = readyInput();
    input.walletValidation = {
      valid: false,
      error: "permissions must not grant group or other access",
    };
    const wallet = runPromoteChecks(input).checks.find((check) => check.id === "wallet");
    expect(wallet?.status).toBe("fail");
    expect(wallet?.detail).toContain("permissions");
  });

  it("fails pins outside the VERSIONING.md matrix with the fix command", () => {
    const input = readyInput();
    input.installedVersions["@tetsuo-ai/marketplace-sdk"] = "0.7.1"; // pre-P1.2, fails closed
    const report = runPromoteChecks(input);
    expect(report.ready).toBe(false);
    const pin = report.checks.find((c) => c.id === "pin:@tetsuo-ai/marketplace-sdk");
    expect(pin?.status).toBe("fail");
    expect(pin?.action).toContain("npm install @tetsuo-ai/marketplace-sdk@^0.12.0");
  });

  it("passes published SDK lines and the explicitly unreleased 0.12 candidate", () => {
    // Regression guard: promote must not flag current published minors or its
    // own coordinated source-workspace candidate outside a stale narrow matrix.
    for (const version of [
      "0.8.2",
      "0.9.0",
      "0.9.1",
      "0.10.0",
      "0.10.1",
      "0.11.0",
      "0.12.0",
    ]) {
      const input = readyInput();
      input.installedVersions["@tetsuo-ai/marketplace-sdk"] = version;
      const report = runPromoteChecks(input);
      expect(statusOf(report, "pin:@tetsuo-ai/marketplace-sdk")).toBe("pass");
    }
  });

  it("gives actionable wallet and RPC hints on FAIL lines", () => {
    const input = readyInput();
    input.config!.walletPath = null;
    input.config!.rpcUrl = null;
    const report = runPromoteChecks(input);
    const wallet = report.checks.find((c) => c.id === "wallet");
    expect(wallet?.action).toContain("solana-keygen new");
    const rpc = report.checks.find((c) => c.id === "rpc");
    expect(rpc?.action).toContain("api.mainnet-beta.solana.com");

    const missing = readyInput();
    missing.walletExists = false;
    const missingWallet = runPromoteChecks(missing).checks.find((c) => c.id === "wallet");
    expect(missingWallet?.action).toContain("solana-keygen new");
  });

  it("checks every installed first-party package against the matrix", () => {
    const input = readyInput();
    input.installedVersions["@tetsuo-ai/marketplace-react"] = "0.3.2"; // stale line
    const report = runPromoteChecks(input);
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-react")).toBe("fail");
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-sdk")).toBe("pass");
  });

  it("accepts the coordinated tools and MCP 0.5 candidates", () => {
    const input = readyInput();
    input.installedVersions["@tetsuo-ai/marketplace-tools"] = "0.5.0";
    input.installedVersions["@tetsuo-ai/marketplace-mcp"] = "0.5.0";
    const report = runPromoteChecks(input);
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-tools")).toBe("pass");
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-mcp")).toBe("pass");
  });

  it("fails when the SDK is not installed at all", () => {
    const input = readyInput();
    input.installedVersions = {};
    const report = runPromoteChecks(input);
    expect(statusOf(report, "pin:sdk")).toBe("fail");
  });

  it("does not mistake another support-matrix package for the required SDK", () => {
    const input = readyInput();
    input.installedVersions = {
      "@tetsuo-ai/marketplace-react": "0.4.1",
    };
    const report = runPromoteChecks(input);
    expect(report.ready).toBe(false);
    expect(statusOf(report, "pin:sdk")).toBe("fail");
  });

  it("requires the worker runtime only for worker templates", () => {
    const worker = readyInput();
    worker.config!.kind = "worker";
    expect(statusOf(runPromoteChecks(worker), "pin:worker-runtime")).toBe("fail");

    worker.installedVersions["@tetsuo-ai/agenc-worker"] = "0.2.0";
    expect(statusOf(runPromoteChecks(worker), "pin:worker-runtime")).toBeUndefined();
    expect(runPromoteChecks(worker).ready).toBe(false);
    expect(statusOf(runPromoteChecks(worker), "production:worker-evidence")).toBe("fail");

    const checkout = readyInput();
    expect(statusOf(runPromoteChecks(checkout), "pin:worker-runtime")).toBeUndefined();
  });

  it("reports an invalid config file with its parse error", () => {
    const report = runPromoteChecks({
      config: null,
      configPath: "/proj/agenc.config.json",
      configError: "agenc.config.json: not valid JSON — Unexpected token",
      installedVersions: {},
      walletExists: false,
    });
    const check = report.checks.find((c) => c.id === "config");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("invalid");
  });
});

describe("gatherPromoteInputAsync", () => {
  it("collects context-bound Program/ProgramData/config evidence and rejects an unreviewed image", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-promote-"));
    const wallet = path.join(dir, "wallet.json");
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const generated = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const keypair = new Uint8Array(64);
    keypair.set(seed);
    keypair.set(getBase58Encoder().encode(generated.address), 32);
    writeFileSync(wallet, JSON.stringify(Array.from(keypair)), {
      mode: 0o600,
    });
    chmodSync(wallet, 0o600);
    const config = defaultConfig("production", "checkout");
    config.network = "mainnet-beta";
    config.rpcUrl = "https://rpc.example/";
    config.walletPath = wallet;
    writeFileSync(path.join(dir, "agenc.config.json"), serializeConfig(config));
    mkdirSync(path.join(dir, "node_modules"), { recursive: true });

    const zero = address("11111111111111111111111111111111");
    const configData = getProtocolConfigEncoder().encode({
      authority: zero,
      treasury: zero,
      disputeThreshold: 50,
      protocolFeeBps: 500,
      minArbiterStake: 0n,
      minAgentStake: 0n,
      maxClaimDuration: 1n,
      maxDisputeDuration: 1n,
      totalAgents: 0n,
      totalTasks: 0n,
      completedTasks: 0n,
      totalValueDistributed: 0n,
      bump: 1,
      multisigThreshold: 0,
      multisigOwnersLen: 0,
      taskCreationCooldown: 0n,
      maxTasksPer24h: 1,
      disputeInitiationCooldown: 0n,
      maxDisputesPer24h: 1,
      minStakeForDispute: 0n,
      slashPercentage: 0,
      stateUpdateCooldown: 0n,
      votingPeriod: 1n,
      protocolVersion: 1,
      minSupportedVersion: 1,
      protocolPaused: false,
      disabledTaskTypeMask: 0,
      multisigOwners: [zero, zero, zero, zero, zero],
      surfaceRevision: 4,
    });
    const reviewed = REVIEWED_MAINNET_RELEASES[0];
    const programDataAddressBytes = getBase58Encoder().encode(
      address(reviewed.programDataAddress),
    );
    const upgradeAuthorityBytes = getBase58Encoder().encode(
      address(reviewed.upgradeAuthority),
    );
    const programData = Buffer.alloc(49);
    programData.writeUInt32LE(3, 0);
    programData.writeBigUInt64LE(BigInt(reviewed.programDataSlot), 4);
    programData[12] = 1;
    programData.set(upgradeAuthorityBytes, 13);
    programData.set([1, 2, 3, 4], 45);
    const program = Buffer.alloc(36);
    program.writeUInt32LE(2, 0);
    program.set(programDataAddressBytes, 4);
    const commitments: unknown[] = [];
    const calls: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        method: string;
        params: unknown[];
      };
      calls.push(request.method);
      if (request.method === "getGenesisHash") {
        return new Response(
          JSON.stringify({ result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }),
        );
      }
      if (request.method === "getSlot") {
        commitments.push(request.params[0]);
        return new Response(JSON.stringify({ result: 123_456 }));
      }
      const address = String(request.params[0]);
      commitments.push(request.params[1]);
      const isProgram = address === "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
      const isProgramData = address === reviewed.programDataAddress;
      const bytes = isProgram ? program : isProgramData ? programData : configData;
      return new Response(
        JSON.stringify({
          result: {
            context: { slot: 123_456 },
            value: {
              executable: isProgram,
              owner: isProgram || isProgramData
                ? "BPFLoaderUpgradeab1e11111111111111111111111"
                : "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
              data: [
                Buffer.from(bytes).toString("base64"),
                "base64",
              ],
            },
          },
        }),
      );
    }) as typeof fetch;

    const input = await gatherPromoteInputAsync(dir, {
      fetchImpl,
      rpcUrl: "https://rpc.example/?api-key=injected-secret",
    });
    expect(input.walletValidation).toEqual({
      valid: true,
      address: generated.address,
    });
    expect(input.chainEvidence).toMatchObject({
      genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      finalizedSlot: 123_456,
      programExecutable: true,
      programDataAddress: reviewed.programDataAddress,
      programDataSlot: reviewed.programDataSlot,
      upgradeAuthority: reviewed.upgradeAuthority,
      protocolPaused: false,
      protocolVersion: 1,
      minSupportedVersion: 1,
      surfaceRevision: 4,
    });
    expect(commitments).toEqual([
      { commitment: "finalized" },
      { encoding: "base64", commitment: "finalized", minContextSlot: 123_456 },
      { encoding: "base64", commitment: "finalized", minContextSlot: 123_456 },
      { encoding: "base64", commitment: "finalized", minContextSlot: 123_456 },
    ]);
    expect(calls[0]).toBe("getSlot");
    expect(statusOf(runPromoteChecks(input), "chain:genesis")).toBe("pass");
    expect(statusOf(runPromoteChecks(input), "chain:program")).toBe("fail");
    expect(statusOf(runPromoteChecks(input), "chain:config")).toBe("pass");
    expect(statusOf(runPromoteChecks(input), "chain:surface")).toBe("pass");
  });

  it("derives the signer address and rejects mismatched 64-byte key material", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-promote-wallet-"));
    const wallet = path.join(dir, "wallet.json");
    writeFileSync(wallet, JSON.stringify(Array.from({ length: 64 }, (_, index) => index)), {
      mode: 0o600,
    });
    chmodSync(wallet, 0o600);
    const config = defaultConfig("invalid-wallet", "worker");
    config.walletPath = wallet;
    writeFileSync(path.join(dir, "agenc.config.json"), serializeConfig(config));

    const input = await gatherPromoteInputAsync(dir);
    expect(input.walletValidation?.valid).toBe(false);
    expect(input.walletValidation?.error).toMatch(/private key does not match.*public key/i);
    expect(statusOf(runPromoteChecks(input), "wallet")).toBe("fail");
  });
});
