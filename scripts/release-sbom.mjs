#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { basename, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { isPrereleaseVersion, validateReleaseTrain } from "./release-policy.mjs";

const ROOT_PATH = fileURLToPath(new URL("../", import.meta.url));
const SPDX_ID = /^[A-Za-z0-9.-]+$/;

function fail(message) {
  throw new Error(message);
}

function sha(algorithm, bytes, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} is required`);
  return value;
}

function repositoryPath(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value ?? "")) {
    fail("repository must be an owner/name GitHub path");
  }
  return value;
}

function canonicalPackageIdentity(name, version) {
  if (
    typeof name !== "string" ||
    name.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)
  ) {
    fail("package name must be a canonical npm name");
  }
  isPrereleaseVersion(version);
}

function safeRelativePath(value, label) {
  const normalized = posix.normalize(requiredString(value, label).replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    fail(`${label} must stay inside the repository`);
  }
  return normalized.replace(/\/$/, "");
}

function spdxSlug(value) {
  const slug = String(value).replace(/[^A-Za-z0-9.-]+/g, ".").replace(/^\.+|\.+$/g, "");
  if (!slug || !SPDX_ID.test(slug)) fail(`cannot create SPDX identifier for ${value}`);
  return slug;
}

function purl(name, version) {
  if (name.startsWith("@")) {
    const [scope, packageName] = name.slice(1).split("/");
    if (!scope || !packageName) fail(`invalid scoped npm package ${name}`);
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function resolveLink(lock, path) {
  let current = path;
  const seen = new Set();
  while (lock.packages[current]?.link === true) {
    if (seen.has(current)) fail(`package-lock link cycle at ${path}`);
    seen.add(current);
    current = safeRelativePath(lock.packages[current].resolved, `link target for ${current}`);
  }
  return current;
}

function dependencyCandidates(parentPath, name) {
  const candidates = [`${parentPath}/node_modules/${name}`];
  let prefix = parentPath;
  while (prefix.includes("/node_modules/")) {
    prefix = prefix.slice(0, prefix.lastIndexOf("/node_modules/"));
    candidates.push(prefix ? `${prefix}/node_modules/${name}` : `node_modules/${name}`);
  }
  candidates.push(`node_modules/${name}`);
  return [...new Set(candidates.map((candidate) => posix.normalize(candidate)))];
}

function resolveDependency(lock, parentPath, name, optional) {
  for (const candidate of dependencyCandidates(parentPath, name)) {
    if (lock.packages[candidate]) return resolveLink(lock, candidate);
  }
  if (optional) return undefined;
  fail(`${parentPath} requires ${name}, but package-lock has no resolvable package`);
}

function packageIdentity(path, record) {
  const name = record.name ?? path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];
  if (typeof name !== "string" || typeof record.version !== "string") {
    fail(`package-lock entry ${path} has no stable name/version identity`);
  }
  return { name, version: record.version };
}

function integrityChecksum(integrity) {
  if (typeof integrity !== "string") return [];
  for (const token of integrity.split(/\s+/)) {
    const match = /^(sha(?:1|256|384|512))-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!match) continue;
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.toString("base64") !== match[2]) continue;
    return [{ algorithm: match[1].toUpperCase(), checksumValue: bytes.toString("hex") }];
  }
  return [];
}

function parseTarNumber(bytes, label) {
  const value = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(value)) fail(`npm tarball has an invalid ${label}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`npm tarball has an unsafe ${label}`);
  return parsed;
}

function parsePax(bytes) {
  const fields = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) fail("npm tarball contains malformed PAX metadata");
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) fail("npm tarball contains malformed PAX length");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || bytes[end - 1] !== 0x0a) {
      fail("npm tarball contains truncated PAX metadata");
    }
    const record = bytes.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) fail("npm tarball contains malformed PAX field");
    fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return fields;
}

