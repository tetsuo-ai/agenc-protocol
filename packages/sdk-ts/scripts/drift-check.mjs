// Drift gate: snapshot the generated tree, regenerate from the current IDL, and
// fail if generation changed any path or byte. Comparing with HEAD gives false
// failures in a reviewed-but-uncommitted worktree and misses the actual question:
// whether the checked tree already matches a deterministic regeneration.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
const GENERATED = path.join(PKG, "src", "generated");

async function digestTree(root) {
  const hash = createHash("sha256");
  async function walk(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`file\0${relative}\0`);
        hash.update(await readFile(absolute));
        hash.update("\0");
      } else {
        throw new Error(`Unsupported generated entry type: ${relative}`);
      }
    }
  }
  await walk(root);
  return hash.digest("hex");
}

const before = await digestTree(GENERATED);
execSync("node scripts/generate.mjs", { cwd: PKG, stdio: "inherit" });
const after = await digestTree(GENERATED);
if (before === after) {
  console.log("OK — generated client is in sync with the IDL.");
} else {
  console.error(
    "\nDRIFT: src/generated/ is stale vs the IDL. Run `npm run sdk:generate` and commit.",
  );
  process.exit(1);
}
