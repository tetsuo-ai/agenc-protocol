import { spawnSync } from "node:child_process";
import { constants, closeSync, openSync } from "node:fs";
import { constants as osConstants } from "node:os";
import process from "node:process";

const SYSTEM_PYTHON = "/usr/bin/python3";
const PIDFD_HELPER = String.raw`
import signal
import sys

if not hasattr(signal, "pidfd_send_signal"):
    print("pidfd_send_signal unavailable", file=sys.stderr)
    raise SystemExit(5)

try:
    signal.pidfd_send_signal(3, int(sys.argv[1]), None, 0)
except ProcessLookupError:
    raise SystemExit(3)
except PermissionError:
    raise SystemExit(4)
except OSError as error:
    print(f"pidfd_send_signal errno={error.errno}", file=sys.stderr)
    raise SystemExit(5)
`;

export class ProcessSignalError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProcessSignalError";
  }
}

function fail(message) {
  throw new ProcessSignalError(message);
}

function validatePid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    fail(`cannot open a stable process reference for invalid pid ${pid}`);
  }
}

/**
 * Open the Linux proc directory for a PID as a stable process reference.
 *
 * Linux explicitly accepts an open /proc/pid directory as the pidfd argument
 * to pidfd_send_signal(2). Once opened, the descriptor continues to identify
 * that exact process even if it exits and its numeric PID is later reused.
 *
 * https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html
 */
export function openLinuxProcessReference(pid) {
  validatePid(pid);
  if (process.platform !== "linux") {
    fail("race-free process signalling is only available on Linux");
  }

  let fd;
  try {
    fd = openSync(
      `/proc/${pid}`,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    fail(`could not open a stable reference for pid ${pid} (${error.message})`);
  }

  let closed = false;
  return Object.freeze({
    pid,
    get fd() {
      if (closed) {
        fail(`stable process reference for pid ${pid} is already closed`);
      }
      return fd;
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  });
}

function signalNumber(signal) {
  const number =
    typeof signal === "string" ? osConstants.signals[signal] : signal;
  if (!Number.isSafeInteger(number) || number < 0) {
    fail(`unsupported process signal ${signal}`);
  }
  return number;
}

export function processReferenceSignalNumber(pid, signal) {
  validatePid(pid);
  const number = signalNumber(signal);
  // PID 1 is accepted only for this module's signal-0 capability probe. Managed
  // identity records still reject PID 1, and no delivered signal may target it.
  if (pid === 1 && number !== 0) {
    fail("refusing to deliver a nonzero signal to pid 1");
  }
  return number;
}

/**
 * Signal the exact process represented by an already-open process reference.
 *
 * Node 22/24 do not expose pidfd_send_signal. Node's documented numeric-stdio
 * support duplicates the open descriptor to fd 3 in a minimal isolated system
 * Python helper, which invokes Python's direct pidfd_send_signal wrapper. There
 * is deliberately no process.kill()/child.kill() fallback: missing kernel or
 * helper support is a hard, fail-closed error.
 *
 * https://nodejs.org/docs/latest-v22.x/api/child_process.html
 * https://docs.python.org/3/library/signal.html#signal.pidfd_send_signal
 */
export function signalProcessReference(reference, signal) {
  const pid = reference?.pid;
  const fd = reference?.fd;
  if (
    reference === null ||
    typeof reference !== "object" ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !Number.isSafeInteger(fd) ||
    fd < 0
  ) {
    fail("cannot signal an invalid process reference");
  }
  const number = processReferenceSignalNumber(pid, signal);
  const result = spawnSync(
    SYSTEM_PYTHON,
    ["-I", "-S", "-c", PIDFD_HELPER, String(number)],
    {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe", fd],
      timeout: 5_000,
    },
  );

  if (result.error) {
    fail(
      `race-free signalling helper failed for pid ${pid} (${result.error.message})`,
    );
  }
  if (result.status === 0) return true;
  if (result.status === 3) return false;
  if (result.status === 4) {
    fail(`permission denied signalling exact pid ${pid}`);
  }
  const detail = result.stderr?.trim();
  fail(
    `race-free signalling helper failed for pid ${pid}` +
      `${detail ? ` (${detail})` : ` (exit ${result.status ?? "unknown"})`}`,
  );
}

/** Prove the complete proc-descriptor/helper/kernel rail before spawning work. */
export function assertRaceFreeProcessSignallingAvailable() {
  const reference = openLinuxProcessReference(process.pid);
  if (reference === null) {
    fail("could not open a stable reference to the current process");
  }
  try {
    // Signal 0 performs the kernel permission/existence check without delivery.
    if (!signalProcessReference(reference, 0)) {
      fail("the current process disappeared during pidfd capability probing");
    }
  } finally {
    reference.close();
  }
}

/**
 * Open a stable process reference, verify identity through that same reference,
 * then deliver the signal through it. PID absence is an already-stopped result;
 * identity mismatches and unavailable pidfd support are hard failures.
 */
export async function signalProcessIfIdentityMatches(
  record,
  signal,
  {
    assertIdentity,
    openProcessReference = openLinuxProcessReference,
    sendSignal = signalProcessReference,
  } = {},
) {
  if (typeof assertIdentity !== "function") {
    throw new TypeError("assertIdentity must be a function");
  }
  if (typeof openProcessReference !== "function") {
    throw new TypeError("openProcessReference must be a function");
  }
  if (typeof sendSignal !== "function") {
    throw new TypeError("sendSignal must be a function");
  }

  const reference = await openProcessReference(record.pid);
  if (reference === null) return false;
  const referencePid = reference?.pid;
  const closeReference = reference?.close;
  if (referencePid !== record.pid || typeof closeReference !== "function") {
    await closeReference?.call(reference);
    fail("process-reference provider returned an invalid or mismatched handle");
  }

  try {
    if (!(await assertIdentity(record, reference))) return false;
    try {
      return (await sendSignal(reference, signal)) !== false;
    } catch (error) {
      // Test doubles and alternate direct pidfd wrappers may surface ESRCH as
      // an exception. It has the same already-stopped meaning as helper exit 3.
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  } finally {
    await closeReference.call(reference);
  }
}
