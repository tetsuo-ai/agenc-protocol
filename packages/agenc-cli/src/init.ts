// `agenc init` — wire the CURRENT repo into an AgenC node. Idempotent:
// identical files are left alone, differing files are refused without
// --force, and everything written lives under paths init owns
// (app/agenc/* or pages/agenc* + agenc.config.json + worker.mjs).
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  CONFIG_FILENAME,
  defaultConfig,
  parseConfig,
  serializeConfig,
  type AgencConfig,
} from "./config.js";
import { detectProject, type ProjectKind } from "./detect.js";
import {
  appCheckoutPage,
  appCheckoutRoute,
  checkoutCoreModule,
  checkoutPolicyModule,
  appJobSpecRoute,
  jobSpecStoreModule,
  pagesCheckoutApi,
  pagesJobSpecApi,
  pagesCheckoutPage,
  scaffoldPackageJson,
  walletFileModule,
  workerLoopMjs,
} from "./templates.js";

export interface InitOptions {
  /** Override framework detection. */
  kind?: ProjectKind;
  /** Overwrite files whose current content differs. */
  force?: boolean;
  /** Override Next.js router selection when migrating generated surfaces. */
  router?: "app" | "pages";
}

export type InitFileStatus = "written" | "unchanged" | "removed" | "refused";

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

const GENERATED_MARKER = "Written by `agenc init` (@tetsuo-ai/agenc-cli).";

type ExistingTarget =
  | { kind: "missing" }
  | { kind: "regular"; content: string }
  | { kind: "unsafe" };

function ensureSafeDirectories(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return false;
  }
  let current = root;
  const components = relative === "" ? [] : relative.split(path.sep);
  for (const component of ["", ...components]) {
    if (component !== "") current = path.join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || component === "") {
        return false;
      }
      try {
        mkdirSync(current, { mode: 0o755 });
        const created = lstatSync(current);
        if (created.isSymbolicLink() || !created.isDirectory()) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

function inspectSafeDirectories(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return false;
  }
  let current = root;
  for (const component of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
  }
  return true;
}