export function inventoryPackedTarball(tarballBytes) {
  let tar;
  try {
    tar = gunzipSync(tarballBytes, { maxOutputLength: 512 * 1024 * 1024 });
  } catch {
    fail("release tarball is not a bounded canonical gzip archive");
  }
  const files = [];
  const paths = new Set();
  let offset = 0;
  let pax = {};
  let longPath;
  let endBlocks = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      endBlocks += 1;
      if (endBlocks === 2) break;
      continue;
    }
    if (endBlocks !== 0) fail("npm tarball has data after an incomplete end marker");
    const storedChecksum = parseTarNumber(header.subarray(148, 156), "header checksum");
    let calculatedChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      calculatedChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (storedChecksum !== calculatedChecksum) fail("npm tarball header checksum mismatch");
    const size = parseTarNumber(header.subarray(124, 136), "entry size");
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > tar.length) fail("npm tarball contains a truncated entry");
    const data = tar.subarray(offset, offset + size);
    offset += padded;
    const type = String.fromCharCode(header[156] || 0x30);
    const headerName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const rawPath = longPath ?? pax.path ?? (prefix ? `${prefix}/${headerName}` : headerName);
    longPath = undefined;
    pax = {};
    if (type === "x" || type === "g") {
      pax = parsePax(data);
      continue;
    }
    if (type === "L") {
      longPath = data.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (type === "5") continue;
    if (type !== "0") fail(`npm tarball contains unsupported link/special entry type ${type}`);
    if (
      typeof rawPath !== "string" ||
      !rawPath.startsWith("package/") ||
      rawPath.includes("\\") ||
      posix.normalize(rawPath) !== rawPath ||
      rawPath.includes("/../") ||
      paths.has(rawPath)
    ) {
      fail("npm tarball contains an unsafe or duplicate file path");
    }
    paths.add(rawPath);
    files.push(Object.freeze({ path: rawPath, bytes: Buffer.from(data) }));
    if (files.length > 100_000) fail("npm tarball contains too many files");
  }
  if (
    endBlocks !== 2 ||
    !tar.subarray(offset).every((byte) => byte === 0) ||
    files.length === 0
  ) {
    fail("npm tarball has no canonical two-block terminator or files");
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function packageRecord(path, record, id, root, reviewedArtifact) {
  const { name, version } = packageIdentity(path, record);
  const result = {
    name,
    SPDXID: id,
    versionInfo: version,
    packageFileName: root?.filename ?? path,
    downloadLocation:
      typeof record.resolved === "string" && /^https:\/\//.test(record.resolved)
        ? record.resolved
        : "NOASSERTION",
    filesAnalyzed: Boolean(root),
    licenseDeclared: record.license ?? root?.manifest.license ?? "NOASSERTION",
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: purl(name, version),
      },
    ],
  };
  if (root) {
    result.primaryPackagePurpose = root.manifest.bin ? "APPLICATION" : "LIBRARY";
    if (typeof root.manifest.description === "string") result.description = root.manifest.description;
    const homepage =
      typeof root.manifest.homepage === "string"
        ? root.manifest.homepage
        : typeof root.manifest.repository?.url === "string"
          ? root.manifest.repository.url
          : undefined;
    if (homepage) result.homepage = homepage;
    result.checksums = [
      { algorithm: "SHA256", checksumValue: sha("sha256", root.bytes) },
      { algorithm: "SHA512", checksumValue: sha("sha512", root.bytes) },
    ];
    result.packageVerificationCode = {
      packageVerificationCodeValue: root.verificationCode,
    };
  } else if (reviewedArtifact) {
    result.downloadLocation =
      `https://registry.npmjs.org/${encodeURIComponent(name)}/-/` +
      `${encodeURIComponent(name.split("/").at(-1))}-${version}.tgz`;
    result.checksums = integrityChecksum(reviewedArtifact.expectedIntegrity);
  } else {
    const checksums = integrityChecksum(record.integrity);
    if (checksums.length > 0) result.checksums = checksums;
  }
  return result;
}

function canonicalCreated(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) fail("created must be an ISO-compatible timestamp");
  return parsed.toISOString().replace(".000Z", "Z");
}

