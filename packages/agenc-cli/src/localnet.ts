// Localnet sandbox discovery/health for `agenc dev` — the WP-D4 stack is the
// blessed dev bed (`scripts/localnet-up.mjs` + `.localnet/env.json`).
// `agenc dev` NEVER touches mainnet/devnet: the resolved endpoint must be a
// loopback URL and the env file must say cluster=localnet.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ReadonlyUint8Array } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findBidMarketplacePda,
  findModerationConfigPda,
  findProtocolConfigPda,
  getBidMarketplaceConfigDecoder,
  getBidMarketplaceConfigDiscriminatorBytes,
  getBidMarketplaceConfigSize,
  getModerationConfigDecoder,
  getModerationConfigDiscriminatorBytes,
  getModerationConfigSize,
  getProtocolConfigDecoder,
  getProtocolConfigDiscriminatorBytes,
  getProtocolConfigSize,
  SURFACE_REVISION_CURRENT,
  type BidMarketplaceConfig,
  type ModerationConfig,
  type ProtocolConfig,
} from "@tetsuo-ai/marketplace-sdk";

const LOCALNET_PROGRAM_DESCRIPTOR_PATH = "/proc/self/fd/5";
const LOCALNET_PROGRAM_LOAD_METHOD = "private-unlinked-fd-v1";

/** The subset of `.localnet/env.json` `agenc dev` consumes. */
export interface LocalnetEnv {
  cluster: string;
  rpcUrl: string;
  rpcSubscriptionsUrl?: string;
  programId: string;
  programSha256?: string;
  programSize?: number;
  keypairs?: { authority?: string; moderator?: string; seeder?: string } | null;
  /** Where the env file was found. */
  envPath: string;
  /** The agenc-protocol repo root the stack belongs to. */
  repoRoot: string;
}

export class LocalnetError extends Error {
  override name = "LocalnetError";
}

export interface ValidatorPidRecord {
  schemaVersion: 2;
  role: "validator";
  pid: number;
  uid: number;
  processStartTicks: string;
  executable: string;
  cwd: string;
  argvSha256: string;
  recordedAt: string;
  rpcPort: number;
  programSha256: string;
  programSize: number;
  programLoadMethod: typeof LOCALNET_PROGRAM_LOAD_METHOD;
}

export interface ValidatorProcessObservation {
  uid: number;
  executable: string;
  argv: string[];
  cwd: string;
  processStartTicks: string;
  argvSha256: string;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalnetError("validator.pid must contain a JSON object");
  }
  return value as Record<string, unknown>;
}

/** Parse the exact identity record emitted by localnet-up.mjs. */
export function parseValidatorPidRecord(
  body: string,
  pidFile = "validator.pid",
): ValidatorPidRecord {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new LocalnetError(
      `${pidFile}: invalid JSON (${(error as Error).message})`,
    );
  }
  const parsed = record(value);
  const expected = [
    "schemaVersion",
    "role",
    "pid",
    "uid",
    "processStartTicks",
    "executable",
    "cwd",
    "argvSha256",
    "recordedAt",
    "rpcPort",
    "programSha256",
    "programSize",
    "programLoadMethod",
  ];
  const unknown = Object.keys(parsed).find((key) => !expected.includes(key));
  if (unknown !== undefined || expected.some((key) => !(key in parsed))) {
    throw new LocalnetError(
      `${pidFile}: invalid or unsupported identity record`,
    );
  }
  if (
    parsed.schemaVersion !== 2 ||
    parsed.role !== "validator" ||
    !Number.isSafeInteger(parsed.pid) ||
    (parsed.pid as number) <= 1 ||
    !Number.isSafeInteger(parsed.uid) ||
    (parsed.uid as number) < 0 ||
    typeof parsed.processStartTicks !== "string" ||
    !/^[1-9][0-9]*$/u.test(parsed.processStartTicks) ||
    typeof parsed.executable !== "string" ||
    !path.isAbsolute(parsed.executable) ||
    typeof parsed.cwd !== "string" ||
    !path.isAbsolute(parsed.cwd) ||
    typeof parsed.argvSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.argvSha256)
  ) {
    throw new LocalnetError(`${pidFile}: malformed exact process identity`);
  }
  if (
    !Number.isSafeInteger(parsed.rpcPort) ||
    (parsed.rpcPort as number) < 1 ||
    (parsed.rpcPort as number) > 65_535
  ) {
    throw new LocalnetError(`${pidFile}: rpcPort is invalid`);
  }
  if (
    typeof parsed.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.recordedAt)) ||
    new Date(Date.parse(parsed.recordedAt)).toISOString() !== parsed.recordedAt
  ) {
    throw new LocalnetError(
      `${pidFile}: recordedAt is not a canonical timestamp`,
    );
  }
  if (
    typeof parsed.programSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.programSha256)
  ) {
    throw new LocalnetError(`${pidFile}: programSha256 is invalid`);
  }
  if (
    !Number.isSafeInteger(parsed.programSize) ||
    (parsed.programSize as number) <= 0
  ) {
    throw new LocalnetError(`${pidFile}: programSize is invalid`);
  }
  if (parsed.programLoadMethod !== LOCALNET_PROGRAM_LOAD_METHOD) {
    throw new LocalnetError(`${pidFile}: programLoadMethod is invalid`);
  }
  return parsed as unknown as ValidatorPidRecord;
}

