#!/usr/bin/env node

import { spawnSync } from "node:child_process";

// tests-integration is deliberately outside the npm workspace, but its locked
// Anchor/web3 tree is also loaded by the production deployment and fee rails.
// Keep the one currently unpatched transitive advisory explicit. Any new high
// or critical advisory fails this gate instead of disappearing behind the root
// workspace audit.
const reviewedHighAdvisories = new Map([
  [
    1103747,
    {
      package: "bigint-buffer",
      url: "https://github.com/advisories/GHSA-3gc7-fjrx-p6mg",
    },
  ],
]);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npm,
  [
    "audit",
    "--prefix",
    "tests-integration",
    "--omit=dev",
    "--audit-level=high",
    "--json",
  ],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0 && result.status !== 1) {
  console.error(result.stderr || result.stdout);
  throw new Error(
    `tests-integration npm audit failed operationally (exit ${result.status ?? "unknown"})`,
  );
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error(result.stderr || result.stdout);
  throw new Error("tests-integration npm audit did not return valid JSON");
}
if (
  report === null ||
  typeof report !== "object" ||
  report.error !== undefined ||
  report.vulnerabilities === null ||
  typeof report.vulnerabilities !== "object" ||
  report.metadata === null ||
  typeof report.metadata !== "object" ||
  report.metadata.vulnerabilities === null ||
  typeof report.metadata.vulnerabilities !== "object"
) {
  console.error(result.stderr || JSON.stringify(report.error ?? report));
  throw new Error(
    "tests-integration npm audit returned an error or incomplete report",
  );
}

const vulnerabilities = report.vulnerabilities;

function advisorySourcesFor(packageName, seen = new Set()) {
  if (seen.has(packageName)) return [];
  seen.add(packageName);
  const vulnerability = vulnerabilities[packageName];
  if (!vulnerability || !Array.isArray(vulnerability.via)) return [];
  return vulnerability.via.flatMap((entry) =>
    typeof entry === "string" ? advisorySourcesFor(entry, seen) : [entry],
  );
}

const failures = [];
const reviewed = new Map();
for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
  if (vulnerability.severity === "critical") {
    failures.push(`${packageName}: critical vulnerability`);
    continue;
  }
  if (vulnerability.severity !== "high") continue;

  const sources = advisorySourcesFor(packageName);
  if (sources.length === 0) {
    failures.push(
      `${packageName}: high vulnerability has no traceable advisory`,
    );
    continue;
  }
  for (const source of sources) {
    if (source.severity !== "high" && source.severity !== "critical") {
      continue;
    }
    const policy = reviewedHighAdvisories.get(Number(source.source));
    if (
      !policy ||
      source.name !== policy.package ||
      source.url !== policy.url
    ) {
      failures.push(
        `${packageName}: unreviewed high advisory ${source.url ?? source.source ?? "unknown"}`,
      );
      continue;
    }
    reviewed.set(Number(source.source), policy);
  }
}

if (failures.length > 0) {
  console.error("tests-integration dependency audit failed:");
  for (const failure of [...new Set(failures)].sort()) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

// Security metadata alone is insufficient for a signing dependency tree. A
// newer rpc-websockets release once paired a CommonJS entrypoint with an
// ESM-only uuid and made every Node 20 rail fail at import time. Exercise the
// same @solana/web3.js CommonJS load used by the operator scripts after each
// clean install so semver-compatible but runtime-incompatible resolutions fail.
const compatibility = spawnSync(
  process.execPath,
  [
    "-e",
    'const web3 = require("@solana/web3.js"); new web3.PublicKey("11111111111111111111111111111111");',
  ],
  {
    cwd: new URL("../tests-integration", import.meta.url),
    encoding: "utf8",
  },
);
if (compatibility.error) throw compatibility.error;
if (compatibility.status !== 0) {
  console.error(compatibility.stderr || compatibility.stdout);
  throw new Error(
    `tests-integration Solana signing dependencies failed their Node compatibility probe ` +
      `(exit ${compatibility.status ?? "unknown"})`,
  );
}

const counts = report.metadata.vulnerabilities;
console.log(
  `tests-integration audit: ${counts.critical ?? 0} critical, ` +
    `${counts.high ?? 0} high package paths, ${counts.moderate ?? 0} moderate`,
);
for (const [source, policy] of reviewed) {
  console.warn(
    `reviewed exception: ${policy.package} advisory ${source} (${policy.url}); ` +
      "see tests-integration/SECURITY.md",
  );
}
