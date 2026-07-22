import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  recordReleaseGateCompletion,
  resolveReleaseTag,
  transitivePrerequisites,
  validateReleaseDependencyGraph,
  validateReleaseTrain,
  validateReleaseWorkflowGateIds,
  validateReleaseWorkspaceCoverage,
  versionRangeAdmits,
  verifyReleaseGateCompletion,
  verifyReleasePrerequisites,
  verifyStableCutover,
} from "./release-policy.mjs";

const train = JSON.parse(
  await readFile(new URL("../release-train.json", import.meta.url), "utf8"),
);
const rootManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const workspaceManifests = new Map(
  await Promise.all(
    rootManifest.workspaces.map(async (directory) => [
      directory,
      JSON.parse(
        await readFile(
          new URL(`../${directory}/package.json`, import.meta.url),
        ),
      ),
    ]),
  ),
);
const HASH = "ab".repeat(32);
const COMMIT = "12".repeat(20);

test("release train covers every workspace package and has an acyclic DAG", () => {
  validateReleaseTrain(train);
  assert.equal(
    validateReleaseWorkspaceCoverage(train, rootManifest, workspaceManifests),
    true,
  );
  const cliAlias = resolveReleaseTag("cli-alias-v1.2.3", train);
  assert.equal(cliAlias.name, "agenc-cli");
  assert.equal(cliAlias.distTag, "latest");
  assert.equal(resolveReleaseTag("worker-v2.0.0-rc.1", train).distTag, "next");
  assert.throws(
    () => resolveReleaseTag("sdk-v1.2.3+build-7", train),
    /invalid semantic/,
  );
  assert.throws(
    () => resolveReleaseTag("worker-v01.0.0", train),
    /invalid semantic/,
  );
  assert.throws(
    () => resolveReleaseTag("sdk-v1.2.3-01", train),
    /invalid semantic/,
  );
  assert.throws(
    () => resolveReleaseTag("sdk-v1.2.3-alpha.01", train),
    /invalid semantic/,
  );
  assert.throws(() => isPrereleaseVersion("1.2.3+build-7"), /invalid semantic/);
  assert.deepEqual(
    transitivePrerequisites(cliAlias, train).map(({ id }) => id),
    ["protocol", "sdk", "worker", "cli"],
  );
});

test("release gate completion is exact, single-use, and bound to the resolved package", async () => {
  const gates = train.packages.map(({ id, name, directory }) => ({
    id,
    name,
    directory,
  }));
  const ids = gates.map(({ id }) => id);
  assert.equal(validateReleaseWorkflowGateIds(train, ids), true);
  assert.throws(
    () => validateReleaseWorkflowGateIds(train, ids.slice(1)),
    /routed gate ids must exactly cover the release train/,
  );
  assert.throws(
    () => validateReleaseWorkflowGateIds(train, [...ids, ids[0]]),
    /routed gate ids must exactly cover the release train/,
  );

  const release = resolveReleaseTag("sdk-v0.12.0", train);
  const runnerTemp = await mkdtemp(join(tmpdir(), "agenc-release-gate-"));
  const tamperedTemp = await mkdtemp(
    join(tmpdir(), "agenc-release-gate-tampered-"),
  );
  try {
    await assert.rejects(
      verifyReleaseGateCompletion({ release, train, gates, runnerTemp }),
      /proof is missing or unreadable/,
    );
    await assert.rejects(
      recordReleaseGateCompletion({
        release,
        train,
        gates,
        gateId: "tools",
        runnerTemp,
      }),
      /cannot complete resolved package sdk/,
    );
    assert.equal(
      await recordReleaseGateCompletion({
        release,
        train,
        gates,
        gateId: "sdk",
        runnerTemp,
      }),
      true,
    );
    assert.equal(
      await verifyReleaseGateCompletion({
        release,
        train,
        gates,
        runnerTemp,
      }),
      true,
    );
    await assert.rejects(
      recordReleaseGateCompletion({
        release,
        train,
        gates,
        gateId: "sdk",
        runnerTemp,
      }),
      /proof must be created exactly once/,
    );

    await recordReleaseGateCompletion({
      release,
      train,
      gates,
      gateId: "sdk",
      runnerTemp: tamperedTemp,
    });
    const proofPath = join(tamperedTemp, "agenc-release-gate-proof-v1.json");
    const tampered = JSON.parse(await readFile(proofPath, "utf8"));
    tampered.id = "tools";
    await writeFile(proofPath, `${JSON.stringify(tampered)}\n`, "utf8");
    await assert.rejects(
      verifyReleaseGateCompletion({
        release,
        train,
        gates,
        runnerTemp: tamperedTemp,
      }),
      /proof does not match the resolved package/,
    );
  } finally {
    await Promise.all([
      rm(runnerTemp, { recursive: true, force: true }),
      rm(tamperedTemp, { recursive: true, force: true }),
    ]);
  }
});

