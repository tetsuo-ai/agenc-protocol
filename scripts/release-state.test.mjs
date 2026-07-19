import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertFinalizationReady,
  inspectReleaseState,
  verifyPublishedPackage,
} from "./release-state.mjs";

const PACKAGE = "@example/reviewed";
const VERSION = "1.2.3";
const INTEGRITY = `sha512-${createHash("sha512").update("reviewed package").digest("base64")}`;
const ASSET = Buffer.from("reviewed asset");
const VERIFIED_SOURCE = {
  expectedReviewedIntegrity: INTEGRITY,
  expectedSourceRef: "refs/tags/example-v1.2.3",
  expectedSourceCommit: "12".repeat(20),
  verifyProvenance: async () => true,
};
const packJson = [{
  name: PACKAGE,
  version: VERSION,
  filename: "example-reviewed-1.2.3.tgz",
  integrity: INTEGRITY,
  shasum: "ab".repeat(20),
}];

function response(status, body, binary = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async arrayBuffer() {
      const value = Buffer.from(binary ? body : JSON.stringify(body));
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    },
  };
}

function registry({
  published = false,
  attested = true,
  tagged = false,
  currentTag,
  staging = false,
} = {}) {
  return {
    "dist-tags": {
      ...(tagged ? { latest: VERSION } : {}),
      ...(currentTag ? { latest: currentTag } : {}),
      ...(staging ? { "agenc-staging": VERSION } : {}),
    },
    versions: published
      ? {
          [VERSION]: {
            name: PACKAGE,
            version: VERSION,
            dist: {
              integrity: INTEGRITY,
              ...(attested
                ? {
                    attestations: {
                      url: "https://registry.example/attestation",
                      provenance: { predicateType: "https://slsa.dev/provenance/v1" },
                    },
                  }
                : {}),
            },
          },
        }
      : {},
  };
}

test("fresh release inspection plans draft, immutable asset, npm publish, dist-tag, and finalization", async () => {
  const state = await inspectReleaseState({
    packageName: PACKAGE,
    packageVersion: VERSION,
    distTag: "latest",
    releaseTag: "example-v1.2.3",
    repository: "example/repo",
    githubToken: "token",
    packJson,
    ...VERIFIED_SOURCE,
    requiredAsset: "hashes.txt",
    requiredAssetBytes: ASSET,
    fetchFn: async (url) =>
      url.startsWith("https://registry.npmjs.org/")
        ? response(200, registry())
        : response(404, { message: "Not Found" }),
  });
  assert.equal(state.createDraft, true);
  assert.equal(state.uploadAsset, true);
  assert.equal(state.publishNpm, true);
  assert.equal(state.publishRelease, true);
  assert.deepEqual(state.missingAssets, ["hashes.txt"]);
});

test("first-ever package registry 404 is treated as an absent publish", async () => {
  const state = await inspectReleaseState({
    packageName: PACKAGE,
    packageVersion: VERSION,
    distTag: "latest",
    releaseTag: "example-v1.2.3",
    repository: "example/repo",
    githubToken: "token",
    packJson,
    ...VERIFIED_SOURCE,
    fetchFn: async (url) =>
      url.startsWith("https://registry.npmjs.org/")
        ? response(404, { error: "Not found" })
        : response(404, { message: "Not Found" }),
  });
  assert.equal(state.npmState, "absent");
  assert.equal(state.distTagState, "absent");
  assert.equal(state.publishNpm, true);
});

test("build metadata is rejected consistently before release mutation", async () => {
  const buildVersion = "1.2.3+build-7";
  await assert.rejects(
    inspectReleaseState({
      packageName: PACKAGE,
      packageVersion: buildVersion,
      distTag: "latest",
      releaseTag: `example-v${buildVersion}`,
      repository: "example/repo",
      githubToken: "token",
      packJson: [{ ...packJson[0], version: buildVersion }],
      ...VERIFIED_SOURCE,
      fetchFn: async (url) =>
        url.startsWith("https://registry.npmjs.org/")
          ? response(200, registry())
          : response(200, {
              tag_name: `example-v${buildVersion}`,
              draft: true,
              prerelease: false,
              assets: [],
            }),
    }),
    /invalid semantic version/,
  );
});

