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
//
// Requires the same Linux/procfs/system-Python pidfd + flock rail as localnet-up.
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  archiveProcessIdentityFile,
  assertRecordedProcessIdentity,
  observeLinuxProcess,
  openPrivateStateDirectory,
  readProcessIdentityFile,
} from "./localnet-process-identity.mjs";
import { withLocalnetLifecycleLock } from "./localnet-lifecycle-lock.mjs";
import {
  LOCALNET_PROGRAM_DESCRIPTOR_PATH,
  LOCALNET_PROGRAM_ID,
} from "./localnet-program-binding.mjs";
import { signalProcessIfIdentityMatches } from "./localnet-process-signal.mjs";
import { readValidatorLaunchIntentFile } from "./localnet-validator-launch.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = path.join(ROOT, ".localnet");
const LEDGER_DIR = path.join(STATE_DIR, "ledger");
const STOPPED_VALIDATOR_FILE = path.join(STATE_DIR, "validator.stopped");
const STARTING_VALIDATOR_FILE = path.join(STATE_DIR, "validator.starting");
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
    argv[upgrade + 1] !== LOCALNET_PROGRAM_ID ||
    argv[upgrade + 2] !== LOCALNET_PROGRAM_DESCRIPTOR_PATH
  ) {
    throw new Error(
      "validator shutdown refused: command line does not bind this repo ledger/program",
    );
  }
}

async function assertIdentity(record, processReference) {
  const observed = await observeLinuxProcess(record.pid, {
    processReference,
  });
  return assertRecordedProcessIdentity(
    record,
    observed,
    record.role === "validator"
      ? {
          executableBasename: "solana-test-validator",
          cwd: STATE_DIR,
          assertArgv: (argv) => validatorArgv(record, argv),
        }
      : { executableBasename: "node" },
  );
}

export async function stopProcess(label, record, dependencies = {}) {
  const assertIdentityForStop = dependencies.assertIdentity ?? assertIdentity;
  const openProcessReference = dependencies.openProcessReference;
  const sendSignal = dependencies.sendSignal;
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const log = dependencies.log ?? console.log;
  const termGraceMs = dependencies.termGraceMs ?? 10_000;
  const killGraceMs = dependencies.killGraceMs ?? 5_000;
  const signalIfExact = (signal) =>
    signalProcessIfIdentityMatches(record, signal, {
      assertIdentity: assertIdentityForStop,
      ...(openProcessReference === undefined ? {} : { openProcessReference }),
      ...(sendSignal === undefined ? {} : { sendSignal }),
    });

  if (!(await signalIfExact("SIGTERM"))) {
    log(`${label}: recorded pid ${record.pid} is already stopped`);
    return;
  }
  const deadline = now() + termGraceMs;
  while (now() < deadline) {
    if (!(await assertIdentityForStop(record))) {
      log(`${label}: pid ${record.pid} stopped (SIGTERM)`);
      return;
    }
    await sleep(200);
  }
  // Reopen a stable process reference for escalation, verify through it, and
  // signal through that same reference. Exit yields a benign ESRCH result;
  // numeric PID reuse cannot retarget the SIGKILL.
  if (!(await signalIfExact("SIGKILL"))) {
    log(`${label}: pid ${record.pid} stopped (SIGTERM)`);
    return;
  }
  const killDeadline = now() + killGraceMs;
  while (now() < killDeadline) {
    if (!(await assertIdentityForStop(record))) {
      log(`${label}: pid ${record.pid} killed (SIGKILL)`);
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `${label}: verified pid ${record.pid} is still alive after SIGKILL`,
  );
}

export function assertLedgerPurgeIsAttested({
  ledgerExists,
  stoppedMarkerFound,
  startingMarkerFound,
}) {
  if (ledgerExists && !stoppedMarkerFound && !startingMarkerFound) {
    throw new Error(
      "purge refused: ledger exists without verified stopped/startup lifecycle evidence",
    );
  }
}

export async function purgeAttestedLedger(
  { ledgerExists, stoppedMarkerFound, startingMarkerFound },
  {
    removeLedger,
    syncStateDirectory,
    removeStoppedMarker,
    removeStartingMarker,
  },
) {
  assertLedgerPurgeIsAttested({
    ledgerExists,
    stoppedMarkerFound,
    startingMarkerFound,
  });
  await removeLedger();
  // The markers are recovery proof. Delete them only after the parent
  // directory durably records ledger removal, then durably record their own
  // deletion. A crash can therefore restore stale proof, never remove proof
  // while restoring the ledger it authorized.
  await syncStateDirectory();
  await removeStoppedMarker();
  await removeStartingMarker();
  await syncStateDirectory();
}

async function existingLedgerIsDirectory() {
  try {
    const metadata = await lstat(LEDGER_DIR);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("purge refused: localnet ledger is not a real directory");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function mainLocked(args) {
  let anyFound = false;

  for (const { label, file } of PID_FILES) {
    const record = await readProcessIdentityFile(file, label);
    if (record === null) continue;
    anyFound = true;
    await stopProcess(label, record);
    if (label === "validator") {
      await archiveProcessIdentityFile(
        file,
        STOPPED_VALIDATOR_FILE,
        "validator",
      );
      console.log(
        `validator: verified-stopped marker retained at ${STOPPED_VALIDATOR_FILE}`,
      );
    } else {
      await rm(file, { force: true });
    }
  }

  const stoppedMarkerFound =
    (await readProcessIdentityFile(STOPPED_VALIDATOR_FILE, "validator")) !==
    null;
  if (stoppedMarkerFound) {
    anyFound = true;
    console.log("validator: using verified-stopped lifecycle marker");
  }
  const startingMarkerFound =
    (await readValidatorLaunchIntentFile(STARTING_VALIDATOR_FILE, {
      repoRoot: ROOT,
      ledgerDir: LEDGER_DIR,
      programId: LOCALNET_PROGRAM_ID,
    })) !== null;
  if (startingMarkerFound) {
    anyFound = true;
    console.log("validator: using completed precommit recovery marker");
  }

  const ledgerExists = args.purge ? await existingLedgerIsDirectory() : false;
  if (args.purge) {
    assertLedgerPurgeIsAttested({
      ledgerExists,
      stoppedMarkerFound,
      startingMarkerFound,
    });
  }
  if (!anyFound) {
    console.log("localnet-down: no pid files found — nothing to stop.");
  }

  if (args.purge) {
    const stateDirectoryHandle = await openPrivateStateDirectory(STATE_DIR);
    try {
      await purgeAttestedLedger(
        { ledgerExists, stoppedMarkerFound, startingMarkerFound },
        {
          removeLedger: () => rm(LEDGER_DIR, { recursive: true, force: true }),
          syncStateDirectory: () => stateDirectoryHandle.sync(),
          removeStoppedMarker: () =>
            rm(STOPPED_VALIDATOR_FILE, { force: true }),
          removeStartingMarker: () =>
            rm(STARTING_VALIDATOR_FILE, { force: true }),
        },
      );
    } finally {
      await stateDirectoryHandle.close();
    }
    console.log(`purged ledger: ${LEDGER_DIR}`);
    console.log(
      "(keys and env.json kept; next `localnet-up` is a fresh genesis + re-init)",
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await withLocalnetLifecycleLock(STATE_DIR, () => mainLocked(args));
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`localnet-down: ERROR: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