/**
 * Pure fd-bound record checks for callers that inspect localnet state.
 * This is not sufficient authorization to signal a numeric PID; lifecycle
 * mutation belongs to the repository's stable-process-reference scripts.
 */
export function assertValidatorProcessBinding(
  recordValue: ValidatorPidRecord,
  observed: ValidatorProcessObservation,
  expected: {
    uid: number;
    ledger: string;
    stateDir: string;
    programId: string;
  },
): void {
  if (observed.uid !== expected.uid || observed.uid !== recordValue.uid) {
    throw new LocalnetError(
      "purge refused: validator PID is owned by another user",
    );
  }
  if (path.basename(observed.executable) !== "solana-test-validator") {
    throw new LocalnetError(
      "purge refused: PID executable is not solana-test-validator",
    );
  }
  if (path.resolve(observed.cwd) !== path.resolve(expected.stateDir)) {
    throw new LocalnetError(
      "purge refused: validator working directory does not match this repo",
    );
  }
  if (
    observed.processStartTicks !== recordValue.processStartTicks ||
    observed.executable !== recordValue.executable ||
    observed.cwd !== recordValue.cwd ||
    observed.argvSha256 !== recordValue.argvSha256
  ) {
    throw new LocalnetError(
      "purge refused: PID identity no longer matches its exact record",
    );
  }
  const argument = (name: string): string | null => {
    const index = observed.argv.indexOf(name);
    return index >= 0 ? (observed.argv[index + 1] ?? null) : null;
  };
  if (
    path.resolve(argument("--ledger") ?? "") !== path.resolve(expected.ledger)
  ) {
    throw new LocalnetError(
      "purge refused: validator ledger argument does not match this repo",
    );
  }
  if (argument("--rpc-port") !== String(recordValue.rpcPort)) {
    throw new LocalnetError(
      "purge refused: validator RPC port does not match its PID record",
    );
  }
  const upgradeIndex = observed.argv.indexOf("--upgradeable-program");
  if (
    upgradeIndex < 0 ||
    observed.argv[upgradeIndex + 1] !== expected.programId ||
    observed.argv[upgradeIndex + 2] !== LOCALNET_PROGRAM_DESCRIPTOR_PATH
  ) {
    throw new LocalnetError(
      "purge refused: validator program arguments do not match this repo",
    );
  }
}

export const SETUP_INSTRUCTIONS = [
  "agenc dev needs the AgenC localnet sandbox (one-time setup, from an",
  "agenc-protocol clone — https://github.com/tetsuo-ai/agenc-protocol):",
  "",
  "  1. anchor build                                  # compile the program (once)",
  "  2. (cd packages/sdk-ts && npm install && npm run build)",
  "  3. node scripts/localnet-up.mjs --dev-ready      # disposable operational marketplace",
  "",
  "then re-run `agenc dev` from your project (it discovers the stack's",
  ".localnet/env.json by walking up from the working directory, checking",
  "sibling agenc-protocol checkouts, or via AGENC_LOCALNET_ENV=<path>).",
].join("\n");

