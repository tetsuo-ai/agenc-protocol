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
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { address } from "@solana/kit";

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

/** Default content host for anchored buyer→worker change-request envelopes. */
export const DEFAULT_TASK_THREAD_BASE_URL = "https://agenc.ag";

type WorkerStateIdentity = Pick<WorkerConfigInput, "rpcUrl" | "walletPath">;

function workerStateRoot(): string {
  return path.join(homedir(), ".local", "state", "agenc-worker");
}

/**
 * Default state directory, namespaced by the canonical RPC and wallet path.
 * The optional form is retained for callers that only need the historical
 * root path; active config resolution always supplies an identity.
 */
export function defaultStateDir(identity?: WorkerStateIdentity): string {
  const root = workerStateRoot();
  if (identity === undefined) return root;
  if (
    typeof identity.rpcUrl !== "string" ||
    typeof identity.walletPath !== "string"
  ) {
    throw new ConfigError(
      "defaultStateDir requires string rpcUrl and walletPath identity fields",
    );
  }
  let canonicalRpc: string;
  try {
    canonicalRpc = new URL(identity.rpcUrl).href;
  } catch {
    throw new ConfigError("defaultStateDir requires a valid absolute rpcUrl");
  }
  const namespace = createHash("sha256")
    .update(
      JSON.stringify({
        rpcUrl: canonicalRpc,
        walletPath: path.resolve(identity.walletPath),
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return path.join(root, namespace);
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
  /** HTTPS content host used to resolve anchored request_changes envelopes. */
  taskThreadBaseUrl: string;
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
  taskThreadBaseUrl: string;
  pollIntervalMs: string | number;
  executorTimeoutMs: string | number;
}>;

/** Thrown for any invalid/missing configuration; message names the field. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

const U64_MAX = 18_446_744_073_709_551_615n;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_CONFIG_FILE_BYTES = 64 * 1024;
const CONFIG_FILE_KEYS = [
  "rpcUrl",
  "walletPath",
  "capabilities",
  "minRewardLamports",
  "maxRewardLamports",
  "allowUnboundedReward",
  "executor",
  "executorMode",
  "executorEnvAllowlist",
  "resultUploader",
  "stateDir",
  "creatorAllowlist",
  "allowAnyCreator",
  "endpoint",
  "taskThreadBaseUrl",
  "pollIntervalMs",
  "executorTimeoutMs",
] as const satisfies readonly (keyof WorkerConfigInput)[];

function configFileFieldError(
  filePath: string,
  field: string,
  expectation: string,
): never {
  throw new ConfigError(`${filePath}: "${field}" must be ${expectation}`);
}

function configFileUrl(
  filePath: string,
  field: string,
  value: unknown,
  options: {
    protocols: readonly string[];
    allowQuery: boolean;
    maxBytes?: number;
  },
): URL {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    configFileFieldError(filePath, field, "a non-empty absolute URL string");
  }
  if (
    options.maxBytes !== undefined &&
    new TextEncoder().encode(value).byteLength > options.maxBytes
  ) {
    configFileFieldError(
      filePath,
      field,
      `an absolute URL of at most ${options.maxBytes} UTF-8 bytes`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    configFileFieldError(filePath, field, "a valid absolute URL");
  }
  if (
    !options.protocols.includes(url.protocol) ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    (!options.allowQuery && (url.search !== "" || url.hash !== ""))
  ) {
    const protocols = options.protocols.join(" or ");
    configFileFieldError(
      filePath,
      field,
      `a credential-free ${protocols} URL${
        options.allowQuery ? "" : " without query or fragment"
      }`,
    );
  }
  return url;
}

function validateConfigFileObject(
  parsed: Record<string, unknown>,
  filePath: string,
): WorkerConfigInput {
  const allowed = new Set<string>(CONFIG_FILE_KEYS);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new ConfigError(`${filePath}: unknown property "${unknown}"`);
  }

  for (const [field, value] of Object.entries(parsed)) {
    switch (field as (typeof CONFIG_FILE_KEYS)[number]) {
      case "rpcUrl":
        configFileUrl(filePath, field, value, {
          protocols: ["http:", "https:"],
          allowQuery: true,
        });
        break;
      case "walletPath":
      case "stateDir":
        if (
          typeof value !== "string" ||
          value.trim() === "" ||
          /[\u0000-\u001f\u007f]/u.test(value)
        ) {
          configFileFieldError(
            filePath,
            field,
            "a non-empty path without control characters",
          );
        }
        break;
      case "capabilities":
      case "minRewardLamports":
      case "maxRewardLamports": {
        if (field === "maxRewardLamports" && value === null) break;
        if (
          typeof value !== "string" ||
          !/^(0|[1-9]\d*)$/u.test(value) ||
          BigInt(value) > U64_MAX ||
          (field === "capabilities" && value === "0")
        ) {
          configFileFieldError(
            filePath,
            field,
            field === "capabilities"
              ? `a canonical decimal string in 1..${U64_MAX}`
              : `a canonical decimal string in 0..${U64_MAX}`,
          );
        }
        break;
      }
      case "allowUnboundedReward":
      case "allowAnyCreator":
        if (typeof value !== "boolean") {
          configFileFieldError(filePath, field, "a JSON boolean");
        }
        break;
      case "executor": {
        if (!Array.isArray(value) || value.length === 0) {
          configFileFieldError(
            filePath,
            field,
            "a non-empty array of non-empty strings",
          );
        }
        const invalidIndex = value.findIndex(
          (entry) => typeof entry !== "string" || entry.length === 0,
        );
        if (invalidIndex !== -1) {
          configFileFieldError(
            filePath,
            `${field}[${invalidIndex}]`,
            "a non-empty string",
          );
        }
        break;
      }
      case "executorMode":
        if (value !== "safe" && value !== "sandboxed" && value !== "unsafe") {
          configFileFieldError(
            filePath,
            field,
            '"safe", "sandboxed", or "unsafe"',
          );
        }
        break;
      case "executorEnvAllowlist": {
        if (!Array.isArray(value)) {
          configFileFieldError(
            filePath,
            field,
            "an array of environment variable names",
          );
        }
        const invalidIndex = value.findIndex(
          (entry) =>
            typeof entry !== "string" ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry),
        );
        if (invalidIndex !== -1) {
          configFileFieldError(
            filePath,
            `${field}[${invalidIndex}]`,
            "an environment variable name",
          );
        }
        break;
      }
      case "resultUploader":
        if (value !== null) {
          configFileUrl(filePath, field, value, {
            protocols: ["https:"],
            allowQuery: true,
          });
        }
        break;
      case "creatorAllowlist": {
        if (value === null) break;
        if (!Array.isArray(value)) {
          configFileFieldError(
            filePath,
            field,
            "null or an array of non-empty base58 address strings",
          );
        }
        const invalidIndex = value.findIndex(
          (entry) => typeof entry !== "string" || entry.trim() === "",
        );
        if (invalidIndex !== -1) {
          configFileFieldError(
            filePath,
            `${field}[${invalidIndex}]`,
            "a non-empty base58 address string",
          );
        }
        for (const [index, entry] of value.entries()) {
          try {
            address(entry as string);
          } catch {
            configFileFieldError(
              filePath,
              `${field}[${index}]`,
              "a valid Solana base58 address",
            );
          }
        }
        break;
      }
      case "endpoint":
        configFileUrl(filePath, field, value, {
          protocols: ["http:", "https:"],
          allowQuery: true,
          maxBytes: 128,
        });
        break;
      case "taskThreadBaseUrl":
        configFileUrl(filePath, field, value, {
          protocols: ["https:"],
          allowQuery: false,
        });
        break;
      case "pollIntervalMs":
      case "executorTimeoutMs":
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value <= 0 ||
          value > MAX_TIMER_MS
        ) {
          configFileFieldError(
            filePath,
            field,
            `a positive JSON integer no greater than ${MAX_TIMER_MS}`,
          );
        }
        break;
    }
  }

  if (
    typeof parsed.minRewardLamports === "string" &&
    typeof parsed.maxRewardLamports === "string" &&
    BigInt(parsed.maxRewardLamports) < BigInt(parsed.minRewardLamports)
  ) {
    configFileFieldError(
      filePath,
      "maxRewardLamports",
      "greater than or equal to minRewardLamports",
    );
  }

  return parsed as WorkerConfigInput;
}

function parseBigint(field: string, value: unknown): bigint {
  if (typeof value === "bigint") {
    if (value >= 0n && value <= U64_MAX) return value;
    throw new ConfigError(
      `${field}: expected a u64 integer, got ${String(value)}`,
    );
  }
  if (typeof value !== "string") {
    throw new ConfigError(
      `${field}: expected a canonical decimal u64 string, got ${JSON.stringify(value)}`,
    );
  }
  const canonical = value.trim();
  if (value !== canonical || !/^(0|[1-9]\d*)$/u.test(canonical)) {
    throw new ConfigError(
      `${field}: expected a canonical decimal u64 string, got ${JSON.stringify(value)}`,
    );
  }
  const parsed = BigInt(canonical);
  if (parsed > U64_MAX) {
    throw new ConfigError(`${field}: must be no greater than ${U64_MAX}`);
  }
  return parsed;
}

function parseNumber(field: string, value: unknown): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (
    typeof value === "string" &&
    value === value.trim() &&
    /^(0|[1-9]\d*)$/u.test(value)
  ) {
    parsed = Number(value);
  } else {
    throw new ConfigError(
      `${field}: expected a canonical positive integer, got ${JSON.stringify(value)}`,
    );
  }
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TIMER_MS) {
    throw new ConfigError(
      `${field}: expected a positive integer no greater than ${MAX_TIMER_MS}, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function parseBoolean(field: string, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
    if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  }
  throw new ConfigError(
    `${field}: expected true or false, got ${JSON.stringify(value)}`,
  );
}

function parseExecutor(field: string, value: unknown): string[] {
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

function parseAllowlist(field: string, value: unknown): string[] | null {
  if (value === null) return null;
  const list =
    typeof value === "string"
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : value;
  if (
    !Array.isArray(list) ||
    !list.every((entry) => typeof entry === "string" && entry.trim() !== "")
  ) {
    throw new ConfigError(`${field}: expected an array of base58 addresses`);
  }
  for (const entry of list) {
    try {
      address(entry);
    } catch {
      throw new ConfigError(
        `${field}: invalid Solana address ${JSON.stringify(entry)}`,
      );
    }
  }
  return list.length === 0 ? null : [...new Set(list)];
}

function parseStringList(field: string, value: unknown): string[] {
  let list: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        list = JSON.parse(trimmed);
      } catch {
        throw new ConfigError(
          `${field}: expected a JSON array or comma-separated names`,
        );
      }
    } else {
      list = trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }
  if (
    !Array.isArray(list) ||
    !list.every(
      (entry) =>
        typeof entry === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry),
    )
  ) {
    throw new ConfigError(`${field}: expected environment variable names`);
  }
  return [...new Set(list as string[])];
}

function parseExecutorMode(value: unknown): ExecutorMode {
  if (value === "safe" || value === "sandboxed" || value === "unsafe")
    return value;
  throw new ConfigError(
    `executorMode: expected "safe", "sandboxed", or "unsafe", got ${JSON.stringify(value)}`,
  );
}

function parsePathString(field: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ConfigError(
      `${field}: expected a non-empty path without control characters`,
    );
  }
  return value;
}

function parseHttpUrl(
  field: string,
  value: unknown,
  protocols: readonly string[],
  options: { allowQuery?: boolean; maxBytes?: number } = {},
): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ConfigError(`${field}: expected an absolute URL string`);
  }
  if (
    options.maxBytes !== undefined &&
    new TextEncoder().encode(value).byteLength > options.maxBytes
  ) {
    throw new ConfigError(
      `${field}: URL must be at most ${options.maxBytes} UTF-8 bytes`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${field}: not a valid absolute URL`);
  }
  if (
    !protocols.includes(url.protocol) ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    (options.allowQuery === false && (url.search !== "" || url.hash !== ""))
  ) {
    throw new ConfigError(
      `${field}: must be a ${protocols.join(" or ")} URL without credentials${
        options.allowQuery === false ? " without query or fragment" : ""
      }`,
    );
  }
  return value;
}

function argvEquals(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** Map `AGENC_WORKER_*` environment variables to a config input. */
export function configFromEnv(
  env: Record<string, string | undefined>,
): WorkerConfigInput {
  const input: WorkerConfigInput = {};
  if (env.AGENC_WORKER_RPC_URL !== undefined)
    input.rpcUrl = env.AGENC_WORKER_RPC_URL;
  if (env.AGENC_WORKER_WALLET !== undefined)
    input.walletPath = env.AGENC_WORKER_WALLET;
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
  if (env.AGENC_WORKER_EXECUTOR !== undefined)
    input.executor = env.AGENC_WORKER_EXECUTOR;
  if (env.AGENC_WORKER_EXECUTOR_MODE !== undefined) {
    input.executorMode = env.AGENC_WORKER_EXECUTOR_MODE;
  }
  if (env.AGENC_WORKER_EXECUTOR_ENV_ALLOWLIST !== undefined) {
    input.executorEnvAllowlist = env.AGENC_WORKER_EXECUTOR_ENV_ALLOWLIST;
  }
  if (env.AGENC_WORKER_RESULT_UPLOADER !== undefined) {
    input.resultUploader = env.AGENC_WORKER_RESULT_UPLOADER;
  }
  if (env.AGENC_WORKER_STATE_DIR !== undefined)
    input.stateDir = env.AGENC_WORKER_STATE_DIR;
  if (env.AGENC_WORKER_CREATOR_ALLOWLIST !== undefined) {
    input.creatorAllowlist = env.AGENC_WORKER_CREATOR_ALLOWLIST;
  }
  if (env.AGENC_WORKER_ALLOW_ANY_CREATOR !== undefined) {
    input.allowAnyCreator = env.AGENC_WORKER_ALLOW_ANY_CREATOR;
  }
  if (env.AGENC_WORKER_ENDPOINT !== undefined)
    input.endpoint = env.AGENC_WORKER_ENDPOINT;
  if (env.AGENC_WORKER_TASK_THREAD_BASE_URL !== undefined) {
    input.taskThreadBaseUrl = env.AGENC_WORKER_TASK_THREAD_BASE_URL;
  }
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
  let pathStat: ReturnType<typeof lstatSync>;
  try {
    pathStat = lstatSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!explicit && (code === "ENOENT" || code === "ENOTDIR")) return {};
    throw new ConfigError(
      `config file ${filePath}: ${(error as Error).message}`,
    );
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new ConfigError(
      `config file ${filePath}: must be a regular file and not a symbolic link`,
    );
  }
  if (pathStat.size > MAX_CONFIG_FILE_BYTES) {
    throw new ConfigError(
      `config file ${filePath}: exceeds ${MAX_CONFIG_FILE_BYTES} bytes`,
    );
  }
  let raw: string;
  let fd: number | undefined;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== pathStat.dev ||
      opened.ino !== pathStat.ino
    ) {
      throw new Error("file changed while it was being opened");
    }
    if (
      typeof process.getuid === "function" &&
      opened.uid !== process.getuid()
    ) {
      throw new Error("file must be owned by the current user");
    }
    if (process.platform !== "win32" && (opened.mode & 0o077) !== 0) {
      throw new Error("file must have private permissions (chmod 600)");
    }
    if (opened.size > MAX_CONFIG_FILE_BYTES) {
      throw new Error(`file exceeds ${MAX_CONFIG_FILE_BYTES} bytes`);
    }
    raw = readFileSync(fd, "utf8");
  } catch (error) {
    throw new ConfigError(
      `config file ${filePath}: ${(error as Error).message}`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
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
  return validateConfigFileObject(parsed as Record<string, unknown>, filePath);
}

/** Merge config sources (later sources are LOWER precedence) and validate. */
export function resolveWorkerConfig(
  ...sources: WorkerConfigInput[]
): WorkerConfig {
  // First source wins per field: flags > env > file.
  const merged: WorkerConfigInput = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (!(CONFIG_FILE_KEYS as readonly string[]).includes(key)) {
        throw new ConfigError(`unknown configuration property "${key}"`);
      }
      if (value === undefined) continue;
      if ((merged as Record<string, unknown>)[key] === undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }

  if (merged.rpcUrl === undefined) {
    throw new ConfigError(
      "rpcUrl is required (--rpc-url, AGENC_WORKER_RPC_URL, or the config file)",
    );
  }
  if (merged.walletPath === undefined) {
    throw new ConfigError(
      "walletPath is required (--wallet, AGENC_WORKER_WALLET, or the config file). " +
        "Use a LOW-FUNDED hot wallet — it is the worker's only spend authority.",
    );
  }
  const rpcUrl = parseHttpUrl("rpcUrl", merged.rpcUrl, ["http:", "https:"]);
  const walletPath = parsePathString("walletPath", merged.walletPath);

  const capabilities =
    merged.capabilities === undefined
      ? DEFAULT_CAPABILITIES
      : parseBigint("capabilities", merged.capabilities);
  if (capabilities === 0n) {
    throw new ConfigError(
      "capabilities: must be non-zero (the program rejects 0)",
    );
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
        'sandbox and set executorMode="sandboxed", or explicitly acknowledge legacy ' +
        'host access with executorMode="unsafe"',
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
    executorEnvAllowlist.some(
      (name) => !DEFAULT_EXECUTOR_ENV_ALLOWLIST.includes(name),
    )
  ) {
    throw new ConfigError(
      "executorEnvAllowlist: safe mode may inherit only ANTHROPIC_API_KEY; use an " +
        "externally sandboxed executor for other credentials",
    );
  }

  let resultUploader: string | null = null;
  if (merged.resultUploader !== undefined && merged.resultUploader !== null) {
    resultUploader = parseHttpUrl("resultUploader", merged.resultUploader, [
      "https:",
    ]);
  }

  const endpoint = parseHttpUrl(
    "endpoint",
    merged.endpoint ?? DEFAULT_ENDPOINT,
    ["http:", "https:"],
    { maxBytes: 128 },
  );

  const taskThreadBaseUrl = parseHttpUrl(
    "taskThreadBaseUrl",
    merged.taskThreadBaseUrl ?? DEFAULT_TASK_THREAD_BASE_URL,
    ["https:"],
    { allowQuery: false },
  );

  const creatorAllowlist =
    merged.creatorAllowlist === undefined
      ? null
      : parseAllowlist("creatorAllowlist", merged.creatorAllowlist);
  const allowAnyCreator =
    merged.allowAnyCreator === undefined
      ? false
      : parseBoolean("allowAnyCreator", merged.allowAnyCreator);

  const usesDefaultStateDir = merged.stateDir === undefined;
  const stateDir = parsePathString(
    "stateDir",
    merged.stateDir ?? defaultStateDir({ rpcUrl, walletPath }),
  );
  if (usesDefaultStateDir) {
    const legacyState = path.join(workerStateRoot(), "state.json");
    const namespacedState = path.join(stateDir, "state.json");
    let legacyExists = false;
    let namespacedExists = false;
    try {
      lstatSync(legacyState);
      legacyExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      lstatSync(namespacedState);
      namespacedExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (legacyExists && !namespacedExists) {
      throw new ConfigError(
        `legacy unnamespaced worker state detected at ${legacyState}; move it to ${stateDir} or explicitly set stateDir to acknowledge the shared legacy path`,
      );
    }
  }

  return {
    rpcUrl,
    walletPath,
    capabilities,
    minRewardLamports,
    maxRewardLamports,
    allowUnboundedReward,
    executor,
    executorMode,
    executorEnvAllowlist,
    resultUploader,
    stateDir,
    creatorAllowlist,
    allowAnyCreator,
    endpoint,
    taskThreadBaseUrl: taskThreadBaseUrl.replace(/\/+$/u, ""),
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
    throw new ConfigError(
      `executorMode: invalid runtime value ${String(config.executorMode)}`,
    );
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
