#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const POLICY = new URL("../supply-chain/npm-license-policy.json", import.meta.url);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "target"]);

function fail(message) {
  throw new Error(message);
}

function sortedUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || value.length === 0)) {
    fail(`${label} must be a non-empty string array`);
  }
  const unique = [...new Set(values)];
  if (unique.length !== values.length || [...values].sort().some((value, index) => value !== values[index])) {
    fail(`${label} must be unique and sorted`);
  }
  return unique;
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys must be exactly ${wanted.join(", ")}`);
  }
}

function parseIsoDay(value, label) {
  if (!DATE.test(value ?? "")) fail(`${label} must use YYYY-MM-DD`);
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    fail(`${label} must be a real calendar date`);
  }
  return milliseconds / 86_400_000;
}

async function discoverPackageLocks(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name === "package-lock.json") {
        found.push(relative(root, absolute).split(sep).join("/"));
      }
    }
  }
  await visit(root);
  return found.sort();
}

function packageName(path, record) {
  if (typeof record.name === "string" && record.name.length > 0) return record.name;
  return path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];
}

function exceptionKey(lockfile, path) {
  return `${lockfile}\0${path}`;
}

function safeRepositoryPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    /[\\%?#\0]/.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`${label} must be a canonical repository-relative path`);
  }
  return value;
}

export function evaluateNpmLicensePolicy({
  policy,
  lockfiles,
  licenseDigests = new Map(),
  codeowners,
  asOf = new Date().toISOString().slice(0, 10),
}) {
  if (!(lockfiles instanceof Map) || typeof codeowners !== "string") {
    fail("invalid npm license policy input");
  }
  exactKeys(
    policy,
    ["schemaVersion", "lockfiles", "allowedLicenses", "exceptionGroups"],
    "policy",
  );
  if (policy.schemaVersion !== 1) fail("policy schemaVersion must be 1");
  const asOfDay = parseIsoDay(asOf, "asOf");
  const configuredLocks = sortedUniqueStrings(policy.lockfiles, "policy lockfiles");
  configuredLocks.forEach((path) => safeRepositoryPath(path, "policy lockfile"));
  const loadedLocks = [...lockfiles.keys()].sort();
  if (JSON.stringify(loadedLocks) !== JSON.stringify(configuredLocks)) {
    fail(
      `policy lockfile inventory differs from repository locks: configured ${configuredLocks.join(", ")}; loaded ${loadedLocks.join(", ")}`,
    );
  }
  const allowed = new Set(sortedUniqueStrings(policy.allowedLicenses, "allowed licenses"));
  if (!Array.isArray(policy.exceptionGroups)) fail("exceptionGroups must be an array");
  const codeownerHandles = new Set(
    codeowners
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+#.*$/, "").trim())
      .filter(Boolean)
      .flatMap((line) => line.split(/\s+/).slice(1)),
  );

  const exceptions = new Map();
  const groupIds = new Set();
  for (const group of policy.exceptionGroups) {
    exactKeys(
      group,
      ["id", "owners", "tracking", "reviewedOn", "expiresOn", "reason", "entries"],
      `license exception group ${group?.id ?? "<unknown>"}`,
    );
    const reviewedDay = parseIsoDay(group.reviewedOn, `${group.id}.reviewedOn`);
    const expiresDay = parseIsoDay(group.expiresOn, `${group.id}.expiresOn`);
    const owners = sortedUniqueStrings(group.owners, `${group.id}.owners`);
    if (
      !/^[a-z][a-z0-9-]*$/.test(group.id) ||
      groupIds.has(group.id) ||
      owners.length < 2 ||
      owners.some(
        (owner) =>
          !/^@[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) ||
          !codeownerHandles.has(owner),
      ) ||
      !/^[A-Z][A-Z0-9-]+-[0-9]+$/.test(group.tracking) ||
      reviewedDay > asOfDay ||
      expiresDay <= asOfDay ||
      expiresDay <= reviewedDay ||
      expiresDay - reviewedDay > 92 ||
      typeof group.reason !== "string" ||
      group.reason.length < 20 ||
      !Array.isArray(group.entries) ||
      group.entries.length === 0
    ) {
      fail(`invalid or expired license exception group ${group?.id ?? "<unknown>"}`);
    }
    groupIds.add(group.id);
    for (const entry of group.entries) {
      exactKeys(
        entry,
        entry.licenseFile === undefined
          ? [
              "lockfile",
              "path",
              "package",
              "version",
              "observedLicense",
              "approvedLicense",
              "evidence",
            ]
          : [
              "lockfile",
              "path",
              "package",
              "version",
              "observedLicense",
              "approvedLicense",
              "licenseFile",
              "licenseSha256",
            ],
        `license exception ${group.id}`,
      );
      const key = exceptionKey(entry?.lockfile, entry?.path);
      if (
        !configuredLocks.includes(entry?.lockfile) ||
        safeRepositoryPath(entry.path, "license exception path") !== entry.path ||
        typeof entry.package !== "string" ||
        typeof entry.version !== "string" ||
        !(entry.observedLicense === null || typeof entry.observedLicense === "string") ||
        typeof entry.approvedLicense !== "string" ||
        entry.approvedLicense.length === 0 ||
        exceptions.has(key)
      ) {
        fail(`invalid or duplicate license exception in ${group.id}`);
      }
      if (entry.licenseFile !== undefined) {
        if (
          safeRepositoryPath(entry.licenseFile, "license evidence path") !== entry.licenseFile ||
          !/^[0-9a-f]{64}$/.test(entry.licenseSha256 ?? "")
        ) {
          fail(`invalid license-file evidence for ${entry.package}@${entry.version}`);
        }
      } else if (typeof entry.evidence !== "string" || !entry.evidence.startsWith("https://")) {
        fail(`external evidence is required for ${entry.package}@${entry.version}`);
      }
      exceptions.set(key, { ...entry, group: group.id, matched: false });
    }
  }

  let checked = 0;
  let excepted = 0;
  for (const lockfile of configuredLocks) {
    const lock = lockfiles.get(lockfile);
    if (
      lock?.lockfileVersion !== 3 ||
      lock.packages === null ||
      typeof lock.packages !== "object" ||
      Array.isArray(lock.packages)
    ) {
      fail(`${lockfile} must be a loaded npm lockfile v3`);
    }
    for (const [path, record] of Object.entries(lock.packages)) {
      if (path === "" || record?.link === true || typeof record?.version !== "string") continue;
      const name = packageName(path, record);
      if (!name) fail(`${lockfile}:${path} has no package identity`);
      checked += 1;
      if (allowed.has(record.license)) continue;
      const key = exceptionKey(lockfile, path);
      const exception = exceptions.get(key);
      if (
        !exception ||
        exception.package !== name ||
        exception.version !== record.version ||
        exception.observedLicense !== (record.license ?? null)
      ) {
        fail(
          `${lockfile}:${path} (${name}@${record.version}) has unapproved license ` +
            `${JSON.stringify(record.license ?? null)}`,
        );
      }
      if (
        exception.licenseFile !== undefined &&
        licenseDigests.get(exception.licenseFile) !== exception.licenseSha256
      ) {
        fail(`license evidence digest mismatch for ${name}@${record.version}`);
      }
      exception.matched = true;
      excepted += 1;
    }
  }
  const stale = [...exceptions.values()].filter(({ matched }) => !matched);
  if (stale.length > 0) {
    fail(
      `stale license exceptions: ${stale
        .map(({ package: name, version, group }) => `${name}@${version} (${group})`)
        .join(", ")}`,
    );
  }
  return Object.freeze({ checked, excepted, lockfiles: configuredLocks.length });
}

async function cli() {
  const policy = JSON.parse(await readFile(POLICY, "utf8"));
  const rootPath = fileURLToPath(ROOT);
  const discoveredLocks = await discoverPackageLocks(rootPath);
  const lockfiles = new Map(
    await Promise.all(
      discoveredLocks.map(async (path) => [
        path,
        JSON.parse(await readFile(new URL(path, ROOT), "utf8")),
      ]),
    ),
  );
  const licenseFiles = [
    ...new Set(
      policy.exceptionGroups.flatMap(({ entries }) =>
        entries.flatMap(({ licenseFile }) => (licenseFile ? [licenseFile] : [])),
      ),
    ),
  ];
  const licenseDigests = new Map(
    await Promise.all(
      licenseFiles.map(async (path) => [
        path,
        createHash("sha256").update(await readFile(new URL(path, ROOT))).digest("hex"),
      ]),
    ),
  );
  const codeowners = await readFile(new URL(".github/CODEOWNERS", ROOT), "utf8");
  const result = evaluateNpmLicensePolicy({
    policy,
    lockfiles,
    licenseDigests,
    codeowners,
  });
  console.log(
    `npm license policy: ${result.checked} packages across ${result.lockfiles} locks; ` +
      `${result.excepted} exact, owned exceptions`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    console.error(`npm license policy failed: ${error.message}`);
    process.exitCode = 1;
  });
}
