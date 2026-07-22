import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCALNET_PROGRAM_LOAD_METHOD } from "./localnet-program-binding.mjs";
import {
  archiveProcessIdentityFile,
  assertRecordedProcessIdentity,
  captureAndPublishSpawnedProcess,
  captureProcessIdentity,
  ensurePrivateStateDirectory,
  observeLinuxProcess,
  parseProcessIdentityRecord,
  publishProcessIdentityFile,
  readProcessIdentityFile,
} from "./localnet-process-identity.mjs";

test("exact process identity detects PID reuse and argv/executable/cwd drift", async (t) => {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    t.skip("procfs identity test is Linux-only");
    return;
  }
  const record = await captureProcessIdentity(process.pid, "attestor");
  const observed = await observeLinuxProcess(process.pid);
  assert.equal(assertRecordedProcessIdentity(record, observed), true);
  for (const mutation of [
    { processStartTicks: String(BigInt(record.processStartTicks) + 1n) },
    { argvSha256: "00".repeat(32) },
    { executable: "/tmp/not-node" },
    { cwd: "/tmp/not-this-process" },
    { uid: record.uid + 1 },
  ]) {
    assert.throws(
      () => assertRecordedProcessIdentity({ ...record, ...mutation }, observed),
      /shutdown refused/,
    );
  }
});

test("legacy/raw and non-exact PID records are rejected", () => {
  assert.throws(() => parseProcessIdentityRecord("1234"), /JSON object/);
  const valid = {
    schemaVersion: 1,
    role: "attestor",
    pid: 1234,
    uid: 1000,
    processStartTicks: "123456",
    executable: "/usr/bin/node",
    cwd: "/tmp/example",
    argvSha256: "ab".repeat(32),
    recordedAt: "2026-07-19T12:00:00.000Z",
  };
  assert.equal(parseProcessIdentityRecord(JSON.stringify(valid)).pid, 1234);
  assert.throws(
    () => parseProcessIdentityRecord(JSON.stringify({ ...valid, extra: true })),
    /unsupported identity schema/,
  );
});

test("validator identities require the fd-bound version-2 provenance", async () => {
  const record = await captureProcessIdentity(process.pid, "validator", {
    rpcPort: 8899,
    programSha256: "ab".repeat(32),
    programSize: 2_000_000,
    programLoadMethod: LOCALNET_PROGRAM_LOAD_METHOD,
  });
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.programLoadMethod, LOCALNET_PROGRAM_LOAD_METHOD);
  for (const mutation of [
    { schemaVersion: 1 },
    { programLoadMethod: "mutable-path" },
  ]) {
    assert.throws(
      () =>
        parseProcessIdentityRecord(
          JSON.stringify({ ...record, ...mutation }),
          "validator identity",
        ),
      /malformed validator binding fields|malformed process identity fields/,
    );
  }
});

test("identity files are private, bounded regular files opened without following links", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "agenc-pid-identity-"),
  );
  const record = {
    schemaVersion: 1,
    role: "attestor",
    pid: 1234,
    uid: typeof process.getuid === "function" ? process.getuid() : 1000,
    processStartTicks: "123456",
    executable: "/usr/bin/node",
    cwd: "/tmp/example",
    argvSha256: "ab".repeat(32),
    recordedAt: "2026-07-19T12:00:00.000Z",
  };
  const target = path.join(directory, "record.json");
  await writeFile(target, JSON.stringify(record), { mode: 0o600 });
  assert.equal((await readProcessIdentityFile(target, "attestor")).pid, 1234);

  await chmod(target, 0o644);
  await assert.rejects(
    readProcessIdentityFile(target, "attestor"),
    /group or other users/,
  );
  await chmod(target, 0o600);
  const link = path.join(directory, "attestor.pid");
  await symlink(target, link);
  await assert.rejects(
    readProcessIdentityFile(link, "attestor"),
    /regular non-symlink/,
  );

  const huge = path.join(directory, "huge.pid");
  await writeFile(huge, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(readProcessIdentityFile(huge, "attestor"), /exceeds/);
});

test("identity reads reject hard-linked validator PID, stopped, and attestor records", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "agenc-pid-hardlinks-"),
  );
  const attestor = await captureProcessIdentity(process.pid, "attestor");
  const validator = await captureProcessIdentity(process.pid, "validator", {
    rpcPort: 8899,
    programSha256: "ab".repeat(32),
    programSize: 2_000_000,
    programLoadMethod: LOCALNET_PROGRAM_LOAD_METHOD,
  });

  for (const [leaf, role, record] of [
    ["validator.pid", "validator", validator],
    ["validator.stopped", "validator", validator],
    ["attestor.pid", "attestor", attestor],
  ]) {
    const identityFile = path.join(directory, leaf);
    await publishProcessIdentityFile(identityFile, record);
    await link(identityFile, path.join(directory, `${leaf}.hardlink`));
    assert.equal((await stat(identityFile)).nlink, 2);
    await assert.rejects(
      readProcessIdentityFile(identityFile, role),
      /must have exactly one hard link/,
    );
  }
});

test("state directory is real, current-user-owned, and private", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "agenc-state-boundary-"));
  const stateDir = path.join(parent, "state");
  await mkdir(stateDir, { mode: 0o770 });
  await ensurePrivateStateDirectory(stateDir);
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);

  await chmod(stateDir, 0o750);
  await assert.rejects(
    readProcessIdentityFile(path.join(stateDir, "validator.pid"), "validator"),
    /chmod 700/,
  );

  const linkedDir = path.join(parent, "linked");
  await symlink(stateDir, linkedDir, "dir");
  await assert.rejects(
    readProcessIdentityFile(path.join(linkedDir, "validator.pid"), "validator"),
    /non-symlink directory/,
  );
});

