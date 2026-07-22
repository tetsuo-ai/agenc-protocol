#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertRecordedProcessIdentity,
  captureProcessIdentity,
  observeLinuxProcess,
  publishProcessIdentityFile,
} from "./localnet-process-identity.mjs";
import { withLocalnetLifecycleLock } from "./localnet-lifecycle-lock.mjs";
import { openLinuxProcessReference } from "./localnet-process-signal.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(ROOT, ".localnet");
const PID_FILE = path.join(STATE_DIR, "attestor.pid");

async function recordAttestor(pid) {
  const processReference = openLinuxProcessReference(pid);
  if (processReference === null) {
    throw new Error(`attestor pid ${pid} exited before it could be recorded`);
  }
  try {
    const record = await captureProcessIdentity(
      pid,
      "attestor",
      {},
      {
        processReference,
      },
    );
    assertRecordedProcessIdentity(
      record,
      await observeLinuxProcess(pid, { processReference }),
      { executableBasename: "node" },
    );
    await publishProcessIdentityFile(PID_FILE, record);
  } finally {
    processReference.close();
  }
  console.log(`recorded attestor pid ${pid} at ${PID_FILE}`);
}

async function main() {
  const pid = Number(process.argv[2]);
  if (!Number.isSafeInteger(pid) || pid <= 1 || process.argv.length !== 3) {
    throw new Error("usage: node scripts/localnet-record-attestor.mjs <pid>");
  }
  await withLocalnetLifecycleLock(STATE_DIR, () => recordAttestor(pid));
}

main().catch((error) => {
  console.error(`localnet-record-attestor: ERROR: ${error.message}`);
  process.exitCode = 1;
});
