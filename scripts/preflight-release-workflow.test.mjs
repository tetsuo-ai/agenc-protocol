import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const RELEASE_WORKFLOW = new URL(
  "../.github/workflows/release.yml",
  import.meta.url,
);
const VERIFY_WORKFLOW = new URL(
  "../.github/workflows/verify.yml",
  import.meta.url,
);
const IDL_DRIFT_WORKFLOW = new URL(
  "../.github/workflows/idl-drift.yml",
  import.meta.url,
);
const TAG_BINDING_SCRIPT = new URL(
  "./verify-release-tag-binding.mjs",
  import.meta.url,
);
const ANNOTATION_PRESERVING_CHECKOUT =
  "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";

async function loadWorkflow(url) {
  return parse(await readFile(url, "utf8"));
}

function externalActionUses(workflow) {
  return Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? [])
      .map((step) => step.uses)
      .filter((uses) => typeof uses === "string" && !uses.startsWith("./")),
  );
}

test("protocol publication is fail-closed on the reusable verifiable build", async () => {
  const [release, verify, idlDrift] = await Promise.all([
    loadWorkflow(RELEASE_WORKFLOW),
    loadWorkflow(VERIFY_WORKFLOW),
    loadWorkflow(IDL_DRIFT_WORKFLOW),
  ]);

  assert.ok(Object.hasOwn(verify.on, "workflow_call"));
  assert.equal(release.permissions.contents, "read");

  const verifier = release.jobs.protocol_verifiable_build;
  assert.equal(verifier.uses, "./.github/workflows/verify.yml");
  assert.match(verifier.if, /protocol-v/);
  assert.equal(verifier.permissions.contents, "read");

  const releaseJob = release.jobs.release;
  assert.equal(releaseJob.needs, "protocol_verifiable_build");
  assert.match(releaseJob.if, /protocol_verifiable_build\.result == 'success'/);
  assert.equal(releaseJob.permissions.actions, "read");
  assert.equal(releaseJob.permissions.contents, "write");
  assert.equal(releaseJob.permissions["id-token"], "write");

  const checkout = releaseJob.steps.find((step) => step.name === "Checkout");
  assert.ok(checkout);
  assert.equal(checkout.uses, ANNOTATION_PRESERVING_CHECKOUT);
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);

  const names = releaseJob.steps.map((step) => step.name);
  const download = names.indexOf("Download required verifiable-build hashes");
  const draft = names.indexOf("Prepare GitHub Release draft");
  const attach = names.indexOf("Attach required verifiable-build hashes");
  const npmPublish = names.indexOf("Publish to npm");
  const releasePublish = names.indexOf("Publish GitHub Release");
  assert.ok(download >= 0 && download < draft);
  assert.ok(
    draft < attach && attach < npmPublish && npmPublish < releasePublish,
  );

  const draftStep = releaseJob.steps[draft];
  assert.match(draftStep.run, /--verify-tag/);
  assert.match(draftStep.run, /--draft/);
  assert.match(releaseJob.steps[attach].run, /verifiable-build-hashes\.txt/);
  assert.match(releaseJob.steps[releasePublish].run, /--draft=false/);

  const productionBuild = names.indexOf(
    "Anchor build (protocol gate — fresh IDL/types for the drift check)",
  );
  const productionIntegration = names.indexOf(
    "Compiled-program integration suite (protocol gate)",
  );
  const productionPackage = names.indexOf(
    "Protocol gate (artifacts check, build, typecheck, pack smoke)",
  );
  const canaryBuild = names.indexOf("Build mainnet-canary SBF (protocol gate)");
  const canaryIdl = names.indexOf("Build mainnet-canary IDL (protocol gate)");
  const canaryCompiled = names.indexOf(
    "Compiled mainnet-canary LiteSVM regression (protocol gate)",
  );
  assert.ok(
    productionBuild >= 0 &&
      productionBuild < productionIntegration &&
      productionIntegration < productionPackage &&
      productionPackage < canaryBuild &&
      canaryBuild < canaryIdl &&
      canaryIdl < canaryCompiled,
    "production gates must finish before the shared .so is replaced by the canary build",
  );
  assert.equal(releaseJob.steps[canaryCompiled].env.AGENC_CANARY_LITESVM, "1");
  assert.match(
    releaseJob.steps[canaryCompiled].run,
    /canary-timeout-accept\.test\.mjs/,
  );

  const driftSteps = idlDrift.jobs["idl-drift"].steps;
  const driftNames = driftSteps.map((step) => step.name);
  const driftProductionBuild = driftNames.indexOf(
    "Anchor build (full surface, default features)",
  );
  const driftProductionArtifacts = driftNames.indexOf(
    "Verify committed protocol artifacts against the fresh build",
  );
  const driftCanaryBuild = driftNames.indexOf("Build mainnet-canary SBF");
  const driftCanaryIdl = driftNames.indexOf("Build mainnet-canary IDL");
  const driftCanaryCompiled = driftNames.indexOf(
    "Compiled mainnet-canary LiteSVM regression",
  );
  assert.ok(
    driftProductionBuild >= 0 &&
      driftProductionBuild < driftProductionArtifacts &&
      driftProductionArtifacts < driftCanaryBuild &&
      driftCanaryBuild < driftCanaryIdl &&
      driftCanaryIdl < driftCanaryCompiled,
    "IDL drift must compare production artifacts before replacing the shared .so with canary",
  );
  assert.equal(driftSteps[driftCanaryCompiled].env.AGENC_CANARY_LITESVM, "1");
  assert.match(
    driftSteps[driftCanaryCompiled].run,
    /canary-timeout-accept\.test\.mjs/,
  );
});

