import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acquireLocalnetLifecycleLock,
  withLocalnetLifecycleLock,
} from "./localnet-lifecycle-lock.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const LOCK_MODULE_URL = pathToFileURL(
  path.join(SCRIPT_DIR, "localnet-lifecycle-lock.mjs"),
).href;

async function temporaryState(t, prefix) {
  const parent = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return path.join(parent, "state");
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

test("exclusive lifecycle lock refuses a contender and releases cleanly", async (t) => {
  const stateDirectory = await temporaryState(t, "agenc-lifecycle-lock-");
  const first = await acquireLocalnetLifecycleLock(stateDirectory);
  await assert.rejects(
    acquireLocalnetLifecycleLock(stateDirectory),
    /another localnet lifecycle operation is already running/,
  );
  assert.equal(
    (await stat(path.join(stateDirectory, "lifecycle.lock"))).mode & 0o777,
    0o600,
  );
  await first.release();
  await first.release();

  const second = await acquireLocalnetLifecycleLock(stateDirectory);
  await second.release();
});

test("callback failure releases the lifecycle lock", async (t) => {
  const stateDirectory = await temporaryState(t, "agenc-lifecycle-error-");
  const failure = new Error("action failed");
  await assert.rejects(
    withLocalnetLifecycleLock(stateDirectory, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  const lock = await acquireLocalnetLifecycleLock(stateDirectory);
  await lock.release();
});

test("lock leaf cannot redirect through a symlink", async (t) => {
  const stateDirectory = await temporaryState(t, "agenc-lifecycle-link-");
  await withLocalnetLifecycleLock(stateDirectory, async () => {});
  const lockFile = path.join(stateDirectory, "lifecycle.lock");
  await rm(lockFile);
  const outside = path.join(path.dirname(stateDirectory), "outside");
  await writeFile(outside, "unchanged", { mode: 0o600 });
  await symlink(outside, lockFile);

  await assert.rejects(
    acquireLocalnetLifecycleLock(stateDirectory),
    /could not open localnet lifecycle lock/,
  );
  assert.equal(await readFile(outside, "utf8"), "unchanged");
});

test("kernel releases the broker lock when the owning Node process crashes", async (t) => {
  const stateDirectory = await temporaryState(t, "agenc-lifecycle-crash-");
  const source = [
    `import { acquireLocalnetLifecycleLock } from ${JSON.stringify(LOCK_MODULE_URL)};`,
    "await acquireLocalnetLifecycleLock(process.env.AG_ENC_TEST_STATE);",
    'console.log("READY");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      env: { ...process.env, AG_ENC_TEST_STATE: stateDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });
  const [ready] = await once(child.stdout, "data");
  assert.equal(String(ready), "READY\n");

  await assert.rejects(
    acquireLocalnetLifecycleLock(stateDirectory),
    /another localnet lifecycle operation is already running/,
  );
  child.kill("SIGKILL");
  await once(child, "exit");

  const recovered = await acquireEventually(stateDirectory);
  await recovered.release();
});

test("every localnet lifecycle writer holds the exclusive lock", async () => {
  const [up, down, recordAttestor, identity] = await Promise.all([
    readFile(path.join(ROOT, "scripts/localnet-up.mjs"), "utf8"),
    readFile(path.join(ROOT, "scripts/localnet-down.mjs"), "utf8"),
    readFile(path.join(ROOT, "scripts/localnet-record-attestor.mjs"), "utf8"),
    readFile(path.join(ROOT, "scripts/localnet-process-identity.mjs"), "utf8"),
  ]);
  for (const [label, source] of [
    ["up", up],
    ["down", down],
    ["record-attestor", recordAttestor],
  ]) {
    assert.match(
      source,
      /withLocalnetLifecycleLock\(STATE_DIR,/,
      `${label} must lock the complete state-mutating main routine`,
    );
  }
  assert.doesNotMatch(
    up,
    /mkdir\(LEDGER_DIR/,
    "up must not create an unattested ledger before guarded validator spawn",
  );
  const liveMarkerCleanup = /if \(ourValidatorAlive\) \{([\s\S]*?)\n  \}/u.exec(
    up,
  )?.[1];
  assert.match(
    liveMarkerCleanup ?? "",
    /rm\(STARTING_PID_FILE[\s\S]*rm\(STOPPED_PID_FILE/u,
    "a live durable identity must clear interrupted recovery markers",
  );
  const mainStart = up.indexOf("async function mainLocked(");
  const mainEnd = up.indexOf("\nasync function main()", mainStart);
  assert.ok(mainStart >= 0 && mainEnd > mainStart, "up must define mainLocked");
  const upMain = up.slice(mainStart, mainEnd);
  const orderedFragments = [
    "assertCanonicalProgramIdentity(",
    "existingLedgerIsDirectory()",
    "assertLedgerLaunchIsAttested({",
    "replaceValidatorLaunchIntentFile(",
    "ensureValidatorLaunchIntentFile(STARTING_PID_FILE",
    "materializeLocalnetProgramSnapshot(",
    "startGuardedProcess(",
    "openLinuxProcessReference(guarded.pid)",
    "captureGuardedValidatorIdentity(",
    "publishProcessIdentityFile(PID_FILE, pidInfo)",
    "await guarded.commit()",
    "commitAcknowledged = true",
    "rm(STARTING_PID_FILE",
    "rm(STOPPED_PID_FILE",
  ];
  let previous = -1;
  for (const fragment of orderedFragments) {
    const index = upMain.indexOf(fragment, previous + 1);
    assert.ok(index >= 0, `up is missing guarded handoff step: ${fragment}`);
    assert.ok(
      index > previous,
      `up reordered guarded handoff step: ${fragment}`,
    );
    previous = index;
  }
  assert.ok(
    upMain.indexOf('step("program account check")') <
      upMain.indexOf('step("airdrops (500 SOL targets)")'),
    "live Program/ProgramData verification must precede every funded action",
  );
  assert.match(
    up,
    /LOCALNET_PROGRAM_DESCRIPTOR_PATH[\s\S]*pinnedInputFd: programSnapshot\.fd/u,
    "validator argv and guarded spawn must share the exact inherited program descriptor",
  );
  assert.match(
    up,
    /startupError !== undefined[\s\S]*!commitAcknowledged[\s\S]*await guarded\.abort\(\)/u,
    "every failed pre-commit startup path must abort the guarded child",
  );
  assert.match(
    up,
    /observeLinuxProcess\(pid, \{ processReference \}\)[\s\S]*assertValidatorArgv/u,
    "validator exec and canonical argv must be checked through the stable reference",
  );
  assert.match(
    identity,
    /await directoryHandle\.sync\(\)/u,
    "durable PID publication must fsync its containing directory",
  );
});