function readRegularFileNoFollow(filePath: string): ExistingTarget {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { kind: "unsafe" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "unsafe" };
  }

  let fd: number | undefined;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return { kind: "unsafe" };
    return { kind: "regular", content: readFileSync(fd, "utf8") };
  } catch {
    return { kind: "unsafe" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function publishAtomic(
  filePath: string,
  content: string,
  overwrite: boolean,
): void {
  const directory = path.dirname(filePath);
  const temp = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  let tempExists = false;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o644,
    );
    tempExists = true;
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (overwrite) {
      // rename replaces the directory entry itself; it never follows a target
      // symlink even if a hostile process races after our lstat/open checks.
      renameSync(temp, filePath);
      tempExists = false;
    } else {
      // Hard-link publication is atomic and refuses an unexpected winner.
      linkSync(temp, filePath);
      unlinkSync(temp);
      tempExists = false;
    }
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (tempExists) {
      try {
        unlinkSync(temp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
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
          relPath: path.join(appDir, "agenc", "checkout-core.ts"),
          content: checkoutCoreModule(config),
        },
        {
          relPath: path.join(appDir, "agenc", "job-spec-store.ts"),
          content: jobSpecStoreModule(),
        },
        {
          relPath: path.join(appDir, "agenc", "checkout-policy.ts"),
          content: checkoutPolicyModule(),
        },
        {
          relPath: path.join(appDir, "agenc", "wallet-file.ts"),
          content: walletFileModule(),
        },
        {
          relPath: path.join(appDir, "agenc", "job-specs", "route.ts"),
          content: appJobSpecRoute(),
        },
        {
          relPath: path.join(appDir, "agenc", "checkout", "route.ts"),
          content: appCheckoutRoute(config),
        },
      );
    } else {
      // Pages Router fallback.
      const pagesDir = detection.pagesDir;
      const helperDir = path.join(path.dirname(pagesDir), "lib", "agenc");
      files.push(
        { relPath: path.join(pagesDir, "agenc.tsx"), content: pagesCheckoutPage(config) },
        {
          relPath: path.join(helperDir, "checkout-core.ts"),
          content: checkoutCoreModule(config),
        },
        {
          relPath: path.join(helperDir, "job-spec-store.ts"),
          content: jobSpecStoreModule(),
        },
        {
          relPath: path.join(helperDir, "checkout-policy.ts"),
          content: checkoutPolicyModule(),
        },
        {
          relPath: path.join(helperDir, "wallet-file.ts"),
          content: walletFileModule(),
        },
        {
          relPath: path.join(pagesDir, "api", "agenc", "job-specs.ts"),
          content: pagesJobSpecApi(),
        },
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

function generatedOutputInventory(): string[] {
  const names = [
    "page.tsx",
    "checkout-core.ts",
    "checkout-policy.ts",
    "job-spec-store.ts",
    "wallet-file.ts",
    path.join("job-specs", "route.ts"),
    path.join("checkout", "route.ts"),
  ];
  const outputs = ["worker.mjs"];
  for (const appDir of ["app", path.join("src", "app")]) {
    outputs.push(...names.map((name) => path.join(appDir, "agenc", name)));
  }
  for (const pagesDir of ["pages", path.join("src", "pages")]) {
    const sourceRoot = path.dirname(pagesDir);
    outputs.push(
      path.join(pagesDir, "agenc.tsx"),
      path.join(pagesDir, "api", "agenc", "checkout.ts"),
      path.join(pagesDir, "api", "agenc", "job-specs.ts"),
      path.join(sourceRoot, "lib", "agenc", "checkout-core.ts"),
      path.join(sourceRoot, "lib", "agenc", "checkout-policy.ts"),
      path.join(sourceRoot, "lib", "agenc", "job-spec-store.ts"),
      path.join(sourceRoot, "lib", "agenc", "wallet-file.ts"),
      // Pre-hardening layouts placed helpers under pages/api and accidentally
      // exposed them as routes. They remain marker-owned migration candidates.
      path.join(pagesDir, "api", "agenc", "checkout-policy.ts"),
      path.join(pagesDir, "api", "agenc", "job-spec-store.ts"),
      path.join(pagesDir, "api", "agenc", "wallet-file.ts"),
    );
  }
  return [...new Set(outputs)];
}

function isMarkerOwned(content: string): boolean {
  return content.slice(0, 512).includes(GENERATED_MARKER);
}

function writePlanned(
  dir: string,
  planned: PlannedFile[],
  force: boolean,
): InitFileResult[] {
  const root = path.resolve(dir);
  const targetPaths = new Set(planned.map((file) => file.relPath));
  const prepared: Array<{
    file: PlannedFile;
    existing: ExistingTarget;
    status: InitFileStatus;
  }> = [];

  // Read-only preflight every intended target. A refusal cancels the whole
  // publication batch so an incompatible retained config cannot be mixed with
  // newly generated code.
  for (const file of planned) {
    const absPath = path.resolve(root, file.relPath);
    const relative = path.relative(root, absPath);
    if (
      relative === "" ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      !inspectSafeDirectories(root, path.dirname(absPath))
    ) {
      prepared.push({ file, existing: { kind: "unsafe" }, status: "refused" });
      continue;
    }
    const existing = readRegularFileNoFollow(absPath);
    const status: InitFileStatus =
      existing.kind === "unsafe"
        ? "refused"
        : existing.kind === "regular" && existing.content === file.content
          ? "unchanged"
          : existing.kind === "regular" && !force
            ? "refused"
            : "written";
    prepared.push({ file, existing, status });
  }

  const stale: Array<{ relPath: string; status: InitFileStatus }> = [];
  for (const relPath of generatedOutputInventory()) {
    if (targetPaths.has(relPath)) continue;
    const absPath = path.resolve(root, relPath);
    if (!inspectSafeDirectories(root, path.dirname(absPath))) {
      stale.push({ relPath, status: "refused" });
      continue;
    }
    const existing = readRegularFileNoFollow(absPath);
    if (existing.kind === "missing") continue;
    if (
      existing.kind !== "regular" ||
      !isMarkerOwned(existing.content) ||
      !force
    ) {
      stale.push({ relPath, status: "refused" });
    } else {
      stale.push({ relPath, status: "removed" });
    }
  }

  if (
    prepared.some((entry) => entry.status === "refused") ||
    stale.some((entry) => entry.status === "refused")
  ) {
    return [
      ...prepared.map((entry) => ({
        path: entry.file.relPath,
        status: entry.status === "unchanged" ? "unchanged" as const : "refused" as const,
      })),
      ...stale.map((entry) => ({ path: entry.relPath, status: "refused" as const })),
    ];
  }

  // Materialize and validate the complete destination directory graph before
  // publishing the first file. Directory creation can fail for quota,
  // permission, or I/O reasons; discovering that after rewriting the config
  // would leave a config/runtime hybrid.
  if (
    prepared.some(
      (entry) =>
        entry.status === "written" &&
        !ensureSafeDirectories(
          root,
          path.dirname(path.resolve(root, entry.file.relPath)),
        ),
    )
  ) {
    return [
      ...prepared.map((entry) => ({
        path: entry.file.relPath,
        status:
          entry.status === "unchanged"
            ? "unchanged" as const
            : "refused" as const,
      })),
      ...stale.map((entry) => ({
        path: entry.relPath,
        status: "refused" as const,
      })),
    ];
  }

  const results: InitFileResult[] = [];
  const published: typeof prepared = [];
  let publicationFailed = false;
  for (const entry of prepared) {
    if (entry.status === "unchanged") {
      results.push({ path: entry.file.relPath, status: "unchanged" });
      continue;
    }
    if (publicationFailed) {
      results.push({ path: entry.file.relPath, status: "refused" });
      continue;
    }
    const absPath = path.resolve(root, entry.file.relPath);
    // Revalidate immediately before publication to narrow directory-swap
    // races after the batch-level readiness pass.
    if (!ensureSafeDirectories(root, path.dirname(absPath))) {
      results.push({ path: entry.file.relPath, status: "refused" });
      publicationFailed = true;
      continue;
    }
    try {
      publishAtomic(absPath, entry.file.content, entry.existing.kind === "regular");
      results.push({ path: entry.file.relPath, status: "written" });
      published.push(entry);
    } catch {
      results.push({ path: entry.file.relPath, status: "refused" });
      publicationFailed = true;
    }
  }

  // Delete only after the replacement surface is published, and revalidate
  // marker ownership immediately before unlinking to close preflight races.
  // A partial publication failure must retain every old surface: even a stale,
  // marker-owned router can remain the last runnable copy of the application.
  if (publicationFailed) {
    // Roll successful publications back in reverse order. Only touch a target
    // if it still contains the exact bytes this invocation published; a
    // concurrent edit is application-owned and must never be overwritten.
    for (const entry of published.reverse()) {
      const absPath = path.resolve(root, entry.file.relPath);
      const current = readRegularFileNoFollow(absPath);
      if (current.kind !== "regular" || current.content !== entry.file.content) {
        continue;
      }
      try {
        if (entry.existing.kind === "regular") {
          publishAtomic(absPath, entry.existing.content, true);
        } else {
          unlinkSync(absPath);
          syncDirectory(path.dirname(absPath));
        }
      } catch {
        // The overall batch is already refused. Do not risk overwriting or
        // unlinking through a second recovery path after rollback I/O fails.
      }
    }
    return [
      ...prepared.map((entry) => ({
        path: entry.file.relPath,
        status:
          entry.status === "unchanged"
            ? "unchanged" as const
            : "refused" as const,
      })),
      ...stale.map((entry) => ({
        path: entry.relPath,
        status: "refused" as const,
      })),
    ];
  }
  for (const entry of stale) {
    const absPath = path.resolve(root, entry.relPath);
    const current = readRegularFileNoFollow(absPath);
    if (current.kind !== "regular" || !isMarkerOwned(current.content)) {
      results.push({ path: entry.relPath, status: "refused" });
      continue;
    }
    try {
      unlinkSync(absPath);
      syncDirectory(path.dirname(absPath));
      results.push({ path: entry.relPath, status: "removed" });
    } catch {
      results.push({ path: entry.relPath, status: "refused" });
    }
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
      "Try the loop:     agenc dev   (bots hire your listing and you watch the marketplace split settle;",
      "                  uses the localnet stack when present, else the in-process litesvm sandbox)",
      "Checkout surface: GET /agenc documents the safe-default endpoint; POST /agenc/checkout is",
      "                  production-disabled until you add real auth + durable idempotency/spend policy.",
      "                  Wire AGENC_RPC_URL / AGENC_WALLET / AGENC_LISTING / AGENC_LISTING_SPEC_HASH /",
      "                  AGENC_MODERATOR / AGENC_ATTESTOR_URL / AGENC_JOB_SPEC_DIR /",
      "                  AGENC_PROVIDER_AGENT / AGENC_OPERATOR / AGENC_JOB_SPEC_PUBLIC_BASE_URL plus the explicit local-only",
      "                  AGENC_ENABLE_DEV_CHECKOUT=1 / AGENC_NETWORK=localnet / AGENC_CHECKOUT_SECRET /",
      "                  AGENC_CHECKOUT_MAX_DEBIT_LAMPORTS / AGENC_CHECKOUT_HOURLY_DEBIT_LIMIT_LAMPORTS /",
      "                  AGENC_CHECKOUT_TX_FEE_BUDGET_LAMPORTS (route stays fail-closed until all are set).",
      "                  AGENC_MODERATOR must be the separate attestor-funded wallet, not AGENC_WALLET.",
      "Go-live diff:     agenc promote",
    );
  } else {
    lines.push(
      install,
      "Try the loop:         agenc dev   (bots hire your listing and you watch the marketplace split settle;",
      "                      uses the localnet stack when present, else the in-process litesvm sandbox)",
      "Run the worker:       set AGENC_WORKER_RPC_URL / AGENC_WORKER_WALLET / AGENC_WORKER_ENDPOINT /",
      "                      AGENC_WORKER_STATE_DIR (private + project-specific) / finite",
      "                      AGENC_WORKER_MAX_REWARD_LAMPORTS / AGENC_WORKER_CREATOR_ALLOWLIST,",
      "                      then node worker.mjs",
      "Go-live diff:         agenc promote",
    );
  }
  return lines;
}

/** Run `agenc init` against `dir`. */
export function runInit(dir: string, options: InitOptions = {}): InitResult {
  const detected = detectProject(dir);
  const detection = options.router === "app"
    ? {
        ...detected,
        appDir:
          detected.appDir ??
          (detected.pagesDir?.startsWith(`src${path.sep}`) ? path.join("src", "app") : "app"),
      }
    : options.router === "pages"
      ? {
          ...detected,
          appDir: null,
          pagesDir:
            detected.pagesDir ??
            (detected.appDir?.startsWith(`src${path.sep}`) ? path.join("src", "pages") : "pages"),
        }
      : detected;
  const kind = options.kind ?? detection.kind;

  // Reuse an existing config's values (name/price/fees) so re-running init
  // never clobbers tuned settings; only the kind can be re-decided.
  const configPath = path.resolve(dir, CONFIG_FILENAME);
  const existingTarget = inspectSafeDirectories(path.resolve(dir), path.resolve(dir))
    ? readRegularFileNoFollow(configPath)
    : ({ kind: "unsafe" } as const);
  if (existingTarget.kind === "unsafe") {
    const projectName = defaultConfig(detection.name, kind).name;
    return {
      kind,
      projectName,
      configPath: path.join(dir, CONFIG_FILENAME),
      files: [{ path: CONFIG_FILENAME, status: "refused" }],
      refused: true,
      instructions: instructionsFor(kind, true, false),
    };
  }
  const existing =
    existingTarget.kind === "regular"
      ? {
          config: parseConfig(existingTarget.content, configPath),
          path: configPath,
        }
      : null;
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