test("release shell never directly interpolates tag-derived package outputs", async () => {
  const [release, verify] = await Promise.all([
    loadWorkflow(RELEASE_WORKFLOW),
    loadWorkflow(VERIFY_WORKFLOW),
  ]);
  const scripts = [release, verify]
    .flatMap((workflow) => Object.values(workflow.jobs))
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run)
    .filter((run) => typeof run === "string")
    .join("\n");

  assert.doesNotMatch(
    scripts,
    /\$\{\{\s*steps\.pkg\.outputs\.(?:name|version|dir)\s*\}\}/,
  );
  assert.doesNotMatch(
    scripts,
    /\$\{\{\s*steps\.(?:full_hash|canary_hash)\.outputs\.hash\s*\}\}/,
  );
  assert.match(scripts, /invalid semantic version/);
  assert.match(scripts, /git merge-base --is-ancestor/);
  assert.match(scripts, /invalid production executable hash/);
  assert.match(scripts, /invalid canary executable hash/);
});

test("package resolver exports only shell-safe version text", async (t) => {
  const release = await loadWorkflow(RELEASE_WORKFLOW);
  const resolver = release.jobs.release.steps.find(
    (step) => step.name === "Resolve package from tag",
  );
  assert.ok(resolver);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-release-resolve-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  function resolve(tag, suffix) {
    const output = join(temporaryRoot, `output-${suffix}`);
    const result = spawnSync("bash", ["-euo", "pipefail"], {
      cwd: temporaryRoot,
      env: {
        ...process.env,
        GITHUB_REF_NAME: tag,
        GITHUB_OUTPUT: output,
      },
      input: resolver.run,
      encoding: "utf8",
    });
    return { output, result };
  }

  const valid = resolve("sdk-v1.2.3-rc.1+build.7", "valid");
  assert.equal(valid.result.status, 0, valid.result.stderr);
  assert.equal(
    await readFile(valid.output, "utf8"),
    "name=@tetsuo-ai/marketplace-sdk\n" +
      "dir=packages/sdk-ts\n" +
      "version=1.2.3-rc.1+build.7\n",
  );

  const shellLooking = resolve(
    "sdk-v1.2.3;touch resolver_PWNED",
    "shell-looking",
  );
  assert.notEqual(shellLooking.result.status, 0);
  assert.match(shellLooking.result.stderr, /invalid semantic version/);
  await assert.rejects(access(join(temporaryRoot, "resolver_PWNED")));

  const outputLooking = resolve(
    "sdk-v1.2.3\nname=attacker-controlled",
    "output-looking",
  );
  assert.notEqual(outputLooking.result.status, 0);
  assert.match(outputLooking.result.stderr, /invalid semantic version/);
});

test("release and verifier external actions are immutable-SHA pinned", async () => {
  const workflows = await Promise.all([
    loadWorkflow(RELEASE_WORKFLOW),
    loadWorkflow(VERIFY_WORKFLOW),
  ]);
  const uses = workflows.flatMap(externalActionUses);
  assert.ok(uses.length > 0);
  for (const action of uses) {
    assert.match(
      action,
      /@[0-9a-f]{40}$/i,
      `${action} must use a full commit SHA`,
    );
  }
});

test("every release mutation re-resolves the remote tag to the event commit", async () => {
  const [release, bindingScript] = await Promise.all([
    loadWorkflow(RELEASE_WORKFLOW),
    readFile(TAG_BINDING_SCRIPT, "utf8"),
  ]);
  const releaseSteps = release.jobs.release.steps;
  const guardedSteps = [
    "Prepare GitHub Release draft",
    "Attach required verifiable-build hashes",
    "Publish to npm",
    "Publish GitHub Release",
  ];

  for (const name of guardedSteps) {
    const step = releaseSteps.find((candidate) => candidate.name === name);
    assert.ok(step, `missing release step: ${name}`);
    assert.match(step.run, /verify-release-tag-binding\.mjs/);
    const guard = step.run.indexOf("verify-release-tag-binding.mjs");
    const firstRemoteOperation = ["gh release", "npm view", "npm publish"]
      .map((command) => step.run.indexOf(command))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    assert.ok(
      guard >= 0 && guard < firstRemoteOperation,
      `${name} must verify first`,
    );

    const syntax = spawnSync("bash", ["-n"], {
      input: step.run,
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, `${name}: ${syntax.stderr}`);
  }

  assert.match(
    bindingScript,
    /\["ls-remote", "--exit-code", "origin", directRef, peeledRef\]/,
  );
  assert.match(bindingScript, /refs\/tags\//);
  assert.match(bindingScript, /\^\{\}/);
  assert.match(bindingScript, /GITHUB_REF_NAME/);
  assert.match(bindingScript, /GITHUB_SHA/);
  assert.match(
    bindingScript,
    /actualCommit\.toLowerCase\(\) !== expectedSourceCommit\.toLowerCase\(\)/,
  );
  assert.match(
    bindingScript,
    /directObject\?\.toLowerCase\(\) !== expectedCommit\.toLowerCase\(\)/,
  );
});

test("an existing npm version fails closed instead of bypassing provenance", async () => {
  const release = await loadWorkflow(RELEASE_WORKFLOW);
  const publish = release.jobs.release.steps.find(
    (step) => step.name === "Publish to npm",
  );
  assert.ok(publish);
  const lookup = publish.run.indexOf("if npm view");
  const refusal = publish.run.indexOf("exit 1", lookup);
  const provenancePublish = publish.run.indexOf(
    "npm publish --access public --provenance",
  );

  assert.ok(lookup >= 0 && refusal > lookup && provenancePublish > refusal);
  assert.doesNotMatch(publish.run, /skipping publish/i);
  assert.match(publish.run, /refusing to endorse an unverified tarball/);
});
