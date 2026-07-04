// Execute a claimed task by shelling out to the coding-agent CLI the operator
// already runs (Claude Code by default) — WITHOUT a shell.
//
// SECURITY INVARIANTS (do not weaken):
// - `spawn(..., { shell: false })` ALWAYS. The prompt (task description +
//   job-spec content) is UNTRUSTED DATA; it is passed as ONE argv element, so
//   `;`, `$( )`, backticks, pipes, and quotes in task content are inert bytes
//   to the OS — the executor process receives them verbatim as an argument.
// - Task content is never eval'd, never string-concatenated into a shell, and
//   never written to a file that gets executed.
// - stdout is captured with a hard byte cap (default 10 MiB); exceeding it
//   kills the executor and fails the task (nothing is submitted).
// - A non-zero exit code, a signal death, or a wall-clock timeout is a task
//   execution FAILURE — nothing is submitted.
import { spawn } from "node:child_process";

/** Placeholder element replaced by the prompt (as a single argv element). */
export const PROMPT_PLACEHOLDER = "{prompt}";

/** Hard cap on captured executor stdout (bytes). */
export const DEFAULT_MAX_STDOUT_BYTES = 10 * 1024 * 1024;

/** Thrown when the executor fails (non-zero exit, signal, timeout, overflow). */
export class ExecutorError extends Error {
  override name = "ExecutorError";
  constructor(
    message: string,
    readonly detail: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      reason: "exit" | "signal" | "timeout" | "stdout-overflow" | "spawn";
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
 * Spawn the executor argv with `shell: false`, pass the prompt as one argv
 * element, capture stdout (bounded), inherit stderr for operator visibility.
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
}): Promise<ExecutorResult> {
  const { argv, prompt, timeoutMs } = options;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const [command, ...args] = buildExecutorArgv(argv, prompt);

  return new Promise<ExecutorResult>((resolve, reject) => {
    const child = spawn(command!, args, {
      shell: false, // NEVER a shell — see the module invariants.
      stdio: ["ignore", "pipe", "inherit"],
    });

    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let failure: ExecutorError | null = null;

    const timer = setTimeout(() => {
      failure = new ExecutorError(
        `executor timed out after ${timeoutMs}ms`,
        { exitCode: null, signal: null, reason: "timeout" },
      );
      child.kill("SIGKILL");
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
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
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
