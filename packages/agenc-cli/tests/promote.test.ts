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
  readInstalledPackageManifests,
  REVIEWED_MAINNET_RELEASES,
  runPromoteChecks,
  versionInMatrix,
  type InstalledPackageManifest,
  type PromoteInput,
} from "../src/promote.js";

type MutableInventory = Record<string, InstalledPackageManifest>;

const SUPPORTED_PACKAGES = [
  "@tetsuo-ai/protocol",
  "@tetsuo-ai/marketplace-sdk",
  "@tetsuo-ai/agenc-worker",
  "@tetsuo-ai/marketplace-react",
  "@tetsuo-ai/marketplace-tools",
  "@tetsuo-ai/marketplace-mcp",
  "@tetsuo-ai/marketplace-moderation",
  "@tetsuo-ai/store-core",
] as const;

type PackageMetadata = {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

// Exact first-party relationships declared by the reviewed published
// revision-4 artifacts and the local revision-5 candidate manifests.
const PACKAGE_METADATA: Record<string, PackageMetadata> = {
  "@tetsuo-ai/agenc-worker@0.1.1": {
    dependencies: {
      "@tetsuo-ai/marketplace-sdk": "^0.8.2 || ^0.9.0",
    },
  },
  "@tetsuo-ai/marketplace-react@0.4.1": {
    peerDependencies: { "@tetsuo-ai/marketplace-sdk": "^0.8.0" },
  },
  "@tetsuo-ai/marketplace-tools@0.4.0": {
    dependencies: { "@tetsuo-ai/marketplace-sdk": "^0.8.0" },
  },
  "@tetsuo-ai/marketplace-mcp@0.4.0": {
    dependencies: {
      "@tetsuo-ai/marketplace-sdk": "^0.8.0",
      "@tetsuo-ai/marketplace-tools": "^0.4.0",
    },
  },
  "@tetsuo-ai/store-core@0.6.0": {
    peerDependencies: {
      "@tetsuo-ai/marketplace-sdk": "^0.8.0",
      "@tetsuo-ai/marketplace-react": "^0.4.0",
    },
  },
  "@tetsuo-ai/agenc-worker@0.2.0": {
    dependencies: { "@tetsuo-ai/marketplace-sdk": "^0.12.0" },
  },
  "@tetsuo-ai/marketplace-react@0.5.0": {
    peerDependencies: { "@tetsuo-ai/marketplace-sdk": "^0.12.0" },
  },
  "@tetsuo-ai/marketplace-tools@0.5.0": {
    dependencies: { "@tetsuo-ai/marketplace-sdk": "^0.12.0" },
  },
  "@tetsuo-ai/marketplace-mcp@0.5.0": {
    dependencies: {
      "@tetsuo-ai/marketplace-sdk": "^0.12.0",
      "@tetsuo-ai/marketplace-tools": "^0.5.0",
    },
  },
  "@tetsuo-ai/store-core@0.6.1": {
    peerDependencies: {
      "@tetsuo-ai/marketplace-sdk": "^0.12.0",
      "@tetsuo-ai/marketplace-react": "^0.5.0",
    },
  },
};

function emptyInventory(root = "/proj"): MutableInventory {
  return Object.fromEntries(
    SUPPORTED_PACKAGES.map((pkg) => [
      pkg,
      {
        status: "absent" as const,
        path: path.join(
          root,
          "node_modules",
          ...pkg.split("/"),
          "package.json",
        ),
      },
    ]),
  );
}

function installedManifest(
  pkg: string,
  version: string,
  metadata: PackageMetadata = PACKAGE_METADATA[`${pkg}@${version}`] ?? {},
): InstalledPackageManifest {
  return {
    status: "present",
    path: path.join("/proj/node_modules", ...pkg.split("/"), "package.json"),
    version,
    dependencies: metadata.dependencies ?? {},
    peerDependencies: metadata.peerDependencies ?? {},
    optionalPeerDependencies: [],
  };
}

function setInstalled(
  input: PromoteInput,
  pkg: string,
  version: string | null,
  metadata?: PackageMetadata,
): void {
  input.installedVersions[pkg] = version;
  const inventory = input.installedPackages as MutableInventory;
  inventory[pkg] =
    version === null
      ? {
          status: "absent",
          path: path.join(
            "/proj/node_modules",
            ...pkg.split("/"),
            "package.json",
          ),
        }
      : installedManifest(pkg, version, metadata);
}

function setInstalledTrain(
  input: PromoteInput,
  versions: Readonly<Record<string, string>>,
): void {
  input.installedVersions = {};
  input.installedPackages = emptyInventory();
  for (const [pkg, version] of Object.entries(versions)) {
    setInstalled(input, pkg, version);
  }
}

function readyInput(): PromoteInput {
  const reviewed = REVIEWED_MAINNET_RELEASES[0];
  const config = defaultConfig("my-shop", "checkout");
  config.network = "mainnet-beta";
  config.rpcUrl = "https://mainnet.helius-rpc.com/";
  config.walletPath = "/home/user/.config/solana/prod.json";
  const installedPackages = emptyInventory();
  installedPackages["@tetsuo-ai/marketplace-sdk"] = installedManifest(
    "@tetsuo-ai/marketplace-sdk",
    "0.11.0",
  );
  return {
    config,
    configPath: "/proj/agenc.config.json",
    installedVersions: {
      "@tetsuo-ai/marketplace-sdk": "0.11.0",
    },
    installedPackages,
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

const REVISION_4_CLIENTS = {
  "@tetsuo-ai/protocol": "0.3.0",
  "@tetsuo-ai/marketplace-sdk": "0.8.2",
  "@tetsuo-ai/agenc-worker": "0.1.1",
  "@tetsuo-ai/marketplace-react": "0.4.1",
  "@tetsuo-ai/marketplace-tools": "0.4.0",
  "@tetsuo-ai/marketplace-mcp": "0.4.0",
  "@tetsuo-ai/marketplace-moderation": "0.1.0",
  "@tetsuo-ai/store-core": "0.6.0",
} as const;

const REVISION_5_CLIENTS = {
  "@tetsuo-ai/protocol": "0.4.0",
  "@tetsuo-ai/marketplace-sdk": "0.12.0",
  "@tetsuo-ai/agenc-worker": "0.2.0",
  "@tetsuo-ai/marketplace-react": "0.5.0",
  "@tetsuo-ai/marketplace-tools": "0.5.0",
  "@tetsuo-ai/marketplace-mcp": "0.5.0",
  "@tetsuo-ai/marketplace-moderation": "0.2.0",
  "@tetsuo-ai/store-core": "0.6.1",
} as const;

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
  ])(
    "rejects non-canonical, metadata-bearing, or unadmitted version %s",
    (version) => {
      expect(versionInMatrix(version, ["0.8"])).toBe(false);
    },
  );

  it("admits a prerelease only through an exact matrix entry", () => {
    expect(versionInMatrix("0.12.0-rc.1", ["0.12"])).toBe(false);
    expect(versionInMatrix("0.12.0-rc.1", ["0.12.0-rc.1"])).toBe(true);
    expect(versionInMatrix("0.12.0-rc.2", ["0.12.0-rc.1"])).toBe(false);
  });

  it("can distinguish exact stable releases inside one pre-1.0 minor", () => {
    expect(versionInMatrix("0.6.0", ["0.6.0"])).toBe(true);
    expect(versionInMatrix("0.6.1", ["0.6.0"])).toBe(false);
    expect(versionInMatrix("0.6.0", ["0.6.1"])).toBe(false);
  });
});

