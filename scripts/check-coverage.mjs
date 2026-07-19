#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const POLICY = new URL("../coverage-policy.json", import.meta.url);

function fail(message) {
  throw new Error(message);
}

function metric(record, label) {
  if (
    record === null ||
    typeof record !== "object" ||
    !Number.isInteger(record.count) ||
    record.count <= 0 ||
    !Number.isInteger(record.covered) ||
    record.covered < 0 ||
    record.covered > record.count ||
    !Number.isFinite(record.percent)
  ) {
    fail(`invalid ${label} coverage totals`);
  }
  const computed = (record.covered / record.count) * 100;
  if (Math.abs(computed - record.percent) > 1e-9) {
    fail(`${label} coverage percentage differs from its counts`);
  }
  return computed;
}

export function checkCoverageReport(report, policy) {
  if (
    policy?.schemaVersion !== 1 ||
    policy.tool?.name !== "cargo-llvm-cov" ||
    typeof policy.tool.version !== "string" ||
    typeof policy.manifest !== "string" ||
    policy.profile !== "default features, all targets" ||
    report?.type !== "llvm.coverage.json.export" ||
    report.version !== "2.0.1" ||
    report.cargo_llvm_cov?.version !== policy.tool.version ||
    report.cargo_llvm_cov?.manifest_path !== policy.manifest ||
    !Array.isArray(report.data) ||
    report.data.length !== 1
  ) {
    fail("coverage report does not match the pinned tool, manifest, and profile policy");
  }
  const names = ["functions", "lines", "regions"];
  if (
    Object.keys(policy.minimumPercent ?? {}).sort().join(",") !== names.join(",") ||
    Object.keys(policy.baseline ?? {}).filter((name) => name !== "measuredOn").sort().join(",") !== names.join(",") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(policy.baseline?.measuredOn ?? "")
  ) {
    fail("coverage policy must define the complete ratchet surface");
  }
  const observed = {};
  for (const name of names) {
    const minimum = policy.minimumPercent[name];
    if (!Number.isFinite(minimum) || minimum <= 0 || minimum > 100) {
      fail(`invalid ${name} coverage minimum`);
    }
    const baseline = metric(policy.baseline[name], `baseline ${name}`);
    if (Math.abs(minimum - baseline) > 1e-12) {
      fail(
        `${name} ratchet must equal the exact recorded baseline percentage`,
      );
    }
    observed[name] = metric(report.data[0]?.totals?.[name], name);
    if (observed[name] + 1e-12 < minimum) {
      fail(
        `${name} coverage ${observed[name].toFixed(3)}% is below the ` +
          `${minimum.toFixed(3)}% ratchet`,
      );
    }
  }
  return Object.freeze(observed);
}

async function cli() {
  const reportPath = process.argv[2];
  if (!reportPath) fail("usage: check-coverage.mjs <llvm-cov JSON>");
  const [report, policy] = await Promise.all([
    readFile(reportPath, "utf8").then(JSON.parse),
    readFile(POLICY, "utf8").then(JSON.parse),
  ]);
  const result = checkCoverageReport(report, policy);
  console.log(
    `coverage ratchet passed: ${result.lines.toFixed(3)}% lines, ` +
      `${result.functions.toFixed(3)}% functions, ${result.regions.toFixed(3)}% regions`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    console.error(`coverage policy failed: ${error.message}`);
    process.exitCode = 1;
  });
}
