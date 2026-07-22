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
//   node scripts/localnet-up.mjs [--port 8899] [--keep-ledger] [--dev-ready] [--env-file <path>]
//
//   --port <n>       Base RPC port (default 8899; reserves rpc through rpc+103)
//   --keep-ledger    do NOT --reset the validator ledger (keeps prior state)
//   --env-file <p>   where to write the environment file
//                    (default <repo>/.localnet/env.json)
//
// Requires: Linux 5.1+ with procfs, /usr/bin/python3 3.9+ with pidfd signalling
// and fcntl.flock lifecycle locking,
// solana-test-validator + solana-keygen on PATH, an `anchor build` .so at
// programs/agenc-coordination/target/deploy/agenc_coordination.so, and the built
// SDK at packages/sdk-ts/dist (cd packages/sdk-ts && npm run build).
import { spawnSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  archiveProcessIdentityFile,
  assertRecordedProcessIdentity,
  captureProcessIdentity,
  ensurePrivateStateDirectory,
  observeLinuxProcess,
  publishProcessIdentityFile,
  readProcessIdentityFile,
} from "./localnet-process-identity.mjs";
import {
  assertRaceFreeProcessSignallingAvailable,
  openLinuxProcessReference,
  signalProcessIfIdentityMatches,
} from "./localnet-process-signal.mjs";
import { startGuardedProcess } from "./localnet-guarded-spawn.mjs";
import { withLocalnetLifecycleLock } from "./localnet-lifecycle-lock.mjs";
import {
  LOCALNET_BID_MARKETPLACE_PARAMS,
  LOCALNET_PROTOCOL_PARAMS,
} from "./localnet-marketplace-policy.mjs";
import {
  LOCALNET_PROGRAM_DESCRIPTOR_PATH,
  LOCALNET_PROGRAM_ID,
  LOCALNET_PROGRAM_LOAD_METHOD,
} from "./localnet-program-binding.mjs";
import {
  assertLocalnetProgramAccountLinksProgramData,
  assertLocalnetProgramDataMatchesArtifact,
  captureLocalnetProgramArtifact,
  materializeLocalnetProgramSnapshot,
} from "./localnet-program-snapshot.mjs";
import {
  ensureValidatorLaunchIntentFile,
  readValidatorLaunchIntentFile,
  replaceValidatorLaunchIntentFile,
} from "./localnet-validator-launch.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = path.join(ROOT, ".localnet");
const LEDGER_DIR = path.join(STATE_DIR, "ledger");
const KEYS_DIR = path.join(STATE_DIR, "keys");
const LOGS_DIR = path.join(STATE_DIR, "logs");
const PID_FILE = path.join(STATE_DIR, "validator.pid");
const STOPPED_PID_FILE = path.join(STATE_DIR, "validator.stopped");
const STARTING_PID_FILE = path.join(STATE_DIR, "validator.starting");
const VALIDATOR_LOG = path.join(LOGS_DIR, "validator.log");
const UNSAFE_PROTOCOL_FIXTURE = path.join(
  STATE_DIR,
  "protocol-config.unpaused.fixture.json",
);
const DEFAULT_ENV_FILE = path.join(STATE_DIR, "env.json");
const FIXTURES_PATH = path.join(STATE_DIR, "fixtures.json");
const SO_PATH = path.join(
  ROOT,
  "programs/agenc-coordination/target/deploy/agenc_coordination.so",
);
const IDL_PATH = path.join(
  ROOT,
  "artifacts/anchor/idl/agenc_coordination.json",
);
const SDK_DIST = path.join(ROOT, "packages/sdk-ts/dist/index.js");
const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";

const KEY_NAMES = ["authority", "moderator", "seeder"];
const LAMPORTS_PER_SOL = 1_000_000_000n;
const AIRDROP_TARGET = 500n * LAMPORTS_PER_SOL; // generous local funding
const AIRDROP_FLOOR = 100n * LAMPORTS_PER_SOL; // top up below this

// Localnet protocol parameters. minStake is the program-enforced floor
// (MIN_REASONABLE_STAKE = 0.001 SOL in initialize_protocol.rs) — register_agent
// requires stake_amount >= this, so local seeding must stake >= 0.001 SOL.
const PROTOCOL_PARAMS = LOCALNET_PROTOCOL_PARAMS;
const BID_MARKETPLACE_PARAMS = LOCALNET_BID_MARKETPLACE_PARAMS;

function usage() {
  return [
    "localnet-up — boot + deploy + initialize the local AgenC stack",
    "",
    "USAGE",
    "  node scripts/localnet-up.mjs [--port 8899] [--keep-ledger] [--dev-ready] [--env-file <path>]",
    "  --port reserves RPC n, WS n+1, faucet n+2, gossip n+3, and dynamic n+4..n+103.",
    "  --dev-ready creates a fresh disposable, current-surface, unpaused local",
    "              marketplace for seeding/hiring. It intentionally bypasses",
    "              the production release-stamp ceremony and cannot keep a ledger.",
    "",
    "TEST-ONLY",
    "  --unsafe-unpaused-fixture  Legacy alias for --dev-ready used by browser tests.",
    "",
    "See docs/LOCALNET.md for the full local-stack runbook.",
  ].join("\n");
}

