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

const keepTemp = process.env.AGENC_KEEP_REGISTRY_STARTER === "1";

async function main() {
  assertRepoShape();

  const expectedReactVersion =
    process.env.AGENC_MARKETPLACE_REACT_REGISTRY_VERSION ??
    (await packageVersion(path.join(reactRoot, "package.json")));
  const expectedSdkVersion =
    process.env.AGENC_MARKETPLACE_SDK_REGISTRY_VERSION ??
    (await packageVersion(path.join(sdkRoot, "package.json")));

  await assertRegistryVersion("@tetsuo-ai/marketplace-react", expectedReactVersion);
  await assertRegistryVersion("@tetsuo-ai/marketplace-sdk", expectedSdkVersion);

  const tempRoot = await mkdtemp(path.join(tmpdir(), "agenc-starter-registry-"));
  const appDir = path.join(tempRoot, "app");
  let succeeded = false;

  try {
    await copyStarter(appDir);
    await rewriteStarterManifest(appDir, {
      reactVersion: expectedReactVersion,
      sdkVersion: expectedSdkVersion,
    });
    await removeSourceAliases(appDir);
    await assertNoPrivateSourceLeakage(appDir);

    await run("npm", ["install", "--ignore-scripts"], { cwd: appDir });
    await assertInstalledFromRegistry(appDir, {
      reactVersion: expectedReactVersion,
      sdkVersion: expectedSdkVersion,
    });
    await run("npm", ["run", "typecheck"], { cwd: appDir });
    await run("npm", ["test"], { cwd: appDir });
    await run("npm", ["run", "build"], { cwd: appDir });

    succeeded = true;
    console.log(`Registry starter verification passed in ${appDir}`);
  } finally {
    if (succeeded && !keepTemp) {
      await rm(tempRoot, { recursive: true, force: true });
    } else {
      console.log(`Registry starter verification workspace kept at ${tempRoot}`);
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
      `verify-registry-install must run from the agenc-protocol repo; missing ${missing.join(", ")}`,
    );
  }
}

async function packageVersion(packageJsonPath) {
  const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (!manifest.version || typeof manifest.version !== "string") {
    throw new Error(`${packageJsonPath} is missing a string version`);
  }
  return manifest.version;
}

async function assertRegistryVersion(packageName, expectedVersion) {
  try {
    const published = JSON.parse(
      await run("npm", ["view", `${packageName}@${expectedVersion}`, "version", "--json"], {
        cwd: starterRoot,
        capture: true,
      }),
    );
    if (published !== expectedVersion) {
      throw new Error(`registry returned ${JSON.stringify(published)}`);
    }
  } catch (error) {
    throw new Error(
      `${packageName}@${expectedVersion} is not available from the public npm registry. ` +
        "Publish the package first or set AGENC_MARKETPLACE_REACT_REGISTRY_VERSION / " +
        "AGENC_MARKETPLACE_SDK_REGISTRY_VERSION to a published version before running this gate.",
      { cause: error },
    );
  }
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

async function rewriteStarterManifest(appDir, { reactVersion, sdkVersion }) {
  const manifestPath = path.join(appDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies["@tetsuo-ai/marketplace-react"] = reactVersion;
  manifest.dependencies["@tetsuo-ai/marketplace-sdk"] = sdkVersion;
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
    /file:/,
  ];

  for (const file of checkedFiles) {
    const text = await readFile(path.join(appDir, file), "utf8");
    const matched = forbidden.find((pattern) => pattern.test(text));
    if (matched) {
      throw new Error(`Registry starter copy contains private/local reference ${matched} in ${file}`);
    }
  }
}

async function assertInstalledFromRegistry(appDir, { reactVersion, sdkVersion }) {
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
    throw new Error(`Registry package install is missing expected artifacts: ${missing.join(", ")}`);
  }

  const reactManifest = await installedManifest(appDir, "@tetsuo-ai/marketplace-react");
  const sdkManifest = await installedManifest(appDir, "@tetsuo-ai/marketplace-sdk");
  assertEqualVersion("@tetsuo-ai/marketplace-react", reactManifest.version, reactVersion);
  assertEqualVersion("@tetsuo-ai/marketplace-sdk", sdkManifest.version, sdkVersion);

  await assertLockfileRegistrySource(appDir, "@tetsuo-ai/marketplace-react");
  await assertLockfileRegistrySource(appDir, "@tetsuo-ai/marketplace-sdk");

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
      throw new Error(`Registry hooks declaration is missing ${key}`);
    }
  }
}

async function installedManifest(appDir, packageName) {
  return JSON.parse(
    await readFile(path.join(appDir, "node_modules", ...packageName.split("/"), "package.json"), "utf8"),
  );
}

function assertEqualVersion(packageName, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${packageName} installed ${actual}; expected public registry version ${expected}`);
  }
}

async function assertLockfileRegistrySource(appDir, packageName) {
  const lockfile = JSON.parse(await readFile(path.join(appDir, "package-lock.json"), "utf8"));
  const packagePath = `node_modules/${packageName}`;
  const entry = lockfile.packages?.[packagePath];
  if (!entry) throw new Error(`package-lock is missing ${packagePath}`);
  const resolved = String(entry.resolved ?? "");
  if (!resolved.startsWith("https://registry.npmjs.org/")) {
    throw new Error(`${packageName} was not resolved from the public npm registry: ${resolved}`);
  }
  if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha")) {
    throw new Error(`${packageName} registry install is missing integrity metadata`);
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
