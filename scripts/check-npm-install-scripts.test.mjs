import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { evaluateNpmInstallScriptPolicy } from "./check-npm-install-scripts.mjs";

const ROOT = new URL("../", import.meta.url);
const LOCKFILES = [
  "package-lock.json",
  "packages/marketplace-react/examples/marketplace-starter/package-lock.json",
  "packages/marketplace-react/test-apps/checkout/package-lock.json",
  "packages/marketplace-react/test-apps/next-ssr/package-lock.json",
  "packages/marketplace-react/test/playwright/package-lock.json",
  "tests-integration/package-lock.json",
];

async function repositoryProjects() {
  return new Map(
    await Promise.all(
      LOCKFILES.map(async (lockfile) => {
        const lockPath = resolve(fileURLToPath(ROOT), lockfile);
        return [
          lockfile,
          {
            lock: JSON.parse(await readFile(lockPath, "utf8")),
            manifest: JSON.parse(
              await readFile(
                resolve(dirname(lockPath), "package.json"),
                "utf8",
              ),
            ),
            npmrc: await readFile(resolve(dirname(lockPath), ".npmrc"), "utf8"),
          },
        ];
      }),
    ),
  );
}

test("every npm install script is exactly approved or explicitly denied", async () => {
  const result = evaluateNpmInstallScriptPolicy(await repositoryProjects());
  assert.deepEqual(result, {
    lockfiles: 6,
    packages: 14,
    approvals: 11,
    denials: 3,
  });
});

test("a newly introduced install script fails closed", async () => {
  const projects = await repositoryProjects();
  projects.get("package-lock.json").manifest.allowScripts = {
    ...projects.get("package-lock.json").manifest.allowScripts,
  };
  delete projects.get("package-lock.json").manifest.allowScripts[
    "esbuild@0.28.1"
  ];
  assert.throws(
    () => evaluateNpmInstallScriptPolicy(projects),
    /esbuild@0\.28\.1 has an unreviewed install script/,
  );
});

