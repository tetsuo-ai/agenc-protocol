#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPackageLocks } from "./check-npm-licenses.mjs";

export const LOCK_ROOTS = [
  ".",
  "tests-integration",
  "packages/marketplace-react/examples/marketplace-starter",
  "packages/marketplace-react/test/playwright",
  "packages/marketplace-react/test-apps/checkout",
  "packages/marketplace-react/test-apps/next-ssr",
];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const severities = ["info", "low", "moderate", "high", "critical"];
const fail = (message) => {
  throw new Error(message);
};
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function validateReviews(policy, now = Date.now()) {
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.reviews))
    fail("invalid advisory-review policy");
  const seen = new Set();
  for (const r of policy.reviews) {
    const start = Date.parse(r.reviewedAt),
      end = Date.parse(r.expiresAt);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r.reviewedAt ?? "") ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r.expiresAt ?? "") ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > now ||
      end <= now ||
      end <= start ||
      end - start > 30 * 86_400_000
    )
      fail(
        "advisory review expired, future-dated or outside the 30-day window",
      );
    if (
      new Date(start).toISOString().replace(".000Z", "Z") !== r.reviewedAt ||
      new Date(end).toISOString().replace(".000Z", "Z") !== r.expiresAt
    )
      fail("invalid advisory review calendar date");
    if (
      r.root !== "." ||
      r.node !== `node_modules/${r.package}` ||
      !/^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9-]+$/.test(
        r.advisory,
      ) ||
      !/^\d+\.\d+\.\d+$/.test(r.version) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(r.integrity) ||
      !severities.includes(r.severity) ||
      r.severity === "critical" ||
      !r.reason ||
      !r.owner ||
      seen.has(r.advisory)
    )
      fail("invalid or duplicate exact development advisory review");
    seen.add(r.advisory);
  }
  return policy.reviews;
}

export function evaluateAudit({
  report,
  lock,
  root,
  runtime = false,
  reviews,
}) {
  if (
    !report ||
    report.error ||
    report.auditReportVersion !== 2 ||
    !report.vulnerabilities ||
    Array.isArray(report.vulnerabilities) ||
    !report.metadata?.vulnerabilities ||
    lock?.lockfileVersion !== 3 ||
    !lock.packages
  )
    fail("incomplete npm audit report or lockfile");
  const counts = report.metadata.vulnerabilities;
  if (
    severities.some((s) => !Number.isSafeInteger(counts[s]) || counts[s] < 0) ||
    counts.total !== severities.reduce((sum, s) => sum + counts[s], 0) ||
    counts.total !== Object.keys(report.vulnerabilities).length
  )
    fail("inconsistent npm audit counts");
  if (runtime && counts.total !== 0)
    fail(`${root}: runtime advisories are never excepted`);
  const observedCounts = Object.fromEntries(severities.map((s) => [s, 0]));
  for (const finding of Object.values(report.vulnerabilities)) {
    if (!finding || !severities.includes(finding.severity))
      fail("invalid npm finding severity");
    observedCounts[finding.severity] += 1;
  }
  if (severities.some((s) => observedCounts[s] !== counts[s]))
    fail("inconsistent npm audit severity counts");
  if (counts.critical !== 0)
    fail(`${root}: critical advisories are never excepted`);
  const used = new Set();
  const completed = new Set();
  function inspect(name, ancestors = new Set()) {
    if (completed.has(name)) return;
    if (ancestors.has(name)) fail("cyclic npm advisory chain");
    const finding = report.vulnerabilities[name];
    if (
      !finding ||
      !Array.isArray(finding.via) ||
      finding.via.length === 0 ||
      !Array.isArray(finding.nodes) ||
      finding.nodes.length === 0 ||
      !severities.includes(finding.severity)
    )
      fail(`incomplete advisory chain: ${name}`);
    const next = new Set(ancestors).add(name);
    for (const via of finding.via) {
      if (typeof via === "string") {
        inspect(via, next);
        continue;
      }
      if (!via || via.name !== name || typeof via.url !== "string")
        fail(`invalid advisory source: ${name}`);
      const review = reviews.find(
        (r) =>
          r.advisory === via.url &&
          r.package === name &&
          r.root === root &&
          r.severity === via.severity,
      );
      if (
        !review ||
        runtime ||
        finding.nodes.length !== 1 ||
        finding.nodes[0] !== review.node
      )
        fail(`${root}: unreviewed advisory ${via.url}`);
      const exact = lock.packages[review.node];
      if (
        exact?.version !== review.version ||
        exact?.integrity !== review.integrity ||
        exact.dev !== true ||
        exact.resolved !==
          `https://registry.npmjs.org/${name}/-/${name}-${review.version}.tgz`
      )
        fail(
          `${root}: advisory review requires exact development-only archive`,
        );
      used.add(review.advisory);
    }
    completed.add(name);
  }
  for (const name of Object.keys(report.vulnerabilities)) inspect(name);
  return { counts, reviewedAdvisories: [...used] };
}

