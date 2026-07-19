// `agenc promote` — a READONLY diff against the go-live checklist. It never
// signs, never flips config, never touches money paths; it prints pass/fail
// with the exact next action for each gap.
//
// The version matrix mirrors docs/VERSIONING.md §1.1 (published/live lines)
// plus §1.1.1 (the explicitly unreleased coordinated candidate set). Update
// both the document and this constant on a candidate bump or lockstep publish.
// A package may have MULTIPLE compatible minor lines when a program upgrade
// was additive (batch-2…4: sdk 0.8.x–0.11.x all speak the live wire; the 0.12
// candidate remains backward-compatible while adding the revision-5 wire).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  address,
  createKeyPairSignerFromBytes,
  getAddressDecoder,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findProtocolConfigPda,
  getProtocolConfigDecoder,
  getProtocolConfigDiscriminatorBytes,
  readSurfaceRevision,
  SURFACE_REVISION_CURRENT,
  SURFACE_REVISION_FULL,
} from "@tetsuo-ai/marketplace-sdk";
import { loadSolanaKeypairFile } from "@tetsuo-ai/agenc-worker";
import { loadConfig, type AgencConfig, AgencConfigError, CONFIG_FILENAME } from "./config.js";

export const SOLANA_MAINNET_GENESIS_HASH =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const AGENC_PROTOCOL_CONFIG_ADDRESS =
  "DeBPkxhzE6MJr66HhEgcHBv5rBFoHWysb6uyK4skufUs";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const MAX_RPC_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Reviewed live deployment identities. Update only with a verified cutover. */
export const REVIEWED_MAINNET_RELEASES = [
  {
    surfaceRevision: 4,
    programDataAddress: "E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw",
    programDataSlot: 431_918_664,
    upgradeAuthority: "Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf",
    executableHash: "c6ddc7fdc19f59bb1fcd2f0c87582e09fc1959ee3e615f299c909e07854b4199",
    sourceCommit: "097ded12b03d27e8c89d50ad6ed8813493700129",
  },
] as const;

/**
 * docs/VERSIONING.md §1.1/§1.1.1 — compatible `major.minor` lines per package,
 * oldest first (the LAST entry is the current line install hints point at).
 */
export const SUPPORT_MATRIX: Record<string, readonly string[]> = {
  "@tetsuo-ai/marketplace-sdk": ["0.8", "0.9", "0.10", "0.11", "0.12"],
  "@tetsuo-ai/agenc-worker": ["0.1", "0.2"],
  "@tetsuo-ai/marketplace-react": ["0.4"],
  "@tetsuo-ai/marketplace-tools": ["0.4", "0.5"],
  "@tetsuo-ai/marketplace-mcp": ["0.4", "0.5"],
  "@tetsuo-ai/marketplace-moderation": ["0.1", "0.2"],
  "@tetsuo-ai/store-core": ["0.5", "0.6"],
};

const SDK_PACKAGE = "@tetsuo-ai/marketplace-sdk";
const WORKER_RUNTIME_PACKAGE = "@tetsuo-ai/agenc-worker";

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
  /** Strict read-only validation of the configured keypair file. */
  walletValidation?: { valid: boolean; address?: string; error?: string };
  /** Finalized, read-only evidence gathered from the configured RPC. */
  chainEvidence?: PromoteChainEvidence;
}

export interface PromoteChainEvidence {
  genesisHash?: string;
  finalizedSlot?: number;
  programExecutable?: boolean;
  programOwner?: string;
  programDataAddress?: string;
  programDataOwner?: string;
  programDataExecutable?: boolean;
  programDataSlot?: number;
  upgradeAuthority?: string;
  executableHash?: string;
  releaseCommit?: string;
  protocolConfigAddress?: string;
  protocolConfigOwner?: string;
  protocolConfigDecoded?: boolean;
  protocolPaused?: boolean;
  protocolVersion?: number;
  minSupportedVersion?: number;
  surfaceRevision?: number;
  error?: string;
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

function productionRpcError(rpcUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return "rpcUrl is not an absolute URL";
  }
  if (url.protocol !== "https:") return "rpcUrl must use HTTPS";
  if (url.username !== "" || url.password !== "") {
    return "rpcUrl must not contain URL credentials";
  }
  if (isLoopback(rpcUrl)) return "rpcUrl points at a loopback endpoint";
  return null;
}

