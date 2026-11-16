import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  evaluateAudit,
  LOCK_ROOTS,
  validateReviews,
} from "./audit-all-npm-locks.mjs";

const onFile = JSON.parse(
  readFileSync(
    new URL("../supply-chain/npm-advisory-reviews.json", import.meta.url),
  ),
);
// These tests are about the rules, not about which package happens to be
// under review today. They take the first review on file as their example,
// and a made-up one when the file holds none: an empty file is the goal, and
// reaching it must not break the suite.
const policy =
  onFile.reviews.length > 0
    ? onFile
    : {
        schemaVersion: 1,
        reviews: [
          {
            advisory: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
            package: "example-dev-tool",
            version: "1.2.3",
            root: ".",
            node: "node_modules/example-dev-tool",
            integrity: `sha512-${"A".repeat(86)}==`,
            severity: "high",
            reviewedAt: "2026-01-01T00:00:00Z",
            expiresAt: "2026-01-15T00:00:00Z",
            owner: "protocol maintainers",
            reason: "A made-up review, used only to exercise the rules.",
          },
        ],
      };
const review = policy.reviews[0];
const name = review.package;
/** A package that is affected only because it depends on the reviewed one. */
const dependent = "depends-on-the-reviewed-package";
const archive = `https://registry.npmjs.org/${name}/-/${name}-${review.version}.tgz`;
// A moment at which every review on file is in force: just after the newest began.
const now =
  Math.max(...policy.reviews.map((entry) => Date.parse(entry.reviewedAt))) +
  1_000;
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
          resolved: archive,
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
          high: 0,
          critical: 0,
          // Two packages are affected, at the severity under review.
          [review.severity]: 2,
          total: 2,
        },
      },
      vulnerabilities: {
        [name]: {
          severity: review.severity,
          nodes: [review.node],
          via: [{ name, url: review.advisory, severity: review.severity }],
        },
        [dependent]: {
          severity: review.severity,
          nodes: [`node_modules/${dependent}`],
          via: [name],
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

test("critical findings cannot be concealed by inconsistent summary severities", () => {
  const x = inputs();
  x.report.vulnerabilities[name].severity = "critical";
  assert.throws(
    () => evaluateAudit(x),
    /inconsistent npm audit severity counts/,
  );
  x.report.metadata.vulnerabilities[review.severity] = 1;
  x.report.metadata.vulnerabilities.critical = 1;
  assert.throws(
    () => evaluateAudit(x),
    /critical advisories are never excepted/,
  );
});

test("the actual CLI rejects an unlisted lock before invoking npm", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agenc-audit-lock-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of [
    "scripts/audit-all-npm-locks.mjs",
    "scripts/check-npm-licenses.mjs",
    "supply-chain/npm-advisory-reviews.json",
    "supply-chain/npm-license-policy.json",
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(new URL(`../${file}`, import.meta.url), join(root, file));
  }
  for (const lockRoot of [...LOCK_ROOTS, "new-fixture"]) {
    mkdirSync(join(root, lockRoot), { recursive: true });
    writeFileSync(
      join(root, lockRoot, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {},
      }),
    );
  }
  const bin = join(root, "bin");
  mkdirSync(bin);
  const invoked = join(root, "npm-was-invoked");
  writeFileSync(
    join(bin, "npm"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(invoked)}, 'unexpected invocation'); process.exit(99);\n`,
    { mode: 0o700 },
  );
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/audit-all-npm-locks.mjs")],
    {
      cwd: root,
      env: { ...process.env, PATH: bin },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /inventory differs from the repository's complete lock inventory/,
  );
  assert.equal(
    existsSync(invoked),
    false,
    "inventory must fail before any registry/tool invocation",
  );
});

test("a review cannot follow a version, archive, dependency-scope or root change", () => {
  for (const change of [
    (x) => {
      x.lock.packages[review.node].version = "999.0.0";
    },
    (x) => {
      x.lock.packages[review.node].integrity += "changed";
    },
    (x) => {
      x.lock.packages[review.node].dev = false;
    },
    (x) => {
      x.lock.packages[review.node].resolved =
        `https://example.invalid/${name}.tgz`;
    },
    (x) => {
      x.root = "tests-integration";
    },
    (x) => {
      x.report.vulnerabilities[name].nodes.push(
        `nested/node_modules/${name}`,
      );
    },
    (x) => {
      x.report.vulnerabilities[name].via[0].url =
        "https://github.com/advisories/GHSA-zzzz-yyyy-xxxx";
    },
    (x) => {
      x.report.vulnerabilities[name].via[0].severity = "critical";
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
  tooLong.reviews[0].expiresAt = new Date(
    Date.parse(review.reviewedAt) + 31 * 86_400_000,
  )
    .toISOString()
    .replace(".000Z", "Z");
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
      x.report.metadata.vulnerabilities[review.severity] = 0;
    },
    (x) => {
      x.report.vulnerabilities[dependent].via = ["missing"];
    },
    (x) => {
      x.report.vulnerabilities[name].via = [dependent];
    },
    (x) => {
      x.report.vulnerabilities[name].via = [];
    },
    (x) => {
      x.report.vulnerabilities[name].via[0].name = "other-package";
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
