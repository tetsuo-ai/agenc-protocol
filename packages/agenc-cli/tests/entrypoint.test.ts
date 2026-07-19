import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

beforeAll(async () => {
  await execFile("npm", ["run", "build"], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
});

async function runNode(args: readonly string[]) {
  return execFile(process.execPath, [...args], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("published CLI entrypoints", () => {
  it("loads the explicit CLI export without output or process execution", async () => {
    for (const args of [
      [
        "--input-type=module",
        "--eval",
        'await import("@tetsuo-ai/agenc-cli/cli");',
      ],
      ["--eval", 'require("@tetsuo-ai/agenc-cli/cli");'],
    ]) {
      const result = await runNode(args);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  });

  it("keeps the agenc executable wired to a successful help command", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { bin?: { agenc?: string } };
    expect(manifest.bin?.agenc).toBe("./dist/bin.js");

    const result = await runNode([
      path.resolve(packageRoot, manifest.bin?.agenc ?? ""),
      "--help",
    ]);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("agenc — init/dev/promote");
    expect(result.stdout).toContain("USAGE");
  });
});