describe("runPromoteChecks", () => {
  it("accepts the published revision-4 SDK pin but gates this revision-5 CLI template", () => {
    const report = runPromoteChecks(readyInput());
    expect(report.ready).toBe(false);
    expect(report.failed).toBe(2);
    expect(statusOf(report, "config")).toBe("pass");
    expect(statusOf(report, "rpc")).toBe("pass");
    expect(statusOf(report, "wallet")).toBe("pass");
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-sdk")).toBe("pass");
    expect(statusOf(report, "pin:template-sdk")).toBe("fail");
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
  ])(
    "fails a tampered finalized deployment identity field %s",
    (field, value) => {
      const input = readyInput();
      input.chainEvidence = { ...input.chainEvidence!, [field]: value };
      expect(statusOf(runPromoteChecks(input), "chain:program")).toBe("fail");
    },
  );

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
    expect(report.checks.find((c) => c.id === "wallet")?.detail).toContain(
      "throwaway",
    );
  });

  it("fails an existing wallet that has not passed strict validation", () => {
    const input = readyInput();
    input.walletValidation = {
      valid: false,
      error: "permissions must not grant group or other access",
    };
    const wallet = runPromoteChecks(input).checks.find(
      (check) => check.id === "wallet",
    );
    expect(wallet?.status).toBe("fail");
    expect(wallet?.detail).toContain("permissions");
  });

  it("fails pins outside the VERSIONING.md matrix with the fix command", () => {
    const input = readyInput();
    setInstalled(input, "@tetsuo-ai/marketplace-sdk", "0.7.1"); // pre-P1.2, fails closed
    const report = runPromoteChecks(input);
    expect(report.ready).toBe(false);
    const pin = report.checks.find(
      (c) => c.id === "pin:@tetsuo-ai/marketplace-sdk",
    );
    expect(pin?.status).toBe("fail");
    expect(pin?.action).toContain(
      "npm install @tetsuo-ai/marketplace-sdk@^0.11.0",
    );
  });

  it("passes every published SDK line on revision 4", () => {
    for (const version of [
      "0.8.2",
      "0.9.0",
      "0.9.1",
      "0.10.0",
      "0.10.1",
      "0.11.0",
    ]) {
      const input = readyInput();
      setInstalled(input, "@tetsuo-ai/marketplace-sdk", version);
      const report = runPromoteChecks(input);
      expect(statusOf(report, "pin:@tetsuo-ai/marketplace-sdk")).toBe("pass");
    }
  });

  it("passes the complete published revision-4 client set", () => {
    const input = readyInput();
    setInstalledTrain(input, REVISION_4_CLIENTS);
    const report = runPromoteChecks(input);
    for (const pkg of Object.keys(REVISION_4_CLIENTS)) {
      expect(statusOf(report, `pin:${pkg}`), pkg).toBe("pass");
    }
    expect(
      report.checks
        .filter((check) => check.id.startsWith("coherence:"))
        .every((check) => check.status === "pass"),
    ).toBe(true);
  });

  it("rejects a revision-4 package set whose individually admitted versions have incoherent published ranges", () => {
    const input = readyInput();
    setInstalledTrain(input, REVISION_4_CLIENTS);
    // SDK 0.11 speaks the revision-4 wire, but the published React 0.4.1,
    // tools 0.4.0, MCP 0.4.0, worker 0.1.1, and store-core 0.6.0
    // manifests do not declare it inside their own ranges.
    setInstalled(input, "@tetsuo-ai/marketplace-sdk", "0.11.0");
    const report = runPromoteChecks(input);
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-sdk")).toBe("pass");
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-react")).toBe("pass");
    expect(
      statusOf(
        report,
        "coherence:@tetsuo-ai/marketplace-react->@tetsuo-ai/marketplace-sdk",
      ),
    ).toBe("fail");
    expect(
      statusOf(
        report,
        "coherence:@tetsuo-ai/agenc-worker->@tetsuo-ai/marketplace-sdk",
      ),
    ).toBe("fail");
    expect(report.ready).toBe(false);
  });

  it("rejects every revision-5 client line against revision 4", () => {
    const input = readyInput();
    setInstalledTrain(input, REVISION_5_CLIENTS);
    const report = runPromoteChecks(input);
    for (const pkg of Object.keys(REVISION_5_CLIENTS)) {
      expect(statusOf(report, `pin:${pkg}`), pkg).toBe("fail");
    }
  });

  it("passes the coordinated revision-5 client set", () => {
    const input = readyInput();
    input.chainEvidence!.surfaceRevision = 5;
    setInstalledTrain(input, REVISION_5_CLIENTS);
    const report = runPromoteChecks(input);
    for (const pkg of Object.keys(REVISION_5_CLIENTS)) {
      expect(statusOf(report, `pin:${pkg}`), pkg).toBe("pass");
    }
    expect(
      report.checks
        .filter((check) => check.id.startsWith("coherence:"))
        .every((check) => check.status === "pass"),
    ).toBe(true);
    // Surface revision alone is never enough: the actual post-upgrade
    // ProgramData identity is intentionally absent until it can be captured.
    expect(statusOf(report, "chain:program")).toBe("fail");
  });

  it("rejects an actual revision-4 peer range paired with the revision-5 SDK", () => {
    const input = readyInput();
    input.chainEvidence!.surfaceRevision = 5;
    setInstalledTrain(input, {
      "@tetsuo-ai/marketplace-sdk": "0.12.0",
      "@tetsuo-ai/marketplace-react": "0.4.1",
    });
    const report = runPromoteChecks(input);
    expect(
      statusOf(
        report,
        "coherence:@tetsuo-ai/marketplace-react->@tetsuo-ai/marketplace-sdk",
      ),
    ).toBe("fail");
  });

  it("rejects every revision-4 client line against revision 5", () => {
    const input = readyInput();
    input.chainEvidence!.surfaceRevision = 5;
    setInstalledTrain(input, REVISION_4_CLIENTS);
    const report = runPromoteChecks(input);
    for (const pkg of Object.keys(REVISION_4_CLIENTS)) {
      expect(statusOf(report, `pin:${pkg}`), pkg).toBe("fail");
    }
  });

  it("fails every installed pin closed for an unknown surface revision", () => {
    const input = readyInput();
    input.chainEvidence!.surfaceRevision = 7;
    setInstalledTrain(input, REVISION_5_CLIENTS);
    const report = runPromoteChecks(input);
    expect(statusOf(report, "chain:surface")).toBe("fail");
    for (const pkg of Object.keys(REVISION_5_CLIENTS)) {
      expect(statusOf(report, `pin:${pkg}`), pkg).toBe("fail");
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
    const missingWallet = runPromoteChecks(missing).checks.find(
      (c) => c.id === "wallet",
    );
    expect(missingWallet?.action).toContain("solana-keygen new");
  });

  it("checks every installed first-party package against the matrix", () => {
    const input = readyInput();
    setInstalled(input, "@tetsuo-ai/marketplace-react", "0.3.2", {
      peerDependencies: { "@tetsuo-ai/marketplace-sdk": "^0.8.0" },
    }); // stale line
    const report = runPromoteChecks(input);
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-react")).toBe("fail");
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-sdk")).toBe("pass");
  });

  it("fails when a material first-party relationship is missing or malformed", () => {
    const missing = readyInput();
    setInstalled(missing, "@tetsuo-ai/marketplace-react", "0.4.1", {});
    expect(
      statusOf(
        runPromoteChecks(missing),
        "coherence:@tetsuo-ai/marketplace-react->@tetsuo-ai/marketplace-sdk",
      ),
    ).toBe("fail");

    const malformed = readyInput();
    setInstalled(malformed, "@tetsuo-ai/marketplace-react", "0.4.1", {
      peerDependencies: {
        "@tetsuo-ai/marketplace-sdk": "definitely-not-semver",
      },
    });
    expect(
      runPromoteChecks(malformed).checks.find((check) =>
        check.id.startsWith("coherence:@tetsuo-ai/marketplace-react"),
      )?.detail,
    ).toContain("malformed");
  });

  it("accepts the coordinated tools and MCP 0.5 candidates", () => {
    const input = readyInput();
    input.chainEvidence!.surfaceRevision = 5;
    setInstalled(input, "@tetsuo-ai/marketplace-sdk", "0.12.0");
    setInstalled(input, "@tetsuo-ai/marketplace-tools", "0.5.0");
    setInstalled(input, "@tetsuo-ai/marketplace-mcp", "0.5.0");
    const report = runPromoteChecks(input);
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-tools")).toBe("pass");
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-mcp")).toBe("pass");
  });

  it("fails when the SDK is not installed at all", () => {
    const input = readyInput();
    setInstalledTrain(input, {});
    const report = runPromoteChecks(input);
    expect(statusOf(report, "pin:sdk")).toBe("fail");
  });

  it("does not mistake another support-matrix package for the required SDK", () => {
    const input = readyInput();
    setInstalledTrain(input, {
      "@tetsuo-ai/marketplace-react": "0.4.1",
    });
    const report = runPromoteChecks(input);
    expect(report.ready).toBe(false);
    expect(statusOf(report, "pin:sdk")).toBe("fail");
  });

  it("requires the worker runtime only for worker templates", () => {
    const worker = readyInput();
    worker.config!.kind = "worker";
    expect(statusOf(runPromoteChecks(worker), "pin:worker-runtime")).toBe(
      "fail",
    );

    setInstalled(worker, "@tetsuo-ai/agenc-worker", "0.1.1");
    expect(
      statusOf(runPromoteChecks(worker), "pin:worker-runtime"),
    ).toBeUndefined();
    expect(runPromoteChecks(worker).ready).toBe(false);
    expect(
      statusOf(runPromoteChecks(worker), "production:worker-evidence"),
    ).toBe("fail");

    const checkout = readyInput();
    expect(
      statusOf(runPromoteChecks(checkout), "pin:worker-runtime"),
    ).toBeUndefined();
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

describe("readInstalledPackageManifests", () => {
  function packageJsonPath(dir: string, pkg: string): string {
    const file = path.join(
      dir,
      "node_modules",
      ...pkg.split("/"),
      "package.json",
    );
    mkdirSync(path.dirname(file), { recursive: true });
    return file;
  }

  it("distinguishes a truly absent optional package from a present manifest with no version", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-promote-manifest-"));
    const sdkFile = packageJsonPath(dir, "@tetsuo-ai/marketplace-sdk");
    writeFileSync(
      sdkFile,
      JSON.stringify({ name: "@tetsuo-ai/marketplace-sdk" }),
    );
    const inventory = readInstalledPackageManifests(dir);
    expect(inventory["@tetsuo-ai/marketplace-sdk"]).toMatchObject({
      status: "invalid",
      error: expect.stringContaining("version"),
    });
    expect(inventory["@tetsuo-ai/marketplace-react"]).toMatchObject({
      status: "absent",
    });

    const input = readyInput();
    input.installedPackages = inventory;
    input.installedVersions = Object.fromEntries(
      Object.keys(inventory).map((pkg) => [pkg, null]),
    );
    expect(
      statusOf(runPromoteChecks(input), "manifest:@tetsuo-ai/marketplace-sdk"),
    ).toBe("fail");
    expect(
      statusOf(
        runPromoteChecks(input),
        "manifest:@tetsuo-ai/marketplace-react",
      ),
    ).toBeUndefined();
  });

  it("fails closed when an installed package directory has no manifest", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-promote-manifest-"));
    mkdirSync(path.join(dir, "node_modules", "@tetsuo-ai", "marketplace-sdk"), {
      recursive: true,
    });

    expect(
      readInstalledPackageManifests(dir)["@tetsuo-ai/marketplace-sdk"],
    ).toMatchObject({
      status: "invalid",
      error: expect.stringContaining("ENOENT"),
    });
  });

  it("reads the effective hoisted package manifest used by a workspace child", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agenc-promote-workspace-"));
    const project = path.join(root, "packages", "shop");
    const manifest = packageJsonPath(root, "@tetsuo-ai/marketplace-sdk");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      manifest,
      JSON.stringify({
        name: "@tetsuo-ai/marketplace-sdk",
        version: "0.12.0",
      }),
    );

    expect(
      readInstalledPackageManifests(project)["@tetsuo-ai/marketplace-sdk"],
    ).toMatchObject({
      status: "present",
      version: "0.12.0",
      path: manifest,
    });
  });

  it("fails closed when the legacy version view contradicts manifest absence", () => {
    const input = readyInput();
    input.installedVersions["@tetsuo-ai/marketplace-react"] = "0.4.1";

    expect(
      runPromoteChecks(input).checks.find(
        (check) => check.id === "manifest:@tetsuo-ai/marketplace-react",
      ),
    ).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("manifest is absent"),
    });
  });

  it("fails closed for malformed and non-file installed manifests", () => {
    const malformedDir = mkdtempSync(
      path.join(tmpdir(), "agenc-promote-manifest-"),
    );
    writeFileSync(
      packageJsonPath(malformedDir, "@tetsuo-ai/marketplace-sdk"),
      "{not-json",
    );
    expect(
      readInstalledPackageManifests(malformedDir)["@tetsuo-ai/marketplace-sdk"],
    ).toMatchObject({ status: "invalid" });

    const nonFileDir = mkdtempSync(
      path.join(tmpdir(), "agenc-promote-manifest-"),
    );
    const manifestPath = packageJsonPath(
      nonFileDir,
      "@tetsuo-ai/marketplace-sdk",
    );
    mkdirSync(manifestPath);
    expect(
      readInstalledPackageManifests(nonFileDir)["@tetsuo-ai/marketplace-sdk"],
    ).toMatchObject({
      status: "invalid",
      error: expect.stringContaining("regular file"),
    });
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
          JSON.stringify({
            result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
          }),
        );
      }
      if (request.method === "getSlot") {
        commitments.push(request.params[0]);
        return new Response(JSON.stringify({ result: 123_456 }));
      }
      const address = String(request.params[0]);
      commitments.push(request.params[1]);
      const isProgram =
        address === "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
      const isProgramData = address === reviewed.programDataAddress;
      const bytes = isProgram
        ? program
        : isProgramData
          ? programData
          : configData;
      return new Response(
        JSON.stringify({
          result: {
            context: { slot: 123_456 },
            value: {
              executable: isProgram,
              owner:
                isProgram || isProgramData
                  ? "BPFLoaderUpgradeab1e11111111111111111111111"
                  : "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
              data: [Buffer.from(bytes).toString("base64"), "base64"],
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
    writeFileSync(
      wallet,
      JSON.stringify(Array.from({ length: 64 }, (_, index) => index)),
      {
        mode: 0o600,
      },
    );
    chmodSync(wallet, 0o600);
    const config = defaultConfig("invalid-wallet", "worker");
    config.walletPath = wallet;
    writeFileSync(path.join(dir, "agenc.config.json"), serializeConfig(config));

    const input = await gatherPromoteInputAsync(dir);
    expect(input.walletValidation?.valid).toBe(false);
    expect(input.walletValidation?.error).toMatch(
      /private key does not match.*public key/i,
    );
    expect(statusOf(runPromoteChecks(input), "wallet")).toBe("fail");
  });
});