function isLoopbackUrl(rpcUrl: string): boolean {
  try {
    const { hostname } = new URL(rpcUrl);
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

/** Throw unless the URL is loopback — `agenc dev` must never leave the box. */
export function assertLocalOnly(rpcUrl: string): void {
  if (!isLoopbackUrl(rpcUrl)) {
    throw new LocalnetError(
      `agenc dev refuses non-local RPC endpoints (got ${rpcUrl}) — the dev ` +
        `sandbox is localnet-only; use \`agenc promote\` to audit mainnet readiness`,
    );
  }
}

function parseEnvFile(envPath: string): LocalnetEnv {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(envPath, "utf8"));
  } catch (error) {
    throw new LocalnetError(`${envPath}: ${(error as Error).message}`);
  }
  const env = parsed as Partial<LocalnetEnv>;
  if (typeof env.rpcUrl !== "string" || typeof env.programId !== "string") {
    throw new LocalnetError(`${envPath}: missing rpcUrl/programId`);
  }
  if (env.cluster !== "localnet") {
    throw new LocalnetError(
      `${envPath}: cluster is "${env.cluster}", not "localnet" — agenc dev ` +
        `only runs against the local sandbox`,
    );
  }
  assertLocalOnly(env.rpcUrl);
  const repoRoot = path.dirname(path.dirname(envPath)); // <repo>/.localnet/env.json
  return { ...(env as LocalnetEnv), envPath, repoRoot };
}

/**
 * Find the localnet env file: explicit path > AGENC_LOCALNET_ENV > walk up
 * from `startDir` looking for `.localnet/env.json` (or an `agenc-protocol`
 * sibling/child carrying one, so running from a scratch app next to the
 * protocol clone Just Works).
 */
