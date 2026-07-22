import { spawn } from "node:child_process";
import process from "node:process";

import {
  openLinuxProcessReference,
  signalProcessReference,
} from "./localnet-process-signal.mjs";

const SYSTEM_PYTHON = "/usr/bin/python3";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_ABORT_TIMEOUT_MS = 20_000;
const MAX_CONTROL_OUTPUT_BYTES = 4 * 1024;

// The guardian owns the validator as an unreaped Popen child. Before COMMIT,
// parent-pipe EOF means the Node launcher died: terminate + wait the exact child,
// then close inherited lifecycle-lock fd 4. An optional exact, unlinked input
// inode is forwarded as fd 5. The child also receives PDEATHSIG so guardian
// death cannot orphan it. After Node has durably published identity, COMMIT
// closes fd 4, acknowledges, detaches the control pipes, and keeps waiting as
// the child's minimal lifetime supervisor.
const SPAWN_GUARDIAN = String.raw`
import ctypes
import errno
import os
import shutil
import signal
import stat
import subprocess
import sys

PR_SET_PDEATHSIG = 1
guardian_pid = os.getpid()
child = None
committed = False
lock_open = True
executable_fd = None
pinned_input_open = False

def arm_parent_death():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
        os._exit(126)
    if os.getppid() != guardian_pid:
        os._exit(126)

def stop_and_wait():
    if child is None or child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=child_term_timeout)
    except subprocess.TimeoutExpired:
        child.kill()
        # SIGKILL can remain pending while a task is in uninterruptible sleep.
        # Never release the inherited lifecycle lock on a timeout: wait until
        # the exact Popen child is actually reaped, however long that takes.
        child.wait()

try:
    child_term_timeout = int(sys.argv[1]) / 1000
    if sys.argv[2] not in ("0", "1"):
        raise RuntimeError("invalid pinned-input flag")
    has_pinned_input = sys.argv[2] == "1"
    requested_command = sys.argv[3]
    if has_pinned_input:
        pinned_input_open = True
        pinned_metadata = os.fstat(5)
        if (
            not stat.S_ISREG(pinned_metadata.st_mode)
            or pinned_metadata.st_uid != os.getuid()
            or pinned_metadata.st_nlink != 0
            or stat.S_IMODE(pinned_metadata.st_mode) != 0o400
            or pinned_metadata.st_size <= 0
        ):
            raise RuntimeError("pinned input is not a private unlinked read-only regular file")
    executable = shutil.which(requested_command)
    if executable is None:
        raise RuntimeError("missing guarded command")
    executable = os.path.realpath(executable)
    executable_fd = os.open(
        executable,
        os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
    )
    executable_metadata = os.fstat(executable_fd)
    if not stat.S_ISREG(executable_metadata.st_mode) or not executable_metadata.st_mode & 0o111:
        raise RuntimeError("guarded command is not an executable regular file")
    if executable_metadata.st_mode & (stat.S_ISUID | stat.S_ISGID):
        raise RuntimeError("guarded command may not be set-user-ID or set-group-ID")
    try:
        if os.getxattr(executable_fd, "security.capability"):
            raise RuntimeError("guarded command may not carry file capabilities")
    except OSError as error:
        if error.errno not in (errno.ENODATA, errno.ENOTSUP, errno.EOPNOTSUPP):
            raise
    # Execute through the already-checked descriptor. A PATH replacement after
    # this point cannot substitute a privileged inode and clear PDEATHSIG.
    pinned_executable = f"/proc/self/fd/{executable_fd}"
    command = [requested_command, *sys.argv[4:]]
    inherited_fds = (3, executable_fd, 5) if has_pinned_input else (3, executable_fd)
    child = subprocess.Popen(
        command,
        executable=pinned_executable,
        stdin=subprocess.DEVNULL,
        stdout=3,
        stderr=3,
        close_fds=True,
        pass_fds=inherited_fds,
        start_new_session=True,
        preexec_fn=arm_parent_death,
    )
    os.close(executable_fd)
    executable_fd = None
    os.close(3)
    if pinned_input_open:
        os.close(5)
        pinned_input_open = False
    print(f"PID {child.pid}", flush=True)
    control = sys.stdin.buffer.readline(64)
    if control == b"COMMIT\n":
        os.close(4)
        lock_open = False
        committed = True
        print("COMMITTED", flush=True)
        sys.stdout.flush()
        os.close(0)
        os.close(1)
        os.close(2)
        child.wait()
    else:
        if control not in (b"", b"ABORT\n"):
            print("invalid guardian control message", file=sys.stderr, flush=True)
        stop_and_wait()
        if control == b"ABORT\n":
            print("ABORTED", flush=True)
finally:
    if not committed:
        stop_and_wait()
    if executable_fd is not None:
        os.close(executable_fd)
    if pinned_input_open:
        os.close(5)
    if lock_open:
        os.close(4)
`;

