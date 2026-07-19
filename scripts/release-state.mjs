#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareSemanticVersions,
  isPrereleaseVersion,
  planReleaseState,
} from "./release-policy.mjs";
import { verifyNpmProvenance } from "./verify-npm-provenance.mjs";

function fail(message) {
  throw new Error(message);
}

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} is required`);
  return value;
}

function canonicalPackRecord(packJson, name, version) {
  if (!Array.isArray(packJson) || packJson.length !== 1) {
    fail("npm pack must produce exactly one package record");
  }
  const record = packJson[0];
  if (
    record?.name !== name ||
    record?.version !== version ||
    typeof record.filename !== "string" ||
    basename(record.filename) !== record.filename ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(record.filename) ||
    typeof record.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.integrity) ||
    Buffer.from(record.integrity.slice(7), "base64").length !== 64 ||
    Buffer.from(record.integrity.slice(7), "base64").toString("base64") !==
      record.integrity.slice(7) ||
    typeof record.shasum !== "string" ||
    !/^[0-9a-f]{40}$/.test(record.shasum)
  ) {
    fail("npm pack record does not match the resolved package/version/integrity");
  }
  return record;
}

async function getJson(fetchFn, url, options = {}) {
  const response = await fetchFn(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers ?? {}),
    },
    signal: options.signal ?? AbortSignal.timeout(15_000),
  });
  return response;
}

export async function inspectReleaseState({
  packageName,
  packageVersion,
  distTag,
  releaseTag,
  repository,
  githubToken,
  packJson,
  requiredAsset,
  requiredAssetBytes,
  requiredAssets,
  expectedReviewedIntegrity,
  expectedSourceRef,
  expectedSourceCommit,
  verifyProvenance = verifyNpmProvenance,
  fetchFn = fetch,
}) {
  const pack = canonicalPackRecord(packJson, packageName, packageVersion);
  if (pack.integrity !== required(expectedReviewedIntegrity, "reviewed pack integrity")) {
    fail("npm pack integrity differs from the immutable release-train artifact");
  }
  const registryResponse = await getJson(
    fetchFn,
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
  );
  if (!registryResponse.ok && registryResponse.status !== 404) {
    fail(`npm registry metadata failed with HTTP ${registryResponse.status}`);
  }
  // npm returns 404 when a package has never been published. That is the valid
  // initial state for a first release; every other registry error remains fatal.
  const registry = registryResponse.status === 404
    ? { versions: {}, "dist-tags": {} }
    : await registryResponse.json();
  const published = registry?.versions?.[packageVersion];
  let npmState = "absent";
  let npmAttested = false;
  if (published) {
    npmState = published.dist?.integrity === pack.integrity ? "matching" : "mismatch";
    if (npmState === "matching") {
      if (typeof verifyProvenance !== "function") fail("verifyProvenance is required");
      await verifyProvenance({
        packageName,
        packageVersion,
        expectedIntegrity: pack.integrity,
        expectedRepository: `https://github.com/${repository}`,
        expectedWorkflow: ".github/workflows/release.yml",
        expectedRef: required(expectedSourceRef, "expected source ref"),
        expectedCommit: required(expectedSourceCommit, "expected source commit"),
      });
      npmAttested = true;
    }
  }
  const currentDistTag = registry?.["dist-tags"]?.[distTag];
  if (
    currentDistTag !== undefined &&
    currentDistTag !== packageVersion &&
    compareSemanticVersions(packageVersion, currentDistTag) <= 0
  ) {
    fail(
      `refusing to move npm ${distTag} backwards from ${currentDistTag} to ${packageVersion}`,
    );
  }
  const distTagState =
    currentDistTag === packageVersion
      ? "matching"
      : currentDistTag === undefined
        ? "absent"
        : "other";

  const releaseResponse = await getJson(
    fetchFn,
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(releaseTag)}`,
    {
      headers: {
        authorization: `Bearer ${required(githubToken, "GitHub token")}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  const assetsToCheck = requiredAssets ?? (requiredAsset
    ? [{ name: requiredAsset, bytes: requiredAssetBytes }]
    : []);
  if (
    !Array.isArray(assetsToCheck) ||
    assetsToCheck.some(
      (asset) =>
        typeof asset?.name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name) ||
        (!Buffer.isBuffer(asset.bytes) && !(asset.bytes instanceof Uint8Array)),
    ) ||
    new Set(assetsToCheck.map(({ name }) => name)).size !== assetsToCheck.length
  ) {
    fail("required release assets must have unique names and byte content");
  }
  let releaseState;
  const perAssetState = Object.fromEntries(
    assetsToCheck.map(({ name }) => [name, "absent"]),
  );
  if (releaseResponse.status === 404) {
    releaseState = "absent";
  } else {
    if (!releaseResponse.ok) {
      fail(`GitHub release lookup failed with HTTP ${releaseResponse.status}`);
    }
    const release = await releaseResponse.json();
    if (
      release.tag_name !== releaseTag ||
      release.prerelease !== isPrereleaseVersion(packageVersion)
    ) {
      fail("existing GitHub release metadata does not match the resolved tag/channel");
    }
    releaseState = release.draft ? "draft" : "public";
    for (const required of assetsToCheck) {
      const matches = (release.assets ?? []).filter(({ name }) => name === required.name);
      if (matches.length > 1) fail(`release contains duplicate ${required.name} assets`);
      if (matches.length === 1) {
        const expectedDigest = `sha256:${createHash("sha256")
          .update(required.bytes)
          .digest("hex")}`;
        const asset = matches[0];
        if (typeof asset.digest === "string") {
          perAssetState[required.name] =
            asset.digest.toLowerCase() === expectedDigest ? "matching" : "mismatch";
        } else {
          const download = await fetchFn(asset.url, {
            headers: {
              accept: "application/octet-stream",
              authorization: `Bearer ${githubToken}`,
              "x-github-api-version": "2022-11-28",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(15_000),
          });
          if (!download.ok) fail(`existing release asset download failed with HTTP ${download.status}`);
          const observedDigest = `sha256:${createHash("sha256")
            .update(Buffer.from(await download.arrayBuffer()))
            .digest("hex")}`;
          perAssetState[required.name] =
            observedDigest === expectedDigest ? "matching" : "mismatch";
        }
      }
    }
  }
  const assetStates = Object.values(perAssetState);
  const assetState =
    assetStates.length === 0
      ? "not-required"
      : assetStates.includes("mismatch")
        ? "mismatch"
        : assetStates.includes("absent")
          ? "absent"
          : "matching";
  const missingAssets = Object.entries(perAssetState)
    .filter(([, state]) => state === "absent")
    .map(([name]) => name);
  const plan = planReleaseState({
    releaseState,
    npmState,
    assetState,
    npmAttested,
    distTagState,
  });
  return Object.freeze({
    ...plan,
    releaseState,
    npmState,
    assetState,
    missingAssets,
    npmAttested,
    distTagState,
    removeStagingTag:
      registry?.["dist-tags"]?.["agenc-staging"] === packageVersion,
    packFilename: pack.filename,
    packIntegrity: pack.integrity,
  });
}

