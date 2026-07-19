#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function fail(message) {
  throw new Error(message);
}

function safeTarget(target, label) {
  if (
    typeof target !== "string" ||
    !target.startsWith("./") ||
    target.includes("\\")
  ) {
    fail(`${label} must be a package-relative POSIX path`);
  }
  const normalized = posix.normalize(target);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    fail(`${label} escapes the installed package`);
  }
  return normalized;
}

function leafTargets(
  value,
  label,
  result = [],
  runtimeCondition = null,
  typesCondition = false,
) {
  if (typeof value === "string") {
    result.push({
      runtimeCondition,
      target: safeTarget(value, label),
      typesCondition,
    });
    return result;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(
      `${label} must contain only condition objects and package-relative targets`,
    );
  }
  for (const [condition, child] of Object.entries(value)) {
    const nextRuntimeCondition =
      condition === "import" || condition === "require"
        ? condition
        : runtimeCondition;
    if (
      runtimeCondition !== null &&
      nextRuntimeCondition !== runtimeCondition
    ) {
      fail(`${label}.${condition} has contradictory runtime conditions`);
    }
    leafTargets(
      child,
      `${label}.${condition}`,
      result,
      nextRuntimeCondition,
      typesCondition || condition === "types",
    );
  }
  return result;
}

export function collectPackSmokePlan(manifest) {
  if (
    !manifest ||
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  ) {
    fail("installed package manifest has no identity");
  }
  const files = new Map();
  const executions = [];
  const exportsField = manifest.exports;
  if (exportsField !== undefined) {
    const exportsMap =
      typeof exportsField === "string" ||
      !Object.keys(exportsField).some((key) => key.startsWith("."))
        ? { ".": exportsField }
        : exportsField;
    for (const [subpath, value] of Object.entries(exportsMap)) {
      if (subpath !== "." && !/^\.\/[A-Za-z0-9._/-]+$/.test(subpath)) {
        fail(`invalid package export subpath ${subpath}`);
      }
      const specifier =
        subpath === "."
          ? manifest.name
          : `${manifest.name}/${subpath.slice(2)}`;
      for (const leaf of leafTargets(value, `exports.${subpath}`)) {
        files.set(leaf.target, leaf.target);
        if (
          leaf.typesCondition ||
          /\.(?:css|json|d\.[cm]?ts)$/.test(leaf.target)
        ) {
          continue;
        }
        executions.push({
          kind:
            leaf.runtimeCondition ??
            (manifest.type === "module" ? "import" : "require"),
          specifier,
        });
      }
    }
  }
  if (manifest.main) {
    const target = safeTarget(manifest.main, "main");
    files.set(target, target);
    executions.push({ kind: "require-file", target });
  }
  if (manifest.module) {
    const target = safeTarget(manifest.module, "module");
    files.set(target, target);
    executions.push({ kind: "import-file", target });
  }
  const bins = [];
  const binMap =
    typeof manifest.bin === "string"
      ? { [manifest.name.split("/").at(-1)]: manifest.bin }
      : (manifest.bin ?? {});
  if (binMap === null || typeof binMap !== "object" || Array.isArray(binMap)) {
    fail("package bin must be a string or object");
  }
  for (const [name, value] of Object.entries(binMap)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      fail(`invalid package bin name ${name}`);
    const target = safeTarget(value, `bin.${name}`);
    files.set(target, target);
    bins.push({ name, target });
  }
  if (files.size === 0)
    fail("released package declares no loadable or executable surface");
  const uniqueExecutions = [
    ...new Map(
      executions.map((item) => [
        `${item.kind}:${item.specifier ?? item.target}`,
        item,
      ]),
    ).values(),
  ];
  return Object.freeze({
    files: [...files.values()].sort(),
    executions: uniqueExecutions,
    bins,
  });
}

async function runNode(args, cwd, execFileFn, { allowOutput = false } = {}) {
  const result = await execFileFn(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 5 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      NODE_ENV: "test",
      AGENC_RPC_URL: "http://127.0.0.1:8899",
    },
  });
  if (
    !allowOutput &&
    (String(result?.stdout ?? "").length > 0 ||
      String(result?.stderr ?? "").length > 0)
  ) {
    fail("packed module load wrote to stdout or stderr");
  }
}

