import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateRustSupplyChainPolicy } from "./check-rust-supply-chain-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY = JSON.parse(
  readFileSync(resolve(ROOT, "supply-chain/rust-policy.json"), "utf8"),
);
const DENY_TEXT = readFileSync(resolve(ROOT, "deny.toml"), "utf8");
const WORKFLOW_TEXT = readFileSync(
  resolve(ROOT, ".github/workflows/rust-supply-chain.yml"),
  "utf8",
);
const LOCK_TEXTS = Object.fromEntries(
  POLICY.locks.map(({ lockfile }) => [
    lockfile,
    readFileSync(resolve(ROOT, lockfile), "utf8"),
  ]),
);

function clone(value) {
  return structuredClone(value);
}

function fixture(overrides = {}) {
  return {
    root: ROOT,
    now: new Date(`${POLICY.advisoryExceptions[0].reviewedOn}T12:00:00Z`),
    policy: clone(POLICY),
    denyText: DENY_TEXT,
    workflowText: WORKFLOW_TEXT,
    lockTexts: { ...LOCK_TEXTS },
    ...overrides,
  };
}

test("current policy covers all Cargo locks with an active narrow exception", () => {
  const input = fixture({ now: new Date() });
  assert.doesNotThrow(() => validateRustSupplyChainPolicy(input));
});

test("the bincode exception fails closed on its expiry date", () => {
  const expiry = POLICY.advisoryExceptions[0].expiresOn;
  const input = fixture({ now: new Date(`${expiry}T00:00:00Z`) });
  assert.throws(
    () => validateRustSupplyChainPolicy(input),
    new RegExp(`exception expired on ${expiry}`),
  );
});

test("the UTC expiry boundary accepts the preceding instant and rejects every later day", () => {
  const expiry = new Date(
    `${POLICY.advisoryExceptions[0].expiresOn}T00:00:00Z`,
  );
  assert.doesNotThrow(() =>
    validateRustSupplyChainPolicy(fixture({ now: new Date(+expiry - 1) })),
  );
  for (const offset of [0, 1, 86_400_000, 365 * 86_400_000]) {
    assert.throws(
      () =>
        validateRustSupplyChainPolicy(
          fixture({ now: new Date(+expiry + offset) }),
        ),
      /exception expired on/,
    );
  }
});

// Exercise the actual CI entry point, file reads, wall clock, and process exit
// status. This does not replace the live --run-tools audit in the same workflow.
test("CI CLI rejects an expired on-disk exception before executing external tools", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "agenc-rust-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = "scripts/check-rust-supply-chain-policy.mjs";
  for (const file of [
    script,
    ".github/CODEOWNERS",
    POLICY.workflow,
    "deny.toml",
    "supply-chain/rust-policy.json",
    ...POLICY.locks.flatMap(({ manifest, lockfile }) => [manifest, lockfile]),
  ]) {
    const destination = resolve(root, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve(ROOT, file), destination);
  }
  const run = (args = []) =>
    spawnSync(process.execPath, [resolve(root, script), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        CARGO_AUDIT_BIN: resolve(root, "must-not-run-audit"),
        CARGO_DENY_BIN: resolve(root, "must-not-run-deny"),
      },
    });
  const valid = run();
  assert.equal(valid.error, undefined);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /policy metadata.*valid/);

  const expired = clone(POLICY);
  const exception = expired.advisoryExceptions[0];
  const original = POLICY.advisoryExceptions[0];
  const today = new Date().toISOString().slice(0, 10);
  exception.reviewedOn = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  exception.expiresOn = today;
  writeFileSync(
    resolve(root, "supply-chain/rust-policy.json"),
    JSON.stringify(expired),
  );
  writeFileSync(
    resolve(root, "deny.toml"),
    DENY_TEXT.replace(
      `reviewed ${original.reviewedOn}`,
      `reviewed ${exception.reviewedOn}`,
    ).replace(
      `expires ${original.expiresOn}`,
      `expires ${exception.expiresOn}`,
    ),
  );
  for (const args of [[], ["--run-tools"]]) {
    const rejected = run(args);
    assert.equal(rejected.error, undefined);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, new RegExp(`exception expired on ${today}`));
    assert.doesNotMatch(rejected.stderr, /cannot execute/);
    assert.doesNotMatch(rejected.stdout, /passed|are valid/);
  }
});

test("the exception cannot broaden its bincode version selector", () => {
  const input = fixture();
  input.policy.advisoryExceptions[0].package.version = ">=1.3.3";
  assert.throws(
    () => validateRustSupplyChainPolicy(input),
    /exception package version must remain exact/,
  );
});

