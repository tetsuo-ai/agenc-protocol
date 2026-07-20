#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "target"]);
const REQUIRED_PACKAGE_MANAGER = "npm@11.18.0";
const REQUIRED_ENGINES = Object.freeze({
  node: ">=22.23.1",
  npm: "11.18.0",
});
const REQUIRED_NPM_CONFIG = Object.freeze({
  "dangerously-allow-all-scripts": "false",
  "engine-strict": "true",
  "strict-allow-scripts": "true",
});
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CANONICAL_SHA512 = /^sha512-([A-Za-z0-9+/]{86}==)$/;

function fail(message) {
  throw new Error(message);
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

function packageNameFromLockPath(path) {
  return path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];
}

function exactApprovalKey(name, version) {
  return `${name}@${version}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateToolchain(lockfile, manifest, npmrc) {
  if (manifest.packageManager !== REQUIRED_PACKAGE_MANAGER) {
    fail(
      `${lockfile}: packageManager must be exactly ${REQUIRED_PACKAGE_MANAGER}`,
    );
  }
  if (
    !isPlainObject(manifest.engines) ||
    manifest.engines.node !== REQUIRED_ENGINES.node ||
    manifest.engines.npm !== REQUIRED_ENGINES.npm
  ) {
    fail(
      `${lockfile}: engines must require node ${REQUIRED_ENGINES.node} and npm ${REQUIRED_ENGINES.npm}`,
    );
  }
  if (typeof npmrc !== "string") {
    fail(`${lockfile}: colocated .npmrc is required`);
  }

  const config = new Map();
  for (const [index, rawLine] of npmrc.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals <= 0) {
      fail(`${lockfile}: malformed .npmrc line ${index + 1}`);
    }
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (config.has(key)) {
      fail(`${lockfile}: duplicate .npmrc key ${key}`);
    }
    config.set(key, value);
  }
  for (const [key, value] of Object.entries(REQUIRED_NPM_CONFIG)) {
    if (config.get(key) !== value) {
      fail(`${lockfile}: .npmrc must set ${key}=${value}`);
    }
  }
}

function validateRegistryPackage(lockfile, path, record) {
  if (!isPlainObject(record)) {
    fail(`${lockfile}:${path} install-script package record is invalid`);
  }
  if (record.link === true) {
    fail(`${lockfile}:${path} install-script package must not be a link`);
  }

  const name = packageNameFromLockPath(path);
  if (!name) {
    fail(`${lockfile}:${path} install-script package has no path-derived name`);
  }
  if (Object.hasOwn(record, "name") && record.name !== name) {
    fail(
      `${lockfile}:${path} install-script package name ${JSON.stringify(record.name)} does not match path-derived ${name}`,
    );
  }

  if (
    typeof record.version !== "string" ||
    !EXACT_SEMVER.test(record.version)
  ) {
    fail(`${lockfile}:${path} install-script package has no exact version`);
  }

  let resolved;
  try {
    resolved = new URL(record.resolved);
  } catch {
    fail(
      `${lockfile}:${path} install-script package has no valid registry URL`,
    );
  }
  if (
    resolved.protocol !== "https:" ||
    resolved.hostname !== "registry.npmjs.org" ||
    resolved.port !== "" ||
    resolved.username !== "" ||
    resolved.password !== "" ||
    resolved.search !== "" ||
    resolved.hash !== "" ||
    !resolved.pathname.endsWith(".tgz")
  ) {
    fail(
      `${lockfile}:${path} install-script package must resolve from https://registry.npmjs.org`,
    );
  }
  const tarballName = name.slice(name.lastIndexOf("/") + 1);
  const expectedPathname = `/${name}/-/${tarballName}-${record.version}.tgz`;
  if (resolved.pathname !== expectedPathname) {
    fail(
      `${lockfile}:${path} registry tarball path must match ${name}@${record.version}`,
    );
  }

  const integrityMatch =
    typeof record.integrity === "string"
      ? record.integrity.match(CANONICAL_SHA512)
      : null;
  if (!integrityMatch) {
    fail(
      `${lockfile}:${path} install-script package needs canonical sha512 integrity`,
    );
  }
  const digest = Buffer.from(integrityMatch[1], "base64");
  if (
    digest.byteLength !== 64 ||
    digest.toString("base64") !== integrityMatch[1]
  ) {
    fail(
      `${lockfile}:${path} install-script package needs canonical sha512 integrity`,
    );
  }

  return Object.freeze({ name, version: record.version });
}

