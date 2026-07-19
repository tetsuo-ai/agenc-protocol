#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  getAddressDecoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  address,
} from "@solana/kit";
import { verifyNpmProvenance } from "./verify-npm-provenance.mjs";

export const PROGRAM_ID = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const EXPECTED_VERIFICATION_REPOSITORY =
  "https://github.com/tetsuo-ai/agenc-protocol";
const NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const NON_NUMERIC_IDENTIFIER = "(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const PRERELEASE_IDENTIFIER =
  `(?:${NUMERIC_IDENTIFIER}|${NON_NUMERIC_IDENTIFIER})`;
const SEMVER = new RegExp(
  `^(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})` +
    `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?$`,
);
const SHA256 = /^[0-9a-f]{64}$/;
const ROOT = new URL("../", import.meta.url);
const execFile = promisify(execFileCallback);

function fail(message) {
  throw new Error(message);
}

function requireValue(value, label) {
  const normalized = String(value ?? "").trim();
  if (normalized.length === 0) fail(`${label} is required`);
  return normalized;
}

function requireExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys must be exactly ${wanted.join(", ")}`);
  }
}

function canonicalSha512Integrity(value, label = "integrity") {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value ?? "");
  if (!match) fail(`${label} must be one canonical sha512 SRI`);
  const digest = Buffer.from(match[1], "base64");
  if (digest.length !== 64 || digest.toString("base64") !== match[1]) {
    fail(`${label} must contain one canonical 64-byte sha512 digest`);
  }
  return value;
}

export function validateReleaseTrain(train) {
  requireExactKeys(
    train,
    ["schemaVersion", "surfaceRevision", "packages"],
    "release train",
  );
  if (
    train.schemaVersion !== 1 ||
    !Number.isSafeInteger(train.surfaceRevision) ||
    train.surfaceRevision <= 0 ||
    !Array.isArray(train.packages) ||
    train.packages.length === 0
  ) {
    fail("release train must use schemaVersion 1 and contain packages");
  }
  const byId = new Map();
  const prefixes = new Set();
  const names = new Set();
  const directories = new Set();
  for (const entry of train.packages) {
    requireExactKeys(
      entry,
      [
        "id",
        "tagPrefix",
        "name",
        "directory",
        "expectedVersion",
        "expectedIntegrity",
        "requires",
      ],
      "release train package",
    );
    if (
      !/^[a-z][a-z0-9-]*$/.test(entry.id ?? "") ||
      !/^[a-z][a-z0-9-]*-v$/.test(entry.tagPrefix ?? "") ||
      typeof entry.name !== "string" ||
      entry.name.length > 214 ||
      !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(
        entry.name,
      ) ||
      typeof entry.directory !== "string" ||
      !/^packages\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(
        entry.directory,
      ) ||
      !Array.isArray(entry.requires) ||
      entry.requires.some((id) => !/^[a-z][a-z0-9-]*$/.test(id)) ||
      new Set(entry.requires).size !== entry.requires.length
    ) {
      fail("release train contains a malformed package entry");
    }
    if (!SEMVER.test(entry.expectedVersion ?? "")) {
      fail(`release train ${entry.id} has a non-canonical expected version`);
    }
    canonicalSha512Integrity(
      entry.expectedIntegrity,
      `release train ${entry.id} expected integrity`,
    );
    if (
      byId.has(entry.id) ||
      prefixes.has(entry.tagPrefix) ||
      names.has(entry.name) ||
      directories.has(entry.directory)
    ) {
      fail(`release train contains duplicate metadata for ${entry.id}`);
    }
    byId.set(entry.id, entry);
    prefixes.add(entry.tagPrefix);
    names.add(entry.name);
    directories.add(entry.directory);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail(`release train dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    const entry = byId.get(id);
    if (!entry) fail(`release train references unknown package ${id}`);
    visiting.add(id);
    for (const required of entry.requires) visit(required);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  return { train, byId };
}

export function resolveReleaseTag(tag, train) {
  const { byId } = validateReleaseTrain(train);
  if (typeof tag !== "string") fail("release tag is required");
  const matches = [...byId.values()].filter((entry) =>
    tag.startsWith(entry.tagPrefix),
  );
  if (matches.length !== 1) fail(`unrecognized or ambiguous release tag: ${tag}`);
  const entry = matches[0];
  const version = tag.slice(entry.tagPrefix.length);
  const match = version.match(SEMVER);
  if (!match) fail(`release tag contains an invalid semantic version: ${tag}`);
  const prerelease = match[4] !== undefined;
  return Object.freeze({
    ...entry,
    version,
    prerelease,
    distTag: prerelease ? "next" : "latest",
  });
}