test("release train fails closed when a publishable root workspace is untracked", () => {
  const directory = "packages/new-marketplace-surface";
  const expandedRoot = structuredClone(rootManifest);
  expandedRoot.workspaces.push(directory);
  const expandedManifests = new Map(workspaceManifests).set(directory, {
    name: "@tetsuo-ai/new-marketplace-surface",
    version: "0.1.0",
  });
  assert.throws(
    () =>
      validateReleaseWorkspaceCoverage(train, expandedRoot, expandedManifests),
    /exactly cover publishable root workspaces/,
  );

  expandedManifests.set(directory, {
    name: "@tetsuo-ai/private-marketplace-fixture",
    private: true,
    version: "0.0.0",
  });
  assert.equal(
    validateReleaseWorkspaceCoverage(train, expandedRoot, expandedManifests),
    true,
  );
});

test("release train metadata is exact, canonical, and repository-relative", () => {
  for (const mutation of [
    (copy) => {
      copy.extra = true;
    },
    (copy) => {
      copy.packages[0].extra = true;
    },
    (copy) => {
      copy.packages[0].name = "@scope/pkg\nforged=value";
    },
    (copy) => {
      copy.packages[0].name = "";
    },
    (copy) => {
      copy.packages[0].directory = "packages/../../tmp";
    },
    (copy) => {
      copy.packages[0].requires = ["sdk", "sdk"];
    },
    (copy) => {
      copy.packages[0].expectedVersion = "01.0.0";
    },
    (copy) => {
      copy.packages[0].expectedIntegrity = "sha512-not-a-digest";
    },
  ]) {
    const copy = structuredClone(train);
    mutation(copy);
    assert.throws(() => validateReleaseTrain(copy));
  }
});

test("prerequisite verification requires exact registry version, dist-tag, integrity, and provenance", async () => {
  const release = resolveReleaseTag("cli-alias-v0.3.0", train);
  const manifests = new Map(
    await Promise.all(
      train.packages.map(async (entry) => [
        entry.id,
        JSON.parse(
          await readFile(
            new URL(`../${entry.directory}/package.json`, import.meta.url),
          ),
        ),
      ]),
    ),
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
    (
      await verifyReleasePrerequisites({
        release,
        train,
        manifests,
        fetchRegistry: async (name) => goodRegistry(name),
        resolveSourceIdentity: async (entry, version) => ({
          ref: `refs/tags/${entry.tagPrefix}${version}`,
          commit: COMMIT,
        }),
        verifyProvenance: async (expectation) => {
          verified.push(expectation);
        },
      })
    ).length,
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
      resolveSourceIdentity: async () =>
        assert.fail("integrity must fail first"),
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
      verifyProvenance: async () => {
        throw new Error("signature identity invalid");
      },
    }),
    /signature identity invalid/,
  );
});