export function buildReleaseSbom({
  lock,
  packageDirectory,
  packageManifest,
  packageName,
  packageVersion,
  tarballFilename,
  tarballBytes,
  packIntegrity,
  packShasum,
  repository,
  sourceCommit,
  created,
  releaseTrain,
}) {
  canonicalPackageIdentity(packageName, packageVersion);
  if (lock?.lockfileVersion !== 3 || lock.packages === null || typeof lock.packages !== "object") {
    fail("release SBOM requires npm package-lock v3");
  }
  const rootPath = safeRelativePath(packageDirectory, "package directory");
  const rootRecord = lock.packages[rootPath];
  if (!rootRecord) fail(`package-lock is missing ${rootPath}`);
  const rootIdentity = packageIdentity(rootPath, rootRecord);
  if (
    rootIdentity.name !== packageName ||
    rootIdentity.version !== packageVersion ||
    packageManifest?.name !== packageName ||
    packageManifest?.version !== packageVersion
  ) {
    fail("release package identity differs across tag, manifest, and lockfile");
  }
  if (
    !(Buffer.isBuffer(tarballBytes) || tarballBytes instanceof Uint8Array) ||
    tarballBytes.length === 0 ||
    basename(tarballFilename ?? "") !== tarballFilename ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(tarballFilename)
  ) {
    fail("release tarball must be a non-empty basename .tgz file");
  }
  tarballBytes = Buffer.from(tarballBytes);
  const integrity = `sha512-${sha("sha512", tarballBytes, "base64")}`;
  if (integrity !== packIntegrity || sha("sha1", tarballBytes) !== packShasum) {
    fail("npm pack integrity/shasum do not match the release tarball bytes");
  }
  const commit = requiredString(sourceCommit, "source commit").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) fail("source commit must be a 40-character Git object ID");
  const repo = repositoryPath(repository);
  const { byId: releaseById } = validateReleaseTrain(releaseTrain);
  const firstPartyByName = new Map(
    [...releaseById.values()].map((entry) => [entry.name, entry]),
  );
  const reviewedRoot = firstPartyByName.get(packageName);
  if (
    reviewedRoot?.expectedVersion !== packageVersion ||
    reviewedRoot.expectedIntegrity !== packIntegrity
  ) {
    fail("release SBOM root differs from the immutable release-train artifact");
  }
  const packedFiles = inventoryPackedTarball(tarballBytes);
  const verificationCode = sha(
    "sha1",
    packedFiles.map(({ bytes }) => sha("sha1", bytes)).sort().join(""),
  );

  const queue = [rootPath];
  const visited = new Set();
  const edges = new Map();
  while (queue.length > 0) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    const record = lock.packages[path];
    if (!record || record.link === true) fail(`invalid canonical package-lock path ${path}`);
    packageIdentity(path, record);
    visited.add(path);
    const kinds = [
      ["dependencies", "DEPENDENCY_OF", false],
      ["optionalDependencies", "OPTIONAL_DEPENDENCY_OF", true],
      ["peerDependencies", "PREREQUISITE_FOR", false],
    ];
    for (const [field, relationshipType, optionalKind] of kinds) {
      const dependencies = record[field] ?? {};
      if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
        fail(`${path}.${field} must be an object`);
      }
      for (const name of Object.keys(dependencies).sort()) {
        const peerOptional = field === "peerDependencies" && record.peerDependenciesMeta?.[name]?.optional === true;
        const dependencyPath = resolveDependency(lock, path, name, optionalKind || peerOptional);
        if (!dependencyPath) continue;
        const key = `${dependencyPath}\0${path}\0${relationshipType}`;
        edges.set(key, { dependencyPath, parentPath: path, relationshipType });
        if (!visited.has(dependencyPath)) queue.push(dependencyPath);
      }
    }
  }

  const ids = new Map(
    [...visited].sort().map((path) => {
      const identity = packageIdentity(path, lock.packages[path]);
      return [
        path,
        `SPDXRef-Package-${spdxSlug(identity.name)}-${spdxSlug(identity.version)}-${sha("sha256", path).slice(0, 12)}`,
      ];
    }),
  );
  const rootId = ids.get(rootPath);
  const tarballSha256 = sha("sha256", tarballBytes);
  const packages = [...visited]
    .sort()
    .map((path) =>
      packageRecord(
        path,
        lock.packages[path],
        ids.get(path),
        path === rootPath
          ? {
              filename: tarballFilename,
              bytes: tarballBytes,
              manifest: packageManifest,
              verificationCode,
            }
          : undefined,
        path === rootPath
          ? undefined
          : firstPartyByName.get(packageIdentity(path, lock.packages[path]).name),
      ),
    );
  const files = packedFiles.map(({ path, bytes }) => ({
    fileName: `./${path}`,
    SPDXID: `SPDXRef-File-${sha("sha256", path).slice(0, 24)}`,
    checksums: [
      { algorithm: "SHA1", checksumValue: sha("sha1", bytes) },
      { algorithm: "SHA256", checksumValue: sha("sha256", bytes) },
    ],
    licenseConcluded: "NOASSERTION",
    copyrightText: "NOASSERTION",
  }));
  const relationships = [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relatedSpdxElement: rootId,
      relationshipType: "DESCRIBES",
    },
    ...[...edges.values()]
      .sort((left, right) =>
        `${left.parentPath}\0${left.dependencyPath}\0${left.relationshipType}`.localeCompare(
          `${right.parentPath}\0${right.dependencyPath}\0${right.relationshipType}`,
        ),
      )
      .map(({ dependencyPath, parentPath, relationshipType }) => ({
        spdxElementId: ids.get(dependencyPath),
        relatedSpdxElement: ids.get(parentPath),
        relationshipType,
      })),
    ...files.map(({ SPDXID: fileId }) => ({
      spdxElementId: rootId,
      relatedSpdxElement: fileId,
      relationshipType: "CONTAINS",
    })),
  ];
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${packageName}@${packageVersion}`,
    documentNamespace:
      `https://github.com/${repo}/sbom/${commit}/${tarballSha256}/` +
      encodeURIComponent(`${packageName}@${packageVersion}`),
    creationInfo: {
      created: canonicalCreated(created),
      creators: ["Tool: agenc-release-sbom/1"],
      comment: `Source commit ${commit}; npm tarball sha256 ${tarballSha256}`,
    },
    documentDescribes: [rootId],
    packages,
    files,
    relationships,
  };
}

