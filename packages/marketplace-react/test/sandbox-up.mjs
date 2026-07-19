#!/usr/bin/env node
/**
 * sandbox-up.mjs — the committed deterministic local-validator bootstrap for
 * the `@tetsuo-ai/marketplace-react` browser e2e (PLAN_2 A3 Done-when, the
 * "local solana-test-validator loaded with the repo-built .so plus injected
 * ProtocolConfig/ModerationConfig via a committed bootstrap script" path).
 *
 * It does NOT re-implement the boot/init/seed logic — it REUSES the repo's
 * canonical localnet stack so the browser e2e runs against EXACTLY the same
 * on-chain state the rest of the codebase tests against:
 *
 *   1. <repo>/scripts/localnet-up.mjs
 *        boots solana-test-validator with the REAL program id genesis-loaded as
 *        an UPGRADEABLE program (real ProgramData PDA + upgrade authority),
 *        establishes ProtocolConfig + ModerationConfig through the published
 *        SDK/local fixture mode, and writes <repo>/.localnet/env.json.
 *   2. packages/sdk-ts/scripts/seed-devnet-sandbox.mjs --env-file <env.json>
 *        registers the 10 sandbox provider agents, creates one Active
 *        ServiceListing each, attests every listing CLEAN (so the fail-closed
 *        moderation gate lets hires through), and writes the env file's
 *        fixturesPath (.localnet/fixtures.json).
 *
 * After start() returns, a browser app can:
 *   - read the RPC url + program id from <repo>/.localnet/env.json,
 *   - read the seeded listing addresses from <repo>/.localnet/fixtures.json,
 *   - build a gPA read transport over that RPC (no indexer needed locally), and
 *   - drive a real hire against the funded seeder/buyer keys.
 *
 * Programmatic API (consumed by test/playwright/global-setup.mjs):
 *   import { start, stop, readSandboxEnv } from "./sandbox-up.mjs";
 *   const env = await start();      // { rpcUrl, rpcSubscriptionsUrl, programId,
 *                                   //   envFile, fixturesPath, fixtures, keypairs }
 *   ... drive the browser e2e ...
 *   await stop();                   // stops the validator (localnet-down.mjs)
 *
 * CLI:
 *   node test/sandbox-up.mjs up      # boot + init + seed (idempotent; converges)
 *   node test/sandbox-up.mjs up --unsafe-unpaused-fixture  # disposable browser fixture
 *   node test/sandbox-up.mjs down    # stop the validator
 *   node test/sandbox-up.mjs down --purge   # stop + wipe the ledger
 *   node test/sandbox-up.mjs env     # print the resolved sandbox env JSON
 *
 * Requirements (same as localnet-up.mjs):
 *   - solana-test-validator + solana-keygen on PATH (Agave/Solana CLI),
 *   - an `anchor build` .so at
 *     programs/agenc-coordination/target/deploy/agenc_coordination.so,
 *   - the built SDK at packages/sdk-ts/dist (cd packages/sdk-ts && npm run build).
 *
 * Idempotent: re-running `up` converges (localnet-up + the seed script are both
 * idempotent). `stop()` is safe to call when nothing is running.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// test/ -> packages/marketplace-react -> packages -> <repo root>
const REPO_ROOT = path.resolve(HERE, "../../..");
const STATE_DIR = path.join(REPO_ROOT, ".localnet");
const VALIDATOR_PID_FILE = path.join(STATE_DIR, "validator.pid");
const LOCALNET_UP = path.join(REPO_ROOT, "scripts/localnet-up.mjs");
const LOCALNET_DOWN = path.join(REPO_ROOT, "scripts/localnet-down.mjs");
const SEED_SCRIPT = path.join(
  REPO_ROOT,
  "packages/sdk-ts/scripts/seed-devnet-sandbox.mjs",
);
const ENV_FILE = path.join(REPO_ROOT, ".localnet/env.json");
const PROGRAM_SO = path.join(
  REPO_ROOT,
  "programs/agenc-coordination/target/deploy/agenc_coordination.so",
);

/** Default RPC port for the sandbox validator (websocket is always port+1). */
export const SANDBOX_PORT = 8899;

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Conservatively report whether the recorded validator process may still be
 * live. Malformed or unreadable identity state is treated as live so fixture
 * code never destroys a caller-owned sandbox on ambiguous evidence.
 */