export function isPrereleaseVersion(version) {
  const match = String(version ?? "").match(SEMVER);
  if (!match) fail(`invalid semantic version: ${version}`);
  return match[4] !== undefined;
}

export function compareSemanticVersions(left, right) {
  const a = String(left ?? "").match(SEMVER);
  const b = String(right ?? "").match(SEMVER);
  if (!a || !b) fail("cannot compare invalid semantic versions");
  for (let index = 1; index <= 3; index += 1) {
    const aPart = BigInt(a[index]);
    const bPart = BigInt(b[index]);
    if (aPart !== bPart) return aPart < bPart ? -1 : 1;
  }
  const aPrerelease = a[4]?.split(".");
  const bPrerelease = b[4]?.split(".");
  if (!aPrerelease && !bPrerelease) return 0;
  if (!aPrerelease) return 1;
  if (!bPrerelease) return -1;
  const length = Math.max(aPrerelease.length, bPrerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (aPrerelease[index] === undefined) return -1;
    if (bPrerelease[index] === undefined) return 1;
    if (aPrerelease[index] === bPrerelease[index]) continue;
    const aNumeric = /^[0-9]+$/.test(aPrerelease[index]);
    const bNumeric = /^[0-9]+$/.test(bPrerelease[index]);
    if (aNumeric && bNumeric) {
      return BigInt(aPrerelease[index]) < BigInt(bPrerelease[index]) ? -1 : 1;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPrerelease[index] < bPrerelease[index] ? -1 : 1;
  }
  return 0;
}

export function transitivePrerequisites(release, train) {
  const { byId } = validateReleaseTrain(train);
  if (!byId.has(release.id)) fail(`unknown release package ${release.id}`);
  const result = [];
  const seen = new Set();
  function add(id) {
    if (seen.has(id)) return;
    const entry = byId.get(id);
    for (const required of entry.requires) add(required);
    seen.add(id);
    result.push(entry);
  }
  for (const required of byId.get(release.id).requires) add(required);
  return result;
}

function caretAdmits(version, base) {
  if (compareSemanticVersions(version, base) < 0) return false;
  const [major, minor, patch] = base.split("-")[0].split(".").map(BigInt);
  let upper;
  if (major > 0n) upper = `${major + 1n}.0.0`;
  else if (minor > 0n) upper = `0.${minor + 1n}.0`;
  else upper = `0.0.${patch + 1n}`;
  return compareSemanticVersions(version, upper) < 0;
}

export function versionRangeAdmits(version, range) {
  if (!SEMVER.test(version ?? "") || typeof range !== "string") return false;
  return range.split("||").some((candidate) => {
    const normalized = candidate.trim();
    if (SEMVER.test(normalized)) return normalized === version;
    if (normalized.startsWith("^") && SEMVER.test(normalized.slice(1))) {
      return caretAdmits(version, normalized.slice(1));
    }
    return false;
  });
}

export function validateReleaseDependencyGraph(train, manifests) {
  const { byId } = validateReleaseTrain(train);
  const byName = new Map([...byId.values()].map((entry) => [entry.name, entry]));
  for (const entry of byId.values()) {
    const manifest = manifests.get(entry.id);
    if (
      manifest?.name !== entry.name ||
      manifest?.version !== entry.expectedVersion
    ) {
      fail(`${entry.id} package manifest does not match its reviewed release-train identity`);
    }
    const declared = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    };
    for (const [name, range] of Object.entries(declared)) {
      const dependency = byName.get(name);
      if (!dependency) continue;
      if (!entry.requires.includes(dependency.id)) {
        fail(`${entry.id} declares untracked first-party dependency ${dependency.id}`);
      }
      if (!versionRangeAdmits(dependency.expectedVersion, range)) {
        fail(
          `${entry.id} dependency range for ${dependency.id} does not admit reviewed ${dependency.expectedVersion}`,
        );
      }
    }
    for (const requiredId of entry.requires) {
      const required = byId.get(requiredId);
      // Protocol is an ABI/release-order prerequisite, not a JavaScript runtime
      // dependency, for the SDK and moderation packages.
      if (requiredId === "protocol" && declared[required.name] === undefined) continue;
      if (declared[required.name] === undefined) {
        fail(`${entry.id} is missing declared first-party dependency ${requiredId}`);
      }
    }
  }
  return true;
}

