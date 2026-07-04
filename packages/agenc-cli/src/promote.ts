// `agenc promote` — a READONLY diff against the go-live checklist. It never
// signs, never flips config, never touches money paths; it prints pass/fail
// with the exact next action for each gap.
//
// The version matrix mirrors docs/VERSIONING.md §1.1 (the human-maintained
// source of truth for which published pins speak the live mainnet wire —
// P1.2 hardened open roster, 2026-07-03). Update BOTH on the next lockstep
// republish.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type AgencConfig, AgencConfigError, CONFIG_FILENAME } from "./config.js";

/** docs/VERSIONING.md §1.1 — compatible `major.minor` per package. */
export const SUPPORT_MATRIX: Record<string, string> = {
  "@tetsuo-ai/marketplace-sdk": "0.8",
  "@tetsuo-ai/marketplace-react": "0.4",
  "@tetsuo-ai/marketplace-tools": "0.4",
  "@tetsuo-ai/marketplace-mcp": "0.4",
  "@tetsuo-ai/marketplace-moderation": "0.1",
  "@tetsuo-ai/store-core": "0.5",
};

export type CheckStatus = "pass" | "fail" | "warn";

export interface PromoteCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Exact next action when not passing. */
  action?: string;
}

export interface PromoteInput {
  config: AgencConfig | null;
  configPath: string;
  /** Config-parse failure, when the file exists but is invalid. */
  configError?: string;
  /** Installed `@tetsuo-ai/*` versions (null = not installed). */
  installedVersions: Record<string, string | null>;
  /** Does the configured wallet file exist on disk? */
  walletExists: boolean;
}

export interface PromoteReport {
  checks: PromoteCheck[];
  passed: number;
  failed: number;
  warned: number;
  ready: boolean;
}

