import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

import { resolveReleaseTag } from "./release-policy.mjs";

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
const CI_WORKFLOW = new URL("../.github/workflows/ci.yml", import.meta.url);
const SDK_WORKFLOW = new URL("../.github/workflows/sdk.yml", import.meta.url);
const REACT_FIXTURES_WORKFLOW = new URL(
  "../.github/workflows/react-fixtures.yml",
  import.meta.url,
);
const INTEGRATION_LOCKFILE = new URL(
  "../tests-integration/package-lock.json",
  import.meta.url,
);
const INTEGRATION_AUDIT_SCRIPT = new URL(
  "./audit-tests-integration.mjs",
  import.meta.url,
);
const TAG_BINDING_SCRIPT = new URL(
  "./verify-release-tag-binding.mjs",
  import.meta.url,
);
const RELEASE_POLICY_SCRIPT = new URL("./release-policy.mjs", import.meta.url);
const RELEASE_STATE_SCRIPT = new URL("./release-state.mjs", import.meta.url);
const NPM_PROVENANCE_SCRIPT = new URL("./verify-npm-provenance.mjs", import.meta.url);
const RELEASE_SBOM_SCRIPT = new URL("./release-sbom.mjs", import.meta.url);
const RUST_SUPPLY_WORKFLOW = new URL(
  "../.github/workflows/rust-supply-chain.yml",
  import.meta.url,
);
const RELEASE_TRAIN = new URL("../release-train.json", import.meta.url);
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
  const [release, verify, idlDrift, rustSupply] = await Promise.all([
    loadWorkflow(RELEASE_WORKFLOW),
    loadWorkflow(VERIFY_WORKFLOW),
    loadWorkflow(IDL_DRIFT_WORKFLOW),
    loadWorkflow(RUST_SUPPLY_WORKFLOW),
  ]);

  assert.ok(Object.hasOwn(verify.on, "workflow_call"));
  assert.equal(release.permissions.contents, "read");

  const verifier = release.jobs.protocol_verifiable_build;
  assert.equal(verifier.uses, "./.github/workflows/verify.yml");
  assert.match(verifier.if, /protocol-v/);
  assert.equal(verifier.permissions.contents, "read");

  const releaseJob = release.jobs.release;
  assert.deepEqual(releaseJob.needs, ["protocol_verifiable_build", "rust_supply_chain"]);
  assert.match(releaseJob.if, /protocol_verifiable_build\.result == 'success'/);
  assert.match(releaseJob.if, /rust_supply_chain\.result == 'success'/);
  assert.ok(Object.hasOwn(rustSupply.on, "workflow_call"));
  assert.equal(
    release.jobs.rust_supply_chain.uses,
    "./.github/workflows/rust-supply-chain.yml",
  );
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
  const sbom = names.indexOf("Generate deterministic SPDX release SBOM");
  const attachSbom = names.indexOf("Attach required SPDX release SBOM");
  const cutover = names.indexOf("Require finalized mainnet cutover for stable releases");
  const inspect = names.indexOf("Inspect resumable release state before mutation");
  const npmPublish = names.indexOf("Publish reviewed tarball to npm staging tag");
  const npmVerify = names.indexOf(
    "Verify npm integrity and provenance before changing public dist-tags",
  );
  const npmDistTag = names.indexOf("Advance reviewed npm dist-tag");
  const releasePublish = names.indexOf("Publish GitHub Release");
  assert.ok(
    download >= 0 &&
      download < cutover &&
      cutover < sbom &&
      sbom < inspect &&
      inspect < draft,
  );
  assert.ok(
    draft < attach &&
      attach < attachSbom &&
      attachSbom < npmPublish &&
      npmPublish < npmVerify &&
      npmVerify < npmDistTag &&
      npmDistTag < releasePublish,
  );

  const draftStep = releaseJob.steps[draft];
  assert.match(draftStep.run, /--verify-tag/);
  assert.match(draftStep.run, /--draft/);
  assert.match(releaseJob.steps[attach].run, /verifiable-build-hashes\.txt/);
  assert.match(releaseJob.steps[attach].if, /missing_assets/);
  assert.match(releaseJob.steps[attachSbom].if, /missing_assets/);
  assert.match(releaseJob.steps[attachSbom].run, /gh release upload/);
  assert.match(releaseJob.steps[releasePublish].run, /--draft=false/);

  const releaseAnchorDependencies = names.indexOf(
    "Install Anchor native build dependencies (cache miss only)",
  );
  const releaseAnchorInstall = names.indexOf(
    "Install anchor CLI (cache miss only)",
  );
  assert.ok(
    releaseAnchorDependencies >= 0 &&
      releaseAnchorDependencies < releaseAnchorInstall,
    "protocol release must install Anchor's native dependencies before a cache-miss build",
  );
  assert.equal(
    releaseJob.steps[releaseAnchorDependencies].if,
    "startsWith(github.ref_name, 'protocol-v') && steps.cache-anchor-protocol.outputs.cache-hit != 'true'",
  );
  assert.match(
    releaseJob.steps[releaseAnchorDependencies].run,
    /libudev-dev/,
  );
  assert.match(
    releaseJob.steps[releaseAnchorDependencies].run,
    /pkg-config/,
  );

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
  assert.equal(
    releaseJob.steps[canaryCompiled].run,
    "node --test tests-integration/canary-*.test.mjs",
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
  const driftIntegrationInstall = driftNames.indexOf(
    "Install compiled canary integration dependencies",
  );
  const driftAnchorDependencies = driftNames.indexOf(
    "Install Anchor native build dependencies (cache miss only)",
  );
  const driftAnchorInstall = driftNames.indexOf(
    "Install anchor CLI (cache miss only)",
  );
  assert.ok(
    driftProductionBuild >= 0 &&
      driftProductionBuild < driftProductionArtifacts &&
      driftProductionArtifacts < driftCanaryBuild &&
      driftCanaryBuild < driftCanaryIdl &&
      driftCanaryIdl < driftCanaryCompiled &&
      driftIntegrationInstall >= 0 &&
      driftIntegrationInstall < driftCanaryCompiled,
    "IDL drift must compare production artifacts before replacing the shared .so with canary",
  );
  assert.equal(
    driftSteps[driftIntegrationInstall]["working-directory"],
    "tests-integration",
  );
  assert.match(driftSteps[driftIntegrationInstall].run, /^npm ci$/);
  assert.equal(driftSteps[driftCanaryCompiled].env.AGENC_CANARY_LITESVM, "1");
  assert.equal(
    driftSteps[driftCanaryCompiled].run,
    "node --test tests-integration/canary-*.test.mjs",
  );
  assert.ok(
    driftAnchorDependencies >= 0 &&
      driftAnchorDependencies < driftAnchorInstall,
    "IDL drift must install Anchor's native dependencies before a cache-miss build",
  );
  assert.equal(
    driftSteps[driftAnchorDependencies].if,
    "steps.cache-anchor.outputs.cache-hit != 'true'",
  );
  assert.match(driftSteps[driftAnchorDependencies].run, /libudev-dev/);
  assert.match(driftSteps[driftAnchorDependencies].run, /pkg-config/);
});

