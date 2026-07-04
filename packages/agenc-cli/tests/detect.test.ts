import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../src/detect.js";

function fixtureDir(): string {
  return mkdtempSync(path.join(tmpdir(), "agenc-cli-detect-"));
}

describe("detectProject", () => {
  it("detects a Next.js app (deps include next) as checkout", () => {
    const dir = fixtureDir();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "my-shop", dependencies: { next: "15.0.0", react: "19.0.0" } }),
    );
    mkdirSync(path.join(dir, "app"));
    const detected = detectProject(dir);
    expect(detected.kind).toBe("checkout");
    expect(detected.name).toBe("my-shop");
    expect(detected.nextDetected).toBe(true);
    expect(detected.appDir).toBe("app");
    expect(detected.pagesDir).toBeNull();
  });

  it("detects next in devDependencies too", () => {
    const dir = fixtureDir();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { next: "15.0.0" } }),
    );
    expect(detectProject(dir).kind).toBe("checkout");
  });

  it("finds src/app when there is no top-level app dir", () => {
    const dir = fixtureDir();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { next: "15.0.0" } }),
    );
    mkdirSync(path.join(dir, "src", "app"), { recursive: true });
    expect(detectProject(dir).appDir).toBe("src/app");
  });

  it("finds a pages dir for the pages-router fallback", () => {
    const dir = fixtureDir();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { next: "13.0.0" } }),
    );
    mkdirSync(path.join(dir, "pages"));
    const detected = detectProject(dir);
    expect(detected.appDir).toBeNull();
    expect(detected.pagesDir).toBe("pages");
  });

  it("detects a generic node project as worker", () => {
    const dir = fixtureDir();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "my-agent", dependencies: { express: "4.0.0" } }),
    );
    const detected = detectProject(dir);
    expect(detected.kind).toBe("worker");
    expect(detected.nextDetected).toBe(false);
  });

  it("handles a repo with no package.json (worker, dir-basename name)", () => {
    const dir = fixtureDir();
    const detected = detectProject(dir);
    expect(detected.kind).toBe("worker");
    expect(detected.name).toBe(path.basename(dir));
  });

  it("survives a malformed package.json", () => {
    const dir = fixtureDir();
    writeFileSync(path.join(dir, "package.json"), "{not json");
    expect(detectProject(dir).kind).toBe("worker");
  });
});
