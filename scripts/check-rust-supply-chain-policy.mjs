#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const POLICY_PATH = "supply-chain/rust-policy.json";
const ALLOWED_REGISTRY =
  "registry+https://github.com/rust-lang/crates.io-index";

const EXPECTED_LOCKS = [
  {
    manifest: "programs/agenc-coordination/Cargo.toml",
    lockfile: "programs/agenc-coordination/Cargo.lock",
  },
  {
    manifest: "programs/agenc-coordination/fuzz/Cargo.toml",
    lockfile: "programs/agenc-coordination/fuzz/Cargo.lock",
  },
  {
    manifest: "zkvm/Cargo.toml",
    lockfile: "zkvm/Cargo.lock",
  },
];

const EXPECTED_EXCEPTION = {
  id: "RUSTSEC-2025-0141",
  kind: "unmaintained",
  name: "bincode",
  version: "1.3.3",
  checksum: "b1f45e9417d87227c7a56d22e471c6206462cba514c7590c09aff4cf6d1ddcad",
  lockfile: "programs/agenc-coordination/Cargo.lock",
  owners: ["@7etsuo", "@signerless"],
  tracking: "CARGO-MAINT-001",
};

const EXPECTED_TOOLS = {
  cargoAudit: {
    version: "0.22.2",
    versionOutput: "cargo-audit 0.22.2",
    linuxX86_64: {
      url: "https://github.com/rustsec/rustsec/releases/download/cargo-audit/v0.22.2/cargo-audit-x86_64-unknown-linux-musl-v0.22.2.tgz",
      sha256:
        "7fb9497f8594b389e5fce5ef9b92db08432996895b2e0c5a0167a69ed445c428",
      member: "cargo-audit-x86_64-unknown-linux-musl-v0.22.2/cargo-audit",
    },
  },
  cargoDeny: {
    version: "0.20.2",
    versionOutput: "cargo-deny 0.20.2",
    linuxX86_64: {
      url: "https://github.com/EmbarkStudios/cargo-deny/releases/download/0.20.2/cargo-deny-0.20.2-x86_64-unknown-linux-musl.tar.gz",
      sha256:
        "9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f",
      member: "cargo-deny-0.20.2-x86_64-unknown-linux-musl/cargo-deny",
    },
  },
};

const EXPECTED_LICENSES = [
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-1-Clause",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "MIT",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
];

const EXPECTED_LICENSE_EXCEPTION = {
  crate: "agenc-coordination@0.1.0",
  allow: ["GPL-3.0-only"],
};

const EXPECTED_ACTIONS = [
  "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4",
];

const EXPECTED_RELEASE_TAGS = [
  "protocol-v*",
  "sdk-v*",
  "react-v*",
  "tools-v*",
  "mcp-v*",
  "moderation-v*",
  "worker-v*",
  "cli-v*",
  "cli-alias-v*",
];

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "target"]);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`Rust supply-chain policy violation: ${message}`);
  }
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

function exactKeys(value, expected, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} keys must be exactly ${wanted.join(", ")}; found ${actual.join(", ")}`,
  );
}

function exactArray(actual, expected, label) {
  invariant(Array.isArray(actual), `${label} must be an array`);
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} must be exactly ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}`,
  );
}

function exactObject(actual, expected, label) {
  exactKeys(actual, Object.keys(expected), label);
  for (const [key, value] of Object.entries(expected)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      exactObject(actual[key], value, `${label}.${key}`);
    } else {
      invariant(
        actual[key] === value,
        `${label}.${key} must be ${JSON.stringify(value)}; found ${JSON.stringify(actual[key])}`,
      );
    }
  }
}

function parseIsoDay(value, label) {
  invariant(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value),
    `${label} must use YYYY-MM-DD`,
  );
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  invariant(Number.isFinite(milliseconds), `${label} is not a valid date`);
  invariant(
    new Date(milliseconds).toISOString().slice(0, 10) === value,
    `${label} is not a real calendar date`,
  );
  return milliseconds / 86_400_000;
}

function findCargoLocks(root) {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          visit(resolve(directory, entry.name));
        }
      } else if (entry.isFile() && entry.name === "Cargo.lock") {
        found.push(
          normalizePath(relative(root, resolve(directory, entry.name))),
        );
      }
    }
  };
  visit(root);
  return found.sort();
}