test("a second advisory exception is rejected", () => {
  const input = fixture();
  const second = clone(input.policy.advisoryExceptions[0]);
  second.id = "RUSTSEC-2099-0001";
  input.policy.advisoryExceptions.push(second);
  assert.throws(
    () => validateRustSupplyChainPolicy(input),
    /exactly one advisory exception is permitted/,
  );
});

test("the exception must be removed when bincode disappears", () => {
  const input = fixture();
  const lockfile = input.policy.advisoryExceptions[0].lockfile;
  const withoutBincode = input.lockTexts[lockfile].replace(
    /\n\[\[package\]\]\nname = "bincode"\n[\s\S]*?(?=\n\[\[package\]\])/,
    "",
  );
  assert.notEqual(
    withoutBincode,
    input.lockTexts[lockfile],
    "test fixture must remove bincode",
  );
  input.lockTexts[lockfile] = withoutBincode;
  assert.throws(
    () => validateRustSupplyChainPolicy(input),
    /bincode no longer appears.*remove RUSTSEC-2025-0141/,
  );
});

test("the exception cannot silently cover bincode in another lock", () => {
  const input = fixture();
  const otherLock = "programs/agenc-coordination/fuzz/Cargo.lock";
  input.lockTexts[otherLock] += `

[[package]]
name = "bincode"
version = "1.3.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "b1f45e9417d87227c7a56d22e471c6206462cba514c7590c09aff4cf6d1ddcad"
`;
  assert.throws(
    () => validateRustSupplyChainPolicy(input),
    /exception scope broadened to more than one locked package/,
  );
});

test("cargo-audit ignores must remain lock-specific", () => {
  const input = fixture();
  input.policy.locks[1].auditIgnores.push("RUSTSEC-2025-0141");
  assert.throws(
    () => validateRustSupplyChainPolicy(input),
    /fuzz\/Cargo\.lock audit ignores must be exactly \[\]/,
  );
});

test("deny.toml cannot add an unrelated advisory ignore", () => {
  const input = fixture({
    denyText: DENY_TEXT.replace(
      "ignore = [",
      'ignore = [\n  { id = "RUSTSEC-2099-0001", reason = "unreviewed" },',
    ),
  });
  assert.throws(
    () => validateRustSupplyChainPolicy(input),
    /deny\.toml must contain exactly one structured advisory ignore/,
  );
});

test("GPL approval cannot broaden from the project crate to dependencies", () => {
  const input = fixture({
    denyText: DENY_TEXT.replace('  "MIT",', '  "GPL-3.0-only",\n  "MIT",'),
  });
  assert.throws(
    () => validateRustSupplyChainPolicy(input),
    /deny\.toml allowed licenses must be exactly/,
  );
});

test("cargo-deny graph pruning cannot bypass license or source checks", () => {
  const input = fixture({
    denyText: DENY_TEXT.replace(
      "all-features = true",
      'all-features = true\nexclude = ["bincode"]',
    ),
  });
  assert.throws(
    () => validateRustSupplyChainPolicy(input),
    /deny\.toml graph options must be exactly \["all-features"\]/,
  );
});

test("deny.toml rejects unreviewed tables including license clarifications", () => {
  for (const injected of [
    '\n[[licenses.clarify]]\nname = "unreviewed"\nexpression = "MIT"\n',
    '\n[bans]\nmultiple-versions = "allow"\n',
  ]) {
    assert.throws(
      () =>
        validateRustSupplyChainPolicy(
          fixture({ denyText: DENY_TEXT + injected }),
        ),
      /deny\.toml section inventory/,
    );
  }
});

test("Rust advisory monitoring cannot lose its recurring schedule", () => {
  const withoutSchedule = WORKFLOW_TEXT.replace(
    /\n  schedule:\n    - cron: "[^"]+"/,
    "",
  );
  assert.notEqual(
    withoutSchedule,
    WORKFLOW_TEXT,
    "fixture must remove the schedule",
  );
  assert.throws(
    () =>
      validateRustSupplyChainPolicy(fixture({ workflowText: withoutSchedule })),
    /recurring schedule/,
  );
});

test("expiry monitoring cannot silently drop back to weekly scans", () => {
  assert.throws(
    () =>
      validateRustSupplyChainPolicy(
        fixture({
          workflowText: WORKFLOW_TEXT.replace("41 9 * * *", "41 9 * * 3"),
        }),
      ),
    /daily recurring schedule/,
  );
});

test("audit tool versions cannot float", () => {
  const input = fixture();
  input.policy.tools.cargoAudit.version = "latest";
  assert.throws(
    () => validateRustSupplyChainPolicy(input),
    /cargoAudit\.version must be "0\.22\.2"/,
  );
});
