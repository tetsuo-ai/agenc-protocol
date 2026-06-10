#!/usr/bin/env node
// localnet-status.mjs — health report for the local AgenC stack.
//
// Reads the environment file (default .localnet/env.json), then reports:
//   - validator process + RPC health (getHealth/getSlot/getVersion)
//   - program account presence (executable) + ProgramData upgrade authority
//   - ProtocolConfig + ModerationConfig PDAs decoded via the SDK
//   - attestor health when env.attestorUrl is set
//
// Exit code 0 when validator + program + both configs are healthy; 1 otherwise.
//
// Usage:
//   node scripts/localnet-status.mjs [--env-file <path>]
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = path.join(ROOT, ".localnet");
const DEFAULT_ENV_FILE = path.join(STATE_DIR, "env.json");
const PID_FILE = path.join(STATE_DIR, "validator.pid");
const SDK_DIST = path.join(ROOT, "packages/sdk-ts/dist/index.js");
const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";

function parseArgs(argv) {
  const args = { envFile: DEFAULT_ENV_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--env-file") {
      if (!argv[i + 1]) throw new Error("--env-file requires a path");
      args.envFile = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node scripts/localnet-status.mjs [--env-file <path>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const OK = "OK  ";
const BAD = "FAIL";
let healthy = true;
function report(ok, label, detail = "") {
  if (!ok) healthy = false;
  console.log(`[${ok ? OK : BAD}] ${label}${detail ? `: ${detail}` : ""}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ----------------------------------------------------------- env file
  let env;
  try {
    env = JSON.parse(await readFile(args.envFile, "utf8"));
  } catch (error) {
    report(false, `env file ${args.envFile}`, `unreadable (${error.message}) — run localnet-up first`);
    process.exit(1);
  }
  console.log(`env file: ${args.envFile}`);
  console.log(JSON.stringify(env, null, 2));
  console.log("");

  // ----------------------------------------------------------- validator
  const pidInfo = await readFile(PID_FILE, "utf8").then(
    (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return { pid: Number(raw.trim()) };
      }
    },
    () => null,
  );
  if (pidInfo) {
    report(pidAlive(pidInfo.pid), "validator process", `pid ${pidInfo.pid}${pidInfo.startedAt ? ` (started ${pidInfo.startedAt})` : ""}`);
  } else {
    report(false, "validator process", `no pid file at ${PID_FILE}`);
  }

  const kit = await import("@solana/kit");
  const rpc = kit.createSolanaRpc(env.rpcUrl);
  let rpcUp = false;
  try {
    const [health, slot, version] = await Promise.all([
      rpc.getHealth().send(),
      rpc.getSlot().send(),
      rpc.getVersion().send(),
    ]);
    rpcUp = health === "ok";
    report(rpcUp, "rpc health", `${env.rpcUrl} health=${health} slot=${slot} solana=${version["solana-core"]}`);
  } catch (error) {
    report(false, "rpc health", `${env.rpcUrl} unreachable (${error.message})`);
  }

  if (!rpcUp) {
    console.log("\nvalidator RPC down — skipping on-chain checks.");
    process.exit(1);
  }

  // ------------------------------------------------------------- program
  const programAddress = kit.address(env.programId);
  const programInfo = await rpc.getAccountInfo(programAddress, { encoding: "base64" }).send();
  report(
    Boolean(programInfo.value?.executable),
    "program account",
    programInfo.value
      ? `${env.programId} executable=${programInfo.value.executable} owner=${programInfo.value.owner}`
      : `${env.programId} MISSING`,
  );

  const [programDataPda] = await kit.getProgramDerivedAddress({
    programAddress: kit.address(BPF_LOADER_UPGRADEABLE),
    seeds: [kit.getAddressEncoder().encode(programAddress)],
  });
  const programDataInfo = await rpc.getAccountInfo(programDataPda, { encoding: "base64" }).send();
  if (programDataInfo.value) {
    // ProgramData layout: 4 (enum tag) + 8 (slot) + 1 (option) + 32 (authority).
    const data = Buffer.from(programDataInfo.value.data[0], "base64");
    const hasAuthority = data.length >= 45 && data[12] === 1;
    const upgradeAuthority = hasAuthority
      ? kit.getAddressDecoder().decode(data.subarray(13, 45))
      : null;
    report(
      true,
      "programdata",
      `${programDataPda} len=${data.length} upgradeAuthority=${upgradeAuthority ?? "none"}`,
    );
  } else {
    report(false, "programdata", `${programDataPda} MISSING (program not loaded as upgradeable)`);
  }

  // ------------------------------------------------------------- configs
  let sdk;
  try {
    await stat(SDK_DIST);
    sdk = await import(pathToFileURL(SDK_DIST).href);
  } catch {
    report(false, "sdk dist", `${SDK_DIST} missing — cd packages/sdk-ts && npm run build`);
    process.exit(1);
  }

  const [protocolPda] = await sdk.findProtocolConfigPda();
  const protocol = await sdk.fetchMaybeProtocolConfig(rpc, protocolPda);
  if (protocol.exists) {
    const d = protocol.data;
    report(
      true,
      "ProtocolConfig",
      `${protocolPda}\n       authority=${d.authority}\n       treasury=${d.treasury}\n       ` +
        `disputeThreshold=${d.disputeThreshold} protocolFeeBps=${d.protocolFeeBps} minAgentStake=${d.minAgentStake} ` +
        `minStakeForDispute=${d.minStakeForDispute}\n       multisig=${d.multisigThreshold}/${d.multisigOwnersLen} ` +
        `owners=[${d.multisigOwners.slice(0, d.multisigOwnersLen).join(", ")}]\n       ` +
        `version=${d.protocolVersion} paused=${d.protocolPaused} totalAgents=${d.totalAgents} totalTasks=${d.totalTasks}`,
    );
  } else {
    report(false, "ProtocolConfig", `${protocolPda} MISSING — run localnet-up`);
  }

  const [moderationPda] = await sdk.findModerationConfigPda();
  const moderation = await sdk.fetchMaybeModerationConfig(rpc, moderationPda);
  if (moderation.exists) {
    const d = moderation.data;
    report(
      true,
      "ModerationConfig",
      `${moderationPda}\n       moderationAuthority=${d.moderationAuthority} enabled=${d.enabled} ` +
        `createdAt=${d.createdAt} updatedAt=${d.updatedAt}`,
    );
  } else {
    report(false, "ModerationConfig", `${moderationPda} MISSING — run localnet-up`);
  }

  // ------------------------------------------------------------- attestor
  if (typeof env.attestorUrl === "string" && env.attestorUrl.length > 0) {
    try {
      const response = await fetch(env.attestorUrl, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      report(
        response.status < 500,
        "attestor",
        `${env.attestorUrl} -> HTTP ${response.status}`,
      );
    } catch (error) {
      report(false, "attestor", `${env.attestorUrl} unreachable (${error.message})`);
    }
  } else {
    console.log("[ -- ] attestor: not configured (attestorUrl=null)");
  }

  // ------------------------------------------------------------- fixtures
  if (typeof env.fixturesPath === "string" && env.fixturesPath.length > 0) {
    try {
      const fixtures = JSON.parse(await readFile(env.fixturesPath, "utf8"));
      console.log(
        `[ -- ] fixtures: ${env.fixturesPath} (seeded=${fixtures.seeded ?? "?"}, ` +
          `listings=${Array.isArray(fixtures.listings) ? fixtures.listings.length : "?"})`,
      );
    } catch {
      console.log(`[ -- ] fixtures: ${env.fixturesPath} not present yet (run the seeder)`);
    }
  }

  console.log(`\nstatus: ${healthy ? "HEALTHY" : "UNHEALTHY"}`);
  process.exit(healthy ? 0 : 1);
}

main().catch((error) => {
  console.error(`localnet-status: ERROR: ${error?.stack ?? error}`);
  process.exit(1);
});