export async function recordedValidatorMayBeLive() {
  if (!(await fileExists(VALIDATOR_PID_FILE))) return false;
  let raw;
  try {
    raw = await readFile(VALIDATOR_PID_FILE, "utf8");
  } catch {
    return true;
  }

  let pid;
  try {
    pid = Number(JSON.parse(raw)?.pid);
  } catch {
    return true;
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function hashFile(p) {
  return createHash("sha256")
    .update(await readFile(p))
    .digest("hex");
}

/**
 * Run a node script as a child process, inheriting stdio so the validator boot
 * / seed progress is visible. Rejects on a non-zero exit.
 */
function runNode(scriptPath, args, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    // Node 20+ has its own --env-file flag. The explicit option terminator is
    // required so fixture-script flags are never consumed by the Node runtime.
    const child = spawn(process.execPath, ["--", scriptPath, ...args], {
      cwd: REPO_ROOT,
      stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${path.basename(scriptPath)} exited with code ${code}`),
        );
    });
  });
}

/**
 * Read + parse the localnet env file written by localnet-up.mjs.
 * @returns the parsed env object, or null when the file is absent/invalid.
 */
export async function readLocalnetEnv(envFile = ENV_FILE) {
  try {
    return JSON.parse(await readFile(envFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read + parse the seeded fixtures file (the env file's fixturesPath).
 * @returns the parsed fixtures object, or null when absent/invalid.
 */
export async function readSandboxFixtures(fixturesPath) {
  if (!fixturesPath) return null;
  try {
    return JSON.parse(await readFile(fixturesPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Resolve the full sandbox environment (env file + fixtures) WITHOUT booting
 * anything. Returns null when the stack has never been brought up.
 */
export async function readSandboxEnv(envFile = ENV_FILE) {
  const env = await readLocalnetEnv(envFile);
  if (env === null) return null;
  const fixtures = await readSandboxFixtures(env.fixturesPath);
  const currentProgramSha256 = (await fileExists(PROGRAM_SO))
    ? await hashFile(PROGRAM_SO)
    : null;
  const envProgramSha256 =
    typeof env.programSha256 === "string" ? env.programSha256 : null;
  return {
    cluster: env.cluster,
    rpcUrl: env.rpcUrl,
    rpcSubscriptionsUrl: env.rpcSubscriptionsUrl,
    programId: env.programId,
    programSha256: envProgramSha256,
    currentProgramSha256,
    programCurrent:
      currentProgramSha256 !== null &&
      envProgramSha256 !== null &&
      envProgramSha256 === currentProgramSha256,
    envFile,
    fixturesPath: env.fixturesPath ?? null,
    fixtures,
    keypairs: env.keypairs ?? null,
  };
}

/**
 * Boot the deterministic local sandbox: validator + protocol/moderation config
 * (localnet-up.mjs), then seed the 10 sandbox listings attested CLEAN
 * (seed-devnet-sandbox.mjs). Idempotent — re-running converges.
 *
 * @param {object} [options]
 * @param {number} [options.port=8899]   RPC port for the validator.
 * @param {boolean} [options.keepLedger=false]  Pass --keep-ledger to localnet-up
 *                                               (do not reset the ledger).
 * @param {boolean} [options.seed=true]  Run the seed step after boot.
 * @param {boolean} [options.quiet=false]  Suppress child stdout (stderr kept).
 * @param {boolean} [options.disposable=false]  This caller first established
 *   exclusive ownership of a fresh fixture and authorizes full cleanup if any
 *   bootstrap stage fails. Never inferred for an idempotently reused sandbox.
 * @param {boolean} [options.unsafeUnpausedFixture=false]  On a fresh disposable
 *   ledger, genesis-inject the current unpaused ProtocolConfig required by the
 *   browser fixture. Bypasses the production release-stamp ceremony; test only.
 * @returns {Promise<object>} the resolved sandbox env (see readSandboxEnv).
 */
export async function start(options = {}, dependencies = {}) {
  const {
    port = SANDBOX_PORT,
    keepLedger = false,
    seed = true,
    quiet = false,
    unsafeUnpausedFixture = false,
    disposable = false,
  } = options;

  if (disposable && keepLedger) {
    throw new Error(
      "a disposable sandbox cannot preserve a caller-owned ledger",
    );
  }

  await (dependencies.assertPrereqs ?? assertPrereqs)();

  const upArgs = ["--port", String(port)];
  if (keepLedger) upArgs.push("--keep-ledger");
  if (unsafeUnpausedFixture) upArgs.push("--unsafe-unpaused-fixture");
  return runSandboxBootstrap(
    {
      up: dependencies.up ?? (() => runNode(LOCALNET_UP, upArgs, { quiet })),
      readEnv: dependencies.readEnv ?? (() => readLocalnetEnv(ENV_FILE)),
      seed:
        dependencies.seed ??
        (() => runNode(SEED_SCRIPT, ["--env-file", ENV_FILE], { quiet })),
      resolve: dependencies.resolve ?? (() => readSandboxEnv(ENV_FILE)),
      cleanup:
        dependencies.cleanup ??
        (() => stop({ purge: true, removeState: true, quiet: true })),
    },
    {
      seed,
      // Cleanup authority is explicit. `start()` is otherwise idempotent and
      // may have converged a caller-owned sandbox that it must never tear down.
      cleanupOnFailure: disposable,
    },
  );
}

/**
 * Transactional core of {@link start}. Exported so the failure path can be
 * regression-tested without spawning a real validator. `up` is considered to
 * have acquired resources even when it rejects: localnet-up can fail after it
 * has published the validator identity file.
 */
export async function runSandboxBootstrap(
  { up, readEnv, seed: runSeed, resolve, cleanup },
  { seed = true, cleanupOnFailure = true } = {},
) {
  try {
    await up();
    const env = await readEnv();
    if (env === null) {
      throw new Error(
        `localnet-up.mjs did not write ${ENV_FILE} — boot likely failed`,
      );
    }

    if (seed) await runSeed();

    const resolved = await resolve();
    if (resolved === null) {
      throw new Error(
        `could not resolve sandbox env from ${ENV_FILE} after start`,
      );
    }
    if (seed && (resolved.fixtures === null || !resolved.fixtures.seeded)) {
      throw new Error(
        `seed step did not produce seeded fixtures at ${resolved.fixturesPath}`,
      );
    }
    return resolved;
  } catch (error) {
    if (!cleanupOnFailure) throw error;
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "sandbox bootstrap failed and its disposable state could not be cleaned",
      );
    }
    throw error;
  }
}

/**
 * Stop the sandbox validator (localnet-down.mjs). Safe when nothing runs.
 * @param {object} [options]
 * @param {boolean} [options.purge=false]  Also wipe the ledger.
 * @param {boolean} [options.removeState=false]  Remove all generated localnet
 *   keys, logs, fixtures, and env files after the identity-safe shutdown.
 */
export async function stop(options = {}) {
  const args = options.purge ? ["--purge"] : [];
  await runNode(LOCALNET_DOWN, args, { quiet: options.quiet });
  if (options.removeState) {
    await rm(STATE_DIR, { recursive: true, force: true });
  }
}

/** Fail fast with an actionable message if a prerequisite is missing. */
async function assertPrereqs() {
  const sdkDist = path.join(REPO_ROOT, "packages/sdk-ts/dist/index.js");
  if (!(await fileExists(LOCALNET_UP))) {
    throw new Error(`missing ${LOCALNET_UP} (repo layout changed?)`);
  }
  if (!(await fileExists(SEED_SCRIPT))) {
    throw new Error(`missing ${SEED_SCRIPT} (repo layout changed?)`);
  }
  if (!(await fileExists(PROGRAM_SO))) {
    throw new Error(
      `program binary missing: ${PROGRAM_SO}\n  Run \`anchor build\` from the repo root first.`,
    );
  }
  if (!(await fileExists(sdkDist))) {
    throw new Error(
      `built SDK missing: ${sdkDist}\n  Run \`cd packages/sdk-ts && npm install && npm run build\` first.`,
    );
  }
}

// ---------------------------------------------------------------------- CLI
async function cli() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "up":
    case undefined: {
      const keepLedger = rest.includes("--keep-ledger");
      const noSeed = rest.includes("--no-seed");
      const unsafeUnpausedFixture = rest.includes("--unsafe-unpaused-fixture");
      const env = await start({
        keepLedger,
        seed: !noSeed,
        unsafeUnpausedFixture,
      });
      console.log("\nsandbox-up: ready.");
      console.log(`  rpc:       ${env.rpcUrl}`);
      console.log(`  ws:        ${env.rpcSubscriptionsUrl}`);
      console.log(`  program:   ${env.programId}`);
      console.log(`  env file:  ${env.envFile}`);
      console.log(`  fixtures:  ${env.fixturesPath ?? "(not seeded)"}`);
      if (env.fixtures) {
        console.log(`  listings:  ${env.fixtures.listings.length} seeded`);
      }
      break;
    }
    case "down": {
      const purge = rest.includes("--purge");
      await stop({ purge });
      break;
    }
    case "env": {
      const env = await readSandboxEnv();
      console.log(JSON.stringify(env, null, 2));
      break;
    }
    default:
      console.error(
        `sandbox-up: unknown command "${cmd}". Use: up [--unsafe-unpaused-fixture] | down [--purge] | env`,
      );
      process.exit(1);
  }
}

// Run the CLI only when invoked directly (not when imported by global-setup).
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  cli().catch((error) => {
    console.error(`\nsandbox-up: ERROR: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