export function parseCargoLock(text, label = "Cargo.lock") {
  invariant(typeof text === "string", `${label} must be text`);
  const packages = [];
  let current;

  const finish = () => {
    if (!current) return;
    invariant(
      current.name && current.version,
      `${label} contains an incomplete package record`,
    );
    packages.push(current);
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "[[package]]") {
      finish();
      current = {};
      continue;
    }
    if (!current) continue;
    const match = line.match(
      /^(name|version|source|checksum)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/,
    );
    if (match) current[match[1]] = JSON.parse(match[2]);
  }
  finish();
  invariant(packages.length > 0, `${label} contains no package records`);
  return packages;
}

function section(text, name) {
  const header = `[${name}]`;
  const start = text.indexOf(header);
  invariant(start >= 0, `deny.toml is missing ${header}`);
  invariant(
    text.indexOf(header, start + header.length) < 0,
    `deny.toml contains duplicate ${header} sections`,
  );
  const bodyStart = start + header.length;
  const remainder = text.slice(bodyStart);
  const next = remainder.search(/^\[[^\]]+\]\s*$/m);
  return next < 0 ? remainder : remainder.slice(0, next);
}

function tomlStrings(sectionText, key, label) {
  const body = tomlArrayBody(sectionText, key, label);
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) =>
    JSON.parse(`"${item[1]}"`),
  );
}

function tomlAssignmentKeys(sectionText) {
  return [...sectionText.matchAll(/^\s*([A-Za-z][\w-]*)\s*=/gm)].map(
    (match) => match[1],
  );
}

function tomlArrayBody(sectionText, key, label) {
  const match = sectionText.match(
    new RegExp(`^\\s*${key.replaceAll("-", "\\-")}\\s*=\\s*\\[`, "m"),
  );
  invariant(match, `${label} must define ${key} as an array`);
  const start = (match.index ?? 0) + match[0].length;
  let depth = 1;
  let quote;
  let escaped = false;
  for (let index = start; index < sectionText.length; index += 1) {
    const character = sectionText[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\" && quote === '"') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) return sectionText.slice(start, index);
    }
  }
  invariant(false, `${label}.${key} has an unterminated array`);
}