function registryVersion(document, version, packageName, expectedIntegrity) {
  const metadata = document?.versions?.[version];
  if (!metadata || metadata.name !== packageName || metadata.version !== version) {
    fail(`${packageName}@${version} is not published exactly`);
  }
  if (metadata.dist?.integrity !== expectedIntegrity) {
    fail(`${packageName}@${version} registry integrity differs from the reviewed artifact`);
  }
  return metadata;
}

export async function verifyReleasePrerequisites({
  release,
  train,
  manifests,
  fetchRegistry,
  resolveSourceIdentity,
  verifyProvenance,
}) {
  if (typeof fetchRegistry !== "function") fail("fetchRegistry is required");
  if (typeof resolveSourceIdentity !== "function") fail("resolveSourceIdentity is required");
  if (typeof verifyProvenance !== "function") fail("verifyProvenance is required");
  validateReleaseDependencyGraph(train, manifests);
  const prerequisites = transitivePrerequisites(release, train);
  const checked = [];
  for (const entry of prerequisites) {
    const manifest = manifests.get(entry.id);
    if (
      manifest?.name !== entry.name ||
      manifest?.version !== entry.expectedVersion
    ) {
      fail(`${entry.id} package manifest is missing or inconsistent`);
    }
    const registry = await fetchRegistry(entry.name);
    registryVersion(
      registry,
      entry.expectedVersion,
      entry.name,
      entry.expectedIntegrity,
    );
    const expectedDistTag = isPrereleaseVersion(manifest.version)
      ? "next"
      : "latest";
    if (registry?.["dist-tags"]?.[expectedDistTag] !== manifest.version) {
      fail(
        `${entry.name} ${expectedDistTag} does not point to required ${manifest.version}`,
      );
    }
    const source = await resolveSourceIdentity(entry, manifest.version);
    await verifyProvenance({
      packageName: entry.name,
      packageVersion: entry.expectedVersion,
      expectedIntegrity: entry.expectedIntegrity,
      expectedRepository: EXPECTED_VERIFICATION_REPOSITORY,
      expectedWorkflow: ".github/workflows/release.yml",
      expectedRef: source.ref,
      expectedCommit: source.commit,
    });
    checked.push(`${entry.name}@${manifest.version}`);
  }
  return checked;
}

function normalizeHash(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!SHA256.test(normalized)) fail(`${label} must be 64 lowercase hexadecimal characters`);
  return normalized;
}

function decodeRpcAccount(response, label, minimumContextSlot = 0) {
  const value = response?.result?.value;
  const slot = response?.result?.context?.slot;
  if (
    !Number.isSafeInteger(slot) ||
    slot < minimumContextSlot ||
    !value
  ) {
    fail(`${label} RPC account response is missing finalized context/account data`);
  }
  if (!Array.isArray(value.data) || value.data[1] !== "base64") {
    fail(`${label} RPC account data is not canonical base64`);
  }
  const data = Buffer.from(value.data[0], "base64");
  if (data.toString("base64") !== value.data[0]) {
    fail(`${label} RPC account data is malformed base64`);
  }
  return { ...value, data, slot };
}

export async function deriveProtocolConfigAddress() {
  return (
    await getProgramDerivedAddress({
      programAddress: address(PROGRAM_ID),
      seeds: [getUtf8Encoder().encode("protocol")],
    })
  )[0];
}

export function hashProgramData(data) {
  if (!Buffer.isBuffer(data) || data.length <= 45 || data.readUInt32LE(0) !== 3) {
    fail("ProgramData account has an invalid loader header");
  }
  let end = data.length;
  while (end > 45 && data[end - 1] === 0) end -= 1;
  if (end === 45) fail("ProgramData account contains no executable bytes");
  return createHash("sha256").update(data.subarray(45, end)).digest("hex");
}

async function rpcCall(fetchFn, url, method, params) {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response?.ok) fail(`${method} failed with HTTP ${response?.status ?? "unknown"}`);
  const body = await response.json();
  if (body?.error || body?.jsonrpc !== "2.0") {
    fail(`${method} returned a malformed/error JSON-RPC response`);
  }
  return body;
}

