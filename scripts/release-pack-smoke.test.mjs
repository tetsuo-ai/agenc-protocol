import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  collectPackSmokePlan,
  smokePackedArtifact,
} from "./release-pack-smoke.mjs";

const execFile = promisify(execFileCallback);

const train = JSON.parse(
  await readFile(new URL("../release-train.json", import.meta.url)),
);

test("every release route has a generic plan covering all declared exports, entrypoints, and bins", async () => {
  for (const entry of train.packages) {
    const manifest = JSON.parse(
      await readFile(
        new URL(`../${entry.directory}/package.json`, import.meta.url),
      ),
    );
    const plan = collectPackSmokePlan(manifest);
    const declared = JSON.stringify({
      exports: manifest.exports,
      main: manifest.main,
      module: manifest.module,
      bin: manifest.bin,
    });
    assert.ok(
      plan.files.length > 0,
      `${entry.id} has no packed files to smoke`,
    );
    for (const file of plan.files)
      assert.match(
        declared,
        new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    if (entry.id === "react") {
      assert.ok(
        plan.executions.some(
          ({ specifier }) =>
            specifier === "@tetsuo-ai/marketplace-react/tailwind-preset",
        ),
        "React's dependency-optional Tailwind preset is not clean-load smoked",
      );
    }
    if (manifest.bin)
      assert.ok(plan.bins.length > 0, `${entry.id} bin is not exercised`);
  }
});

test("pack smoke planning rejects traversal and malformed surface declarations", () => {
  assert.throws(
    () =>
      collectPackSmokePlan({
        name: "example",
        version: "1.0.0",
        exports: { ".": "../outside.js" },
      }),
    /package-relative/,
  );
  assert.throws(
    () =>
      collectPackSmokePlan({
        name: "example",
        version: "1.0.0",
        bin: { "bad/name": "./bin.js" },
      }),
    /invalid package bin name/,
  );
});

test("direct and nested runtime exports are executed with their advertised semantics", () => {
  const direct = collectPackSmokePlan({
    name: "direct-export",
    version: "1.0.0",
    type: "module",
    exports: {
      "./cli": "./dist/cli.js",
    },
  });
  assert.deepEqual(direct.executions, [
    { kind: "import", specifier: "direct-export/cli" },
  ]);

  const conditional = collectPackSmokePlan({
    name: "conditional-export",
    version: "1.0.0",
    type: "module",
    exports: {
      ".": {
        import: {
          types: "./dist/index.d.ts",
          default: "./dist/index.js",
        },
        require: {
          types: "./dist/index.d.cts",
          default: "./dist/index.cjs",
        },
      },
    },
  });
  assert.deepEqual(conditional.executions, [
    { kind: "import", specifier: "conditional-export" },
    { kind: "require", specifier: "conditional-export" },
  ]);
  assert.deepEqual(conditional.files, [
    "dist/index.cjs",
    "dist/index.d.cts",
    "dist/index.d.ts",
    "dist/index.js",
  ]);
});

async function packFixture(root, { name, moduleSource, binSource }) {
  const directory = join(root, name);
  await mkdir(directory);
  const manifest = {
    name,
    version: "1.0.0",
    type: "module",
    exports: { "./probe": "./probe.js" },
    files: ["probe.js", ...(binSource === undefined ? [] : ["bin.js"])],
    ...(binSource === undefined ? {} : { bin: { fixture: "./bin.js" } }),
  };
  await Promise.all([
    writeFile(join(directory, "package.json"), `${JSON.stringify(manifest)}\n`),
    writeFile(join(directory, "probe.js"), moduleSource),
    ...(binSource === undefined
      ? []
      : [writeFile(join(directory, "bin.js"), binSource, { mode: 0o755 })]),
  ]);
  const { stdout } = await execFile(
    "npm",
    ["pack", "--ignore-scripts", "--json"],
    { cwd: directory, encoding: "utf8" },
  );
  const packed = JSON.parse(stdout);
  assert.equal(packed.length, 1);
  return {
    name,
    tarballPath: join(directory, packed[0].filename),
  };
}

test("packed module loads reject observable side effects while bin help may print", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agenc-pack-smoke-regression-"));
  try {
    await t.test("successful module stdout is rejected", async () => {
      const fixture = await packFixture(root, {
        name: "loud-module-export",
        moduleSource:
          'console.log("unexpected output");\nexport const ok = true;\n',
      });
      await assert.rejects(
        smokePackedArtifact({
          ...fixture,
          expectedName: fixture.name,
          expectedVersion: "1.0.0",
        }),
        /packed module load wrote to stdout or stderr/,
      );
    });

    await t.test(
      "successful module exitCode mutation is rejected",
      async () => {
        const fixture = await packFixture(root, {
          name: "exit-code-module-export",
          moduleSource: "process.exitCode = 0;\nexport const ok = true;\n",
        });
        await assert.rejects(
          smokePackedArtifact({
            ...fixture,
            expectedName: fixture.name,
            expectedVersion: "1.0.0",
          }),
          /packed module load changed process\.exitCode/,
        );
      },
    );

    await t.test("successful process.exit call is rejected", async () => {
      const fixture = await packFixture(root, {
        name: "process-exit-module-export",
        moduleSource: "process.exit(0);\nexport const ok = true;\n",
      });
      await assert.rejects(
        smokePackedArtifact({
          ...fixture,
          expectedName: fixture.name,
          expectedVersion: "1.0.0",
        }),
        /packed module load called process\.exit\(0\)/,
      );
    });

    await t.test("bin help output is permitted", async () => {
      const fixture = await packFixture(root, {
        name: "quiet-module-loud-bin",
        moduleSource: "export const ok = true;\n",
        binSource: '#!/usr/bin/env node\nconsole.log("fixture help");\n',
      });
      const plan = await smokePackedArtifact({
        ...fixture,
        expectedName: fixture.name,
        expectedVersion: "1.0.0",
      });
      assert.deepEqual(plan.executions, [
        { kind: "import", specifier: "quiet-module-loud-bin/probe" },
      ]);
      assert.deepEqual(plan.bins, [{ name: "fixture", target: "bin.js" }]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
