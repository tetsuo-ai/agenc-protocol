import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const COMMON_KEYS = [
  "schemaVersion",
  "role",
  "pid",
  "uid",
  "processStartTicks",
  "executable",
  "cwd",
  "argvSha256",
  "recordedAt",
];
const VALIDATOR_KEYS = ["rpcPort", "programSha256", "programSize"];
const MAX_IDENTITY_FILE_BYTES = 16 * 1024;

export class ProcessIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProcessIdentityError";
  }
}

function fail(message) {
  throw new ProcessIdentityError(message);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must contain a JSON object`);
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    fail(`${label} has an invalid or unsupported identity schema`);
  }
}

function canonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

export function parseProcessIdentityRecord(body, label = "pid file") {
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    fail(`${label} contains invalid JSON (${error.message})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must contain a JSON object`);
  }
  const role = value?.role;
  if (!new Set(["validator", "attestor"]).has(role)) {
    fail(`${label} has an unsupported process role`);
  }
  exactKeys(
    value,
    role === "validator" ? [...COMMON_KEYS, ...VALIDATOR_KEYS] : COMMON_KEYS,
    label,
  );
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    !/^[1-9][0-9]*$/.test(value.processStartTicks ?? "") ||
    typeof value.executable !== "string" ||
    !value.executable.startsWith("/") ||
    typeof value.cwd !== "string" ||
    !value.cwd.startsWith("/") ||
    !/^[0-9a-f]{64}$/.test(value.argvSha256 ?? "") ||
    !canonicalTimestamp(value.recordedAt)
  ) {
    fail(`${label} contains malformed process identity fields`);
  }
  if (
    role === "validator" &&
    (!Number.isSafeInteger(value.rpcPort) ||
      value.rpcPort < 1 ||
      value.rpcPort > 65_535 ||
      !/^[0-9a-f]{64}$/.test(value.programSha256 ?? "") ||
      !Number.isSafeInteger(value.programSize) ||
      value.programSize <= 0)
  ) {
    fail(`${label} contains malformed validator binding fields`);
  }
  return Object.freeze(value);
}

export async function observeLinuxProcess(pid) {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    fail(
      "strong process identity verification is unavailable on this platform",
    );
  }
  try {
    const [status, statBody, executable, cwd, argvBytes] = await Promise.all([
      readFile(`/proc/${pid}/status`, "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
      readlink(`/proc/${pid}/exe`),
      readlink(`/proc/${pid}/cwd`),
      readFile(`/proc/${pid}/cmdline`),
    ]);
    const uid = Number(/^Uid:\s+(\d+)/mu.exec(status)?.[1]);
    const commEnd = statBody.lastIndexOf(")");
    const fields =
      commEnd < 0
        ? []
        : statBody
            .slice(commEnd + 1)
            .trim()
            .split(/\s+/u);
    const processStartTicks = fields[19];
    if (
      !Number.isSafeInteger(uid) ||
      !/^[1-9][0-9]*$/.test(processStartTicks ?? "") ||
      argvBytes.length === 0
    ) {
      fail(`could not read complete identity for pid ${pid}`);
    }
    return Object.freeze({
      uid,
      processStartTicks,
      executable,
      cwd,
      argvSha256: createHash("sha256").update(argvBytes).digest("hex"),
      argv: argvBytes.toString("utf8").split("\0").filter(Boolean),
    });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    if (error instanceof ProcessIdentityError) throw error;
    fail(`could not verify pid ${pid} identity (${error.message})`);
  }
}

export async function captureProcessIdentity(pid, role, extra = {}) {
  const observed = await observeLinuxProcess(pid);
  if (!observed)
    fail(`${role} pid ${pid} exited before its identity was recorded`);
  return parseProcessIdentityRecord(
    JSON.stringify({
      schemaVersion: 1,
      role,
      pid,
      uid: observed.uid,
      processStartTicks: observed.processStartTicks,
      executable: observed.executable,
      cwd: observed.cwd,
      argvSha256: observed.argvSha256,
      recordedAt: new Date().toISOString(),
      ...extra,
    }),
    `${role} identity`,
  );
}

export function assertRecordedProcessIdentity(record, observed, expected = {}) {
  if (!observed) return false;
  for (const field of [
    "uid",
    "processStartTicks",
    "executable",
    "cwd",
    "argvSha256",
  ]) {
    if (record[field] !== observed[field]) {
      fail(
        `${record.role} shutdown refused: pid ${record.pid} ${field} no longer matches its identity record`,
      );
    }
  }
  if (typeof process.getuid !== "function" || record.uid !== process.getuid()) {
    fail(
      `${record.role} shutdown refused: process is not owned by the current user`,
    );
  }
  if (expected.executableBasename) {
    const actual = record.executable.split("/").at(-1);
    if (actual !== expected.executableBasename) {
      fail(
        `${record.role} shutdown refused: executable is not ${expected.executableBasename}`,
      );
    }
  }
  if (expected.cwd && record.cwd !== expected.cwd) {
    fail(
      `${record.role} shutdown refused: working directory does not match this stack`,
    );
  }
  if (typeof expected.assertArgv === "function")
    expected.assertArgv(observed.argv);
  return true;
}

async function openPrivateStateDirectory(
  directory,
  { create = false, repairPermissions = false, missingOk = false } = {},
) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (missingOk && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${directory} must be a real non-symlink directory`);
  }
  if (
    typeof process.getuid !== "function" ||
    metadata.uid !== process.getuid()
  ) {
    fail(`${directory} must be owned by the current user`);
  }

  let handle;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    let opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.uid !== metadata.uid
    ) {
      fail(`${directory} changed while it was being opened`);
    }
    if ((opened.mode & 0o077) !== 0 && repairPermissions) {
      await handle.chmod(0o700);
      opened = await handle.stat();
    }
    if ((opened.mode & 0o077) !== 0) {
      fail(
        `${directory} must not be accessible by group or other users (chmod 700)`,
      );
    }
    return handle;
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