function guardedModuleExpression(expression) {
  return `
const agencPackSmokeInitialExitCode = process.exitCode;
process.exit = (code) => {
  throw new Error(\`packed module load called process.exit(\${String(code ?? 0)})\`);
};
${expression}
if (process.exitCode !== agencPackSmokeInitialExitCode) {
  throw new Error("packed module load changed process.exitCode");
}
`;
}

export async function smokePackedArtifact({
  tarballPath,
  expectedName,
  expectedVersion,
  execFileFn = execFile,
  tempRoot = tmpdir(),
}) {
  const tarball = await realpath(tarballPath);
  if (!tarball.endsWith(".tgz")) fail("reviewed artifact must be a .tgz file");
  const directory = await mkdtemp(join(tempRoot, "agenc-pack-smoke-"));
  try {
    await writeFile(join(directory, "package.json"), '{"private":true}\n', {
      encoding: "utf8",
      mode: 0o600,
    });
    await execFileFn(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        tarball,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 20 * 1024 * 1024,
        env: process.env,
      },
    );
    const packageRoot = join(directory, "node_modules", expectedName);
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    );
    if (
      manifest.name !== expectedName ||
      manifest.version !== expectedVersion
    ) {
      fail(
        "installed tarball identity differs from the reviewed release identity",
      );
    }
    const plan = collectPackSmokePlan(manifest);
    const canonicalRoot = `${await realpath(packageRoot)}${sep}`;
    for (const target of plan.files) {
      const path = resolve(packageRoot, target);
      const canonical = await realpath(path);
      const stat = await lstat(canonical);
      if (!canonical.startsWith(canonicalRoot) || !stat.isFile()) {
        fail(
          `packed surface ${target} is not a regular file inside the package`,
        );
      }
    }
    for (const check of plan.executions) {
      if (check.kind === "import") {
        await runNode(
          [
            "--input-type=module",
            "--eval",
            guardedModuleExpression(
              `await import(${JSON.stringify(check.specifier)});`,
            ),
          ],
          directory,
          execFileFn,
        );
      } else if (check.kind === "require") {
        await runNode(
          [
            "--eval",
            guardedModuleExpression(
              `require(${JSON.stringify(check.specifier)});`,
            ),
          ],
          directory,
          execFileFn,
        );
      } else {
        const path = resolve(packageRoot, check.target);
        const expression =
          check.kind === "import-file"
            ? `await import(${JSON.stringify(pathToFileURL(path).href)});`
            : `require(${JSON.stringify(path)});`;
        await runNode(
          check.kind === "import-file"
            ? [
                "--input-type=module",
                "--eval",
                guardedModuleExpression(expression),
              ]
            : ["--eval", guardedModuleExpression(expression)],
          directory,
          execFileFn,
        );
      }
    }
    for (const bin of plan.bins) {
      const path = resolve(packageRoot, bin.target);
      const stat = await lstat(path);
      if ((stat.mode & 0o111) === 0)
        fail(`packed bin ${bin.name} is not executable`);
      await runNode([path, "--help"], directory, execFileFn, {
        allowOutput: true,
      });
    }
    return plan;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function cli() {
  const packJsonPath = process.env.PACK_JSON;
  const packageDirectory = process.env.PACKAGE_DIR;
  const expectedName = process.env.PACKAGE_NAME;
  const expectedVersion = process.env.PACKAGE_VERSION;
  if (!packJsonPath || !packageDirectory || !expectedName || !expectedVersion) {
    fail(
      "PACK_JSON, PACKAGE_DIR, PACKAGE_NAME, and PACKAGE_VERSION are required",
    );
  }
  const packJson = JSON.parse(await readFile(packJsonPath, "utf8"));
  if (
    !Array.isArray(packJson) ||
    packJson.length !== 1 ||
    typeof packJson[0]?.filename !== "string"
  ) {
    fail("npm pack must return exactly one artifact record");
  }
  const result = await smokePackedArtifact({
    tarballPath: resolve(
      fileURLToPath(new URL("../", import.meta.url)),
      packageDirectory,
      packJson[0].filename,
    ),
    expectedName,
    expectedVersion,
  });
  console.log(
    `smoked ${expectedName}@${expectedVersion}: ${result.files.length} files, ` +
      `${result.executions.length} module loads, ${result.bins.length} bins`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    console.error(`release pack smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}