export async function verifyPublishedPackage({
  packageName,
  packageVersion,
  distTag,
  expectedIntegrity,
  requireDistTag,
  repository,
  expectedSourceRef,
  expectedSourceCommit,
  verifyProvenance = verifyNpmProvenance,
  fetchFn = fetch,
}) {
  const response = await getJson(
    fetchFn,
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
    { headers: { "cache-control": "no-cache" } },
  );
  if (!response.ok) fail(`npm registry metadata failed with HTTP ${response.status}`);
  const registry = await response.json();
  const published = registry?.versions?.[packageVersion];
  if (!published || published.dist?.integrity !== expectedIntegrity) {
    fail("published npm package is absent or has unexpected integrity");
  }
  if (typeof verifyProvenance !== "function") fail("verifyProvenance is required");
  await verifyProvenance({
    packageName,
    packageVersion,
    expectedIntegrity,
    expectedRepository: `https://github.com/${required(repository, "repository")}`,
    expectedWorkflow: ".github/workflows/release.yml",
    expectedRef: required(expectedSourceRef, "expected source ref"),
    expectedCommit: required(expectedSourceCommit, "expected source commit"),
  });
  if (requireDistTag && registry?.["dist-tags"]?.[distTag] !== packageVersion) {
    fail(`npm ${distTag} does not point to ${packageName}@${packageVersion}`);
  }
  return true;
}

