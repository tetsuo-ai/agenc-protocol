import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import {
  runPromoteChecks,
  versionInMatrix,
  type PromoteInput,
} from "../src/promote.js";

function readyInput(): PromoteInput {
  const config = defaultConfig("my-shop", "checkout");
  config.rpcUrl = "https://mainnet.helius-rpc.com/?api-key=x";
  config.walletPath = "/home/user/.config/solana/prod.json";
  return {
    config,
    configPath: "/proj/agenc.config.json",
    installedVersions: {
      "@tetsuo-ai/marketplace-sdk": "0.8.3",
    },
    walletExists: true,
  };
}

function statusOf(report: ReturnType<typeof runPromoteChecks>, id: string) {
  return report.checks.find((c) => c.id === id)?.status;
}

const SDK_LINES = ["0.8", "0.9", "0.10", "0.11"] as const;

describe("versionInMatrix", () => {
  it("accepts patch releases inside any supported line", () => {
    expect(versionInMatrix("0.8.2", SDK_LINES)).toBe(true);
    expect(versionInMatrix("0.8.11", SDK_LINES)).toBe(true);
    expect(versionInMatrix("0.9.0", SDK_LINES)).toBe(true);
    expect(versionInMatrix("0.9.1", SDK_LINES)).toBe(true);
    expect(versionInMatrix("0.10.0", SDK_LINES)).toBe(true);
    expect(versionInMatrix("0.11.0", SDK_LINES)).toBe(true);
  });
  it("rejects older and newer lines", () => {
    expect(versionInMatrix("0.7.9", SDK_LINES)).toBe(false);
    expect(versionInMatrix("0.12.0", SDK_LINES)).toBe(false);
    expect(versionInMatrix("0.9.0", ["0.8"])).toBe(false);
    expect(versionInMatrix("1.8.0", SDK_LINES)).toBe(false);
  });
  it("rejects garbage", () => {
    expect(versionInMatrix("not-a-version", ["0.8"])).toBe(false);
  });
});

describe("runPromoteChecks", () => {
  it("passes a fully-configured project (rent warning stays advisory)", () => {
    const report = runPromoteChecks(readyInput());
    expect(report.ready).toBe(true);
    expect(report.failed).toBe(0);
    expect(statusOf(report, "config")).toBe("pass");
    expect(statusOf(report, "rpc")).toBe("pass");
    expect(statusOf(report, "wallet")).toBe("pass");
    expect(statusOf(report, "pin:@tetsuo-ai/marketplace-sdk")).toBe("pass");
    expect(statusOf(report, "rent-exemption")).toBe("warn");
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

  it("fails pins outside the VERSIONING.md matrix with the fix command", () => {
    const input = readyInput();
    input.installedVersions["@tetsuo-ai/marketplace-sdk"] = "0.7.1"; // pre-P1.2, fails closed
    const report = runPromoteChecks(input);
    expect(report.ready).toBe(false);
    const pin = report.checks.find((c) => c.id === "pin:@tetsuo-ai/marketplace-sdk");
    expect(pin?.status).toBe("fail");
    expect(pin?.action).toContain("npm install @tetsuo-ai/marketplace-sdk@^0.11.0");
  });

  it("passes all supported sdk lines — 0.8.x through 0.11.x speak the live wire", () => {
    // Regression guard: promote must not flag current published minors as
    // outside a stale narrow matrix.
    for (const version of ["0.8.2", "0.9.0", "0.9.1", "0.10.0", "0.10.1", "0.11.0"]) {
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

  it("fails when the SDK is not installed at all", () => {
    const input = readyInput();
    input.installedVersions = {};
    const report = runPromoteChecks(input);
    expect(statusOf(report, "pin:sdk")).toBe("fail");
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
