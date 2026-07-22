#!/usr/bin/env node
// Sync the compiled agenc-coordination program into testing-assets/ so the
// `@tetsuo-ai/marketplace-sdk/testing` local sandbox can boot litesvm — both
// from a repo checkout (vitest against src/) and from the published tarball
// (package.json `files` ships testing-assets/). Idempotent: skips the copy
// when the destination already matches the source byte-for-byte (sha256).
//
// Run from anywhere: paths are resolved relative to this script, not cwd.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertProductionSbf,
  getIdlInstructionLogNames,
} from "./sbf-profile.mjs";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.resolve(
  packageDir,
  "../../programs/agenc-coordination/target/deploy/agenc_coordination.so",
);
const destDir = path.join(packageDir, "testing-assets");
const dest = path.join(destDir, "agenc_coordination.so");
const idlPath = path.resolve(
  packageDir,
  "../../artifacts/anchor/idl/agenc_coordination.json",
);

if (!existsSync(source)) {
  console.error(
    [
      "sync-testing-so: compiled program not found at",
      `  ${source}`,
      "",
      "Build it first from the agenc-protocol repo root:",
      "  anchor build",
      "then re-run:",
      "  node scripts/sync-testing-so.mjs",
    ].join("\n"),
  );
  process.exit(1);
}

const sha256 = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

const sourceSha = sha256(source);
const idl = JSON.parse(readFileSync(idlPath, "utf8"));
const expectedInstructionNames = getIdlInstructionLogNames(idl);
assertProductionSbf(readFileSync(source), {
  expectedInstructionNames,
  sourceLabel: source,
});
mkdirSync(destDir, { recursive: true });

if (existsSync(dest) && sha256(dest) === sourceSha) {
  console.log(
    `sync-testing-so: up to date (sha256 ${sourceSha.slice(0, 16)}…) ${dest}`,
  );
} else {
  copyFileSync(source, dest);
  console.log(
    `sync-testing-so: copied (sha256 ${sourceSha.slice(0, 16)}…)\n  ${source}\n  -> ${dest}`,
  );
}
