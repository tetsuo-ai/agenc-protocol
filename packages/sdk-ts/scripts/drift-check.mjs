// Drift gate: regenerate the client from the current IDL and fail if it differs from
// the committed src/generated/. A non-empty diff means the program/IDL changed without
// a matching `npm run sdk:generate` — i.e. the SDK is stale vs the program.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");

execSync("node scripts/generate.mjs", { cwd: PKG, stdio: "inherit" });
try {
  execSync("git diff --exit-code -- src/generated", { cwd: PKG, stdio: "inherit" });
  console.log("OK — generated client is in sync with the IDL.");
} catch {
  console.error(
    "\nDRIFT: src/generated/ is stale vs the IDL. Run `npm run sdk:generate` and commit.",
  );
  process.exit(1);
}
