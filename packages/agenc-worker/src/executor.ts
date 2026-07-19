// Execute a claimed task by shelling out to the coding-agent CLI the operator
// already runs (Claude Code by default) — WITHOUT a shell.
//
// SECURITY INVARIANTS (do not weaken):
// - `spawn(..., { shell: false })` ALWAYS. The prompt (task description +
//   job-spec content) is UNTRUSTED DATA; it is passed as ONE argv element, so
//   `;`, `$( )`, backticks, pipes, and quotes in task content are inert bytes
//   to the OS — the executor process receives them verbatim as an argument.
// - Safe/sandboxed execution uses a fresh 0700 scratch cwd and HOME, a
//   minimal environment, and no ambient worker/RPC/wallet variables.
// - Task content is never eval'd, never string-concatenated into a shell, and
//   never written to a file that gets executed.
// - stdout is captured with a hard byte cap (default 10 MiB); exceeding it
//   kills the executor and fails the task (nothing is submitted).
// - A non-zero exit code, a signal death, or a wall-clock timeout is a task
//   execution FAILURE — nothing is submitted.
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Placeholder element replaced by the prompt (as a single argv element). */
export const PROMPT_PLACEHOLDER = "{prompt}";

/** Hard cap on captured executor stdout (bytes). */
export const DEFAULT_MAX_STDOUT_BYTES = 10 * 1024 * 1024;

/** Hard cap on drained (never inherited) executor stderr. */
export const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;

/**
 * Pre-claim cap for a prompt transported as one argv element. Unix kernels
 * commonly impose a much smaller per-argument limit than ARG_MAX; Windows'
 * command-line ceiling is smaller still.
 */
export const DEFAULT_MAX_EXECUTOR_PROMPT_BYTES =
  process.platform === "win32" ? 12 * 1024 : 48 * 1024;

/** Non-secret process variables safe to preserve in the isolated executor. */
const BASE_ENV_ALLOWLIST = ["LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;

/** Thrown when the executor fails (non-zero exit, signal, timeout, overflow). */
export class ExecutorError extends Error {
  override name = "ExecutorError";
  constructor(
    message: string,
    readonly detail: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      reason:
        | "exit"
        | "signal"
        | "timeout"
        | "stdout-overflow"
        | "stderr-overflow"
        | "prompt-overflow"
        | "prompt-invalid"
        | "spawn";
    },
  ) {
    super(message);
  }
}

/**
 * Build the concrete argv from the template: every element that IS exactly
 * `"{prompt}"` becomes the prompt (one element, verbatim). If no element is
 * the placeholder, the prompt is appended as the final argv element. The
 * prompt is NEVER spliced into the middle of another string — that would
 * reintroduce an injection surface through executor-specific flag parsing.
 */
export function buildExecutorArgv(
  template: readonly string[],
  prompt: string,
): string[] {
  if (template.length === 0) {
    throw new ExecutorError("executor argv template is empty", {
      exitCode: null,
      signal: null,
      reason: "spawn",
    });
  }
  let replaced = false;
  const argv = template.map((element) => {
    if (element === PROMPT_PLACEHOLDER) {
      replaced = true;
      return prompt;
    }
    return element;
  });
  if (!replaced) argv.push(prompt);
  return argv;
}

/** Result of a successful executor run. */
export type ExecutorResult = {
  /** Captured stdout bytes (the task result body). */
  stdout: Buffer;
  exitCode: 0;
};

/**
 * Reject a prompt before claiming when it cannot safely fit in one argv
 * element on the current platform.
 */
export function assertExecutorPromptFits(
  prompt: string,
  maxBytes = DEFAULT_MAX_EXECUTOR_PROMPT_BYTES,
): void {
  if (prompt.includes("\0")) {
    throw new ExecutorError(
      "executor prompt contains a NUL byte and cannot be represented as argv",
      { exitCode: null, signal: null, reason: "prompt-invalid" },
    );
  }
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > maxBytes) {
    throw new ExecutorError(
      `executor prompt is ${bytes} bytes, above the pre-claim ${maxBytes}-byte argv cap`,
      { exitCode: null, signal: null, reason: "prompt-overflow" },
    );
  }
}

