import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { openPrivateStateDirectory } from "./localnet-process-identity.mjs";

const SYSTEM_PYTHON = "/usr/bin/python3";
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;
const MAX_HELPER_OUTPUT_BYTES = 4 * 1024;
const LOCK_LEAF = "lifecycle.lock";

// The broker acquires flock(2) on the same open file description retained by
// Node. Broker failure therefore cannot silently drop the lock; if Node crashes,
// its pipe and duplicate descriptor close, then the broker exits and the kernel
// releases the final descriptor without stale-lock recovery.
const LOCK_BROKER = String.raw`
import errno
import fcntl
import os
import stat
import sys

metadata = os.fstat(3)
if not stat.S_ISREG(metadata.st_mode):
    raise RuntimeError("lock leaf is not a regular file")
if metadata.st_uid != os.getuid():
    raise RuntimeError("lock leaf is not owned by the current user")
if stat.S_IMODE(metadata.st_mode) & 0o077:
    raise RuntimeError("lock leaf is accessible by group or other users")
try:
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError as error:
    if error.errno in (errno.EACCES, errno.EAGAIN):
        print("BUSY", file=sys.stderr, flush=True)
        raise SystemExit(73)
    raise
print("READY", flush=True)
while sys.stdin.buffer.read(8192):
    pass
`;

export class LocalnetLifecycleLockError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalnetLifecycleLockError";
  }
}

function fail(message) {
  throw new LocalnetLifecycleLockError(message);
}

function boundedAppend(current, chunk, label) {
  const next = current + String(chunk);
  if (Buffer.byteLength(next, "utf8") > MAX_HELPER_OUTPUT_BYTES) {
    fail(
      `localnet lifecycle lock ${label} exceeded ${MAX_HELPER_OUTPUT_BYTES} bytes`,
    );
  }
  return next;
}

function validateTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    fail(`${label} must be an integer in 1..60000`);
  }
}

