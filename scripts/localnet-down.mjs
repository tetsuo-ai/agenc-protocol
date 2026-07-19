#!/usr/bin/env node
// localnet-down.mjs — stop the local AgenC stack started by localnet-up.mjs.
//
// Gracefully stops the validator (SIGTERM, then SIGKILL after 10s) and, if an
// attestor pid file exists (.localnet/attestor.pid), the attestor too.
//
// Usage:
//   node scripts/localnet-down.mjs [--purge]
//
//   --purge   additionally remove the validator ledger (.localnet/ledger) so
//             the next up is a clean genesis. Keys and env.json are kept.
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertRecordedProcessIdentity,
  observeLinuxProcess,
  readProcessIdentityFile,
} from "./localnet-process-identity.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = path.join(ROOT, ".localnet");
const LEDGER_DIR = path.join(STATE_DIR, "ledger");
const SO_PATH = path.join(
  ROOT,
  "programs/agenc-coordination/target/deploy/agenc_coordination.so",
);
const PROGRAM_ID = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
const PID_FILES = [
  { label: "validator", file: path.join(STATE_DIR, "validator.pid") },
  { label: "attestor", file: path.join(STATE_DIR, "attestor.pid") },
];

function parseArgs(argv) {
  const args = { purge: false };
  for (const arg of argv) {
    if (arg === "--purge") args.purge = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/localnet-down.mjs [--purge]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

function validatorArgv(record, argv) {
  const argument = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const upgrade = argv.indexOf("--upgradeable-program");
  if (
    path.resolve(argument("--ledger") ?? "") !== path.resolve(LEDGER_DIR) ||
    argument("--rpc-port") !== String(record.rpcPort) ||
    upgrade < 0 ||
    argv[upgrade + 1] !== PROGRAM_ID ||
    path.resolve(argv[upgrade + 2] ?? "") !== path.resolve(SO_PATH)
  ) {
    throw new Error("validator shutdown refused: command line does not bind this repo ledger/program");
  }
}

async function assertIdentity(record) {
  const observed = await observeLinuxProcess(record.pid);
  return assertRecordedProcessIdentity(record, observed, record.role === "validator"
    ? {
        executableBasename: "solana-test-validator",
        cwd: STATE_DIR,
        assertArgv: (argv) => validatorArgv(record, argv),
      }
    : { executableBasename: "node" });
}

async function stopProcess(label, record) {
  if (!(await assertIdentity(record))) {
    console.log(`${label}: pid ${record.pid} not running (stale identity file removed)`);
    return;
  }
  process.kill(record.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await assertIdentity(record))) {
      console.log(`${label}: pid ${record.pid} stopped (SIGTERM)`);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Revalidate immediately before escalation. If the PID was reused during the
  // grace period, assertIdentity refuses instead of signalling the new process.
  await assertIdentity(record);
  process.kill(record.pid, "SIGKILL");
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline) {
    if (!(await assertIdentity(record))) {
      console.log(`${label}: pid ${record.pid} killed (SIGKILL)`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label}: verified pid ${record.pid} is still alive after SIGKILL`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let anyFound = false;

  for (const { label, file } of PID_FILES) {
    const record = await readProcessIdentityFile(file, label);
    if (record === null) continue;
    anyFound = true;
    await stopProcess(label, record);
    await rm(file, { force: true });
  }
  if (!anyFound) {
    console.log("localnet-down: no pid files found — nothing to stop.");
  }

  if (args.purge) {
    await rm(LEDGER_DIR, { recursive: true, force: true });
    console.log(`purged ledger: ${LEDGER_DIR}`);
    console.log("(keys and env.json kept; next `localnet-up` is a fresh genesis + re-init)");
  }
}

main().catch((error) => {
  console.error(`localnet-down: ERROR: ${error?.stack ?? error}`);
  process.exit(1);
});