function isolatedEnvironment(
  scratchDir: string,
  allowlist: readonly string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: scratchDir,
    TMPDIR: scratchDir,
    XDG_CONFIG_HOME: path.join(scratchDir, "config"),
    XDG_CACHE_HOME: path.join(scratchDir, "cache"),
    XDG_DATA_HOME: path.join(scratchDir, "data"),
    XDG_STATE_HOME: path.join(scratchDir, "state"),
    // Defense in depth for Claude Code. The default argv also carries the
    // equivalent command-line switches, which cannot be overridden by task
    // content because the prompt is a single final argv element.
    CLAUDE_CODE_SAFE_MODE: "1",
    CLAUDE_CODE_SIMPLE: "1",
    NO_COLOR: "1",
  };
  // PATH is operational data, not a secret. Remove relative entries so a
  // task cannot influence executable lookup through the scratch cwd.
  const safePath = (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))
    .join(path.delimiter);
  env.PATH = safePath || "/usr/local/bin:/usr/bin:/bin";
  for (const key of [...BASE_ENV_ALLOWLIST, ...allowlist]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function executablePath(command: string): string | null {
  const candidates: string[] = [];
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    candidates.push(path.resolve(command));
  } else {
    const extensions =
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
        : [""];
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      for (const extension of extensions) candidates.push(path.join(directory, command + extension));
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

function missingExecutable(command: string): ExecutorError {
  return new ExecutorError(`executor command is not installed or executable: ${command}`, {
    exitCode: null,
    signal: null,
    reason: "spawn",
  });
}

/** Fail before a claim when the configured executor cannot actually start. */
export function preflightExecutor(options: {
  argv: readonly string[];
  safeClaudeMode: boolean;
  envAllowlist?: readonly string[];
}): void {
  const command = options.argv[0];
  if (command === undefined) throw missingExecutable("(empty argv)");
  const resolved = executablePath(command);
  if (resolved === null) throw missingExecutable(command);
  if (!options.safeClaudeMode) return;

  const scratchDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-preflight-"));
  try {
    const check = spawnSync(resolved, ["--help"], {
      shell: false,
      cwd: scratchDir,
      env: isolatedEnvironment(scratchDir, options.envAllowlist ?? []),
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    if (check.error !== undefined || check.status !== 0) {
      throw new ExecutorError(
        `safe executor preflight failed: ${check.error?.message ?? `exit ${check.status}`}`,
        { exitCode: check.status, signal: check.signal, reason: "spawn" },
      );
    }
    const help = `${check.stdout}\n${check.stderr}`;
    const requiredFlags = [
      "--bare",
      "--safe-mode",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--tools",
      "--no-session-persistence",
    ];
    const missing = requiredFlags.filter((flag) => !help.includes(flag));
    if (missing.length > 0) {
      throw new ExecutorError(
        `installed Claude CLI is too old for safe mode (missing ${missing.join(", ")})`,
        { exitCode: check.status, signal: check.signal, reason: "spawn" },
      );
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function killExecutor(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      // Safe/sandboxed children start a new process group. Kill descendants as
      // well so a timed-out executor cannot leave background helpers behind.
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // It may have exited between the event and this call; fall through.
    }
  }
  child.kill("SIGKILL");
}

/**
 * Spawn the executor argv with `shell: false`, pass the prompt as one argv
 * element, capture stdout (bounded), and drain stderr through a separate cap.
 */
export async function runExecutor(options: {
  /** Argv template (element `"{prompt}"` is replaced; see buildExecutorArgv). */
  argv: readonly string[];
  /** The untrusted prompt (job-spec content + task description). */
  prompt: string;
  /** Wall-clock budget in ms. */
  timeoutMs: number;
  /** stdout byte cap (default 10 MiB). */
  maxStdoutBytes?: number;
  /** stderr byte cap (default 256 KiB); stderr is drained but never inherited. */
  maxStderrBytes?: number;
  /**
   * Explicit environment variable names copied into an otherwise-scrubbed
   * child environment. Values come from the worker process and are never
   * included in the prompt (default: none).
   */
  envAllowlist?: readonly string[];
  /**
   * UNSAFE compatibility escape hatch: inherit the ambient cwd/environment.
   * Only set after an operator explicitly selected executorMode="unsafe".
   */
  unsafeInheritProcessContext?: boolean;
}): Promise<ExecutorResult> {
  const { argv, prompt, timeoutMs } = options;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  assertExecutorPromptFits(prompt);
  const [command, ...args] = buildExecutorArgv(argv, prompt);
  const resolvedCommand = executablePath(command!);
  if (resolvedCommand === null) throw missingExecutable(command!);
  const unsafe = options.unsafeInheritProcessContext === true;
  const scratchDir = unsafe
    ? null
    : mkdtempSync(path.join(tmpdir(), "agenc-worker-executor-"));
  if (scratchDir !== null) {
    for (const directory of ["config", "cache", "data", "state"]) {
      mkdirSync(path.join(scratchDir, directory), { mode: 0o700 });
    }
  }

  return new Promise<ExecutorResult>((resolve, reject) => {
    let cleaned = false;
    const cleanup = () => {
      if (cleaned || scratchDir === null) return;
      cleaned = true;
      rmSync(scratchDir, { recursive: true, force: true });
    };
    const child = spawn(resolvedCommand, args, {
      shell: false, // NEVER a shell — see the module invariants.
      // stderr is task-influenced too. Drain it through a hard cap instead of
      // inheriting it into an operator terminal or an unbounded service log.
      stdio: ["ignore", "pipe", "pipe"],
      ...(unsafe
        ? {}
        : {
            cwd: scratchDir!,
            env: isolatedEnvironment(scratchDir!, options.envAllowlist ?? []),
            detached: process.platform !== "win32",
          }),
    });

    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let failure: ExecutorError | null = null;

    const timer = setTimeout(() => {
      failure = new ExecutorError(
        `executor timed out after ${timeoutMs}ms`,
        { exitCode: null, signal: null, reason: "timeout" },
      );
      killExecutor(child);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        if (failure === null) {
          failure = new ExecutorError(
            `executor stdout exceeded the ${maxStdoutBytes}-byte cap`,
            { exitCode: null, signal: null, reason: "stdout-overflow" },
          );
        }
        killExecutor(child);
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) {
        if (failure === null) {
          failure = new ExecutorError(
            `executor stderr exceeded the ${maxStderrBytes}-byte cap`,
            { exitCode: null, signal: null, reason: "stderr-overflow" },
          );
        }
        killExecutor(child);
      }
      // Deliberately discard bytes: hostile prompts can emit terminal control
      // sequences and forge structured service logs. Exit status/reason remain
      // available to the operator without reflecting task-controlled stderr.
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (!unsafe) killExecutor(child);
      cleanup();
      reject(
        new ExecutorError(`executor failed to spawn: ${error.message}`, {
          exitCode: null,
          signal: null,
          reason: "spawn",
        }),
      );
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      // The process leader has exited. Kill any ordinary background children
      // that remain in its dedicated group before deleting their scratch cwd.
      if (!unsafe) killExecutor(child);
      cleanup();
      if (failure !== null) {
        reject(failure);
        return;
      }
      if (signal !== null) {
        reject(
          new ExecutorError(`executor was killed by signal ${signal}`, {
            exitCode,
            signal,
            reason: "signal",
          }),
        );
        return;
      }
      if (exitCode !== 0) {
        reject(
          new ExecutorError(
            `executor exited with code ${exitCode} — task execution failed, nothing submitted`,
            { exitCode, signal: null, reason: "exit" },
          ),
        );
        return;
      }
      resolve({ stdout: Buffer.concat(chunks), exitCode: 0 });
    });
  });
}
