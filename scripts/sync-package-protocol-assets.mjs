#!/usr/bin/env node

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = [
  {
    source: path.join(root, "artifacts", "anchor", "idl", "agenc_coordination.json"),
    dest: path.join(
      root,
      "packages",
      "protocol",
      "src",
      "generated",
      "agenc_coordination.json",
    ),
  },
  {
    source: path.join(root, "artifacts", "anchor", "types", "agenc_coordination.ts"),
    dest: path.join(
      root,
      "packages",
      "protocol",
      "src",
      "generated",
      "agenc_coordination.ts",
    ),
  },
  {
    source: path.join(root, "artifacts", "anchor", "manifest.json"),
    dest: path.join(root, "packages", "protocol", "src", "generated", "manifest.json"),
  },
  {
    source: path.join(root, "scripts", "idl", "verifier_router.json"),
    dest: path.join(
      root,
      "packages",
      "protocol",
      "src",
      "generated",
      "verifier_router.json",
    ),
  },
];

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function syncFile(source, dest, checkOnly) {
  if (!(await exists(source))) {
    throw new Error(`Missing canonical protocol artifact: ${path.relative(root, source)}`);
  }

  let sourceContent = await readFile(source, "utf8");
  if (source.endsWith(path.join("artifacts", "anchor", "types", "agenc_coordination.ts"))) {
    sourceContent = sourceContent.replace(
      "`target/idl/agenc_coordination.json`",
      "`@tetsuo-ai/protocol/idl/agenc_coordination.json`",
    );
  }
  const destExists = await exists(dest);
  const destContent = destExists ? await readFile(dest, "utf8") : null;

  if (checkOnly) {
    if (!destExists) {
      throw new Error(
        `Package-generated artifact missing: ${path.relative(root, dest)}. Run "npm run sync:artifacts".`,
      );
    }

    if (destContent !== sourceContent) {
      throw new Error(
        `Package-generated artifact is stale: ${path.relative(root, dest)}. Run "npm run sync:artifacts".`,
      );
    }
    return;
  }

  await mkdir(path.dirname(dest), { recursive: true });
  if (destContent !== sourceContent) {
    await writeFile(dest, sourceContent, "utf8");
  }
}

async function main() {
  const checkOnly = process.argv.includes("--check");

  for (const entry of sourceFiles) {
    await syncFile(entry.source, entry.dest, checkOnly);
  }

  process.stdout.write(
    checkOnly
      ? "Package-generated protocol artifacts match canonical sources.\n"
      : "Package-generated protocol artifacts refreshed.\n",
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