test("identity publication is atomic, private, and never follows an existing leaf", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenc-publish-"));
  const record = await captureProcessIdentity(process.pid, "attestor");
  const identityFile = path.join(directory, "attestor.pid");
  await publishProcessIdentityFile(identityFile, record);
  assert.equal((await stat(identityFile)).mode & 0o777, 0o600);
  assert.equal(
    (await readProcessIdentityFile(identityFile, "attestor")).pid,
    process.pid,
  );

  const secondDirectory = await mkdtemp(
    path.join(os.tmpdir(), "agenc-publish-link-"),
  );
  const outside = path.join(secondDirectory, "outside.json");
  const original = "do-not-overwrite";
  await writeFile(outside, original, { mode: 0o600 });
  const linkedLeaf = path.join(secondDirectory, "attestor.pid");
  await symlink(outside, linkedLeaf);
  await assert.rejects(
    publishProcessIdentityFile(linkedLeaf, record),
    /EEXIST/,
  );
  assert.equal(await readFile(outside, "utf8"), original);
});

test("a verified live identity atomically replaces the durable stopped marker", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "agenc-stopped-marker-"),
  );
  const liveFile = path.join(directory, "validator.pid");
  const stoppedFile = path.join(directory, "validator.stopped");
  const record = await captureProcessIdentity(process.pid, "validator", {
    rpcPort: 8899,
    programSha256: "ab".repeat(32),
    programSize: 2_000_000,
    programLoadMethod: LOCALNET_PROGRAM_LOAD_METHOD,
  });
  await publishProcessIdentityFile(stoppedFile, record);
  await publishProcessIdentityFile(liveFile, record);

  assert.equal(
    (await archiveProcessIdentityFile(liveFile, stoppedFile, "validator")).pid,
    process.pid,
  );
  assert.equal(await readProcessIdentityFile(liveFile, "validator"), null);
  assert.equal(
    (await readProcessIdentityFile(stoppedFile, "validator")).pid,
    process.pid,
  );
  assert.equal((await stat(stoppedFile)).mode & 0o777, 0o600);
});

test("identity archive rejects a hard-linked live PID or stopped marker", async () => {
  const record = await captureProcessIdentity(process.pid, "validator", {
    rpcPort: 8899,
    programSha256: "ab".repeat(32),
    programSize: 2_000_000,
    programLoadMethod: LOCALNET_PROGRAM_LOAD_METHOD,
  });

  const linkedPidDirectory = await mkdtemp(
    path.join(os.tmpdir(), "agenc-archive-pid-hardlink-"),
  );
  const linkedPid = path.join(linkedPidDirectory, "validator.pid");
  const missingStopped = path.join(linkedPidDirectory, "validator.stopped");
  await publishProcessIdentityFile(linkedPid, record);
  await link(linkedPid, path.join(linkedPidDirectory, "pid-alias"));
  await assert.rejects(
    archiveProcessIdentityFile(linkedPid, missingStopped, "validator"),
    /must have exactly one hard link/,
  );
  assert.equal((await stat(linkedPid)).nlink, 2);
  assert.equal(
    await readProcessIdentityFile(missingStopped, "validator"),
    null,
  );

  const linkedStoppedDirectory = await mkdtemp(
    path.join(os.tmpdir(), "agenc-archive-stopped-hardlink-"),
  );
  const livePid = path.join(linkedStoppedDirectory, "validator.pid");
  const linkedStopped = path.join(linkedStoppedDirectory, "validator.stopped");
  await publishProcessIdentityFile(livePid, record);
  await publishProcessIdentityFile(linkedStopped, record);
  await link(linkedStopped, path.join(linkedStoppedDirectory, "stopped-alias"));
  await assert.rejects(
    archiveProcessIdentityFile(livePid, linkedStopped, "validator"),
    /must have exactly one hard link/,
  );
  assert.equal(
    (await readProcessIdentityFile(livePid, "validator")).pid,
    process.pid,
  );
  assert.equal((await stat(linkedStopped)).nlink, 2);
});

test("failed identity publication terminates the exact just-spawned child", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "agenc-publish-fail-"),
  );
  const identityFile = path.join(directory, "attestor.pid");
  await writeFile(identityFile, "occupied", { mode: 0o600 });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });

  await assert.rejects(
    captureAndPublishSpawnedProcess(child, "attestor", identityFile),
    { code: "EEXIST" },
  );
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("spawned child was orphaned")),
          2_000,
        ),
      ),
    ]);
  }
  assert.equal(child.signalCode, "SIGTERM");
});

test("failed publication escalates against a SIGTERM-resistant exact child and awaits exit", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "agenc-publish-resistant-"),
  );
  const identityFile = path.join(directory, "attestor.pid");
  await writeFile(identityFile, "occupied", { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  await once(child.stdout, "data");

  await assert.rejects(
    captureAndPublishSpawnedProcess(
      child,
      "attestor",
      identityFile,
      {},
      { termGraceMs: 50, killGraceMs: 2_000 },
    ),
    { code: "EEXIST" },
  );
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(await observeLinuxProcess(child.pid), null);
});