function validateDenyConfig(denyText, exception) {
  invariant(typeof denyText === "string", "deny.toml must be text");

  const sectionInventory = [
    ...denyText.matchAll(/^\s*(\[\[?[^\]\r\n]+\]\]?)\s*(?:#.*)?$/gm),
  ].map((match) => match[1]);
  exactArray(
    sectionInventory,
    [
      "[graph]",
      "[advisories]",
      "[licenses]",
      "[licenses.private]",
      "[sources]",
      "[sources.allow-org]",
    ],
    "deny.toml section inventory",
  );

  const graph = section(denyText, "graph");
  exactArray(
    tomlAssignmentKeys(graph),
    ["all-features"],
    "deny.toml graph options",
  );
  invariant(
    /^all-features\s*=\s*true\s*$/m.test(graph),
    "deny.toml must check all features",
  );

  const advisories = section(denyText, "advisories");
  exactArray(
    tomlAssignmentKeys(advisories),
    ["ignore"],
    "deny.toml advisory options",
  );
  const advisoryIgnoreBody = tomlArrayBody(
    advisories,
    "ignore",
    "[advisories]",
  );
  const advisoryObjects = [...advisoryIgnoreBody.matchAll(/\{([^{}]*)\}/g)];
  invariant(
    advisoryObjects.length === 1,
    "deny.toml must contain exactly one structured advisory ignore",
  );
  invariant(
    advisoryIgnoreBody
      .replace(advisoryObjects[0][0], "")
      .replace(/[\s,]/g, "") === "",
    "deny.toml advisory ignore array contains an unreviewed entry",
  );
  const advisoryFields = [
    ...advisoryObjects[0][1].matchAll(/\b([A-Za-z][\w-]*)\s*=/g),
  ].map((match) => match[1]);
  exactArray(
    advisoryFields.sort(),
    ["id", "reason"],
    "deny.toml advisory ignore fields",
  );
  const advisoryIds = [
    ...advisoryObjects[0][1].matchAll(/\bid\s*=\s*"([^"]+)"/g),
  ].map((match) => match[1]);
  exactArray(advisoryIds, [exception.id], "deny.toml advisory ignores");
  for (const token of [
    exception.tracking,
    `${exception.package.name} ${exception.package.version}`,
    ...exception.owners,
    exception.reviewedOn,
    exception.expiresOn,
  ]) {
    invariant(
      advisories.includes(token),
      `deny.toml exception reason must include ${token}`,
    );
  }

  const licenses = section(denyText, "licenses");
  exactArray(
    tomlAssignmentKeys(licenses),
    ["allow", "confidence-threshold", "exceptions"],
    "deny.toml license options",
  );
  const allowedLicenses = tomlStrings(licenses, "allow", "[licenses]").sort();
  exactArray(
    allowedLicenses,
    [...EXPECTED_LICENSES].sort(),
    "deny.toml allowed licenses",
  );
  const licenseExceptionBody = tomlArrayBody(
    licenses,
    "exceptions",
    "[licenses]",
  );
  const licenseExceptionObjects = [
    ...licenseExceptionBody.matchAll(/\{([^{}]*)\}/g),
  ];
  invariant(
    licenseExceptionObjects.length === 1,
    "deny.toml must contain exactly one project-license exception",
  );
  invariant(
    licenseExceptionBody
      .replace(licenseExceptionObjects[0][0], "")
      .replace(/[\s,]/g, "") === "",
    "deny.toml license exceptions contain an unreviewed entry",
  );
  const licenseException = licenseExceptionObjects[0][1];
  const licenseExceptionFields = [
    ...licenseException.matchAll(/\b([A-Za-z][\w-]*)\s*=/g),
  ].map((match) => match[1]);
  exactArray(
    licenseExceptionFields.sort(),
    ["allow", "crate"],
    "project license exception fields",
  );
  invariant(
    licenseException.includes(`crate = "${EXPECTED_LICENSE_EXCEPTION.crate}"`),
    "GPL exception must apply only to the AgenC program crate",
  );
  exactArray(
    tomlStrings(licenseException, "allow", "license exception"),
    EXPECTED_LICENSE_EXCEPTION.allow,
    "project license exception",
  );
  invariant(
    /^confidence-threshold\s*=\s*0\.8\s*$/m.test(licenses),
    "deny.toml license confidence threshold must be 0.8",
  );

  const privateLicenses = section(denyText, "licenses.private");
  exactArray(
    tomlAssignmentKeys(privateLicenses),
    ["ignore", "registries"],
    "deny.toml private-license options",
  );
  invariant(
    /^ignore\s*=\s*true\s*$/m.test(privateLicenses),
    "private workspace crates must be ignored",
  );
  exactArray(
    tomlStrings(privateLicenses, "registries", "[licenses.private]"),
    [],
    "private license registries",
  );

  const sources = section(denyText, "sources");
  exactArray(
    tomlAssignmentKeys(sources),
    ["unknown-registry", "unknown-git", "allow-registry", "allow-git"],
    "deny.toml source options",
  );
  invariant(
    /^unknown-registry\s*=\s*"deny"\s*$/m.test(sources),
    "unknown registries must be denied",
  );
  invariant(
    /^unknown-git\s*=\s*"deny"\s*$/m.test(sources),
    "unknown git sources must be denied",
  );
  exactArray(
    tomlStrings(sources, "allow-registry", "[sources]"),
    [ALLOWED_REGISTRY.replace(/^registry\+/, "")],
    "allowed registries",
  );
  exactArray(
    tomlStrings(sources, "allow-git", "[sources]"),
    [],
    "allowed git sources",
  );

  const sourceOrgs = section(denyText, "sources.allow-org");
  exactArray(
    tomlAssignmentKeys(sourceOrgs),
    ["github", "gitlab", "bitbucket"],
    "deny.toml source-organization options",
  );
  for (const host of ["github", "gitlab", "bitbucket"]) {
    exactArray(
      tomlStrings(sourceOrgs, host, "[sources.allow-org]"),
      [],
      `allowed ${host} organizations`,
    );
  }
}

