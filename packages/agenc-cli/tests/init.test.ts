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

  it("scaffolds a package.json (pinned AgenC deps) when the project has none", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-cli-init-NO-Pkg "));
    const result = runInit(dir);
    expect(result.kind).toBe("worker");
    const pkgFile = result.files.find((f) => f.path === "package.json");
    expect(pkgFile?.status).toBe("written");
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    // Name derived from the dir basename, sanitized to a valid npm name.
    expect(pkg.name).toMatch(/^[a-z0-9-._~]+$/);
    expect(pkg.private).toBe(true);
    // Deps pinned inside the support matrix so `npm install` works HERE
    // (no hoisting into an ancestor) and `agenc promote` finds the sdk.
    expect(pkg.dependencies["@tetsuo-ai/marketplace-sdk"]).toMatch(/^\^0\.11\./);
    expect(pkg.dependencies["@tetsuo-ai/agenc-worker"]).toMatch(/^\^0\.1\./);
    expect(pkg.dependencies["@solana/kit"]).toBeDefined();
    // The printed next step is a plain `npm install`.
    expect(result.instructions.some((l) => l.includes("npm install"))).toBe(true);
  });

  it("never touches an existing package.json", () => {
    const dir = workerDir(); // has its own package.json
    const before = readFileSync(path.join(dir, "package.json"), "utf8");
    const result = runInit(dir);
    expect(result.files.some((f) => f.path === "package.json")).toBe(false);
    expect(readFileSync(path.join(dir, "package.json"), "utf8")).toBe(before);
  });

  it("is idempotent after scaffolding a package.json (second run leaves it alone)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-cli-init-"));
    runInit(dir);
    // User customizes the scaffolded file…
    const pkgPath = path.join(dir, "package.json");
    const customized = JSON.parse(readFileSync(pkgPath, "utf8"));
    customized.dependencies.express = "^5.0.0";
    writeFileSync(pkgPath, JSON.stringify(customized, null, 2));
    // …and a re-run (even --force) does not plan package.json at all.
    const second = runInit(dir, { force: true });
    expect(second.refused).toBe(false);
    expect(second.files.some((f) => f.path === "package.json")).toBe(false);
    const after = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(after.dependencies.express).toBe("^5.0.0");
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
