#!/usr/bin/env node
// localnet-mac.mjs: a disposable local validator for client runs on macOS.
//
// The Linux rail (localnet-up, localnet-status, localnet-down) proves process
// identity through procfs, pidfd and flock, which macOS does not have. This
// launcher boots the same disposable "--dev-ready" marketplace on a Mac so the
// RPC e2e suites, credible-exit.mjs and the revision 9 localnet scenarios can
// run there:
//
//   - the program genesis-loaded at the real program id as an upgradeable
//     program, with a throwaway upgrade authority;
//   - an unpaused ProtocolConfig at the SDK's current surface, injected at
//     genesis with the shared local policy and 2 of 3 local owners
//     (authority, moderator, seeder);
//   - the bid marketplace and the task moderation config, set up with 2 of 3;
//   - .localnet/env.json in the schema localnet-up writes, plus the launcher,
//     the program profile, the genesis hash and the program's sha256.
//
// It never builds a program (--so names the binary) and never reads a wallet:
// its three keys are generated here and are disposable. It passes --mint so the
// validator never looks for a CLI keypair. Linux CI keeps localnet-up.
//
// USAGE
//   node scripts/localnet-mac.mjs up --validator <solana-test-validator>
//        --so <program.so> --ledger <dir> [--port 8899] [--short-disputes]
//        [--profile production|validation-timings]
//   node scripts/localnet-mac.mjs status
//   node scripts/localnet-mac.mjs compact [--if-wal-over <MB>]
//   node scripts/localnet-mac.mjs down [--purge]
//
// COMPACT. This validator keeps RocksDB write-ahead logs until they reach
// 4 GiB, whatever --limit-ledger-size says, and an idle localnet writes about
// 1.6 MB of shreds a second. `compact` restarts the validator on the same
// ledger (no --reset): RocksDB flushes on recovery and drops the old logs, and
// the accounts, the program, the clock and the faucet carry on. RPC is down for
// a few seconds, so call it only between suites or from a wait that rides out
// the outage. With --if-wal-over it restarts only when the logs are larger.
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { closeSync, openSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOCALNET_PROTOCOL_PARAMS,
} from "./localnet-marketplace-policy.mjs";
import { localnetBidMarketplaceInitializeInput } from "./localnet-up.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(ROOT, ".localnet");
const KEYS_DIR = path.join(STATE_DIR, "keys");
const ENV_FILE = path.join(STATE_DIR, "env.json");
const PID_FILE = path.join(STATE_DIR, "validator-mac.json");
const COMPACT_LOCK = path.join(STATE_DIR, "compact.lock");
const COMPACT_HOLD = path.join(STATE_DIR, "compact.hold");
const FIXTURE = path.join(STATE_DIR, "protocol-config.mac.fixture.json");
const IDL_PATH = path.join(ROOT, "artifacts/anchor/idl/agenc_coordination.json");
const SDK_DIST = path.join(ROOT, "packages/sdk-ts/dist/index.js");
const KEY_NAMES = ["authority", "moderator", "seeder"];
const SOL = 1_000_000_000n;
// The ledger keeps this many shreds of rooted slots and purges older ones. The
// suites need only recent history (a fee lookup right after a send, an event
// poll after a wait); a large limit lets the ledger grow by gigabytes an hour
// under test load.
const LEDGER_SHREDS = "200000";
const PROGRAMDATA_HEADER = 45;

/** A refusal with a plain message; thrown, so locks and cleanups still run. */
class LocalnetMacError extends Error {}

function fail(message) {
  throw new LocalnetMacError(message);
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {
    command,
    port: 8899,
    shortDisputes: false,
    profile: "production",
    purge: false,
    ifWalOverMb: null,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === "--validator") args.validator = path.resolve(value), (index += 1);
    else if (flag === "--so") args.so = path.resolve(value), (index += 1);
    else if (flag === "--ledger") args.ledger = path.resolve(value), (index += 1);
    else if (flag === "--port") args.port = Number(value), (index += 1);
    else if (flag === "--profile") args.profile = value, (index += 1);
    else if (flag === "--short-disputes") args.shortDisputes = true;
    else if (flag === "--purge") args.purge = true;
    else if (flag === "--if-wal-over") args.ifWalOverMb = Number(value), (index += 1);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!["up", "status", "compact", "down"].includes(command)) {
    throw new Error("the command is up, status, compact or down");
  }
  if (args.ifWalOverMb !== null && !(args.ifWalOverMb >= 0)) {
    throw new Error("--if-wal-over takes a size in MB");
  }
  if (!["production", "validation-timings"].includes(args.profile)) {
    throw new Error("--profile is production or validation-timings");
  }
  if (command === "up") {
    for (const required of ["validator", "so", "ledger"]) {
      if (!args[required]) throw new Error(`up needs --${required}`);
    }
    if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65_000) {
      throw new Error("--port must be an integer from 1024 to 65000");
    }
  }
  return args;
}

