// Worker configuration: CLI flags > environment (`AGENC_WORKER_*`) > config
// file (default `~/.config/agenc-worker/config.json`) > built-in defaults.
//
// SAFETY POSTURE (read before changing defaults):
// - `walletPath` points at a LOW-FUNDED hot-wallet keypair JSON. That wallet
//   is the worker's ONLY spend authority and therefore the blast-radius bound:
//   task content is untrusted, so the worker must never be handed a wallet
//   whose loss would hurt.
// - `executor` is an ARGV ARRAY, never a shell string. The safe default also
//   disables Claude tools/customizations/session persistence and runs in an
//   isolated scratch environment. Custom executors require an explicit
//   `sandboxed` or `unsafe` mode acknowledgement.
// - `resultUploader` must be an https: URL — results are never POSTed over
//   plaintext HTTP.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Default executor: Claude Code as a tool-less, customization-free,
 * non-persistent text generator. The child process additionally gets a fresh
 * HOME/cwd and a scrubbed environment in executor.ts.
 */
export const DEFAULT_EXECUTOR: readonly string[] = [
  "claude",
  "--print",
  "--bare",
  "--safe-mode",
  "--disable-slash-commands",
  "--strict-mcp-config",
  "--tools",
  "",
  "--permission-mode",
  "dontAsk",
  "--no-session-persistence",
  "--",
  "{prompt}",
];

/** Only this credential is inherited by the isolated default executor. */
export const DEFAULT_EXECUTOR_ENV_ALLOWLIST: readonly string[] = [
  "ANTHROPIC_API_KEY",
];

export type ExecutorMode = "safe" | "sandboxed" | "unsafe";

/** Default capability bitmask claimed/required (bit 0). */
export const DEFAULT_CAPABILITIES = 1n;

/** Default poll interval for `up` mode sweeps + settlement checks (ms). */
export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Default executor wall-clock budget (ms). */
export const DEFAULT_EXECUTOR_TIMEOUT_MS = 15 * 60_000;

/**
 * Default agent endpoint recorded at registration. The program REQUIRES a
 * non-empty http(s) endpoint on register_agent; this placeholder marks the
 * agent as an agenc-worker instance with no public inbox.
 */
export const DEFAULT_ENDPOINT = "https://agenc.ag/worker";

/** Default state directory. */
export function defaultStateDir(): string {
  return path.join(homedir(), ".local", "state", "agenc-worker");
}

/** Default config file path. */
export function defaultConfigPath(): string {
  return path.join(homedir(), ".config", "agenc-worker", "config.json");
}

/** The fully-resolved worker configuration the runtime consumes. */
export type WorkerConfig = {
  /** HTTP RPC endpoint (required). */
  rpcUrl: string;
  /**
   * Path to the hot-wallet keypair JSON (required). Keep it LOW-FUNDED — it is
   * the worker's only spend authority and the blast-radius bound.
   */
  walletPath: string;
  /** Worker capability bitmask (default 1n). */
  capabilities: bigint;
  /** Only claim tasks paying at least this many lamports (default 0n). */
  minRewardLamports: bigint;
  /**
   * Safety cap: never claim tasks paying MORE than this (bait filter — a
   * too-good-to-be-true reward is a lure to run hostile content). Active
   * workers reject `null` unless `allowUnboundedReward` is explicitly true.
   */
  maxRewardLamports: bigint | null;
  /** Explicitly allow a null reward cap (unsafe; false by default). */
  allowUnboundedReward: boolean;
  /**
   * Executor command as an argv array. Any element that is exactly
   * `"{prompt}"` is replaced by the prompt as ONE argv element.
   */
  executor: string[];
  /** Safe built-in, externally sandboxed custom command, or explicit unsafe legacy mode. */
  executorMode: ExecutorMode;
  /** Variable names copied into the otherwise-scrubbed executor environment. */
  executorEnvAllowlist: string[];
  /**
   * Optional HTTPS URL to POST the raw result body to. The response must be
   * JSON `{ "uri": "..." }`. When absent the worker submits with the inline
   * `agenc://result/sha256/<hex>` placeholder URI (content addressed by the
   * on-chain proof hash; delivery is out of band).
   */
  resultUploader: string | null;
  /** Directory for the worker's persistent state (agent id, submissions). */
  stateDir: string;
  /** Only claim tasks created by these wallets (base58). Active workers require a policy. */
  creatorAllowlist: string[] | null;
  /** Explicitly allow tasks from every creator (unsafe; false by default). */
  allowAnyCreator: boolean;
  /** Agent endpoint recorded at registration (non-empty http(s); on-chain rule). */
  endpoint: string;
  /** Poll interval for `up` mode (ms). */
  pollIntervalMs: number;
  /** Executor wall-clock budget (ms). */
  executorTimeoutMs: number;
};