test("release DAG matches first-party manifest edges and exact prerequisite ranges", async () => {
  const manifests = new Map(
    await Promise.all(
      train.packages.map(async (entry) => [
        entry.id,
        JSON.parse(
          await readFile(
            new URL(`../${entry.directory}/package.json`, import.meta.url),
          ),
        ),
      ]),
    ),
  );
  assert.equal(validateReleaseDependencyGraph(train, manifests), true);
  assert.equal(versionRangeAdmits("0.12.0", "^0.11.0 || ^0.12.0"), true);
  assert.equal(versionRangeAdmits("0.12.0", "^0.11.0"), false);

  const missingEdge = structuredClone(manifests.get("mcp"));
  delete missingEdge.dependencies["@tetsuo-ai/marketplace-tools"];
  assert.throws(
    () =>
      validateReleaseDependencyGraph(
        train,
        new Map(manifests).set("mcp", missingEdge),
      ),
    /missing declared first-party dependency tools/,
  );
  const wrongRange = structuredClone(manifests.get("mcp"));
  wrongRange.dependencies["@tetsuo-ai/marketplace-sdk"] = "^0.11.0";
  assert.throws(
    () =>
      validateReleaseDependencyGraph(
        train,
        new Map(manifests).set("mcp", wrongRange),
      ),
    /does not admit reviewed 0.12.0/,
  );

  for (const shadowingSection of ["optionalDependencies", "peerDependencies"]) {
    const shadowedWrongRange = structuredClone(manifests.get("mcp"));
    shadowedWrongRange.dependencies["@tetsuo-ai/marketplace-sdk"] = "^0.11.0";
    shadowedWrongRange[shadowingSection] = {
      ...(shadowedWrongRange[shadowingSection] ?? {}),
      "@tetsuo-ai/marketplace-sdk": "^0.12.0",
    };
    assert.throws(
      () =>
        validateReleaseDependencyGraph(
          train,
          new Map(manifests).set("mcp", shadowedWrongRange),
        ),
      /does not admit reviewed 0.12.0/,
    );
  }

  const contradictoryRanges = structuredClone(manifests.get("mcp"));
  contradictoryRanges.peerDependencies["@tetsuo-ai/marketplace-sdk"] = "0.12.0";
  assert.throws(
    () =>
      validateReleaseDependencyGraph(
        train,
        new Map(manifests).set("mcp", contradictoryRanges),
      ),
    /contradictory dependencies\/peerDependencies ranges.*sdk/,
  );

  const matchingDuplicate = structuredClone(manifests.get("mcp"));
  matchingDuplicate.peerDependencies["@tetsuo-ai/marketplace-sdk"] = "^0.12.0";
  assert.equal(
    validateReleaseDependencyGraph(
      train,
      new Map(manifests).set("mcp", matchingDuplicate),
    ),
    true,
  );

  for (const malformedSection of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const malformed = structuredClone(manifests.get("moderation"));
    malformed[malformedSection] = [];
    assert.throws(
      () =>
        validateReleaseDependencyGraph(
          train,
          new Map(manifests).set("moderation", malformed),
        ),
      new RegExp(`${malformedSection} must be a package-name-to-spec object`),
    );
  }

  for (const sectionName of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const hiddenAlias = structuredClone(manifests.get("moderation"));
    hiddenAlias[sectionName] = {
      ...(hiddenAlias[sectionName] ?? {}),
      "hidden-sdk": "npm:@tetsuo-ai/marketplace-sdk@^0.12.0",
    };
    assert.throws(
      () =>
        validateReleaseDependencyGraph(
          train,
          new Map(manifests).set("moderation", hiddenAlias),
        ),
      new RegExp(
        `${sectionName} hidden-sdk aliases first-party dependency sdk`,
      ),
    );
  }

  const unscopedAlias = structuredClone(manifests.get("moderation"));
  unscopedAlias.dependencies = {
    "hidden-cli": "npm:agenc-cli@^0.3.0",
  };
  assert.throws(
    () =>
      validateReleaseDependencyGraph(
        train,
        new Map(manifests).set("moderation", unscopedAlias),
      ),
    /aliases first-party dependency cli-alias/,
  );

  const normalizedAlias = structuredClone(manifests.get("moderation"));
  normalizedAlias.dependencies = {
    "hidden-sdk": "NpM:@TETSUO-AI/MARKETPLACE-SDK@^0.12.0",
  };
  assert.throws(
    () =>
      validateReleaseDependencyGraph(
        train,
        new Map(manifests).set("moderation", normalizedAlias),
      ),
    /aliases first-party dependency sdk/,
  );

  const externalAlias = structuredClone(manifests.get("moderation"));
  externalAlias.dependencies = { semver7: "npm:semver@^7.7.0" };
  assert.equal(
    validateReleaseDependencyGraph(
      train,
      new Map(manifests).set("moderation", externalAlias),
    ),
    true,
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
  assert.throws(
    () => hashProgramData(Buffer.alloc(45)),
    /invalid loader header/,
  );
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
        [
          {
            is_verified: true,
            on_chain_hash: HASH,
            executable_hash: HASH,
            commit: "34".repeat(20),
            repo_url: "https://github.com/tetsuo-ai/agenc-protocol",
          },
        ],
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
        return [
          {
            is_verified: true,
            on_chain_hash: HASH,
            executable_hash: HASH,
            commit: COMMIT,
            repo_url: "https://github.com/tetsuo-ai/agenc-protocol",
          },
        ];
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
        readEvidenceFn: async () =>
          assert.fail("invalid RPC URL must fail first"),
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
  getAddressEncoder()
    .encode(programDataAddress)
    .forEach((byte, index) => {
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
  createHash("sha256")
    .update("account:ProtocolConfig")
    .digest()
    .subarray(0, 8)
    .copy(protocol);
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
    return {
      ok: true,
      status: 200,
      async json() {
        return result;
      },
    };
  };
  const evidence = await readFinalizedCutoverEvidence({
    url: "https://rpc.example",
    fetchFn,
  });
  assert.equal(evidence.surfaceRevision, 5);
  assert.equal(
    evidence.executableHash,
    createHash("sha256").update(executable).digest("hex"),
  );
  assert.equal(
    calls.filter(({ method }) => method === "getAccountInfo").length,
    3,
  );
  assert.ok(
    calls
      .filter(({ method }) => method === "getAccountInfo")
      .every(
        ({ params }) =>
          params[1].commitment === "finalized" &&
          params[1].minContextSlot === 99,
      ),
  );

  const staleFetch = async (url, options) => {
    const response = await fetchFn(url, options);
    const body = await response.json();
    if (JSON.parse(options.body).method === "getAccountInfo") {
      body.result.context.slot = 1;
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return body;
      },
    };
  };
  await assert.rejects(
    readFinalizedCutoverEvidence({
      url: "https://rpc.example",
      fetchFn: staleFetch,
    }),
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
    () =>
      planReleaseState({
        releaseState: "draft",
        npmState: "matching",
        npmAttested: false,
      }),
    /lacks provenance/,
  );
  assert.throws(
    () => planReleaseState({ releaseState: "draft", npmState: "mismatch" }),
    /integrity differs/,
  );
});