function audit(root, runtime) {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["audit", "--prefix", root, "--json", ...(runtime ? ["--omit=dev"] : [])],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error || ![0, 1].includes(result.status))
    fail(
      `npm audit operational failure for ${root}: ${result.error?.message ?? result.stderr}`,
    );
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    fail(`npm audit returned invalid JSON for ${root}`);
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length && (argv.length !== 2 || argv[0] !== "--output"))
    fail("usage: audit-all-npm-locks.mjs [--output report.json]");
  const policy = JSON.parse(
    readFileSync(
      resolve(ROOT, "supply-chain/npm-advisory-reviews.json"),
      "utf8",
    ),
  );
  const licensePolicy = JSON.parse(
    readFileSync(resolve(ROOT, "supply-chain/npm-license-policy.json"), "utf8"),
  );
  // Use the same actual filesystem discovery as the license gate, including
  // newly added locks that neither policy has approved yet.
  const discoveredLocks = await discoverPackageLocks(ROOT);
  if (
    JSON.stringify(discoveredLocks) !==
      JSON.stringify([...licensePolicy.lockfiles].sort()) ||
    JSON.stringify(licensePolicy.lockfiles.map(dirname).sort()) !==
      JSON.stringify([...LOCK_ROOTS].sort())
  )
    fail(
      "npm audit inventory differs from the repository's complete lock inventory",
    );
  const now = Date.now();
  const reviews = validateReviews(policy, now);
  const evidence = {
    schemaVersion: 1,
    observedAt: new Date(now).toISOString(),
    npmVersion: "11.18.0",
    policySha256: sha256(JSON.stringify(policy)),
    locks: [],
    accepted: false,
  };
  const version = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["--version"],
    { encoding: "utf8" },
  );
  if (version.status !== 0 || version.stdout.trim() !== evidence.npmVersion)
    fail("audit requires npm 11.18.0");
  const failures = [];
  for (const root of LOCK_ROOTS) {
    const rawLock = readFileSync(resolve(ROOT, root, "package-lock.json"));
    const lock = JSON.parse(rawLock);
    const row = { root, lockSha256: sha256(rawLock), scans: [] };
    for (const runtime of [false, true]) {
      try {
        const report = audit(root, runtime);
        // Preserve an observed vulnerable report even when the policy rejects it.
        const scan = { runtime, report };
        row.scans.push(scan);
        Object.assign(
          scan,
          evaluateAudit({ report, lock, root, runtime, reviews }),
        );
        console.log(
          `${root} ${runtime ? "runtime" : "full"}: ${scan.counts.total} affected packages; ${scan.reviewedAdvisories.length} exact development review(s)`,
        );
      } catch (error) {
        failures.push(
          `${root} ${runtime ? "runtime" : "full"}: ${error.message}`,
        );
      }
    }
    evidence.locks.push(row);
  }
  evidence.accepted = failures.length === 0;
  evidence.failures = failures;
  if (argv[1]) {
    const out = resolve(argv[1]);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  if (failures.length) fail(failures.join("\n"));
  return evidence;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