function anchoredLeaf(directory, handle, leaf) {
  return process.platform === "linux"
    ? path.join("/proc/self/fd", String(handle.fd), leaf)
    : path.join(directory, leaf);
}

/** Create/repair and verify the private `.localnet` trust boundary. */
export async function ensurePrivateStateDirectory(directory) {
  const handle = await openPrivateStateDirectory(directory, {
    create: true,
    repairPermissions: true,
  });
  await handle.close();
}

/**
 * Publish a complete private identity inode without following or overwriting a
 * pre-existing leaf. The hard-link publication is atomic and directory-fsynced.
 */
export async function publishProcessIdentityFile(file, record) {
  const body = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_IDENTITY_FILE_BYTES) {
    fail(`${file} exceeds ${MAX_IDENTITY_FILE_BYTES} bytes`);
  }
  parseProcessIdentityRecord(body, file);
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
  } finally {
    await temporaryHandle?.close();
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await directoryHandle.close();
  }
}

/** Capture and durably publish a just-spawned child, or terminate that child. */
export async function captureAndPublishSpawnedProcess(
  child,
  role,
  file,
  extra = {},
  cleanupOptions = {},
) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 1) {
    fail(`cannot record ${role}: spawned child has no valid pid`);
  }
  let identity;
  try {
    identity = await captureProcessIdentity(child.pid, role, extra);
    await publishProcessIdentityFile(file, identity);
    return identity;
  } catch (error) {
    try {
      await stopFailedSpawn(child, identity, cleanupOptions);
    } catch (cleanupError) {
      throw new ProcessIdentityError(
        `${role} identity publication failed (${error.message}) and exact child cleanup failed (${cleanupError.message})`,
      );
    }
    throw error;
  }
}

async function stopFailedSpawn(child, identity, options) {
  const termGraceMs = options.termGraceMs ?? 10_000;
  const killGraceMs = options.killGraceMs ?? 5_000;
  const pollMs = options.pollMs ?? 100;
  for (const [label, value] of Object.entries({
    termGraceMs,
    killGraceMs,
    pollMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
      fail(`${label} must be an integer in 1..60000`);
    }
  }

  const exactChildAlive = async () => {
    if (identity === undefined) {
      return child.exitCode === null && child.signalCode === null;
    }
    const observed = await observeLinuxProcess(child.pid);
    if (observed === null) return false;
    assertRecordedProcessIdentity(identity, observed);
    return true;
  };
  const waitGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await exactChildAlive())) return true;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return !(await exactChildAlive());
  };
  const awaitChildExit = async (timeoutMs) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        child.removeListener("exit", onExit);
        reject(
          new Error(
            `child pid ${child.pid} exited but did not settle its handle`,
          ),
        );
      }, timeoutMs);
      child.once("exit", onExit);
    });
  };

  if (!(await exactChildAlive())) return;
  child.kill("SIGTERM");
  if (await waitGone(termGraceMs)) {
    await awaitChildExit(killGraceMs);
    return;
  }

  // Re-verification in waitGone immediately precedes escalation. A reused or
  // otherwise changed PID throws and is never signalled.
  if (!(await exactChildAlive())) return;
  child.kill("SIGKILL");
  if (!(await waitGone(killGraceMs))) {
    fail(`${identity?.role ?? "spawned"} pid ${child.pid} survived SIGKILL`);
  }
  await awaitChildExit(killGraceMs);
}

export async function readProcessIdentityFile(file, role) {
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
    if (error?.code === "ENOENT") {
      await directoryHandle.close();
      return null;
    }
    await directoryHandle.close();
    throw error;
  }
  let handle;
  try {
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail(`${file} must be a regular non-symlink file`);
    }
    if (
      typeof process.getuid !== "function" ||
      metadata.uid !== process.getuid()
    ) {
      fail(`${file} is not owned by the current user`);
    }
    if ((metadata.mode & 0o077) !== 0) {
      fail(`${file} must not be accessible by group or other users`);
    }
    if (metadata.size > MAX_IDENTITY_FILE_BYTES) {
      fail(`${file} exceeds ${MAX_IDENTITY_FILE_BYTES} bytes`);
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
      opened.size > MAX_IDENTITY_FILE_BYTES
    ) {
      fail(`${file} changed while its identity record was being opened`);
    }
    const body = await handle.readFile("utf8");
    if (Buffer.byteLength(body, "utf8") > MAX_IDENTITY_FILE_BYTES) {
      fail(`${file} exceeds ${MAX_IDENTITY_FILE_BYTES} bytes`);
    }
    const record = parseProcessIdentityRecord(body, file);
    if (record.role !== role)
      fail(`${file} does not describe the expected ${role}`);
    return record;
  } finally {
    await handle?.close();
    await directoryHandle.close();
  }
}
