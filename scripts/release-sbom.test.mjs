import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { buildReleaseSbom, validateReleaseSbom } from "./release-sbom.mjs";

function tarEntry(path, bytes) {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([header, bytes, Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length)]);
}

const tarballBytes = gzipSync(Buffer.concat([
  tarEntry("package/package.json", Buffer.from('{"name":"@example/released"}\n')),
  tarEntry("package/dist/native.so", Buffer.from([1, 2, 3, 4])),
  Buffer.alloc(1024),
]), { mtime: 0 });
const packIntegrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
const packShasum = createHash("sha1").update(tarballBytes).digest("hex");
const prerequisiteIntegrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const base = {
  lock: {
    lockfileVersion: 3,
    packages: {
      "": { name: "private-root", version: "1.0.0" },
      "packages/example": {
        name: "@example/released",
        version: "1.2.3",
        license: "MIT",
        dependencies: { alpha: "^2", "@example/prereq": "^1.0.0" },
        devDependencies: { devonly: "1" },
        peerDependencies: { peer: ">=3" },
      },
      "node_modules/@example/released": { link: true, resolved: "packages/example" },
      "packages/prereq": {
        name: "@example/prereq",
        version: "1.0.0",
        license: "MIT",
      },
      "node_modules/@example/prereq": { link: true, resolved: "packages/prereq" },
      "node_modules/alpha": {
        version: "2.0.0",
        license: "Apache-2.0",
        resolved: "https://registry.npmjs.org/alpha/-/alpha-2.0.0.tgz",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
        dependencies: { beta: "1" },
      },
      "node_modules/beta": { version: "1.0.0", license: "MIT" },
      "node_modules/peer": { version: "3.0.0", license: "ISC" },
      "node_modules/devonly": { version: "1.0.0", license: "MIT" },
    },
  },
  packageDirectory: "packages/example",
  packageManifest: {
    name: "@example/released",
    version: "1.2.3",
    license: "MIT",
    description: "Example package",
  },
  packageName: "@example/released",
  packageVersion: "1.2.3",
  tarballFilename: "example-released-1.2.3.tgz",
  tarballBytes,
  packIntegrity,
  packShasum,
  repository: "example/repository",
  sourceCommit: "ab".repeat(20),
  created: "2026-07-19T12:34:56-06:00",
  releaseTrain: {
    schemaVersion: 1,
    surfaceRevision: 1,
    packages: [
      {
        id: "released",
        tagPrefix: "released-v",
        name: "@example/released",
        directory: "packages/example",
        expectedVersion: "1.2.3",
        expectedIntegrity: packIntegrity,
        requires: [],
      },
      {
        id: "prereq",
        tagPrefix: "prereq-v",
        name: "@example/prereq",
        directory: "packages/prereq",
        expectedVersion: "1.0.0",
        expectedIntegrity: prerequisiteIntegrity,
        requires: [],
      },
    ],
  },
};

test("release SBOM is deterministic, runtime-complete, and binds the reviewed tarball", () => {
  const first = buildReleaseSbom(base);
  const second = buildReleaseSbom(structuredClone(base));
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.packages.map(({ name }) => name).sort(),
    ["@example/prereq", "@example/released", "alpha", "beta", "peer"],
  );
  const prerequisite = first.packages.find(({ name }) => name === "@example/prereq");
  assert.equal(prerequisite.checksums[0].checksumValue, Buffer.alloc(64, 7).toString("hex"));
  assert.equal(first.files.length, 2);
  assert.ok(first.files.some(({ fileName }) => fileName.endsWith("native.so")));
  assert.equal(
    first.packages.find(({ name }) => name === "@example/released").filesAnalyzed,
    true,
  );
  assert.ok(first.relationships.some(({ relationshipType }) => relationshipType === "PREREQUISITE_FOR"));
  assert.ok(!first.relationships.some(({ relationshipType }) => relationshipType.includes("DEV")));
  assert.equal(
    validateReleaseSbom(first, {
      packageName: base.packageName,
      packageVersion: base.packageVersion,
      tarballBytes,
      sourceCommit: base.sourceCommit,
    }),
    true,
  );
});

test("SBOM generation and validation reject identity, graph, and artifact drift", () => {
  assert.throws(
    () => buildReleaseSbom({ ...base, packShasum: "00".repeat(20) }),
    /integrity\/shasum/,
  );
  const missing = structuredClone(base);
  delete missing.lock.packages["node_modules/alpha"];
  assert.throws(() => buildReleaseSbom(missing), /requires alpha/);

  const sbom = buildReleaseSbom(base);
  sbom.packages.find(({ name }) => name === "@example/released").checksums[0].checksumValue = "00".repeat(32);
  assert.throws(
    () =>
      validateReleaseSbom(sbom, {
        packageName: base.packageName,
        packageVersion: base.packageVersion,
        tarballBytes,
        sourceCommit: base.sourceCommit,
      }),
    /does not bind/,
  );
});