function safeRpcLabel(rpcUrl: string): string {
  try {
    const url = new URL(rpcUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid endpoint";
  }
}

function validWalletAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    address(value);
    return true;
  } catch {
    return false;
  }
}

type CanonicalSemver = {
  major: string;
  minor: string;
  prerelease: string | null;
};

function parseCanonicalSemver(version: string): CanonicalSemver | null {
  // Build metadata is intentionally outside the accepted production policy:
  // two differently built artifacts must not collapse to the same readiness
  // decision. Numeric identifiers are canonical (no leading zeroes).
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(
    version,
  );
  if (match === null) return null;
  const prerelease = match[4] ?? null;
  if (
    prerelease !== null &&
    prerelease
      .split(".")
      .some((identifier) => /^\d+$/u.test(identifier) && !/^(0|[1-9]\d*)$/u.test(identifier))
  ) {
    return null;
  }
  return { major: match[1]!, minor: match[2]!, prerelease };
}

function isCanonicalMinorLine(entry: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(entry);
}

/**
 * Stable versions match an admitted canonical `major.minor` line. A
 * prerelease is rejected unless its full canonical SemVer is listed as an
 * exact matrix entry. Build metadata is always rejected.
 */
export function versionInMatrix(
  version: string,
  entries: readonly string[],
): boolean {
  const parsed = parseCanonicalSemver(version);
  if (parsed === null) return false;
  if (parsed.prerelease !== null) {
    return entries.some(
      (entry) => entry === version && parseCanonicalSemver(entry)?.prerelease !== null,
    );
  }
  return entries.some(
    (entry) =>
      isCanonicalMinorLine(entry) &&
      entry === `${parsed.major}.${parsed.minor}`,
  );
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

  if (config === null || config.network !== "mainnet-beta") {
    checks.push({
      id: "network",
      label: "production network",
      status: "fail",
      detail: config === null ? "network is unavailable" : `network is ${config.network}`,
      action: `set "network" in ${CONFIG_FILENAME} to "mainnet-beta"`,
    });
  } else {
    checks.push({
      id: "network",
      label: "production network",
      status: "pass",
      detail: "mainnet-beta",
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
  } else if (productionRpcError(rpcUrl) !== null) {
    checks.push({
      id: "rpc",
      label: "production RPC endpoint",
      status: "fail",
      detail: productionRpcError(rpcUrl)!,
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
      detail: safeRpcLabel(rpcUrl),
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
  } else if (
    input.walletValidation?.valid !== true ||
    !validWalletAddress(input.walletValidation.address)
  ) {
    checks.push({
      id: "wallet",
      label: "signer wallet",
      status: "fail",
      detail:
        input.walletValidation?.error ??
        "wallet file has not passed strict keypair and filesystem validation",
      action:
        "use an owner-held regular 64-byte Solana keypair JSON file with mode 600",
    });
  } else {
    checks.push({
      id: "wallet",
      label: "signer wallet",
      status: "pass",
      detail: `${walletPath} (${input.walletValidation.address})`,
    });
  }

  const evidence = input.chainEvidence;
  const revision = evidence?.surfaceRevision;
  const reviewedRelease = REVIEWED_MAINNET_RELEASES.find(
    (release) => release.surfaceRevision === revision,
  );
  if (evidence?.genesisHash !== SOLANA_MAINNET_GENESIS_HASH) {
    checks.push({
      id: "chain:genesis",
      label: "finalized mainnet identity",
      status: "fail",
      detail:
        evidence?.error ??
        (evidence?.genesisHash === undefined
          ? "RPC identity was not verified"
          : `unexpected genesis hash ${evidence.genesisHash}`),
      action: "use a healthy Solana mainnet-beta RPC and run `agenc promote` again",
    });
  } else if (
    evidence.finalizedSlot === undefined ||
    !Number.isSafeInteger(evidence.finalizedSlot) ||
    evidence.finalizedSlot <= 0
  ) {
    checks.push({
      id: "chain:genesis",
      label: "finalized mainnet identity",
      status: "fail",
      detail: "RPC did not return a valid finalized slot",
      action: "use a healthy finalized Solana mainnet-beta RPC",
    });
  } else {
    checks.push({
      id: "chain:genesis",
      label: "finalized mainnet identity",
      status: "pass",
      detail: `mainnet-beta at finalized slot ${evidence.finalizedSlot}`,
    });
  }

  if (
    evidence?.programExecutable !== true ||
    evidence.programOwner !== UPGRADEABLE_LOADER ||
    evidence.programDataOwner !== UPGRADEABLE_LOADER ||
    evidence.programDataExecutable !== false ||
    reviewedRelease === undefined ||
    evidence.programDataAddress !== reviewedRelease.programDataAddress ||
    evidence.programDataSlot !== reviewedRelease.programDataSlot ||
    evidence.upgradeAuthority !== reviewedRelease.upgradeAuthority ||
    evidence.executableHash !== reviewedRelease.executableHash ||
    evidence.releaseCommit !== reviewedRelease.sourceCommit
  ) {
    checks.push({
      id: "chain:program",
      label: "AgenC program deployment",
      status: "fail",
      detail:
        evidence?.error ??
        "canonical Program/ProgramData, upgrade authority, executable hash, or reviewed release identity did not match",
      action:
        "verify the finalized canonical AgenC deployment against its reviewed ProgramData hash and release commit",
    });
  } else {
    checks.push({
      id: "chain:program",
      label: "AgenC program deployment",
      status: "pass",
      detail:
        `${AGENC_COORDINATION_PROGRAM_ADDRESS} is executable at reviewed commit ` +
        reviewedRelease.sourceCommit,
    });
  }

  if (
    evidence?.protocolConfigOwner !== AGENC_COORDINATION_PROGRAM_ADDRESS ||
    evidence.protocolConfigAddress !== AGENC_PROTOCOL_CONFIG_ADDRESS ||
    evidence.protocolConfigDecoded !== true ||
    evidence.protocolPaused !== false ||
    evidence.protocolVersion !== 1 ||
    evidence.minSupportedVersion === undefined ||
    evidence.minSupportedVersion > 1
  ) {
    checks.push({
      id: "chain:config",
      label: "ProtocolConfig ownership",
      status: "fail",
      detail:
        "canonical ProtocolConfig is missing, paused, incompatible, malformed, or not program-owned",
      action: "verify the RPC and canonical AgenC program/config deployment",
    });
  } else {
    checks.push({
      id: "chain:config",
      label: "ProtocolConfig ownership",
      status: "pass",
      detail: evidence.protocolConfigAddress,
    });
  }

  if (
    revision === undefined ||
    !Number.isInteger(revision) ||
    revision < SURFACE_REVISION_FULL ||
    revision > SURFACE_REVISION_CURRENT
  ) {
    checks.push({
      id: "chain:surface",
      label: "deployed protocol surface",
      status: "fail",
      detail: `unsupported or unverified surface revision ${revision ?? "unknown"}`,
      action: "use an SDK version compatible with the deployed mainnet surface",
    });
  } else {
    checks.push({
      id: "chain:surface",
      label: "deployed protocol surface",
      status: "pass",
      detail: `surface revision ${revision}`,
    });
  }

  // 4) installed package pins inside the VERSIONING.md support matrix
  for (const [pkg, lines] of Object.entries(SUPPORT_MATRIX)) {
    const version = input.installedVersions[pkg];
    if (version == null) continue; // not a dependency of this project — fine
    const supported = lines
      .map((entry) => (isCanonicalMinorLine(entry) ? `${entry}.x` : entry))
      .join(" / ");
    const current = [...lines].reverse().find(isCanonicalMinorLine);
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
        action:
          current === undefined
            ? `install an explicitly supported ${pkg} version (see agenc-protocol docs/VERSIONING.md §1.1)`
            : `npm install ${pkg}@^${current}.0 (see agenc-protocol docs/VERSIONING.md §1.1)`,
      });
    }
  }
  if (input.installedVersions[SDK_PACKAGE] == null) {
    checks.push({
      id: "pin:sdk",
      label: "@tetsuo-ai/marketplace-sdk pin",
      status: "fail",
      detail: "@tetsuo-ai/marketplace-sdk is not installed in this project",
      action:
        "npm install @tetsuo-ai/marketplace-sdk@^0.12.0 (run it in the project root — `agenc init` scaffolds a package.json when the project has none)",
    });
  }
  if (
    config?.kind === "worker" &&
    input.installedVersions[WORKER_RUNTIME_PACKAGE] == null
  ) {
    checks.push({
      id: "pin:worker-runtime",
      label: "@tetsuo-ai/agenc-worker runtime",
      status: "fail",
      detail:
        "this worker template cannot run because @tetsuo-ai/agenc-worker is not installed in the project",
      action:
        "npm install @tetsuo-ai/agenc-worker@^0.2.0 @tetsuo-ai/marketplace-sdk@^0.12.0",
      });
  }

  // Wire compatibility is broader than the API surface emitted by this CLI.
  // Generated recovery/listing-verification code requires the current SDK line.
  const sdkVersion = input.installedVersions[SDK_PACKAGE];
  if (config !== null && (sdkVersion == null || !versionInMatrix(sdkVersion, ["0.12"]))) {
    checks.push({
      id: "pin:template-sdk",
      label: "generated-template SDK API",
      status: "fail",
      detail: `generated ${config.kind} code requires @tetsuo-ai/marketplace-sdk 0.12.x (installed: ${sdkVersion ?? "missing"})`,
      action: "npm install @tetsuo-ai/marketplace-sdk@^0.12.0 and rebuild the generated surface",
    });
  }
  const workerVersion = input.installedVersions[WORKER_RUNTIME_PACKAGE];
  if (
    config?.kind === "worker" &&
    (workerVersion == null || !versionInMatrix(workerVersion, ["0.2"]))
  ) {
    checks.push({
      id: "pin:template-worker",
      label: "generated-worker runtime API",
      status: "fail",
      detail: `generated worker.mjs requires @tetsuo-ai/agenc-worker 0.2.x (installed: ${workerVersion ?? "missing"})`,
      action: "npm install @tetsuo-ai/agenc-worker@^0.2.0 and rebuild worker.mjs",
    });
  }

  // The generated checkout is intentionally local-only. Until this command can
  // gather durable auth/admission and bounded deployed-route canary evidence, it
  // must never turn that scaffold into a false production-ready green.
  if (config?.kind === "checkout") {
    checks.push({
      id: "production:checkout-evidence",
      label: "production checkout controls",
      status: "fail",
      detail:
        "not evidenced: production authorization, durable atomic idempotency/recovery, total-debit policy, public job-spec readback, reviewed attestor/listing/version binding, and deployed-route bounded canaries",
      action:
        "replace the generated local-only checkout policy, deploy it, run bounded read-only/funded canaries under operator review, and record those controls in your release process",
    });
  } else if (config?.kind === "worker") {
    checks.push({
      id: "production:worker-evidence",
      label: "production worker runtime",
      status: "fail",
      detail:
        "not evidenced: effective RPC/endpoint/task-thread/uploader configuration, durable private state, wallet funding limits, and a bounded deployed worker canary",
      action:
        "validate the effective environment-injected worker config and complete an operator-reviewed bounded canary before launch",
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
  let walletValidation: PromoteInput["walletValidation"];
  if (walletExists && walletPath !== null) {
    const resolved = path.isAbsolute(walletPath) ? walletPath : path.join(dir, walletPath);
    try {
      loadSolanaKeypairFile(resolved);
      walletValidation = {
        valid: false,
        error: "keypair bytes passed parsing but signer address has not been derived",
      };
    } catch (error) {
      walletValidation = { valid: false, error: (error as Error).message };
    }
  }
  return {
    config,
    configPath,
    ...(configError !== undefined ? { configError } : {}),
    installedVersions: readInstalledVersions(dir),
    walletExists,
    ...(walletValidation !== undefined ? { walletValidation } : {}),
  };
}

async function readBoundedRpcResponse(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RPC_RESPONSE_BYTES) {
    throw new Error(`RPC response exceeds ${MAX_RPC_RESPONSE_BYTES} bytes`);
  }
  if (response.body === null) throw new Error("RPC returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RPC_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`RPC response exceeds ${MAX_RPC_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: readonly unknown[],
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`RPC answered HTTP ${response.status}`);
  const envelope = await readBoundedRpcResponse(response);
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("RPC returned an invalid JSON-RPC envelope");
  }
  const record = envelope as Record<string, unknown>;
  if (record.error !== undefined) throw new Error(`RPC ${method} returned an error`);
  if (!("result" in record)) throw new Error(`RPC ${method} omitted result`);
  return record.result;
}

type RawAccount = {
  executable: boolean;
  owner: string;
  data: [string, string];
};

function rawAccount(value: unknown, label: string): RawAccount {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} account is missing`);
  }
  const account = value as Record<string, unknown>;
  if (
    typeof account.executable !== "boolean" ||
    typeof account.owner !== "string" ||
    !Array.isArray(account.data) ||
    account.data.length !== 2 ||
    typeof account.data[0] !== "string" ||
    account.data[1] !== "base64"
  ) {
    throw new Error(`${label} account has an invalid RPC shape`);
  }
  return account as RawAccount;
}

function accountData(account: RawAccount, label: string): Buffer {
  const bytes = Buffer.from(account.data[0], "base64");
  if (bytes.toString("base64") !== account.data[0]) {
    throw new Error(`${label} account data is not canonical base64`);
  }
  return bytes;
}

function contextAccount(
  result: unknown,
  label: string,
  minimumSlot: number,
): RawAccount {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(`${label} RPC result is invalid`);
  }
  const record = result as { context?: unknown; value?: unknown };
  if (
    typeof record.context !== "object" ||
    record.context === null ||
    Array.isArray(record.context)
  ) {
    throw new Error(`${label} RPC result omitted its finalized context`);
  }
  const slot = (record.context as { slot?: unknown }).slot;
  if (!Number.isSafeInteger(slot) || (slot as number) < minimumSlot) {
    throw new Error(
      `${label} RPC context slot is below minContextSlot ${minimumSlot}`,
    );
  }
  return rawAccount(record.value, label);
}

function hashProgramData(data: Buffer): string {
  if (data.length <= 45 || data.readUInt32LE(0) !== 3) {
    throw new Error("ProgramData account has an invalid loader header");
  }
  let end = data.length;
  while (end > 45 && data[end - 1] === 0) end -= 1;
  if (end === 45) throw new Error("ProgramData account contains no executable bytes");
  return createHash("sha256").update(data.subarray(45, end)).digest("hex");
}

/** Gather the sync filesystem checks plus finalized mainnet deployment evidence. */
export async function gatherPromoteInputAsync(
  dir: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; rpcUrl?: string } = {},
): Promise<PromoteInput> {
  const input = gatherPromoteInput(dir);
  const injectedRpcUrl = options.rpcUrl ?? process.env.AGENC_RPC_URL?.trim();
  if (input.config !== null && injectedRpcUrl !== undefined && injectedRpcUrl !== "") {
    input.config = { ...input.config, rpcUrl: injectedRpcUrl };
  }
  const rpcUrl = input.config?.rpcUrl ?? null;
  const walletPath = input.config?.walletPath ?? null;
  if (input.walletExists && walletPath !== null) {
    const resolved = path.isAbsolute(walletPath) ? walletPath : path.join(dir, walletPath);
    try {
      const signer = await createKeyPairSignerFromBytes(
        loadSolanaKeypairFile(resolved),
      );
      input.walletValidation = { valid: true, address: String(signer.address) };
    } catch (error) {
      input.walletValidation = { valid: false, error: (error as Error).message };
    }
  }
  if (
    input.config?.network !== "mainnet-beta" ||
    rpcUrl === null ||
    productionRpcError(rpcUrl) !== null
  ) {
    return input;
  }
  const evidence: PromoteChainEvidence = {};
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 10_000;
    // Establish one finalized lower bound first. Every account request is then
    // pinned with minContextSlot and its returned context is independently
    // checked, preventing a lagging RPC/cache from mixing deployment epochs.
    const finalizedSlot = await rpcCall(
      rpcUrl,
      "getSlot",
      [{ commitment: "finalized" }],
      fetchImpl,
      timeoutMs,
    );
    if (
      typeof finalizedSlot !== "number" ||
      !Number.isSafeInteger(finalizedSlot) ||
      finalizedSlot <= 0
    ) {
      throw new Error("RPC returned an invalid finalized slot");
    }
    const accountConfig = {
      encoding: "base64",
      commitment: "finalized",
      minContextSlot: finalizedSlot,
    } as const;
    const [protocolConfigAddress] = await findProtocolConfigPda();
    const [genesis, programResult, configResult] = await Promise.all([
      rpcCall(rpcUrl, "getGenesisHash", [], fetchImpl, timeoutMs),
      rpcCall(
        rpcUrl,
        "getAccountInfo",
        [AGENC_COORDINATION_PROGRAM_ADDRESS, accountConfig],
        fetchImpl,
        timeoutMs,
      ),
      rpcCall(
        rpcUrl,
        "getAccountInfo",
        [protocolConfigAddress, accountConfig],
        fetchImpl,
        timeoutMs,
      ),
    ]);
    const program = contextAccount(programResult, "program", finalizedSlot);
    const protocolConfig = contextAccount(
      configResult,
      "ProtocolConfig",
      finalizedSlot,
    );
    const programBytes = accountData(program, "program");
    if (
      programBytes.length !== 36 ||
      programBytes.readUInt32LE(0) !== 2
    ) {
      throw new Error("program account is not an upgradeable-loader Program");
    }
    const programDataAddress = String(
      getAddressDecoder().decode(programBytes.subarray(4, 36)),
    );
    const programDataResult = await rpcCall(
      rpcUrl,
      "getAccountInfo",
      [programDataAddress, accountConfig],
      fetchImpl,
      timeoutMs,
    );
    const programData = contextAccount(
      programDataResult,
      "ProgramData",
      finalizedSlot,
    );
    const programDataBytes = accountData(programData, "ProgramData");
    if (programDataBytes.length <= 45 || programDataBytes.readUInt32LE(0) !== 3) {
      throw new Error("ProgramData account has an invalid loader layout");
    }
    const authorityTag = programDataBytes[12];
    if (authorityTag !== 1) {
      throw new Error("ProgramData must retain the reviewed upgrade authority");
    }
    const programDataSlotBigint = programDataBytes.readBigUInt64LE(4);
    if (programDataSlotBigint > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("ProgramData deployment slot is outside the safe integer range");
    }
    const programDataSlot = Number(programDataSlotBigint);
    const upgradeAuthority = String(
      getAddressDecoder().decode(programDataBytes.subarray(13, 45)),
    );
    const executableHash = hashProgramData(programDataBytes);

    const configBuffer = accountData(protocolConfig, "ProtocolConfig");
    const configBytes = Uint8Array.from(configBuffer);
    const discriminator = getProtocolConfigDiscriminatorBytes();
    if (
      discriminator.some((byte, index) => configBytes[index] !== byte)
    ) {
      throw new Error("ProtocolConfig account discriminator is invalid");
    }
    const decodedConfig = getProtocolConfigDecoder().decode(configBytes);
    const surfaceRevision = readSurfaceRevision(configBytes);
    const reviewedRelease = REVIEWED_MAINNET_RELEASES.find(
      (release) =>
        release.surfaceRevision === surfaceRevision &&
        release.programDataAddress === programDataAddress &&
        release.programDataSlot === programDataSlot &&
        release.upgradeAuthority === upgradeAuthority &&
        release.executableHash === executableHash,
    );
    if (String(protocolConfigAddress) !== AGENC_PROTOCOL_CONFIG_ADDRESS) {
      throw new Error("derived ProtocolConfig address does not match this CLI build");
    }
    Object.assign(evidence, {
      genesisHash: typeof genesis === "string" ? genesis : undefined,
      finalizedSlot,
      programExecutable: program.executable,
      programOwner: program.owner,
      programDataAddress,
      programDataOwner: programData.owner,
      programDataExecutable: programData.executable,
      programDataSlot,
      upgradeAuthority,
      executableHash,
      releaseCommit: reviewedRelease?.sourceCommit,
      protocolConfigAddress: String(protocolConfigAddress),
      protocolConfigOwner: protocolConfig.owner,
      protocolConfigDecoded: true,
      protocolPaused: decodedConfig.protocolPaused,
      protocolVersion: decodedConfig.protocolVersion,
      minSupportedVersion: decodedConfig.minSupportedVersion,
      surfaceRevision,
    });
  } catch (error) {
    evidence.error = `RPC verification failed: ${(error as Error).message}`;
  }
  return { ...input, chainEvidence: evidence };
}