/** A disposable Solana keypair as the 64-byte JSON array the CLI writes. */
function newKeypairBytes() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return [...seed, ...pub];
}

async function sdkModules() {
  const kit = await import("@solana/kit");
  const sdk = await import(pathToFileURL(SDK_DIST).href);
  return { kit, sdk };
}

async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) fail(`${label} did not happen within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Bytes of RocksDB write-ahead log in a ledger. */
export function walBytes(ledger) {
  const dir = path.join(ledger, "rocksdb");
  let total = 0;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".log")) total += statSync(path.join(dir, name)).size;
  }
  return total;
}

function startValidator(validator, validatorArgs, ledger, log, append) {
  const out = openSync(log, append ? "a" : "w");
  const child = spawn(validator, validatorArgs, {
    cwd: path.dirname(ledger),
    detached: true,
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  child.unref();
  return child.pid;
}

async function stopValidator(pid) {
  if (!alive(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 20_000;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (alive(pid)) process.kill(pid, "SIGKILL");
}

async function waitReady(kit, rpcUrl, programId) {
  const rpc = kit.createSolanaRpc(rpcUrl);
  await waitFor(async () => (await rpc.getHealth().send()) === "ok", 90_000, "validator health");
  await waitFor(
    async () => (await rpc.getAccountInfo(kit.address(programId), { encoding: "base64" }).send()).value !== null,
    60_000,
    "the program account",
  );
  return rpc;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function up(args) {
  const { kit, sdk } = await sdkModules();
  if ((await stat(args.so).catch(() => null)) === null) fail(`no program at ${args.so}`);
  const previous = await readFile(PID_FILE, "utf8").then(JSON.parse, () => null);
  if (previous !== null && alive(previous.pid)) {
    fail(`a validator started here is still running (pid ${previous.pid}); run down first`);
  }
  const programId = JSON.parse(await readFile(IDL_PATH, "utf8")).address;
  if (programId !== sdk.AGENC_COORDINATION_PROGRAM_ADDRESS) {
    fail("the IDL and the SDK disagree on the program id");
  }
  await mkdir(KEYS_DIR, { recursive: true });
  const keypairs = {};
  const signers = {};
  for (const name of KEY_NAMES) {
    const file = path.join(KEYS_DIR, `${name}.json`);
    const bytes = newKeypairBytes();
    await writeFile(file, `${JSON.stringify(bytes)}\n`, { mode: 0o600 });
    keypairs[name] = file;
    signers[name] = await kit.createKeyPairSignerFromBytes(Uint8Array.from(bytes));
  }

  // The same dev-ready ProtocolConfig localnet-up injects at genesis.
  const params = LOCALNET_PROTOCOL_PARAMS;
  const [protocolPda, bump] = await sdk.findProtocolConfigPda();
  const none = kit.address("11111111111111111111111111111111");
  const data = sdk.getProtocolConfigEncoder().encode({
    authority: signers.authority.address,
    treasury: signers.authority.address,
    disputeThreshold: params.disputeThreshold,
    protocolFeeBps: params.protocolFeeBps,
    minArbiterStake: params.minStake,
    minAgentStake: params.minStake,
    maxClaimDuration: 604_800n,
    maxDisputeDuration: args.shortDisputes ? 600n : 604_800n,
    totalAgents: 0n,
    totalTasks: 0n,
    completedTasks: 0n,
    totalValueDistributed: 0n,
    bump,
    multisigThreshold: params.multisigThreshold,
    multisigOwnersLen: 3,
    taskCreationCooldown: 60n,
    maxTasksPer24h: 50,
    disputeInitiationCooldown: 300n,
    maxDisputesPer24h: 10,
    minStakeForDispute: params.minStakeForDispute,
    slashPercentage: 25,
    stateUpdateCooldown: 60n,
    votingPeriod: args.shortDisputes ? 300n : 86_400n,
    protocolVersion: 1,
    minSupportedVersion: 1,
    protocolPaused: false,
    disabledTaskTypeMask: 0,
    multisigOwners: [
      signers.authority.address,
      signers.moderator.address,
      signers.seeder.address,
      none,
      none,
    ],
    surfaceRevision: sdk.SURFACE_REVISION_CURRENT,
  });
  await writeFile(
    FIXTURE,
    `${JSON.stringify(
      {
        pubkey: String(protocolPda),
        account: {
          lamports: 10_000_000,
          data: [Buffer.from(data).toString("base64"), "base64"],
          owner: programId,
          executable: false,
          rentEpoch: 0,
          space: data.length,
        },
      },
      null,
      2,
    )}\n`,
  );

  await rm(args.ledger, { recursive: true, force: true });
  await mkdir(args.ledger, { recursive: true });
  const log = path.join(path.dirname(args.ledger), `${path.basename(args.ledger)}.log`);
  const validatorArgs = [
    "--reset",
    "--ledger", args.ledger,
    "--limit-ledger-size", LEDGER_SHREDS,
    "--mint", signers.seeder.address,
    "--rpc-port", String(args.port),
    "--faucet-port", String(args.port + 2),
    "--gossip-port", String(args.port + 3),
    "--dynamic-port-range", `${args.port + 4}-${args.port + 103}`,
    "--quiet",
    "--upgradeable-program", programId, args.so, signers.authority.address,
    "--account", String(protocolPda), FIXTURE,
  ];
  const pid = startValidator(args.validator, validatorArgs, args.ledger, log, false);
  await writeFile(
    PID_FILE,
    `${JSON.stringify({ pid, ledger: args.ledger, log, port: args.port, validator: args.validator, validatorArgs })}\n`,
  );

  const rpcUrl = `http://127.0.0.1:${args.port}`;
  const rpc = await waitReady(kit, rpcUrl, programId);

  for (const name of ["authority", "moderator"]) {
    await rpc.requestAirdrop(signers[name].address, kit.lamports(500n * SOL)).send();
  }
  await waitFor(async () => {
    for (const name of ["authority", "moderator"]) {
      const { value } = await rpc.getBalance(signers[name].address).send();
      if (BigInt(value) < 100n * SOL) return false;
    }
    return true;
  }, 30_000, "the airdrops");

  const client = sdk.createMarketplaceClient({ rpcUrl, signer: signers.authority });
  await client.send([
    await sdk.facade.initializeBidMarketplace(localnetBidMarketplaceInitializeInput(signers)),
  ]);
  // Revision 9 (G): configure_task_moderation needs 2 of the 3 owners.
  await client.send([
    await sdk.facade.configureTaskModeration({
      authority: signers.authority,
      moderationAuthority: signers.moderator.address,
      enabled: true,
      multisigSigners: [signers.authority, signers.moderator],
    }),
  ]);

  const programSha256 = await sha256File(args.so);
  const env = {
    cluster: "localnet",
    launcher: "localnet-mac",
    programProfile: args.profile,
    shortDisputes: args.shortDisputes,
    rpcUrl,
    rpcSubscriptionsUrl: `ws://127.0.0.1:${args.port + 1}`,
    programId,
    programSha256,
    programSize: (await stat(args.so)).size,
    genesisHash: await rpc.getGenesisHash().send(),
    attestorUrl: null,
    deactivatedFeatures: [],
    fixturesPath: path.join(STATE_DIR, "fixtures.json"),
    keypairs,
  };
  await writeFile(ENV_FILE, `${JSON.stringify(env, null, 2)}\n`);
  console.log(
    `localnet-mac: up on ${rpcUrl} (pid ${pid}, ${args.profile}${args.shortDisputes ? ", short disputes" : ""}, program ${programSha256.slice(0, 12)})`,
  );
}

