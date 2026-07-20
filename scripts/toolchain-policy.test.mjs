import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const ROOT = new URL("../", import.meta.url);
const RELEASE_NODE = "24.18.0";
const MINIMUM_NODE = "22.23.1";
const RELEASE_RUST = "1.85.0";
const PROGRAM_MSRV = "1.82.0";

async function json(path) {
  return JSON.parse(await readFile(new URL(path, ROOT), "utf8"));
}

async function yaml(path) {
  return parse(await readFile(new URL(path, ROOT), "utf8"));
}

test("repository pins exact Node/npm and Rust release toolchains", async () => {
  const [rootPackage, rustToolchain, nodeVersion, nvmrc] = await Promise.all([
    json("package.json"),
    readFile(new URL("rust-toolchain.toml", ROOT), "utf8"),
    readFile(new URL(".node-version", ROOT), "utf8"),
    readFile(new URL(".nvmrc", ROOT), "utf8"),
  ]);
  assert.equal(rootPackage.packageManager, "npm@11.18.0");
  assert.equal(rootPackage.engines.npm, "11.18.0");
  assert.equal(nodeVersion.trim(), RELEASE_NODE);
  assert.equal(nvmrc.trim(), RELEASE_NODE);
  assert.match(rustToolchain, new RegExp(`channel = "${RELEASE_RUST}"`));

  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/sdk.yml",
    ".github/workflows/idl-drift.yml",
    ".github/workflows/release.yml",
    ".github/workflows/sandbox-nightly.yml",
  ]) {
    const workflow = await yaml(path);
    const setupNode = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => String(step.uses ?? "").startsWith("actions/setup-node@"));
    assert.ok(setupNode.length > 0, `${path} must set up Node`);
    assert.ok(
      setupNode.every((step) => String(step.with?.["node-version"]) === RELEASE_NODE),
      `${path} must pin Node ${RELEASE_NODE}`,
    );
  }

  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/sdk.yml",
    ".github/workflows/idl-drift.yml",
    ".github/workflows/release.yml",
    ".github/workflows/verify.yml",
  ]) {
    const workflow = await yaml(path);
    const rustSteps = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => String(step.uses ?? "").startsWith("dtolnay/rust-toolchain@"));
    assert.ok(rustSteps.length > 0, `${path} must set up Rust`);
    assert.ok(
      rustSteps.every((step) => String(step.with?.toolchain) === RELEASE_RUST),
      `${path} must pin Rust ${RELEASE_RUST}`,
    );
  }
});

test("advertised minimum runtimes have explicit compatibility jobs", async () => {
  const [compatibility, programCargo, packageFiles] = await Promise.all([
    yaml(".github/workflows/compatibility.yml"),
    readFile(new URL("programs/agenc-coordination/Cargo.toml", ROOT), "utf8"),
    Promise.all(
      [
        "protocol",
        "sdk-ts",
        "marketplace-react",
        "marketplace-tools",
        "marketplace-mcp",
        "marketplace-moderation",
        "agenc-worker",
        "agenc-cli",
        "agenc-cli-alias",
      ].map((directory) => json(`packages/${directory}/package.json`)),
    ),
  ]);
  assert.match(programCargo, /rust-version = "1\.82"/);
  assert.ok(
    packageFiles.every((manifest) => manifest.engines?.node === `>=${MINIMUM_NODE}`),
  );
  const nodeSetup = compatibility.jobs["node-minimum"].steps.find(
    (step) => step.name === "Setup minimum supported Node",
  );
  assert.equal(String(nodeSetup.with["node-version"]), MINIMUM_NODE);
  assert.match(
    compatibility.jobs["node-minimum"].steps
      .map((step) => step.run ?? "")
      .join("\n"),
    /npm@11\.18\.0/,
  );
  const rustSetup = compatibility.jobs["rust-msrv"].steps.find(
    (step) => step.name === "Setup declared program MSRV",
  );
  assert.equal(String(rustSetup.with.toolchain), PROGRAM_MSRV);
  assert.ok(
    compatibility.jobs["rust-msrv"].steps
      .filter((step) => step.run)
      .every((step) => !String(step.run).includes("cargo ") || String(step.run).includes("+1.82.0")),
  );
});

test("every GitHub-hosted workflow job pins the Ubuntu 24.04 runner family", async () => {
  const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
  const files = (await readdir(workflowDirectory))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

  for (const file of files) {
    const workflow = await yaml(`.github/workflows/${file}`);
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (typeof job["runs-on"] !== "string") continue;
      assert.equal(
        job["runs-on"],
        "ubuntu-24.04",
        `${file}:${jobName} must not follow a mutable latest runner label`,
      );
    }
  }
});
