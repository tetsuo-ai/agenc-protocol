import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertFinalizationReady,
  findReleaseByTag,
  inspectReleaseState,
  verifyPublishedPackage,
} from "./release-state.mjs";

const PACKAGE = "@example/reviewed";
const VERSION = "1.2.3";
const INTEGRITY = `sha512-${createHash("sha512").update("reviewed package").digest("base64")}`;
const ASSET = Buffer.from("reviewed asset");
const SBOM = Buffer.from("sbom");
const TAG = "example-v1.2.3";
const REPOSITORY = "example/repo";
const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases`;
const BOTH_ASSETS = [
  { name: "hashes.txt", bytes: ASSET },
  { name: "release.spdx.json", bytes: SBOM },
];
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

function digestOf(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function githubRelease({
  id = 1,
  tag = TAG,
  draft = true,
  prerelease = false,
  assets = [],
} = {}) {
  return { id, tag_name: tag, draft, prerelease, assets };
}

// Serves the npm registry and GitHub's two release lookups with GitHub's real
// semantics: GET /releases/tags/{tag} returns published releases only, while
// GET /releases also lists drafts to a token with push access. `releases` and
// `registryBody` may change between calls, as they do during a release run.
function fakeFetch({
  registryBody = registry(),
  registryStatus = 200,
  releases = [],
  pages,
  listStatus = 200,
  calls = [],
} = {}) {
  return async (url) => {
    calls.push(url);
    if (url.startsWith("https://registry.npmjs.org/")) {
      return response(
        registryStatus,
        typeof registryBody === "function" ? registryBody() : registryBody,
      );
    }
    if (url.startsWith(`${RELEASES_URL}/tags/`)) {
      const tag = decodeURIComponent(url.slice(`${RELEASES_URL}/tags/`.length));
      const published = releases.find(
        (entry) => entry.tag_name === tag && entry.draft === false,
      );
      return published
        ? response(200, published)
        : response(404, { message: "Not Found" });
    }
    const listing = /^https:\/\/api\.github\.com\/repos\/example\/repo\/releases\?per_page=(\d+)&page=(\d+)$/.exec(url);
    if (listing) {
      if (listStatus !== 200) return response(listStatus, { message: "refused" });
      const perPage = Number(listing[1]);
      const page = Number(listing[2]);
      if (pages) return response(200, pages[page - 1] ?? []);
      return response(200, releases.slice((page - 1) * perPage, page * perPage));
    }
    return assert.fail(`unexpected fetch: ${url}`);
  };
}

function inspect(overrides = {}) {
  return inspectReleaseState({
    packageName: PACKAGE,
    packageVersion: VERSION,
    distTag: "latest",
    releaseTag: TAG,
    repository: REPOSITORY,
    githubToken: "token",
    packJson,
    ...VERIFIED_SOURCE,
    ...overrides,
  });
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
    fetchFn: fakeFetch(),
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
    fetchFn: fakeFetch({ registryStatus: 404, registryBody: { error: "Not found" } }),
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
      fetchFn: fakeFetch({
        releases: [githubRelease({ tag: `example-v${buildVersion}` })],
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
    fetchFn: fakeFetch({
      registryBody: registry({ published: true, tagged: false, staging: true }),
      releases: [githubRelease({ assets: [{ name: "hashes.txt", digest }] })],
    }),
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
      fetchFn: fakeFetch({ registryBody: registry({ currentTag: "1.2.4" }) }),
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
      fetchFn: async () => assert.fail("unsafe asset names must fail before fetch"),
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
    fetchFn: fakeFetch({
      releases: [
        githubRelease({ assets: [{ name: "hashes.txt", digest: digestOf(ASSET) }] }),
      ],
    }),
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
      fetchFn: fakeFetch({ registryBody: registry({ published: true, attested: false }) }),
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
      fetchFn: fakeFetch({
        registryBody: registry({ published: true, tagged: true }),
        releases: [
          githubRelease({
            draft: false,
            assets: [{ name: "hashes.txt", digest: `sha256:${"00".repeat(32)}` }],
          }),
        ],
      }),
    }),
    /asset digest differs/,
  );
});

test("a draft left by an earlier attempt is resumed instead of recreated", async () => {
  // An earlier attempt created the draft and attached both assets, then failed
  // at npm publish. GitHub's by-tag endpoint cannot see that draft.
  const calls = [];
  const fetchFn = fakeFetch({
    calls,
    releases: [
      githubRelease({ id: 9, assets: [
        { name: "hashes.txt", digest: digestOf(ASSET) },
        { name: "release.spdx.json", digest: digestOf(SBOM) },
      ] }),
      githubRelease({ id: 7, tag: "example-v1.2.2", draft: false }),
    ],
  });
  assert.equal((await fetchFn(`${RELEASES_URL}/tags/${TAG}`)).status, 404);
  const state = await inspect({ requiredAssets: BOTH_ASSETS, fetchFn });
  assert.equal(state.releaseState, "draft");
  assert.equal(state.createDraft, false);
  assert.equal(state.uploadAsset, false);
  assert.deepEqual(state.missingAssets, []);
  assert.equal(state.publishNpm, true);
  assert.equal(state.setDistTag, true);
  assert.equal(state.publishRelease, true);
  assert.ok(calls.includes(`${RELEASES_URL}?per_page=100&page=1`));

  // An attempt that failed between the two uploads leaves a partial draft.
  const partial = await inspect({
    requiredAssets: BOTH_ASSETS,
    fetchFn: fakeFetch({
      releases: [
        githubRelease({ assets: [{ name: "hashes.txt", digest: digestOf(ASSET) }] }),
      ],
    }),
  });
  assert.equal(partial.releaseState, "draft");
  assert.equal(partial.createDraft, false);
  assert.equal(partial.uploadAsset, true);
  assert.deepEqual(partial.missingAssets, ["release.spdx.json"]);
});

test("the reinspection before finalization sees the draft created earlier in the same run", async () => {
  const releases = [];
  let npm = registry();
  const fetchFn = fakeFetch({ releases, registryBody: () => npm });
  const before = await inspect({ requiredAssets: BOTH_ASSETS, fetchFn });
  assert.equal(before.releaseState, "absent");
  assert.equal(before.createDraft, true);
  assert.equal(before.publishRelease, true);

  // The run creates the draft, attaches both assets, publishes npm, points
  // latest at the version, and removes agenc-staging.
  releases.push(
    githubRelease({ id: 11, assets: [
      { name: "hashes.txt", digest: digestOf(ASSET) },
      { name: "release.spdx.json", digest: digestOf(SBOM) },
    ] }),
  );
  npm = registry({ published: true, tagged: true });
  assert.equal((await fetchFn(`${RELEASES_URL}/tags/${TAG}`)).status, 404);

  const after = await inspect({ requiredAssets: BOTH_ASSETS, fetchFn });
  assert.equal(after.releaseState, "draft");
  assert.equal(after.createDraft, false);
  assert.equal(after.removeStagingTag, false);
  assert.equal(after.complete, false);
  assert.equal(assertFinalizationReady(after), true);
});

test("a published release is found through the listing", async () => {
  const state = await inspect({
    requiredAssets: BOTH_ASSETS,
    fetchFn: fakeFetch({
      registryBody: registry({ published: true, tagged: true }),
      releases: [
        githubRelease({ draft: false, assets: [
          { name: "hashes.txt", digest: digestOf(ASSET) },
          { name: "release.spdx.json", digest: digestOf(SBOM) },
        ] }),
      ],
    }),
  });
  assert.equal(state.releaseState, "public");
  assert.equal(state.createDraft, false);
  assert.equal(state.publishRelease, false);
  assert.equal(state.complete, true);
});

test("the release listing follows pages and counts a release seen twice once", async () => {
  const others = Array.from({ length: 100 }, (_, index) =>
    githubRelease({ id: 1000 + index, tag: `other-v0.0.${index}`, draft: false }),
  );
  const draft = githubRelease({ id: 42 });
  const calls = [];
  const lookup = (fetchFn) =>
    findReleaseByTag({
      repository: REPOSITORY,
      releaseTag: TAG,
      githubToken: "token",
      fetchFn,
    });
  const found = await lookup(fakeFetch({ calls, pages: [others, [draft]] }));
  assert.equal(found.id, 42);
  assert.deepEqual(calls, [
    `${RELEASES_URL}?per_page=100&page=1`,
    `${RELEASES_URL}?per_page=100&page=2`,
  ]);
  // A release created while the pages are read pushes the draft from the end
  // of page 1 to the start of page 2.
  const shifted = await lookup(
    fakeFetch({ pages: [[...others.slice(0, 99), draft], [draft, others[99]]] }),
  );
  assert.equal(shifted.id, 42);
  assert.equal(await lookup(fakeFetch({ pages: [others] })), null);
});

test("ambiguous or unreadable release listings fail closed", async () => {
  await assert.rejects(
    inspect({
      fetchFn: fakeFetch({ releases: [githubRelease({ id: 1 }), githubRelease({ id: 2 })] }),
    }),
    /2 GitHub releases claim tag example-v1\.2\.3/,
  );
  await assert.rejects(
    inspect({ fetchFn: fakeFetch({ listStatus: 403 }) }),
    /GitHub release listing failed with HTTP 403/,
  );
  await assert.rejects(
    inspect({ fetchFn: fakeFetch({ pages: [{ message: "not a list" }] }) }),
    /GitHub release listing is not an array/,
  );
  await assert.rejects(
    inspect({
      fetchFn: fakeFetch({
        pages: [[{ tag_name: TAG, draft: true, prerelease: false, assets: [] }]],
      }),
    }),
    /release without a numeric id/,
  );
  await assert.rejects(
    inspect({
      fetchFn: fakeFetch({
        releases: [{ id: 3, tag_name: TAG, prerelease: false, assets: [] }],
      }),
    }),
    /does not state whether it is a draft/,
  );
  const full = Array.from({ length: 100 }, (_, index) =>
    githubRelease({ id: 1 + index, tag: `other-v0.0.${index}`, draft: false }),
  );
  await assert.rejects(
    inspect({ fetchFn: fakeFetch({ pages: Array.from({ length: 50 }, () => full) }) }),
    /GitHub release listing exceeded 50 pages/,
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
