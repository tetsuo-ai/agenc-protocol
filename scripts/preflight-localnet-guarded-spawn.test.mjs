import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startGuardedProcess } from "./localnet-guarded-spawn.mjs";
import { acquireLocalnetLifecycleLock } from "./localnet-lifecycle-lock.mjs";
import { purgeAttestedLedger } from "./localnet-down.mjs";
import {
  captureLocalnetProgramArtifact,
  materializeLocalnetProgramSnapshot,
} from "./localnet-program-snapshot.mjs";
import {
  observeLinuxProcess,
  openPrivateStateDirectory,
  readProcessIdentityFile,
} from "./localnet-process-identity.mjs";
import {
  openLinuxProcessReference,
  signalProcessReference,
} from "./localnet-process-signal.mjs";
import { readValidatorLaunchIntentFile } from "./localnet-validator-launch.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCK_MODULE_URL = pathToFileURL(
  path.join(SCRIPT_DIR, "localnet-lifecycle-lock.mjs"),
).href;
const GUARD_MODULE_URL = pathToFileURL(
  path.join(SCRIPT_DIR, "localnet-guarded-spawn.mjs"),
).href;
const IDENTITY_MODULE_URL = pathToFileURL(
  path.join(SCRIPT_DIR, "localnet-process-identity.mjs"),
).href;
const SIGNAL_MODULE_URL = pathToFileURL(
  path.join(SCRIPT_DIR, "localnet-process-signal.mjs"),
).href;
const LAUNCH_MODULE_URL = pathToFileURL(
  path.join(SCRIPT_DIR, "localnet-validator-launch.mjs"),
).href;
const PROGRAM_ID = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";

async function temporaryState(t, prefix) {
  const parent = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, stateDirectory: path.join(parent, "state") };
}

async function waitGone(reference, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      (await observeLinuxProcess(reference.pid, {
        processReference: reference,
      })) === null
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`pid ${reference.pid} did not exit within ${timeoutMs}ms`);
}