export function assertFinalizationReady(state) {
  if (
    !state ||
    !["draft", "public"].includes(state.releaseState) ||
    state.npmState !== "matching" ||
    state.npmAttested !== true ||
    state.distTagState !== "matching" ||
    state.removeStagingTag !== false ||
    !["matching", "not-required"].includes(state.assetState) ||
    state.missingAssets?.length !== 0
  ) {
    fail("release state is not ready for immutable public finalization");
  }
  return true;
}

async function output(values) {
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
  const packageName = required(process.env.PACKAGE_NAME, "PACKAGE_NAME");
  const packageVersion = required(process.env.PACKAGE_VERSION, "PACKAGE_VERSION");
  const distTag = required(process.env.DIST_TAG, "DIST_TAG");
  const expectedIntegrity = process.env.PACK_INTEGRITY;
  if (command === "inspect" || command === "finalize") {
    const packJson = JSON.parse(
      await readFile(required(process.env.PACK_JSON, "PACK_JSON"), "utf8"),
    );
    const requiredAssets = [];
    for (const [nameVariable, pathVariable] of [
      ["REQUIRED_RELEASE_ASSET", "REQUIRED_RELEASE_ASSET_PATH"],
      ["SBOM_RELEASE_ASSET", "SBOM_RELEASE_ASSET_PATH"],
    ]) {
      const name = process.env[nameVariable];
      if (name) {
        requiredAssets.push({
          name,
          bytes: await readFile(required(process.env[pathVariable], pathVariable)),
        });
      }
    }
    const state = await inspectReleaseState({
      packageName,
      packageVersion,
      distTag,
      releaseTag: required(process.env.GITHUB_REF_NAME, "GITHUB_REF_NAME"),
      repository: required(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
      githubToken: required(process.env.GH_TOKEN, "GH_TOKEN"),
      packJson,
      requiredAssets,
      expectedReviewedIntegrity: required(
        process.env.EXPECTED_REVIEWED_INTEGRITY,
        "EXPECTED_REVIEWED_INTEGRITY",
      ),
      expectedSourceRef: required(process.env.GITHUB_REF, "GITHUB_REF"),
      expectedSourceCommit: required(process.env.GITHUB_SHA, "GITHUB_SHA").toLowerCase(),
    });
    if (command === "finalize") {
      assertFinalizationReady(state);
      console.log(`${packageName}@${packageVersion} is ready for public finalization`);
      return;
    }
    await output(
      Object.fromEntries(
        Object.entries(state).map(([key, value]) => [
          key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
          Array.isArray(value) ? JSON.stringify(value) : String(value),
        ]),
      ),
    );
    return;
  }
  if (command === "verify-npm") {
    await verifyPublishedPackage({
      packageName,
      packageVersion,
      distTag,
      expectedIntegrity: required(expectedIntegrity, "PACK_INTEGRITY"),
      requireDistTag: process.env.REQUIRE_DIST_TAG === "1",
      repository: required(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
      expectedSourceRef: required(process.env.GITHUB_REF, "GITHUB_REF"),
      expectedSourceCommit: required(process.env.GITHUB_SHA, "GITHUB_SHA").toLowerCase(),
    });
    console.log(`${packageName}@${packageVersion} registry integrity/provenance verified`);
    return;
  }
  fail("usage: release-state.mjs <inspect|finalize|verify-npm>");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    console.error(`release state failed: ${error.message}`);
    process.exitCode = 1;
  });
}