function validateWorkflow(workflowText, policy) {
  invariant(
    typeof workflowText === "string",
    `${policy.workflow} must be text`,
  );
  invariant(
    /\bworkflow_call:\s*$/m.test(workflowText),
    "workflow must be reusable via workflow_call",
  );
  invariant(
    /\bpull_request:\s*$/m.test(workflowText),
    "workflow must run for pull requests",
  );
  invariant(
    /\bworkflow_dispatch:\s*$/m.test(workflowText),
    "workflow must support manual runs",
  );
  invariant(
    /\bschedule:\s*$[\s\S]*?\bcron:\s*["'][^"']+["']/m.test(workflowText),
    "workflow must run on a recurring schedule",
  );
  invariant(
    /runs-on:\s*ubuntu-24\.04\s*$/m.test(workflowText),
    "workflow runner must be ubuntu-24.04",
  );
  invariant(
    /timeout-minutes:\s*30\s*$/m.test(workflowText),
    "workflow must have a 30-minute timeout",
  );
  invariant(
    /contents:\s*read\s*$/m.test(workflowText),
    "workflow permissions must be read-only",
  );
  invariant(
    /node-version:\s*["']24\.18\.0["']\s*$/m.test(workflowText),
    "workflow Node version must be 24.18.0",
  );
  invariant(
    /toolchain:\s*["']?1\.85\.0["']?\s*$/m.test(workflowText),
    "workflow Rust version must be 1.85.0",
  );
  for (const tag of EXPECTED_RELEASE_TAGS) {
    invariant(
      workflowText.includes(`- "${tag}"`),
      `workflow must gate ${tag} release tags`,
    );
  }
  invariant(
    !/\bcargo install\b/.test(workflowText),
    "workflow must not compile audit tools with the project toolchain",
  );
  invariant(
    /sha256sum --check --strict/.test(workflowText),
    "workflow must verify artifact SHA-256 values",
  );
  invariant(
    workflowText.includes(
      "node --test scripts/rust-supply-chain-policy.test.mjs",
    ),
    "workflow must run the policy regression tests",
  );
  invariant(
    workflowText.includes(
      "node scripts/check-rust-supply-chain-policy.mjs --run-tools",
    ),
    "workflow must execute all pinned audit tools through the policy runner",
  );

  const actions = [...workflowText.matchAll(/^\s*-\s+uses:\s*([^\s#]+)/gm)].map(
    (match) => match[1],
  );
  exactArray(actions, EXPECTED_ACTIONS, "workflow action references");

  for (const tool of Object.values(policy.tools)) {
    for (const value of [
      tool.version,
      tool.versionOutput,
      tool.linuxX86_64.url,
      tool.linuxX86_64.sha256,
      tool.linuxX86_64.member,
    ]) {
      invariant(
        workflowText.includes(value),
        `workflow must pin tool value ${value}`,
      );
    }
  }
}

function validateToolPolicy(tools) {
  exactKeys(tools, ["cargoAudit", "cargoDeny"], "policy.tools");
  exactObject(
    tools.cargoAudit,
    EXPECTED_TOOLS.cargoAudit,
    "policy.tools.cargoAudit",
  );
  exactObject(
    tools.cargoDeny,
    EXPECTED_TOOLS.cargoDeny,
    "policy.tools.cargoDeny",
  );
}

function readDocument(root, path, override) {
  if (override !== undefined) return override;
  const absolute = resolve(root, path);
  invariant(existsSync(absolute), `${path} does not exist`);
  invariant(statSync(absolute).isFile(), `${path} is not a regular file`);
  return readFileSync(absolute, "utf8");
}

export function validateRustSupplyChainPolicy({
  root = DEFAULT_ROOT,
  now = new Date(),
  policy: policyOverride,
  denyText: denyOverride,
  workflowText: workflowOverride,
  lockTexts = {},
} = {}) {
  root = resolve(root);
  invariant(
    now instanceof Date && Number.isFinite(now.valueOf()),
    "validation time must be a valid Date",
  );

  const policy =
    policyOverride ?? JSON.parse(readDocument(root, POLICY_PATH, undefined));
  exactKeys(
    policy,
    [
      "schemaVersion",
      "workflow",
      "denyConfig",
      "tools",
      "locks",
      "advisoryExceptions",
    ],
    "policy",
  );
  invariant(policy.schemaVersion === 1, "schemaVersion must be 1");
  invariant(
    policy.workflow === ".github/workflows/rust-supply-chain.yml",
    "workflow path is fixed",
  );
  invariant(policy.denyConfig === "deny.toml", "deny config path is fixed");
  validateToolPolicy(policy.tools);

  invariant(Array.isArray(policy.locks), "policy.locks must be an array");
  invariant(
    policy.locks.length === EXPECTED_LOCKS.length,
    "policy must cover exactly three Cargo locks",
  );
  policy.locks.forEach((entry, index) => {
    exactKeys(
      entry,
      ["manifest", "lockfile", "auditIgnores"],
      `policy.locks[${index}]`,
    );
    invariant(
      entry.manifest === EXPECTED_LOCKS[index].manifest,
      `lock ${index} manifest is not the expected workspace root`,
    );
    invariant(
      entry.lockfile === EXPECTED_LOCKS[index].lockfile,
      `lock ${index} path is not the expected Cargo.lock`,
    );
    invariant(
      existsSync(resolve(root, entry.manifest)),
      `${entry.manifest} does not exist`,
    );
    invariant(
      existsSync(resolve(root, entry.lockfile)),
      `${entry.lockfile} does not exist`,
    );
  });

  const discoveredLocks = findCargoLocks(root);
  exactArray(
    discoveredLocks,
    EXPECTED_LOCKS.map((entry) => entry.lockfile).sort(),
    "repository Cargo.lock inventory",
  );

  invariant(
    Array.isArray(policy.advisoryExceptions),
    "advisoryExceptions must be an array",
  );
  invariant(
    policy.advisoryExceptions.length === 1,
    "exactly one advisory exception is permitted; broadening requires a new reviewed policy design",
  );
  const exception = policy.advisoryExceptions[0];
  exactKeys(
    exception,
    [
      "id",
      "kind",
      "package",
      "lockfile",
      "owners",
      "tracking",
      "reviewedOn",
      "expiresOn",
      "reason",
      "remediation",
    ],
    "advisoryExceptions[0]",
  );
  exactKeys(
    exception.package,
    ["name", "version", "checksum"],
    "advisoryExceptions[0].package",
  );
  for (const key of ["id", "kind", "lockfile", "tracking"]) {
    invariant(
      exception[key] === EXPECTED_EXCEPTION[key],
      `${key} cannot be broadened or redirected`,
    );
  }
  for (const key of ["name", "version", "checksum"]) {
    invariant(
      exception.package[key] === EXPECTED_EXCEPTION[key],
      `exception package ${key} must remain exact`,
    );
  }
  exactArray(exception.owners, EXPECTED_EXCEPTION.owners, "exception owners");
  const codeowners = readDocument(root, ".github/CODEOWNERS", undefined);
  for (const owner of exception.owners) {
    invariant(
      codeowners.split(/\r?\n/).some((line) => line.includes(owner)),
      `exception owner ${owner} must remain assigned in .github/CODEOWNERS`,
    );
  }
  invariant(
    typeof exception.reason === "string" && exception.reason.length >= 60,
    "exception reason is incomplete",
  );
  invariant(
    typeof exception.remediation === "string" &&
      exception.remediation.includes("Remove this exception"),
    "exception remediation must require removal",
  );

  const reviewedDay = parseIsoDay(exception.reviewedOn, "exception reviewedOn");
  const expiresDay = parseIsoDay(exception.expiresOn, "exception expiresOn");
  const today =
    Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) / 86_400_000;
  invariant(
    reviewedDay <= today,
    "exception review date cannot be in the future",
  );
  invariant(
    expiresDay > reviewedDay,
    "exception expiry must follow its review date",
  );
  invariant(
    expiresDay - reviewedDay <= 92,
    "exception review window cannot exceed 92 days",
  );
  invariant(
    today < expiresDay,
    `exception expired on ${exception.expiresOn}; remove it or complete and record a new review`,
  );

  for (const entry of policy.locks) {
    const expectedIgnores = policy.advisoryExceptions
      .filter((item) => item.lockfile === entry.lockfile)
      .map((item) => item.id);
    exactArray(
      entry.auditIgnores,
      expectedIgnores,
      `${entry.lockfile} audit ignores`,
    );
  }

  const packagesByLock = new Map();
  for (const entry of policy.locks) {
    const lockText = readDocument(
      root,
      entry.lockfile,
      lockTexts[entry.lockfile],
    );
    const packages = parseCargoLock(lockText, entry.lockfile);
    packagesByLock.set(entry.lockfile, packages);
    for (const item of packages) {
      if (item.source !== undefined) {
        invariant(
          item.source === ALLOWED_REGISTRY,
          `${entry.lockfile} uses unapproved source ${item.source}`,
        );
        invariant(
          /^[a-f0-9]{64}$/.test(item.checksum ?? ""),
          `${item.name}@${item.version} lacks a pinned registry checksum`,
        );
      }
    }
  }

  const bincodeOccurrences = [];
  for (const [lockfile, packages] of packagesByLock) {
    for (const item of packages.filter(
      (candidate) => candidate.name === EXPECTED_EXCEPTION.name,
    )) {
      bincodeOccurrences.push({ lockfile, ...item });
    }
  }
  invariant(
    bincodeOccurrences.length > 0,
    "bincode no longer appears in any covered lockfile; remove RUSTSEC-2025-0141 instead of retaining a stale exception",
  );
  invariant(
    bincodeOccurrences.length === 1,
    "bincode exception scope broadened to more than one locked package",
  );
  const lockedBincode = bincodeOccurrences[0];
  invariant(
    lockedBincode.lockfile === exception.lockfile,
    "bincode moved outside the reviewed lockfile scope",
  );
  invariant(
    lockedBincode.version === exception.package.version,
    "locked bincode version differs from the reviewed exact version",
  );
  invariant(
    lockedBincode.checksum === exception.package.checksum,
    "locked bincode checksum differs from the reviewed artifact",
  );
  invariant(
    lockedBincode.source === ALLOWED_REGISTRY,
    "locked bincode source differs from the reviewed registry",
  );

  const denyText = readDocument(root, policy.denyConfig, denyOverride);
  validateDenyConfig(denyText, exception);
  const workflowText = readDocument(root, policy.workflow, workflowOverride);
  validateWorkflow(workflowText, policy);

  return policy;
}

function commandVersion(binary, expected) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
  invariant(
    !result.error,
    `cannot execute ${binary}: ${result.error?.message}`,
  );
  invariant(
    result.status === 0,
    `${binary} --version failed with status ${result.status}`,
  );
  const output = `${result.stdout}${result.stderr}`.trim();
  invariant(
    output === expected,
    `${binary} must report ${expected}; found ${output}`,
  );
}

function runCommand(binary, args, root) {
  const result = spawnSync(binary, args, {
    cwd: root,
    env: { ...process.env, CARGO_TERM_COLOR: "never" },
    stdio: "inherit",
  });
  invariant(
    !result.error,
    `cannot execute ${binary}: ${result.error?.message}`,
  );
  invariant(
    result.status === 0,
    `${binary} ${args.join(" ")} failed with status ${result.status}`,
  );
}

export function runPinnedTools(policy, { root = DEFAULT_ROOT } = {}) {
  root = resolve(root);
  const cargoAudit = process.env.CARGO_AUDIT_BIN || "cargo-audit";
  const cargoDeny = process.env.CARGO_DENY_BIN || "cargo-deny";
  commandVersion(cargoAudit, policy.tools.cargoAudit.versionOutput);
  commandVersion(cargoDeny, policy.tools.cargoDeny.versionOutput);

  for (const entry of policy.locks) {
    // cargo-audit is a Cargo subcommand binary and expects its `audit`
    // dispatcher token even when invoked by absolute path.
    const args = [
      "audit",
      "--deny",
      "warnings",
      "--file",
      resolve(root, entry.lockfile),
    ];
    for (const advisory of entry.auditIgnores) args.push("--ignore", advisory);
    runCommand(cargoAudit, args, root);
  }

  for (const entry of policy.locks) {
    runCommand(
      cargoDeny,
      [
        "--manifest-path",
        resolve(root, entry.manifest),
        "--config",
        resolve(root, policy.denyConfig),
        "--locked",
        "check",
        "--deny",
        "warnings",
        // A shared allowlist spans three independent graphs, so some licenses
        // and the one scoped advisory are intentionally absent in a given run.
        // The metadata validator independently rejects stale/broadened entries.
        "--allow",
        "license-not-encountered",
        "--allow",
        "license-exception-not-encountered",
        "--allow",
        "advisory-not-detected",
        "advisories",
        "licenses",
        "sources",
      ],
      root,
    );
  }
}

function main() {
  const unknown = process.argv
    .slice(2)
    .filter((argument) => argument !== "--run-tools");
  invariant(unknown.length === 0, `unknown argument(s): ${unknown.join(", ")}`);
  const policy = validateRustSupplyChainPolicy();
  console.log(
    "Rust supply-chain policy metadata, lock scope, deny config, and workflow pins are valid.",
  );
  if (process.argv.includes("--run-tools")) {
    runPinnedTools(policy);
    console.log(
      "All three Cargo locks passed the pinned advisory, license, and source checks.",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