export function validateReleaseSbom(
  sbom,
  { packageName, packageVersion, tarballBytes, sourceCommit },
) {
  if (
    sbom?.spdxVersion !== "SPDX-2.3" ||
    sbom.dataLicense !== "CC0-1.0" ||
    sbom.SPDXID !== "SPDXRef-DOCUMENT" ||
    sbom.name !== `${packageName}@${packageVersion}` ||
    !Array.isArray(sbom.packages) ||
    sbom.packages.length === 0 ||
    !Array.isArray(sbom.files) ||
    sbom.files.length === 0 ||
    !Array.isArray(sbom.relationships) ||
    !Array.isArray(sbom.documentDescribes) ||
    sbom.documentDescribes.length !== 1
  ) {
    fail("invalid SPDX 2.3 release document shape");
  }
  const ids = new Set();
  for (const record of sbom.packages) {
    if (
      typeof record?.SPDXID !== "string" ||
      !record.SPDXID.startsWith("SPDXRef-") ||
      ids.has(record.SPDXID) ||
      typeof record.filesAnalyzed !== "boolean" ||
      typeof record.name !== "string" ||
      typeof record.versionInfo !== "string"
    ) {
      fail("invalid or duplicate SPDX package record");
    }
    ids.add(record.SPDXID);
  }
  const root = sbom.packages.find(({ SPDXID: id }) => id === sbom.documentDescribes[0]);
  const expectedSha256 = sha("sha256", tarballBytes);
  const expectedSha512 = sha("sha512", tarballBytes);
  if (
    root?.name !== packageName ||
    root.filesAnalyzed !== true ||
    root.versionInfo !== packageVersion ||
    root.checksums?.find(({ algorithm }) => algorithm === "SHA256")?.checksumValue !== expectedSha256 ||
    root.checksums?.find(({ algorithm }) => algorithm === "SHA512")?.checksumValue !== expectedSha512 ||
    !sbom.creationInfo?.comment?.includes(sourceCommit.toLowerCase()) ||
    !sbom.documentNamespace?.includes(expectedSha256)
  ) {
    fail("release SBOM does not bind the exact package, source commit, and tarball");
  }
  const packedFiles = inventoryPackedTarball(tarballBytes);
  const expectedFiles = new Map(
    packedFiles.map(({ path, bytes }) => [`./${path}`, {
      sha1: sha("sha1", bytes),
      sha256: sha("sha256", bytes),
    }]),
  );
  const fileIds = new Set();
  for (const file of sbom.files) {
    const expected = expectedFiles.get(file?.fileName);
    if (
      !expected ||
      typeof file.SPDXID !== "string" ||
      !file.SPDXID.startsWith("SPDXRef-File-") ||
      fileIds.has(file.SPDXID) ||
      file.checksums?.find(({ algorithm }) => algorithm === "SHA1")?.checksumValue !== expected.sha1 ||
      file.checksums?.find(({ algorithm }) => algorithm === "SHA256")?.checksumValue !== expected.sha256
    ) {
      fail("release SBOM file inventory differs from the exact tarball payload");
    }
    fileIds.add(file.SPDXID);
    expectedFiles.delete(file.fileName);
  }
  const verificationCode = sha(
    "sha1",
    packedFiles.map(({ bytes }) => sha("sha1", bytes)).sort().join(""),
  );
  if (
    expectedFiles.size !== 0 ||
    root.packageVerificationCode?.packageVerificationCodeValue !== verificationCode ||
    sbom.packages.some((record) => record !== root && record.filesAnalyzed !== false)
  ) {
    fail("release SBOM package verification code or file coverage is incomplete");
  }
  for (const relationship of sbom.relationships) {
    if (
      relationship.spdxElementId !== "SPDXRef-DOCUMENT" &&
      !ids.has(relationship.spdxElementId)
    ) {
      fail("SPDX relationship has an unknown source element");
    }
    if (
      !ids.has(relationship.relatedSpdxElement) &&
      !fileIds.has(relationship.relatedSpdxElement)
    ) {
      fail("SPDX relationship has an unknown related element");
    }
    if (relationship.relationshipType === "DEV_DEPENDENCY_OF") {
      fail("release SBOM must not contain development dependencies");
    }
  }
  return true;
}

