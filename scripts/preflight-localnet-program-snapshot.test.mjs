import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertLocalnetProgramAccountLinksProgramData,
  assertLocalnetProgramDataMatchesArtifact,
  captureLocalnetProgramArtifact,
  materializeLocalnetProgramSnapshot,
} from "./localnet-program-snapshot.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function temporaryRoot(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("captured program bytes remain exact after in-place source mutation", async (t) => {
  const root = await temporaryRoot(t, "agenc-program-snapshot-mutate-");
  const source = path.join(root, "program.so");
  const stateDirectory = path.join(root, "state");
  const original = Buffer.from("captured-program-bytes\0v1");
  await writeFile(source, original, { mode: 0o770 });
  await chmod(source, 0o770);

  const artifact = await captureLocalnetProgramArtifact(source);
  assert.deepEqual(artifact, {
    sha256: sha256(original),
    size: original.length,
  });
  assert.equal(Object.isFrozen(artifact), true);

  await writeFile(source, Buffer.from("mutated-program-bytes\0v2"));
  const snapshot = await materializeLocalnetProgramSnapshot(
    artifact,
    stateDirectory,
  );
  const descriptorPath = `/proc/self/fd/${snapshot.fd}`;
  assert.deepEqual(await readFile(descriptorPath), original);
  const metadata = await stat(descriptorPath);
  assert.equal(metadata.nlink, 0);
  assert.equal(metadata.mode & 0o777, 0o400);
  assert.deepEqual(
    (await readdir(stateDirectory)).filter((leaf) =>
      leaf.startsWith("program-snapshot."),
    ),
    [],
  );

  await snapshot.close();
  await snapshot.close();
  assert.throws(() => snapshot.fd, /already closed/);
});

test("captured program bytes survive source path replacement", async (t) => {
  const root = await temporaryRoot(t, "agenc-program-snapshot-replace-");
  const source = path.join(root, "program.so");
  const displaced = path.join(root, "program.old.so");
  const original = Buffer.from("original-inode");
  await writeFile(source, original, { mode: 0o770 });
  const artifact = await captureLocalnetProgramArtifact(source);

  await rename(source, displaced);
  await writeFile(source, "replacement-inode", { mode: 0o770 });
  const snapshot = await materializeLocalnetProgramSnapshot(
    artifact,
    path.join(root, "state"),
  );
  try {
    assert.deepEqual(await readFile(`/proc/self/fd/${snapshot.fd}`), original);
  } finally {
    await snapshot.close();
  }
});

test("capture rejects aliases and unbounded or empty program sources", async (t) => {
  const root = await temporaryRoot(t, "agenc-program-snapshot-refuse-");
  const source = path.join(root, "program.so");
  const alias = path.join(root, "program.alias.so");
  const symbolic = path.join(root, "program.symlink.so");
  await writeFile(source, "program", { mode: 0o770 });
  await link(source, alias);
  await assert.rejects(
    captureLocalnetProgramArtifact(source),
    /single-link regular file/,
  );
  await rm(alias);
  await symlink(source, symbolic);
  await assert.rejects(
    captureLocalnetProgramArtifact(symbolic),
    /could not capture localnet program artifact/,
  );

  const empty = path.join(root, "empty.so");
  await writeFile(empty, "");
  await assert.rejects(captureLocalnetProgramArtifact(empty), /bounded size/);

  const oversized = path.join(root, "oversized.so");
  await writeFile(oversized, "x");
  await truncate(oversized, 32 * 1024 * 1024 + 1);
  await assert.rejects(
    captureLocalnetProgramArtifact(oversized),
    /bounded size/,
  );
});

test("materialization accepts only artifacts captured by this rail", async (t) => {
  const root = await temporaryRoot(t, "agenc-program-snapshot-forge-");
  await assert.rejects(
    materializeLocalnetProgramSnapshot(
      Object.freeze({ sha256: "00".repeat(32), size: 1 }),
      path.join(root, "state"),
    ),
    /was not captured by this rail/,
  );
});

test("ProgramData verification binds the live payload and zero capacity", async (t) => {
  const root = await temporaryRoot(t, "agenc-programdata-verify-");
  const source = path.join(root, "program.so");
  const executable = Buffer.from("live-executable");
  await writeFile(source, executable, { mode: 0o770 });
  const artifact = await captureLocalnetProgramArtifact(source);
  const header = Buffer.alloc(45);
  header.writeUInt32LE(3, 0);
  header[12] = 1;
  const authority = Buffer.alloc(32, 7);
  authority.copy(header, 13);
  const valid = Buffer.concat([header, executable, Buffer.alloc(32)]);
  assert.doesNotThrow(() =>
    assertLocalnetProgramDataMatchesArtifact(artifact, valid, authority),
  );

  const changed = Buffer.from(valid);
  changed[45] ^= 0xff;
  assert.throws(
    () =>
      assertLocalnetProgramDataMatchesArtifact(artifact, changed, authority),
    /do not match/,
  );
  const dirtyCapacity = Buffer.from(valid);
  dirtyCapacity[dirtyCapacity.length - 1] = 1;
  assert.throws(
    () =>
      assertLocalnetProgramDataMatchesArtifact(
        artifact,
        dirtyCapacity,
        authority,
      ),
    /nonzero executable bytes/,
  );
  for (const malformed of [
    Buffer.alloc(44),
    Buffer.from(valid).fill(0, 0, 4),
    Buffer.from(valid).fill(2, 12, 13),
  ]) {
    assert.throws(
      () =>
        assertLocalnetProgramDataMatchesArtifact(
          artifact,
          malformed,
          authority,
        ),
      /invalid loader layout or upgrade authority/,
    );
  }

  const wrongAuthority = Buffer.alloc(32, 8);
  assert.throws(
    () =>
      assertLocalnetProgramDataMatchesArtifact(artifact, valid, wrongAuthority),
    /upgrade authority/,
  );
});

test("Program account verification requires the canonical ProgramData link", () => {
  const programDataAddress = Buffer.alloc(32, 9);
  const program = Buffer.alloc(36);
  program.writeUInt32LE(2, 0);
  programDataAddress.copy(program, 4);
  assert.doesNotThrow(() =>
    assertLocalnetProgramAccountLinksProgramData(program, programDataAddress),
  );
  for (const malformed of [
    Buffer.alloc(35),
    Buffer.from(program).fill(0, 0, 4),
    Buffer.from(program).fill(1, 35, 36),
  ]) {
    assert.throws(
      () =>
        assertLocalnetProgramAccountLinksProgramData(
          malformed,
          programDataAddress,
        ),
      /does not link/,
    );
  }
});
