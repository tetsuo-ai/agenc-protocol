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
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = path.join(ROOT, ".localnet");
const LEDGER_DIR = path.join(STATE_DIR, "ledger");
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function readPid(file) {
  try {
    const raw = await readFile(file, "utf8");
    try {
      const parsed = JSON.parse(raw);
      return Number.isInteger(parsed.pid) ? parsed.pid : null;
    } catch {
      const pid = Number(raw.trim());
      return Number.isInteger(pid) ? pid : null;
    }
  } catch {
    return null;
  }
}

async function stopProcess(label, pid) {
  if (!pidAlive(pid)) {
    console.log(`${label}: pid ${pid} not running (stale pid file removed)`);
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      console.log(`${label}: pid ${pid} stopped (SIGTERM)`);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  process.kill(pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 500));
  console.log(`${label}: pid ${pid} ${pidAlive(pid) ? "STILL ALIVE after SIGKILL" : "killed (SIGKILL)"}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let anyFound = false;

  for (const { label, file } of PID_FILES) {
    const pid = await readPid(file);
    if (pid === null) continue;
    anyFound = true;
    await stopProcess(label, pid);
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
