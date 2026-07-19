import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { checkCoverageReport } from "./check-coverage.mjs";

const POLICY_URL = new URL("../coverage-policy.json", import.meta.url);

function totals(count, covered) {
  return { count, covered, notcovered: count - covered, percent: (covered / count) * 100 };
}

async function fixture() {
  const policy = JSON.parse(await readFile(POLICY_URL, "utf8"));
  const report = {
    type: "llvm.coverage.json.export",
    version: "2.0.1",
    cargo_llvm_cov: { version: policy.tool.version, manifest_path: policy.manifest },
    data: [
      {
        totals: {
          functions: totals(1_000, 487),
          lines: totals(1_000, 425),
          regions: totals(1_000, 339),
        },
      },
    ],
  };
  return { policy, report };
}

test("coverage thresholds are a nonzero ratchet at the measured baseline", async () => {
  const { policy, report } = await fixture();
  for (const metric of ["lines", "functions", "regions"]) {
    assert.equal(
      policy.minimumPercent[metric],
      policy.baseline[metric].percent,
      `${metric} ratchet must retain the exact measured baseline`,
    );
  }
  assert.deepEqual(checkCoverageReport(report, policy), {
    functions: 48.699999999999996,
    lines: 42.5,
    regions: 33.900000000000006,
  });
});

test("coverage regression, forged percentages, and tool drift fail closed", async () => {
  const below = await fixture();
  below.report.data[0].totals.lines = totals(1_000, 423);
  assert.throws(() => checkCoverageReport(below.report, below.policy), /below the 42\.435% ratchet/);

  const oneLineLost = await fixture();
  oneLineLost.report.data[0].totals = Object.fromEntries(
    ["functions", "lines", "regions"].map((name) => {
      const baseline = oneLineLost.policy.baseline[name];
      return [name, totals(
        baseline.count,
        baseline.covered - (name === "lines" ? 1 : 0),
      )];
    }),
  );
  assert.throws(
    () => checkCoverageReport(oneLineLost.report, oneLineLost.policy),
    /lines coverage .* is below/,
  );

  const weakenedPolicy = await fixture();
  weakenedPolicy.policy.minimumPercent.lines = 42.4;
  assert.throws(
    () => checkCoverageReport(weakenedPolicy.report, weakenedPolicy.policy),
    /exact recorded baseline/,
  );

  const forged = await fixture();
  forged.report.data[0].totals.functions.percent = 99;
  assert.throws(() => checkCoverageReport(forged.report, forged.policy), /differs from its counts/);

  const drift = await fixture();
  drift.report.cargo_llvm_cov.version = "0.6.22";
  assert.throws(() => checkCoverageReport(drift.report, drift.policy), /pinned tool/);
});