/** Raw (pre-validation) input from one config source; all fields optional. */
export type WorkerConfigInput = Partial<{
  rpcUrl: string;
  walletPath: string;
  capabilities: string | bigint;
  minRewardLamports: string | bigint;
  maxRewardLamports: string | bigint | null;
  allowUnboundedReward: boolean | string;
  executor: string[] | string;
  executorMode: ExecutorMode | string;
  executorEnvAllowlist: string[] | string;
  resultUploader: string | null;
  stateDir: string;
  creatorAllowlist: string[] | string | null;
  allowAnyCreator: boolean | string;
  endpoint: string;
  pollIntervalMs: string | number;
  executorTimeoutMs: string | number;
}>;

/** Thrown for any invalid/missing configuration; message names the field. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

function parseBigint(field: string, value: string | bigint): bigint {
  if (typeof value === "bigint") return value;
  try {
    const parsed = BigInt(value.trim());
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new ConfigError(
      `${field}: expected a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
}

function parseNumber(field: string, value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(
      `${field}: expected a positive number, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function parseBoolean(field: string, value: boolean | string): boolean {
  if (typeof value === "boolean") return value;
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  throw new ConfigError(`${field}: expected true or false, got ${JSON.stringify(value)}`);
}

function parseExecutor(field: string, value: string[] | string): string[] {
  let argv: unknown = value;
  if (typeof value === "string") {
    try {
      argv = JSON.parse(value);
    } catch {
      throw new ConfigError(
        `${field}: expected a JSON argv array like ["sandbox-wrapper","{prompt}"]`,
      );
    }
  }
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((element) => typeof element === "string" && element.length > 0)
  ) {
    throw new ConfigError(
      `${field}: expected a non-empty array of non-empty strings`,
    );
  }
  return argv as string[];
}

function parseAllowlist(
  field: string,
  value: string[] | string | null,
): string[] | null {
  if (value === null) return null;
  const list =
    typeof value === "string"
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : value;
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) {
    throw new ConfigError(`${field}: expected an array of base58 addresses`);
  }
  return list.length === 0 ? null : list;
}

function parseStringList(field: string, value: string[] | string): string[] {
  let list: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        list = JSON.parse(trimmed);
      } catch {
        throw new ConfigError(`${field}: expected a JSON array or comma-separated names`);
      }
    } else {
      list = trimmed.split(",").map((entry) => entry.trim()).filter(Boolean);
    }
  }
  if (
    !Array.isArray(list) ||
    !list.every((entry) =>
      typeof entry === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)
    )
  ) {
    throw new ConfigError(`${field}: expected environment variable names`);
  }
  return [...new Set(list as string[])];
}

function parseExecutorMode(value: string): ExecutorMode {
  if (value === "safe" || value === "sandboxed" || value === "unsafe") return value;
  throw new ConfigError(
    `executorMode: expected "safe", "sandboxed", or "unsafe", got ${JSON.stringify(value)}`,
  );
}

function argvEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Map `AGENC_WORKER_*` environment variables to a config input. */
export function configFromEnv(
  env: Record<string, string | undefined>,
): WorkerConfigInput {
  const input: WorkerConfigInput = {};
  if (env.AGENC_WORKER_RPC_URL !== undefined) input.rpcUrl = env.AGENC_WORKER_RPC_URL;
  if (env.AGENC_WORKER_WALLET !== undefined) input.walletPath = env.AGENC_WORKER_WALLET;
  if (env.AGENC_WORKER_CAPABILITIES !== undefined) {
    input.capabilities = env.AGENC_WORKER_CAPABILITIES;
  }
  if (env.AGENC_WORKER_MIN_REWARD_LAMPORTS !== undefined) {
    input.minRewardLamports = env.AGENC_WORKER_MIN_REWARD_LAMPORTS;
  }
  if (env.AGENC_WORKER_MAX_REWARD_LAMPORTS !== undefined) {
    input.maxRewardLamports = env.AGENC_WORKER_MAX_REWARD_LAMPORTS;
  }
  if (env.AGENC_WORKER_ALLOW_UNBOUNDED_REWARD !== undefined) {
    input.allowUnboundedReward = env.AGENC_WORKER_ALLOW_UNBOUNDED_REWARD;
  }
  if (env.AGENC_WORKER_EXECUTOR !== undefined) input.executor = env.AGENC_WORKER_EXECUTOR;
  if (env.AGENC_WORKER_EXECUTOR_MODE !== undefined) {
    input.executorMode = env.AGENC_WORKER_EXECUTOR_MODE;
  }
  if (env.AGENC_WORKER_EXECUTOR_ENV_ALLOWLIST !== undefined) {
    input.executorEnvAllowlist = env.AGENC_WORKER_EXECUTOR_ENV_ALLOWLIST;
  }
  if (env.AGENC_WORKER_RESULT_UPLOADER !== undefined) {
    input.resultUploader = env.AGENC_WORKER_RESULT_UPLOADER;
  }
  if (env.AGENC_WORKER_STATE_DIR !== undefined) input.stateDir = env.AGENC_WORKER_STATE_DIR;
  if (env.AGENC_WORKER_CREATOR_ALLOWLIST !== undefined) {
    input.creatorAllowlist = env.AGENC_WORKER_CREATOR_ALLOWLIST;
  }
  if (env.AGENC_WORKER_ALLOW_ANY_CREATOR !== undefined) {
    input.allowAnyCreator = env.AGENC_WORKER_ALLOW_ANY_CREATOR;
  }
  if (env.AGENC_WORKER_ENDPOINT !== undefined) input.endpoint = env.AGENC_WORKER_ENDPOINT;
  if (env.AGENC_WORKER_POLL_INTERVAL_MS !== undefined) {
    input.pollIntervalMs = env.AGENC_WORKER_POLL_INTERVAL_MS;
  }
  if (env.AGENC_WORKER_EXECUTOR_TIMEOUT_MS !== undefined) {
    input.executorTimeoutMs = env.AGENC_WORKER_EXECUTOR_TIMEOUT_MS;
  }
  return input;
}

