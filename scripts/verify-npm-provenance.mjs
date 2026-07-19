#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const NPM_REGISTRY = "https://registry.npmjs.org/";
const SLSA_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_V1 = "https://in-toto.io/Statement/v1";
const GITHUB_WORKFLOW_V1 =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const GITHUB_HOSTED_BUILDER = "https://github.com/actions/runner/github-hosted";
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9][0-9]*)|(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*)))*)?$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

function fail(message) {
  throw new Error(message);
}

function packagePurl(name, version) {
  if (name.startsWith("@")) {
    const [scope, packageName] = name.slice(1).split("/");
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function attestationUrl(name, version) {
  const encodedName = name.startsWith("@")
    ? `@${name.slice(1).replace("/", "%2f")}`
    : name;
  return `${NPM_REGISTRY}-/npm/v1/attestations/${encodedName}@${version}`;
}

function sha512Hex(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? "");
  if (!match) fail("expected npm integrity must be one canonical sha512 SRI");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== match[1]) {
    fail("expected npm integrity must contain a canonical 64-byte sha512 digest");
  }
  return bytes.toString("hex");
}

function decodeStatement(bundle) {
  if (
    bundle?.bundle?.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json" ||
    typeof bundle.bundle.dsseEnvelope.payload !== "string"
  ) {
    fail("verified npm provenance has no canonical in-toto DSSE envelope");
  }
  const encoded = bundle.bundle.dsseEnvelope.payload;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    fail("verified npm provenance contains malformed base64");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("verified npm provenance contains malformed JSON");
  }
}

function assertExpectation(expectation) {
  const {
    packageName,
    packageVersion,
    expectedIntegrity,
    expectedRepository,
    expectedWorkflow,
    expectedRef,
    expectedCommit,
  } = expectation ?? {};
  if (!PACKAGE.test(packageName ?? "") || !VERSION.test(packageVersion ?? "")) {
    fail("npm provenance expectation has a non-canonical package identity");
  }
  sha512Hex(expectedIntegrity);
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expectedRepository ?? "")) {
    fail("npm provenance expectation has an invalid GitHub repository");
  }
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(expectedWorkflow ?? "")) {
    fail("npm provenance expectation has an invalid workflow path");
  }
  if (!/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(expectedRef ?? "")) {
    fail("npm provenance expectation must bind an exact release tag ref");
  }
  if (!COMMIT.test(expectedCommit ?? "")) {
    fail("npm provenance expectation must bind an exact lowercase source commit");
  }
}

/**
 * Validate identity inside output that npm has already cryptographically verified.
 * `npm audit signatures --include-attestations` performs the Sigstore verification;
 * this function additionally pins the artifact, repository, workflow, ref, and commit.
 */
export function assertVerifiedNpmProvenance(audit, expectation) {
  assertExpectation(expectation);
  if (
    !Array.isArray(audit?.invalid) ||
    audit.invalid.length !== 0 ||
    !Array.isArray(audit?.missing) ||
    audit.missing.length !== 0 ||
    !Array.isArray(audit?.verified)
  ) {
    fail("npm signature audit reported invalid, missing, or malformed evidence");
  }
  const matches = audit.verified.filter(
    (entry) =>
      entry?.name === expectation.packageName &&
      entry?.version === expectation.packageVersion &&
      entry?.location === `node_modules/${expectation.packageName}`,
  );
  if (matches.length !== 1) {
    fail("npm signature audit did not verify the exact requested package once");
  }
  const verified = matches[0];
  if (
    verified.registry !== NPM_REGISTRY ||
    verified.attestations?.url !==
      attestationUrl(expectation.packageName, expectation.packageVersion) ||
    verified.attestations?.provenance?.predicateType !== SLSA_V1
  ) {
    fail("npm signature audit did not use the canonical registry attestation endpoint");
  }
  const provenance = (verified.attestationBundles ?? []).filter(
    (candidate) => candidate?.predicateType === SLSA_V1,
  );
  if (provenance.length !== 1) {
    fail("npm signature audit must return exactly one verified SLSA v1 provenance bundle");
  }
  const statement = decodeStatement(provenance[0]);
  const expectedDigest = sha512Hex(expectation.expectedIntegrity);
  if (
    statement?._type !== IN_TOTO_V1 ||
    statement.predicateType !== SLSA_V1 ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1 ||
    statement.subject[0]?.name !==
      packagePurl(expectation.packageName, expectation.packageVersion) ||
    statement.subject[0]?.digest?.sha512 !== expectedDigest
  ) {
    fail("verified npm provenance subject does not bind the reviewed tarball");
  }
  const build = statement.predicate?.buildDefinition;
  const workflow = build?.externalParameters?.workflow;
  const expectedDependencyUri =
    `git+${expectation.expectedRepository}@${expectation.expectedRef}`;
  const dependencies = build?.resolvedDependencies;
  if (
    build?.buildType !== GITHUB_WORKFLOW_V1 ||
    workflow?.repository !== expectation.expectedRepository ||
    workflow?.path !== expectation.expectedWorkflow ||
    workflow?.ref !== expectation.expectedRef ||
    !Array.isArray(dependencies) ||
    dependencies.length !== 1 ||
    dependencies[0]?.uri !== expectedDependencyUri ||
    dependencies[0]?.digest?.gitCommit !== expectation.expectedCommit
  ) {
    fail("verified npm provenance does not bind the expected repository workflow ref and commit");
  }
  const run = statement.predicate?.runDetails;
  const repositoryPath = new URL(expectation.expectedRepository).pathname.replace(/^\//, "");
  if (
    run?.builder?.id !== GITHUB_HOSTED_BUILDER ||
    typeof run?.metadata?.invocationId !== "string" ||
    !new RegExp(
      `^https://github\\.com/${repositoryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` +
        "/actions/runs/[1-9][0-9]*/attempts/[1-9][0-9]*$",
    ).test(run.metadata.invocationId)
  ) {
    fail("verified npm provenance does not bind a GitHub-hosted run for the expected repository");
  }
  return true;
}

export async function verifyNpmProvenance(
  expectation,
  { execFileFn = execFile, tempRoot = tmpdir() } = {},
) {
  assertExpectation(expectation);
  const directory = await mkdtemp(join(tempRoot, "agenc-npm-provenance-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ private: true, dependencies: { [expectation.packageName]: expectation.packageVersion } }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const options = {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, npm_config_registry: NPM_REGISTRY },
    };
    await execFileFn(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        "--registry",
        NPM_REGISTRY,
      ],
      options,
    );
    const { stdout } = await execFileFn(
      "npm",
      ["audit", "signatures", "--json", "--include-attestations"],
      options,
    );
    let audit;
    try {
      audit = JSON.parse(stdout);
    } catch {
      fail("npm signature audit returned malformed JSON");
    }
    return assertVerifiedNpmProvenance(audit, expectation);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