/** The launcher's own checks, in place of the Linux status rail. */
async function status() {
  const { kit } = await sdkModules();
  const env = JSON.parse(await readFile(ENV_FILE, "utf8"));
  const record = await readFile(PID_FILE, "utf8").then(JSON.parse, () => null);
  if (record === null) fail("no validator was started here; run up first");
  if (env.launcher !== "localnet-mac") fail("env.json was not written by localnet-mac");
  const url = new URL(env.rpcUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") fail("the RPC is not loopback");
  if (!alive(record.pid)) fail(`validator pid ${record.pid} is not running`);
  const rpc = kit.createSolanaRpc(env.rpcUrl);
  if ((await rpc.getHealth().send()) !== "ok") fail("the validator is not healthy");
  if ((await rpc.getGenesisHash().send()) !== env.genesisHash) {
    fail("the RPC answers with another genesis than the one this launcher booted");
  }
  const program = (await rpc.getAccountInfo(kit.address(env.programId), { encoding: "base64" }).send()).value;
  if (program === null) fail("the program account is missing");
  const programData = kit.getAddressDecoder().decode(
    Buffer.from(program.data[0], "base64").subarray(4, 36),
  );
  const data = (await rpc.getAccountInfo(programData, { encoding: "base64" }).send()).value;
  if (data === null) fail("the program data account is missing");
  const bytes = Buffer.from(data.data[0], "base64").subarray(PROGRAMDATA_HEADER, PROGRAMDATA_HEADER + env.programSize);
  if (createHash("sha256").update(bytes).digest("hex") !== env.programSha256) {
    fail("the deployed program is not the binary this launcher booted");
  }
  console.log(`localnet-mac: ok (pid ${record.pid}, ${env.programProfile})`);
}

/**
 * One compaction at a time across processes (two suites may wait at once): a
 * caller that finds the lock waits for the holder and returns, since the log
 * the holder dropped was the same log.
 */
async function withCompactLock(run) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(COMPACT_LOCK);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const held = await stat(COMPACT_LOCK).catch(() => null);
      if (held !== null && Date.now() - held.mtimeMs > 300_000) {
        await rm(COMPACT_LOCK, { recursive: true, force: true });
        continue;
      }
      if (attempt === 0) console.log("localnet-mac: another caller is compacting; waiting for it");
      if (attempt > 720) fail("the compaction lock was not released within 6 minutes");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if ((await stat(COMPACT_LOCK).catch(() => null)) === null) {
        console.log("localnet-mac: compacted by another caller");
        return;
      }
    }
  }
  try {
    await run();
  } finally {
    await rm(COMPACT_LOCK, { recursive: true, force: true });
  }
}

