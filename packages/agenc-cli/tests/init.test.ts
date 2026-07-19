import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { address } from "@solana/kit";
import {
  getTaskJobSpecEncoder,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import { fetchAndVerifyJobSpec } from "@tetsuo-ai/agenc-worker";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { runInit } from "../src/init.js";
import { defaultConfig, parseConfig } from "../src/config.js";
import { jobSpecStoreModule } from "../src/templates.js";

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

function expectTypeScriptSyntax(source: string, jsx = false): void {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  expect(compiled.diagnostics ?? []).toEqual([]);
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
        path.join("app", "agenc", "job-spec-store.ts"),
        path.join("app", "agenc", "job-specs", "route.ts"),
      ].sort(),
    );
    expect(result.files.every((f) => f.status === "written")).toBe(true);
    // The route uses the plain SDK orchestration, not marketplace-react.
    const route = readFileSync(path.join(dir, "app", "agenc", "checkout", "route.ts"), "utf8");
    const page = readFileSync(path.join(dir, "app", "agenc", "page.tsx"), "utf8");
    expect(route).toContain("hireAndActivate");
    expect(route).not.toContain('from "@tetsuo-ai/marketplace-react"');
    expect(route).toContain("storedJobSpec = await storeJobSpec(jobSpec)");
    expect(route.indexOf("storedJobSpec = await storeJobSpec(jobSpec)")).toBeLessThan(
      route.indexOf("await hireAndActivate"),
    );
    expect(route).not.toContain("values.descriptionHash(instructions)");
    expect(route).not.toContain("agenc://job-spec/");
    expect(route).toContain('const EXPECTED_PRICE_LAMPORTS = BigInt("1000000")');
    expect(route).not.toContain("1000000n");
    expect(page).toContain('name="checkoutSecret"');
    expect(route).toContain('form.get("checkoutSecret")');
    expect(route.indexOf("request.formData()")).toBeLessThan(
      route.indexOf("checkCheckoutAuth(request, form)"),
    );
    const store = readFileSync(path.join(dir, "app", "agenc", "job-spec-store.ts"), "utf8");
    expect(store).toContain("values.canonicalJobSpecHash(payload)");
    expect(store).toContain('"canonicalization":"json-stable-v1"');
    expect(store).toContain("AGENC_JOB_SPEC_PUBLIC_BASE_URL");
    expect(store).toContain('open(tempFile, "wx"');
    expect(store).toContain("await handle.sync()");
    expect(store).toContain("await link(tempFile, file)");
    expect(store).toContain('const directoryHandle = await open(directory, "r")');
    expect(store).toContain("await directoryHandle.sync()");
    expect(store).toContain("await syncDirectory(directory)");
    expect(store.indexOf("await unlink(tempFile);")).toBeLessThan(
      store.indexOf("await syncDirectory(directory);"),
    );
    const getRoute = readFileSync(
      path.join(dir, "app", "agenc", "job-specs", "route.ts"),
      "utf8",
    );
    expect(getRoute).toContain("readJobSpec(hash)");
    expectTypeScriptSyntax(route);
    expectTypeScriptSyntax(store);
    expectTypeScriptSyntax(getRoute);
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
    expect(result.files.map((f) => f.path)).toContain(
      path.join("pages", "api", "agenc", "job-specs.ts"),
    );
    const api = readFileSync(path.join(dir, "pages", "api", "agenc", "checkout.ts"), "utf8");
    expect(api).toContain("storedJobSpec = await storeJobSpec(jobSpec)");
    expect(api).not.toContain("agenc://job-spec/");
    expect(api).toContain('const EXPECTED_PRICE_LAMPORTS = BigInt("1000000")');
    expect(api).toContain("req.body?.checkoutSecret");
    expect(
      readFileSync(path.join(dir, "pages", "agenc.tsx"), "utf8"),
    ).toContain('name="checkoutSecret"');
    expectTypeScriptSyntax(api);
    expectTypeScriptSyntax(
      readFileSync(path.join(dir, "pages", "api", "agenc", "job-spec-store.ts"), "utf8"),
    );
    expectTypeScriptSyntax(
      readFileSync(path.join(dir, "pages", "api", "agenc", "job-specs.ts"), "utf8"),
    );
  });

  it("encodes hostile project names as inert Pages Router JSX text", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-cli-init-"));
    const hostile = '{"x"}</h1>{(()=>{throw new Error("injected")})()}<h1>';
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: hostile, dependencies: { next: "13.0.0" } }),
    );
    mkdirSync(path.join(dir, "pages"));

    runInit(dir);
    const page = readFileSync(path.join(dir, "pages", "agenc.tsx"), "utf8");
    expect(page).toContain(`<h1>{${JSON.stringify(hostile)}}</h1>`);
    expect(page).not.toContain('<h1>{"x"}</h1>{');
    expectTypeScriptSyntax(page, true);
  });

  it("generates an HTTPS envelope the stock worker verifies", async () => {
    const moduleDir = mkdtempSync(path.join(process.cwd(), "node_modules", ".agenc-store-test-"));
    const storageDir = mkdtempSync(path.join(tmpdir(), "agenc-job-spec-store-"));
    const modulePath = path.join(moduleDir, "job-spec-store.mjs");
    const previousDir = process.env.AGENC_JOB_SPEC_DIR;
    const previousBaseUrl = process.env.AGENC_JOB_SPEC_PUBLIC_BASE_URL;
    try {
      const compiled = ts.transpileModule(jobSpecStoreModule(), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        reportDiagnostics: true,
      });
      expect(compiled.diagnostics ?? []).toEqual([]);
      writeFileSync(modulePath, compiled.outputText);
      process.env.AGENC_JOB_SPEC_DIR = storageDir;
      process.env.AGENC_JOB_SPEC_PUBLIC_BASE_URL =
        "https://jobs.example/agenc/job-specs";

      const store = (await import(pathToFileURL(modulePath).href)) as {
        storeJobSpec(payload: Record<string, unknown>): Promise<{
          jobSpecHash: Uint8Array;
          jobSpecUri: string;
        }>;
      };
      const payload = { instructions: "build the verified deliverable" };
      const concurrent = await Promise.all(
        Array.from({ length: 12 }, () => store.storeJobSpec(payload)),
      );
      const hosted = concurrent[0]!;
      expect(
        concurrent.every(
          (entry) =>
            entry.jobSpecUri === hosted.jobSpecUri &&
            values.bytesToHex(entry.jobSpecHash) ===
              values.bytesToHex(hosted.jobSpecHash),
        ),
      ).toBe(true);
      expect(readdirSync(storageDir).filter((name) => name.endsWith(".tmp"))).toEqual(
        [],
      );
      const reordered = await store.storeJobSpec({
        z: { second: 2, first: 1 },
        a: "same canonical content",
      });
      const reorderedAgain = await store.storeJobSpec({
        a: "same canonical content",
        z: { first: 1, second: 2 },
      });
      expect(values.bytesToHex(reordered.jobSpecHash)).toBe(
        values.bytesToHex(reorderedAgain.jobSpecHash),
      );
      for (const suffix of ["?", "#"]) {
        process.env.AGENC_JOB_SPEC_PUBLIC_BASE_URL =
          `https://jobs.example/agenc/job-specs${suffix}`;
        await expect(
          store.storeJobSpec({ instructions: "must not publish" }),
        ).rejects.toThrow(/no query or fragment/u);
      }
      process.env.AGENC_JOB_SPEC_PUBLIC_BASE_URL =
        "https://jobs.example/agenc/job-specs";
      const envelope = readFileSync(
        path.join(storageDir, `${values.bytesToHex(hosted.jobSpecHash)}.json`),
      );
      const task = address("11111111111111111111111111111111");
      const encodedTaskJobSpec = getTaskJobSpecEncoder().encode({
        task,
        creator: task,
        jobSpecHash: hosted.jobSpecHash,
        jobSpecUri: hosted.jobSpecUri,
        createdAt: 1n,
        updatedAt: 1n,
        bump: 1,
        reserved: new Uint8Array(7),
      });

      const verified = await fetchAndVerifyJobSpec({
        task,
        readAccount: async () => new Uint8Array(encodedTaskJobSpec),
        fetchUri: async (uri) => {
          expect(uri).toBe(hosted.jobSpecUri);
          return envelope;
        },
      });
      expect(new TextDecoder().decode(verified.content)).toBe(
        values.canonicalJobSpecJson(payload),
      );
      expect(hosted.jobSpecUri).toMatch(
        /^https:\/\/jobs\.example\/agenc\/job-specs\?hash=[0-9a-f]{64}$/u,
      );
    } finally {
      if (previousDir === undefined) delete process.env.AGENC_JOB_SPEC_DIR;
      else process.env.AGENC_JOB_SPEC_DIR = previousDir;
      if (previousBaseUrl === undefined) {
        delete process.env.AGENC_JOB_SPEC_PUBLIC_BASE_URL;
      } else {
        process.env.AGENC_JOB_SPEC_PUBLIC_BASE_URL = previousBaseUrl;
      }
      rmSync(moduleDir, { recursive: true, force: true });
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it("writes a worker loop for a generic node project", () => {
    const dir = workerDir();
    const result = runInit(dir);
    expect(result.kind).toBe("worker");
    expect(existsSync(path.join(dir, "worker.mjs"))).toBe(true);
    const worker = readFileSync(path.join(dir, "worker.mjs"), "utf8");
    expect(worker).toContain("@tetsuo-ai/agenc-worker");
    expect(worker).toContain("runUp");
    expect(worker).toContain("AGENC_WORKER_MAX_REWARD_LAMPORTS");
    expect(worker).toContain("AGENC_WORKER_CREATOR_ALLOWLIST");
    expect(worker).toContain("taskThread.createContentTransport");
    expect(worker).toContain("taskThreadTransport");
    expect(() =>
      execFileSync(process.execPath, ["--check", path.join(dir, "worker.mjs")]),
    ).not.toThrow();
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
    expect(pkg.dependencies["@tetsuo-ai/marketplace-sdk"]).toBe("^0.12.0");
    expect(pkg.dependencies["@tetsuo-ai/agenc-worker"]).toBe("^0.2.0");
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

  it("accepts only canonical on-chain listing prices", () => {
    const config = defaultConfig("price-test", "checkout");
    config.listing.priceLamports = "18446744073709551615";
    expect(
      parseConfig(JSON.stringify(config), "agenc.config.json").listing.priceLamports,
    ).toBe("18446744073709551615");

    for (const priceLamports of [
      "0",
      "999",
      "0001",
      "18446744073709551616",
    ]) {
      config.listing.priceLamports = priceLamports;
      expect(() =>
        parseConfig(JSON.stringify(config), "agenc.config.json"),
      ).toThrow(/canonical decimal string/u);
    }
  });
});
