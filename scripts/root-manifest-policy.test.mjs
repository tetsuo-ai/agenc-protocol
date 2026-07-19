import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("package.json", repositoryRoot), "utf8"),
);
const lock = JSON.parse(
  await readFile(new URL("package-lock.json", repositoryRoot), "utf8"),
);

const allowedRootKeys = [
  "allowScripts",
  "description",
  "devDependencies",
  "engines",
  "name",
  "overrides",
  "packageManager",
  "private",
  "scripts",
  "version",
  "workspaces",
];

test("private workspace root cannot become a publishable runtime package", () => {
  assert.equal(manifest.private, true);
  assert.deepEqual(Object.keys(manifest).sort(), allowedRootKeys);
  assert.equal(manifest.dependencies, undefined);

  const lockRoot = lock.packages?.[""];
  assert.ok(lockRoot, "package-lock is missing its root package record");
  assert.equal(lockRoot.dependencies, undefined);
  assert.deepEqual(lockRoot.devDependencies, manifest.devDependencies);
  assert.deepEqual(lockRoot.workspaces, manifest.workspaces);
});
