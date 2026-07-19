// Localnet sandbox discovery/health for `agenc dev` — the WP-D4 stack is the
// blessed dev bed (`scripts/localnet-up.mjs` + `.localnet/env.json`).
// `agenc dev` NEVER touches mainnet/devnet: the resolved endpoint must be a
// loopback URL and the env file must say cluster=localnet.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import path from "node:path";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { parseSolanaKeypairJson } from "@tetsuo-ai/agenc-worker";

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
  schemaVersion: 1;
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
    throw new LocalnetError(`${pidFile}: invalid JSON (${(error as Error).message})`);
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
  ];
  const unknown = Object.keys(parsed).find((key) => !expected.includes(key));
  if (unknown !== undefined || expected.some((key) => !(key in parsed))) {
    throw new LocalnetError(`${pidFile}: invalid or unsupported identity record`);
  }
  if (
    parsed.schemaVersion !== 1 ||
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
    throw new LocalnetError(`${pidFile}: recordedAt is not a canonical timestamp`);
  }
  if (
    typeof parsed.programSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.programSha256)
  ) {
    throw new LocalnetError(`${pidFile}: programSha256 is invalid`);
  }
  if (!Number.isSafeInteger(parsed.programSize) || (parsed.programSize as number) <= 0) {
    throw new LocalnetError(`${pidFile}: programSize is invalid`);
  }
  return parsed as unknown as ValidatorPidRecord;
}

/** Pure binding checks used immediately before a purge signal is sent. */
export function assertValidatorProcessBinding(
  recordValue: ValidatorPidRecord,
  observed: ValidatorProcessObservation,
  expected: {
    uid: number;
    ledger: string;
    stateDir: string;
    programId: string;
    programBinary: string;
  },
): void {
  if (observed.uid !== expected.uid || observed.uid !== recordValue.uid) {
    throw new LocalnetError("purge refused: validator PID is owned by another user");
  }
  if (path.basename(observed.executable) !== "solana-test-validator") {
    throw new LocalnetError("purge refused: PID executable is not solana-test-validator");
  }
  if (path.resolve(observed.cwd) !== path.resolve(expected.stateDir)) {
    throw new LocalnetError("purge refused: validator working directory does not match this repo");
  }
  if (
    observed.processStartTicks !== recordValue.processStartTicks ||
    observed.executable !== recordValue.executable ||
    observed.cwd !== recordValue.cwd ||
    observed.argvSha256 !== recordValue.argvSha256
  ) {
    throw new LocalnetError("purge refused: PID identity no longer matches its exact record");
  }
  const argument = (name: string): string | null => {
    const index = observed.argv.indexOf(name);
    return index >= 0 ? (observed.argv[index + 1] ?? null) : null;
  };
  if (path.resolve(argument("--ledger") ?? "") !== path.resolve(expected.ledger)) {
    throw new LocalnetError("purge refused: validator ledger argument does not match this repo");
  }
  if (argument("--rpc-port") !== String(recordValue.rpcPort)) {
    throw new LocalnetError("purge refused: validator RPC port does not match its PID record");
  }
  const upgradeIndex = observed.argv.indexOf("--upgradeable-program");
  if (
    upgradeIndex < 0 ||
    observed.argv[upgradeIndex + 1] !== expected.programId ||
    path.resolve(observed.argv[upgradeIndex + 2] ?? "") !==
      path.resolve(expected.programBinary)
  ) {
    throw new LocalnetError("purge refused: validator program arguments do not match this repo");
  }
}

function linuxProcessObservation(pid: number): ValidatorProcessObservation {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    throw new LocalnetError(
      "purge refused: strong process identity verification is unavailable on this platform",
    );
  }
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const uidMatch = /^Uid:\s+(\d+)/mu.exec(status);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = stat.lastIndexOf(")");
    const fields = commEnd < 0 ? [] : stat.slice(commEnd + 1).trim().split(/\s+/u);
    const processStartTicks = fields[19];
    const argvBytes = readFileSync(`/proc/${pid}/cmdline`);
    if (
      uidMatch === null ||
      !Number.isSafeInteger(Number(uidMatch[1])) ||
      !/^[1-9][0-9]*$/u.test(processStartTicks ?? "") ||
      argvBytes.length === 0
    ) {
      throw new Error("incomplete procfs identity");
    }
    return {
      uid: Number(uidMatch[1]),
      executable: readlinkSync(`/proc/${pid}/exe`),
      argv: argvBytes.toString("utf8").split("\0").filter(Boolean),
      cwd: readlinkSync(`/proc/${pid}/cwd`),
      processStartTicks: processStartTicks!,
      argvSha256: createHash("sha256").update(argvBytes).digest("hex"),
    };
  } catch (error) {
    throw new LocalnetError(
      `purge refused: could not verify validator process identity (${(error as Error).message})`,
    );
  }
}