async function githubOutput(values) {
  if (!process.env.GITHUB_OUTPUT) {
    console.log(JSON.stringify(values));
    return;
  }
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => {
        const rendered = String(value);
        if (!/^[a-z_][a-z0-9_]*$/.test(key) || /[\r\n]/.test(rendered)) {
          fail("GitHub output contains an unsafe key or multiline value");
        }
        return `${key}=${rendered}\n`;
      })
      .join(""),
    { encoding: "utf8", mode: 0o600 },
  );
}

async function cli() {
  const command = process.argv[2];
  if (command !== "generate") fail("usage: release-sbom.mjs generate");
  const packageDirectory = safeRelativePath(process.env.PACKAGE_DIR, "PACKAGE_DIR");
  const packageName = requiredString(process.env.PACKAGE_NAME, "PACKAGE_NAME");
  const packageVersion = requiredString(process.env.PACKAGE_VERSION, "PACKAGE_VERSION");
  canonicalPackageIdentity(packageName, packageVersion);
  const packJson = JSON.parse(
    await readFile(requiredString(process.env.PACK_JSON, "PACK_JSON"), "utf8"),
  );
  if (!Array.isArray(packJson) || packJson.length !== 1) fail("npm pack must return one package record");
  const pack = packJson[0];
  if (pack.name !== packageName || pack.version !== packageVersion) {
    fail("npm pack record differs from the resolved release package");
  }
  if (
    basename(pack.filename ?? "") !== pack.filename ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(pack.filename)
  ) {
    fail("npm pack returned an unsafe tarball filename");
  }
  const tarballPath = resolve(ROOT_PATH, packageDirectory, pack.filename);
  const tarballBytes = await readFile(tarballPath);
  const [lock, packageManifest] = await Promise.all([
    readFile(resolve(ROOT_PATH, "package-lock.json"), "utf8").then(JSON.parse),
    readFile(resolve(ROOT_PATH, packageDirectory, "package.json"), "utf8").then(JSON.parse),
  ]);
  const releaseTrain = JSON.parse(
    await readFile(resolve(ROOT_PATH, "release-train.json"), "utf8"),
  );
  const sbom = buildReleaseSbom({
    lock,
    packageDirectory,
    packageManifest,
    packageName,
    packageVersion,
    tarballFilename: pack.filename,
    tarballBytes,
    packIntegrity: pack.integrity,
    packShasum: pack.shasum,
    repository: requiredString(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
    sourceCommit: requiredString(process.env.GITHUB_SHA, "GITHUB_SHA"),
    created: requiredString(process.env.SOURCE_COMMIT_DATE, "SOURCE_COMMIT_DATE"),
    releaseTrain,
  });
  validateReleaseSbom(sbom, {
    packageName,
    packageVersion,
    tarballBytes,
    sourceCommit: process.env.GITHUB_SHA,
  });
  const slug = packageName.replace(/^@/, "").replaceAll("/", "-");
  const name = `${slug}-${packageVersion}.spdx.json`;
  const path = resolve(requiredString(process.env.RUNNER_TEMP, "RUNNER_TEMP"), name);
  const bytes = `${JSON.stringify(sbom, null, 2)}\n`;
  await writeFile(path, bytes, { encoding: "utf8", mode: 0o600 });
  await githubOutput({ name, path, sha256: sha("sha256", bytes) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    console.error(`release SBOM failed: ${error.message}`);
    process.exitCode = 1;
  });
}
