#!/usr/bin/env node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "agenc-protocol-pack-"));

try {
  const packDir = path.join(tempDir, "pack");
  await mkdir(packDir, { recursive: true });

  const packOutput = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
    {
      cwd: packageDir,
      encoding: "utf8",
    },
  );
  const packResult = JSON.parse(packOutput);
  const tarballName = packResult.at(-1)?.filename;

  if (!tarballName) {
    throw new Error("npm pack did not produce a tarball");
  }

  const tarballPath = path.join(packDir, tarballName);

  execFileSync("npm", ["init", "-y"], {
    cwd: tempDir,
    stdio: "ignore",
  });
  execFileSync("npm", ["install", tarballPath], {
    cwd: tempDir,
    stdio: "inherit",
  });

  const smokePath = path.join(tempDir, "smoke.mjs");
  await writeFile(
    smokePath,
    [
      'import {',
      "  AGENC_COORDINATION_IDL,",
      "  AGENC_PROTOCOL_MANIFEST,",
      "  VERIFIER_ROUTER_IDL,",
      "  AGENC_COORDINATION_PROGRAM_ADDRESS,",
      '} from "@tetsuo-ai/protocol";',
      'import idlJson from "@tetsuo-ai/protocol/idl/agenc_coordination.json" with { type: "json" };',
      'import manifestJson from "@tetsuo-ai/protocol/manifest.json" with { type: "json" };',
      'import verifierJson from "@tetsuo-ai/protocol/verifier-router.json" with { type: "json" };',
      "",
      'if (AGENC_COORDINATION_IDL.address !== AGENC_COORDINATION_PROGRAM_ADDRESS) {',
      '  throw new Error("IDL address mismatch");',
      "}",
      'if (AGENC_PROTOCOL_MANIFEST.program.address !== AGENC_COORDINATION_PROGRAM_ADDRESS) {',
      '  throw new Error("Manifest export mismatch");',
      "}",
      'if (idlJson.address !== AGENC_COORDINATION_IDL.address) {',
      '  throw new Error("Raw IDL export mismatch");',
      "}",
      'if (manifestJson.program.address !== AGENC_COORDINATION_PROGRAM_ADDRESS) {',
      '  throw new Error("Manifest address mismatch");',
      "}",
      'if (verifierJson.address !== VERIFIER_ROUTER_IDL.address) {',
      '  throw new Error("Verifier router export mismatch");',
      "}",
      'console.log("pack smoke ok");',
    ].join("\n"),
    "utf8",
  );

  const smokeCjsPath = path.join(tempDir, "smoke.cjs");
  await writeFile(
    smokeCjsPath,
    [
      'const {',
      "  AGENC_COORDINATION_IDL,",
      "  AGENC_PROTOCOL_MANIFEST,",
      "  VERIFIER_ROUTER_IDL,",
      "  AGENC_COORDINATION_PROGRAM_ADDRESS,",
      '} = require("@tetsuo-ai/protocol");',
      'const idlJson = require("@tetsuo-ai/protocol/idl/agenc_coordination.json");',
      'const manifestJson = require("@tetsuo-ai/protocol/manifest.json");',
      'const verifierJson = require("@tetsuo-ai/protocol/verifier-router.json");',
      "",
      'if (AGENC_COORDINATION_IDL.address !== AGENC_COORDINATION_PROGRAM_ADDRESS) {',
      '  throw new Error("CJS IDL address mismatch");',
      "}",
      'if (AGENC_PROTOCOL_MANIFEST.program.address !== AGENC_COORDINATION_PROGRAM_ADDRESS) {',
      '  throw new Error("CJS manifest export mismatch");',
      "}",
      'if (idlJson.address !== AGENC_COORDINATION_IDL.address) {',
      '  throw new Error("CJS raw IDL export mismatch");',
      "}",
      'if (manifestJson.program.address !== AGENC_COORDINATION_PROGRAM_ADDRESS) {',
      '  throw new Error("CJS manifest address mismatch");',
      "}",
      'if (verifierJson.address !== VERIFIER_ROUTER_IDL.address) {',
      '  throw new Error("CJS verifier router export mismatch");',
      "}",
      'console.log("pack smoke cjs ok");',
    ].join("\n"),
    "utf8",
  );

  execFileSync("node", [smokePath], {
    cwd: tempDir,
    stdio: "inherit",
  });
  execFileSync("node", [smokeCjsPath], {
    cwd: tempDir,
    stdio: "inherit",
  });
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