async function assertValidatorRpcIdentity(
  repoRoot: string,
  recordValue: ValidatorPidRecord,
): Promise<void> {
  const rpcUrl = `http://127.0.0.1:${recordValue.rpcPort}`;
  const envPath = path.join(repoRoot, ".localnet", "env.json");
  const env = parseEnvFile(envPath);
  if (env.rpcUrl !== rpcUrl) {
    throw new LocalnetError("purge refused: RPC port does not match .localnet/env.json");
  }
  if (
    env.programSha256 !== recordValue.programSha256 ||
    env.programSize !== recordValue.programSize
  ) {
    throw new LocalnetError("purge refused: PID program identity does not match .localnet/env.json");
  }
  const identityPath = path.join(repoRoot, ".localnet", "ledger", "validator-keypair.json");
  const signer = await createKeyPairSignerFromBytes(
    parseSolanaKeypairJson(readFileSync(identityPath, "utf8"), identityPath),
  );
  const [identity, program] = await Promise.all([
    fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity", params: [] }),
      signal: AbortSignal.timeout(3_000),
    }),
    fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "getAccountInfo",
        params: [env.programId, { encoding: "base64" }],
      }),
      signal: AbortSignal.timeout(3_000),
    }),
  ]);
  if (!identity.ok || !program.ok) {
    throw new LocalnetError("purge refused: validator RPC identity is unavailable");
  }
  const identityBody = (await identity.json()) as { result?: { identity?: unknown } };
  const programBody = (await program.json()) as { result?: { value?: unknown } };
  if (
    identityBody.result?.identity !== signer.address ||
    programBody.result?.value == null
  ) {
    throw new LocalnetError("purge refused: RPC is not this ledger's AgenC validator");
  }
}

export const SETUP_INSTRUCTIONS = [
  "agenc dev needs the AgenC localnet sandbox (one-time setup, from an",
  "agenc-protocol clone — https://github.com/tetsuo-ai/agenc-protocol):",
  "",
  "  1. anchor build                                  # compile the program (once)",
  "  2. (cd packages/sdk-ts && npm install && npm run build)",
  "  3. node scripts/localnet-up.mjs                  # validator + program + configs",
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

/** Health probe: RPC answers AND the program account exists. */
export async function checkLocalnetHealth(
  env: Pick<LocalnetEnv, "rpcUrl" | "programId">,
): Promise<{ rpcHealthy: boolean; programDeployed: boolean }> {
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
  if (!rpcHealthy) return { rpcHealthy: false, programDeployed: false };
  const account = await post({
    jsonrpc: "2.0",
    id: 2,
    method: "getAccountInfo",
    params: [env.programId, { encoding: "base64" }],
  });
  const programDeployed =
    account !== null &&
    (account as { result?: { value?: unknown } }).result?.value != null;
  return { rpcHealthy, programDeployed };
}

/** Can we boot the stack from here? (the sdk repo's localnet tooling) */
export function localnetTooling(repoRoot: string): string | null {
  const script = path.join(repoRoot, "scripts", "localnet-up.mjs");
  return existsSync(script) ? script : null;
}

/**
 * Boot (or re-boot) the localnet stack via the sdk repo's own tooling.
 * `purge` first kills a stale validator recorded in `.localnet/validator.pid`
 * so localnet-up starts from a reset ledger.
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
    const pidFile = path.join(repoRoot, ".localnet", "validator.pid");
    if (existsSync(pidFile)) {
      const metadata = lstatSync(pidFile);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new LocalnetError("purge refused: validator.pid is not a regular non-symlink file");
      }
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new LocalnetError("purge refused: validator.pid is not owned by the current user");
      }
      const pidRecord = parseValidatorPidRecord(readFileSync(pidFile, "utf8"), pidFile);
      const programBinary = path.join(
        repoRoot,
        "programs",
        "agenc-coordination",
        "target",
        "deploy",
        "agenc_coordination.so",
      );
      const env = parseEnvFile(path.join(repoRoot, ".localnet", "env.json"));
      let alive = true;
      try {
        process.kill(pidRecord.pid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
      if (alive) {
        assertValidatorProcessBinding(pidRecord, linuxProcessObservation(pidRecord.pid), {
          uid: process.getuid!(),
          ledger: path.join(repoRoot, ".localnet", "ledger"),
          stateDir: path.join(repoRoot, ".localnet"),
          programId: env.programId,
          programBinary,
        });
        await assertValidatorRpcIdentity(repoRoot, pidRecord);
        // Identity is rechecked immediately before the only mutating operation.
        assertValidatorProcessBinding(pidRecord, linuxProcessObservation(pidRecord.pid), {
          uid: process.getuid!(),
          ledger: path.join(repoRoot, ".localnet", "ledger"),
          stateDir: path.join(repoRoot, ".localnet"),
          programId: env.programId,
          programBinary,
        });
        process.kill(pidRecord.pid, "SIGTERM");
        log(`purge: sent SIGTERM to verified validator pid ${pidRecord.pid}`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }
  log(`booting localnet sandbox: node ${script}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new LocalnetError(`localnet-up.mjs exited with code ${code}`));
    });
  });
}
