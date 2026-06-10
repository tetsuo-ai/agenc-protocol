// NODE-ONLY (see ./index.ts module doc): resolves the packaged compiled
// program (.so) on disk for litesvm. This file must work from every shape the
// module ships in:
//   - dist ESM   dist/testing/index.js   -> import.meta.url is real
//   - dist CJS   dist/testing/index.cjs  -> __dirname is real (esbuild lowers
//                import.meta to an empty shim there, so it must not be relied on)
//   - src dev    src/testing/*.ts via vitest/tsx -> import.meta.url is real
// In all three, the package root is two directories up, so the asset lives at
// ../../testing-assets/agenc_coordination.so; ../testing-assets is probed as a
// defensive fallback for flattened bundles.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Filename of the compiled program shipped in the npm tarball. */
export const TESTING_PROGRAM_SO_FILENAME = "agenc_coordination.so";

function moduleDirname(): string | null {
  // CJS build: __dirname is the real directory of dist/testing/index.cjs.
  // (typeof on the undeclared global is safe under ESM.)
  if (typeof __dirname === "string") return __dirname;
  // ESM build / src dev: import.meta.url is a real file URL. In the CJS
  // build esbuild lowers import.meta to an empty object, but that branch is
  // unreachable there because __dirname matched above.
  try {
    if (typeof import.meta.url === "string" && import.meta.url.length > 0) {
      return path.dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    // fall through to null
  }
  return null;
}

/**
 * Resolve the compiled `agenc_coordination.so` shipped in `testing-assets/`.
 *
 * Probes (relative to this module's directory, in order):
 * 1. `../../testing-assets/agenc_coordination.so` — the canonical location for
 *    `dist/testing/index.{js,cjs}` in the published package AND for
 *    `src/testing/*.ts` during repo development (both are two levels below the
 *    package root).
 * 2. `../testing-assets/agenc_coordination.so` — defensive fallback.
 *
 * @returns The absolute path of the first existing candidate.
 * @throws If no candidate exists, with every probed path and the exact
 * remediation for each failure mode: consumers with a broken install
 * (reinstall the package), consumers whose bundler relocated this module out
 * of `node_modules` (mark the subpath external or pass `{ programPath }`),
 * and repo developers (`anchor build` + `node scripts/sync-testing-so.mjs`).
 */
export function resolveTestingProgramSo(): string {
  const dir = moduleDirname();
  if (dir === null) {
    throw new Error(
      "marketplace-sdk/testing: cannot locate the module directory " +
        "(neither __dirname nor import.meta.url is available in this runtime). " +
        "Pass an explicit { programPath } to startLocalMarketplace().",
    );
  }
  const candidates = [
    path.resolve(dir, "../../testing-assets", TESTING_PROGRAM_SO_FILENAME),
    path.resolve(dir, "../testing-assets", TESTING_PROGRAM_SO_FILENAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    [
      `marketplace-sdk/testing: compiled program ${TESTING_PROGRAM_SO_FILENAME} not found. Probed:`,
      ...candidates.map((c) => `  - ${c}`),
      "If you installed @tetsuo-ai/marketplace-sdk from npm, the testing-assets/ folder",
      "is missing from your install — reinstall the package (it ships in the tarball).",
      "If this module was bundled/copied out of node_modules (the probed paths above point",
      "outside @tetsuo-ai/marketplace-sdk), the relative asset lookup cannot work — mark",
      "@tetsuo-ai/marketplace-sdk/testing as external in your bundler or pass { programPath } explicitly.",
      "If you are working in the agenc-protocol repo, build and sync it:",
      "  anchor build   (repo root)",
      "  node scripts/sync-testing-so.mjs   (packages/sdk-ts)",
      "Or pass an explicit path: startLocalMarketplace({ programPath: \"/path/to/agenc_coordination.so\" }).",
    ].join("\n"),
  );
}