export function parseArgs(argv) {
  const args = {
    port: 8899,
    keepLedger: false,
    envFile: DEFAULT_ENV_FILE,
    devReady: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 65432) {
        throw new Error(
          `--port must be an integer in 1..65432, got: ${argv[i + 1]}`,
        );
      }
      args.port = value;
      i += 1;
    } else if (arg === "--keep-ledger") {
      args.keepLedger = true;
    } else if (arg === "--dev-ready" || arg === "--unsafe-unpaused-fixture") {
      args.devReady = true;
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
  if (args.keepLedger && args.devReady) {
    throw new Error(
      "--dev-ready requires a fresh disposable genesis and cannot be combined with --keep-ledger",
    );
  }
  return args;
}

export function expectedLocalnetProtocolMode(devReady, currentSurfaceRevision) {
  if (
    typeof devReady !== "boolean" ||
    !Number.isSafeInteger(currentSurfaceRevision) ||
    currentSurfaceRevision < 1
  ) {
    throw new TypeError("invalid localnet protocol-mode expectation");
  }
  return Object.freeze(
    devReady
      ? { protocolPaused: false, surfaceRevision: currentSurfaceRevision }
      : { protocolPaused: true, surfaceRevision: 0 },
  );
}

/**
 * A reset creates a different chain even though deterministic fixture paths
 * survive on disk. Remove only that stale cache: a live idempotent converge and
 * an explicit keep-ledger restart still describe the same chain.
 */
export async function invalidateFixturesAfterValidatorBoot(
  { booted, keepLedger },
  removeFixtures = () => rm(FIXTURES_PATH, { force: true }),
) {
  if (!booted || keepLedger) return false;
  await removeFixtures();
  return true;
}

/** Build the exact M-of-N-gated singleton initializer used by both modes. */
export function localnetBidMarketplaceInitializeInput(signers) {
  const authority = signers?.authority;
  const moderator = signers?.moderator;
  if (
    typeof authority?.address !== "string" ||
    typeof moderator?.address !== "string" ||
    authority.address === moderator.address
  ) {
    throw new TypeError(
      "localnet bid marketplace requires distinct authority and moderator signers",
    );
  }
  if (PROTOCOL_PARAMS.multisigThreshold !== 2) {
    throw new Error(
      "localnet bid marketplace signer policy requires a 2-of-N ProtocolConfig threshold",
    );
  }
  return {
    authority,
    multisigSigners: [authority, moderator],
    ...BID_MARKETPLACE_PARAMS,
  };
}

