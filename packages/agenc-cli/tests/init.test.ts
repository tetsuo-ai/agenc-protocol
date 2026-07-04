import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/init.js";
import { parseConfig } from "../src/config.js";

function nextAppDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agenc-cli-init-"));
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "my-shop", dependencies: { next: "15.0.0" } }),
  );
  mkdirSync(path.join(dir, "app"));
  return dir;
}

function workerDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agenc-cli-init-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "my-agent" }));
  return dir;
}

describe("runInit", () => {
  it("writes the checkout surface for a Next.js app-router project", () => {
    const dir = nextAppDir();
    const result = runInit(dir);
    expect(result.kind).toBe("checkout");
    expect(result.refused).toBe(false);
    const written = result.files.map((f) => f.path).sort();
    expect(written).toEqual(
      [
        "agenc.config.json",
        path.join("app", "agenc", "page.tsx"),
        path.join("app", "agenc", "checkout", "route.ts"),
      ].sort(),
    );
    expect(result.files.every((f) => f.status === "written")).toBe(true);
    // The route uses the plain SDK orchestration, not marketplace-react.
    const route = readFileSync(path.join(dir, "app", "agenc", "checkout", "route.ts"), "utf8");
    expect(route).toContain("hireAndActivate");
    expect(route).not.toContain('from "@tetsuo-ai/marketplace-react"');
    // The config parses back and carries the project name.
    const config = parseConfig(readFileSync(path.join(dir, "agenc.config.json"), "utf8"), "agenc.config.json");
    expect(config.name).toBe("my-shop");
    expect(config.kind).toBe("checkout");
  });

  it("falls back to the pages router when there is no app dir", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-cli-init-"));
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "legacy", dependencies: { next: "13.0.0" } }),
    );
    mkdirSync(path.join(dir, "pages"));
    const result = runInit(dir);
    expect(result.files.map((f) => f.path)).toContain(path.join("pages", "agenc.tsx"));
    expect(result.files.map((f) => f.path)).toContain(
      path.join("pages", "api", "agenc", "checkout.ts"),
    );
  });

  it("writes a worker loop for a generic node project", () => {
    const dir = workerDir();
    const result = runInit(dir);
    expect(result.kind).toBe("worker");
    expect(existsSync(path.join(dir, "worker.mjs"))).toBe(true);
    const worker = readFileSync(path.join(dir, "worker.mjs"), "utf8");
    expect(worker).toContain("@tetsuo-ai/agenc-worker");
    expect(worker).toContain("runUp");
  });

  it("--kind overrides detection", () => {
    const dir = nextAppDir();
    const result = runInit(dir, { kind: "worker" });
    expect(result.kind).toBe("worker");
    expect(existsSync(path.join(dir, "worker.mjs"))).toBe(true);
    expect(existsSync(path.join(dir, "app", "agenc"))).toBe(false);
  });

  it("is idempotent: a second run reports every file unchanged", () => {
    const dir = nextAppDir();
    runInit(dir);
    const second = runInit(dir);
    expect(second.refused).toBe(false);
    expect(second.files.every((f) => f.status === "unchanged")).toBe(true);
  });

  it("refuses to overwrite differing files without --force", () => {
    const dir = nextAppDir();
    runInit(dir);
    const pagePath = path.join(dir, "app", "agenc", "page.tsx");
    writeFileSync(pagePath, "// user edited this\n");
    const result = runInit(dir);
    expect(result.refused).toBe(true);
    const page = result.files.find((f) => f.path === path.join("app", "agenc", "page.tsx"));
    expect(page?.status).toBe("refused");
    // The user's edit survived.
    expect(readFileSync(pagePath, "utf8")).toBe("// user edited this\n");
    // And --force overwrites it.
    const forced = runInit(dir, { force: true });
    expect(forced.refused).toBe(false);
    expect(readFileSync(pagePath, "utf8")).not.toBe("// user edited this\n");
  });

  it("preserves tuned config values on re-run", () => {
    const dir = workerDir();
    runInit(dir);
    const configPath = path.join(dir, "agenc.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.listing.priceLamports = "5000000";
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const result = runInit(dir, { force: true });
    expect(result.refused).toBe(false);
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(after.listing.priceLamports).toBe("5000000");
  });
});
