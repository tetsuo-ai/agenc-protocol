import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { assertVerifiedNpmProvenance } from "./verify-npm-provenance.mjs";

const expectation = {
  packageName: "@tetsuo-ai/example",
  packageVersion: "1.2.3",
  expectedIntegrity: `sha512-${Buffer.from("reviewed artifact").toString("base64")}`,
  expectedRepository: "https://github.com/tetsuo-ai/agenc-protocol",
  expectedWorkflow: ".github/workflows/release.yml",
  expectedRef: "refs/tags/example-v1.2.3",
  expectedCommit: "12".repeat(20),
};
// Use a real 64-byte digest in the SRI.
expectation.expectedIntegrity = `sha512-${createHash("sha512").update("reviewed artifact").digest("base64")}`;

function audit() {
  const digest = Buffer.from(expectation.expectedIntegrity.slice(7), "base64").toString("hex");
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "pkg:npm/%40tetsuo-ai/example@1.2.3", digest: { sha512: digest } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: expectation.expectedRef,
            repository: expectation.expectedRepository,
            path: expectation.expectedWorkflow,
          },
        },
        resolvedDependencies: [{
          uri: `git+${expectation.expectedRepository}@${expectation.expectedRef}`,
          digest: { gitCommit: expectation.expectedCommit },
        }],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId: "https://github.com/tetsuo-ai/agenc-protocol/actions/runs/123/attempts/1",
        },
      },
    },
  };
  return {
    invalid: [],
    missing: [],
    verified: [{
      name: expectation.packageName,
      version: expectation.packageVersion,
      location: `node_modules/${expectation.packageName}`,
      registry: "https://registry.npmjs.org/",
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/@tetsuo-ai%2fexample@1.2.3",
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
      attestationBundles: [{
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
          },
        },
      }],
    }],
  };
}

test("accepts cryptographically verified output only when every artifact identity field matches", () => {
  assert.equal(assertVerifiedNpmProvenance(audit(), expectation), true);
});

test("rejects invalid/missing signatures and malicious provenance identity drift", () => {
  for (const mutate of [
    (copy) => copy.invalid.push({ name: expectation.packageName }),
    (copy) => copy.missing.push({ name: expectation.packageName }),
    (copy) => { copy.verified[0].name = "@attacker/example"; },
    (copy) => { copy.verified[0].registry = "https://registry.example/"; },
    (copy) => { copy.verified[0].attestations.url += "?redirect=1"; },
    (copy) => {
      const statement = JSON.parse(Buffer.from(copy.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload, "base64"));
      statement.subject[0].digest.sha512 = "00".repeat(64);
      copy.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    },
    (copy) => {
      const statement = JSON.parse(Buffer.from(copy.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload, "base64"));
      statement.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/attacker/repo";
      copy.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    },
    (copy) => {
      const statement = JSON.parse(Buffer.from(copy.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload, "base64"));
      statement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/evil.yml";
      copy.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    },
    (copy) => {
      const statement = JSON.parse(Buffer.from(copy.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload, "base64"));
      statement.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main";
      copy.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    },
    (copy) => {
      const statement = JSON.parse(Buffer.from(copy.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload, "base64"));
      statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "34".repeat(20);
      copy.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    },
  ]) {
    const copy = audit();
    mutate(copy);
    assert.throws(() => assertVerifiedNpmProvenance(copy, expectation));
  }
});

test("rejects non-canonical SRI, version, ref, workflow, repository, and commit expectations", () => {
  for (const override of [
    { expectedIntegrity: "sha512-not-base64" },
    { packageVersion: "1.2.3+build" },
    { expectedRef: "refs/heads/main" },
    { expectedWorkflow: "../release.yml" },
    { expectedRepository: "http://github.com/tetsuo-ai/agenc-protocol" },
    { expectedCommit: "ABC" },
  ]) {
    assert.throws(() => assertVerifiedNpmProvenance(audit(), { ...expectation, ...override }));
  }
});