export function findLocalnetEnv(
  startDir: string,
  explicitPath?: string,
): LocalnetEnv | null {
  const fromEnvVar = process.env.AGENC_LOCALNET_ENV?.trim();
  const explicit = explicitPath ?? (fromEnvVar === "" ? undefined : fromEnvVar);
  if (explicit !== undefined) {
    if (!existsSync(explicit)) {
      throw new LocalnetError(`localnet env file not found: ${explicit}`);
    }
    return parseEnvFile(explicit);
  }
  let dir = path.resolve(startDir);
  for (;;) {
    const candidates = [
      path.join(dir, ".localnet", "env.json"),
      path.join(dir, "agenc-protocol", ".localnet", "env.json"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return parseEnvFile(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface LocalnetHealth {
  rpcHealthy: boolean;
  programDeployed: boolean;
  marketplaceReady: boolean;
  protocolPaused: boolean | null;
  surfaceRevision: number | null;
}

const LOCALNET_BID_MARKETPLACE_POLICY = Object.freeze({
  minBidBondLamports: 1_000_000n,
  bidCreationCooldownSecs: 60n,
  maxBidsPer24h: 50,
  maxActiveBidsPerTask: 20,
  maxBidLifetimeSecs: 604_800n,
  acceptedNoShowSlashBps: 1_000,
});

interface RpcAccountValue {
  data?: unknown;
  executable?: unknown;
  owner?: unknown;
}

function bytesEqual(
  left: ReadonlyUint8Array,
  right: ReadonlyUint8Array,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Decode only an exact, canonical base64 account owned by this program.
 * Generated account decoders intentionally decode fields rather than RPC
 * envelopes, so ownership, executability, allocation size, and discriminator
 * are enforced here before decoded values can influence readiness.
 */
function decodeCanonicalProgramAccount<T>(
  value: unknown,
  expectedProgramId: string,
  expectedSize: number,
  expectedDiscriminator: ReadonlyUint8Array,
  decode: (bytes: ReadonlyUint8Array) => T,
): T | null {
  const account = value as RpcAccountValue | null;
  if (
    account === null ||
    account.executable !== false ||
    account.owner !== expectedProgramId ||
    !Array.isArray(account.data) ||
    account.data.length !== 2 ||
    account.data[1] !== "base64" ||
    typeof account.data[0] !== "string"
  ) {
    return null;
  }
  try {
    const bytes = Buffer.from(account.data[0], "base64");
    if (
      bytes.toString("base64") !== account.data[0] ||
      bytes.length !== expectedSize ||
      !bytesEqual(
        bytes.subarray(0, expectedDiscriminator.length),
        expectedDiscriminator,
      )
    ) {
      return null;
    }
    return decode(bytes);
  } catch {
    return null;
  }
}

export function localnetProtocolIsMarketplaceReady(config: {
  protocolPaused: boolean;
  surfaceRevision: number;
}): boolean {
  return (
    config.protocolPaused === false &&
    config.surfaceRevision === SURFACE_REVISION_CURRENT
  );
}

export function decodeLocalnetProtocolReadiness(
  value: unknown,
  expectedProgramId: string,
  expectedBump?: number,
): Pick<
  LocalnetHealth,
  "marketplaceReady" | "protocolPaused" | "surfaceRevision"
> | null {
  const config = decodeCanonicalProgramAccount<ProtocolConfig>(
    value,
    expectedProgramId,
    getProtocolConfigSize(),
    getProtocolConfigDiscriminatorBytes(),
    (bytes) => getProtocolConfigDecoder().decode(bytes),
  );
  if (
    config === null ||
    (expectedBump !== undefined && config.bump !== expectedBump)
  ) {
    return null;
  }
  return {
    marketplaceReady: localnetProtocolIsMarketplaceReady(config),
    protocolPaused: config.protocolPaused,
    surfaceRevision: config.surfaceRevision,
  };
}

export function decodeLocalnetMarketplaceReadiness(
  values: {
    protocol: unknown;
    moderation: unknown;
    bidMarketplace: unknown;
  },
  expected: {
    programId: string;
    protocolBump: number;
    moderationBump: number;
    bidMarketplaceBump: number;
  },
): Pick<
  LocalnetHealth,
  "marketplaceReady" | "protocolPaused" | "surfaceRevision"
> | null {
  const protocol = decodeCanonicalProgramAccount<ProtocolConfig>(
    values.protocol,
    expected.programId,
    getProtocolConfigSize(),
    getProtocolConfigDiscriminatorBytes(),
    (bytes) => getProtocolConfigDecoder().decode(bytes),
  );
  if (protocol === null || protocol.bump !== expected.protocolBump) return null;

  const moderation = decodeCanonicalProgramAccount<ModerationConfig>(
    values.moderation,
    expected.programId,
    getModerationConfigSize(),
    getModerationConfigDiscriminatorBytes(),
    (bytes) => getModerationConfigDecoder().decode(bytes),
  );
  const bidMarketplace = decodeCanonicalProgramAccount<BidMarketplaceConfig>(
    values.bidMarketplace,
    expected.programId,
    getBidMarketplaceConfigSize(),
    getBidMarketplaceConfigDiscriminatorBytes(),
    (bytes) => getBidMarketplaceConfigDecoder().decode(bytes),
  );

  const dependentConfigsReady =
    moderation !== null &&
    moderation.bump === expected.moderationBump &&
    moderation.enabled === true &&
    moderation.authority === protocol.authority &&
    bidMarketplace !== null &&
    bidMarketplace.bump === expected.bidMarketplaceBump &&
    bidMarketplace.authority === protocol.authority &&
    bidMarketplace.minBidBondLamports ===
      LOCALNET_BID_MARKETPLACE_POLICY.minBidBondLamports &&
    bidMarketplace.bidCreationCooldownSecs ===
      LOCALNET_BID_MARKETPLACE_POLICY.bidCreationCooldownSecs &&
    bidMarketplace.maxBidsPer24h ===
      LOCALNET_BID_MARKETPLACE_POLICY.maxBidsPer24h &&
    bidMarketplace.maxActiveBidsPerTask ===
      LOCALNET_BID_MARKETPLACE_POLICY.maxActiveBidsPerTask &&
    bidMarketplace.maxBidLifetimeSecs ===
      LOCALNET_BID_MARKETPLACE_POLICY.maxBidLifetimeSecs &&
    bidMarketplace.acceptedNoShowSlashBps ===
      LOCALNET_BID_MARKETPLACE_POLICY.acceptedNoShowSlashBps;

  return {
    marketplaceReady:
      localnetProtocolIsMarketplaceReady(protocol) && dependentConfigsReady,
    protocolPaused: protocol.protocolPaused,
    surfaceRevision: protocol.surfaceRevision,
  };
}

/** Health probe: canonical program + every required marketplace config. */
export async function checkLocalnetHealth(
  env: Pick<LocalnetEnv, "rpcUrl" | "programId">,
): Promise<LocalnetHealth> {
  const down = {
    rpcHealthy: false,
    programDeployed: false,
    marketplaceReady: false,
    protocolPaused: null,
    surfaceRevision: null,
  } as const;
  const post = async (body: object): Promise<unknown | null> => {
    try {
      const response = await fetch(env.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  };
  const health = await post({ jsonrpc: "2.0", id: 1, method: "getHealth" });
  const rpcHealthy =
    health !== null && (health as { result?: unknown }).result === "ok";
  if (!rpcHealthy) return down;
  const account = await post({
    jsonrpc: "2.0",
    id: 2,
    method: "getAccountInfo",
    params: [env.programId, { encoding: "base64" }],
  });
  const programValue = (
    account as {
      result?: {
        value?: { executable?: unknown; owner?: unknown } | null;
      };
    } | null
  )?.result?.value;
  const programDeployed =
    env.programId === AGENC_COORDINATION_PROGRAM_ADDRESS &&
    programValue?.executable === true &&
    programValue.owner === "BPFLoaderUpgradeab1e11111111111111111111111";
  if (!programDeployed) {
    return { ...down, rpcHealthy: true };
  }

  try {
    const [
      [protocolConfig, protocolBump],
      [moderationConfig, moderationBump],
      [bidMarketplaceConfig, bidMarketplaceBump],
    ] = await Promise.all([
      findProtocolConfigPda(),
      findModerationConfigPda(),
      findBidMarketplacePda(),
    ]);
    const response = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "getMultipleAccounts",
      params: [
        [protocolConfig, moderationConfig, bidMarketplaceConfig],
        { encoding: "base64" },
      ],
    });
    const values = (
      response as {
        result?: {
          value?: unknown;
        };
      } | null
    )?.result?.value;
    if (!Array.isArray(values) || values.length !== 3) {
      return { ...down, rpcHealthy: true, programDeployed: true };
    }
    const readiness = decodeLocalnetMarketplaceReadiness(
      {
        protocol: values[0],
        moderation: values[1],
        bidMarketplace: values[2],
      },
      {
        programId: env.programId,
        protocolBump,
        moderationBump,
        bidMarketplaceBump,
      },
    );
    if (readiness === null) {
      return { ...down, rpcHealthy: true, programDeployed: true };
    }
    return {
      rpcHealthy: true,
      programDeployed: true,
      ...readiness,
    };
  } catch {
    return { ...down, rpcHealthy: true, programDeployed: true };
  }
}

/** Can we boot the stack from here? (the sdk repo's localnet tooling) */
export function localnetTooling(repoRoot: string): string | null {
  const script = path.join(repoRoot, "scripts", "localnet-up.mjs");
  return existsSync(script) ? script : null;
}

function localnetDownTooling(repoRoot: string): string | null {
  const script = path.join(repoRoot, "scripts", "localnet-down.mjs");
  return existsSync(script) ? script : null;
}

async function runLocalnetScript(
  repoRoot: string,
  script: string,
  args: readonly string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        const outcome =
          signal === null ? `code ${String(code)}` : `signal ${signal}`;
        reject(
          new LocalnetError(`${path.basename(script)} exited with ${outcome}`),
        );
      }
    });
  });
}

/**
 * Boot (or re-boot) the localnet stack via the sdk repo's own tooling.
 * `purge` first delegates the complete stop-and-wipe operation to
 * localnet-down. localnet-up never starts unless that child exits successfully.
 */
export async function bootLocalnet(
  repoRoot: string,
  options: { purge?: boolean; log?: (line: string) => void } = {},
): Promise<void> {
  const script = localnetTooling(repoRoot);
  if (script === null) {
    throw new LocalnetError(
      `no localnet tooling at ${repoRoot}/scripts/localnet-up.mjs\n\n${SETUP_INSTRUCTIONS}`,
    );
  }
  const log = options.log ?? (() => {});
  if (options.purge === true) {
    const downScript = localnetDownTooling(repoRoot);
    if (downScript === null) {
      throw new LocalnetError(
        `no localnet purge tooling at ${repoRoot}/scripts/localnet-down.mjs`,
      );
    }
    log(`purging localnet sandbox: node ${downScript} --purge`);
    await runLocalnetScript(repoRoot, downScript, ["--purge"]);
  }
  log(`booting localnet sandbox: node ${script} --dev-ready`);
  await runLocalnetScript(repoRoot, script, ["--dev-ready"]);
}
