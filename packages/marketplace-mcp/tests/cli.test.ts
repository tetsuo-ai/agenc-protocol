// The bin's informational flags. `--help` and `--version` must answer and exit
// 0 without starting the stdio server: the release smoke runs every packed bin
// with `--help` and a timeout, and a server waiting on stdin never exits.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { helpText, informationalOutput } from "../src/cli.js";
import { SERVER_VERSION } from "../src/index.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILT_BIN = join(PACKAGE_ROOT, "dist", "bin.js");

describe("informational flags", () => {
  it("answers --help and -h with usage and every environment variable", () => {
    for (const flag of ["--help", "-h"]) {
      const text = informationalOutput([flag]);
      expect(text).toBe(helpText());
      expect(text).toContain("Usage:");
      for (const name of [
        "AGENC_RPC_URL",
        "AGENC_MARKETPLACE_CLUSTER",
        "AGENC_INDEXER_URL",
        "AGENC_INDEXER_API_KEY",
        "AGENC_PROGRAM_ADDRESS",
        "AGENC_MCP_ENABLE_MUTATIONS",
      ]) {
        expect(text).toContain(name);
      }
    }
  });

  it("answers --version and -v with the package version", () => {
    for (const flag of ["--version", "-v"]) {
      expect(informationalOutput([flag])).toBe(`${SERVER_VERSION}\n`);
    }
  });

  it("starts the server for no arguments or anything else", () => {
    expect(informationalOutput([])).toBeUndefined();
    expect(informationalOutput(["--stdio"])).toBeUndefined();
    expect(informationalOutput(["serve", "--help"])).toBeUndefined();
  });
});

function runBuiltBin(args: string[], home: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      // Same shape as scripts/release-pack-smoke.mjs: stdin stays open and a
      // timeout kills a process that never exits.
      execFile(
        process.execPath,
        [BUILT_BIN, ...args],
        {
          cwd: home,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            NODE_ENV: "test",
            AGENC_RPC_URL: "http://127.0.0.1:8899",
          },
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
          resolve({ code, stdout, stderr });
        },
      );
    },
  );
}

describe("built bin", () => {
  it("exits 0 for --help and --version without starting the server", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-mcp-bin-"));
    try {
      const help = await runBuiltBin(["--help"], home);
      expect(help).toEqual({ code: 0, stdout: helpText(), stderr: "" });

      const version = await runBuiltBin(["--version"], home);
      expect(version).toEqual({ code: 0, stdout: `${SERVER_VERSION}\n`, stderr: "" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("server release identity", () => {
  it("reports the package version in serverInfo and --version", async () => {
    const manifest = JSON.parse(
      await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { version: string };
    expect(SERVER_VERSION).toBe(manifest.version);
  });
});