/**
 * Read + parse a JSON config file. A missing file at the DEFAULT path is fine
 * (returns `{}`); a missing file at an explicitly-requested path is an error.
 */
export function loadConfigFile(
  filePath: string,
  { explicit = false }: { explicit?: boolean } = {},
): WorkerConfigInput {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!explicit && (code === "ENOENT" || code === "ENOTDIR")) return {};
    throw new ConfigError(`config file ${filePath}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `config file ${filePath}: invalid JSON (${(error as Error).message})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`config file ${filePath}: expected a JSON object`);
  }
  return parsed as WorkerConfigInput;
}

/** Merge config sources (later sources are LOWER precedence) and validate. */
export function resolveWorkerConfig(
  ...sources: WorkerConfigInput[]
): WorkerConfig {
  // First source wins per field: flags > env > file.
  const merged: WorkerConfigInput = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if ((merged as Record<string, unknown>)[key] === undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }

  if (merged.rpcUrl === undefined || merged.rpcUrl.trim() === "") {
    throw new ConfigError(
      "rpcUrl is required (--rpc-url, AGENC_WORKER_RPC_URL, or the config file)",
    );
  }
  if (merged.walletPath === undefined || merged.walletPath.trim() === "") {
    throw new ConfigError(
      "walletPath is required (--wallet, AGENC_WORKER_WALLET, or the config file). " +
        "Use a LOW-FUNDED hot wallet — it is the worker's only spend authority.",
    );
  }

  const capabilities =
    merged.capabilities === undefined
      ? DEFAULT_CAPABILITIES
      : parseBigint("capabilities", merged.capabilities);
  if (capabilities === 0n) {
    throw new ConfigError("capabilities: must be non-zero (the program rejects 0)");
  }

  const minRewardLamports =
    merged.minRewardLamports === undefined
      ? 0n
      : parseBigint("minRewardLamports", merged.minRewardLamports);
  const maxRewardLamports =
    merged.maxRewardLamports === undefined || merged.maxRewardLamports === null
      ? null
      : parseBigint("maxRewardLamports", merged.maxRewardLamports);
  const allowUnboundedReward =
    merged.allowUnboundedReward === undefined
      ? false
      : parseBoolean("allowUnboundedReward", merged.allowUnboundedReward);
  if (maxRewardLamports !== null && maxRewardLamports < minRewardLamports) {
    throw new ConfigError(
      `maxRewardLamports (${maxRewardLamports}) must be >= minRewardLamports (${minRewardLamports})`,
    );
  }

  const executor =
    merged.executor === undefined
      ? [...DEFAULT_EXECUTOR]
      : parseExecutor("executor", merged.executor);
  const executorMode =
    merged.executorMode === undefined
      ? "safe"
      : parseExecutorMode(merged.executorMode);
  if (executorMode === "safe" && !argvEquals(executor, DEFAULT_EXECUTOR)) {
    throw new ConfigError(
      "executor: custom argv is not permitted in safe mode; wrap it in an external " +
        "sandbox and set executorMode=\"sandboxed\", or explicitly acknowledge legacy " +
        "host access with executorMode=\"unsafe\"",
    );
  }
  const executorEnvAllowlist =
    merged.executorEnvAllowlist === undefined
      ? executorMode === "safe"
        ? [...DEFAULT_EXECUTOR_ENV_ALLOWLIST]
        : []
      : parseStringList("executorEnvAllowlist", merged.executorEnvAllowlist);
  if (
    executorMode === "safe" &&
    executorEnvAllowlist.some((name) => !DEFAULT_EXECUTOR_ENV_ALLOWLIST.includes(name))
  ) {
    throw new ConfigError(
      "executorEnvAllowlist: safe mode may inherit only ANTHROPIC_API_KEY; use an " +
        "externally sandboxed executor for other credentials",
    );
  }

  let resultUploader: string | null = null;
  if (merged.resultUploader !== undefined && merged.resultUploader !== null) {
    let url: URL;
    try {
      url = new URL(merged.resultUploader);
    } catch {
      throw new ConfigError(`resultUploader: not a valid URL`);
    }
    if (url.protocol !== "https:") {
      throw new ConfigError(
        `resultUploader: must be an https: URL (got ${url.protocol}//)`,
      );
    }
    resultUploader = merged.resultUploader;
  }

  const endpoint = merged.endpoint ?? DEFAULT_ENDPOINT;
  if (
    endpoint === "" ||
    (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) ||
    endpoint.length > 128
  ) {
    throw new ConfigError(
      "endpoint: must be a non-empty http(s) URL of at most 128 chars (on-chain register_agent rule)",
    );
  }

  const creatorAllowlist =
    merged.creatorAllowlist === undefined
      ? null
      : parseAllowlist("creatorAllowlist", merged.creatorAllowlist);
  const allowAnyCreator =
    merged.allowAnyCreator === undefined
      ? false
      : parseBoolean("allowAnyCreator", merged.allowAnyCreator);

  return {
    rpcUrl: merged.rpcUrl,
    walletPath: merged.walletPath,
    capabilities,
    minRewardLamports,
    maxRewardLamports,
    allowUnboundedReward,
    executor,
    executorMode,
    executorEnvAllowlist,
    resultUploader,
    stateDir: merged.stateDir ?? defaultStateDir(),
    creatorAllowlist,
    allowAnyCreator,
    endpoint,
    pollIntervalMs:
      merged.pollIntervalMs === undefined
        ? DEFAULT_POLL_INTERVAL_MS
        : parseNumber("pollIntervalMs", merged.pollIntervalMs),
    executorTimeoutMs:
      merged.executorTimeoutMs === undefined
        ? DEFAULT_EXECUTOR_TIMEOUT_MS
        : parseNumber("executorTimeoutMs", merged.executorTimeoutMs),
  };
}