async function waitForBrokerReady(child, timeoutMs) {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      callback(value);
    };
    const onError = (error) =>
      finish(
        reject,
        new LocalnetLifecycleLockError(
          `could not start lifecycle lock broker (${error.message})`,
        ),
      );
    const onExit = (code, signal) => {
      const detail = stderr.trim();
      if (code === 73) {
        finish(
          reject,
          new LocalnetLifecycleLockError(
            "another localnet lifecycle operation is already running",
          ),
        );
        return;
      }
      finish(
        reject,
        new LocalnetLifecycleLockError(
          `lifecycle lock broker exited before acquisition` +
            `${detail ? ` (${detail})` : ` (code=${code ?? "null"}, signal=${signal ?? "null"})`}`,
        ),
      );
    };
    const onStdout = (chunk) => {
      try {
        stdout = boundedAppend(stdout, chunk, "stdout");
        if (stdout === "READY\n") finish(resolve);
        else if (!"READY\n".startsWith(stdout)) {
          finish(
            reject,
            new LocalnetLifecycleLockError(
              "lifecycle lock broker returned an invalid readiness response",
            ),
          );
        }
      } catch (error) {
        finish(reject, error);
      }
    };
    const onStderr = (chunk) => {
      try {
        stderr = boundedAppend(stderr, chunk, "stderr");
      } catch (error) {
        finish(reject, error);
      }
    };
    const timer = setTimeout(() => {
      finish(
        reject,
        new LocalnetLifecycleLockError(
          `lifecycle lock broker did not become ready within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
  });
}

async function waitForBrokerExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode === 0) return;
    fail(
      `lifecycle lock broker exited abnormally during release (code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`,
    );
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      callback(value);
    };
    const onError = (error) =>
      finish(
        reject,
        new LocalnetLifecycleLockError(
          `lifecycle lock broker failed during release (${error.message})`,
        ),
      );
    const onExit = (code, signal) => {
      if (code === 0) finish(resolve);
      else {
        finish(
          reject,
          new LocalnetLifecycleLockError(
            `lifecycle lock broker exited abnormally during release (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          ),
        );
      }
    };
    const timer = setTimeout(() => {
      finish(
        reject,
        new LocalnetLifecycleLockError(
          `lifecycle lock broker did not release within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

/** Acquire the crash-releasing exclusive lock for one localnet state tree. */
export async function acquireLocalnetLifecycleLock(
  stateDirectory,
  {
    pythonPath = SYSTEM_PYTHON,
    acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
    releaseTimeoutMs = DEFAULT_RELEASE_TIMEOUT_MS,
  } = {},
) {
  if (process.platform !== "linux") {
    fail("localnet lifecycle locking is only available on Linux");
  }
  if (!path.isAbsolute(stateDirectory)) {
    fail("localnet state directory must be an absolute path");
  }
  validateTimeout(acquireTimeoutMs, "acquireTimeoutMs");
  validateTimeout(releaseTimeoutMs, "releaseTimeoutMs");

  const directoryHandle = await openPrivateStateDirectory(stateDirectory, {
    create: true,
    repairPermissions: true,
  });
  let lockHandle;
  let child;
  try {
    const anchoredLock = path.join(
      "/proc/self/fd",
      String(directoryHandle.fd),
      LOCK_LEAF,
    );
    try {
      lockHandle = await open(
        anchoredLock,
        constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      fail(`could not open localnet lifecycle lock (${error.message})`);
    }
    const metadata = await lockHandle.stat();
    if (
      !metadata.isFile() ||
      typeof process.getuid !== "function" ||
      metadata.uid !== process.getuid() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0
    ) {
      fail(
        "localnet lifecycle lock must be a private, current-user-owned, single-link regular file",
      );
    }

    child = spawn(pythonPath, ["-I", "-S", "-c", LOCK_BROKER], {
      env: { LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe", lockHandle.fd],
    });
    await Promise.all([
      directoryHandle.close(),
      waitForBrokerReady(child, acquireTimeoutMs),
    ]);
  } catch (error) {
    await directoryHandle.close().catch(() => {});
    child?.stdin?.destroy();
    if (
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill("SIGKILL");
    }
    await lockHandle?.close().catch(() => {});
    throw error;
  }

  let released = false;
  let brokerExitedBeforeRelease = false;
  child.once("exit", () => {
    if (!released) brokerExitedBeforeRelease = true;
  });
  return Object.freeze({
    // Exposed for diagnostics and adversarial tests; never use this numeric PID
    // for lifecycle signalling in production.
    brokerPid: child.pid,
    get fd() {
      if (released) fail("localnet lifecycle lock is already released");
      return lockHandle.fd;
    },
    async release() {
      if (released) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        brokerExitedBeforeRelease = true;
      }
      released = true;
      if (!brokerExitedBeforeRelease) child.stdin.end();
      let releaseError;
      if (brokerExitedBeforeRelease) {
        releaseError = new LocalnetLifecycleLockError(
          `lifecycle lock broker exited before release (code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`,
        );
      } else {
        try {
          await waitForBrokerExit(child, releaseTimeoutMs);
        } catch (error) {
          releaseError = error;
        }
      }
      let closeError;
      try {
        await lockHandle.close();
      } catch (error) {
        closeError = error;
      }
      if (releaseError !== undefined && closeError !== undefined) {
        throw new AggregateError(
          [releaseError, closeError],
          "lifecycle lock broker release and descriptor close both failed",
        );
      }
      if (releaseError !== undefined) throw releaseError;
      if (closeError !== undefined) throw closeError;
    },
  });
}

/** Hold the lifecycle lock for the complete callback, releasing on all exits. */
export async function withLocalnetLifecycleLock(
  stateDirectory,
  callback,
  options,
) {
  if (typeof callback !== "function") {
    throw new TypeError("callback must be a function");
  }
  const lock = await acquireLocalnetLifecycleLock(stateDirectory, options);
  let result;
  let actionError;
  try {
    result = await callback(lock);
  } catch (error) {
    actionError = error;
  }
  try {
    await lock.release();
  } catch (releaseError) {
    if (actionError !== undefined) {
      throw new AggregateError(
        [actionError, releaseError],
        "localnet lifecycle action and lock release both failed",
      );
    }
    throw releaseError;
  }
  if (actionError !== undefined) throw actionError;
  return result;
}
