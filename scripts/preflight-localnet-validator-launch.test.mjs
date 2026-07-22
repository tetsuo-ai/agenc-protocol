import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { LOCALNET_PROGRAM_LOAD_METHOD } from "./localnet-program-binding.mjs";
import {
  ensureValidatorLaunchIntentFile,
  parseValidatorLaunchIntent,
  readValidatorLaunchIntentFile,
  replaceValidatorLaunchIntentFile,
} from "./localnet-validator-launch.mjs";

const PROGRAM_ID = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
const PROGRAM_SHA256 = "ab".repeat(32);
const PROGRAM_SIZE = 2_284_496;

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "agenc-launch-intent-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const stateDirectory = path.join(parent, "state");
  return {
    parent,
    file: path.join(stateDirectory, "validator.starting"),
    expected: {
      repoRoot: parent,
      ledgerDir: path.join(stateDirectory, "ledger"),
      programId: PROGRAM_ID,
      programSha256: PROGRAM_SHA256,
      programSize: PROGRAM_SIZE,
    },
  };
}

test("validator launch intent is private, durable, exact, and idempotent", async (t) => {
  const { file, expected } = await fixture(t);
  const created = await ensureValidatorLaunchIntentFile(file, expected);
  assert.equal(created.role, "validator-starting");
  assert.equal(created.uid, process.getuid());
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(
    await readValidatorLaunchIntentFile(file, expected),
    created,
  );
  assert.deepEqual(
    await ensureValidatorLaunchIntentFile(file, expected),
    created,
  );
  assert.match(await readFile(file, "utf8"), /"validator-starting"/);

  await assert.rejects(
    readValidatorLaunchIntentFile(file, {
      ...expected,
      ledgerDir: `${expected.ledgerDir}-wrong`,
    }),
    /does not belong to this localnet ledgerDir/,
  );
  await assert.rejects(
    readValidatorLaunchIntentFile(file, {
      ...expected,
      programSha256: "cd".repeat(32),
    }),
    /does not belong to this localnet programSha256/,
  );
});

test("reset launch atomically replaces a validated prior artifact binding", async (t) => {
  const { file, expected } = await fixture(t);
  const prior = await ensureValidatorLaunchIntentFile(file, expected);
  const replacement = await replaceValidatorLaunchIntentFile(file, {
    ...expected,
    programSha256: "cd".repeat(32),
    programSize: PROGRAM_SIZE + 1,
  });
  assert.notEqual(replacement.createdAt, undefined);
  assert.notEqual(replacement.programSha256, prior.programSha256);
  assert.deepEqual(
    await readValidatorLaunchIntentFile(file, {
      ...expected,
      programSha256: "cd".repeat(32),
      programSize: PROGRAM_SIZE + 1,
    }),
    replacement,
  );
});

test("launch-intent parser rejects extra, malformed, and foreign fields", () => {
  const valid = {
    schemaVersion: 2,
    role: "validator-starting",
    uid: typeof process.getuid === "function" ? process.getuid() : 1000,
    repoRoot: "/tmp/repo",
    ledgerDir: "/tmp/repo/.localnet/ledger",
    programId: PROGRAM_ID,
    programSha256: PROGRAM_SHA256,
    programSize: PROGRAM_SIZE,
    programLoadMethod: LOCALNET_PROGRAM_LOAD_METHOD,
    createdAt: "2026-07-20T20:00:00.000Z",
  };
  assert.equal(
    parseValidatorLaunchIntent(JSON.stringify(valid)).programId,
    PROGRAM_ID,
  );
  for (const mutation of [
    { extra: true },
    { schemaVersion: 1 },
    { role: "validator" },
    { repoRoot: "relative" },
    { programId: "not-base58" },
    { programLoadMethod: "mutable-path" },
    { createdAt: "yesterday" },
  ]) {
    assert.throws(
      () =>
        parseValidatorLaunchIntent(JSON.stringify({ ...valid, ...mutation })),
      /invalid or unsupported/,
    );
  }
});

test("launch intent never follows or accepts attacker-controlled leaves", async (t) => {
  const { parent, file, expected } = await fixture(t);
  await ensureValidatorLaunchIntentFile(file, expected);
  await rm(file);
  const outside = path.join(parent, "outside");
  await writeFile(outside, "unchanged", { mode: 0o600 });
  await symlink(outside, file);
  await assert.rejects(
    readValidatorLaunchIntentFile(file, expected),
    /private, current-user-owned, single-link file/,
  );
  assert.equal(await readFile(outside, "utf8"), "unchanged");

  await rm(file);
  const body = `${JSON.stringify({
    schemaVersion: 1,
    role: "validator-starting",
    uid: process.getuid(),
    ...expected,
    createdAt: new Date().toISOString(),
  })}\n`;
  await writeFile(file, body, { mode: 0o600 });
  const secondLink = path.join(parent, "second-link");
  await link(file, secondLink);
  await assert.rejects(
    readValidatorLaunchIntentFile(file, expected),
    /single-link file/,
  );
  await rm(secondLink);
  await chmod(file, 0o640);
  await assert.rejects(
    readValidatorLaunchIntentFile(file, expected),
    /private, current-user-owned/,
  );
});
