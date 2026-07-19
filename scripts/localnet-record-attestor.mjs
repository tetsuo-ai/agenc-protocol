#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertRecordedProcessIdentity,
  captureProcessIdentity,
  ensurePrivateStateDirectory,
  observeLinuxProcess,
  publishProcessIdentityFile,
} from "./localnet-process-identity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(ROOT, ".localnet");
const PID_FILE = path.join(STATE_DIR, "attestor.pid");

async function main() {
  const pid = Number(process.argv[2]);
  if (!Number.isSafeInteger(pid) || pid <= 1 || process.argv.length !== 3) {
    throw new Error("usage: node scripts/localnet-record-attestor.mjs <pid>");
  }
  const record = await captureProcessIdentity(pid, "attestor");
  assertRecordedProcessIdentity(record, await observeLinuxProcess(pid), {
    executableBasename: "node",
  });
  await ensurePrivateStateDirectory(STATE_DIR);
  await publishProcessIdentityFile(PID_FILE, record);
  console.log(`recorded attestor pid ${pid} at ${PID_FILE}`);
}

main().catch((error) => {
  console.error(`localnet-record-attestor: ERROR: ${error.message}`);
  process.exitCode = 1;
});
