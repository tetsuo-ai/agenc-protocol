import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertActiveWorkerConfig,
  ConfigError,
  configFromEnv,
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
    expect(config.stateDir).toContain("agenc-worker");
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
        creatorAllowlist: ["trusted"],
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
      creatorAllowlist: ["trusted"],
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
      creatorAllowlist: "addr1, addr2 ,addr3",
    });
    expect(config.creatorAllowlist).toEqual(["addr1", "addr2", "addr3"]);
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
    writeFileSync(good, JSON.stringify({ rpcUrl: "http://file" }));
    expect(loadConfigFile(good)).toEqual({ rpcUrl: "http://file" });
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "[1,2,3]");
    expect(() => loadConfigFile(bad)).toThrow(/JSON object/);
    const invalid = path.join(dir, "invalid.json");
    writeFileSync(invalid, "{nope");
    expect(() => loadConfigFile(invalid)).toThrow(/invalid JSON/);
  });
});