export async function readFinalizedCutoverEvidence({ url, fetchFn = fetch }) {
  const genesis = (await rpcCall(fetchFn, url, "getGenesisHash", [])).result;
  if (genesis !== MAINNET_GENESIS) fail("RPC is not Solana mainnet-beta");
  const slot = (await rpcCall(fetchFn, url, "getSlot", [{ commitment: "finalized" }])).result;
  if (!Number.isSafeInteger(slot) || slot <= 0) fail("RPC returned an invalid finalized slot");
  const accountConfig = {
    commitment: "finalized",
    encoding: "base64",
    minContextSlot: slot,
  };
  const program = decodeRpcAccount(
    await rpcCall(fetchFn, url, "getAccountInfo", [PROGRAM_ID, accountConfig]),
    "program",
    slot,
  );
  if (
    program.owner !== UPGRADEABLE_LOADER ||
    program.executable !== true ||
    program.data.length !== 36 ||
    program.data.readUInt32LE(0) !== 2
  ) {
    fail("program account is not the expected executable upgradeable-loader Program");
  }
  const programDataAddress = getAddressDecoder().decode(program.data.subarray(4, 36));
  const programData = decodeRpcAccount(
    await rpcCall(fetchFn, url, "getAccountInfo", [programDataAddress, accountConfig]),
    "ProgramData",
    slot,
  );
  if (programData.owner !== UPGRADEABLE_LOADER || programData.executable !== false) {
    fail("ProgramData account has an unexpected owner/executable flag");
  }
  const protocolAddress = await deriveProtocolConfigAddress();
  const protocol = decodeRpcAccount(
    await rpcCall(fetchFn, url, "getAccountInfo", [protocolAddress, accountConfig]),
    "ProtocolConfig",
    slot,
  );
  const discriminator = createHash("sha256")
    .update("account:ProtocolConfig")
    .digest()
    .subarray(0, 8);
  if (
    protocol.owner !== PROGRAM_ID ||
    protocol.data.length !== 351 ||
    !protocol.data.subarray(0, 8).equals(discriminator)
  ) {
    fail("ProtocolConfig owner/layout/discriminator does not match revision-5 ABI");
  }
  return Object.freeze({
    genesis,
    slot: Math.min(program.slot, programData.slot, protocol.slot),
    programDataAddress,
    executableHash: hashProgramData(programData.data),
    surfaceRevision: protocol.data.readUInt16LE(349),
  });
}

export function assertIndependentCutoverEvidence(
  evidence,
  { expectedHash, expectedRevision },
) {
  if (!Array.isArray(evidence) || evidence.length !== 2) {
    fail("exactly two independent RPC evidence records are required");
  }
  const hash = normalizeHash(expectedHash, "expected executable hash");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
    fail("expected surface revision must be a positive integer");
  }
  for (const [index, item] of evidence.entries()) {
    if (
      item.genesis !== MAINNET_GENESIS ||
      item.executableHash !== hash ||
      item.surfaceRevision !== expectedRevision ||
      !Number.isSafeInteger(item.slot) ||
      item.slot <= 0
    ) {
      fail(`RPC ${index + 1} does not prove the expected finalized cutover`);
    }
  }
  if (evidence[0].programDataAddress !== evidence[1].programDataAddress) {
    fail("independent RPCs disagree on ProgramData address");
  }
  return true;
}

export function assertVerifiedBuildStatus(
  statuses,
  { expectedHash, expectedCommit, expectedRepository = EXPECTED_VERIFICATION_REPOSITORY },
) {
  const hash = normalizeHash(expectedHash, "expected executable hash");
  if (!/^[0-9a-f]{40}$/i.test(expectedCommit ?? "")) {
    fail("expected verified source commit must be a 40-character Git object ID");
  }
  if (!Array.isArray(statuses)) fail("verified-build status response must be an array");
  const normalizedRepository = expectedRepository.replace(/\/?(?:\.git)?$/, "");
  const match = statuses.find(
    (status) =>
      status?.is_verified === true &&
      String(status.on_chain_hash).toLowerCase() === hash &&
      String(status.executable_hash).toLowerCase() === hash &&
      String(status.commit).toLowerCase() === expectedCommit.toLowerCase() &&
      String(status.repo_url).replace(/\/?(?:\.git)?$/, "") === normalizedRepository,
  );
  if (!match) fail("no verified-build record binds the expected repo commit and live hash");
  return match;
}