export class GuardedSpawnError extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardedSpawnError";
  }
}

function fail(message) {
  throw new GuardedSpawnError(message);
}

function validateTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    fail(`${label} must be an integer in 1..60000`);
  }
}

function validateFd(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be an open file descriptor`);
  }
}

function validateCommand(command, args) {
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.includes("\0") ||
    !Array.isArray(args) ||
    args.some((value) => typeof value !== "string" || value.includes("\0"))
  ) {
    fail("guarded command and arguments must be non-NUL strings");
  }
}

function createControlChannel(child) {
  let buffer = "";
  let stderr = "";
  let closed;
  const queued = [];
  const waiters = [];

  const rejectWaiters = (error) => {
    while (waiters.length > 0) waiters.shift().reject(error);
  };
  const failChannel = (message) => {
    if (closed !== undefined) return;
    closed = new GuardedSpawnError(message);
    rejectWaiters(closed);
  };
  const publish = (line) => {
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(line);
    else waiter.resolve(line);
  };
  child.stdout.on("data", (chunk) => {
    if (closed !== undefined) return;
    buffer += String(chunk);
    if (Buffer.byteLength(buffer, "utf8") > MAX_CONTROL_OUTPUT_BYTES) {
      failChannel(
        `guarded spawn stdout exceeded ${MAX_CONTROL_OUTPUT_BYTES} bytes`,
      );
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      publish(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    if (closed !== undefined) return;
    stderr += String(chunk);
    if (Buffer.byteLength(stderr, "utf8") > MAX_CONTROL_OUTPUT_BYTES) {
      failChannel(
        `guarded spawn stderr exceeded ${MAX_CONTROL_OUTPUT_BYTES} bytes`,
      );
    }
  });
  child.once("error", (error) => {
    failChannel(`could not start guarded spawn helper (${error.message})`);
  });
  child.once("close", (code, signal) => {
    if (closed !== undefined) return;
    const detail = stderr.trim();
    failChannel(
      `guarded spawn helper closed` +
        `${detail ? ` (${detail})` : ` (code=${code ?? "null"}, signal=${signal ?? "null"})`}`,
    );
  });

  return Object.freeze({
    async nextLine(timeoutMs) {
      if (queued.length > 0) return queued.shift();
      if (closed !== undefined) throw closed;
      return await new Promise((resolve, reject) => {
        const waiter = {
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new GuardedSpawnError(
              `guarded spawn control timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  });
}

