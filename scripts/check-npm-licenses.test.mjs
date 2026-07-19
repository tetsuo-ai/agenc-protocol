import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    asOf: "2026-07-19",
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
  expired.asOf = "2026-10-17";
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