/** Restart on the same ledger so RocksDB drops its old write-ahead logs. */
async function compact(args) {
  await withCompactLock(() => compactUnlocked(args));
}

async function compactUnlocked(args) {
  // A run that has several suites on one validator holds compaction while any
  // of them is still sending (.localnet/compact.hold); the waits retry.
  if ((await stat(COMPACT_HOLD).catch(() => null)) !== null) {
    console.log("localnet-mac: compaction is held; no restart");
    return;
  }
  const { kit } = await sdkModules();
  const env = JSON.parse(await readFile(ENV_FILE, "utf8"));
  const record = await readFile(PID_FILE, "utf8").then(JSON.parse, () => null);
  if (record === null) fail("no validator was started here; run up first");
  if (env.launcher !== "localnet-mac") fail("env.json was not written by localnet-mac");
  if (!alive(record.pid)) fail(`validator pid ${record.pid} is not running`);
  const before = walBytes(record.ledger);
  if (args.ifWalOverMb !== null && before <= args.ifWalOverMb * 1_000_000) {
    console.log(`localnet-mac: write-ahead log ${(before / 1e6).toFixed(0)} MB, no restart`);
    return;
  }
  const resumeArgs = record.validatorArgs.filter((arg) => arg !== "--reset");
  const started = Date.now();
  // Right after a restart the RPC can answer from the genesis bank for a
  // moment (slot 0, the genesis clock); ready means back past this slot.
  const lastSlot = await kit.createSolanaRpc(env.rpcUrl).getSlot({ commitment: "confirmed" }).send();
  await stopValidator(record.pid);
  const pid = startValidator(record.validator, resumeArgs, record.ledger, record.log, true);
  await writeFile(PID_FILE, `${JSON.stringify({ ...record, pid })}\n`);
  const rpc = await waitReady(kit, env.rpcUrl, env.programId);
  await waitFor(
    async () => (await rpc.getSlot({ commitment: "confirmed" }).send()) > lastSlot,
    120_000,
    "the restarted validator to pass its last slot",
  );
  if ((await rpc.getGenesisHash().send()) !== env.genesisHash) {
    fail("the restarted validator answers with another genesis");
  }
  console.log(
    `localnet-mac: compacted (pid ${pid}, write-ahead log ${(before / 1e6).toFixed(0)} MB -> ${(walBytes(record.ledger) / 1e6).toFixed(0)} MB, ${((Date.now() - started) / 1000).toFixed(0)} s)`,
  );
}

async function down(args) {
  const record = await readFile(PID_FILE, "utf8").then(JSON.parse, () => null);
  if (record === null) {
    console.log("localnet-mac: nothing to stop");
    return;
  }
  await stopValidator(record.pid);
  await rm(PID_FILE, { force: true });
  if (args.purge) await rm(record.ledger, { recursive: true, force: true });
  console.log(`localnet-mac: stopped pid ${record.pid}${args.purge ? ", ledger removed" : ""}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const main = async () => {
    let args;
    try {
      args = parseArgs(process.argv.slice(2));
    } catch (error) {
      fail(error.message);
    }
    if (args.command === "up") return up(args);
    if (args.command === "status") return status();
    if (args.command === "compact") return compact(args);
    return down(args);
  };
  main().catch((error) => {
    console.error(
      `localnet-mac: ${error instanceof LocalnetMacError ? error.message : (error?.stack ?? String(error))}`,
    );
    process.exit(1);
  });
}