test("approvals cannot broaden and denials cannot narrow to one version", async () => {
  const broad = await repositoryProjects();
  broad.get("package-lock.json").manifest.allowScripts = Object.fromEntries(
    [
      ...Object.entries(
        broad.get("package-lock.json").manifest.allowScripts,
      ).filter(([key]) => key !== "esbuild@0.28.1"),
      ["esbuild", true],
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
  assert.throws(
    () => evaluateNpmInstallScriptPolicy(broad),
    /esbuild@0\.28\.1 has an unreviewed install script/,
  );

  const narrow = await repositoryProjects();
  narrow.get("tests-integration/package-lock.json").manifest.allowScripts = {
    "bufferutil@4.1.0": false,
    "utf-8-validate": false,
  };
  assert.throws(
    () => evaluateNpmInstallScriptPolicy(narrow),
    /bufferutil@4\.1\.0 has an unreviewed install script/,
  );
});

test("stale decisions and unsorted policy fail closed", async () => {
  const stale = await repositoryProjects();
  stale.get("package-lock.json").manifest.allowScripts = {
    ...stale.get("package-lock.json").manifest.allowScripts,
    "unused@1.0.0": true,
  };
  assert.throws(
    () => evaluateNpmInstallScriptPolicy(stale),
    /stale install-script decision unused@1\.0\.0/,
  );

  const unsorted = await repositoryProjects();
  unsorted.get("tests-integration/package-lock.json").manifest.allowScripts = {
    "utf-8-validate": false,
    bufferutil: false,
  };
  assert.throws(
    () => evaluateNpmInstallScriptPolicy(unsorted),
    /keys must be sorted/,
  );
});

test("every install root pins the enforced Node and npm toolchain", async (t) => {
  const cases = [
    {
      name: "packageManager",
      mutate(project) {
        project.manifest.packageManager = "npm@11.17.0";
      },
      error: /packageManager must be exactly npm@11\.18\.0/,
    },
    {
      name: "Node engine",
      mutate(project) {
        project.manifest.engines.node = ">=20";
      },
      error: /engines must require node >=22\.23\.1 and npm 11\.18\.0/,
    },
    {
      name: "npm engine",
      mutate(project) {
        project.manifest.engines.npm = ">=11";
      },
      error: /engines must require node >=22\.23\.1 and npm 11\.18\.0/,
    },
    {
      name: "missing npm config",
      mutate(project) {
        delete project.npmrc;
      },
      error: /colocated \.npmrc is required/,
    },
    {
      name: "global lifecycle-script bypass",
      mutate(project) {
        project.npmrc = project.npmrc.replace(
          "dangerously-allow-all-scripts=false",
          "dangerously-allow-all-scripts=true",
        );
      },
      error: /\.npmrc must set dangerously-allow-all-scripts=false/,
    },
    {
      name: "disabled engine enforcement",
      mutate(project) {
        project.npmrc = project.npmrc.replace(
          "engine-strict=true",
          "engine-strict=false",
        );
      },
      error: /\.npmrc must set engine-strict=true/,
    },
    {
      name: "disabled lifecycle enforcement",
      mutate(project) {
        project.npmrc = project.npmrc.replace(
          "strict-allow-scripts=true",
          "strict-allow-scripts=false",
        );
      },
      error: /\.npmrc must set strict-allow-scripts=true/,
    },
    {
      name: "duplicate lifecycle configuration",
      mutate(project) {
        project.npmrc += "strict-allow-scripts=false\n";
      },
      error: /duplicate \.npmrc key strict-allow-scripts/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const projects = await repositoryProjects();
      scenario.mutate(projects.get("package-lock.json"));
      assert.throws(
        () => evaluateNpmInstallScriptPolicy(projects),
        scenario.error,
      );
    });
  }
});

test("install-script package identity and registry evidence fail closed", async (t) => {
  const packagePath = "node_modules/esbuild";
  const cases = [
    {
      name: "link",
      mutate(_project, record) {
        record.link = true;
      },
      error: /must not be a link/,
    },
    {
      name: "mismatched declared name",
      mutate(_project, record) {
        record.name = "not-esbuild";
      },
      error: /does not match path-derived esbuild/,
    },
    {
      name: "missing path-derived name",
      mutate(project, record) {
        delete project.lock.packages[packagePath];
        project.lock.packages.vendor = record;
      },
      error: /has no path-derived name/,
    },
    {
      name: "version range",
      mutate(_project, record) {
        record.version = "^0.28.1";
      },
      error: /has no exact version/,
    },
    {
      name: "missing resolved URL",
      mutate(_project, record) {
        delete record.resolved;
      },
      error: /has no valid registry URL/,
    },
    {
      name: "plaintext registry URL",
      mutate(_project, record) {
        record.resolved = record.resolved.replace("https:", "http:");
      },
      error: /must resolve from https:\/\/registry\.npmjs\.org/,
    },
    {
      name: "lookalike registry host",
      mutate(_project, record) {
        record.resolved = record.resolved.replace(
          "registry.npmjs.org",
          "registry.npmjs.org.example.com",
        );
      },
      error: /must resolve from https:\/\/registry\.npmjs\.org/,
    },
    {
      name: "mismatched registry tarball name",
      mutate(_project, record) {
        record.resolved =
          "https://registry.npmjs.org/not-esbuild/-/not-esbuild-0.28.1.tgz";
      },
      error: /registry tarball path must match esbuild@0\.28\.1/,
    },
    {
      name: "mismatched registry tarball version",
      mutate(_project, record) {
        record.resolved =
          "https://registry.npmjs.org/esbuild/-/esbuild-9.9.9.tgz";
      },
      error: /registry tarball path must match esbuild@0\.28\.1/,
    },
    {
      name: "mismatched scoped registry tarball",
      packagePath: "node_modules/@swc/core",
      mutate(_project, record) {
        record.resolved =
          "https://registry.npmjs.org/@swc/not-core/-/not-core-1.15.41.tgz";
      },
      error: /registry tarball path must match @swc\/core@1\.15\.41/,
    },
    {
      name: "missing integrity",
      mutate(_project, record) {
        delete record.integrity;
      },
      error: /needs canonical sha512 integrity/,
    },
    {
      name: "noncanonical integrity",
      mutate(_project, record) {
        record.integrity = `sha256-${record.integrity.slice("sha512-".length)}`;
      },
      error: /needs canonical sha512 integrity/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const projects = await repositoryProjects();
      const project = projects.get("package-lock.json");
      const targetPath = scenario.packagePath ?? packagePath;
      scenario.mutate(project, project.lock.packages[targetPath]);
      assert.throws(
        () => evaluateNpmInstallScriptPolicy(projects),
        scenario.error,
      );
    });
  }
});