function discriminatorHex(value) {
  if (!(value instanceof Uint8Array)) return String(value);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Return every exact singleton mismatch so startup can refuse partial drift. */
export function localnetBidMarketplaceDiffs({
  account,
  expectedAuthority,
  expectedBump,
  expectedDiscriminator,
  programId = LOCALNET_PROGRAM_ID,
}) {
  if (!account?.exists) {
    return [{ field: "exists", actual: false, expected: true }];
  }
  const d = account.data ?? {};
  const diffs = [];
  const check = (field, actual, expected) => {
    if (`${actual}` !== `${expected}`) {
      diffs.push({ field, actual, expected });
    }
  };
  check("owner", account.programAddress, programId);
  check("executable", account.executable, false);
  check(
    "discriminator",
    discriminatorHex(d.discriminator),
    discriminatorHex(expectedDiscriminator),
  );
  check("authority", d.authority, expectedAuthority);
  check(
    "minBidBondLamports",
    d.minBidBondLamports,
    BID_MARKETPLACE_PARAMS.minBidBondLamports,
  );
  check(
    "bidCreationCooldownSecs",
    d.bidCreationCooldownSecs,
    BID_MARKETPLACE_PARAMS.bidCreationCooldownSecs,
  );
  check("maxBidsPer24h", d.maxBidsPer24h, BID_MARKETPLACE_PARAMS.maxBidsPer24h);
  check(
    "maxActiveBidsPerTask",
    d.maxActiveBidsPerTask,
    BID_MARKETPLACE_PARAMS.maxActiveBidsPerTask,
  );
  check(
    "maxBidLifetimeSecs",
    d.maxBidLifetimeSecs,
    BID_MARKETPLACE_PARAMS.maxBidLifetimeSecs,
  );
  check(
    "acceptedNoShowSlashBps",
    d.acceptedNoShowSlashBps,
    BID_MARKETPLACE_PARAMS.acceptedNoShowSlashBps,
  );
  check("bump", d.bump, expectedBump);
  return diffs;
}

function fail(message) {
  throw new Error(message);
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

function decodeCanonicalBase64AccountData(value, label) {
  const encoded = value?.data;
  if (
    !Array.isArray(encoded) ||
    encoded.length !== 2 ||
    encoded[1] !== "base64" ||
    typeof encoded[0] !== "string"
  ) {
    fail(`${label} RPC response did not contain canonical base64 account data`);
  }
  const bytes = Buffer.from(encoded[0], "base64");
  if (bytes.toString("base64") !== encoded[0]) {
    fail(`${label} RPC response contained malformed base64 account data`);
  }
  return bytes;
}

async function existingLedgerIsDirectory() {
  try {
    const metadata = await lstat(LEDGER_DIR);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail("localnet ledger must be a real non-symlink directory");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function artifactMatches(record, programSha256, programSize) {
  return (
    record?.programSha256 === programSha256 &&
    record?.programSize === programSize &&
    record?.programLoadMethod === LOCALNET_PROGRAM_LOAD_METHOD
  );
}

/** Fail before marker publication or spawn when generated surfaces drift. */
export function assertCanonicalProgramIdentity(idlProgramId, sdkProgramId) {
  if (
    idlProgramId !== LOCALNET_PROGRAM_ID ||
    sdkProgramId !== LOCALNET_PROGRAM_ID
  ) {
    fail(
      `program identity mismatch: canonical=${LOCALNET_PROGRAM_ID}, IDL=${idlProgramId}, SDK=${sdkProgramId}.\n` +
        "  Rebuild and synchronize the IDL + SDK before starting a validator.",
    );
  }
}

/** Refuse both reset and reuse when an existing ledger lacks prior proof. */
export function assertLedgerLaunchIsAttested({
  ledgerExists,
  keepLedger,
  stoppedMarker,
  startingMarker,
  programSha256,
  programSize,
}) {
  if (!ledgerExists) return;
  const evidence = [stoppedMarker, startingMarker].filter(
    (record) => record !== null && record !== undefined,
  );
  if (evidence.length === 0) {
    fail(
      "existing ledger has no prior stopped/startup lifecycle evidence; refusing to manufacture reset or reuse authority",
    );
  }
  if (
    keepLedger &&
    evidence.some(
      (record) => !artifactMatches(record, programSha256, programSize),
    )
  ) {
    fail(
      "--keep-ledger refused: prior lifecycle evidence does not prove the current program artifact is loaded; restart without --keep-ledger to perform an attested reset",
    );
  }
}

async function readPidFile() {
  return readProcessIdentityFile(PID_FILE, "validator");
}

function assertValidatorArgv(record, argv, programId) {
  const argument = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const upgrade = argv.indexOf("--upgradeable-program");
  if (
    path.resolve(argument("--ledger") ?? "") !== path.resolve(LEDGER_DIR) ||
    argument("--rpc-port") !== String(record.rpcPort) ||
    upgrade < 0 ||
    argv[upgrade + 1] !== programId ||
    argv[upgrade + 2] !== LOCALNET_PROGRAM_DESCRIPTOR_PATH
  ) {
    throw new Error(
      "validator stop refused: command line does not bind this repo ledger/program",
    );
  }
}

async function assertValidatorIdentity(record, programId, processReference) {
  return assertRecordedProcessIdentity(
    record,
    await observeLinuxProcess(record.pid, { processReference }),
    {
      executableBasename: "solana-test-validator",
      cwd: STATE_DIR,
      assertArgv: (argv) => assertValidatorArgv(record, argv, programId),
    },
  );
}

async function captureGuardedValidatorIdentity(
  pid,
  programId,
  processReference,
  extra,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await observeLinuxProcess(pid, { processReference });
    if (observed === null) {
      throw new Error(
        `validator pid ${pid} exited before identity publication`,
      );
    }
    if (observed.executable.split("/").at(-1) === "solana-test-validator") {
      assertValidatorArgv(extra, observed.argv, programId);
      const record = await captureProcessIdentity(pid, "validator", extra, {
        processReference,
      });
      if (
        !(await assertValidatorIdentity(record, programId, processReference))
      ) {
        throw new Error(
          `validator pid ${pid} exited before identity publication`,
        );
      }
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `guarded validator pid ${pid} did not exec solana-test-validator within ${timeoutMs}ms`,
  );
}

export async function stopPid(label, record, programId, dependencies = {}) {
  const assertIdentityForStop =
    dependencies.assertIdentity ??
    ((candidate, processReference) =>
      assertValidatorIdentity(candidate, programId, processReference));
  const openProcessReference = dependencies.openProcessReference;
  const sendSignal = dependencies.sendSignal;
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const termGraceMs = dependencies.termGraceMs ?? 10_000;
  const signalIfExact = (signal) =>
    signalProcessIfIdentityMatches(record, signal, {
      assertIdentity: assertIdentityForStop,
      ...(openProcessReference === undefined ? {} : { openProcessReference }),
      ...(sendSignal === undefined ? {} : { sendSignal }),
    });

  if (!(await signalIfExact("SIGTERM"))) return;
  const deadline = now() + termGraceMs;
  while (now() < deadline) {
    if (!(await assertIdentityForStop(record))) return;
    await sleep(200);
  }
  if (!(await signalIfExact("SIGKILL"))) return;
  await sleep(500);
  if (await assertIdentityForStop(record)) {
    fail(`${label} pid ${record.pid} is still alive after SIGKILL`);
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
    const socket = net.createConnection({
      host: "127.0.0.1",
      port,
      timeout: 1500,
    });
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

async function occupiedPorts(ports) {
  const results = await Promise.all(ports.map((port) => portOccupied(port)));
  return ports.filter((_, index) => results[index]);
}

/** A just-stopped validator can release its sockets a fraction after /proc exits. */
async function waitForPortsFree(ports, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let occupied = await occupiedPorts(ports);
  while (occupied.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    occupied = await occupiedPorts(ports);
  }
  return occupied;
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
  return diffs
    .map((d) => `  - ${d.field}: on-chain=${d.actual} expected=${d.expected}`)
    .join("\n");
}

/**
 * Write a solana-test-validator genesis account for the browser fixture only.
 *
 * A fresh production build correctly initializes paused at surface revision 0
 * and can become live only through the reviewed atomic stamp ceremony. The
 * React browser fixture is not a release rehearsal and does not have the IDL,
 * custody, and bid-config accounts that ceremony deliberately requires. This
 * explicit unsafe flag uses the same generated encoder as clients to inject a
 * current, unpaused ProtocolConfig into a disposable validator genesis. Normal
 * localnet and every deployed environment continue through initialize_protocol.
 */
async function writeUnsafeUnpausedProtocolFixture({
  kit,
  sdk,
  programId,
  signers,
}) {
  const [protocolPda, bump] = await sdk.findProtocolConfigPda();
  const defaultAddress = kit.address("11111111111111111111111111111111");
  const data = sdk.getProtocolConfigEncoder().encode({
    authority: signers.authority.address,
    treasury: signers.authority.address,
    disputeThreshold: PROTOCOL_PARAMS.disputeThreshold,
    protocolFeeBps: PROTOCOL_PARAMS.protocolFeeBps,
    minArbiterStake: PROTOCOL_PARAMS.minStake,
    minAgentStake: PROTOCOL_PARAMS.minStake,
    maxClaimDuration: 604_800n,
    maxDisputeDuration: 604_800n,
    totalAgents: 0n,
    totalTasks: 0n,
    completedTasks: 0n,
    totalValueDistributed: 0n,
    bump,
    multisigThreshold: PROTOCOL_PARAMS.multisigThreshold,
    multisigOwnersLen: 3,
    taskCreationCooldown: 60n,
    maxTasksPer24h: 50,
    disputeInitiationCooldown: 300n,
    maxDisputesPer24h: 10,
    minStakeForDispute: PROTOCOL_PARAMS.minStakeForDispute,
    slashPercentage: 25,
    stateUpdateCooldown: 60n,
    votingPeriod: 86_400n,
    protocolVersion: 1,
    minSupportedVersion: 1,
    protocolPaused: false,
    disabledTaskTypeMask: 0,
    multisigOwners: [
      signers.authority.address,
      signers.moderator.address,
      signers.seeder.address,
      defaultAddress,
      defaultAddress,
    ],
    surfaceRevision: sdk.SURFACE_REVISION_CURRENT,
  });

  const dump = {
    pubkey: String(protocolPda),
    account: {
      lamports: 10_000_000,
      data: [Buffer.from(data).toString("base64"), "base64"],
      owner: programId,
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  };
  await writeFile(
    UNSAFE_PROTOCOL_FIXTURE,
    `${JSON.stringify(dump, null, 2)}\n`,
  );
  return { address: String(protocolPda), path: UNSAFE_PROTOCOL_FIXTURE };
}

async function mainLocked(args, lifecycleLock) {
  const rpcUrl = `http://127.0.0.1:${args.port}`;
  const wsPort = args.port + 1;
  const faucetPort = args.port + 2;
  const gossipPort = args.port + 3;
  const dynamicPortRange = `${args.port + 4}-${args.port + 103}`;
  const rpcSubscriptionsUrl = `ws://127.0.0.1:${wsPort}`;

  console.log(`localnet-up: repo ${ROOT}`);

  // ---------------------------------------------------------------- preflight
  step("preflight (binaries, .so, SDK dist)");
  assertRaceFreeProcessSignallingAvailable();
  const validatorVersion = binaryOnPath("solana-test-validator");
  if (!validatorVersion) {
    fail(
      "solana-test-validator not found on PATH (install the Solana/Agave CLI tools).",
    );
  }
  if (!binaryOnPath("solana-keygen")) {
    fail(
      "solana-keygen not found on PATH (install the Solana/Agave CLI tools).",
    );
  }
  if (!(await fileExists(SO_PATH))) {
    fail(
      `program binary missing: ${SO_PATH}\n  Run \`anchor build\` from the repo root first (full surface, default features).`,
    );
  }
  const programArtifact = await captureLocalnetProgramArtifact(SO_PATH);
  const soBytes = programArtifact.size;
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
    fail(
      `IDL missing: ${IDL_PATH} (run \`anchor build && npm run artifacts:refresh\`).`,
    );
  }
  const soSha256 = programArtifact.sha256;
  const programId = JSON.parse(await readFile(IDL_PATH, "utf8")).address;
  if (!programId) fail(`IDL at ${IDL_PATH} has no .address field`);
  const sdk = await import(pathToFileURL(SDK_DIST).href);
  assertCanonicalProgramIdentity(
    programId,
    sdk.AGENC_COORDINATION_PROGRAM_ADDRESS,
  );
  stepDone(
    `${validatorVersion}; .so ${soBytes} bytes sha256=${soSha256.slice(0, 16)}; program ${programId}`,
  );

  // ------------------------------------------------------- state dir + keys
  step("state dir + keypairs (.localnet/)");
  await ensurePrivateStateDirectory(STATE_DIR);
  await mkdir(KEYS_DIR, { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });
  const keyPaths = Object.fromEntries(
    KEY_NAMES.map((name) => [name, path.join(KEYS_DIR, `${name}.json`)]),
  );
  const generated = [];
  for (const name of KEY_NAMES) {
    if (await ensureKeypair(keyPaths[name], name)) generated.push(name);
  }
  stepDone(
    generated.length ? `generated: ${generated.join(", ")}` : "all present",
  );

  const kit = await import("@solana/kit");
  const signers = {};
  for (const name of KEY_NAMES) {
    signers[name] = await loadSigner(kit, keyPaths[name]);
  }
  console.log(`   authority ${signers.authority.address}`);
  console.log(`   moderator ${signers.moderator.address}`);
  console.log(`   seeder    ${signers.seeder.address}`);

  let unsafeProtocolFixture = null;
  if (args.devReady) {
    unsafeProtocolFixture = await writeUnsafeUnpausedProtocolFixture({
      kit,
      sdk,
      programId,
      signers,
    });
    console.warn(
      `   LOCAL DEV ONLY: genesis-injecting current, unpaused ProtocolConfig ${unsafeProtocolFixture.address}`,
    );
  }

  // ------------------------------------------------------------- run check
  step(`validator on port ${args.port}`);
  let pidInfo = await readPidFile();
  let ourValidatorAlive =
    pidInfo !== null && (await assertValidatorIdentity(pidInfo, programId));
  let booted = false;

  if (ourValidatorAlive) {
    // A live managed identity supersedes either recovery marker. In
    // particular, a launcher can die after COMMIT acknowledgement but before
    // removing validator.starting; a later converge must finish that cleanup.
    await rm(STARTING_PID_FILE, { force: true });
    await rm(STOPPED_PID_FILE, { force: true });
  }

  const liveArtifactCurrent =
    ourValidatorAlive && artifactMatches(pidInfo, soSha256, soBytes);
  if (ourValidatorAlive && args.keepLedger && !liveArtifactCurrent) {
    fail(
      `--keep-ledger refused: live validator pid ${pidInfo.pid} is running a different program artifact.\n` +
        "  Re-run without --keep-ledger to stop it and perform an attested reset.",
    );
  }

  if (ourValidatorAlive && !args.keepLedger && !liveArtifactCurrent) {
    const stalePid = pidInfo.pid;
    const previous = pidInfo.programSha256
      ? pidInfo.programSha256.slice(0, 16)
      : "missing";
    await stopPid("validator", pidInfo, programId);
    await archiveProcessIdentityFile(PID_FILE, STOPPED_PID_FILE, "validator");
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
    let stoppedMarker = await readProcessIdentityFile(
      STOPPED_PID_FILE,
      "validator",
    );
    let startingMarker = await readValidatorLaunchIntentFile(
      STARTING_PID_FILE,
      {
        repoRoot: ROOT,
        ledgerDir: LEDGER_DIR,
        programId,
      },
    );
    if (pidInfo !== null) {
      // The exact managed process is gone, but its durable record is still the
      // proof that this ledger belonged to a script-managed validator.
      await archiveProcessIdentityFile(PID_FILE, STOPPED_PID_FILE, "validator");
      stoppedMarker = pidInfo;
      pidInfo = null;
    }
    const ledgerExists = await existingLedgerIsDirectory();
    assertLedgerLaunchIsAttested({
      ledgerExists,
      keepLedger: args.keepLedger,
      stoppedMarker,
      startingMarker,
      programSha256: soSha256,
      programSize: soBytes,
    });
    const stillOccupied = await waitForPortsFree([
      args.port,
      wsPort,
      faucetPort,
      gossipPort,
    ]);
    if (stillOccupied.length > 0) {
      fail(
        `port(s) ${stillOccupied.join(", ")} remain bound by a process that is NOT our validator.\n` +
          `  Stop it, or pass a different --port.`,
      );
    }

    // ------------------------------------------------------------- boot
    const validatorArgs = [
      "--ledger",
      LEDGER_DIR,
      "--rpc-port",
      String(args.port),
      "--faucet-port",
      String(faucetPort),
      "--gossip-port",
      String(gossipPort),
      "--dynamic-port-range",
      dynamicPortRange,
      "--quiet",
      // Genesis-load the program at the REAL program id as an UPGRADEABLE
      // program with a real ProgramData account and our authority as upgrade
      // authority — required by initialize_protocol's ProgramData check.
      // (Silently ignored when the ledger already exists, i.e. --keep-ledger.)
      "--upgradeable-program",
      programId,
      LOCALNET_PROGRAM_DESCRIPTOR_PATH,
      signers.authority.address,
    ];
    if (unsafeProtocolFixture !== null) {
      validatorArgs.push(
        "--account",
        unsafeProtocolFixture.address,
        unsafeProtocolFixture.path,
      );
    }
    if (!args.keepLedger) validatorArgs.unshift("--reset");

    // Keep prior proof until the replacement has a durable live identity. A
    // valid old starting marker is atomically rebound only for an attested
    // reset; keep-ledger requires every prior artifact binding to match.
    const launchIntent = {
      repoRoot: ROOT,
      ledgerDir: LEDGER_DIR,
      programId,
      programSha256: soSha256,
      programSize: soBytes,
      programLoadMethod: LOCALNET_PROGRAM_LOAD_METHOD,
    };
    if (
      startingMarker !== null &&
      !artifactMatches(startingMarker, soSha256, soBytes)
    ) {
      await replaceValidatorLaunchIntentFile(STARTING_PID_FILE, launchIntent);
    } else {
      await ensureValidatorLaunchIntentFile(STARTING_PID_FILE, launchIntent);
    }
    let logFd = openSync(VALIDATOR_LOG, "a");
    let guarded;
    let programSnapshot;
    let processReference;
    let commitAcknowledged = false;
    let startupError;
    try {
      programSnapshot = await materializeLocalnetProgramSnapshot(
        programArtifact,
        STATE_DIR,
      );
      guarded = await startGuardedProcess(
        "solana-test-validator",
        validatorArgs,
        {
          cwd: STATE_DIR,
          logFd,
          lifecycleLockFd: lifecycleLock.fd,
          pinnedInputFd: programSnapshot.fd,
        },
      );
      await programSnapshot.close();
      programSnapshot = undefined;
      const openedLogFd = logFd;
      logFd = undefined;
      closeSync(openedLogFd);

      processReference = openLinuxProcessReference(guarded.pid);
      if (processReference === null) {
        throw new Error(
          `guarded validator pid ${guarded.pid} exited before identity capture`,
        );
      }
      pidInfo = await captureGuardedValidatorIdentity(
        guarded.pid,
        programId,
        processReference,
        {
          rpcPort: args.port,
          programSha256: soSha256,
          programSize: soBytes,
          programLoadMethod: LOCALNET_PROGRAM_LOAD_METHOD,
        },
      );
      await publishProcessIdentityFile(PID_FILE, pidInfo);
      await guarded.commit();
      commitAcknowledged = true;
      await rm(STARTING_PID_FILE, { force: true });
      await rm(STOPPED_PID_FILE, { force: true });

      const deadline = Date.now() + 90_000;
      let healthy = false;
      while (Date.now() < deadline) {
        if (
          !(await assertValidatorIdentity(pidInfo, programId, processReference))
        ) {
          await archiveProcessIdentityFile(
            PID_FILE,
            STOPPED_PID_FILE,
            "validator",
          );
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
          `validator did not become healthy on ${rpcUrl} within 90s (pid ${guarded.pid}).\n` +
            `  Inspect ${VALIDATOR_LOG}, then \`node scripts/localnet-down.mjs\`.`,
        );
      }
      booted = true;
      stepDone(
        `booted pid ${guarded.pid}${args.keepLedger ? " (kept ledger)" : " (reset)"}`,
      );
    } catch (error) {
      startupError = error;
    }

    const cleanupErrors = [];
    if (
      startupError !== undefined &&
      guarded !== undefined &&
      !commitAcknowledged
    ) {
      try {
        await guarded.abort();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      processReference?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (programSnapshot !== undefined) {
      try {
        await programSnapshot.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (logFd !== undefined) {
      const openedLogFd = logFd;
      logFd = undefined;
      try {
        closeSync(openedLogFd);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (startupError !== undefined || cleanupErrors.length > 0) {
      const failures = [startupError, ...cleanupErrors].filter(
        (error) => error !== undefined,
      );
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(
        failures,
        "validator startup or guarded cleanup failed",
      );
    }
  }

  await invalidateFixturesAfterValidatorBoot({
    booted,
    keepLedger: args.keepLedger,
  });

  const rpc = kit.createSolanaRpc(rpcUrl);

  // ------------------------------------------ exact live program verification
  // This must precede every funded or initialization action. Lifecycle markers
  // bind the managed launch; these RPC reads prove what this ledger currently
  // stores even if someone attempted an out-of-band local program upgrade.
  step("program account check");
  const programInfo = await rpc
    .getAccountInfo(kit.address(programId), { encoding: "base64" })
    .send();
  if (
    !programInfo.value ||
    !programInfo.value.executable ||
    String(programInfo.value.owner) !== BPF_LOADER_UPGRADEABLE
  ) {
    fail(
      `program ${programId} is not an executable account on ${rpcUrl}.\n` +
        `  The ledger predates the genesis program load — re-run WITHOUT --keep-ledger (resets the ledger).`,
    );
  }
  const [programDataPda] = await kit.getProgramDerivedAddress({
    programAddress: kit.address(BPF_LOADER_UPGRADEABLE),
    seeds: [kit.getAddressEncoder().encode(kit.address(programId))],
  });
  assertLocalnetProgramAccountLinksProgramData(
    decodeCanonicalBase64AccountData(programInfo.value, "Program"),
    kit.getAddressEncoder().encode(programDataPda),
  );
  const programDataInfo = await rpc
    .getAccountInfo(programDataPda, { encoding: "base64" })
    .send();
  if (
    !programDataInfo.value ||
    programDataInfo.value.executable ||
    String(programDataInfo.value.owner) !== BPF_LOADER_UPGRADEABLE
  ) {
    fail(
      `ProgramData ${programDataPda} missing — the program was not loaded as UPGRADEABLE.\n` +
        `  Re-run without --keep-ledger so genesis uses --upgradeable-program.`,
    );
  }
  assertLocalnetProgramDataMatchesArtifact(
    programArtifact,
    decodeCanonicalBase64AccountData(programDataInfo.value, "ProgramData"),
    kit.getAddressEncoder().encode(signers.authority.address),
  );
  stepDone(
    `executable at ${programId}; ProgramData ${programDataPda}; exact .so verified`,
  );

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
      fail(
        `airdrop to ${name} (${address}) did not land within 30s (balance ${final}).`,
      );
    }
    funded.push(`${name}=${final / LAMPORTS_PER_SOL}SOL`);
  }
  stepDone(funded.join(" "));

  // ------------------------------------------------- initialize_protocol
  step("protocol config (initialize_protocol)");
  const client = sdk.createMarketplaceClient({
    rpcUrl,
    signer: signers.authority,
  });
  const expectedOwners = [
    signers.authority.address,
    signers.moderator.address,
    signers.seeder.address,
  ];
  const [protocolPda] = await sdk.findProtocolConfigPda();
  let protocol = await sdk.fetchMaybeProtocolConfig(rpc, protocolPda);
  let protocolAction = args.devReady
    ? "verified LOCAL-DEV genesis fixture"
    : "verified existing";
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
      accounts: [
        ...ix.accounts,
        { address: programDataPda, role: kit.AccountRole.READONLY },
      ],
    };
    const { signature } = await client.send([ixWithProgramData]);
    protocolAction = `initialized (${signature})`;
    protocol = await sdk.fetchMaybeProtocolConfig(rpc, protocolPda);
    if (!protocol.exists)
      fail("ProtocolConfig still missing after initialize_protocol");
  }
  {
    const d = protocol.data;
    const actualOwners = d.multisigOwners.slice(0, d.multisigOwnersLen);
    const diffs = [];
    const check = (field, actual, expected) => {
      if (`${actual}` !== `${expected}`)
        diffs.push({ field, actual, expected });
    };
    check("authority", d.authority, signers.authority.address);
    check("treasury", d.treasury, signers.authority.address);
    check(
      "disputeThreshold",
      d.disputeThreshold,
      PROTOCOL_PARAMS.disputeThreshold,
    );
    check("protocolFeeBps", d.protocolFeeBps, PROTOCOL_PARAMS.protocolFeeBps);
    check("minAgentStake", d.minAgentStake, PROTOCOL_PARAMS.minStake);
    check(
      "minStakeForDispute",
      d.minStakeForDispute,
      PROTOCOL_PARAMS.minStakeForDispute,
    );
    check(
      "multisigThreshold",
      d.multisigThreshold,
      PROTOCOL_PARAMS.multisigThreshold,
    );
    check("multisigOwners", actualOwners.join("|"), expectedOwners.join("|"));
    const expectedMode = expectedLocalnetProtocolMode(
      args.devReady,
      sdk.SURFACE_REVISION_CURRENT,
    );
    check("protocolPaused", d.protocolPaused, expectedMode.protocolPaused);
    check("surfaceRevision", d.surfaceRevision, expectedMode.surfaceRevision);
    if (diffs.length > 0) {
      fail(
        `ProtocolConfig ${protocolPda} EXISTS WITH DIFFERENT VALUES — refusing to converge:\n` +
          `${describeDiffs(diffs)}\n` +
          `  This ledger was initialized with other keys/parameters. Either restore the matching\n` +
          `  .localnet/keys/, or wipe and restart: node scripts/localnet-down.mjs --purge && ` +
          `node scripts/localnet-up.mjs${args.devReady ? " --dev-ready" : ""}`,
      );
    }
  }
  stepDone(protocolAction);
  console.log(
    `   ProtocolConfig ${protocolPda}: authority=${protocol.data.authority} feeBps=${protocol.data.protocolFeeBps} ` +
      `disputeThreshold=${protocol.data.disputeThreshold} minAgentStake=${protocol.data.minAgentStake} ` +
      `multisig=${protocol.data.multisigThreshold}/${protocol.data.multisigOwnersLen} version=${protocol.data.protocolVersion}`,
  );

  // ------------------------------------------ initialize_bid_marketplace
  step("bid marketplace config (initialize_bid_marketplace)");
  const [bidMarketplacePda, bidMarketplaceBump] =
    await sdk.findBidMarketplacePda();
  let bidMarketplace = await sdk.fetchMaybeBidMarketplaceConfig(
    rpc,
    bidMarketplacePda,
  );
  let bidMarketplaceAction = "verified existing";
  if (!bidMarketplace.exists) {
    const ix = await sdk.facade.initializeBidMarketplace(
      localnetBidMarketplaceInitializeInput(signers),
    );
    const { signature } = await client.send([ix]);
    bidMarketplaceAction = `initialized (${signature})`;
    bidMarketplace = await sdk.fetchMaybeBidMarketplaceConfig(
      rpc,
      bidMarketplacePda,
    );
    if (!bidMarketplace.exists) {
      fail(
        "BidMarketplaceConfig still missing after initialize_bid_marketplace",
      );
    }
  }
  {
    const diffs = localnetBidMarketplaceDiffs({
      account: bidMarketplace,
      expectedAuthority: signers.authority.address,
      expectedBump: bidMarketplaceBump,
      expectedDiscriminator: sdk.BID_MARKETPLACE_CONFIG_DISCRIMINATOR,
      programId,
    });
    if (diffs.length > 0) {
      fail(
        `BidMarketplaceConfig ${bidMarketplacePda} EXISTS WITH DIFFERENT VALUES — refusing to converge:\n` +
          `${describeDiffs(diffs)}\n` +
          `  This singleton must exactly match the reviewed local marketplace policy. Wipe and restart:\n` +
          `  node scripts/localnet-down.mjs --purge && node scripts/localnet-up.mjs${args.devReady ? " --dev-ready" : ""}`,
      );
    }
  }
  stepDone(bidMarketplaceAction);
  console.log(
    `   BidMarketplaceConfig ${bidMarketplacePda}: authority=${bidMarketplace.data.authority} ` +
      `minBidBondLamports=${bidMarketplace.data.minBidBondLamports} ` +
      `cooldown=${bidMarketplace.data.bidCreationCooldownSecs}s ` +
      `maxPer24h=${bidMarketplace.data.maxBidsPer24h} ` +
      `maxActivePerTask=${bidMarketplace.data.maxActiveBidsPerTask} ` +
      `maxLifetime=${bidMarketplace.data.maxBidLifetimeSecs}s ` +
      `noShowSlashBps=${bidMarketplace.data.acceptedNoShowSlashBps}`,
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
    if (!moderation.exists)
      fail("ModerationConfig still missing after configure_task_moderation");
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
          `  Wipe and restart: node scripts/localnet-down.mjs --purge && node scripts/localnet-up.mjs${args.devReady ? " --dev-ready" : ""}`,
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
    if (
      typeof previous.attestorUrl === "string" &&
      previous.attestorUrl.length > 0
    ) {
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
  console.log(
    `\nlocalnet is up (${totalSecs}s total)${booted ? "" : " — was already running"}.`,
  );
  console.log(
    `  mode:       ${args.devReady ? "DEV READY (disposable local fixture)" : "PRODUCTION-FROZEN initialization rehearsal"}`,
  );
  console.log(`  rpc:        ${rpcUrl}`);
  console.log(`  ws:         ${rpcSubscriptionsUrl}`);
  console.log(
    `  program:    ${programId} (upgradeable, authority=${signers.authority.address})`,
  );
  console.log(`  env file:   ${args.envFile}`);
  console.log(
    `  attestor:   ${attestorUrl ?? "not running (attestorUrl=null)"}`,
  );
  console.log("\nNext commands:");
  console.log(
    "  node scripts/localnet-status.mjs                      # integrity + marketplace readiness",
  );
  if (args.devReady) {
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
  } else {
    console.warn(
      "  MARKETPLACE INTENTIONALLY PAUSED: this mode validates production-frozen initialization.\n" +
        "  New registrations/listings/hires will fail. For disposable development:\n" +
        "    node scripts/localnet-down.mjs --purge && node scripts/localnet-up.mjs --dev-ready",
    );
  }
  console.log(
    "  node scripts/localnet-down.mjs [--purge]              # stop (and wipe ledger)",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await withLocalnetLifecycleLock(STATE_DIR, (lifecycleLock) =>
    mainLocked(args, lifecycleLock),
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`\nlocalnet-up: ERROR: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
