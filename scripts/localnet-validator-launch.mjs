import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { openPrivateStateDirectory } from "./localnet-process-identity.mjs";
import { LOCALNET_PROGRAM_LOAD_METHOD } from "./localnet-program-binding.mjs";

const MAX_LAUNCH_INTENT_BYTES = 8 * 1024;
const LAUNCH_KEYS = [
  "schemaVersion",
  "role",
  "uid",
  "repoRoot",
  "ledgerDir",
  "programId",
  "programSha256",
  "programSize",
  "programLoadMethod",
  "createdAt",
];

export class ValidatorLaunchIntentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidatorLaunchIntentError";
  }
}

function fail(message) {
  throw new ValidatorLaunchIntentError(message);
}

function canonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

export function parseValidatorLaunchIntent(body, label = "launch marker") {
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    fail(`${label} contains invalid JSON (${error.message})`);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...LAUNCH_KEYS].sort()) ||
    value.schemaVersion !== 2 ||
    value.role !== "validator-starting" ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    typeof value.repoRoot !== "string" ||
    !path.isAbsolute(value.repoRoot) ||
    typeof value.ledgerDir !== "string" ||
    !path.isAbsolute(value.ledgerDir) ||
    typeof value.programId !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(value.programId) ||
    typeof value.programSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.programSha256) ||
    !Number.isSafeInteger(value.programSize) ||
    value.programSize <= 0 ||
    value.programLoadMethod !== LOCALNET_PROGRAM_LOAD_METHOD ||
    !canonicalTimestamp(value.createdAt)
  ) {
    fail(`${label} has an invalid or unsupported launch-intent schema`);
  }
  return Object.freeze(value);
}

function assertExpected(intent, expected, label) {
  for (const field of [
    "repoRoot",
    "ledgerDir",
    "programId",
    "programSha256",
    "programSize",
    "programLoadMethod",
  ]) {
    if (expected?.[field] !== undefined && intent[field] !== expected[field]) {
      fail(`${label} does not belong to this localnet ${field}`);
    }
  }
  if (typeof process.getuid !== "function" || intent.uid !== process.getuid()) {
    fail(`${label} is not owned by the current user identity`);
  }
}

function createValidatorLaunchIntent(file, expected) {
  if (typeof process.getuid !== "function") {
    fail("validator launch intents require a numeric current-user identity");
  }
  const intent = parseValidatorLaunchIntent(
    JSON.stringify({
      schemaVersion: 2,
      role: "validator-starting",
      uid: process.getuid(),
      repoRoot: expected.repoRoot,
      ledgerDir: expected.ledgerDir,
      programId: expected.programId,
      programSha256: expected.programSha256,
      programSize: expected.programSize,
      programLoadMethod: LOCALNET_PROGRAM_LOAD_METHOD,
      createdAt: new Date().toISOString(),
    }),
    file,
  );
  assertExpected(intent, expected, file);
  return intent;
}

function anchoredLeaf(directory, handle, leaf) {
  return path.join("/proc/self/fd", String(handle.fd), leaf);
}

export async function readValidatorLaunchIntentFile(file, expected = {}) {
  const directory = path.dirname(file);
  const directoryHandle = await openPrivateStateDirectory(directory, {
    missingOk: true,
  });
  if (directoryHandle === null) return null;
  const anchoredFile = anchoredLeaf(
    directory,
    directoryHandle,
    path.basename(file),
  );
  let metadata;
  try {
    metadata = await lstat(anchoredFile);
  } catch (error) {
    await directoryHandle.close();
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let handle;
  try {
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      typeof process.getuid !== "function" ||
      metadata.uid !== process.getuid() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > MAX_LAUNCH_INTENT_BYTES
    ) {
      fail(`${file} must be a private, current-user-owned, single-link file`);
    }
    handle = await open(
      anchoredFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.uid !== metadata.uid ||
      opened.nlink !== 1 ||
      opened.size > MAX_LAUNCH_INTENT_BYTES
    ) {
      fail(`${file} changed while its launch intent was being opened`);
    }
    const body = await handle.readFile("utf8");
    if (Buffer.byteLength(body, "utf8") > MAX_LAUNCH_INTENT_BYTES) {
      fail(`${file} exceeds ${MAX_LAUNCH_INTENT_BYTES} bytes`);
    }
    const intent = parseValidatorLaunchIntent(body, file);
    assertExpected(intent, expected, file);
    return intent;
  } finally {
    await handle?.close();
    await directoryHandle.close();
  }
}

/**
 * Durably create the pre-spawn marker once. A valid prior marker is reusable:
 * acquiring the inherited lifecycle lock proves its old guardian already reaped.
 */
export async function ensureValidatorLaunchIntentFile(file, expected) {
  const existing = await readValidatorLaunchIntentFile(file, expected);
  if (existing !== null) return existing;
  const intent = createValidatorLaunchIntent(file, expected);
  const body = `${JSON.stringify(intent, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_LAUNCH_INTENT_BYTES) {
    fail(`${file} exceeds ${MAX_LAUNCH_INTENT_BYTES} bytes`);
  }
  const directory = path.dirname(file);
  const directoryHandle = await openPrivateStateDirectory(directory, {
    create: true,
    repairPermissions: true,
  });
  const target = anchoredLeaf(directory, directoryHandle, path.basename(file));
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let temporaryHandle;
  try {
    temporaryHandle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await temporaryHandle.writeFile(body, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await link(temporary, target);
    await unlink(temporary);
    await directoryHandle.sync();
    return intent;
  } finally {
    await temporaryHandle?.close();
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await directoryHandle.close();
  }
}

/** Atomically replace one already-validated prior intent for a reset launch. */
export async function replaceValidatorLaunchIntentFile(file, expected) {
  const previous = await readValidatorLaunchIntentFile(file, {
    repoRoot: expected.repoRoot,
    ledgerDir: expected.ledgerDir,
    programId: expected.programId,
  });
  if (previous === null) {
    fail(`${file} disappeared before its launch intent could be replaced`);
  }
  const intent = createValidatorLaunchIntent(file, expected);
  const body = `${JSON.stringify(intent, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_LAUNCH_INTENT_BYTES) {
    fail(`${file} exceeds ${MAX_LAUNCH_INTENT_BYTES} bytes`);
  }
  const directory = path.dirname(file);
  const directoryHandle = await openPrivateStateDirectory(directory);
  const target = anchoredLeaf(directory, directoryHandle, path.basename(file));
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let temporaryHandle;
  try {
    temporaryHandle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await temporaryHandle.writeFile(body, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporary, target);
    await directoryHandle.sync();
    return intent;
  } finally {
    await temporaryHandle?.close();
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await directoryHandle.close();
  }
}
