import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getAddressEncoder } from "@solana/kit";
import {
  MAINNET_GENESIS,
  PROGRAM_ID,
  UPGRADEABLE_LOADER,
  assertIndependentCutoverEvidence,
  assertVerifiedBuildStatus,
  assertVerifiableBuildManifest,
  deriveProtocolConfigAddress,
  hashProgramData,
  isPrereleaseVersion,
  planReleaseState,
  readFinalizedCutoverEvidence,
  resolveReleaseTag,
  transitivePrerequisites,
  validateReleaseDependencyGraph,
  validateReleaseTrain,
  versionRangeAdmits,
  verifyReleasePrerequisites,
  verifyStableCutover,
} from "./release-policy.mjs";

const train = JSON.parse(
  await readFile(new URL("../release-train.json", import.meta.url), "utf8"),
);
const HASH = "ab".repeat(32);
const COMMIT = "12".repeat(20);

test("release train covers every workspace package and has an acyclic DAG", () => {
  validateReleaseTrain(train);
  assert.equal(train.packages.length, 9);
  assert.deepEqual(
    new Set(train.packages.map(({ directory }) => directory)),
    new Set([
      "packages/protocol",
      "packages/sdk-ts",
      "packages/marketplace-react",
      "packages/marketplace-tools",
      "packages/marketplace-mcp",
      "packages/marketplace-moderation",
      "packages/agenc-worker",
      "packages/agenc-cli",
      "packages/agenc-cli-alias",
    ]),
  );
  const cliAlias = resolveReleaseTag("cli-alias-v1.2.3", train);
  assert.equal(cliAlias.name, "agenc-cli");
  assert.equal(cliAlias.distTag, "latest");
  assert.equal(resolveReleaseTag("worker-v2.0.0-rc.1", train).distTag, "next");
  assert.throws(() => resolveReleaseTag("sdk-v1.2.3+build-7", train), /invalid semantic/);
  assert.throws(() => resolveReleaseTag("worker-v01.0.0", train), /invalid semantic/);
  assert.throws(() => resolveReleaseTag("sdk-v1.2.3-01", train), /invalid semantic/);
  assert.throws(() => resolveReleaseTag("sdk-v1.2.3-alpha.01", train), /invalid semantic/);
  assert.throws(() => isPrereleaseVersion("1.2.3+build-7"), /invalid semantic/);
  assert.deepEqual(
    transitivePrerequisites(cliAlias, train).map(({ id }) => id),
    ["protocol", "sdk", "worker", "cli"],
  );
});

test("release train metadata is exact, canonical, and repository-relative", () => {
  for (const mutation of [
    (copy) => { copy.extra = true; },
    (copy) => { copy.packages[0].extra = true; },
    (copy) => { copy.packages[0].name = "@scope/pkg\nforged=value"; },
    (copy) => { copy.packages[0].name = ""; },
    (copy) => { copy.packages[0].directory = "packages/../../tmp"; },
    (copy) => { copy.packages[0].requires = ["sdk", "sdk"]; },
    (copy) => { copy.packages[0].expectedVersion = "01.0.0"; },
    (copy) => { copy.packages[0].expectedIntegrity = "sha512-not-a-digest"; },
  ]) {
    const copy = structuredClone(train);
    mutation(copy);
    assert.throws(() => validateReleaseTrain(copy));
  }
});

