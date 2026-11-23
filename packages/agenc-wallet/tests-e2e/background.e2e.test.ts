// The wallet run by the person's service manager, so it keeps earning after
// the host app closes. It starts locked and holds nothing until the host
// hands it the start-up line over a private socket; a host that starts again
// proves it holds the secret instead of sending it; the secret is never in
// the command line, the environment or the log. Runs the CLI from source on
// practice money.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { connectWallet } from "../src/client/socket-client.js";
import { openBackgroundWallet, unlockProof, UnlockRefused } from "../src/client/unlock.js";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

interface Locked {
  child: ChildProcess;
  dir: string;
  unlockSocket: string;
  walletSocket: string;
  stderr: () => string;
}

/** Start `serve --unlock-socket` the way a service manager does: nothing on stdin. */
async function startLocked(dir = mkdtempSync(path.join(tmpdir(), "agenc-wallet-bg-"))): Promise<Locked> {
  const runtime = path.join(dir, "run");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const unlockSocket = path.join(runtime, "unlock.sock");
  const walletSocket = path.join(runtime, "wallet.sock");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", cli, "serve", "--data-dir", dir, "--socket", walletSocket, "--network", "sandbox", "--unlock-socket", unlockSocket],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffered = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline !== -1) resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
    });
    child.once("exit", (code) => reject(new Error(`the service exited early (${code}): ${stderr}`)));
  });
  expect(first).toEqual({ locked: true, unlockSocket, network: "sandbox" });
  return { child, dir, unlockSocket, walletSocket, stderr: () => stderr };
}

function startup(secret: Buffer, ownerToken = randomBytes(32).toString("hex")) {
  return { unlockSecret: secret.toString("base64"), ownerToken };
}

/** Send raw lines on the unlock socket and collect the answers. */
function talk(socketPath: string, lines: unknown[]): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const answers: Array<Record<string, unknown>> = [];
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      for (const line of lines) socket.write(`${JSON.stringify(line)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        answers.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
      if (answers.length >= lines.length) socket.end();
    });
    socket.on("close", () => resolve(answers));
    socket.on("error", reject);
  });
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

describe("the wallet under a service manager", () => {
  it("starts locked, serves nothing, and opens with the start-up line from its host", async () => {
    const service = await startLocked();
    // Locked: nobody can talk to the wallet.
    await expect(connectWallet({ socketPath: service.walletSocket, token: "x".repeat(64), connectTimeoutMs: 1_000 })).rejects.toThrow();

    const secret = randomBytes(32);
    const line = startup(secret);
    const opened = await openBackgroundWallet({ socketPath: service.unlockSocket, unlockSecret: secret, startup: () => line });
    expect(opened).toEqual({ socket: service.walletSocket, ownerToken: line.ownerToken, unlocked: true });
    const owner = await connectWallet({ socketPath: opened.socket, token: opened.ownerToken });
    const overview = await owner.call("overview", {});
    expect(overview.capabilities).toEqual(["earn-finishing", "delivery-review-v2"]);
    expect(overview.main.balance.usdCents).toBe(5_000);
    const agent = await owner.call("agents.create", { name: "Worker" });
    owner.close();

    // The host closes and starts again: it proves the secret, it does not send it.
    const again = await openBackgroundWallet({
      socketPath: service.unlockSocket,
      unlockSecret: secret,
      startup: () => {
        throw new Error("the start-up line must not be sent to a running wallet");
      },
    });
    expect(again).toEqual({ socket: service.walletSocket, ownerToken: line.ownerToken, unlocked: false });
    const back = await connectWallet({ socketPath: again.socket, token: again.ownerToken });
    const reconnected = await back.call("overview", {});
    expect(reconnected.capabilities).toEqual(["earn-finishing", "delivery-review-v2"]);
    expect(reconnected.agents.map((entry) => entry.id)).toContain(agent.id);
    back.close();

    // The secret is in no command line, environment or log of the service.
    const needle = secret.toString("base64");
    if (process.platform === "linux") {
      expect(readFileSync(`/proc/${service.child.pid}/cmdline`, "utf8")).not.toContain(needle);
      expect(readFileSync(`/proc/${service.child.pid}/environ`, "utf8")).not.toContain(needle);
    }
    expect(service.stderr()).not.toContain(needle);
    expect(service.stderr()).not.toContain(line.ownerToken);

    // Stopped by its service manager, it closes and exits cleanly.
    const gone = exited(service.child);
    service.child.kill("SIGTERM");
    expect(await gone).toBe(0);
  }, 90_000);

  it("gives nothing to a host that does not hold the secret", async () => {
    const service = await startLocked();
    const secret = randomBytes(32);
    await openBackgroundWallet({ socketPath: service.unlockSocket, unlockSecret: secret, startup: () => startup(secret) });

    await expect(
      openBackgroundWallet({ socketPath: service.unlockSocket, unlockSecret: randomBytes(32), startup: () => startup(randomBytes(32)) }),
    ).rejects.toBeInstanceOf(UnlockRefused);
    // A second unlock of an open wallet is refused, whatever it carries.
    const [, refused] = await talk(service.unlockSocket, [{ type: "hello" }, { type: "unlock", startup: startup(secret) }]);
    expect(refused).toMatchObject({ ok: false });
    expect(JSON.stringify(refused)).not.toContain("ownerToken");
    // A proof needs this connection's own one-time value.
    const [hello] = await talk(service.unlockSocket, [{ type: "hello" }]);
    const stale = await talk(service.unlockSocket, [{ type: "prove", mac: unlockProof(secret, String(hello!.nonce)) }]);
    expect(stale).toEqual([{ ok: false, error: "Say hello first." }]);
    expect(service.stderr()).toMatch(/unlock proof refused/);
  }, 90_000);

  it("stays locked when the start-up line does not open this wallet", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-wallet-bg-"));
    const first = await startLocked(dir);
    const secret = randomBytes(32);
    await openBackgroundWallet({ socketPath: first.unlockSocket, unlockSecret: secret, startup: () => startup(secret) });
    const gone = exited(first.child);
    first.child.kill("SIGTERM");
    await gone;

    // The service manager starts it again (a crash, a login): locked.
    const second = await startLocked(dir);
    const wrong = randomBytes(32);
    await expect(
      openBackgroundWallet({ socketPath: second.unlockSocket, unlockSecret: wrong, startup: () => startup(wrong) }),
    ).rejects.toThrow(/could not be unlocked/);
    // Still locked: the right host opens it.
    const opened = await openBackgroundWallet({ socketPath: second.unlockSocket, unlockSecret: secret, startup: () => startup(secret) });
    expect(opened.unlocked).toBe(true);
    expect(second.stderr()).not.toContain(wrong.toString("base64"));
  }, 120_000);
});