test("rerun resumes only when npm provenance/integrity and immutable asset digest match", async () => {
  const digest = `sha256:${createHash("sha256").update(ASSET).digest("hex")}`;
  const state = await inspectReleaseState({
    packageName: PACKAGE,
    packageVersion: VERSION,
    distTag: "latest",
    releaseTag: "example-v1.2.3",
    repository: "example/repo",
    githubToken: "token",
    packJson,
    ...VERIFIED_SOURCE,
    requiredAsset: "hashes.txt",
    requiredAssetBytes: ASSET,
    fetchFn: async (url) => {
      if (url.startsWith("https://registry.npmjs.org/")) {
        return response(200, registry({ published: true, tagged: false, staging: true }));
      }
      return response(200, {
        tag_name: "example-v1.2.3",
        draft: true,
        prerelease: false,
        assets: [{ name: "hashes.txt", digest }],
      });
    },
  });
  assert.equal(state.publishNpm, false);
  assert.equal(state.uploadAsset, false);
  assert.equal(state.setDistTag, true);
  assert.equal(state.removeStagingTag, true);
  assert.equal(state.publishRelease, true);
  assert.deepEqual(state.missingAssets, []);
});

test("release inspection refuses to roll a public dist-tag backwards", async () => {
  await assert.rejects(
    inspectReleaseState({
      packageName: PACKAGE,
      packageVersion: VERSION,
      distTag: "latest",
      releaseTag: "example-v1.2.3",
      repository: "example/repo",
      githubToken: "token",
      packJson,
      ...VERIFIED_SOURCE,
      fetchFn: async (url) =>
        url.startsWith("https://registry.npmjs.org/")
          ? response(200, registry({ currentTag: "1.2.4" }))
          : response(404, {}),
    }),
    /refusing to move npm latest backwards/,
  );
});

test("release inspection rejects output-injecting pack and asset names", async () => {
  await assert.rejects(
    inspectReleaseState({
      packageName: PACKAGE,
      packageVersion: VERSION,
      distTag: "latest",
      releaseTag: "example-v1.2.3",
      repository: "example/repo",
      githubToken: "token",
      packJson: [{ ...packJson[0], filename: "safe.tgz\nforged=true" }],
      ...VERIFIED_SOURCE,
      fetchFn: async () => assert.fail("unsafe pack metadata must fail before fetch"),
    }),
    /npm pack record/,
  );
  await assert.rejects(
    inspectReleaseState({
      packageName: PACKAGE,
      packageVersion: VERSION,
      distTag: "latest",
      releaseTag: "example-v1.2.3",
      repository: "example/repo",
      githubToken: "token",
      packJson,
      ...VERIFIED_SOURCE,
      requiredAssets: [{ name: "safe.txt\nforged=true", bytes: ASSET }],
      fetchFn: async (url) =>
        url.startsWith("https://registry.npmjs.org/")
          ? response(200, registry())
          : response(404, {}),
    }),
    /release assets must have unique names/,
  );
});

test("multiple required release assets are tracked independently", async () => {
  const state = await inspectReleaseState({
    packageName: PACKAGE,
    packageVersion: VERSION,
    distTag: "latest",
    releaseTag: "example-v1.2.3",
    repository: "example/repo",
    githubToken: "token",
    packJson,
    ...VERIFIED_SOURCE,
    requiredAssets: [
      { name: "hashes.txt", bytes: ASSET },
      { name: "release.spdx.json", bytes: Buffer.from("sbom") },
    ],
    fetchFn: async (url) => {
      if (url.startsWith("https://registry.npmjs.org/")) return response(200, registry());
      return response(200, {
        tag_name: "example-v1.2.3",
        draft: true,
        prerelease: false,
        assets: [
          {
            name: "hashes.txt",
            digest: `sha256:${createHash("sha256").update(ASSET).digest("hex")}`,
          },
        ],
      });
    },
  });
  assert.deepEqual(state.missingAssets, ["release.spdx.json"]);
  assert.equal(state.uploadAsset, true);
});