/**
 * Enforce claim-risk policy at active-worker startup. Readonly `status` can
 * still resolve a partial config, but `up`/`once` and programmatic ticks fail
 * before registration or claiming unless both limits are explicit.
 */
export function assertActiveWorkerConfig(
  config: Pick<
    WorkerConfig,
    | "maxRewardLamports"
    | "allowUnboundedReward"
    | "creatorAllowlist"
    | "allowAnyCreator"
    | "executor"
    | "executorMode"
    | "executorEnvAllowlist"
  >,
): void {
  if (config.maxRewardLamports === null && !config.allowUnboundedReward) {
    throw new ConfigError(
      "maxRewardLamports is required for up/once. Set a finite bait cap, or " +
        "explicitly opt out with allowUnboundedReward=true.",
    );
  }
  if (config.creatorAllowlist === null && !config.allowAnyCreator) {
    throw new ConfigError(
      "creatorAllowlist is required for up/once. List trusted creator addresses, or " +
        "explicitly opt out with allowAnyCreator=true.",
    );
  }
  if (
    config.executorMode !== "safe" &&
    config.executorMode !== "sandboxed" &&
    config.executorMode !== "unsafe"
  ) {
    throw new ConfigError(`executorMode: invalid runtime value ${String(config.executorMode)}`);
  }
  if (config.executorMode === "safe") {
    if (!argvEquals(config.executor, DEFAULT_EXECUTOR)) {
      throw new ConfigError(
        "executor: runtime safe mode requires the built-in tool-less executor argv",
      );
    }
    if (
      config.executorEnvAllowlist.some(
        (name) => !DEFAULT_EXECUTOR_ENV_ALLOWLIST.includes(name),
      )
    ) {
      throw new ConfigError(
        "executorEnvAllowlist: runtime safe mode may inherit only ANTHROPIC_API_KEY",
      );
    }
    if (!config.executorEnvAllowlist.includes("ANTHROPIC_API_KEY")) {
      throw new ConfigError(
        "executorEnvAllowlist: runtime safe mode requires ANTHROPIC_API_KEY inheritance",
      );
    }
    if ((process.env.ANTHROPIC_API_KEY ?? "").trim() === "") {
      throw new ConfigError(
        "ANTHROPIC_API_KEY is required by the isolated safe executor; refusing to " +
          "register or claim before executor authentication is ready",
      );
    }
  }
}
