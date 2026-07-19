import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const ROOT = new URL("../", import.meta.url);
const WORKFLOW = new URL(".github/workflows/supply-chain.yml", ROOT);
const CI_WORKFLOW = new URL(".github/workflows/ci.yml", ROOT);
const RUST_WORKFLOW = new URL(".github/workflows/rust-supply-chain.yml", ROOT);
const DEPENDABOT = new URL(".github/dependabot.yml", ROOT);
const GITLEAKS = new URL(".gitleaks.toml", ROOT);
const NPM_POLICY = new URL("supply-chain/npm-license-policy.json", ROOT);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "target"]);
const INSTALL_ROOTS = [
  ".",
  "packages/marketplace-react/examples/marketplace-starter",
  "packages/marketplace-react/test-apps/checkout",
  "packages/marketplace-react/test-apps/next-ssr",
  "packages/marketplace-react/test/playwright",
  "tests-integration",
];

async function discoverNpmLocks() {
  const root = fileURLToPath(ROOT);
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name === "package-lock.json") {
        found.push(relative(root, absolute).split(sep).join("/"));
      }
    }
  }
  await visit(root);
  return found.sort();
}

test("CodeQL, history secret scanning, and npm policy run fail-closed", async () => {
  const workflow = parse(await readFile(WORKFLOW, "utf8"));
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.ok(Object.hasOwn(workflow.on, "schedule"));

  const codeql = workflow.jobs.codeql;
  assert.equal(codeql.permissions["security-events"], "write");
  const codeqlActions = codeql.steps.filter(({ uses }) =>
    uses?.startsWith("github/codeql-action/"),
  );
  assert.deepEqual(
    codeqlActions.map(({ uses }) => uses),
    [
      "github/codeql-action/init@eec0bff2f6c15bf3f1e8a0152f94d17664a06a06",
      "github/codeql-action/analyze@eec0bff2f6c15bf3f1e8a0152f94d17664a06a06",
    ],
  );
  assert.equal(codeqlActions[0].with.languages, "javascript-typescript");

  const secretSteps = workflow.jobs["history-secret-scan"].steps;
  const checkout = secretSteps.find(({ uses }) =>
    uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with["fetch-depth"], 0);
  const install = secretSteps.find(
    ({ name }) => name === "Install checksum-pinned gitleaks",
  );
  assert.equal(install.env.GITLEAKS_VERSION, "8.30.1");
  assert.match(install.env.GITLEAKS_SHA256, /^[0-9a-f]{64}$/);
  assert.match(install.run, /sha256sum --check --strict/);
  const scan = secretSteps.find(
    ({ name }) => name === "Scan every reachable commit",
  );
  assert.match(scan.run, /--all --full-history/);
  assert.match(scan.run, /--config \.gitleaks\.toml/);

  const npmSteps = workflow.jobs["npm-policy"].steps;
  const toolchain = npmSteps.find(
    ({ name }) => name === "Pin declared npm toolchain",
  );
  assert.match(toolchain.run, /npm@11\.18\.0/);
  assert.match(toolchain.run, /grep -Fx 11\.18\.0/);
  const config = npmSteps.find(
    ({ name }) => name === "Verify fail-closed npm configuration",
  );
  assert.match(config.run, /npm config get dangerously-allow-all-scripts/);
  assert.match(config.run, /npm config get engine-strict/);
  assert.match(config.run, /npm config get strict-allow-scripts/);
  const installs = npmSteps.find(
    ({ name }) => name === "Install license evidence without lifecycle scripts",
  );
  assert.match(installs.run, /npm ci --ignore-scripts/);
  for (const root of INSTALL_ROOTS) {
    assert.ok(
      config.run.includes(`"${root}"`),
      `${root} config must be checked`,
    );
    assert.ok(
      installs.run.includes(`"${root}"`),
      `${root} lock must be installed`,
    );
  }
  assert.ok(
    npmSteps.some(({ run }) => run?.includes("check-npm-licenses.mjs")),
  );
  assert.ok(
    npmSteps.some(
      ({ run }) => run === "node scripts/check-npm-install-scripts.mjs",
    ),
  );
  assert.ok(
    npmSteps.some(({ run }) =>
      run?.includes("scripts/check-npm-install-scripts.test.mjs"),
    ),
  );
  assert.ok(
    npmSteps.some(({ run }) => run === "npm audit --omit=dev --workspaces"),
  );
  assert.ok(
    npmSteps.some(({ run }) => run === "npm run audit:tests-integration"),
  );

  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/i);
    }
  }
});

test("the gitleaks exception permits only the exact public regression vector", async () => {
  const source = await readFile(GITLEAKS, "utf8");
  assert.match(source, /useDefault = true/);
  assert.match(source, /whsec_3q9QGiHxBcDdXxJZBkPMV7Fy/);
  assert.doesNotMatch(source, /paths\s*=|commits\s*=|stopwords\s*=/);
  const regexes = source.match(/regexes\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  assert.equal((regexes.match(/whsec_/g) ?? []).length, 1);
});

test("Dependabot covers every independent npm lock", async () => {
  const [dependabot, policy, locks] = await Promise.all([
    readFile(DEPENDABOT, "utf8").then(parse),
    readFile(NPM_POLICY, "utf8").then(JSON.parse),
    discoverNpmLocks(),
  ]);
  const npmDirectories = dependabot.updates
    .filter((entry) => entry["package-ecosystem"] === "npm")
    .map(({ directory }) => directory)
    .sort();
  const discoveredDirectories = locks
    .map((lock) => (lock === "package-lock.json" ? "/" : `/${dirname(lock)}`))
    .sort();
  assert.deepEqual(npmDirectories, discoveredDirectories);
  assert.deepEqual(policy.lockfiles, locks);
});

test("runtime advisory checks run on ordinary CI and quiet-period schedules", async () => {
  const [ci, rust] = await Promise.all([
    readFile(CI_WORKFLOW, "utf8").then(parse),
    readFile(RUST_WORKFLOW, "utf8").then(parse),
  ]);
  const ciRuns = ci.jobs.verify.steps.map(({ run }) => run).filter(Boolean);
  assert.ok(
    ciRuns.includes("npm audit --omit=dev --workspaces"),
    "normal CI must audit root workspace runtime dependencies",
  );
  assert.ok(Object.hasOwn(rust.on, "pull_request"));
  assert.ok(Object.hasOwn(rust.on, "schedule"));
  assert.ok(rust.on.schedule.some(({ cron }) => typeof cron === "string"));
});
