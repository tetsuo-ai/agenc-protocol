// Framework detection for `agenc init` — the CURRENT working repo, never
// greenfield-only: a Next.js app gets the checkout surface, everything else
// (generic node/agent project, or no package.json at all) gets a worker loop.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type ProjectKind = "checkout" | "worker";

export interface DetectedProject {
  kind: ProjectKind;
  /** Project name (package.json "name", else the directory basename). */
  name: string;
  /** True when a package.json file exists in the project dir (even invalid). */
  hasPackageJson: boolean;
  /** True when package.json deps/devDeps include `next`. */
  nextDetected: boolean;
  /** App-router directory relative to the project ("app" | "src/app"), if any. */
  appDir: string | null;
  /** Pages-router directory relative to the project ("pages" | "src/pages"), if any. */
  pagesDir: string | null;
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  const file = path.join(dir, "package.json");
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasDependency(pkg: Record<string, unknown>, name: string): boolean {
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[key];
    if (
      deps !== null &&
      typeof deps === "object" &&
      !Array.isArray(deps) &&
      Object.prototype.hasOwnProperty.call(deps, name)
    ) {
      return true;
    }
  }
  return false;
}

function firstExistingDir(dir: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(path.join(dir, candidate))) return candidate;
  }
  return null;
}

/** Inspect `dir` and decide what `agenc init` should wire up. */
export function detectProject(dir: string): DetectedProject {
  const pkg = readPackageJson(dir);
  const name =
    pkg !== null && typeof pkg.name === "string" && pkg.name.trim() !== ""
      ? pkg.name
      : path.basename(path.resolve(dir));
  const nextDetected = pkg !== null && hasDependency(pkg, "next");
  const appDir = firstExistingDir(dir, ["app", "src/app"]);
  const pagesDir = firstExistingDir(dir, ["pages", "src/pages"]);
  return {
    kind: nextDetected ? "checkout" : "worker",
    name,
    hasPackageJson: existsSync(path.join(dir, "package.json")),
    nextDetected,
    appDir,
    pagesDir,
  };
}