test("prerequisite verification requires exact registry version, dist-tag, integrity, and provenance", async () => {
  const release = resolveReleaseTag("cli-alias-v0.3.0", train);
  const manifests = new Map(
    await Promise.all(train.packages.map(async (entry) => [
      entry.id,
      JSON.parse(await readFile(new URL(`../${entry.directory}/package.json`, import.meta.url))),
    ])),
  );
  const goodRegistry = (name) => {
    const entry = train.packages.find((item) => item.name === name);
    const manifest = manifests.get(entry.id);
    return {
      "dist-tags": { latest: manifest.version },
      versions: {
        [manifest.version]: {
          ...manifest,
          dist: {
            integrity: entry.expectedIntegrity,
          },
        },
      },
    };
  };
  const verified = [];
  assert.equal(
    (await verifyReleasePrerequisites({
      release,
      train,
      manifests,
      fetchRegistry: async (name) => goodRegistry(name),
      resolveSourceIdentity: async (entry, version) => ({
        ref: `refs/tags/${entry.tagPrefix}${version}`,
        commit: COMMIT,
      }),
      verifyProvenance: async (expectation) => { verified.push(expectation); },
    })).length,
    4,
  );
  assert.equal(verified.length, 4);
  assert.ok(verified.every(({ expectedCommit }) => expectedCommit === COMMIT));
  await assert.rejects(
    verifyReleasePrerequisites({
      release,
      train,
      manifests,
      fetchRegistry: async (name) => {
        const registry = goodRegistry(name);
        registry.versions[registry["dist-tags"].latest].dist.integrity =
          `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
        return registry;
      },
      resolveSourceIdentity: async () => assert.fail("integrity must fail first"),
      verifyProvenance: async () => assert.fail("integrity must fail first"),
    }),
    /integrity differs/,
  );
  await assert.rejects(
    verifyReleasePrerequisites({
      release,
      train,
      manifests,
      fetchRegistry: async (name) => goodRegistry(name),
      resolveSourceIdentity: async (entry, version) => ({
        ref: `refs/tags/${entry.tagPrefix}${version}`,
        commit: COMMIT,
      }),
      verifyProvenance: async () => { throw new Error("signature identity invalid"); },
    }),
    /signature identity invalid/,
  );
});

test("release DAG matches first-party manifest edges and exact prerequisite ranges", async () => {
  const manifests = new Map(
    await Promise.all(train.packages.map(async (entry) => [
      entry.id,
      JSON.parse(await readFile(new URL(`../${entry.directory}/package.json`, import.meta.url))),
    ])),
  );
  assert.equal(validateReleaseDependencyGraph(train, manifests), true);
  assert.equal(versionRangeAdmits("0.12.0", "^0.11.0 || ^0.12.0"), true);
  assert.equal(versionRangeAdmits("0.12.0", "^0.11.0"), false);

  const missingEdge = structuredClone(manifests.get("mcp"));
  delete missingEdge.dependencies["@tetsuo-ai/marketplace-tools"];
  assert.throws(
    () => validateReleaseDependencyGraph(train, new Map(manifests).set("mcp", missingEdge)),
    /missing declared first-party dependency tools/,
  );
  const wrongRange = structuredClone(manifests.get("mcp"));
  wrongRange.dependencies["@tetsuo-ai/marketplace-sdk"] = "^0.11.0";
  assert.throws(
    () => validateReleaseDependencyGraph(train, new Map(manifests).set("mcp", wrongRange)),
    /does not admit reviewed 0.12.0/,
  );
});

test("live ProgramData hashing trims allocated zero capacity and validates the loader header", () => {
  const program = Buffer.concat([
    Buffer.from([3, 0, 0, 0]),
    Buffer.alloc(41, 7),
    Buffer.from([1, 2, 3]),
    Buffer.alloc(50),
  ]);
  assert.equal(
    hashProgramData(program),
    createHash("sha256").update(program.subarray(45, 48)).digest("hex"),
  );
  assert.throws(() => hashProgramData(Buffer.alloc(45)), /invalid loader header/);
});

test("two finalized RPCs and verified-build record must bind exact revision/hash/commit", () => {
  const evidence = [1, 2].map((slot) => ({
    genesis: MAINNET_GENESIS,
    slot,
    programDataAddress: "program-data",
    executableHash: HASH,
    surfaceRevision: 5,
  }));
  assert.equal(
    assertIndependentCutoverEvidence(evidence, {
      expectedHash: HASH,
      expectedRevision: 5,
    }),
    true,
  );
  assert.throws(
    () =>
      assertIndependentCutoverEvidence(
        [{ ...evidence[0], surfaceRevision: 4 }, evidence[1]],
        { expectedHash: HASH, expectedRevision: 5 },
      ),
    /does not prove/,
  );
  assert.ok(
    assertVerifiedBuildStatus(
      [
        {
          is_verified: true,
          on_chain_hash: HASH,
          executable_hash: HASH,
          commit: COMMIT,
          repo_url: "https://github.com/tetsuo-ai/agenc-protocol.git",
        },
      ],
      { expectedHash: HASH, expectedCommit: COMMIT },
    ),
  );
  assert.throws(
    () =>
      assertVerifiedBuildStatus(
        [{ is_verified: true, on_chain_hash: HASH, executable_hash: HASH, commit: "34".repeat(20), repo_url: "https://github.com/tetsuo-ai/agenc-protocol" }],
        { expectedHash: HASH, expectedCommit: COMMIT },
      ),
    /no verified-build record/,
  );
  assert.equal(
    assertVerifiableBuildManifest(
      `# AgenC verifiable build hashes\n# Git commit: ${COMMIT}\n\n` +
        `production (default features) — candidate:\n  ${HASH}\n`,
      { expectedHash: HASH, expectedCommit: COMMIT },
    ),
    true,
  );
  assert.throws(
    () =>
      assertVerifiableBuildManifest(
        `# Git commit: ${COMMIT}\nproduction (default features):\n  ${"cd".repeat(32)}\n`,
        { expectedHash: HASH, expectedCommit: COMMIT },
      ),
    /does not bind/,
  );
});

test("stable protocol cutover executes the manifest, independent RPC, and verified-build gates", async () => {
  const release = resolveReleaseTag("protocol-v0.4.0", train);
  const environment = {
    AGENC_MAINNET_RPC_URLS_JSON: JSON.stringify([
      "https://rpc-one.example/path",
      "https://rpc-two.example/path",
    ]),
    EXPECTED_MAINNET_PROGRAM_SHA256: HASH,
    EXPECTED_VERIFIED_SOURCE_COMMIT: COMMIT,
    GITHUB_SHA: COMMIT,
    VERIFIABLE_BUILD_MANIFEST: "reviewed-hashes.txt",
    VERIFICATION_STATUS_BASE_URL: "https://verify.example",
  };
  const reads = [];
  const evidenceUrls = [];
  const result = await verifyStableCutover({
    release,
    train,
    environment,
    readFileFn: async (path, encoding) => {
      reads.push([path, encoding]);
      return `# Git commit: ${COMMIT}\nproduction (default features):\n  ${HASH}\n`;
    },
    readEvidenceFn: async ({ url }) => {
      evidenceUrls.push(url);
      return {
        genesis: MAINNET_GENESIS,
        slot: url.includes("one") ? 101 : 102,
        programDataAddress: "program-data",
        executableHash: HASH,
        surfaceRevision: train.surfaceRevision,
      };
    },
    fetchFn: async (url) => ({
      ok: url === `https://verify.example/status-all/${PROGRAM_ID}`,
      status: 200,
      async json() {
        return [{
          is_verified: true,
          on_chain_hash: HASH,
          executable_hash: HASH,
          commit: COMMIT,
          repo_url: "https://github.com/tetsuo-ai/agenc-protocol",
        }];
      },
    }),
  });
  assert.deepEqual(reads, [["reviewed-hashes.txt", "utf8"]]);
  assert.deepEqual(evidenceUrls, [
    "https://rpc-one.example/path",
    "https://rpc-two.example/path",
  ]);
  assert.deepEqual(result.finalizedSlots, [101, 102]);
  assert.equal(result.expectedHash, HASH);

  await assert.rejects(
    verifyStableCutover({
      release,
      train,
      environment: { ...environment, VERIFIABLE_BUILD_MANIFEST: "" },
      readEvidenceFn: async () => assert.fail("RPC evidence must not be read"),
      fetchFn: async () => assert.fail("verification must not be fetched"),
    }),
    /VERIFIABLE_BUILD_MANIFEST is required/,
  );

  for (const invalidUrls of [
    ["http://rpc-one.example", "https://rpc-two.example"],
    ["https://user:secret@rpc-one.example", "https://rpc-two.example"],
    ["https://rpc-one.example?api-key=secret", "https://rpc-two.example"],
    ["https://rpc-one.example#fragment", "https://rpc-two.example"],
  ]) {
    await assert.rejects(
      verifyStableCutover({
        release,
        train,
        environment: {
          ...environment,
          AGENC_MAINNET_RPC_URLS_JSON: JSON.stringify(invalidUrls),
        },
        readEvidenceFn: async () => assert.fail("invalid RPC URL must fail first"),
        fetchFn: async () => assert.fail("invalid RPC URL must fail first"),
      }),
      /credential-free canonical HTTPS URLs/,
    );
  }
});

test("RPC reader validates mainnet, program/programdata, and protocol revision from finalized responses", async () => {
  const protocolAddress = await deriveProtocolConfigAddress();
  const programDataAddress = "11111111111111111111111111111111";
  const program = Buffer.alloc(36);
  program.writeUInt32LE(2, 0);
  getAddressEncoder().encode(programDataAddress).forEach((byte, index) => {
    program[4 + index] = byte;
  });
  const executable = Buffer.from([9, 8, 7]);
  const programData = Buffer.concat([
    Buffer.from([3, 0, 0, 0]),
    Buffer.alloc(41, 1),
    executable,
    Buffer.alloc(10),
  ]);
  const protocol = Buffer.alloc(351);
  createHash("sha256").update("account:ProtocolConfig").digest().subarray(0, 8).copy(protocol);
  protocol.writeUInt16LE(5, 349);
  const account = (owner, data, executableFlag = false) => ({
    jsonrpc: "2.0",
    result: {
      context: { slot: 99 },
      value: {
        owner,
        executable: executableFlag,
        lamports: 1,
        data: [data.toString("base64"), "base64"],
      },
    },
  });
  const calls = [];
  const fetchFn = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    const result =
      request.method === "getGenesisHash"
        ? { jsonrpc: "2.0", result: MAINNET_GENESIS }
        : request.method === "getSlot"
          ? { jsonrpc: "2.0", result: 99 }
          : request.params[0] === PROGRAM_ID
            ? account(UPGRADEABLE_LOADER, program, true)
            : request.params[0] === programDataAddress
              ? account(UPGRADEABLE_LOADER, programData)
              : request.params[0] === protocolAddress
                ? account(PROGRAM_ID, protocol)
                : null;
    return { ok: true, status: 200, async json() { return result; } };
  };
  const evidence = await readFinalizedCutoverEvidence({ url: "https://rpc.example", fetchFn });
  assert.equal(evidence.surfaceRevision, 5);
  assert.equal(evidence.executableHash, createHash("sha256").update(executable).digest("hex"));
  assert.equal(calls.filter(({ method }) => method === "getAccountInfo").length, 3);
  assert.ok(
    calls
      .filter(({ method }) => method === "getAccountInfo")
      .every(({ params }) => params[1].commitment === "finalized" && params[1].minContextSlot === 99),
  );

  const staleFetch = async (url, options) => {
    const response = await fetchFn(url, options);
    const body = await response.json();
    if (JSON.parse(options.body).method === "getAccountInfo") {
      body.result.context.slot = 1;
    }
    return { ok: true, status: 200, async json() { return body; } };
  };
  await assert.rejects(
    readFinalizedCutoverEvidence({ url: "https://rpc.example", fetchFn: staleFetch }),
    /missing finalized context/,
  );
});

test("release state matrix resumes safely and rejects inconsistent public state", () => {
  assert.deepEqual(
    planReleaseState({
      releaseState: "absent",
      npmState: "absent",
      assetState: "absent",
      distTagState: "absent",
    }),
    {
      createDraft: true,
      uploadAsset: true,
      publishNpm: true,
      verifyNpm: true,
      setDistTag: true,
      publishRelease: true,
      complete: false,
    },
  );
  const resumed = planReleaseState({
    releaseState: "draft",
    npmState: "matching",
    npmAttested: true,
    assetState: "matching",
    distTagState: "absent",
  });
  assert.equal(resumed.publishNpm, false);
  assert.equal(resumed.setDistTag, true);
  assert.equal(resumed.publishRelease, true);
  assert.throws(
    () => planReleaseState({ releaseState: "public", npmState: "absent" }),
    /public GitHub release exists before npm/,
  );
  assert.throws(
    () => planReleaseState({ releaseState: "draft", npmState: "matching", npmAttested: false }),
    /lacks provenance/,
  );
  assert.throws(
    () => planReleaseState({ releaseState: "draft", npmState: "mismatch" }),
    /integrity differs/,
  );
});
