import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertActiveWorkerConfig,
  ConfigError,
  configFromEnv,
  defaultStateDir,
  DEFAULT_CAPABILITIES,
  DEFAULT_ENDPOINT,
  DEFAULT_EXECUTOR,
  DEFAULT_EXECUTOR_ENV_ALLOWLIST,
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TASK_THREAD_BASE_URL,
  loadConfigFile,
  resolveWorkerConfig,
} from "../src/config.js";

const REQUIRED = { rpcUrl: "http://localhost:8899", walletPath: "/tmp/w.json" };
const CREATOR_A = "11111111111111111111111111111111";
const CREATOR_B = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";

function writePrivate(file: string, body: string): void {
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
}

describe("resolveWorkerConfig", () => {
  it("applies defaults when only the required fields are given", () => {
    const config = resolveWorkerConfig(REQUIRED);
    expect(config.capabilities).toBe(DEFAULT_CAPABILITIES);
    expect(config.minRewardLamports).toBe(0n);
    expect(config.maxRewardLamports).toBeNull();
    expect(config.allowUnboundedReward).toBe(false);
    expect(config.executor).toEqual([...DEFAULT_EXECUTOR]);
    expect(config.executorMode).toBe("safe");
    expect(config.executorEnvAllowlist).toEqual([
      ...DEFAULT_EXECUTOR_ENV_ALLOWLIST,
    ]);
    expect(config.executor.at(-2)).toBe("--");
    expect(config.executor.at(-1)).toBe("{prompt}");
    expect(config.resultUploader).toBeNull();
    expect(config.creatorAllowlist).toBeNull();
    expect(config.allowAnyCreator).toBe(false);
    expect(config.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(config.taskThreadBaseUrl).toBe(DEFAULT_TASK_THREAD_BASE_URL);
    expect(config.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(config.executorTimeoutMs).toBe(DEFAULT_EXECUTOR_TIMEOUT_MS);
    expect(config.stateDir).toBe(defaultStateDir(REQUIRED));
    expect(path.basename(config.stateDir)).toMatch(/^[0-9a-f]{24}$/u);
  });

  it("namespaces default state by canonical RPC and wallet identity", () => {
    const first = defaultStateDir(REQUIRED);
    expect(defaultStateDir({ ...REQUIRED })).toBe(first);
    expect(
      defaultStateDir({ ...REQUIRED, walletPath: "/tmp/other-wallet.json" }),
    ).not.toBe(first);
    expect(
      defaultStateDir({ ...REQUIRED, rpcUrl: "http://localhost:9999" }),
    ).not.toBe(first);
    expect(
      resolveWorkerConfig({ ...REQUIRED, stateDir: "/tmp/explicit-state" })
        .stateDir,
    ).toBe("/tmp/explicit-state");
  });

  it("enforces precedence: flags > env > file", () => {
    const flags = { minRewardLamports: "111" };
    const env = configFromEnv({
      AGENC_WORKER_RPC_URL: "http://env:1",
      AGENC_WORKER_WALLET: "/env/wallet.json",
      AGENC_WORKER_MIN_REWARD_LAMPORTS: "222",
      AGENC_WORKER_CAPABILITIES: "3",
    });
    const file = {
      rpcUrl: "http://file:1",
      walletPath: "/file/wallet.json",
      minRewardLamports: "333",
      capabilities: "7",
      maxRewardLamports: "999",
    };
    const config = resolveWorkerConfig(flags, env, file);
    expect(config.minRewardLamports).toBe(111n); // flag wins
    expect(config.rpcUrl).toBe("http://env:1"); // env beats file
    expect(config.walletPath).toBe("/env/wallet.json");
    expect(config.capabilities).toBe(3n); // env beats file
    expect(config.maxRewardLamports).toBe(999n); // only in file
  });

  it("requires rpcUrl and walletPath", () => {
    expect(() => resolveWorkerConfig({ walletPath: "/w" })).toThrow(
      ConfigError,
    );
    expect(() => resolveWorkerConfig({ walletPath: "/w" })).toThrow(/rpcUrl/);
    expect(() => resolveWorkerConfig({ rpcUrl: "http://x" })).toThrow(
      /walletPath/,
    );
    expect(() => resolveWorkerConfig({ rpcUrl: "http://x" })).toThrow(
      /LOW-FUNDED/,
    );
  });

  it("rejects a zero capabilities bitmask (the program rejects 0)", () => {
    expect(() =>
      resolveWorkerConfig({ ...REQUIRED, capabilities: "0" }),
    ).toThrow(/capabilities/);
  });

  it("rejects malformed bigint fields", () => {
    expect(() =>
      resolveWorkerConfig({ ...REQUIRED, minRewardLamports: "not-a-number" }),
    ).toThrow(ConfigError);
    expect(() =>
      resolveWorkerConfig({ ...REQUIRED, maxRewardLamports: "-5" }),
    ).toThrow(ConfigError);
  });

  it("rejects maxReward below minReward", () => {
    expect(() =>
      resolveWorkerConfig({
        ...REQUIRED,
        minRewardLamports: "100",
        maxRewardLamports: "50",
      }),
    ).toThrow(/maxRewardLamports/);
  });

  it("parses the executor from a JSON string and validates its shape", () => {
    const config = resolveWorkerConfig({
      ...REQUIRED,
      executor: '["codex","exec","{prompt}"]',
      executorMode: "sandboxed",
    });
    expect(config.executor).toEqual(["codex", "exec", "{prompt}"]);
    expect(() => resolveWorkerConfig({ ...REQUIRED, executor: "[]" })).toThrow(
      /executor/,
    );
    expect(() =>
      resolveWorkerConfig({ ...REQUIRED, executor: "claude -p" }),
    ).toThrow(/JSON argv array/);
    expect(() =>
      resolveWorkerConfig({ ...REQUIRED, executor: '["ok", 5]' as string }),
    ).toThrow(/executor/);
  });

  it("rejects a custom executor unless sandboxed or explicitly unsafe", () => {
    const custom = '["codex","exec","{prompt}"]';
    expect(() =>
      resolveWorkerConfig({ ...REQUIRED, executor: custom }),
    ).toThrow(/custom argv.*safe mode/);
    expect(
      resolveWorkerConfig({
        ...REQUIRED,
        executor: custom,
        executorMode: "sandboxed",
      }),
    ).toMatchObject({ executorMode: "sandboxed", executorEnvAllowlist: [] });
    expect(
      resolveWorkerConfig({
        ...REQUIRED,
        executor: custom,
        executorMode: "unsafe",
      }).executorMode,
    ).toBe("unsafe");
  });

  it("limits safe-mode environment inheritance to the API credential", () => {
    expect(() =>
      resolveWorkerConfig({
        ...REQUIRED,
        executorEnvAllowlist: ["ANTHROPIC_API_KEY", "AGENC_WORKER_WALLET"],
      }),
    ).toThrow(/safe mode may inherit only ANTHROPIC_API_KEY/);
  });

  it("fails safe active startup before claiming when executor auth is absent", () => {
    const oldKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const config = resolveWorkerConfig({
        ...REQUIRED,
        maxRewardLamports: "1000",
        creatorAllowlist: [CREATOR_A],
      });
      expect(() => assertActiveWorkerConfig(config)).toThrow(
        /ANTHROPIC_API_KEY.*refusing/s,
      );
    } finally {
      if (oldKey !== undefined) process.env.ANTHROPIC_API_KEY = oldKey;
    }
  });

  it("fails active startup without an explicit reward cap and creator policy", () => {
    const defaults = resolveWorkerConfig(REQUIRED);
    expect(() => assertActiveWorkerConfig(defaults)).toThrow(
      /maxRewardLamports/,
    );

    const capped = resolveWorkerConfig({
      ...REQUIRED,
      maxRewardLamports: "1000",
    });
    expect(() => assertActiveWorkerConfig(capped)).toThrow(/creatorAllowlist/);

    const restricted = resolveWorkerConfig({
      ...REQUIRED,
      maxRewardLamports: "1000",
      creatorAllowlist: [CREATOR_A],
      executor: [process.execPath, "-e", "void 0", "{prompt}"],
      executorMode: "sandboxed",
      executorEnvAllowlist: [],
    });
    expect(() => assertActiveWorkerConfig(restricted)).not.toThrow();

    const explicitOptOut = resolveWorkerConfig({
      ...REQUIRED,
      allowUnboundedReward: true,
      allowAnyCreator: true,
      executor: [process.execPath, "-e", "void 0", "{prompt}"],
      executorMode: "sandboxed",
      executorEnvAllowlist: [],
    });
    expect(() => assertActiveWorkerConfig(explicitOptOut)).not.toThrow();
  });

  it("requires the result uploader to be https", () => {
    expect(() =>
      resolveWorkerConfig({
        ...REQUIRED,
        resultUploader: "http://plain.example",
      }),
    ).toThrow(/https/);
    expect(
      resolveWorkerConfig({
        ...REQUIRED,
        resultUploader: "https://up.example/x",
      }).resultUploader,
    ).toBe("https://up.example/x");
  });

  it("requires the endpoint to be a non-empty http(s) URL (on-chain register_agent rule)", () => {
    expect(() =>
      resolveWorkerConfig({ ...REQUIRED, endpoint: "ftp://x" }),
    ).toThrow(/endpoint/);
    expect(() => resolveWorkerConfig({ ...REQUIRED, endpoint: "" })).toThrow(
      /endpoint/,
    );
    expect(() =>
      resolveWorkerConfig({
        ...REQUIRED,
        endpoint: `https://x.example/${"a".repeat(130)}`,
      }),
    ).toThrow(/128/);
    expect(
      resolveWorkerConfig({ ...REQUIRED, endpoint: "https://agent.example" })
        .endpoint,
    ).toBe("https://agent.example");
    expect(resolveWorkerConfig(REQUIRED).endpoint).toBe(DEFAULT_ENDPOINT);
  });

  it("requires an HTTPS credential-free task-thread content host", () => {
    expect(() =>
      resolveWorkerConfig({
        ...REQUIRED,
        taskThreadBaseUrl: "http://threads.example",
      }),
    ).toThrow(/taskThreadBaseUrl/);
    expect(() =>
      resolveWorkerConfig({
        ...REQUIRED,
        taskThreadBaseUrl: "https://user:pass@threads.example",
      }),
    ).toThrow(/credentials/);
    expect(() =>
      resolveWorkerConfig({
        ...REQUIRED,
        taskThreadBaseUrl: "https://threads.example?token=secret",
      }),
    ).toThrow(/query/);
    expect(
      resolveWorkerConfig({
        ...REQUIRED,
        taskThreadBaseUrl: "https://threads.example/",
      }).taskThreadBaseUrl,
    ).toBe("https://threads.example");
    expect(
      configFromEnv({
        AGENC_WORKER_TASK_THREAD_BASE_URL: "https://env-threads.example",
      }).taskThreadBaseUrl,
    ).toBe("https://env-threads.example");
  });

  it("parses creator allowlists from comma-separated env strings", () => {
    const config = resolveWorkerConfig({
      ...REQUIRED,
      creatorAllowlist: `${CREATOR_A}, ${CREATOR_B}`,
    });
    expect(config.creatorAllowlist).toEqual([CREATOR_A, CREATOR_B]);
  });

  it("enforces the runtime schema across env and programmatic sources", () => {
    const invalidInputs: Array<Record<string, unknown>> = [
      { rpcUrl: 7 },
      { rpcUrl: "https://user:secret@rpc.example" },
      { walletPath: "bad\npath" },
      { stateDir: "\u0000state" },
      { capabilities: "01" },
      { capabilities: -1n },
      { minRewardLamports: 18_446_744_073_709_551_616n },
      { maxRewardLamports: "18446744073709551616" },
      { pollIntervalMs: " 10" },
      { pollIntervalMs: 1.5 },
      { executorTimeoutMs: 2_147_483_648 },
      { creatorAllowlist: ["not-a-solana-address"] },
      { resultUploader: "https://user:secret@up.example" },
      { endpoint: "https://user:secret@worker.example" },
      { taskThreadBaseUrl: "https://threads.example#fragment" },
      { typo: true },
    ];
    for (const invalid of invalidInputs) {
      expect(() =>
        resolveWorkerConfig({
          ...REQUIRED,
          ...invalid,
        } as never),
      ).toThrow(ConfigError);
    }

    expect(() =>
      resolveWorkerConfig(
        REQUIRED,
        configFromEnv({ AGENC_WORKER_CAPABILITIES: "01" }),
      ),
    ).toThrow(/capabilities/);
    expect(() =>
      resolveWorkerConfig(
        REQUIRED,
        configFromEnv({ AGENC_WORKER_CREATOR_ALLOWLIST: "not-an-address" }),
      ),
    ).toThrow(/creatorAllowlist/);
  });
});

describe("loadConfigFile", () => {
  it("returns {} for a missing DEFAULT-path file but errors on an explicit one", () => {
    const missing = path.join(tmpdir(), "definitely-missing-agenc-worker.json");
    expect(loadConfigFile(missing)).toEqual({});
    expect(() => loadConfigFile(missing, { explicit: true })).toThrow(
      ConfigError,
    );
  });

  it("parses a JSON object and rejects non-objects", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-worker-config-"));
    const good = path.join(dir, "config.json");
    writePrivate(good, JSON.stringify({ rpcUrl: "http://file" }));
    expect(loadConfigFile(good)).toEqual({ rpcUrl: "http://file" });
    const bad = path.join(dir, "bad.json");
    writePrivate(bad, "[1,2,3]");
    expect(() => loadConfigFile(bad)).toThrow(/JSON object/);
    const invalid = path.join(dir, "invalid.json");
    writePrivate(invalid, "{nope");
    expect(() => loadConfigFile(invalid)).toThrow(/invalid JSON/);
  });

  it("refuses symlinks and group/world-readable config files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-worker-config-"));
    const target = path.join(dir, "target.json");
    const link = path.join(dir, "link.json");
    writePrivate(
      target,
      JSON.stringify({ rpcUrl: "https://rpc.example?api-key=secret" }),
    );
    symlinkSync(target, link);
    expect(() => loadConfigFile(link, { explicit: true })).toThrow(
      /symbolic link/u,
    );

    chmodSync(target, 0o644);
    expect(() => loadConfigFile(target, { explicit: true })).toThrow(
      /chmod 600/u,
    );
  });

  it("rejects unknown properties with the config path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-worker-config-"));
    const file = path.join(dir, "unknown.json");
    writePrivate(
      file,
      JSON.stringify({ rpcUrl: "http://file", rpcURL: "typo" }),
    );
    expect(() => loadConfigFile(file)).toThrow(
      new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}.*rpcURL`),
    );
  });

  it.each([
    ["rpcUrl", null],
    ["walletPath", false],
    ["capabilities", 1],
    ["minRewardLamports", 1],
    ["maxRewardLamports", true],
    ["allowUnboundedReward", "true"],
    ["executor", '["claude"]'],
    ["executorMode", null],
    ["executorEnvAllowlist", "ANTHROPIC_API_KEY"],
    ["resultUploader", 7],
    ["stateDir", []],
    ["creatorAllowlist", "creator"],
    ["allowAnyCreator", 0],
    ["endpoint", {}],
    ["taskThreadBaseUrl", false],
    ["pollIntervalMs", "15000"],
    ["executorTimeoutMs", null],
  ])("rejects an invalid JSON type at %s", (field, value) => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-worker-config-"));
    const file = path.join(dir, `${field}.json`);
    writePrivate(file, JSON.stringify({ [field]: value }));
    expect(() => loadConfigFile(file)).toThrow(ConfigError);
    expect(() => loadConfigFile(file)).toThrow(new RegExp(`"${field}"`));
  });

  it.each([
    ["rpcUrl", "not a URL"],
    ["walletPath", "   "],
    ["capabilities", "0"],
    ["capabilities", "01"],
    ["minRewardLamports", "-1"],
    ["maxRewardLamports", "18446744073709551616"],
    ["executor", []],
    ["executor", ["claude", ""]],
    ["executorMode", "root"],
    ["executorEnvAllowlist", ["BAD-NAME"]],
    ["resultUploader", "http://uploader.example"],
    ["resultUploader", "https://user:secret@uploader.example"],
    ["stateDir", ""],
    ["creatorAllowlist", [""]],
    ["creatorAllowlist", ["not-a-solana-address"]],
    ["endpoint", "ftp://worker.example"],
    ["taskThreadBaseUrl", "https://threads.example?token=secret"],
    ["pollIntervalMs", 0],
    ["pollIntervalMs", 1.5],
    ["executorTimeoutMs", 2_147_483_648],
  ])("rejects an invalid JSON value at %s", (field, value) => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-worker-config-"));
    const file = path.join(dir, `${field}-value.json`);
    writePrivate(file, JSON.stringify({ [field]: value }));
    expect(() => loadConfigFile(file)).toThrow(ConfigError);
    expect(() => loadConfigFile(file)).toThrow(new RegExp(`"${field}`));
  });
});
