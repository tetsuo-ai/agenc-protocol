import assert from "node:assert/strict";
import { readFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { evaluateNpmLicensePolicy } from "./check-npm-licenses.mjs";

const ROOT = new URL("../", import.meta.url);

async function repositoryInput() {
  const policy = JSON.parse(
    await readFile(new URL("supply-chain/npm-license-policy.json", ROOT), "utf8"),
  );
  const lockfiles = new Map(
    await Promise.all(
      policy.lockfiles.map(async (path) => [
        path,
        JSON.parse(await readFile(new URL(path, ROOT), "utf8")),
      ]),
    ),
  );
  const licenseDigests = new Map(
    policy.exceptionGroups
      .flatMap(({ entries }) => entries)
      .filter(({ licenseFile }) => licenseFile)
      .map(({ licenseFile, licenseSha256 }) => [licenseFile, licenseSha256]),
  );
  const codeowners = await readFile(new URL(".github/CODEOWNERS", ROOT), "utf8");
  return {
    policy,
    lockfiles,
    licenseDigests,
    codeowners,
    asOf: policy.exceptionGroups.map((group) => group.reviewedOn).sort().at(-1),
  };
}

test("every npm lock is covered by the exact license policy", async () => {
  const result = evaluateNpmLicensePolicy(await repositoryInput());
  assert.equal(result.lockfiles, 6);
  assert.ok(result.checked > 1_000);
  assert.equal(result.excepted, 19);
});

test("unknown licenses fail closed", async () => {
  const input = await repositoryInput();
  const lock = structuredClone(input.lockfiles.get("package-lock.json"));
  lock.packages["node_modules/typescript"].license = "AGPL-3.0-only";
  input.lockfiles.set("package-lock.json", lock);
  assert.throws(
    () => evaluateNpmLicensePolicy(input),
    /typescript@.*unapproved license "AGPL-3.0-only"/,
  );
});

test("expired, stale, and changed evidence exceptions fail closed", async () => {
  const expired = await repositoryInput();
  expired.asOf = expired.policy.exceptionGroups[0].expiresOn;
  assert.throws(() => evaluateNpmLicensePolicy(expired), /invalid or expired/);

  const stale = await repositoryInput();
  stale.policy = structuredClone(stale.policy);
  stale.policy.exceptionGroups[0].entries[0].version = "0.0.1";
  assert.throws(() => evaluateNpmLicensePolicy(stale), /only@0.0.2.*unapproved/);

  const digest = await repositoryInput();
  digest.licenseDigests.set("node_modules/spawndamnit/LICENSE", "00".repeat(32));
  assert.throws(() => evaluateNpmLicensePolicy(digest), /evidence digest mismatch/);
});

test("exception ownership and review windows are bounded by CODEOWNERS", async () => {
  const unowned = await repositoryInput();
  unowned.policy = structuredClone(unowned.policy);
  unowned.policy.exceptionGroups[0].owners = ["@unknown", "@unreviewed"];
  assert.throws(
    () => evaluateNpmLicensePolicy(unowned),
    /invalid or expired license exception group/,
  );

  const permanent = await repositoryInput();
  permanent.policy = structuredClone(permanent.policy);
  permanent.policy.exceptionGroups[0].expiresOn = "2099-12-31";
  assert.throws(
    () => evaluateNpmLicensePolicy(permanent),
    /invalid or expired license exception group/,
  );

  const impossibleDate = await repositoryInput();
  impossibleDate.policy = structuredClone(impossibleDate.policy);
  impossibleDate.policy.exceptionGroups[0].reviewedOn = "2026-02-30";
  assert.throws(
    () => evaluateNpmLicensePolicy(impossibleDate),
    /real calendar date/,
  );
});

test("a newly discovered package lock cannot bypass policy coverage", async () => {
  const input = await repositoryInput();
  input.lockfiles.set("unreviewed/package-lock.json", {
    name: "unreviewed",
    lockfileVersion: 3,
    packages: {},
  });
  assert.throws(
    () => evaluateNpmLicensePolicy(input),
    /lockfile inventory differs from repository locks/,
  );
});

test("license evidence paths cannot traverse through URL or platform normalization", async () => {
  for (const licenseFile of ["..\\secret", "%2e%2e/secret"]) {
    const input = await repositoryInput();
    input.policy = structuredClone(input.policy);
    const entry = input.policy.exceptionGroups[0].entries.find(
      (candidate) => candidate.licenseFile,
    );
    entry.licenseFile = licenseFile;
    assert.throws(
      () => evaluateNpmLicensePolicy(input),
      /canonical repository-relative path/,
    );
  }
});

test("actual npm policy CLI rejects an expired on-disk exception", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agenc-npm-license-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await repositoryInput();
  const files = [
    "scripts/check-npm-licenses.mjs", ".github/CODEOWNERS",
    ...input.policy.lockfiles,
    ...input.policy.exceptionGroups.flatMap(({ entries }) => entries)
      .map(({ licenseFile }) => licenseFile).filter(Boolean),
  ];
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await copyFile(new URL(file, ROOT), join(root, file));
  }
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const policy = structuredClone(input.policy);
  for (const group of policy.exceptionGroups) {
    group.reviewedOn = today;
    group.expiresOn = tomorrow;
  }
  const policyPath = join(root, "supply-chain/npm-license-policy.json");
  await mkdir(dirname(policyPath), { recursive: true });
  await writeFile(policyPath, JSON.stringify(policy));
  const run = () => spawnSync(process.execPath, [join(root, "scripts/check-npm-licenses.mjs")], {
    cwd: root, encoding: "utf8", timeout: 30_000,
  });
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /19 exact, owned exceptions/);
  for (let i = 0; i < policy.exceptionGroups.length; i++) {
    const expired = structuredClone(policy);
    expired.exceptionGroups[i].expiresOn = today;
    await writeFile(policyPath, JSON.stringify(expired));
    const result = run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`invalid or expired license exception group ${expired.exceptionGroups[i].id}`));
  }
});
