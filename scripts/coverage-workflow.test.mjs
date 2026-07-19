import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const WORKFLOW = new URL("../.github/workflows/coverage.yml", import.meta.url);

test("coverage workflow pins its tools, checks the production manifest, and retains evidence", async () => {
  const workflow = parse(await readFile(WORKFLOW, "utf8"));
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  const steps = workflow.jobs["program-coverage"].steps;
  const install = steps.find(({ name }) => name === "Install pinned coverage tool");
  const measure = steps.find(({ name }) => name === "Measure default production surface");
  const enforce = steps.find(({ name }) => name === "Enforce coverage ratchet");
  const upload = steps.find(({ name }) => name === "Upload machine-readable coverage evidence");
  assert.match(install.run, /cargo-llvm-cov --version 0\.6\.21 --locked/);
  assert.match(measure.run, /programs\/agenc-coordination\/Cargo\.toml/);
  assert.match(measure.run, /--locked --all-targets/);
  assert.match(enforce.run, /check-coverage\.mjs/);
  assert.equal(upload.if, "always()");
  assert.equal(upload.with["if-no-files-found"], "error");
  for (const { uses } of steps) {
    if (uses) assert.match(uses, /@[0-9a-f]{40}$/i);
  }
});