export function assertVerifiableBuildManifest(
  contents,
  { expectedHash, expectedCommit },
) {
  const hash = normalizeHash(expectedHash, "expected executable hash");
  if (!/^[0-9a-f]{40}$/i.test(expectedCommit ?? "")) {
    fail("expected manifest commit must be a 40-character Git object ID");
  }
  const text = String(contents ?? "");
  const commit = text.match(/^# Git commit:\s+([0-9a-f]{40})\s*$/im)?.[1];
  const production = text.match(
    /^production \(default features\)[^\n]*:\s*\n\s+([0-9a-f]{64})\s*$/im,
  )?.[1];
  if (
    commit?.toLowerCase() !== expectedCommit.toLowerCase() ||
    production?.toLowerCase() !== hash
  ) {
    fail("verifiable-build manifest does not bind the expected source commit and production hash");
  }
  return true;
}

export async function verifyStableCutover({
  release,
  train,
  environment = process.env,
  readFileFn = readFile,
  fetchFn = fetch,
  readEvidenceFn = readFinalizedCutoverEvidence,
}) {
  if (release?.prerelease) {
    return Object.freeze({ prerelease: true });
  }
  const rpcUrls = JSON.parse(environment.AGENC_MAINNET_RPC_URLS_JSON ?? "null");
  if (!Array.isArray(rpcUrls) || rpcUrls.length !== 2) {
    fail("AGENC_MAINNET_RPC_URLS_JSON must contain exactly two distinct RPC origins");
  }
  const origins = rpcUrls.map((url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      fail("AGENC_MAINNET_RPC_URLS_JSON must contain exactly two valid RPC URLs");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      fail(
        "mainnet RPC endpoints must be credential-free canonical HTTPS URLs without query strings or fragments",
      );
    }
    return parsed.origin;
  });
  if (origins[0] === origins[1]) {
    fail("AGENC_MAINNET_RPC_URLS_JSON must contain exactly two distinct RPC origins");
  }
  const expectedHash = normalizeHash(
    environment.EXPECTED_MAINNET_PROGRAM_SHA256,
    "EXPECTED_MAINNET_PROGRAM_SHA256",
  );
  const expectedCommit = requireValue(
    environment.EXPECTED_VERIFIED_SOURCE_COMMIT,
    "EXPECTED_VERIFIED_SOURCE_COMMIT",
  );
  if (release?.id === "protocol") {
    const githubSha = requireValue(environment.GITHUB_SHA, "GITHUB_SHA");
    if (expectedCommit.toLowerCase() !== githubSha.toLowerCase()) {
      fail("protocol stable release requires verified source commit to equal GITHUB_SHA");
    }
    const manifestPath = requireValue(
      environment.VERIFIABLE_BUILD_MANIFEST,
      "VERIFIABLE_BUILD_MANIFEST",
    );
    assertVerifiableBuildManifest(await readFileFn(manifestPath, "utf8"), {
      expectedHash,
      expectedCommit,
    });
  }
  const evidence = await Promise.all(
    rpcUrls.map((url) => readEvidenceFn({ url, fetchFn })),
  );
  assertIndependentCutoverEvidence(evidence, {
    expectedHash,
    expectedRevision: train.surfaceRevision,
  });
  const verificationBase =
    environment.VERIFICATION_STATUS_BASE_URL ?? "https://verify.osec.io";
  const verificationResponse = await fetchFn(
    `${verificationBase}/status-all/${PROGRAM_ID}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
  );
  if (!verificationResponse.ok) {
    fail(`verified-build status failed: HTTP ${verificationResponse.status}`);
  }
  assertVerifiedBuildStatus(await verificationResponse.json(), {
    expectedHash,
    expectedCommit,
  });
  return Object.freeze({
    prerelease: false,
    expectedHash,
    expectedRevision: train.surfaceRevision,
    finalizedSlots: evidence.map(({ slot }) => slot),
  });
}

export function planReleaseState({
  releaseState,
  npmState,
  assetState = "not-required",
  npmAttested = false,
  distTagState = "absent",
}) {
  const allowed = {
    releaseState: ["absent", "draft", "public"],
    npmState: ["absent", "matching", "mismatch"],
    assetState: ["not-required", "absent", "matching", "mismatch"],
    distTagState: ["absent", "matching", "other"],
  };
  const states = { releaseState, npmState, assetState, distTagState };
  for (const [name, values] of Object.entries(allowed)) {
    if (!values.includes(states[name])) fail(`invalid ${name}`);
  }
  if (npmState === "mismatch") fail("published npm integrity differs from reviewed tarball");
  if (assetState === "mismatch") fail("release asset digest differs from reviewed artifact");
  if (npmState === "matching" && !npmAttested) fail("published npm artifact lacks provenance");
  if (releaseState === "public" && npmState === "absent") {
    fail("public GitHub release exists before npm publication");
  }
  if (releaseState === "public" && assetState === "absent") {
    fail("public GitHub release is missing its required immutable asset");
  }
  const publishNpm = npmState === "absent";
  return Object.freeze({
    createDraft: releaseState === "absent",
    uploadAsset: assetState === "absent" && releaseState !== "public",
    publishNpm,
    verifyNpm: true,
    setDistTag: distTagState !== "matching",
    publishRelease: releaseState !== "public",
    complete:
      releaseState === "public" &&
      npmState === "matching" &&
      npmAttested &&
      (assetState === "not-required" || assetState === "matching") &&
      distTagState === "matching",
  });
}

async function loadTrainAndManifests() {
  const train = JSON.parse(await readFile(new URL("release-train.json", ROOT), "utf8"));
  validateReleaseTrain(train);
  const manifests = new Map();
  for (const entry of train.packages) {
    manifests.set(
      entry.id,
      JSON.parse(await readFile(new URL(`${entry.directory}/package.json`, ROOT), "utf8")),
    );
  }
  validateReleaseDependencyGraph(train, manifests);
  return { train, manifests };
}

function appendGithubOutput(values) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    console.log(JSON.stringify(values));
    return;
  }
  return import("node:fs/promises").then(({ appendFile }) =>
    appendFile(
      output,
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
    ),
  );
}

async function cli() {
  const command = process.argv[2];
  const { train, manifests } = await loadTrainAndManifests();
  if (command === "resolve") {
    const release = resolveReleaseTag(process.env.GITHUB_REF_NAME, train);
    const manifest = manifests.get(release.id);
    if (manifest.name !== release.name || manifest.version !== release.version) {
      fail(
        `tag ${process.env.GITHUB_REF_NAME} does not match ${release.directory}/package.json ` +
          `(${manifest.name}@${manifest.version})`,
      );
    }
    await appendGithubOutput({
      id: release.id,
      name: release.name,
      dir: release.directory,
      version: release.version,
      prerelease: String(release.prerelease),
      dist_tag: release.distTag,
      expected_integrity: release.expectedIntegrity,
    });
    return;
  }
  if (command === "prerequisites") {
    const release = resolveReleaseTag(process.env.GITHUB_REF_NAME, train);
    const checked = await verifyReleasePrerequisites({
      release,
      train,
      manifests,
      fetchRegistry: async (packageName) => {
        const response = await fetch(
          `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
          { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
        );
        if (!response.ok) fail(`npm registry lookup failed for ${packageName}: HTTP ${response.status}`);
        return response.json();
      },
      resolveSourceIdentity: async (entry, version) => {
        const tag = `${entry.tagPrefix}${version}`;
        let stdout;
        try {
          ({ stdout } = await execFile(
            "git",
            ["rev-list", "-n", "1", `${tag}^{commit}`],
            { cwd: fileURLToPath(ROOT), encoding: "utf8" },
          ));
        } catch {
          fail(`cannot resolve reviewed source commit for prerequisite tag ${tag}`);
        }
        const commit = stdout.trim().toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(commit)) {
          fail(`prerequisite tag ${tag} does not resolve to a source commit`);
        }
        return { ref: `refs/tags/${tag}`, commit };
      },
      verifyProvenance: verifyNpmProvenance,
    });
    console.log(`verified release prerequisites: ${checked.join(", ") || "none"}`);
    return;
  }
  if (command === "cutover") {
    const release = resolveReleaseTag(process.env.GITHUB_REF_NAME, train);
    if (release.prerelease) {
      console.log("prerelease tag: stable mainnet cutover gate is not required; dist-tag remains next");
      return;
    }
    const result = await verifyStableCutover({ release, train });
    console.log(
      `stable cutover verified at revision ${result.expectedRevision}, hash ${result.expectedHash}, ` +
        `finalized slots ${result.finalizedSlots.join("/")}`,
    );
    return;
  }
  fail("usage: release-policy.mjs <resolve|prerequisites|cutover>");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    console.error(`release policy failed: ${error.message}`);
    process.exitCode = 1;
  });
}
