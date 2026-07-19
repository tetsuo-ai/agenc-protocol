#!/usr/bin/env node

import { spawnSync } from "node:child_process";

// tests-integration is deliberately outside the npm workspace, but its locked
// Anchor/web3 tree is also loaded by production deployment and fee rails. Keep
// its audit independent and fail on every advisory severity so a vulnerable
// resolution cannot be hidden by the root workspace audit.

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npm,
  [
    "audit",
    "--prefix",
    "tests-integration",
    "--omit=dev",
    "--audit-level=low",
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

const counts = report.metadata.vulnerabilities;
const total = ["critical", "high", "moderate", "low", "info"].reduce(
  (sum, severity) => sum + Number(counts[severity] ?? 0),
  0,
);
if (total !== 0 || Object.keys(report.vulnerabilities).length !== 0) {
  console.error("tests-integration dependency audit found vulnerabilities:");
  for (const [packageName, vulnerability] of Object.entries(
    report.vulnerabilities,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    console.error(`- ${packageName}: ${vulnerability.severity}`);
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

console.log(
  `tests-integration audit: ${counts.critical ?? 0} critical, ` +
    `${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ` +
    `${counts.low ?? 0} low`,
);
