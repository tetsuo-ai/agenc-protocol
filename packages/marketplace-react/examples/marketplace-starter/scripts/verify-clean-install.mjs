#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const starterRoot = path.resolve(scriptDir, "..");
const reactRoot = path.resolve(starterRoot, "../..");
const sdkRoot = path.resolve(reactRoot, "../sdk-ts");
const protocolRoot = path.resolve(reactRoot, "../..");

const keepTemp = process.env.AGENC_KEEP_CLEAN_STARTER === "1";

async function main() {
  assertRepoShape();

  const tempRoot = await mkdtemp(path.join(tmpdir(), "agenc-starter-clean-"));
  const tarballDir = path.join(tempRoot, "tarballs");
  const appDir = path.join(tempRoot, "app");
  let succeeded = false;

  try {
    await mkdir(tarballDir, { recursive: true });

    const sdkTarball = await packPackage(sdkRoot, tarballDir);
    await run("npm", ["run", "build"], { cwd: reactRoot });
    const reactTarball = await packPackage(reactRoot, tarballDir);

    await copyStarter(appDir);
    await rewriteStarterManifest(appDir, {
      sdkTarball,
      reactTarball,
    });
    await removeSourceAliases(appDir);
    await assertNoPrivateSourceLeakage(appDir);

    await run("npm", ["install", "--ignore-scripts"], { cwd: appDir });
    await assertInstalledFromPackageArtifacts(appDir);
    await run("npm", ["run", "typecheck"], { cwd: appDir });
    await run("npm", ["test"], { cwd: appDir });
    await run("npm", ["run", "build"], { cwd: appDir });

    succeeded = true;
    console.log(`Clean starter verification passed in ${appDir}`);
  } finally {
    if (succeeded && !keepTemp) {
      await rm(tempRoot, { recursive: true, force: true });
    } else {
      console.log(`Clean starter verification workspace kept at ${tempRoot}`);
    }
  }
}

function assertRepoShape() {
  const required = [
    path.join(protocolRoot, "package.json"),
    path.join(sdkRoot, "package.json"),
    path.join(reactRoot, "package.json"),
    path.join(starterRoot, "package.json"),
  ];
  const missing = required.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `verify-clean-install must run from the agenc-protocol repo; missing ${missing.join(", ")}`,
    );
  }
}

async function packPackage(packageRoot, tarballDir) {
  const output = await run("npm", ["pack", "--pack-destination", tarballDir], {
    cwd: packageRoot,
    capture: true,
  });
  const tarballName = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .findLast((line) => line.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error(`npm pack did not report a tarball for ${packageRoot}`);
  }
  return path.join(tarballDir, tarballName);
}

async function copyStarter(appDir) {
  await cp(starterRoot, appDir, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return !["node_modules", "dist", ".data", ".env.local", "package-lock.json"].includes(
        base,
      );
    },
  });
}

