// Temporary release dry run (scratch branch only, never for main).
// Records the CI-built tarball, its npm integrity and the program bytes it
// was built next to, so release-train.json can be pinned from them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const packJsonPath = required("PACK_JSON");
const outDir = path.join(required("RUNNER_TEMP"), "dry-run-pack");
const workspace = required("GITHUB_WORKSPACE");

const records = JSON.parse(await readFile(packJsonPath, "utf8"));
if (!Array.isArray(records) || records.length !== 1) {
  throw new Error("npm pack must return exactly one artifact record");
}
const pack = records[0];
const tarball = path.resolve(process.cwd(), pack.filename);
const bytes = await readFile(tarball);
const sri = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
if (sri !== pack.integrity) {
  throw new Error(
    `npm pack reported ${pack.integrity}, but the tarball hashes to ${sri}`,
  );
}
const optionalSha256 = async (file) => {
  try {
    return createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  } catch {
    return null;
  }
};

const result = {
  tag: required("DRY_RUN_TAG"),
  attempt: required("DRY_RUN_ATTEMPT"),
  id: required("PACKAGE_ID"),
  name: pack.name,
  version: pack.version,
  filename: pack.filename,
  integrity: pack.integrity,
  shasum: pack.shasum,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: pack.size,
  unpackedSize: pack.unpackedSize,
  entryCount: pack.entryCount,
  sourceCommit: required("GITHUB_SHA"),
  runner: {
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    node: process.version,
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
  },
  testingProgramSha256: await optionalSha256(
    path.join(workspace, "packages/sdk-ts/testing-assets/agenc_coordination.so"),
  ),
  builtProgramSha256: await optionalSha256(
    path.join(
      workspace,
      "programs/agenc-coordination/target/deploy/agenc_coordination.so",
    ),
  ),
};

await mkdir(outDir, { recursive: true });
await copyFile(tarball, path.join(outDir, pack.filename));
await copyFile(packJsonPath, path.join(outDir, "package-pack.json"));
await writeFile(
  path.join(outDir, "integrity.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(
  `PACK ${result.name}@${result.version} ${result.integrity} ` +
    `sha256=${result.sha256} files=${result.entryCount} size=${result.size}` +
    (result.testingProgramSha256
      ? ` testing-assets .so sha256=${result.testingProgramSha256}`
      : ""),
);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `${result.tag} (${result.attempt}): \`${result.integrity}\`, ` +
      `${result.entryCount} files, ${result.size} bytes\n`,
  );
}