test("release shell never directly interpolates tag-derived package outputs", async () => {
  const [release, verify, releasePolicySource] = await Promise.all([
    loadWorkflow(RELEASE_WORKFLOW),
    loadWorkflow(VERIFY_WORKFLOW),
    readFile(RELEASE_POLICY_SCRIPT, "utf8"),
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
  assert.match(releasePolicySource, /invalid semantic version/);
  assert.match(scripts, /git merge-base --is-ancestor/);
  assert.match(scripts, /invalid production executable hash/);
  assert.match(scripts, /invalid canary executable hash/);
});

test("normal pull-request CI enforces deployment and compiled integration gates", async () => {
  const [ci, sdk, reactFixtures, release, integrationLock, integrationAuditSource] = await Promise.all([
    loadWorkflow(CI_WORKFLOW),
    loadWorkflow(SDK_WORKFLOW),
    loadWorkflow(REACT_FIXTURES_WORKFLOW),
    loadWorkflow(RELEASE_WORKFLOW),
    readFile(INTEGRATION_LOCKFILE, "utf8").then(JSON.parse),
    readFile(INTEGRATION_AUDIT_SCRIPT, "utf8"),
  ]);

  const ciSteps = ci.jobs.verify.steps;
  const deployment = ciSteps.find(
    (step) => step.name === "Deployment and preflight script regressions",
  );
  assert.ok(deployment, "normal CI must run deployment/preflight regressions");
  assert.match(deployment.run, /test:deployment-scripts/);
  const ciPreflightInstall = ciSteps.find(
    (step) => step.name === "Install deployment/preflight dependencies",
  );
  assert.ok(ciPreflightInstall);
  assert.equal(ciPreflightInstall["working-directory"], "tests-integration");
  assert.match(ciPreflightInstall.run, /^npm ci$/);
  const ciPreflightAudit = ciSteps.find(
    (step) => step.name === "Audit independent deployment/preflight dependencies",
  );
  assert.ok(ciPreflightAudit);
  assert.match(ciPreflightAudit.run, /audit:tests-integration/);
  assert.ok(
    ciSteps.indexOf(ciPreflightInstall) < ciSteps.indexOf(ciPreflightAudit) &&
      ciSteps.indexOf(ciPreflightAudit) < ciSteps.indexOf(deployment),
  );

  const releaseSteps = release.jobs.release.steps;
  const releasePreflightInstall = releaseSteps.find(
    (step) => step.name === "Install deployment/preflight dependencies",
  );
  const releaseProtocolMatrix = releaseSteps.find(
    (step) => step.name === "Protocol Rust release matrix",
  );
  assert.ok(releasePreflightInstall);
  assert.ok(releaseProtocolMatrix);
  assert.equal(
    releasePreflightInstall["working-directory"],
    "tests-integration",
  );
  assert.match(releasePreflightInstall.if, /protocol-v/);
  assert.match(releasePreflightInstall.run, /^npm ci$/);
  const releasePreflightAudit = releaseSteps.find(
    (step) => step.name === "Audit independent deployment/preflight dependencies",
  );
  assert.ok(releasePreflightAudit);
  assert.match(releasePreflightAudit.if, /protocol-v/);
  assert.match(releasePreflightAudit.run, /audit:tests-integration/);
  assert.ok(
    releaseSteps.indexOf(releasePreflightInstall) <
      releaseSteps.indexOf(releasePreflightAudit) &&
      releaseSteps.indexOf(releasePreflightAudit) <
        releaseSteps.indexOf(releaseProtocolMatrix),
  );

  const sdkSteps = sdk.jobs["sdk-e2e"].steps;
  const integration = sdkSteps.find(
    (step) => step.name === "Root compiled-program integration suite",
  );
  assert.ok(integration, "normal SDK PR CI must run the root compiled integration suite");
  assert.match(integration.run, /tests-integration\/\*\.test\.mjs/);
  const integrationInstall = sdkSteps.find(
    (step) => step.name === "Install compiled-program integration dependencies",
  );
  assert.ok(
    integrationInstall,
    "compiled integration CI must install its independent lockfile",
  );
  assert.equal(integrationInstall["working-directory"], "tests-integration");
  assert.match(integrationInstall.run, /^npm ci$/);
  assert.equal(integrationLock.lockfileVersion, 3);
  assert.equal(
    integrationLock.packages[""].dependencies["@coral-xyz/anchor"],
    "^0.32.1",
  );
  assert.equal(
    integrationLock.packages["node_modules/rpc-websockets"].version,
    "9.3.8",
  );
  assert.equal(integrationLock.packages["node_modules/uuid"].version, "11.1.1");
  assert.equal(
    integrationLock.packages[""].dependencies["@solana/spl-token"],
    undefined,
  );
  assert.match(integrationAuditSource, /fail on every advisory severity/);
  assert.doesNotMatch(integrationAuditSource, /reviewedHighAdvisories/);
  assert.match(integrationAuditSource, /report\.error !== undefined/);
  assert.match(integrationAuditSource, /require\("@solana\/web3\.js"\)/);
  const idlStage = sdkSteps.find(
    (step) => step.name === "Stage committed IDL for compiled integration harness",
  );
  assert.ok(idlStage, "compiled integration CI must stage its reviewed IDL");
  assert.match(
    idlStage.run,
    /artifacts\/anchor\/idl\/agenc_coordination\.json/,
  );
  assert.match(idlStage.run, /target\/idl\/agenc_coordination\.json/);
  const buildIndex = sdkSteps.findIndex(
    (step) => step.name === "Build program (full surface, default features)",
  );
  const integrationInstallIndex = sdkSteps.indexOf(integrationInstall);
  const idlStageIndex = sdkSteps.indexOf(idlStage);
  const integrationIndex = sdkSteps.indexOf(integration);
  assert.ok(buildIndex >= 0 && buildIndex < integrationIndex);
  assert.ok(
    integrationInstallIndex >= 0 && integrationInstallIndex < integrationIndex,
  );
  assert.ok(idlStageIndex > buildIndex && idlStageIndex < integrationIndex);

  const workerBuild = sdkSteps.findIndex(
    (step) => step.name === "Build worker workspace dependency",
  );
  const downstreamTypecheck = sdkSteps.findIndex(
    (step) => step.name === "Downstream workspace typechecks",
  );
  assert.ok(
    workerBuild >= 0 && workerBuild < downstreamTypecheck,
    "SDK CI must build worker declarations before typechecking agenc-cli",
  );

  const fixtureBuild = reactFixtures.jobs["fixture-smoke"].steps.find(
    (step) => step.name === "Build fixture workspace dependencies",
  );
  assert.ok(fixtureBuild);
  assert.match(
    fixtureBuild.run,
    /marketplace-sdk[\s\S]*marketplace-react[\s\S]*agenc-worker[\s\S]*agenc-cli/,
  );

  for (const workflow of [ci, release]) {
    const rejectStep = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.name === "Reject mixed release surfaces");
    assert.ok(rejectStep);
    assert.match(rejectStep.run, /--no-default-features/);
    assert.match(rejectStep.run, /full protocol surface requires spl-token-rewards/);
  }
});

test("package resolver accepts only canonical semver and covers every release route", async () => {
  const train = JSON.parse(await readFile(RELEASE_TRAIN, "utf8"));
  const valid = resolveReleaseTag("sdk-v1.2.3-rc.1", train);
  assert.deepEqual(
    { name: valid.name, directory: valid.directory, version: valid.version, distTag: valid.distTag },
    {
      name: "@tetsuo-ai/marketplace-sdk",
      directory: "packages/sdk-ts",
      version: "1.2.3-rc.1",
      distTag: "next",
    },
  );
  assert.throws(
    () => resolveReleaseTag("sdk-v1.2.3-rc.1+build.7", train),
    /invalid semantic version/,
  );
  assert.throws(
    () => resolveReleaseTag("sdk-v1.2.3;touch resolver_PWNED", train),
    /invalid semantic version/,
  );
  assert.throws(
    () => resolveReleaseTag("sdk-v1.2.3\nname=attacker-controlled", train),
    /invalid semantic version/,
  );
  assert.deepEqual(
    new Set(train.packages.map(({ tagPrefix }) => tagPrefix)),
    new Set([
      "protocol-v",
      "sdk-v",
      "react-v",
      "tools-v",
      "mcp-v",
      "moderation-v",
      "worker-v",
      "cli-v",
      "cli-alias-v",
    ]),
  );
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

test("every release carries a deterministic SPDX SBOM bound to its reviewed tarball", async () => {
  const [release, sbomSource] = await Promise.all([
    loadWorkflow(RELEASE_WORKFLOW),
    readFile(RELEASE_SBOM_SCRIPT, "utf8"),
  ]);
  const steps = release.jobs.release.steps;
  const prepack = steps.find(
    (step) => step.name === "Run reviewed package prepack lifecycle",
  );
  const pack = steps.find((step) => step.name === "Build reviewed npm tarball");
  const generate = steps.find(
    (step) => step.name === "Generate deterministic SPDX release SBOM",
  );
  const inspect = steps.find(
    (step) => step.name === "Inspect resumable release state before mutation",
  );
  const attach = steps.find(
    (step) => step.name === "Attach required SPDX release SBOM",
  );
  assert.ok(prepack && pack && generate && inspect && attach);
  assert.ok(steps.indexOf(prepack) < steps.indexOf(pack));
  assert.ok(steps.indexOf(pack) < steps.indexOf(generate));
  assert.ok(steps.indexOf(generate) < steps.indexOf(inspect));
  assert.ok(steps.indexOf(inspect) < steps.indexOf(attach));
  assert.equal(prepack.run, "npm run prepack --if-present");
  assert.match(pack.run, /npm pack --ignore-scripts --json/);
  assert.match(pack.run, />\s*"\$\{RUNNER_TEMP\}\/package-pack\.json"/);
  assert.match(generate.run, /release-sbom\.mjs generate/);
  assert.equal(inspect.env.SBOM_RELEASE_ASSET, "${{ steps.sbom.outputs.name }}");
  assert.equal(inspect.env.SBOM_RELEASE_ASSET_PATH, "${{ steps.sbom.outputs.path }}");
  assert.match(sbomSource, /SPDX-2\.3/);
  assert.match(sbomSource, /npm pack integrity\/shasum/);
  assert.match(sbomSource, /Source commit/);
});

test("release rechecks expiring npm license exceptions before publication", async () => {
  const release = await loadWorkflow(RELEASE_WORKFLOW);
  const steps = release.jobs.release.steps;
  const install = steps.find(
    (step) => step.name === "Install independent npm license evidence",
  );
  const policy = steps.find(
    (step) => step.name === "Enforce release-time npm license policy",
  );
  const publish = steps.find(
    (step) => step.name === "Publish reviewed tarball to npm staging tag",
  );
  assert.ok(install && policy && publish);
  assert.match(install.run, /npm ci --prefix tests-integration --ignore-scripts/);
  assert.match(policy.run, /check-npm-licenses\.mjs/);
  assert.ok(steps.indexOf(install) < steps.indexOf(policy));
  assert.ok(steps.indexOf(policy) < steps.indexOf(publish));
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
    "Attach required SPDX release SBOM",
    "Publish reviewed tarball to npm staging tag",
    "Advance reviewed npm dist-tag",
    "Publish GitHub Release",
  ];

  for (const name of guardedSteps) {
    const step = releaseSteps.find((candidate) => candidate.name === name);
    assert.ok(step, `missing release step: ${name}`);
    assert.match(step.run, /verify-release-tag-binding\.mjs/);
    const guard = step.run.indexOf("verify-release-tag-binding.mjs");
    const firstRemoteOperation = ["gh release", "npm publish", "npm dist-tag"]
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

test("an existing npm version resumes only after exact integrity and provenance verification", async () => {
  const [release, stateSource, provenanceSource] = await Promise.all([
    loadWorkflow(RELEASE_WORKFLOW),
    readFile(RELEASE_STATE_SCRIPT, "utf8"),
    readFile(NPM_PROVENANCE_SCRIPT, "utf8"),
  ]);
  const steps = release.jobs.release.steps;
  const inspect = steps.find(
    (step) => step.name === "Inspect resumable release state before mutation",
  );
  const publish = steps.find(
    (step) => step.name === "Publish reviewed tarball to npm staging tag",
  );
  const verify = steps.find(
    (step) =>
      step.name ===
      "Verify npm integrity and provenance before changing public dist-tags",
  );
  const distTag = steps.find(
    (step) => step.name === "Advance reviewed npm dist-tag",
  );
  const finalize = steps.find(
    (step) => step.name === "Reinspect every immutable release surface before finalization",
  );
  const publishRelease = steps.find((step) => step.name === "Publish GitHub Release");
  assert.ok(inspect && publish && verify && distTag && finalize && publishRelease);
  assert.match(inspect.run, /release-state\.mjs inspect/);
  assert.match(publish.if, /publish_npm == 'true'/);
  assert.match(publish.run, /--provenance --tag agenc-staging/);
  assert.match(verify.run, /release-state\.mjs verify-npm/);
  assert.match(distTag.run, /remove_staging_tag/);
  assert.match(distTag.run, /npm dist-tag rm "\$\{PACKAGE_NAME\}" agenc-staging/);
  assert.match(distTag.if, /remove_staging_tag == 'true'/);
  assert.ok(steps.indexOf(inspect) < steps.indexOf(publish));
  assert.ok(steps.indexOf(publish) < steps.indexOf(verify));
  assert.ok(steps.indexOf(verify) < steps.indexOf(distTag));
  assert.ok(steps.indexOf(distTag) < steps.indexOf(finalize));
  assert.ok(steps.indexOf(finalize) < steps.indexOf(publishRelease));
  assert.match(finalize.run, /release-state\.mjs finalize/);
  assert.ok(finalize.env.EXPECTED_REVIEWED_INTEGRITY);
  assert.match(stateSource, /published\.dist\?\.integrity === pack\.integrity/);
  assert.match(stateSource, /verifyNpmProvenance/);
  assert.match(provenanceSource, /npm.*audit.*signatures/s);
  assert.match(provenanceSource, /--include-attestations/);
  assert.match(provenanceSource, /https:\/\/slsa\.dev\/provenance\/v1/);
  assert.match(provenanceSource, /resolvedDependencies/);
  assert.match(stateSource, /perAssetState\[required\.name\] =.*"matching" : "mismatch"/s);
  assert.match(stateSource, /missingAssets = Object\.entries\(perAssetState\)/);
  assert.match(stateSource, /registryResponse\.status !== 404/);
  assert.match(stateSource, /refusing to move npm \$\{distTag\} backwards/);
});
