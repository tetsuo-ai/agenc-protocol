import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
import {
  appCheckoutPage,
  checkoutCoreModule,
  checkoutPolicyModule,
  jobSpecStoreModule,
  npmPackageName,
  pagesCheckoutPage,
  walletFileModule,
  workerLoopMjs,
} from "../src/templates.js";

describe("npmPackageName", () => {
  it("normalizes hostile and very long names with bounded output", () => {
    expect(npmPackageName("  ...My Package///Name---  ")).toBe("my-package-name");
    expect(npmPackageName("---.___")).toBe("agenc-project");
    expect(npmPackageName(`${"a".repeat(213)} ! b`)).toBe(`${"a".repeat(213)}-`);
    expect(npmPackageName(`${"a".repeat(213)}${"-".repeat(50)}`)).toBe(
      "a".repeat(213),
    );
    expect(npmPackageName("x".repeat(1_000_000))).toHaveLength(214);
  });
});

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

function nearestNodeModulesDir(start = process.cwd()): string {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, "node_modules");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`no node_modules directory found above ${start}`);
    }
    current = parent;
  }
}

function moduleTempDir(prefix: string): string {
  return mkdtempSync(path.join(nearestNodeModulesDir(), prefix));
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
  it("keeps generated debit allocations and finality gates pinned", () => {
    const core = checkoutCoreModule(defaultConfig("checkout-size-test", "checkout"));
    const programState = readFileSync(
      new URL("../../../programs/agenc-coordination/src/state.rs", import.meta.url),
      "utf8",
    );
    const pinnedSize = (account: string): string => {
      const match = programState.match(
        new RegExp(`assert!\\(${account}::SIZE == (\\d+)\\)`),
      );
      expect(match, account + " must have an exact compile-time size pin").not.toBeNull();
      return match![1]!;
    };

    expect(core).toContain(pinnedSize("Task") + "n");
    expect(core).toContain(pinnedSize("TaskJobSpec") + "n");
    expect(core).toContain("BigInt(getTaskEscrowSize())");
    expect(core).toContain("BigInt(getHireRecordSize())");
    expect(core).toContain("BigInt(getTaskValidationConfigSize())");
    expect(core).toContain("BigInt(getAuthorityRateLimitSize())");
    expect(core).not.toContain("fetchMaybeAuthorityRateLimit");
    expect(core).toContain(
      'getMinimumBalanceForRentExemption(size, { commitment: "finalized" })',
    );
    expect(core).toContain(
      'fetchMaybeTask(rpc, taskPda, { commitment: "finalized" })',
    );
    expect(core).toContain(
      'fetchServiceListing(rpc, listing, { commitment: "finalized" })',
    );
    expect(core).not.toContain("getSignaturesForAddress");
    expect(core).toContain(
      'return { phase: "moderating", taskPda, hireSignature: "", hireReconciled: true }',
    );
    expect(core).toContain('hireSignature: result.hireSignature === "" ? null');
    expect(core).toContain("creator: signer.address");
    expect(core).toContain("clusterIdentity,");
    expect(core).not.toContain("rpcUrl: input.rpcUrl");
    expect(core).not.toContain("attestorUrl: input.attestorUrl");
    expect(core).toContain('new URL(requiredEnv("AGENC_RPC_URL")).toString()');
    expect(core).toContain("signer.address === moderator");
    expect(core).toContain("separate attestor-funded wallet");
    expect(core).toContain('new URL("/v1/info", endpoint)');
    expect(core).toContain("await verifyAttestorModerator(attestorUrl, moderator)");
    expect(core).toContain("local attestor identity does not match AGENC_MODERATOR");
    expect(core).toContain('operator = parsedAddress("AGENC_OPERATOR")');
    expect(core).toContain("live.operatorFeeBps !== EXPECTED_OPERATOR_FEE_BPS");
    expect(core).toContain("live.defaultDeadlineSecs !== EXPECTED_DEFAULT_DEADLINE_SECS");
    expect(core).toContain("live.requiredCapabilities !== EXPECTED_REQUIRED_CAPABILITIES");
    expect(core).toContain(': await storeJobSpec(jobSpec);');
    expect(core).toContain("a committed hire exists, but job-spec readback failed");
    expect(core).toContain("the hire outcome remains ambiguous and job-spec readback failed");
    expect(core).toContain('commitment: "finalized" });');
    expect(core).toContain("error instanceof AgencError && error.signature === null");
    expect(core).toContain("hire was not submitted; fix the RPC/signing failure");
    expect(core).toContain("if (!admission.checkpoint(recovery()))");
    expect(core).toContain("checkout ownership expired before hire submission");
    expect(core).toContain("hire committed but moderation/activation is incomplete");
    expect(core).toContain("generated local-only checkout refuses public Solana cluster");
    expect(core).toContain("validRecoveryKind");
    expect(core).toContain(
      'fetchMaybeTaskJobSpec(rpc, jobSpecPda, { commitment: "finalized" })',
    );

    const maximum = defaultConfig("max-price", "checkout");
    maximum.listing.priceLamports = "18446744073709551615";
    for (const page of [appCheckoutPage(maximum), pagesCheckoutPage(maximum)]) {
      expect(page).toContain("18446744073.709551615");
      expect(page).not.toContain("Number(");
    }
    const zeroFees = defaultConfig("zero-fees", "checkout");
    zeroFees.listing.operatorFeeBps = 0;
    zeroFees.listing.referrerFeeBps = 0;
    for (const page of [appCheckoutPage(zeroFees), pagesCheckoutPage(zeroFees)]) {
      expect(page).toContain(
        "Settlement pays the worker and applies the current on-chain protocol fee terms.",
      );
      expect(page).not.toContain("operator payee leg");
      expect(page).not.toContain("referrer payee leg");
    }
  });

  it("executes generated checkout term guards and same-intent recovery failover", async () => {
    const moduleDir = moduleTempDir(".agenc-core-template-test-");
    const savedEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    const globals = globalThis as typeof globalThis & {
      __agencCoreSigner?: string;
      __agencCoreGenesis?: unknown;
      __agencCoreLiveListing?: Record<string, unknown>;
      __agencCoreMode?: string;
      __agencCoreHostBase?: string;
      __agencCoreStoreCalls?: string[];
      __agencCoreVerifyCalls?: string[];
      __agencCoreHireCalls?: number;
      __agencCoreResumeCalls?: number;
      __agencCoreAttestationCalls?: number;
      __agencCoreModeration?: Record<string, unknown>;
      __agencCoreInfoModerator?: string;
      __agencCoreTaskExists?: boolean;
    };
    const writePackage = (
      name: string,
      files: Record<string, string>,
      exports: string | Record<string, string> = "./index.js",
    ): void => {
      const packageDir = path.join(moduleDir, "node_modules", ...name.split("/"));
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name, type: "module", exports }),
      );
      for (const [file, source] of Object.entries(files)) {
        writeFileSync(path.join(packageDir, file), source);
      }
    };
    const CREATOR = "11111111111111111111111111111111";
    const MODERATOR = "So11111111111111111111111111111111111111112";
    const LISTING = "SysvarRent111111111111111111111111111111111";
    const PROVIDER = "Vote111111111111111111111111111111111111111";
    const OPERATOR = "SysvarC1ock11111111111111111111111111111111";
    const SPEC_HEX = "09".repeat(32);
    try {
      writePackage("@solana/kit", {
        "index.js": `export function address(value) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("invalid address");
  return value;
}
export function isNone(value) { return value === null; }
export async function createKeyPairSignerFromBytes() { return { address: globalThis.__agencCoreSigner }; }
export function createSolanaRpc(url) {
  return {
    url,
    getGenesisHash() { return { send: async () => globalThis.__agencCoreGenesis }; },
    getMinimumBalanceForRentExemption() { return { send: async () => 10n }; }
  };
}
`,
      });
      writePackage(
        "@tetsuo-ai/marketplace-sdk",
        {
          "index.js": `export const ListingState = { Active: "active" };
export class AgencError extends Error {
  constructor(message, options = {}) { super(message); this.signature = options.signature ?? null; }
}
export class HireAndActivateError extends Error {
  constructor(progress) { super("post-hire failure"); this.progress = progress; }
}
export function createMarketplaceClient(input) { return { ...input }; }
export async function fetchServiceListing() { return { data: globalThis.__agencCoreLiveListing }; }
export async function fetchMaybeTask() {
  return globalThis.__agencCoreTaskExists
    ? { exists: true, data: { creator: globalThis.__agencCoreSigner, taskId: new Uint8Array(32).fill(7), rewardAmount: 1000000n, referrerFeeBps: 0 } }
    : { exists: false };
}
export async function fetchMaybeTaskJobSpec() { return { exists: false }; }
export async function findTaskPda() { return ["task-pda"]; }
export async function findTaskJobSpecPda() { return ["job-spec-pda"]; }
export async function findTaskModerationPda() { return ["task-moderation-pda"]; }
export function getAuthorityRateLimitSize() { return 67; }
export function getHireRecordSize() { return 173; }
export function getTaskEscrowSize() { return 58; }
export function getTaskValidationConfigSize() { return 105; }
export const values = {
  hexToBytes(hex) { return Uint8Array.from(hex.match(/../g).map((part) => Number.parseInt(part, 16))); },
  bytesToHex(bytes) { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); },
  randomId32() { return new Uint8Array(32).fill(7); }
};
export async function hireAndActivate(_client, input) {
  globalThis.__agencCoreHireCalls += 1;
  if (globalThis.__agencCoreMode === "pre-submit") {
    throw new AgencError("blockhash unavailable", { signature: null });
  }
  if (globalThis.__agencCoreMode === "unknown-after-send") {
    throw new Error("transport outcome unknown");
  }
  if (globalThis.__agencCoreMode === "fail-moderating") {
    throw new HireAndActivateError({ phase: "moderating", taskPda: "task-pda", hireSignature: "sig-hire" });
  }
  const moderation = await input.hostAndModerateJobSpec({ taskPda: "task-pda" });
  globalThis.__agencCoreModeration = moderation;
  return { taskPda: "task-pda", hireSignature: "sig-hire", activationSignature: "sig-activate", activationReconciled: false, moderation: moderation.moderation };
}
export async function resumeHireAndActivate(_client, input, progress) {
  globalThis.__agencCoreResumeCalls += 1;
  const moderation = await input.hostAndModerateJobSpec({ taskPda: progress.taskPda });
  globalThis.__agencCoreModeration = moderation;
  return { taskPda: progress.taskPda, hireSignature: progress.hireSignature, hireReconciled: progress.hireReconciled, activationSignature: "sig-activate", activationReconciled: false, moderation: moderation.moderation };
}
`,
          "sandbox.js": `export async function requestSandboxAttestation() {
  globalThis.__agencCoreAttestationCalls += 1;
  return { signature: "attestation-signature" };
}
`,
        },
        { ".": "./index.js", "./sandbox": "./sandbox.js" },
      );
      writeFileSync(
        path.join(moduleDir, "job-spec-store.mjs"),
        `export async function storeJobSpec() {
  const uri = globalThis.__agencCoreHostBase + "?hash=${SPEC_HEX}";
  globalThis.__agencCoreStoreCalls.push(uri);
  return { jobSpecHash: new Uint8Array(32).fill(9), jobSpecUri: uri };
}
export async function verifyPublishedJobSpec(stored) { globalThis.__agencCoreVerifyCalls.push(stored.jobSpecUri); }
`,
      );
      writeFileSync(
        path.join(moduleDir, "wallet-file.mjs"),
        "export function loadWalletFile() { return new Uint8Array(64); }\n",
      );
      const transpiled = ts.transpileModule(
        checkoutCoreModule(defaultConfig("runtime-checkout", "checkout")),
        {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
          },
          reportDiagnostics: true,
        },
      );
      expect(transpiled.diagnostics ?? []).toEqual([]);
      const corePath = path.join(moduleDir, "checkout-core.mjs");
      writeFileSync(
        corePath,
        transpiled.outputText
          .replace('"./job-spec-store"', '"./job-spec-store.mjs"')
          .replace('"./wallet-file"', '"./wallet-file.mjs"'),
      );

      Object.assign(process.env, {
        AGENC_RPC_URL: "http://127.0.0.1:8899",
        AGENC_WALLET: "/private/creator.json",
        AGENC_LISTING: LISTING,
        AGENC_PROVIDER_AGENT: PROVIDER,
        AGENC_OPERATOR: OPERATOR,
        AGENC_MODERATOR: MODERATOR,
        AGENC_LISTING_SPEC_HASH: SPEC_HEX,
        AGENC_ATTESTOR_URL: "http://127.0.0.1:4401/v1/attest",
        AGENC_CHECKOUT_MAX_DEBIT_LAMPORTS: "2000000",
        AGENC_CHECKOUT_TX_FEE_BUDGET_LAMPORTS: "100",
      });
      globals.__agencCoreSigner = CREATOR;
      globals.__agencCoreGenesis = "11111111111111111111111111111112";
      globals.__agencCoreHostBase = "https://old-host.example/agenc/job-specs";
      globals.__agencCoreStoreCalls = [];
      globals.__agencCoreVerifyCalls = [];
      globals.__agencCoreHireCalls = 0;
      globals.__agencCoreResumeCalls = 0;
      globals.__agencCoreAttestationCalls = 0;
      globals.__agencCoreInfoModerator = MODERATOR;
      globals.__agencCoreTaskExists = false;
      const reviewedListing = {
        providerAgent: PROVIDER,
        operator: OPERATOR,
        operatorFeeBps: 1000,
        defaultDeadlineSecs: 3600n,
        requiredCapabilities: 1n,
        state: "active",
        price: 1_000_000n,
        priceMint: null,
        specHash: new Uint8Array(32).fill(9),
        version: 7n,
      };
      globals.__agencCoreLiveListing = { ...reviewedListing };
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({ moderator: globals.__agencCoreInfoModerator }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const core = (await import(pathToFileURL(corePath).href)) as {
        executeCheckout(
          instructions: string,
          referrer: string,
          admission: Record<string, unknown>,
        ): Promise<{ status: number; body: Record<string, unknown> }>;
      };
      const makeAdmission = (
        recovery: unknown = undefined,
        bind: (fingerprint: string) => boolean = () => true,
      ) => {
        const state: { recovery: unknown; completed?: Record<string, unknown>; aborted: number } = {
          recovery,
          aborted: 0,
        };
        return {
          state,
          admission: {
            ok: true,
            recovery,
            bindIntent: bind,
            checkpoint(value: unknown) { state.recovery = value; return true; },
            preserve(value: unknown) { state.recovery = value; },
            complete(value: Record<string, unknown>) { state.completed = value; },
            abort() { state.aborted += 1; },
          },
        };
      };

      globals.__agencCoreGenesis = null;
      const malformedCluster = makeAdmission();
      await expect(
        core.executeCheckout("reject malformed genesis", "", malformedCluster.admission),
      ).resolves.toMatchObject({
        status: 503,
        body: { error: expect.stringContaining("identity could not be verified") },
      });
      expect(malformedCluster.state.aborted).toBe(1);
      expect(globals.__agencCoreHireCalls).toBe(0);

      globals.__agencCoreGenesis =
        "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
      const publicCluster = makeAdmission();
      await expect(
        core.executeCheckout("must stay local", "", publicCluster.admission),
      ).resolves.toMatchObject({
        status: 503,
        body: { error: expect.stringContaining("mainnet-beta") },
      });
      expect(publicCluster.state.aborted).toBe(1);
      expect(globals.__agencCoreHireCalls).toBe(0);
      globals.__agencCoreGenesis = "11111111111111111111111111111112";

      globals.__agencCoreSigner = MODERATOR;
      const split = makeAdmission();
      await expect(core.executeCheckout("work", "", split.admission)).resolves.toMatchObject({
        status: 503,
        body: { error: expect.stringContaining("separate attestor-funded wallet") },
      });
      expect(split.state.aborted).toBe(1);
      globals.__agencCoreSigner = CREATOR;

      for (const [field, value] of [
        ["operator", CREATOR],
        ["operatorFeeBps", 999],
        ["defaultDeadlineSecs", 3599n],
        ["requiredCapabilities", 2n],
      ] as const) {
        globals.__agencCoreLiveListing = { ...reviewedListing, [field]: value };
        const guarded = makeAdmission();
        await expect(
          core.executeCheckout("reviewed terms", "", guarded.admission),
        ).resolves.toMatchObject({ status: 409 });
      }
      expect(globals.__agencCoreHireCalls).toBe(0);
      globals.__agencCoreLiveListing = { ...reviewedListing };

      const staleOwnership = makeAdmission();
      staleOwnership.admission.checkpoint = () => false;
      await expect(
        core.executeCheckout("stale pre-broadcast owner", "", staleOwnership.admission),
      ).resolves.toMatchObject({
        status: 409,
        body: { error: expect.stringContaining("no transaction was sent") },
      });
      expect(globals.__agencCoreHireCalls).toBe(0);

      globals.__agencCoreMode = "pre-submit";
      const preSubmit = makeAdmission();
      await expect(
        core.executeCheckout("retryable pre-submit failure", "", preSubmit.admission),
      ).resolves.toMatchObject({
        status: 503,
        body: { error: expect.stringContaining("hire was not submitted") },
      });
      expect(preSubmit.state.aborted).toBe(1);
      expect(globals.__agencCoreHireCalls).toBe(1);
      globals.__agencCoreStoreCalls = [];
      globals.__agencCoreVerifyCalls = [];

      globals.__agencCoreMode = "unknown-after-send";
      globals.__agencCoreTaskExists = true;
      const reconciledHire = makeAdmission();
      await expect(
        core.executeCheckout("reconcile finalized hire", "", reconciledHire.admission),
      ).resolves.toMatchObject({
        status: 503,
        body: {
          error: expect.stringContaining("hire committed"),
          task: "task-pda",
          phase: "moderating",
        },
      });
      expect(reconciledHire.state.recovery).toMatchObject({
        progress: {
          phase: "moderating",
          hireSignature: "",
          hireReconciled: true,
        },
      });
      globals.__agencCoreTaskExists = false;
      globals.__agencCoreHireCalls = 0;
      globals.__agencCoreStoreCalls = [];
      globals.__agencCoreVerifyCalls = [];

      let fingerprint: string | undefined;
      globals.__agencCoreMode = "fail-moderating";
      const first = makeAdmission(undefined, (value) => {
        fingerprint = value;
        return true;
      });
      await expect(
        core.executeCheckout("same canonical work", "", first.admission),
      ).resolves.toMatchObject({ status: 503, body: { phase: "moderating" } });
      expect(first.state.recovery).toMatchObject({
        expectedVersion: 7n,
        progress: { phase: "moderating", hireSignature: "sig-hire" },
      });
      expect(globals.__agencCoreStoreCalls).toEqual([
        `https://old-host.example/agenc/job-specs?hash=${SPEC_HEX}`,
      ]);

      process.env.AGENC_RPC_URL = "http://localhost:8899";
      process.env.AGENC_ATTESTOR_URL = "http://localhost:4402/v1/attest";
      globals.__agencCoreHostBase = "https://new-host.example/api/agenc/job-specs";
      globals.__agencCoreMode = "resume";
      globals.__agencCoreInfoModerator = CREATOR;
      const wrongIdentity = makeAdmission(first.state.recovery, (value) => value === fingerprint);
      await expect(
        core.executeCheckout("same canonical work", "", wrongIdentity.admission),
      ).resolves.toMatchObject({ status: 503 });
      expect(globals.__agencCoreAttestationCalls).toBe(0);
      expect(wrongIdentity.state.recovery).toMatchObject({
        progress: { phase: "moderating" },
        storedJobSpec: {
          jobSpecUri: `https://new-host.example/api/agenc/job-specs?hash=${SPEC_HEX}`,
        },
      });

      globals.__agencCoreInfoModerator = MODERATOR;
      const resumed = makeAdmission(
        wrongIdentity.state.recovery,
        (value) => value === fingerprint,
      );
      await expect(
        core.executeCheckout("same canonical work", "", resumed.admission),
      ).resolves.toMatchObject({ status: 200 });
      expect(globals.__agencCoreHireCalls).toBe(1);
      expect(globals.__agencCoreResumeCalls).toBe(2);
      expect(globals.__agencCoreAttestationCalls).toBe(1);
      expect(globals.__agencCoreModeration).toMatchObject({
        jobSpecUri: `https://new-host.example/api/agenc/job-specs?hash=${SPEC_HEX}`,
        moderator: MODERATOR,
      });
      expect(resumed.state.completed).toMatchObject({
        task: "task-pda",
        hireSignature: "sig-hire",
      });
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
      for (const key of Object.keys(globals)) {
        if (key.startsWith("__agencCore")) delete (globals as Record<string, unknown>)[key];
      }
      rmSync(moduleDir, { recursive: true, force: true });
    }
  });

  it("writes the checkout surface for a Next.js app-router project", () => {
    const dir = nextAppDir();
    const result = runInit(dir);
    expect(result.kind).toBe("checkout");
    expect(result.refused).toBe(false);
    const written = result.files.map((f) => f.path).sort();
    expect(written).toEqual(
      [
        "agenc.config.json",
        path.join("app", "agenc", "checkout-core.ts"),
        path.join("app", "agenc", "page.tsx"),
        path.join("app", "agenc", "checkout", "route.ts"),
        path.join("app", "agenc", "checkout-policy.ts"),
        path.join("app", "agenc", "job-spec-store.ts"),
        path.join("app", "agenc", "job-specs", "route.ts"),
        path.join("app", "agenc", "wallet-file.ts"),
      ].sort(),
    );
    expect(result.files.every((f) => f.status === "written")).toBe(true);
    // The route uses the plain SDK orchestration, not marketplace-react.
    const route = readFileSync(path.join(dir, "app", "agenc", "checkout", "route.ts"), "utf8");
    const core = readFileSync(path.join(dir, "app", "agenc", "checkout-core.ts"), "utf8");
    const page = readFileSync(path.join(dir, "app", "agenc", "page.tsx"), "utf8");
    expect(core).toContain("hireAndActivate");
    expect(route).not.toContain('from "@tetsuo-ai/marketplace-react"');
    expect(core).toContain("await storeJobSpec(jobSpec)");
    expect(core.indexOf("await storeJobSpec(jobSpec)")).toBeLessThan(
      core.indexOf("await hireAndActivate"),
    );
    expect(route).not.toContain("values.descriptionHash(instructions)");
    expect(route).not.toContain("agenc://job-spec/");
    expect(core).toContain('const EXPECTED_PRICE_LAMPORTS = BigInt("1000000")');
    expect(route).not.toContain("1000000n");
    expect(page).not.toContain('name="checkoutSecret"');
    expect(page).toContain("Funded checkout is disabled by default");
    expect(route).not.toContain("request.formData()");
    expect(route.indexOf("admitCheckout(request.headers")).toBeLessThan(
      route.indexOf("readCheckoutBody(request)"),
    );
    expect(route).toContain("MAX_BODY_BYTES = 16 * 1024");
    expect(core).toContain("fetchServiceListing");
    expect(core).toContain("providerAgent");
    expect(core).toContain("resumeHireAndActivate");
    expect(core).toContain("verifyPublishedJobSpec");
    expectTypeScriptSyntax(core);
    const store = readFileSync(path.join(dir, "app", "agenc", "job-spec-store.ts"), "utf8");
    expect(store).toContain("values.canonicalJobSpecHash(payload)");
    expect(store).toContain('"canonicalization":"json-stable-v1"');
    expect(store).toContain("AGENC_JOB_SPEC_PUBLIC_BASE_URL");
    expect(store).toContain('open(tempFile, "wx"');
    expect(store).toContain("await handle.sync()");
    expect(store).toContain("await link(tempFile, file)");
    expect(store).toContain("constants.O_DIRECTORY | constants.O_NOFOLLOW");
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
    expectTypeScriptSyntax(
      readFileSync(path.join(dir, "app", "agenc", "checkout-policy.ts"), "utf8"),
    );
    expectTypeScriptSyntax(
      readFileSync(path.join(dir, "app", "agenc", "wallet-file.ts"), "utf8"),
    );
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
    const core = readFileSync(path.join(dir, "lib", "agenc", "checkout-core.ts"), "utf8");
    expect(api).toContain("executeCheckout");
    expect(core).toContain("await storeJobSpec(jobSpec)");
    expect(api).not.toContain("agenc://job-spec/");
    expect(core).toContain('const EXPECTED_PRICE_LAMPORTS = BigInt("1000000")');
    expect(api).not.toContain("req.body");
    expect(api).toContain("bodyParser: false");
    expect(api.indexOf("admitCheckout(requestHeaders(req)")).toBeLessThan(
      api.indexOf("readCheckoutBody(req)"),
    );
    expect(
      readFileSync(path.join(dir, "pages", "agenc.tsx"), "utf8"),
    ).not.toContain('name="checkoutSecret"');
    expectTypeScriptSyntax(api);
    expectTypeScriptSyntax(core);
    expectTypeScriptSyntax(
      readFileSync(path.join(dir, "lib", "agenc", "job-spec-store.ts"), "utf8"),
    );
    expectTypeScriptSyntax(
      readFileSync(path.join(dir, "pages", "api", "agenc", "job-specs.ts"), "utf8"),
    );
  });

  it("generates a fail-closed idempotent, rate/spend-bounded checkout policy", async () => {
    const moduleDir = moduleTempDir(".agenc-policy-test-");
    const modulePath = path.join(moduleDir, "checkout-policy.mjs");
    const savedEnv = { ...process.env };
    try {
      const compiled = ts.transpileModule(checkoutPolicyModule(), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        reportDiagnostics: true,
      });
      expect(compiled.diagnostics ?? []).toEqual([]);
      writeFileSync(modulePath, compiled.outputText);
      const policy = (await import(pathToFileURL(modulePath).href)) as {
        admitCheckout(
          headers: { get(name: string): string | null },
          cost: bigint,
          now: number,
        ):
          | {
              ok: true;
              cachedBody?: Record<string, unknown>;
              bindIntent(fingerprint: string): boolean;
              checkpoint(recovery: unknown, now?: number): boolean;
              preserve(recovery: unknown): void;
              complete(body: Record<string, unknown>, now?: number): void;
              abort(): void;
            }
          | { ok: false; status: number; body: Record<string, unknown> };
      };
      process.env.NODE_ENV = "test";
      process.env.AGENC_CHECKOUT_SECRET = "local-secret";
      process.env.AGENC_ENABLE_DEV_CHECKOUT = "1";
      process.env.AGENC_NETWORK = "localnet";
      process.env.AGENC_RPC_URL = "http://127.0.0.1:8899";
      process.env.AGENC_CHECKOUT_HOURLY_DEBIT_LIMIT_LAMPORTS = "10000";
      const headers = {
        get(name: string) {
          if (name === "x-agenc-checkout-secret") return "local-secret";
          if (name === "idempotency-key") return "request-00000001";
          return null;
        },
      };
      const first = policy.admitCheckout(headers, 1_000n, 1_000);
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.bindIntent("intent-a")).toBe(true);
        first.complete({ task: "task-1" }, 1_000);
      }
      const changed = policy.admitCheckout(headers, 1_000n, 1_001);
      expect(changed.ok).toBe(true);
      if (changed.ok) {
        expect(changed.bindIntent("intent-b")).toBe(false);
        changed.abort();
      }
      const replay = policy.admitCheckout(headers, 1_000n, 1_002);
      expect(replay.ok).toBe(true);
      if (replay.ok) {
        expect(replay.bindIntent("intent-a")).toBe(true);
        expect(replay.cachedBody).toEqual({ task: "task-1" });
        replay.complete(replay.cachedBody ?? {});
      }

      const withKey = (key: string) => ({
        get(name: string) {
          if (name === "x-agenc-checkout-secret") return "local-secret";
          if (name === "idempotency-key") return key;
          return null;
        },
      });

      // A closure from an expired generation must never delete/credit the
      // replacement request occupying the same key.
      const stale = policy.admitCheckout(withKey("stale-generation-01"), 500n, 10_000_000);
      expect(stale.ok).toBe(true);
      const replacement = policy.admitCheckout(
        withKey("stale-generation-01"),
        500n,
        10_000_000 + 3_600_001,
      );
      expect(replacement.ok).toBe(true);
      if (stale.ok) {
        expect(stale.checkpoint({ taskId: "must-not-broadcast" })).toBe(false);
        stale.abort();
      }
      expect(
        policy.admitCheckout(
          withKey("stale-generation-01"),
          500n,
          10_000_000 + 3_600_002,
        ),
      ).toMatchObject({ ok: false, status: 409 });
      if (replacement.ok) replacement.abort();

      // A dormant recovery whose old rolling-window reservation expired must
      // atomically reserve the full amount again before it can resume.
      process.env.AGENC_CHECKOUT_HOURLY_DEBIT_LIMIT_LAMPORTS = "1000";
      const recoverable = policy.admitCheckout(
        withKey("recoverable-key-01"),
        1_000n,
        20_000_000,
      );
      expect(recoverable.ok).toBe(true);
      if (recoverable.ok) {
        expect(recoverable.bindIntent("recoverable-intent")).toBe(true);
        recoverable.preserve({ taskId: "saved" });
      }
      const resumed = policy.admitCheckout(
        withKey("recoverable-key-01"),
        1_000n,
        20_000_000 + 3_600_001,
      );
      expect(resumed.ok).toBe(true);
      expect(
        policy.admitCheckout(
          withKey("other-funded-key-01"),
          1_000n,
          20_000_000 + 3_600_002,
        ),
      ).toMatchObject({ ok: false, status: 429 });
      if (resumed.ok) resumed.abort();

      // Rolling reservations expire independently: a request at minute 59 is
      // still counted after the earlier request falls out at minute 60.
      process.env.AGENC_CHECKOUT_HOURLY_DEBIT_LIMIT_LAMPORTS = "1500";
      const windowA = policy.admitCheckout(withKey("rolling-window-a1"), 500n, 30_000_000);
      if (windowA.ok) {
        windowA.bindIntent("rolling-a");
        windowA.complete({ task: "a" }, 30_000_000);
      }
      const windowB = policy.admitCheckout(
        withKey("rolling-window-b1"),
        1_000n,
        30_000_000 + 3_540_000,
      );
      expect(windowB.ok).toBe(true);
      if (windowB.ok) {
        windowB.bindIntent("rolling-b");
        windowB.complete({ task: "b" }, 30_000_000 + 3_540_000);
      }
      expect(
        policy.admitCheckout(
          withKey("rolling-window-c1"),
          1_000n,
          30_000_000 + 3_600_001,
        ),
      ).toMatchObject({ ok: false, status: 429 });

      // Resuming just before the original reservation expires restarts the
      // rolling window. The post-hire activation can spend at resume time, so
      // the reservation must not disappear one minute later.
      process.env.AGENC_CHECKOUT_HOURLY_DEBIT_LIMIT_LAMPORTS = "1000";
      const sliding = policy.admitCheckout(
        withKey("sliding-recovery-a1"),
        1_000n,
        40_000_000,
      );
      expect(sliding.ok).toBe(true);
      if (sliding.ok) {
        expect(sliding.bindIntent("sliding-intent")).toBe(true);
        sliding.preserve({ taskId: "saved" });
      }
      const slidingResume = policy.admitCheckout(
        withKey("sliding-recovery-a1"),
        1_000n,
        40_000_000 + 3_540_000,
      );
      expect(slidingResume.ok).toBe(true);
      if (slidingResume.ok) {
        expect(slidingResume.bindIntent("sliding-intent")).toBe(true);
        slidingResume.complete(
          { task: "activated" },
          40_000_000 + 3_540_000,
        );
      }
      expect(
        policy.admitCheckout(
          withKey("sliding-recovery-b1"),
          1_000n,
          40_000_000 + 3_600_001,
        ),
      ).toMatchObject({ ok: false, status: 429 });

      // A funded operation can run for longer than the original rolling
      // window. Its last pre-broadcast checkpoint and completion must extend
      // the reservation so the next prune cannot admit the same full debit.
      process.env.AGENC_CHECKOUT_HOURLY_DEBIT_LIMIT_LAMPORTS = "1000";
      const longRunningStartedAt = 50_000_000;
      const longRunning = policy.admitCheckout(
        withKey("long-running-funded-01"),
        1_000n,
        longRunningStartedAt,
      );
      expect(longRunning.ok).toBe(true);
      if (longRunning.ok) {
        expect(longRunning.bindIntent("long-running-intent")).toBe(true);
        expect(
          longRunning.checkpoint(
            { phase: "hiring" },
            longRunningStartedAt + 3_600_001,
          ),
        ).toBe(true);
        longRunning.complete(
          { task: "long-running-task" },
          longRunningStartedAt + 3_600_002,
        );
      }
      expect(
        policy.admitCheckout(
          withKey("long-running-funded-02"),
          1_000n,
          longRunningStartedAt + 3_600_003,
        ),
      ).toMatchObject({ ok: false, status: 429 });

      process.env.NODE_ENV = "production";
      const production = policy.admitCheckout(headers, 1_000n, 1_003);
      expect(production).toMatchObject({ ok: false, status: 503 });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
      rmSync(moduleDir, { recursive: true, force: true });
    }
  });

  it("generates the strict shared checkout wallet loader", () => {
    const source = walletFileModule();
    expect(source).toContain("value.length !== 64");
    expect(source).toContain("Number.isSafeInteger(byte)");
    expect(source).toContain("constants.O_NOFOLLOW");
    expect(source).toContain("stat.mode & 0o077");
    expect(source).toContain("stat.size > MAX_WALLET_FILE_BYTES");
    expectTypeScriptSyntax(source);
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
    const normalized = parseConfig(
      readFileSync(path.join(dir, "agenc.config.json"), "utf8"),
      "agenc.config.json",
    ).name;
    expect(page).toContain(`<h1>{${JSON.stringify(normalized)}}</h1>`);
    expect(page).not.toContain('<h1>{"x"}</h1>{');
    expectTypeScriptSyntax(page, true);
  });

  it("generates an HTTPS envelope the stock worker verifies", async () => {
    const moduleDir = moduleTempDir(".agenc-store-test-");
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
    expect(worker).toContain("loadSolanaKeypairFile(config.walletPath)");
    expect(worker).toContain("getMinimumBalanceForRentExemption(BigInt(space)");
    expect(worker).not.toContain("Uint8Array.from(JSON.parse");
    expect(() =>
      execFileSync(process.execPath, ["--check", path.join(dir, "worker.mjs")]),
    ).not.toThrow();
  });

  it("executes the generated worker against linked runtime mocks", async () => {
    const moduleDir = moduleTempDir(".agenc-worker-template-test-");
    const writeMockPackage = (name: string, source: string): void => {
      const packageDir = path.join(moduleDir, "node_modules", ...name.split("/"));
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name, type: "module", exports: "./index.js" }),
      );
      writeFileSync(path.join(packageDir, "index.js"), source);
    };
    const globals = globalThis as typeof globalThis & {
      __agencWorkerRpc?: Record<string, (...args: unknown[]) => unknown>;
      __agencWorkerContext?: Record<string, unknown>;
      __agencRentCall?: { space: unknown; options: unknown };
    };
    try {
      writeMockPackage(
        "@solana/kit",
        `export async function createKeyPairSignerFromBytes() { return { address: "11111111111111111111111111111111" }; }
export function createSolanaRpc() { return globalThis.__agencWorkerRpc; }
`,
      );
      writeMockPackage(
        "@tetsuo-ai/marketplace-sdk",
        `export function createMarketplaceClient(input) { return { input }; }
export const taskThread = { createContentTransport(input) { return { input }; } };
`,
      );
      writeMockPackage(
        "@tetsuo-ai/agenc-worker",
        `export const DEFAULT_ENDPOINT = "https://default.invalid";
export function configFromEnv() { return {
  rpcUrl: "http://127.0.0.1:8899",
  walletPath: "/private/wallet.json",
  endpoint: "https://worker.example/agent",
  stateDir: "/private/state",
  taskThreadBaseUrl: "https://threads.example"
}; }
export function defaultConfigPath() { return "/private/config.json"; }
export function loadConfigFile() { return {}; }
export function loadSolanaKeypairFile() { return new Uint8Array(64); }
export function resolveWorkerConfig(first) { return first; }
export async function findVerifiedSettlementSignature() { return "settlement-signature"; }
export async function runUp(context) { globalThis.__agencWorkerContext = context; }
`,
      );
      globals.__agencWorkerRpc = {
        getAccountInfo: () => ({ send: async () => ({ value: null }) }),
        getBalance: () => ({ send: async () => ({ value: 99n }) }),
        getMinimumBalanceForRentExemption: (space: unknown, options: unknown) => {
          globals.__agencRentCall = { space, options };
          return { send: async () => 1234n };
        },
      };
      const workerPath = path.join(moduleDir, "worker.mjs");
      writeFileSync(
        workerPath,
        workerLoopMjs(defaultConfig("linked-worker", "worker")),
      );
      await import(pathToFileURL(workerPath).href);
      const context = globals.__agencWorkerContext as {
        getMinimumBalanceForRentExemption(space: number): Promise<bigint>;
        getBalance(address: string): Promise<bigint>;
        findSettlementSignature(task: string): Promise<string>;
        stateDir: string;
      };
      await expect(context.getMinimumBalanceForRentExemption(388)).resolves.toBe(1234n);
      expect(globals.__agencRentCall).toEqual({
        space: 388n,
        options: { commitment: "finalized" },
      });
      await expect(
        context.getBalance("11111111111111111111111111111111"),
      ).resolves.toBe(99n);
      await expect(context.findSettlementSignature("task")).resolves.toBe(
        "settlement-signature",
      );
      expect(context.stateDir).toBe("/private/state");
    } finally {
      delete globals.__agencWorkerRpc;
      delete globals.__agencWorkerContext;
      delete globals.__agencRentCall;
      rmSync(moduleDir, { recursive: true, force: true });
    }
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

  it("--force refuses leaf symlinks instead of overwriting their outside targets", () => {
    const dir = nextAppDir();
    const outside = path.join(mkdtempSync(path.join(tmpdir(), "agenc-outside-")), "victim.tsx");
    writeFileSync(outside, "// outside sentinel\n");
    mkdirSync(path.join(dir, "app", "agenc"), { recursive: true });
    const target = path.join(dir, "app", "agenc", "page.tsx");
    symlinkSync(outside, target);

    const result = runInit(dir, { force: true });
    expect(
      result.files.find((file) => file.path === path.join("app", "agenc", "page.tsx")),
    ).toMatchObject({ status: "refused" });
    expect(readFileSync(outside, "utf8")).toBe("// outside sentinel\n");
  });

  it("migrates worker to checkout and removes only marker-owned stale output", () => {
    const dir = workerDir();
    runInit(dir);
    expect(existsSync(path.join(dir, "worker.mjs"))).toBe(true);

    const migrated = runInit(dir, { kind: "checkout", force: true });
    expect(migrated.refused).toBe(false);
    expect(migrated.files).toContainEqual({ path: "worker.mjs", status: "removed" });
    expect(existsSync(path.join(dir, "worker.mjs"))).toBe(false);
    expect(existsSync(path.join(dir, "app", "agenc", "checkout", "route.ts"))).toBe(true);
  });

  it("retains every stale surface when replacement publication fails mid-batch", () => {
    const dir = workerDir();
    runInit(dir);
    const oldWorker = path.join(dir, "worker.mjs");
    expect(existsSync(oldWorker)).toBe(true);

    // Preflight accepts an ordinary directory, but publication below it is
    // forced to fail. This exercises the post-preflight failure path rather
    // than the earlier unsafe-target refusal path.
    const appDir = path.join(dir, "app");
    mkdirSync(appDir);
    chmodSync(appDir, 0o555);
    try {
      const migrated = runInit(dir, { kind: "checkout", force: true });
      expect(migrated.refused).toBe(true);
      expect(migrated.files).toContainEqual({
        path: "worker.mjs",
        status: "refused",
      });
      expect(existsSync(oldWorker)).toBe(true);
      expect(
        parseConfig(
          readFileSync(path.join(dir, "agenc.config.json"), "utf8"),
          "agenc.config.json",
        ).kind,
      ).toBe("worker");
    } finally {
      chmodSync(appDir, 0o755);
    }
  });

  it("migrates checkout to worker without leaving funded marker-owned routes", () => {
    const dir = nextAppDir();
    runInit(dir);
    const route = path.join(dir, "app", "agenc", "checkout", "route.ts");
    expect(existsSync(route)).toBe(true);

    const migrated = runInit(dir, { kind: "worker", force: true });
    expect(migrated.refused).toBe(false);
    expect(existsSync(route)).toBe(false);
    expect(existsSync(path.join(dir, "worker.mjs"))).toBe(true);
  });

  it("migrates Pages and App Router surfaces in both directions", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-cli-init-"));
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "router-migration", dependencies: { next: "15.0.0" } }),
    );
    mkdirSync(path.join(dir, "pages"));
    runInit(dir, { router: "pages" });
    const pagesRoute = path.join(dir, "pages", "api", "agenc", "checkout.ts");
    expect(existsSync(pagesRoute)).toBe(true);

    const toApp = runInit(dir, { router: "app", force: true });
    expect(toApp.refused).toBe(false);
    expect(existsSync(pagesRoute)).toBe(false);
    expect(existsSync(path.join(dir, "lib", "agenc", "checkout-core.ts"))).toBe(false);
    const appRoute = path.join(dir, "app", "agenc", "checkout", "route.ts");
    expect(existsSync(appRoute)).toBe(true);

    const toPages = runInit(dir, { router: "pages", force: true });
    expect(toPages.refused).toBe(false);
    expect(existsSync(appRoute)).toBe(false);
    expect(existsSync(pagesRoute)).toBe(true);
  });

  it("refuses a migration when a stale output was edited or replaced by a symlink", () => {
    const editedDir = nextAppDir();
    runInit(editedDir);
    const editedRoute = path.join(editedDir, "app", "agenc", "checkout", "route.ts");
    writeFileSync(editedRoute, "// application-owned route\n");
    const edited = runInit(editedDir, { kind: "worker", force: true });
    expect(edited.refused).toBe(true);
    expect(readFileSync(editedRoute, "utf8")).toBe("// application-owned route\n");
    expect(existsSync(path.join(editedDir, "worker.mjs"))).toBe(false);

    const linkedDir = nextAppDir();
    runInit(linkedDir);
    const linkedRoute = path.join(linkedDir, "app", "agenc", "checkout", "route.ts");
    const outside = path.join(mkdtempSync(path.join(tmpdir(), "agenc-outside-")), "route.ts");
    writeFileSync(outside, "// outside\n");
    rmSync(linkedRoute);
    symlinkSync(outside, linkedRoute);
    const linked = runInit(linkedDir, { kind: "worker", force: true });
    expect(linked.refused).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("// outside\n");
    expect(existsSync(path.join(linkedDir, "worker.mjs"))).toBe(false);
  });

  it("refuses an unsafe config before publishing any other target", () => {
    const dir = nextAppDir();
    const outside = path.join(mkdtempSync(path.join(tmpdir(), "agenc-outside-")), "config.json");
    writeFileSync(outside, JSON.stringify(defaultConfig("outside", "checkout")));
    symlinkSync(outside, path.join(dir, "agenc.config.json"));

    const result = runInit(dir, { force: true });
    expect(result.refused).toBe(true);
    expect(result.files).toEqual([{ path: "agenc.config.json", status: "refused" }]);
    expect(existsSync(path.join(dir, "app", "agenc", "page.tsx"))).toBe(false);
  });

  it("refuses symlinked path components without publishing outside the project", () => {
    const dir = nextAppDir();
    const outside = mkdtempSync(path.join(tmpdir(), "agenc-outside-dir-"));
    symlinkSync(outside, path.join(dir, "app", "agenc"));

    const result = runInit(dir, { force: true });
    expect(
      result.files
        .filter((file) => file.path.startsWith(path.join("app", "agenc")))
        .every((file) => file.status === "refused"),
    ).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
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
