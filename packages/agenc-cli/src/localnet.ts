// Localnet sandbox discovery/health for `agenc dev` — the WP-D4 stack is the
// blessed dev bed (`scripts/localnet-up.mjs` + `.localnet/env.json`).
// `agenc dev` NEVER touches mainnet/devnet: the resolved endpoint must be a
// loopback URL and the env file must say cluster=localnet.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The subset of `.localnet/env.json` `agenc dev` consumes. */
export interface LocalnetEnv {
  cluster: string;
  rpcUrl: string;
  rpcSubscriptionsUrl?: string;
  programId: string;
  keypairs?: { authority?: string; moderator?: string; seeder?: string } | null;
  /** Where the env file was found. */
  envPath: string;
  /** The agenc-protocol repo root the stack belongs to. */
  repoRoot: string;
}

export class LocalnetError extends Error {
  override name = "LocalnetError";
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
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGTERM");
          log(`purge: sent SIGTERM to validator pid ${pid}`);
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        } catch {
          // already gone
        }
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