async function acquireEventually(stateDirectory, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await acquireLocalnetLifecycleLock(stateDirectory);
    } catch (error) {
      lastError = error;
      if (!/already running/.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError ?? new Error("lifecycle lock did not become available");
}

async function startNodeGuard(lock, cwd, logFd, source, options = {}) {
  return await startGuardedProcess(process.execPath, ["--eval", source], {
    cwd,
    logFd,
    lifecycleLockFd: lock.fd,
    ...options,
  });
}

test("guardian never times out exact reap or force-kills an indeterminate handoff", async () => {
  const source = await readFile(
    path.join(SCRIPT_DIR, "localnet-guarded-spawn.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /child\.kill\(\)[\s\S]*child\.wait\(\)/u,
    "SIGKILL escalation must retain the inherited lock until exact reap",
  );
  assert.doesNotMatch(source, /child\.wait\(timeout=child_kill/u);
  assert.doesNotMatch(source, /forceStopHelper/u);
  assert.match(
    source,
    /COMMIT acknowledgement is indeterminate; refusing to kill the guardian/u,
  );
  assert.match(
    source,
    /detached: true/u,
    "guardian must not inherit the invoking terminal session",
  );
});

test("precommit abort reaps the exact child before inherited lock release", async (t) => {
  const { parent, stateDirectory } = await temporaryState(
    t,
    "agenc-guard-abort-",
  );
  const lock = await acquireLocalnetLifecycleLock(stateDirectory);
  const logFd = openSync(path.join(parent, "child.log"), "a");
  let guarded;
  try {
    guarded = await startNodeGuard(
      lock,
      parent,
      logFd,
      "setInterval(() => {}, 1000)",
    );
  } finally {
    closeSync(logFd);
  }
  const reference = openLinuxProcessReference(guarded.pid);
  assert.notEqual(reference, null);
  await assert.rejects(
    acquireLocalnetLifecycleLock(stateDirectory),
    /already running/,
  );
  await guarded.abort();
  await waitGone(reference);
  await assert.rejects(
    acquireLocalnetLifecycleLock(stateDirectory),
    /already running/,
  );
  reference.close();
  await lock.release();

  const recovered = await acquireLocalnetLifecycleLock(stateDirectory);
  await recovered.release();
});

test("guardian forwards the exact unlinked program snapshot as target fd 5", async (t) => {
  const { parent, stateDirectory } = await temporaryState(
    t,
    "agenc-guard-pinned-input-",
  );
  const sourcePath = path.join(parent, "program.so");
  const outputPath = path.join(parent, "observed-program.so");
  const original = Buffer.from("exact-validator-program\0revision-5");
  await writeFile(sourcePath, original, { mode: 0o770 });
  const artifact = await captureLocalnetProgramArtifact(sourcePath);
  await writeFile(sourcePath, "path-was-mutated-after-capture");
  const snapshot = await materializeLocalnetProgramSnapshot(
    artifact,
    stateDirectory,
  );
  const lock = await acquireLocalnetLifecycleLock(stateDirectory);
  const logFd = openSync(path.join(parent, "child.log"), "a");
  let guarded;
  let reference;
  // Static source: the destination path travels via the environment so no
  // runtime value is ever spliced into generated code (CodeQL
  // js/improper-code-sanitization).
  process.env.AG_ENC_TEST_OUTPUT = outputPath;
  try {
    guarded = await startNodeGuard(
      lock,
      parent,
      logFd,
      [
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.env.AG_ENC_TEST_OUTPUT, fs.readFileSync("/proc/self/fd/5"));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { pinnedInputFd: snapshot.fd },
    );
    reference = openLinuxProcessReference(guarded.pid);
    assert.notEqual(reference, null);
  } finally {
    delete process.env.AG_ENC_TEST_OUTPUT;
    closeSync(logFd);
    await snapshot.close();
  }

  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        if ((await stat(outputPath)).size === original.length) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(await readFile(outputPath), original);
    await guarded.abort();
    await waitGone(reference);
  } finally {
    try {
      await guarded?.abort();
    } catch {}
    reference?.close();
    await lock.release();
  }
});

test("commit detaches lifecycle lock only after acknowledgement", async (t) => {
  const { parent, stateDirectory } = await temporaryState(
    t,
    "agenc-guard-commit-",
  );
  const lock = await acquireLocalnetLifecycleLock(stateDirectory);
  const logFd = openSync(path.join(parent, "child.log"), "a");
  let guarded;
  try {
    guarded = await startNodeGuard(
      lock,
      parent,
      logFd,
      "setInterval(() => {}, 1000)",
    );
  } finally {
    closeSync(logFd);
  }
  const reference = openLinuxProcessReference(guarded.pid);
  assert.notEqual(reference, null);
  t.after(() => {
    try {
      signalProcessReference(reference, "SIGKILL");
    } catch {}
    reference.close();
  });

  await guarded.commit();
  await lock.release();
  const contender = await acquireLocalnetLifecycleLock(stateDirectory);
  await contender.release();
  assert.equal(signalProcessReference(reference, "SIGTERM"), true);
  await waitGone(reference);
});

test("launcher SIGKILL cannot release flock before its uncommitted child is reaped", async (t) => {
  const { parent, stateDirectory } = await temporaryState(
    t,
    "agenc-guard-crash-",
  );
  const logPath = path.join(parent, "child.log");
  const ledgerPath = path.join(stateDirectory, "ledger");
  const startingPath = path.join(stateDirectory, "validator.starting");
  const source = [
    `import { openSync, closeSync, mkdirSync } from "node:fs";`,
    `import { acquireLocalnetLifecycleLock } from ${JSON.stringify(LOCK_MODULE_URL)};`,
    `import { startGuardedProcess } from ${JSON.stringify(GUARD_MODULE_URL)};`,
    `import { ensureValidatorLaunchIntentFile } from ${JSON.stringify(LAUNCH_MODULE_URL)};`,
    "const lock = await acquireLocalnetLifecycleLock(process.env.AG_ENC_TEST_STATE);",
    "await ensureValidatorLaunchIntentFile(process.env.AG_ENC_TEST_STARTING, { repoRoot: process.env.AG_ENC_TEST_PARENT, ledgerDir: process.env.AG_ENC_TEST_LEDGER, programId: process.env.AG_ENC_TEST_PROGRAM, programSha256: process.env.AG_ENC_TEST_PROGRAM_SHA, programSize: Number(process.env.AG_ENC_TEST_PROGRAM_SIZE) });",
    "mkdirSync(process.env.AG_ENC_TEST_LEDGER, { recursive: true });",
    "const logFd = openSync(process.env.AG_ENC_TEST_LOG, 'a');",
    "const guarded = await startGuardedProcess(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { cwd: process.env.AG_ENC_TEST_PARENT, logFd, lifecycleLockFd: lock.fd });",
    "closeSync(logFd);",
    "console.log(`PID ${guarded.pid}`);",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const launcher = spawn(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      env: {
        ...process.env,
        AG_ENC_TEST_STATE: stateDirectory,
        AG_ENC_TEST_LOG: logPath,
        AG_ENC_TEST_PARENT: parent,
        AG_ENC_TEST_LEDGER: ledgerPath,
        AG_ENC_TEST_STARTING: startingPath,
        AG_ENC_TEST_PROGRAM: PROGRAM_ID,
        AG_ENC_TEST_PROGRAM_SHA: "ab".repeat(32),
        AG_ENC_TEST_PROGRAM_SIZE: "2284496",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill("SIGKILL");
    }
  });
  const [line] = await once(launcher.stdout, "data");
  const targetPid = Number(/^PID ([1-9][0-9]*)\n$/u.exec(String(line))?.[1]);
  assert.ok(Number.isSafeInteger(targetPid));
  const targetReference = openLinuxProcessReference(targetPid);
  const launcherReference = openLinuxProcessReference(launcher.pid);
  assert.notEqual(targetReference, null);
  assert.notEqual(launcherReference, null);
  try {
    assert.equal(signalProcessReference(launcherReference, "SIGKILL"), true);
    await once(launcher, "exit");
    const recovered = await acquireEventually(stateDirectory);
    assert.equal(
      await observeLinuxProcess(targetPid, {
        processReference: targetReference,
      }),
      null,
      "flock became acquirable before the precommit target was reaped",
    );
    assert.notEqual(
      await readValidatorLaunchIntentFile(startingPath, {
        repoRoot: parent,
        ledgerDir: ledgerPath,
        programId: PROGRAM_ID,
      }),
      null,
    );
    assert.equal((await stat(ledgerPath)).isDirectory(), true);
    const stateDirectoryHandle =
      await openPrivateStateDirectory(stateDirectory);
    try {
      await purgeAttestedLedger(
        {
          ledgerExists: true,
          stoppedMarkerFound: false,
          startingMarkerFound: true,
        },
        {
          removeLedger: () => rm(ledgerPath, { recursive: true, force: true }),
          syncStateDirectory: () => stateDirectoryHandle.sync(),
          removeStoppedMarker: async () => {},
          removeStartingMarker: () => rm(startingPath, { force: true }),
        },
      );
    } finally {
      await stateDirectoryHandle.close();
    }
    await assert.rejects(stat(ledgerPath), { code: "ENOENT" });
    await assert.rejects(stat(startingPath), { code: "ENOENT" });
    await recovered.release();
  } finally {
    launcherReference.close();
    targetReference.close();
  }
});

test("graceful broker failure cannot unlock Node's retained descriptor", async (t) => {
  const { stateDirectory } = await temporaryState(t, "agenc-broker-failure-");
  const lock = await acquireLocalnetLifecycleLock(stateDirectory);
  const brokerReference = openLinuxProcessReference(lock.brokerPid);
  assert.notEqual(brokerReference, null);
  try {
    assert.equal(signalProcessReference(brokerReference, "SIGINT"), true);
    await waitGone(brokerReference);
    await assert.rejects(
      acquireLocalnetLifecycleLock(stateDirectory),
      /already running/,
    );
    await assert.rejects(lock.release(), /exited before release|abnormally/);
    const recovered = await acquireLocalnetLifecycleLock(stateDirectory);
    await recovered.release();
  } finally {
    brokerReference.close();
  }
});

test("guardian death before commit kills its child while parent lock remains", async (t) => {
  const { parent, stateDirectory } = await temporaryState(
    t,
    "agenc-guardian-precommit-death-",
  );
  const lock = await acquireLocalnetLifecycleLock(stateDirectory);
  const logFd = openSync(path.join(parent, "child.log"), "a");
  let guarded;
  try {
    guarded = await startNodeGuard(
      lock,
      parent,
      logFd,
      "setInterval(() => {}, 1000)",
    );
  } finally {
    closeSync(logFd);
  }
  const targetReference = openLinuxProcessReference(guarded.pid);
  const guardianReference = openLinuxProcessReference(guarded.guardianPid);
  assert.notEqual(targetReference, null);
  assert.notEqual(guardianReference, null);
  try {
    assert.equal(signalProcessReference(guardianReference, "SIGKILL"), true);
    await waitGone(guardianReference);
    await waitGone(targetReference);
    await assert.rejects(
      acquireLocalnetLifecycleLock(stateDirectory),
      /already running/,
    );
  } finally {
    guardianReference.close();
    targetReference.close();
  }
  await lock.release();
});

test("committed supervisor death still kills its guarded child", async (t) => {
  const { parent, stateDirectory } = await temporaryState(
    t,
    "agenc-guardian-postcommit-death-",
  );
  const lock = await acquireLocalnetLifecycleLock(stateDirectory);
  const logFd = openSync(path.join(parent, "child.log"), "a");
  let guarded;
  try {
    guarded = await startNodeGuard(
      lock,
      parent,
      logFd,
      "setInterval(() => {}, 1000)",
    );
  } finally {
    closeSync(logFd);
  }
  const targetReference = openLinuxProcessReference(guarded.pid);
  const guardianReference = openLinuxProcessReference(guarded.guardianPid);
  assert.notEqual(targetReference, null);
  assert.notEqual(guardianReference, null);
  await guarded.commit();
  await lock.release();
  try {
    assert.equal(signalProcessReference(guardianReference, "SIGKILL"), true);
    await waitGone(guardianReference);
    await waitGone(targetReference);
  } finally {
    guardianReference.close();
    targetReference.close();
  }
});

test("abort escalates and reaps a SIGTERM-resistant guarded child", async (t) => {
  const { parent, stateDirectory } = await temporaryState(
    t,
    "agenc-guardian-resistant-",
  );
  const readyPath = path.join(parent, "ready");
  const termPath = path.join(parent, "term-seen");
  // Static source: paths travel via the environment so no runtime value is
  // ever spliced into generated code (CodeQL js/improper-code-sanitization).
  const source = [
    `const fs = require("node:fs");`,
    'process.on("SIGTERM", () => fs.writeFileSync(process.env.AG_ENC_TEST_TERM, "seen"));',
    'fs.writeFileSync(process.env.AG_ENC_TEST_READY, "ready");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const lock = await acquireLocalnetLifecycleLock(stateDirectory);
  const logFd = openSync(path.join(parent, "child.log"), "a");
  let guarded;
  process.env.AG_ENC_TEST_TERM = termPath;
  process.env.AG_ENC_TEST_READY = readyPath;
  try {
    guarded = await startNodeGuard(lock, parent, logFd, source, {
      childTermGraceMs: 100,
    });
  } finally {
    delete process.env.AG_ENC_TEST_TERM;
    delete process.env.AG_ENC_TEST_READY;
    closeSync(logFd);
  }
  const reference = openLinuxProcessReference(guarded.pid);
  assert.notEqual(reference, null);
  const readyDeadline = Date.now() + 2_000;
  while (Date.now() < readyDeadline) {
    try {
      if ((await readFile(readyPath, "utf8")) === "ready") break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await readFile(readyPath, "utf8"), "ready");
  await guarded.abort();
  await waitGone(reference);
  assert.equal(await readFile(termPath, "utf8"), "seen");
  reference.close();
  await lock.release();
});

test("missing guardian helper fails quickly without leaking the lock", async (t) => {
  const { parent, stateDirectory } = await temporaryState(
    t,
    "agenc-guardian-missing-",
  );
  const lock = await acquireLocalnetLifecycleLock(stateDirectory);
  const logFd = openSync(path.join(parent, "child.log"), "a");
  try {
    await assert.rejects(
      startGuardedProcess(process.execPath, ["--eval", ""], {
        cwd: parent,
        logFd,
        lifecycleLockFd: lock.fd,
        pythonPath: path.join(parent, "missing-python"),
        handshakeTimeoutMs: 100,
        abortTimeoutMs: 100,
      }),
      /could not start guarded spawn helper/,
    );
  } finally {
    closeSync(logFd);
  }
  await assert.rejects(
    acquireLocalnetLifecycleLock(stateDirectory),
    /already running/,
  );
  await lock.release();
  const recovered = await acquireLocalnetLifecycleLock(stateDirectory);
  await recovered.release();
});

test("guardian protocol timeout fails closed while EOF cleanup releases a targetless helper", async (t) => {
  const { parent, stateDirectory } = await temporaryState(
    t,
    "agenc-guardian-timeout-",
  );
  const fakeHelper = path.join(parent, "silent-helper");
  await writeFile(
    fakeHelper,
    "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.exit(0), 50)); setInterval(() => {}, 1000);\n",
    { mode: 0o700 },
  );
  await chmod(fakeHelper, 0o700);
  const lock = await acquireLocalnetLifecycleLock(stateDirectory);
  const logFd = openSync(path.join(parent, "child.log"), "a");
  try {
    await assert.rejects(
      startGuardedProcess(process.execPath, ["--eval", ""], {
        cwd: parent,
        logFd,
        lifecycleLockFd: lock.fd,
        pythonPath: fakeHelper,
        handshakeTimeoutMs: 50,
        abortTimeoutMs: 100,
      }),
      /guarded process startup and cleanup both failed|timed out/,
    );
  } finally {
    closeSync(logFd);
  }
  await assert.rejects(
    acquireLocalnetLifecycleLock(stateDirectory),
    /already running/,
  );
  await lock.release();
});

test("indeterminate COMMIT never force-kills the guardian or target", async (t) => {
  const { parent, stateDirectory } = await temporaryState(
    t,
    "agenc-guardian-commit-failure-",
  );
  const lock = await acquireLocalnetLifecycleLock(stateDirectory);
  const logFd = openSync(path.join(parent, "child.log"), "a");
  let guarded;
  try {
    guarded = await startNodeGuard(
      lock,
      parent,
      logFd,
      "setInterval(() => {}, 1000)",
      { handshakeTimeoutMs: 50, abortTimeoutMs: 2_000 },
    );
  } finally {
    closeSync(logFd);
  }
  const targetReference = openLinuxProcessReference(guarded.pid);
  const guardianReference = openLinuxProcessReference(guarded.guardianPid);
  assert.notEqual(targetReference, null);
  assert.notEqual(guardianReference, null);
  try {
    assert.equal(signalProcessReference(guardianReference, "SIGSTOP"), true);
    const commitError = await guarded.commit().then(
      () => null,
      (error) => error,
    );
    assert.match(commitError?.message ?? "", /control timed out/);
    await assert.rejects(
      guarded.abort(),
      /COMMIT acknowledgement is indeterminate; refusing to kill the guardian/,
    );
    assert.notEqual(
      await observeLinuxProcess(guarded.pid, {
        processReference: targetReference,
      }),
      null,
      "indeterminate COMMIT cleanup killed the target",
    );
    assert.equal(signalProcessReference(guardianReference, "SIGCONT"), true);
    assert.equal(signalProcessReference(targetReference, "SIGTERM"), true);
    await waitGone(targetReference);
    await waitGone(guardianReference);
  } finally {
    guardianReference.close();
    targetReference.close();
  }
  await lock.release();
  const recovered = await acquireLocalnetLifecycleLock(stateDirectory);
  await recovered.release();
});

test("durable identity precedes commit and survives launcher exit", async (t) => {
  const { parent, stateDirectory } = await temporaryState(
    t,
    "agenc-guardian-durable-",
  );
  const logPath = path.join(parent, "child.log");
  const identityPath = path.join(stateDirectory, "target.pid");
  const source = [
    `import { openSync, closeSync } from "node:fs";`,
    `import { acquireLocalnetLifecycleLock } from ${JSON.stringify(LOCK_MODULE_URL)};`,
    `import { startGuardedProcess } from ${JSON.stringify(GUARD_MODULE_URL)};`,
    `import { captureProcessIdentity, publishProcessIdentityFile } from ${JSON.stringify(IDENTITY_MODULE_URL)};`,
    `import { openLinuxProcessReference } from ${JSON.stringify(SIGNAL_MODULE_URL)};`,
    "const lock = await acquireLocalnetLifecycleLock(process.env.AG_ENC_TEST_STATE);",
    "const logFd = openSync(process.env.AG_ENC_TEST_LOG, 'a');",
    "const guarded = await startGuardedProcess(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { cwd: process.env.AG_ENC_TEST_PARENT, logFd, lifecycleLockFd: lock.fd });",
    "closeSync(logFd);",
    "const reference = openLinuxProcessReference(guarded.pid);",
    "const record = await captureProcessIdentity(guarded.pid, 'attestor', {}, { processReference: reference });",
    "await publishProcessIdentityFile(process.env.AG_ENC_TEST_IDENTITY, record);",
    "await guarded.commit();",
    "reference.close();",
    "await lock.release();",
    "console.log(`READY ${guarded.pid} ${guarded.guardianPid}`);",
  ].join("\n");
  const launcher = spawn(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      env: {
        ...process.env,
        AG_ENC_TEST_STATE: stateDirectory,
        AG_ENC_TEST_LOG: logPath,
        AG_ENC_TEST_PARENT: parent,
        AG_ENC_TEST_IDENTITY: identityPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const [line] = await once(launcher.stdout, "data");
  const match = /^READY ([1-9][0-9]*) ([1-9][0-9]*)\n$/u.exec(String(line));
  assert.notEqual(match, null);
  const targetPid = Number(match[1]);
  const guardianPid = Number(match[2]);
  await once(launcher, "exit");
  assert.equal(
    (await readProcessIdentityFile(identityPath, "attestor")).pid,
    targetPid,
  );
  assert.equal((await stat(identityPath)).mode & 0o777, 0o600);
  const targetReference = openLinuxProcessReference(targetPid);
  const guardianReference = openLinuxProcessReference(guardianPid);
  assert.notEqual(targetReference, null);
  assert.notEqual(guardianReference, null);
  try {
    assert.equal(signalProcessReference(targetReference, "SIGTERM"), true);
    await waitGone(targetReference);
    await waitGone(guardianReference);
  } finally {
    targetReference.close();
    guardianReference.close();
  }
});

test("committed guardian and target survive invoking PTY teardown", async (t) => {
  try {
    await stat("/usr/bin/script");
  } catch {
    t.skip("util-linux script is required for PTY teardown coverage");
    return;
  }
  const { parent, stateDirectory } = await temporaryState(
    t,
    "agenc-guardian-pty-detach-",
  );
  const launcherPath = path.join(parent, "launcher.mjs");
  const logPath = path.join(parent, "child.log");
  await writeFile(
    launcherPath,
    [
      `import { openSync, closeSync } from "node:fs";`,
      `import { acquireLocalnetLifecycleLock } from ${JSON.stringify(LOCK_MODULE_URL)};`,
      `import { startGuardedProcess } from ${JSON.stringify(GUARD_MODULE_URL)};`,
      "const lock = await acquireLocalnetLifecycleLock(process.env.AG_ENC_TEST_STATE);",
      "const logFd = openSync(process.env.AG_ENC_TEST_LOG, 'a');",
      "const guarded = await startGuardedProcess(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { cwd: process.env.AG_ENC_TEST_PARENT, logFd, lifecycleLockFd: lock.fd });",
      "closeSync(logFd);",
      "await guarded.commit();",
      "await lock.release();",
      "console.log(`READY ${guarded.pid} ${guarded.guardianPid}`);",
    ].join("\n"),
  );
  const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  const session = spawn(
    "/usr/bin/script",
    [
      "-q",
      "-e",
      "-c",
      `${quote(process.execPath)} ${quote(launcherPath)}`,
      "/dev/null",
    ],
    {
      env: {
        ...process.env,
        AG_ENC_TEST_STATE: stateDirectory,
        AG_ENC_TEST_LOG: logPath,
        AG_ENC_TEST_PARENT: parent,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  session.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const [exitCode] = await once(session, "exit");
  assert.equal(exitCode, 0);
  const match = /READY ([1-9][0-9]*) ([1-9][0-9]*)/u.exec(output);
  assert.notEqual(match, null, output);
  const targetReference = openLinuxProcessReference(Number(match[1]));
  const guardianReference = openLinuxProcessReference(Number(match[2]));
  assert.notEqual(targetReference, null);
  assert.notEqual(guardianReference, null);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.notEqual(
      await observeLinuxProcess(targetReference.pid, {
        processReference: targetReference,
      }),
      null,
      "PTY teardown killed the committed target",
    );
    assert.notEqual(
      await observeLinuxProcess(guardianReference.pid, {
        processReference: guardianReference,
      }),
      null,
      "PTY teardown killed the committed guardian",
    );
    const contender = await acquireLocalnetLifecycleLock(stateDirectory);
    await contender.release();
    assert.equal(signalProcessReference(targetReference, "SIGTERM"), true);
    await waitGone(targetReference);
    await waitGone(guardianReference);
  } finally {
    try {
      signalProcessReference(targetReference, "SIGKILL");
    } catch {}
    try {
      signalProcessReference(guardianReference, "SIGKILL");
    } catch {}
    targetReference.close();
    guardianReference.close();
  }
});
