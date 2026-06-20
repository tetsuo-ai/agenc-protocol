#!/usr/bin/env node
// localnet-up.mjs — one-command local AgenC stack (PLAN.md "run every phase locally").
//
// Boots solana-test-validator with the REAL program id genesis-loaded as an
// UPGRADEABLE program (--upgradeable-program <PROGRAM_ID> <SO> <authority>), so
// the real `initialize_protocol` instruction — which validates the ProgramData
// PDA + upgrade authority — works exactly like it does on devnet/mainnet.
// Then it funds the three well-known keys, runs the real initializers through
// the published SDK (packages/sdk-ts dist), and writes .localnet/env.json per
// the environment convention (see docs/LOCALNET.md).
//
// Idempotent: re-running converges (verifies existing state) instead of
// duplicating. Existing configs with DIFFERENT values fail loudly.
//
// Usage:
//   node scripts/localnet-up.mjs [--port 8899] [--keep-ledger] [--env-file <path>]
//
//   --port <n>       RPC port (default 8899; websocket port is always rpc+1)
//   --keep-ledger    do NOT --reset the validator ledger (keeps prior state)
//   --env-file <p>   where to write the environment file
//                    (default <repo>/.localnet/env.json)
//
// Requires: solana-test-validator + solana-keygen on PATH, an `anchor build`
// .so at programs/agenc-coordination/target/deploy/agenc_coordination.so, and
// the built SDK at packages/sdk-ts/dist (cd packages/sdk-ts && npm run build).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = path.join(ROOT, ".localnet");
const LEDGER_DIR = path.join(STATE_DIR, "ledger");
const KEYS_DIR = path.join(STATE_DIR, "keys");
const LOGS_DIR = path.join(STATE_DIR, "logs");
const PID_FILE = path.join(STATE_DIR, "validator.pid");
const VALIDATOR_LOG = path.join(LOGS_DIR, "validator.log");
const DEFAULT_ENV_FILE = path.join(STATE_DIR, "env.json");
const FIXTURES_PATH = path.join(STATE_DIR, "fixtures.json");
const SO_PATH = path.join(
  ROOT,
  "programs/agenc-coordination/target/deploy/agenc_coordination.so",
);
const IDL_PATH = path.join(ROOT, "artifacts/anchor/idl/agenc_coordination.json");
const SDK_DIST = path.join(ROOT, "packages/sdk-ts/dist/index.js");
const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";

const KEY_NAMES = ["authority", "moderator", "seeder"];
const LAMPORTS_PER_SOL = 1_000_000_000n;
const AIRDROP_TARGET = 500n * LAMPORTS_PER_SOL; // generous local funding
const AIRDROP_FLOOR = 100n * LAMPORTS_PER_SOL; // top up below this

// Localnet protocol parameters. minStake is the program-enforced floor
// (MIN_REASONABLE_STAKE = 0.001 SOL in initialize_protocol.rs) — register_agent
// requires stake_amount >= this, so local seeding must stake >= 0.001 SOL.
const PROTOCOL_PARAMS = {
  disputeThreshold: 60,
  protocolFeeBps: 250,
  minStake: 1_000_000n,
  minStakeForDispute: 1_000_000n,
  multisigThreshold: 2,
};

function usage() {
  return [
    "localnet-up — boot + deploy + initialize the local AgenC stack",
    "",
    "USAGE",
    "  node scripts/localnet-up.mjs [--port 8899] [--keep-ledger] [--env-file <path>]",
    "",
    "See docs/LOCALNET.md for the full local-stack runbook.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { port: 8899, keepLedger: false, envFile: DEFAULT_ENV_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 65534) {
        throw new Error(`--port must be an integer in 1..65534, got: ${argv[i + 1]}`);
      }
      args.port = value;
      i += 1;
    } else if (arg === "--keep-ledger") {
      args.keepLedger = true;
    } else if (arg === "--env-file") {
      if (!argv[i + 1]) throw new Error("--env-file requires a path");
      args.envFile = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return args;
}

function fail(message) {
  console.error(`\nlocalnet-up: ERROR: ${message}`);
  process.exit(1);
}

