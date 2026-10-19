import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  evaluateAudit,
  LOCK_ROOTS,
  validateReviews,
} from "./audit-all-npm-locks.mjs";

const policy = JSON.parse(
  readFileSync(
    new URL("../supply-chain/npm-advisory-reviews.json", import.meta.url),
  ),
);
const review = policy.reviews[0];
const now = Date.parse("2026-10-19T14:00:00Z");
function inputs() {
  return {
    root: ".",
    runtime: false,
    reviews: validateReviews(policy, now),
    lock: {
      lockfileVersion: 3,
      packages: {
        [review.node]: {
          version: review.version,
          integrity: review.integrity,
          dev: true,
          resolved: "https://registry.npmjs.org/braces/-/braces-3.0.3.tgz",
        },
      },
    },
    report: {
      auditReportVersion: 2,
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 2,
          critical: 0,
          total: 2,
        },
      },
      vulnerabilities: {
        braces: {
          severity: "high",
          nodes: [review.node],
          via: [{ name: "braces", url: review.advisory, severity: "high" }],
        },
        micromatch: {
          severity: "high",
          nodes: ["node_modules/micromatch"],
          via: ["braces"],
        },
      },
    },
  };
}

test("the bounded review covers the exact dev archive and its audit dependency chain", () => {
  assert.deepEqual(evaluateAudit(inputs()).reviewedAdvisories, [
    review.advisory,
  ]);
  assert.equal(LOCK_ROOTS.length, 6);
});

test("all runtime findings are rejected even with a matching development review", () => {
  const x = inputs();
  x.runtime = true;
  assert.throws(
    () => evaluateAudit(x),
    /runtime advisories are never excepted/,
  );
});

test("a review cannot follow a version, archive, dependency-scope or root change", () => {
  for (const change of [
    (x) => {
      x.lock.packages[review.node].version = "3.0.4";
    },
    (x) => {
      x.lock.packages[review.node].integrity += "changed";
    },
    (x) => {
      x.lock.packages[review.node].dev = false;
    },
    (x) => {
      x.lock.packages[review.node].resolved =
        "https://example.invalid/braces.tgz";
    },
    (x) => {
      x.root = "tests-integration";
    },
    (x) => {
      x.report.vulnerabilities.braces.nodes.push("nested/node_modules/braces");
    },
    (x) => {
      x.report.vulnerabilities.braces.via[0].url =
        "https://github.com/advisories/GHSA-aaaa-bbbb-cccc";
    },
    (x) => {
      x.report.vulnerabilities.braces.via[0].severity = "critical";
    },
  ]) {
    const x = inputs();
    change(x);
    assert.throws(() => evaluateAudit(x));
  }
});

test("expiry is inclusive and a review cannot be extended beyond 30 days or future-dated", () => {
  assert.throws(
    () => validateReviews(policy, Date.parse(review.expiresAt)),
    /expired/,
  );
  assert.doesNotThrow(() =>
    validateReviews(policy, Date.parse(review.expiresAt) - 1),
  );
  assert.throws(
    () => validateReviews(policy, Date.parse(review.reviewedAt) - 1),
    /future-dated/,
  );
  const tooLong = structuredClone(policy);
  tooLong.reviews[0].expiresAt = "2026-11-19T13:55:00Z";
  assert.throws(() => validateReviews(tooLong, now), /30-day/);
});

test("incomplete, failed, inconsistent and cyclic audit results fail closed", () => {
  for (const change of [
    (x) => {
      x.report.error = { code: "E503" };
    },
    (x) => {
      delete x.report.metadata;
    },
    (x) => {
      x.report.metadata.vulnerabilities.high = 0;
    },
    (x) => {
      x.report.vulnerabilities.micromatch.via = ["missing"];
    },
    (x) => {
      x.report.vulnerabilities.braces.via = ["micromatch"];
    },
    (x) => {
      x.report.vulnerabilities.braces.via = [];
    },
    (x) => {
      x.report.vulnerabilities.braces.via[0].name = "other-package";
    },
  ]) {
    const x = inputs();
    change(x);
    assert.throws(() => evaluateAudit(x));
  }
});

test("an actual zero-finding report passes both modes without a review", () => {
  for (const runtime of [false, true]) {
    const x = inputs();
    x.runtime = runtime;
    x.reviews = [];
    x.report.vulnerabilities = {};
    for (const key of Object.keys(x.report.metadata.vulnerabilities))
      x.report.metadata.vulnerabilities[key] = 0;
    assert.equal(evaluateAudit(x).counts.total, 0);
  }
});
