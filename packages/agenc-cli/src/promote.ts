// `agenc promote` — a READONLY diff against the go-live checklist. It never
// signs, never flips config, never touches money paths; it prints pass/fail
// with the exact next action for each gap.
//
// The version matrix mirrors docs/VERSIONING.md §1.1 (the human-maintained
// source of truth for which published pins speak the live mainnet wire —
// P1.2 wire + additive batch-2, 2026-07-05). Update BOTH on the next
// lockstep republish. A package may have MULTIPLE compatible minor lines
// when a program upgrade was additive (batch-2…4: sdk 0.8.x–0.11.x all
// speak the live wire).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type AgencConfig, AgencConfigError, CONFIG_FILENAME } from "./config.js";

/**
 * docs/VERSIONING.md §1.1 — compatible `major.minor` lines per package,
 * oldest first (the LAST entry is the current line install hints point at).
 */
export const SUPPORT_MATRIX: Record<string, readonly string[]> = {
  "@tetsuo-ai/marketplace-sdk": ["0.8", "0.9", "0.10", "0.11"],
  "@tetsuo-ai/marketplace-react": ["0.4"],
  "@tetsuo-ai/marketplace-tools": ["0.4"],
  "@tetsuo-ai/marketplace-mcp": ["0.4"],
  "@tetsuo-ai/marketplace-moderation": ["0.1"],
  "@tetsuo-ai/store-core": ["0.5", "0.6"],
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

/** `version` is inside one of the supported `major.minor` lines. */
export function versionInMatrix(
  version: string,
  lines: readonly string[],
): boolean {
  const match = /^(\d+)\.(\d+)\./u.exec(`${version}.`);
  if (match === null) return false;
  return lines.includes(`${match[1]}.${match[2]}`);
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
      action:
        `set "rpcUrl" in ${CONFIG_FILENAME} to your mainnet RPC endpoint — ` +
        "https://api.mainnet-beta.solana.com works to start (rate-limited; development only); " +
        "use a dedicated provider (Helius / Triton / QuickNode class) for production traffic",
    });
  } else if (isLoopback(rpcUrl)) {
    checks.push({
      id: "rpc",
      label: "production RPC endpoint",
      status: "fail",
      detail: `rpcUrl points at a local endpoint (${rpcUrl})`,
      action:
        `set "rpcUrl" in ${CONFIG_FILENAME} to a real mainnet RPC endpoint — ` +
        "https://api.mainnet-beta.solana.com works to start (rate-limited; development only); " +
        "use a dedicated provider (Helius / Triton / QuickNode class) for production traffic",
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
      action:
        `set "walletPath" in ${CONFIG_FILENAME} to your production keypair (never a .localnet key) — ` +
        "no wallet yet? `solana-keygen new --outfile ~/.config/solana/agenc-mainnet.json`, " +
        "then fund it with SOL before going live",
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
      action:
        "create/copy the keypair to that path (or fix the path) — " +
        `\`solana-keygen new --outfile ${walletPath}\` creates one; fund it with SOL before going live`,
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
  for (const [pkg, lines] of Object.entries(SUPPORT_MATRIX)) {
    const version = input.installedVersions[pkg];
    if (version == null) continue; // not a dependency of this project — fine
    sawAnyPackage = true;
    const supported = lines.map((line) => `${line}.x`).join(" / ");
    const current = lines[lines.length - 1];
    if (versionInMatrix(version, lines)) {
      checks.push({
        id: `pin:${pkg}`,
        label: `${pkg} pin`,
        status: "pass",
        detail: `${version} (matrix: ${supported})`,
      });
    } else {
      checks.push({
        id: `pin:${pkg}`,
        label: `${pkg} pin`,
        status: "fail",
        detail: `${version} is OUTSIDE the supported ${supported} lines — it fails closed against the live mainnet program`,
        action: `npm install ${pkg}@^${current}.0 (see agenc-protocol docs/VERSIONING.md §1.1)`,
      });
    }
  }
  if (!sawAnyPackage) {
    checks.push({
      id: "pin:sdk",
      label: "@tetsuo-ai/marketplace-sdk pin",
      status: "fail",
      detail: "@tetsuo-ai/marketplace-sdk is not installed in this project",
      action:
        "npm install @tetsuo-ai/marketplace-sdk@^0.11.0 (run it in the project root — `agenc init` scaffolds a package.json when the project has none)",
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