test("inspection rejects missing provenance and changed public assets", async () => {
  await assert.rejects(
    inspectReleaseState({
      packageName: PACKAGE,
      packageVersion: VERSION,
      distTag: "latest",
      releaseTag: "example-v1.2.3",
      repository: "example/repo",
      githubToken: "token",
      packJson,
      ...VERIFIED_SOURCE,
      verifyProvenance: async () => { throw new Error("cryptographic provenance missing"); },
      fetchFn: async (url) =>
        url.startsWith("https://registry.npmjs.org/")
          ? response(200, registry({ published: true, attested: false }))
          : response(404, {}),
    }),
    /cryptographic provenance missing/,
  );
  await assert.rejects(
    inspectReleaseState({
      packageName: PACKAGE,
      packageVersion: VERSION,
      distTag: "latest",
      releaseTag: "example-v1.2.3",
      repository: "example/repo",
      githubToken: "token",
      packJson,
      ...VERIFIED_SOURCE,
      requiredAsset: "hashes.txt",
      requiredAssetBytes: ASSET,
      fetchFn: async (url) =>
        url.startsWith("https://registry.npmjs.org/")
          ? response(200, registry({ published: true, tagged: true }))
          : response(200, {
              tag_name: "example-v1.2.3",
              draft: false,
              prerelease: false,
              assets: [{ name: "hashes.txt", digest: `sha256:${"00".repeat(32)}` }],
            }),
    }),
    /asset digest differs/,
  );
});

test("post-publish verification requires exact integrity, provenance, and requested dist-tag", async () => {
  const fetchFn = async () => response(200, registry({ published: true, tagged: true }));
  assert.equal(
    await verifyPublishedPackage({
      packageName: PACKAGE,
      packageVersion: VERSION,
      distTag: "latest",
      expectedIntegrity: INTEGRITY,
      requireDistTag: true,
      repository: "example/repo",
      expectedSourceRef: VERIFIED_SOURCE.expectedSourceRef,
      expectedSourceCommit: VERIFIED_SOURCE.expectedSourceCommit,
      verifyProvenance: VERIFIED_SOURCE.verifyProvenance,
      fetchFn,
    }),
    true,
  );
  await assert.rejects(
    verifyPublishedPackage({
      packageName: PACKAGE,
      packageVersion: VERSION,
      distTag: "next",
      expectedIntegrity: INTEGRITY,
      requireDistTag: true,
      repository: "example/repo",
      expectedSourceRef: VERIFIED_SOURCE.expectedSourceRef,
      expectedSourceCommit: VERIFIED_SOURCE.expectedSourceCommit,
      verifyProvenance: VERIFIED_SOURCE.verifyProvenance,
      fetchFn,
    }),
    /npm next does not point/,
  );
});

test("finalization requires a public-channel package, verified provenance, immutable assets, and no staging tag", () => {
  const ready = {
    releaseState: "draft",
    npmState: "matching",
    npmAttested: true,
    distTagState: "matching",
    removeStagingTag: false,
    assetState: "matching",
    missingAssets: [],
  };
  assert.equal(assertFinalizationReady(ready), true);
  for (const mutation of [
    { releaseState: "absent" },
    { npmState: "absent" },
    { npmAttested: false },
    { distTagState: "other" },
    { removeStagingTag: true },
    { assetState: "mismatch" },
    { missingAssets: ["sbom.json"] },
  ]) {
    assert.throws(() => assertFinalizationReady({ ...ready, ...mutation }), /not ready/);
  }
});