function isLoopback(rpcUrl: string): boolean {
  try {
    const { hostname } = new URL(rpcUrl);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

/** `version` is inside the supported `major.minor` line. */
export function versionInMatrix(version: string, majorMinor: string): boolean {
  const match = /^(\d+)\.(\d+)\./u.exec(`${version}.`);
  if (match === null) return false;
  return `${match[1]}.${match[2]}` === majorMinor;
}

/** Pure checklist logic (unit-testable without a filesystem). */
export function runPromoteChecks(input: PromoteInput): PromoteReport {
  const checks: PromoteCheck[] = [];
  const { config } = input;

  // 1) config file
  if (config === null) {
    checks.push({
      id: "config",
      label: "agenc.config.json",
      status: "fail",
      detail:
        input.configError !== undefined
          ? `invalid: ${input.configError}`
          : `not found at ${input.configPath}`,
      action:
        input.configError !== undefined
          ? "fix the JSON (or re-run `agenc init --force`)"
          : "run `agenc init` in the project root first",
    });
  } else {
    checks.push({
      id: "config",
      label: "agenc.config.json",
      status: "pass",
      detail: `${config.name} (${config.kind})`,
    });
  }

  // 2) RPC configured and not localhost
  const rpcUrl = config?.rpcUrl ?? null;
  if (rpcUrl === null || rpcUrl.trim() === "") {
    checks.push({
      id: "rpc",
      label: "production RPC endpoint",
      status: "fail",
      detail: "rpcUrl is not set (the dev sandbox uses localnet automatically)",
      action: `set "rpcUrl" in ${CONFIG_FILENAME} to your mainnet RPC endpoint`,
    });
  } else if (isLoopback(rpcUrl)) {
    checks.push({
      id: "rpc",
      label: "production RPC endpoint",
      status: "fail",
      detail: `rpcUrl points at a local endpoint (${rpcUrl})`,
      action: `set "rpcUrl" in ${CONFIG_FILENAME} to a real mainnet RPC endpoint`,
    });
  } else {
    checks.push({
      id: "rpc",
      label: "production RPC endpoint",
      status: "pass",
      detail: rpcUrl,
    });
  }

  // 3) wallet path set, exists, and not a sandbox throwaway
  const walletPath = config?.walletPath ?? null;
  if (walletPath === null || walletPath.trim() === "") {
    checks.push({
      id: "wallet",
      label: "signer wallet",
      status: "fail",
      detail: "walletPath is not set",
      action: `set "walletPath" in ${CONFIG_FILENAME} to your production keypair (never a .localnet key)`,
    });
  } else if (walletPath.split(path.sep).includes(".localnet")) {
    checks.push({
      id: "wallet",
      label: "signer wallet",
      status: "fail",
      detail: `walletPath is a localnet sandbox throwaway key (${walletPath})`,
      action: "point walletPath at a real, funded production keypair",
    });
  } else if (!input.walletExists) {
    checks.push({
      id: "wallet",
      label: "signer wallet",
      status: "fail",
      detail: `walletPath does not exist: ${walletPath}`,
      action: "create/copy the keypair to that path (or fix the path)",
    });
  } else {
    checks.push({
      id: "wallet",
      label: "signer wallet",
      status: "pass",
      detail: walletPath,
    });
  }

  // 4) installed package pins inside the VERSIONING.md support matrix
  let sawAnyPackage = false;
  for (const [pkg, majorMinor] of Object.entries(SUPPORT_MATRIX)) {
    const version = input.installedVersions[pkg];
    if (version == null) continue; // not a dependency of this project — fine
    sawAnyPackage = true;
    if (versionInMatrix(version, majorMinor)) {
      checks.push({
        id: `pin:${pkg}`,
        label: `${pkg} pin`,
        status: "pass",
        detail: `${version} (matrix: ${majorMinor}.x)`,
      });
    } else {
      checks.push({
        id: `pin:${pkg}`,
        label: `${pkg} pin`,
        status: "fail",
        detail: `${version} is OUTSIDE the supported ${majorMinor}.x line — it fails closed against the live mainnet program`,
        action: `npm install ${pkg}@^${majorMinor}.0 (see agenc-protocol docs/VERSIONING.md §1.1)`,
      });
    }
  }
  if (!sawAnyPackage) {
    checks.push({
      id: "pin:sdk",
      label: "@tetsuo-ai/marketplace-sdk pin",
      status: "fail",
      detail: "@tetsuo-ai/marketplace-sdk is not installed in this project",
      action: "npm install @tetsuo-ai/marketplace-sdk@^0.8.2",
    });
  }

  // 5) fee-leg payees rent exemption (advisory — payees are runtime inputs)
  checks.push({
    id: "rent-exemption",
    label: "fee-leg payees rent-exempt",
    status: "warn",
    detail:
      "settlement fee legs (operator / referrer / treasury) must be rent-exempt " +
      "accounts on mainnet or the settlement transaction fails",
    action:
      "before going live, confirm every operator/referrer payee wallet holds at " +
      "least the rent-exempt minimum (~0.00089 SOL)",
  });

  // 6) receipts / explorer surface
  checks.push({
    id: "receipts",
    label: "settlement receipts",
    status: "pass",
    detail:
      "mainnet settlements get a shareable receipt at https://agenc.ag/receipt/<signature> " +
      "(SDK: settlementReceiptUrl)",
  });

  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  return { checks, passed, failed, warned, ready: failed === 0 };
}

/** Read installed versions from the project's node_modules (readonly). */
export function readInstalledVersions(
  dir: string,
): Record<string, string | null> {
  const versions: Record<string, string | null> = {};
  for (const pkg of Object.keys(SUPPORT_MATRIX)) {
    const pkgJson = path.join(dir, "node_modules", ...pkg.split("/"), "package.json");
    if (!existsSync(pkgJson)) {
      versions[pkg] = null;
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(pkgJson, "utf8")) as {
        version?: unknown;
      };
      versions[pkg] = typeof parsed.version === "string" ? parsed.version : null;
    } catch {
      versions[pkg] = null;
    }
  }
  return versions;
}

/** Gather everything the checklist needs from `dir` (readonly). */
export function gatherPromoteInput(dir: string): PromoteInput {
  const configPath = path.join(dir, CONFIG_FILENAME);
  let config: AgencConfig | null = null;
  let configError: string | undefined;
  try {
    config = loadConfig(dir)?.config ?? null;
  } catch (error) {
    if (error instanceof AgencConfigError) configError = error.message;
    else throw error;
  }
  const walletPath = config?.walletPath ?? null;
  const walletExists =
    walletPath !== null &&
    walletPath.trim() !== "" &&
    existsSync(path.isAbsolute(walletPath) ? walletPath : path.join(dir, walletPath));
  return {
    config,
    configPath,
    ...(configError !== undefined ? { configError } : {}),
    installedVersions: readInstalledVersions(dir),
    walletExists,
  };
}