async function waitForExit(child, timeoutMs) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
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
    const onError = (error) => finish(reject, error);
    const onExit = () => finish(resolve);
    const timer = setTimeout(
      () =>
        finish(
          reject,
          new GuardedSpawnError(
            `guarded spawn helper did not exit within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForExactTargetExit(reference, timeoutMs) {
  if (reference === undefined || reference === null) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!signalProcessReference(reference, 0)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fail(
    `guarded target pid ${reference.pid} did not exit within ${timeoutMs}ms`,
  );
}

function writeControl(child, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      child.stdin.removeListener("error", onError);
      callback(value);
    };
    const onError = (error) => finish(reject, error);
    child.stdin.once("error", onError);
    child.stdin.end(message, () => finish(resolve));
  });
}

/**
 * Start a process behind a parent-death guardian that also inherits the current
 * lifecycle lock. Call commit() only after durable process-identity publication.
 */
export async function startGuardedProcess(
  command,
  args,
  {
    cwd,
    logFd,
    lifecycleLockFd,
    pinnedInputFd,
    pythonPath = SYSTEM_PYTHON,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    abortTimeoutMs = DEFAULT_ABORT_TIMEOUT_MS,
    childTermGraceMs = 10_000,
  },
) {
  validateCommand(command, args);
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
    fail("guarded process cwd must be a non-NUL string");
  }
  validateFd(logFd, "logFd");
  validateFd(lifecycleLockFd, "lifecycleLockFd");
  if (pinnedInputFd !== undefined) {
    validateFd(pinnedInputFd, "pinnedInputFd");
  }
  validateTimeout(handshakeTimeoutMs, "handshakeTimeoutMs");
  validateTimeout(abortTimeoutMs, "abortTimeoutMs");
  validateTimeout(childTermGraceMs, "childTermGraceMs");

  const child = spawn(
    pythonPath,
    [
      "-I",
      "-S",
      "-c",
      SPAWN_GUARDIAN,
      String(childTermGraceMs),
      pinnedInputFd === undefined ? "0" : "1",
      command,
      ...args,
    ],
    {
      cwd,
      detached: true,
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      stdio: [
        "pipe",
        "pipe",
        "pipe",
        logFd,
        lifecycleLockFd,
        pinnedInputFd ?? "ignore",
      ],
    },
  );
  const control = createControlChannel(child);
  let state = "starting";
  let pid;
  let targetReference;

  const closeTargetReference = () => {
    targetReference?.close();
    targetReference = undefined;
  };

  const abort = async () => {
    if (state === "aborted" || state === "committed") {
      return;
    }
    if (state === "commit-sent") {
      closeTargetReference();
      state = "commit-indeterminate";
      fail(
        "guarded COMMIT acknowledgement is indeterminate; refusing to kill the guardian because it must retain the lifecycle lock until the exact target is reaped",
      );
    }
    state = "aborting";
    let controlError;
    try {
      await writeControl(child, "ABORT\n");
      const response = await control.nextLine(abortTimeoutMs);
      if (response !== "ABORTED") {
        fail(`guarded spawn returned invalid abort response: ${response}`);
      }
    } catch (error) {
      controlError = error;
      child.stdin.destroy();
    }
    let exitError;
    try {
      await waitForExit(child, abortTimeoutMs);
    } catch (error) {
      exitError = error;
    }
    let targetExitError;
    if (exitError === undefined) {
      try {
        await waitForExactTargetExit(targetReference, abortTimeoutMs);
      } catch (error) {
        targetExitError = error;
      }
    }
    closeTargetReference();
    state = exitError === undefined ? "aborted" : "abort-indeterminate";
    const failures = [controlError, exitError, targetExitError].filter(
      (error) => error !== undefined,
    );
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "guarded process abort protocol or cleanup failed",
      );
    }
    if (failures.length === 1) throw failures[0];
  };

  try {
    const response = await control.nextLine(handshakeTimeoutMs);
    const match = /^PID ([1-9][0-9]*)$/u.exec(response);
    pid = Number(match?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      fail(`guarded spawn returned invalid PID response: ${response}`);
    }
    targetReference = openLinuxProcessReference(pid);
    if (targetReference === null) {
      fail(`guarded target pid ${pid} exited before stable capture`);
    }
    state = "guarded";
  } catch (error) {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 1) throw error;
    try {
      await abort();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "guarded process startup and cleanup both failed",
      );
    }
    throw error;
  }

  return Object.freeze({
    pid,
    guardianPid: child.pid,
    async commit() {
      if (state !== "guarded") {
        fail(`guarded process cannot commit from state ${state}`);
      }
      state = "commit-sent";
      await writeControl(child, "COMMIT\n");
      const response = await control.nextLine(handshakeTimeoutMs);
      if (response !== "COMMITTED") {
        fail(`guarded spawn returned invalid commit response: ${response}`);
      }
      state = "committed";
      closeTargetReference();
      child.unref();
      child.stdout.destroy();
      child.stderr.destroy();
    },
    abort,
  });
}
