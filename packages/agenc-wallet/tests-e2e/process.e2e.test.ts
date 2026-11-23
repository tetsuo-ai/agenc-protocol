// The wallet as its own process, the way a desktop host runs it: secrets on
// stdin, one "ready" line on stdout, and it stops when the host closes the
// pipe. Runs the CLI from source in practice mode.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { connectWallet } from "../src/client/socket-client.js";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let child: ChildProcess | null = null;
afterEach(() => {
  child?.kill("SIGKILL");
  child = null;
});

function exited(process: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => process.once("exit", (code) => resolve(code)));
}

describe("the wallet service process", () => {
  it("starts from a line on stdin, serves its owner, and stops when the host goes away", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-wallet-proc-"));
    const socketPath = path.join(dir, "w.sock");
    const ownerToken = randomBytes(32).toString("hex");
    const started = spawn(
      process.execPath,
      ["--import", "tsx", cli, "serve", "--data-dir", dir, "--socket", socketPath, "--network", "sandbox"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child = started;
    const ready = new Promise<{ ready: boolean; socket: string; network: string }>((resolve, reject) => {
      let buffered = "";
      started.stdout!.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const newline = buffered.indexOf("\n");
        if (newline !== -1) resolve(JSON.parse(buffered.slice(0, newline)));
      });
      started.once("exit", (code) => reject(new Error(`the service exited early (${code})`)));
    });
    started.stdin!.write(
      `${JSON.stringify({ unlockSecret: randomBytes(32).toString("base64"), ownerToken })}\n`,
    );
    const line = await ready;
    expect(line).toMatchObject({ ready: true, socket: socketPath, network: "sandbox" });

    const owner = await connectWallet({ socketPath, token: ownerToken });
    const overview = await owner.call("overview", {});
    expect(overview.capabilities).toEqual(["earn-finishing", "service-discovery-v1"]);
    expect(overview.network).toBe("sandbox");
    expect(overview.main.balance.usdCents).toBe(5_000);
    const { services } = await owner.call("market.find", {});
    expect(services.map((service) => service.name)).toContain("Haiku Writer");
    owner.close();

    // The host closes the pipe: the service must not outlive it.
    const gone = exited(started);
    started.stdin!.end();
    const code = await Promise.race([
      gone,
      new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 8_000)),
    ]);
    expect(code).toBe(0);
    child = null;
  }, 60_000);

  it("refuses to start without a wallet when nothing arrives on stdin", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-wallet-proc-"));
    const started = spawn(
      process.execPath,
      ["--import", "tsx", cli, "serve", "--data-dir", dir, "--network", "sandbox"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child = started;
    let stderr = "";
    started.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    started.stdin!.end();
    expect(await exited(started)).toBe(1);
    expect(stderr).toMatch(/agenc-wallet init/);
    child = null;
  }, 30_000);
});
