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

describe("versionInMatrix", () => {
  it("accepts patch releases inside the line", () => {
    expect(versionInMatrix("0.8.2", "0.8")).toBe(true);
    expect(versionInMatrix("0.8.11", "0.8")).toBe(true);
  });
  it("rejects older and newer lines", () => {
    expect(versionInMatrix("0.7.9", "0.8")).toBe(false);
    expect(versionInMatrix("0.9.0", "0.8")).toBe(false);
    expect(versionInMatrix("1.8.0", "0.8")).toBe(false);
  });
  it("rejects garbage", () => {
    expect(versionInMatrix("not-a-version", "0.8")).toBe(false);
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
    expect(pin?.action).toContain("npm install @tetsuo-ai/marketplace-sdk@^0.8.0");
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
