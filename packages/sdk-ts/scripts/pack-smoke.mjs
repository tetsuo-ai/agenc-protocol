#!/usr/bin/env node
// Clean-room packaging smoke test: pack the real tarball, install it in a temp
// project alongside the peer deps, and exercise the README quickstart through
// BOTH the ESM (`import`) and CJS (`require`) entry points. Guards the exports
// map against drift from tsup's output names (a broken `import` target once
// shipped unnoticed because unit tests resolve src/, not dist/).

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
  execFileSync("node", ["-p", "JSON.stringify(require('./package.json'))"], {
    cwd: packageDir,
    encoding: "utf8",
  }),
);
const peerSpecs = Object.entries(pkg.peerDependencies ?? {}).map(
  ([name, range]) => `${name}@${range}`,
);

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agenc-sdk-pack-"));

try {
  const packDir = path.join(tempDir, "pack");
  await mkdir(packDir, { recursive: true });

  const packOutput = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
    { cwd: packageDir, encoding: "utf8" },
  );
  const tarballName = JSON.parse(packOutput).at(-1)?.filename;
  if (!tarballName) {
    throw new Error("npm pack did not produce a tarball");
  }

  execFileSync("npm", ["init", "-y"], { cwd: tempDir, stdio: "ignore" });
  execFileSync("npm", ["pkg", "set", "type=module"], { cwd: tempDir, stdio: "ignore" });
  execFileSync(
    "npm",
    ["install", path.join(packDir, tarballName), ...peerSpecs],
    { cwd: tempDir, stdio: "inherit" },
  );

  const quickstart = [
    "const authority = await generateKeyPairSigner();",
    "const ix = await facade.registerAgent({",
    "  authority,",
    "  agentId: new Uint8Array(32).fill(7),",
    "  capabilities: 1n,",
    '  endpoint: "https://my-agent.example",',
    "  metadataUri: null,",
    "  stakeAmount: 0n,",
    "});",
    'if (!ix.programAddress) throw new Error("no program address");',
    'if (!ix.accounts?.length) throw new Error("no accounts");',
    'if (!ix.data?.length) throw new Error("no data");',
  ];

  const smokeMjs = path.join(tempDir, "smoke.mjs");
  await writeFile(
    smokeMjs,
    [
      'import { facade } from "@tetsuo-ai/marketplace-sdk";',
      'import { generateKeyPairSigner } from "@solana/kit";',
      ...quickstart,
      'console.log("sdk pack smoke esm ok");',
    ].join("\n"),
    "utf8",
  );

  const smokeCjs = path.join(tempDir, "smoke.cjs");
  await writeFile(
    smokeCjs,
    [
      'const { facade } = require("@tetsuo-ai/marketplace-sdk");',
      'if (typeof facade.registerAgent !== "function") {',
      '  throw new Error("CJS facade.registerAgent missing");',
      "}",
      "(async () => {",
      '  const { generateKeyPairSigner } = await import("@solana/kit");',
      ...quickstart.map((l) => `  ${l}`),
      '  console.log("sdk pack smoke cjs ok");',
      "})().catch((e) => { console.error(e); process.exit(1); });",
    ].join("\n"),
    "utf8",
  );

  execFileSync("node", [smokeMjs], { cwd: tempDir, stdio: "inherit" });
  execFileSync("node", [smokeCjs], { cwd: tempDir, stdio: "inherit" });
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