const startedAt = Date.now();
let stepStart = Date.now();
function step(label) {
  stepStart = Date.now();
  process.stdout.write(`-> ${label} ... `);
}
function stepDone(detail = "") {
  const secs = ((Date.now() - stepStart) / 1000).toFixed(1);
  console.log(`${detail ? `${detail} ` : ""}(${secs}s)`);
}

function binaryOnPath(name) {
  const probe = spawnSync(name, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return null;
  return (probe.stdout || "").trim().split("\n")[0];
}

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // alive but not ours
  }
}

async function readPidFile() {
  try {
    const raw = JSON.parse(await readFile(PID_FILE, "utf8"));
    return Number.isInteger(raw.pid) ? raw : null;
  } catch {
    return null;
  }
}

async function hashFile(p) {
  return createHash("sha256").update(await readFile(p)).digest("hex");
}

async function stopPid(label, pid) {
  if (!pidAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  process.kill(pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 500));
  if (pidAlive(pid)) {
    fail(`${label} pid ${pid} is still alive after SIGKILL`);
  }
}

async function rpcCall(rpcUrl, method, params = [], timeoutMs = 2500) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function rpcHealthy(rpcUrl) {
  try {
    return (await rpcCall(rpcUrl, "getHealth")) === "ok";
  } catch {
    return false;
  }
}

async function portOccupied(port) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port, timeout: 1500 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true); // something is listening but slow — treat as occupied
    });
    socket.once("error", () => resolve(false));
  });
}

async function tailLog(lines = 25) {
  try {
    const raw = await readFile(VALIDATOR_LOG, "utf8");
    return raw.trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no validator log)";
  }
}

async function ensureKeypair(keyPath, label) {
  if (await fileExists(keyPath)) {
    await chmod(keyPath, 0o600);
    return false;
  }
  const gen = spawnSync(
    "solana-keygen",
    ["new", "--no-bip39-passphrase", "--silent", "--outfile", keyPath],
    { encoding: "utf8" },
  );
  if (gen.error || gen.status !== 0) {
    throw new Error(
      `solana-keygen new failed for ${label}: ${gen.error?.message ?? gen.stderr}`,
    );
  }
  await chmod(keyPath, 0o600);
  return true;
}

async function loadSigner(kit, keyPath) {
  const bytes = Uint8Array.from(JSON.parse(await readFile(keyPath, "utf8")));
  return kit.createKeyPairSignerFromBytes(bytes);
}