/**
 * Validate npm 11.18 install-script decisions against every lockfile entry.
 *
 * Approvals must pin an exact package version (`name@version: true`). Denials
 * are intentionally name-wide (`name: false`) so a dependency update cannot
 * silently re-enable code that the repository does not need to execute.
 */
export function evaluateNpmInstallScriptPolicy(projects) {
  if (!(projects instanceof Map) || projects.size === 0) {
    fail("install-script projects must be a non-empty Map");
  }

  let packages = 0;
  let approvals = 0;
  let denials = 0;

  for (const [lockfile, project] of projects) {
    const { lock, manifest, npmrc } = project ?? {};
    if (
      lock?.lockfileVersion !== 3 ||
      !isPlainObject(lock.packages) ||
      !isPlainObject(manifest)
    ) {
      fail(`${lockfile} must have a package.json and npm lockfile v3`);
    }
    validateToolchain(lockfile, manifest, npmrc);

    const decisions = manifest.allowScripts ?? {};
    if (!isPlainObject(decisions)) {
      fail(`${lockfile}: allowScripts must be an object`);
    }
    const decisionKeys = Object.keys(decisions);
    if (
      decisionKeys.some((key) => key.length === 0) ||
      decisionKeys.some((key) => typeof decisions[key] !== "boolean") ||
      [...decisionKeys].sort().some((key, index) => key !== decisionKeys[index])
    ) {
      fail(`${lockfile}: allowScripts keys must be sorted and boolean-valued`);
    }

    const installPackages = [];
    for (const [path, record] of Object.entries(lock.packages)) {
      if (record?.hasInstallScript !== true) {
        continue;
      }
      installPackages.push(validateRegistryPackage(lockfile, path, record));
    }

    const matched = new Set();
    for (const { name, version } of installPackages) {
      const approval = exactApprovalKey(name, version);
      if (decisions[name] === false) {
        matched.add(name);
        denials += 1;
      } else if (decisions[approval] === true) {
        matched.add(approval);
        approvals += 1;
      } else {
        fail(
          `${lockfile}: ${name}@${version} has an unreviewed install script; ` +
            `add an exact true approval or a name-wide false denial`,
        );
      }
      packages += 1;
    }

    for (const key of decisionKeys) {
      const decision = decisions[key];
      if (
        decision === true &&
        !key.includes("@", key.startsWith("@") ? 1 : 0)
      ) {
        fail(
          `${lockfile}: install-script approval ${key} must pin an exact version`,
        );
      }
      if (decision === false && /@[^/]+$/.test(key)) {
        fail(`${lockfile}: install-script denial ${key} must be name-wide`);
      }
      if (!matched.has(key)) {
        fail(`${lockfile}: stale install-script decision ${key}`);
      }
    }
  }

  return Object.freeze({
    lockfiles: projects.size,
    packages,
    approvals,
    denials,
  });
}

async function cli() {
  const rootPath = fileURLToPath(ROOT);
  const lockfiles = await discoverPackageLocks(rootPath);
  const projects = new Map(
    await Promise.all(
      lockfiles.map(async (lockfile) => {
        const lockPath = resolve(rootPath, lockfile);
        const manifestPath = resolve(dirname(lockPath), "package.json");
        const npmrcPath = resolve(dirname(lockPath), ".npmrc");
        return [
          lockfile,
          {
            lock: JSON.parse(await readFile(lockPath, "utf8")),
            manifest: JSON.parse(await readFile(manifestPath, "utf8")),
            npmrc: await readFile(npmrcPath, "utf8"),
          },
        ];
      }),
    ),
  );
  const result = evaluateNpmInstallScriptPolicy(projects);
  console.log(
    `npm install-script policy: ${result.packages} packages across ` +
      `${result.lockfiles} locks; ${result.approvals} exact approvals, ` +
      `${result.denials} explicit denials`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    console.error(`npm install-script policy failed: ${error.message}`);
    process.exitCode = 1;
  });
}
