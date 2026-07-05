// `agenc init` — wire the CURRENT repo into an AgenC node. Idempotent:
// identical files are left alone, differing files are refused without
// --force, and everything written lives under paths init owns
// (app/agenc/* or pages/agenc* + agenc.config.json + worker.mjs).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CONFIG_FILENAME,
  defaultConfig,
  loadConfig,
  serializeConfig,
  type AgencConfig,
} from "./config.js";
import { detectProject, type ProjectKind } from "./detect.js";
import {
  appCheckoutPage,
  appCheckoutRoute,
  pagesCheckoutApi,
  pagesCheckoutPage,
  scaffoldPackageJson,
  workerLoopMjs,
} from "./templates.js";

export interface InitOptions {
  /** Override framework detection. */
  kind?: ProjectKind;
  /** Overwrite files whose current content differs. */
  force?: boolean;
}

export type InitFileStatus = "written" | "unchanged" | "refused";

export interface InitFileResult {
  /** Path relative to the project dir. */
  path: string;
  status: InitFileStatus;
}

export interface InitResult {
  kind: ProjectKind;
  projectName: string;
  configPath: string;
  files: InitFileResult[];
  /** True when any file was refused (exit non-zero; rerun with --force). */
  refused: boolean;
  /** Human next steps (install commands, how to run). */
  instructions: string[];
}

interface PlannedFile {
  relPath: string;
  content: string;
}

/** Decide every file init would write (pure — used by tests and by run). */
export function planInitFiles(
  dir: string,
  config: AgencConfig,
  detection: ReturnType<typeof detectProject>,
): PlannedFile[] {
  const files: PlannedFile[] = [
    { relPath: CONFIG_FILENAME, content: serializeConfig(config) },
  ];
  // No package.json -> scaffold one, so `npm install` lands node_modules in
  // THIS project (never hoisted into an ancestor package, where `agenc
  // promote` and the wired templates would not find the sdk) with the AgenC
  // deps pre-pinned. Never touches an existing package.json.
  if (!detection.hasPackageJson) {
    files.push({ relPath: "package.json", content: scaffoldPackageJson(config) });
  }
  if (config.kind === "checkout") {
    if (detection.appDir !== null || detection.pagesDir === null) {
      // App Router (default even when neither dir exists yet).
      const appDir = detection.appDir ?? "app";
      files.push(
        { relPath: path.join(appDir, "agenc", "page.tsx"), content: appCheckoutPage(config) },
        {
          relPath: path.join(appDir, "agenc", "checkout", "route.ts"),
          content: appCheckoutRoute(config),
        },
      );
    } else {
      // Pages Router fallback.
      const pagesDir = detection.pagesDir;
      files.push(
        { relPath: path.join(pagesDir, "agenc.tsx"), content: pagesCheckoutPage(config) },
        {
          relPath: path.join(pagesDir, "api", "agenc", "checkout.ts"),
          content: pagesCheckoutApi(config),
        },
      );
    }
  } else {
    files.push({ relPath: "worker.mjs", content: workerLoopMjs(config) });
  }
  return files;
}

function writePlanned(
  dir: string,
  planned: PlannedFile[],
  force: boolean,
): InitFileResult[] {
  const results: InitFileResult[] = [];
  for (const file of planned) {
    const absPath = path.join(dir, file.relPath);
    if (existsSync(absPath)) {
      const current = readFileSync(absPath, "utf8");
      if (current === file.content) {
        results.push({ path: file.relPath, status: "unchanged" });
        continue;
      }
      if (!force) {
        results.push({ path: file.relPath, status: "refused" });
        continue;
      }
    }
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, file.content);
    results.push({ path: file.relPath, status: "written" });
  }
  return results;
}

function instructionsFor(
  kind: ProjectKind,
  refused: boolean,
  scaffoldedPackageJson: boolean,
): string[] {
  const lines: string[] = [];
  if (refused) {
    lines.push(
      "Some files already exist with different content and were NOT touched.",
      "Re-run with --force to overwrite them.",
    );
  }
  const install = scaffoldedPackageJson
    ? "Install deps:     npm install   (package.json was scaffolded with the AgenC deps pinned)"
    : kind === "checkout"
      ? "Install the SDK:  npm install @tetsuo-ai/marketplace-sdk @solana/kit"
      : "Install the runtime:  npm install @tetsuo-ai/agenc-worker @tetsuo-ai/marketplace-sdk @solana/kit";
  if (kind === "checkout") {
    lines.push(
      install,
      "Try the loop:     agenc dev   (bots hire your listing and you watch the 4-way split settle;",
      "                  uses the localnet stack when present, else the in-process litesvm sandbox)",
      "Checkout surface: GET /agenc renders the form; POST /agenc/checkout runs hireAndActivate.",
      "                  Wire AGENC_RPC_URL / AGENC_WALLET / AGENC_LISTING / AGENC_LISTING_SPEC_HASH /",
      "                  AGENC_MODERATOR / AGENC_ATTESTOR_URL before real hires (route returns 501 until then).",
      "Go-live diff:     agenc promote",
    );
  } else {
    lines.push(
      install,
      "Try the loop:         agenc dev   (bots hire your listing and you watch the 4-way split settle;",
      "                      uses the localnet stack when present, else the in-process litesvm sandbox)",
      "Run the worker:       AGENC_WORKER_RPC_URL=<rpc> AGENC_WORKER_WALLET=<keypair.json> node worker.mjs",
      "Go-live diff:         agenc promote",
    );
  }
  return lines;
}

/** Run `agenc init` against `dir`. */
export function runInit(dir: string, options: InitOptions = {}): InitResult {
  const detection = detectProject(dir);
  const kind = options.kind ?? detection.kind;

  // Reuse an existing config's values (name/price/fees) so re-running init
  // never clobbers tuned settings; only the kind can be re-decided.
  const existing = loadConfig(dir);
  const config: AgencConfig =
    existing !== null ? { ...existing.config, kind } : defaultConfig(detection.name, kind);

  const planned = planInitFiles(dir, config, detection);
  const files = writePlanned(dir, planned, options.force === true);
  const refused = files.some((f) => f.status === "refused");
  const scaffoldedPackageJson = files.some(
    (f) => f.path === "package.json" && f.status === "written",
  );
  return {
    kind,
    projectName: config.name,
    configPath: path.join(dir, CONFIG_FILENAME),
    files,
    refused,
    instructions: instructionsFor(kind, refused, scaffoldedPackageJson),
  };
}