function describeDiffs(diffs) {
  return diffs.map((d) => `  - ${d.field}: on-chain=${d.actual} expected=${d.expected}`).join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = `http://127.0.0.1:${args.port}`;
  const wsPort = args.port + 1;
  const rpcSubscriptionsUrl = `ws://127.0.0.1:${wsPort}`;

  console.log(`localnet-up: repo ${ROOT}`);

  // ---------------------------------------------------------------- preflight
  step("preflight (binaries, .so, SDK dist)");
  const validatorVersion = binaryOnPath("solana-test-validator");
  if (!validatorVersion) {
    fail("solana-test-validator not found on PATH (install the Solana/Agave CLI tools).");
  }
  if (!binaryOnPath("solana-keygen")) {
    fail("solana-keygen not found on PATH (install the Solana/Agave CLI tools).");
  }
  if (!(await fileExists(SO_PATH))) {
    fail(
      `program binary missing: ${SO_PATH}\n  Run \`anchor build\` from the repo root first (full surface, default features).`,
    );
  }
  const soBytes = (await stat(SO_PATH)).size;
  if (soBytes < 2_000_000) {
    console.warn(
      `\nWARNING: ${SO_PATH} is only ${soBytes} bytes — the full surface is ~2.8 MB.` +
        `\n  This looks like the restricted mainnet-canary build (npm run canary:build overwrites the .so).` +
        `\n  Run \`anchor build\` to restore the full surface, or continue at your own risk.`,
    );
  }
  if (!(await fileExists(SDK_DIST))) {
    fail(
      `built SDK missing: ${SDK_DIST}\n  Run \`cd packages/sdk-ts && npm install && npm run build\` first.`,
    );
  }
  if (!(await fileExists(IDL_PATH))) {
    fail(`IDL missing: ${IDL_PATH} (run \`anchor build && npm run artifacts:refresh\`).`);
  }
  const soSha256 = await hashFile(SO_PATH);
  const programId = JSON.parse(await readFile(IDL_PATH, "utf8")).address;
  if (!programId) fail(`IDL at ${IDL_PATH} has no .address field`);
  stepDone(
    `${validatorVersion}; .so ${soBytes} bytes sha256=${soSha256.slice(0, 16)}; program ${programId}`,
  );

  // ------------------------------------------------------- state dir + keys
  step("state dir + keypairs (.localnet/)");
  await mkdir(LEDGER_DIR, { recursive: true });
  await mkdir(KEYS_DIR, { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });
  const keyPaths = Object.fromEntries(
    KEY_NAMES.map((name) => [name, path.join(KEYS_DIR, `${name}.json`)]),
  );
  const generated = [];
  for (const name of KEY_NAMES) {
    if (await ensureKeypair(keyPaths[name], name)) generated.push(name);
  }
  stepDone(generated.length ? `generated: ${generated.join(", ")}` : "all present");

  const kit = await import("@solana/kit");
  const signers = {};
  for (const name of KEY_NAMES) {
    signers[name] = await loadSigner(kit, keyPaths[name]);
  }
  console.log(`   authority ${signers.authority.address}`);
  console.log(`   moderator ${signers.moderator.address}`);
  console.log(`   seeder    ${signers.seeder.address}`);

  // ------------------------------------------------------------- run check
  step(`validator on port ${args.port}`);
  let pidInfo = await readPidFile();
  let ourValidatorAlive = pidInfo !== null && pidAlive(pidInfo.pid);
  let booted = false;

  if (
    ourValidatorAlive &&
    !args.keepLedger &&
    pidInfo.programSha256 !== soSha256
  ) {
    const stalePid = pidInfo.pid;
    const previous = pidInfo.programSha256
      ? pidInfo.programSha256.slice(0, 16)
      : "missing";
    await stopPid("validator", stalePid);
    await rm(PID_FILE, { force: true });
    pidInfo = null;
    ourValidatorAlive = false;
    stepDone(
      `stopped stale pid ${stalePid} (program sha ${previous} -> ${soSha256.slice(0, 16)})`,
    );
    step(`validator on port ${args.port}`);
  }

  if (ourValidatorAlive) {
    if (pidInfo.rpcPort !== args.port) {
      fail(
        `our validator (pid ${pidInfo.pid}) is already running on port ${pidInfo.rpcPort}, not ${args.port}.\n` +
          `  Re-run without --port, or \`node scripts/localnet-down.mjs\` first.`,
      );
    }
    if (!(await rpcHealthy(rpcUrl))) {
      // Possibly still starting up from a previous invocation — give it a chance.
      const deadline = Date.now() + 30_000;
      let healthy = false;
      while (Date.now() < deadline) {
        if (await rpcHealthy(rpcUrl)) {
          healthy = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!healthy) {
        fail(
          `our validator pid ${pidInfo.pid} is alive but RPC is not healthy on ${rpcUrl}.\n` +
            `  Run \`node scripts/localnet-down.mjs\` and retry. Last log lines:\n${await tailLog()}`,
        );
      }
    }
    stepDone(`already running (pid ${pidInfo.pid}) — converging`);
  } else {
    if (pidInfo !== null) {
      await rm(PID_FILE, { force: true }); // stale pid file
    }
    if ((await portOccupied(args.port)) || (await portOccupied(wsPort))) {
      fail(
        `port ${args.port} (rpc) or ${wsPort} (websocket) is already bound by a process that is NOT our validator.\n` +
          `  Stop it, or pass a different --port.`,
      );
    }

    // ------------------------------------------------------------- boot
    const validatorArgs = [
      "--ledger",
      LEDGER_DIR,
      "--rpc-port",
      String(args.port),
      "--quiet",
      // Genesis-load the program at the REAL program id as an UPGRADEABLE
      // program with a real ProgramData account and our authority as upgrade
      // authority — required by initialize_protocol's ProgramData check.
      // (Silently ignored when the ledger already exists, i.e. --keep-ledger.)
      "--upgradeable-program",
      programId,
      SO_PATH,
      signers.authority.address,
    ];
    if (!args.keepLedger) validatorArgs.unshift("--reset");

    const logFd = openSync(VALIDATOR_LOG, "a");
    const child = spawn("solana-test-validator", validatorArgs, {
      cwd: STATE_DIR,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    closeSync(logFd);
    await writeFile(
      PID_FILE,
      `${JSON.stringify(
        {
          pid: child.pid,
          rpcPort: args.port,
          startedAt: new Date().toISOString(),
          programSha256: soSha256,
          programSize: soBytes,
        },
        null,
        2,
      )}\n`,
    );

    const deadline = Date.now() + 90_000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (!pidAlive(child.pid)) {
        await rm(PID_FILE, { force: true });
        fail(
          `solana-test-validator exited during startup. Last log lines (${VALIDATOR_LOG}):\n${await tailLog()}`,
        );
      }
      if (await rpcHealthy(rpcUrl)) {
        healthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!healthy) {
      fail(
        `validator did not become healthy on ${rpcUrl} within 90s (pid ${child.pid}).\n` +
          `  Inspect ${VALIDATOR_LOG}, then \`node scripts/localnet-down.mjs\`.`,
      );
    }
    booted = true;
    stepDone(`booted pid ${child.pid}${args.keepLedger ? " (kept ledger)" : " (reset)"}`);
  }

  const rpc = kit.createSolanaRpc(rpcUrl);

  // ------------------------------------------------------------- airdrops
  step("airdrops (500 SOL targets)");
  const funded = [];
  for (const name of KEY_NAMES) {
    const address = signers[name].address;
    const { value: balance } = await rpc.getBalance(address).send();
    if (BigInt(balance) >= AIRDROP_FLOOR) {
      funded.push(`${name}=${BigInt(balance) / LAMPORTS_PER_SOL}SOL(kept)`);
      continue;
    }
    await rpc.requestAirdrop(address, kit.lamports(AIRDROP_TARGET)).send();
    const deadline = Date.now() + 30_000;
    let final = BigInt(balance);
    while (Date.now() < deadline) {
      const { value } = await rpc.getBalance(address).send();
      final = BigInt(value);
      if (final >= AIRDROP_FLOOR) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (final < AIRDROP_FLOOR) {
      fail(`airdrop to ${name} (${address}) did not land within 30s (balance ${final}).`);
    }
    funded.push(`${name}=${final / LAMPORTS_PER_SOL}SOL`);
  }
  stepDone(funded.join(" "));

  // ---------------------------------------------------------- SDK + program
  step("program account check");
  const sdk = await import(pathToFileURL(SDK_DIST).href);
  if (sdk.AGENC_COORDINATION_PROGRAM_ADDRESS !== programId) {
    fail(
      `SDK program address ${sdk.AGENC_COORDINATION_PROGRAM_ADDRESS} != IDL address ${programId}.\n` +
        `  Rebuild artifacts + SDK (npm run artifacts:refresh; cd packages/sdk-ts && npm run sdk:generate && npm run build).`,
    );
  }
  const programInfo = await rpc
    .getAccountInfo(kit.address(programId), { encoding: "base64" })
    .send();
  if (!programInfo.value || !programInfo.value.executable) {
    fail(
      `program ${programId} is not an executable account on ${rpcUrl}.\n` +
        `  The ledger predates the genesis program load — re-run WITHOUT --keep-ledger (resets the ledger).`,
    );
  }
  const [programDataPda] = await kit.getProgramDerivedAddress({
    programAddress: kit.address(BPF_LOADER_UPGRADEABLE),
    seeds: [kit.getAddressEncoder().encode(kit.address(programId))],
  });
  const programDataInfo = await rpc
    .getAccountInfo(programDataPda, { encoding: "base64" })
    .send();
  if (!programDataInfo.value) {
    fail(
      `ProgramData ${programDataPda} missing — the program was not loaded as UPGRADEABLE.\n` +
        `  Re-run without --keep-ledger so genesis uses --upgradeable-program.`,
    );
  }
  stepDone(`executable at ${programId}; ProgramData ${programDataPda}`);

  // ------------------------------------------------- initialize_protocol
  step("protocol config (initialize_protocol)");
  const client = sdk.createMarketplaceClient({ rpcUrl, signer: signers.authority });
  const expectedOwners = [
    signers.authority.address,
    signers.moderator.address,
    signers.seeder.address,
  ];
  const [protocolPda] = await sdk.findProtocolConfigPda();
  let protocol = await sdk.fetchMaybeProtocolConfig(rpc, protocolPda);
  let protocolAction = "verified existing";
  if (!protocol.exists) {
    const ix = await sdk.facade.initializeProtocol({
      authority: signers.authority,
      secondSigner: signers.moderator,
      treasury: signers.authority.address, // system account; signs as authority
      disputeThreshold: PROTOCOL_PARAMS.disputeThreshold,
      protocolFeeBps: PROTOCOL_PARAMS.protocolFeeBps,
      minStake: PROTOCOL_PARAMS.minStake,
      minStakeForDispute: PROTOCOL_PARAMS.minStakeForDispute,
      multisigThreshold: PROTOCOL_PARAMS.multisigThreshold,
      multisigOwners: expectedOwners,
    });
    // initialize_protocol validates remaining_accounts[0] == ProgramData PDA.
    const ixWithProgramData = {
      ...ix,
      accounts: [...ix.accounts, { address: programDataPda, role: kit.AccountRole.READONLY }],
    };
    const { signature } = await client.send([ixWithProgramData]);
    protocolAction = `initialized (${signature})`;
    protocol = await sdk.fetchMaybeProtocolConfig(rpc, protocolPda);
    if (!protocol.exists) fail("ProtocolConfig still missing after initialize_protocol");
  }
  {
    const d = protocol.data;
    const actualOwners = d.multisigOwners.slice(0, d.multisigOwnersLen);
    const diffs = [];
    const check = (field, actual, expected) => {
      if (`${actual}` !== `${expected}`) diffs.push({ field, actual, expected });
    };
    check("authority", d.authority, signers.authority.address);
    check("treasury", d.treasury, signers.authority.address);
    check("disputeThreshold", d.disputeThreshold, PROTOCOL_PARAMS.disputeThreshold);
    check("protocolFeeBps", d.protocolFeeBps, PROTOCOL_PARAMS.protocolFeeBps);
    check("minAgentStake", d.minAgentStake, PROTOCOL_PARAMS.minStake);
    check("minStakeForDispute", d.minStakeForDispute, PROTOCOL_PARAMS.minStakeForDispute);
    check("multisigThreshold", d.multisigThreshold, PROTOCOL_PARAMS.multisigThreshold);
    check("multisigOwners", actualOwners.join("|"), expectedOwners.join("|"));
    if (diffs.length > 0) {
      fail(
        `ProtocolConfig ${protocolPda} EXISTS WITH DIFFERENT VALUES — refusing to converge:\n` +
          `${describeDiffs(diffs)}\n` +
          `  This ledger was initialized with other keys/parameters. Either restore the matching\n` +
          `  .localnet/keys/, or wipe and restart: node scripts/localnet-down.mjs --purge && node scripts/localnet-up.mjs`,
      );
    }
  }
  stepDone(protocolAction);
  console.log(
    `   ProtocolConfig ${protocolPda}: authority=${protocol.data.authority} feeBps=${protocol.data.protocolFeeBps} ` +
      `disputeThreshold=${protocol.data.disputeThreshold} minAgentStake=${protocol.data.minAgentStake} ` +
      `multisig=${protocol.data.multisigThreshold}/${protocol.data.multisigOwnersLen} version=${protocol.data.protocolVersion}`,
  );

  // -------------------------------------------- configure_task_moderation
  step("moderation config (configure_task_moderation)");
  const [moderationPda] = await sdk.findModerationConfigPda();
  let moderation = await sdk.fetchMaybeModerationConfig(rpc, moderationPda);
  let moderationAction = "verified existing";
  if (!moderation.exists) {
    const ix = await sdk.facade.configureTaskModeration({
      authority: signers.authority,
      moderationAuthority: signers.moderator.address,
      enabled: true,
    });
    const { signature } = await client.send([ix]);
    moderationAction = `initialized (${signature})`;
    moderation = await sdk.fetchMaybeModerationConfig(rpc, moderationPda);
    if (!moderation.exists) fail("ModerationConfig still missing after configure_task_moderation");
  }
  {
    const d = moderation.data;
    const diffs = [];
    if (d.moderationAuthority !== signers.moderator.address) {
      diffs.push({
        field: "moderationAuthority",
        actual: d.moderationAuthority,
        expected: signers.moderator.address,
      });
    }
    if (d.enabled !== true) {
      diffs.push({ field: "enabled", actual: d.enabled, expected: true });
    }
    if (diffs.length > 0) {
      fail(
        `ModerationConfig ${moderationPda} EXISTS WITH DIFFERENT VALUES — refusing to converge:\n` +
          `${describeDiffs(diffs)}\n` +
          `  Wipe and restart: node scripts/localnet-down.mjs --purge && node scripts/localnet-up.mjs`,
      );
    }
  }
  stepDone(moderationAction);
  console.log(
    `   ModerationConfig ${moderationPda}: moderationAuthority=${moderation.data.moderationAuthority} enabled=${moderation.data.enabled}`,
  );

  // ----------------------------------------------------------- env.json
  step(`environment file (${args.envFile})`);
  // Preserve a previously-recorded attestorUrl (the attestor is started
  // separately; up must not un-register it on converge).
  let attestorUrl = null;
  try {
    const previous = JSON.parse(await readFile(args.envFile, "utf8"));
    if (typeof previous.attestorUrl === "string" && previous.attestorUrl.length > 0) {
      attestorUrl = previous.attestorUrl;
    }
  } catch {
    // no previous env file — fresh write
  }
  const env = {
    cluster: "localnet",
    rpcUrl,
    rpcSubscriptionsUrl,
    programId,
    programSha256: soSha256,
    programSize: soBytes,
    attestorUrl,
    fixturesPath: FIXTURES_PATH,
    keypairs: {
      authority: keyPaths.authority,
      moderator: keyPaths.moderator,
      seeder: keyPaths.seeder,
    },
  };
  await mkdir(path.dirname(args.envFile), { recursive: true });
  const tmpPath = `${args.envFile}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(env, null, 2)}\n`);
  await rename(tmpPath, args.envFile);
  stepDone("written");

  // ------------------------------------------------------------- summary
  const totalSecs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nlocalnet is up (${totalSecs}s total)${booted ? "" : " — was already running"}.`);
  console.log(`  rpc:        ${rpcUrl}`);
  console.log(`  ws:         ${rpcSubscriptionsUrl}`);
  console.log(`  program:    ${programId} (upgradeable, authority=${signers.authority.address})`);
  console.log(`  env file:   ${args.envFile}`);
  console.log(`  attestor:   ${attestorUrl ?? "not running (attestorUrl=null)"}`);
  console.log("\nNext commands:");
  console.log("  node scripts/localnet-status.mjs                      # health + decoded configs");
  console.log(
    "  node packages/sdk-ts/scripts/seed-devnet-sandbox.mjs \\\n" +
      `      --rpc ${rpcUrl} \\\n` +
      "      --keypair .localnet/keys/seeder.json \\\n" +
      "      --moderator-keypair .localnet/keys/moderator.json  # seed providers + listings",
  );
  console.log(
    "  # attestor (optional): see docs/LOCALNET.md — storefront sandboxAttestor with\n" +
      `  #   SANDBOX_ATTESTOR_RPC_URL=${rpcUrl} SANDBOX_ATTESTOR_ALLOW_CUSTOM_RPC=true,\n` +
      "  #   then record its URL in the env file's attestorUrl.",
  );
  console.log("  node scripts/localnet-down.mjs [--purge]              # stop (and wipe ledger)");
}

main().catch((error) => {
  console.error(`\nlocalnet-up: ERROR: ${error?.stack ?? error}`);
  process.exit(1);
});
