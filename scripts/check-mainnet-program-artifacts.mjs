#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const PROGRAM_ID_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/u;

async function readText(path) {
  return readFile(path, "utf8");
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function extractDeclareId(source) {
  const match = source.match(/declare_id!\(\s*"([^"]+)"\s*\)/u);
  if (!match) throw new Error("Missing declare_id! in programs/agenc-coordination/src/lib.rs");
  return match[1];
}

function extractAnchorProgramIds(anchorToml) {
  const entries = [];
  let section = "";
  for (const rawLine of anchorToml.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[(programs\.[^\]]+)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const programMatch = line.match(/^agenc_coordination\s*=\s*"([^"]+)"$/u);
    if (programMatch && section.startsWith("programs.")) {
      entries.push({ section, programId: programMatch[1] });
    }
  }
  return entries;
}

function extractTypeAddress(source) {
  const match = source.match(/"address":\s*"([^"]+)"/u);
  if (!match) throw new Error("Missing generated type address field");
  return match[1];
}

function assertProgramId(label, value, expected) {
  if (value !== expected) {
    throw new Error(`${label} program id mismatch: expected ${expected}, got ${value}`);
  }
  if (!PROGRAM_ID_RE.test(value)) {
    throw new Error(`${label} does not look like a Solana program id: ${value}`);
  }
}

const [
  libSource,
  anchorToml,
  artifactIdlText,
  artifactTypesText,
  artifactManifestText,
  packageIdlText,
  packageTypesText,
  packageManifestText
] = await Promise.all([
  readText("programs/agenc-coordination/src/lib.rs"),
  readText("Anchor.toml"),
  readText("artifacts/anchor/idl/agenc_coordination.json"),
  readText("artifacts/anchor/types/agenc_coordination.ts"),
  readText("artifacts/anchor/manifest.json"),
  readText("packages/protocol/src/generated/agenc_coordination.json"),
  readText("packages/protocol/src/generated/agenc_coordination.ts"),
  readText("packages/protocol/src/generated/manifest.json")
]);

const expected = extractDeclareId(libSource);
assertProgramId("declare_id", expected, expected);

for (const entry of extractAnchorProgramIds(anchorToml)) {
  assertProgramId(`Anchor.toml ${entry.section}`, entry.programId, expected);
}

const artifactIdl = JSON.parse(artifactIdlText);
const artifactManifest = JSON.parse(artifactManifestText);
const packageIdl = JSON.parse(packageIdlText);
const packageManifest = JSON.parse(packageManifestText);

assertProgramId("artifacts/anchor/idl/agenc_coordination.json", artifactIdl.address, expected);
assertProgramId("artifacts/anchor/types/agenc_coordination.ts", extractTypeAddress(artifactTypesText), expected);
assertProgramId("artifacts/anchor/manifest.json", artifactManifest.program?.address, expected);
assertProgramId("packages/protocol/src/generated/agenc_coordination.json", packageIdl.address, expected);
assertProgramId(
  "packages/protocol/src/generated/agenc_coordination.ts",
  extractTypeAddress(packageTypesText),
  expected
);
assertProgramId("packages/protocol/src/generated/manifest.json", packageManifest.program?.address, expected);

const artifactIdlSha = sha256Hex(artifactIdlText);
const artifactTypesSha = sha256Hex(artifactTypesText);
if (artifactManifest.artifacts?.idl?.sha256 !== artifactIdlSha) {
  throw new Error("artifacts/anchor/manifest.json IDL sha256 is stale");
}
if (artifactManifest.artifacts?.types?.sha256 !== artifactTypesSha) {
  throw new Error("artifacts/anchor/manifest.json types sha256 is stale");
}
if (packageManifest.artifacts?.idl?.sha256 !== artifactIdlSha) {
  throw new Error("packages/protocol/src/generated/manifest.json IDL sha256 is stale");
}
if (packageManifest.artifacts?.types?.sha256 !== artifactTypesSha) {
  throw new Error("packages/protocol/src/generated/manifest.json types sha256 is stale");
}

console.log(JSON.stringify({ success: true, programId: expected }, null, 2));