async function rewriteStarterManifest(appDir, { sdkTarball, reactTarball }) {
  const manifestPath = path.join(appDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies["@tetsuo-ai/marketplace-sdk"] = fileDependency(
    appDir,
    sdkTarball,
  );
  manifest.dependencies["@tetsuo-ai/marketplace-react"] = fileDependency(
    appDir,
    reactTarball,
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function removeSourceAliases(appDir) {
  for (const file of ["tsconfig.json", "tsconfig.test.json"]) {
    const tsconfigPath = path.join(appDir, file);
    if (!existsSync(tsconfigPath)) continue;
    const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8"));
    delete tsconfig.compilerOptions?.paths;
    await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");
  }
}

function fileDependency(fromDir, file) {
  return `file:${path.relative(fromDir, file).split(path.sep).join("/")}`;
}

async function assertNoPrivateSourceLeakage(appDir) {
  const files = await listFiles(appDir);
  const checkedFiles = files.filter((file) =>
    file !== "scripts/verify-clean-install.mjs" &&
    file !== "scripts/verify-registry-install.mjs" &&
    /\.(json|mjs|ts|tsx|css|html|md)$/.test(file),
  );
  const forbidden = [
    /agenc-ag/,
    /\/home\/tetsuo\/git\/AgenC\/agenc-ag/,
    /from\s+["']@\//,
    /from\s+["'][^"']*@tetsuo-ai\/marketplace-[^"']*\/src/,
    /workspace:/,
    /link:/,
    /file:\.\.\/\.\./,
  ];

  for (const file of checkedFiles) {
    const text = await readFile(path.join(appDir, file), "utf8");
    const matched = forbidden.find((pattern) => pattern.test(text));
    if (matched) {
      throw new Error(`Clean starter copy contains private/local reference ${matched} in ${file}`);
    }
  }
}

async function assertInstalledFromPackageArtifacts(appDir) {
  const requiredFiles = [
    "node_modules/@tetsuo-ai/marketplace-react/dist/index.js",
    "node_modules/@tetsuo-ai/marketplace-react/dist/index.d.ts",
    "node_modules/@tetsuo-ai/marketplace-react/dist/hooks/index.js",
    "node_modules/@tetsuo-ai/marketplace-react/dist/hooks/index.d.ts",
    "node_modules/@tetsuo-ai/marketplace-react/dist/signers/index.js",
    "node_modules/@tetsuo-ai/marketplace-react/dist/theme/agenc-tokens.css",
    "node_modules/@tetsuo-ai/marketplace-react/dist/components/agenc-components.css",
    "node_modules/@tetsuo-ai/marketplace-sdk/dist/index.js",
    "node_modules/@tetsuo-ai/marketplace-sdk/dist/index.d.ts",
  ];

  const missing = requiredFiles.filter((file) => !existsSync(path.join(appDir, file)));
  if (missing.length > 0) {
    throw new Error(`Packed package install is missing expected artifacts: ${missing.join(", ")}`);
  }

  await run(
    "node",
    [
      "--input-type=module",
      "-e",
      [
        "const hooks = await import('@tetsuo-ai/marketplace-react/hooks');",
        "for (const key of ['useHumanlessHireFlow','useTaskActivation','useTaskWork','useTaskLifecycle','useRateHire']) {",
        "  if (typeof hooks[key] !== 'function') throw new Error(`missing ${key}`);",
        "}",
        "const signers = await import('@tetsuo-ai/marketplace-react/signers');",
        "if (typeof signers.signerFromWalletAccount !== 'function') throw new Error('missing signer bridge');",
        "const sdk = await import('@tetsuo-ai/marketplace-sdk');",
        "if (!sdk.values?.canonicalJobSpecHash) throw new Error('missing SDK values export');",
      ].join("\n"),
    ],
    { cwd: appDir },
  );

  const hooksDeclaration = await readFile(
    path.join(appDir, "node_modules/@tetsuo-ai/marketplace-react/dist/hooks/index.d.ts"),
    "utf8",
  );
  for (const key of [
    "HumanlessHireFlowActivationInput",
    "HumanlessHireFlowCreator",
    "HumanlessHireFlowHireInput",
    "HumanlessHireFlowHost",
    "HumanlessHireFlowHostInput",
    "HumanlessHireFlowInput",
    "HumanlessHireFlowJobSpecHash",
    "HumanlessHireFlowModerationResult",
    "HumanlessHireFlowPhase",
    "HumanlessHireFlowProgress",
    "HumanlessHireFlowResult",
    "HumanlessHireFlowStatus",
    "UseHumanlessHireFlowResult",
  ]) {
    const exactToken = new RegExp(`(^|[^A-Za-z0-9_$])${key}([^A-Za-z0-9_$]|$)`);
    if (!exactToken.test(hooksDeclaration)) {
      throw new Error(`Packed hooks declaration is missing ${key}`);
    }
  }

  const manifest = JSON.parse(
    await readFile(
      path.join(appDir, "node_modules/@tetsuo-ai/marketplace-react/package.json"),
      "utf8",
    ),
  );
  if (manifest.version === "0.1.1") {
    throw new Error(
      "Clean starter requires a marketplace-react lifecycle artifact newer than 0.1.1.",
    );
  }
}

async function listFiles(root, prefix = "") {
  const dirents = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const dirent of dirents) {
    if (["node_modules", "dist", ".data"].includes(dirent.name)) continue;
    const relative = path.join(prefix, dirent.name);
    if (dirent.isDirectory()) {
      files.push(...(await listFiles(root, relative)));
    } else if (dirent.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

async function run(command, args, { cwd, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: "1" },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      if (capture && stderr) process.stderr.write(stderr);
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

await main();
