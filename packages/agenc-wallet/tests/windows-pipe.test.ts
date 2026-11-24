// Windows transport without PowerShell. Unix sockets stand in for named pipes
// here: on Windows the same code listens with Node's own named pipe, and the
// client sends no secret before the service proved it holds it.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ file: string; args: readonly string[] }> }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (file: string, args: readonly string[], options: object) => {
      spawned.calls.push({ file, args });
      if (/powershell/i.test(file)) throw new Error("PowerShell must not start.");
      return real.spawn(file, args as string[], options);
    },
  };
});

import { connectWallet } from "../src/client/socket-client.js";
import { helloProof, type HelloProofContext } from "../src/client/hello-proof.js";
import { openBackgroundWallet, unlockServerKeyFile, unlockServerProof, UnlockRefused } from "../src/client/unlock.js";
import { listenWindowsPipe, PipeHelperUnavailable, PipeNameTaken } from "../src/client/windows-pipe.js";
import { agentToken, serveWallet, type WalletServer } from "../src/server.js";
import { listenForUnlock, type OpenWallet, type UnlockServer } from "../src/unlock-server.js";
import type { AgencWallet } from "../src/wallet.js";

const cleanups: Array<() => unknown> = [];
beforeEach(() => {
  spawned.calls.length = 0;
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function folder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agenc-pipe-"));
  chmodSync(dir, 0o700);
  return dir;
}

/** Act as Windows for `run`: the code takes its win32 paths. */
async function asWindows<T>(run: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...real, value: "win32" });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

const OWNER = "o".repeat(64);
const AGENT = "agent_1";
const fakeWallet = {
  on: () => () => undefined,
  overview: async () => ({ fake: true }),
} as unknown as AgencWallet;

async function wallet(socketPath: string): Promise<WalletServer> {
  const server = await serveWallet({ wallet: fakeWallet, socketPath, ownerToken: OWNER, agentExists: (id) => id === AGENT });
  cleanups.push(() => server.close());
  return server;
}

/** A stand-in at the wallet's socket that knows no credential and keeps every byte. */
async function impostor(socketPath: string, answer: (line: Record<string, unknown>) => unknown): Promise<string[]> {
  const received: string[] = [];
  const server: Server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      received.push(chunk.toString("utf8"));
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const reply = answer(JSON.parse(line) as Record<string, unknown>);
        if (reply !== undefined) socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return received;
}

describe.skipIf(process.platform === "win32")("Windows transport without PowerShell", () => {
  it("serves the owner pipe and the unlock pipe with Node and connects without a helper", async () => {
    const dir = folder();
    await asWindows(async () => {
      await wallet(path.join(dir, "w.sock"));
      const client = await connectWallet({ socketPath: path.join(dir, "w.sock"), token: OWNER });
      expect(client.role).toBe("owner");
      expect(await client.call("overview", {} as never)).toEqual({ fake: true });
      client.close();
      let open: OpenWallet | null = null;
      const unlock = await listenForUnlock({
        socketPath: path.join(dir, "u.sock"),
        serverKeyFile: unlockServerKeyFile(dir),
        unlock: async () => {
          open = { unlockSecret: new Uint8Array(32).fill(3), ownerToken: OWNER, socket: "w" };
        },
        opened: () => open,
        log: () => undefined,
      });
      cleanups.push(() => unlock.close());
      const opened = await openBackgroundWallet({
        socketPath: path.join(dir, "u.sock"),
        unlockSecret: new Uint8Array(32).fill(3),
        serverKeyFile: unlockServerKeyFile(dir),
        startup: () => ({ ownerToken: OWNER }),
        timeoutMs: 2_000,
      });
      expect(opened).toMatchObject({ socket: "w", ownerToken: OWNER, unlocked: true });
    });
    expect(spawned.calls).toEqual([]);
  });

  it("listens on a plain Market pipe with Node and refuses a name taken first", async () => {
    const dir = folder();
    const previous = process.cwd();
    process.chdir(dir);
    cleanups.push(() => process.chdir(previous));
    // On Linux this name is a socket file in the current folder.
    const name = "\\\\.\\pipe\\agenc-market-test";
    const stop = await listenWindowsPipe(name, (socket) => socket.end("hi\n"));
    cleanups.push(stop);
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(name);
      socket.setEncoding("utf8");
      socket.on("data", resolve);
      socket.on("error", reject);
    });
    expect(answer).toBe("hi\n");
    await expect(listenWindowsPipe(name, () => undefined)).rejects.toBeInstanceOf(PipeNameTaken);
    await expect(listenWindowsPipe(name, () => undefined)).rejects.toThrow(/Another program is already using/);
    expect(spawned.calls).toEqual([]);
  });

  it("has no PowerShell or compiled script in its source", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const root = path.join(import.meta.dirname, "..", "src");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    for (const file of files) expect(readFileSync(path.join(root, file), "utf8")).not.toMatch(/powershell|add-type/i);
  });
});

describe.skipIf(process.platform === "win32")("the owner pipe's mutual hello", () => {
  it("proves an owner credential, a narrowed owner and an agent credential without sending any", async () => {
    const dir = folder();
    const socketPath = path.join(dir, "w.sock");
    await wallet(socketPath);
    const owner = await connectWallet({ socketPath, token: OWNER, proveServer: true });
    expect([owner.role, owner.agentId]).toEqual(["owner", null]);
    owner.close();
    const narrowed = await connectWallet({ socketPath, token: OWNER, actAs: AGENT, proveServer: true });
    expect([narrowed.role, narrowed.agentId]).toEqual(["agent", AGENT]);
    narrowed.close();
    const agent = await connectWallet({ socketPath, token: agentToken(OWNER, AGENT), actAs: AGENT, proveServer: true });
    expect([agent.role, agent.agentId]).toEqual(["agent", AGENT]);
    agent.close();
  });

  it("still takes the legacy hello with the credential", async () => {
    const dir = folder();
    const socketPath = path.join(dir, "w.sock");
    await wallet(socketPath);
    const owner = await connectWallet({ socketPath, token: OWNER, proveServer: false });
    expect(owner.role).toBe("owner");
    owner.close();
  });

  it("refuses a wrong credential, and its proof never opens the wallet", async () => {
    const dir = folder();
    const socketPath = path.join(dir, "w.sock");
    await wallet(socketPath);
    // The client checks the service first: a wrong token cannot match its proof.
    await expect(connectWallet({ socketPath, token: "x".repeat(64), proveServer: true })).rejects.toMatchObject({
      code: "NOT_ALLOWED",
      message: "The wallet service did not prove it is your wallet, so no credential was sent.",
    });
    await expect(connectWallet({ socketPath, token: agentToken(OWNER, "agent_2"), actAs: "agent_2", proveServer: true }))
      .rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("refuses a client proof that is not for this exchange", async () => {
    const dir = folder();
    const socketPath = path.join(dir, "w.sock");
    await wallet(socketPath);
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = connect(socketPath);
      const clientNonce = randomBytes(32).toString("base64url");
      let step = 0;
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ hello: 2, nonce: clientNonce })}\n`));
      socket.on("data", (chunk: string) => {
        const message = JSON.parse(chunk.split("\n")[0]!) as Record<string, unknown>;
        if (step++ === 0) {
          // The server's own proof sent back is no client proof.
          const context: HelloProofContext = { clientNonce, serverNonce: message.nonce as string };
          expect(message.proofs).toEqual([helloProof(OWNER, "server", context)]);
          socket.write(`${JSON.stringify({ hello: 2, proof: (message.proofs as string[])[0] })}\n`);
        } else {
          resolve(message);
          socket.destroy();
        }
      });
      socket.on("error", reject);
    });
    expect(reply).toMatchObject({ hello: 1, ok: false });
  });

  it("sends no credential to a stand-in that does not know it", async () => {
    const dir = folder();
    const socketPath = path.join(dir, "w.sock");
    const received = await impostor(socketPath, (line) =>
      line.hello === 2 && typeof line.nonce === "string"
        ? { hello: 2, nonce: randomBytes(32).toString("base64url"), proofs: [randomBytes(32).toString("base64url")] }
        : { hello: 1, ok: true, role: "owner", agentId: null });
    await expect(connectWallet({ socketPath, token: OWNER, proveServer: true })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    const all = received.join("");
    expect(all).not.toContain(OWNER);
    expect(all).not.toContain('"proof"');
  });

  it("does not take a stand-in's yes that skips the proof", async () => {
    const dir = folder();
    const socketPath = path.join(dir, "w.sock");
    const received = await impostor(socketPath, () => ({ hello: 1, ok: true, role: "owner", agentId: null }));
    await expect(connectWallet({ socketPath, token: OWNER, proveServer: true })).rejects.toMatchObject({
      message: "The wallet service did not prove it is your wallet, so no credential was sent.",
    });
    expect(received.join("")).not.toContain(OWNER);
  });

  it("is the default on Windows", async () => {
    const dir = folder();
    const socketPath = path.join(dir, "w.sock");
    const received = await impostor(socketPath, () => ({ hello: 1, ok: false, error: "no" }));
    await asWindows(() => connectWallet({ socketPath, token: OWNER }).catch(() => undefined));
    expect(received.join("")).toContain('"hello":2');
    expect(received.join("")).not.toContain(OWNER);
  });
});

describe.skipIf(process.platform === "win32")("the unlock pipe's server proof", () => {
  const secret = new Uint8Array(32).fill(9);

  it("sends no start-up line to a locked stand-in without the key", async () => {
    const dir = folder();
    const keyFile = unlockServerKeyFile(dir);
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const socketPath = path.join(dir, "u.sock");
    const received = await impostor(socketPath, () => ({ state: "locked", proof: "0".repeat(64) }));
    let asked = false;
    await expect(openBackgroundWallet({
      socketPath, unlockSecret: secret, serverKeyFile: keyFile, requireServerProof: true, timeoutMs: 2_000,
      startup: () => { asked = true; return { ownerToken: OWNER }; },
    })).rejects.toBeInstanceOf(UnlockRefused);
    expect(asked).toBe(false);
    expect(received.join("")).not.toContain("unlock\"");
  });

  it("sends nothing when the key file is missing", async () => {
    const dir = folder();
    const socketPath = path.join(dir, "u.sock");
    await impostor(socketPath, () => ({ state: "locked" }));
    let asked = false;
    await expect(openBackgroundWallet({
      socketPath, unlockSecret: secret, requireServerProof: true, timeoutMs: 2_000,
      startup: () => { asked = true; return { ownerToken: OWNER }; },
    })).rejects.toThrow("The background wallet did not prove it is yours, so nothing was sent to it.");
    expect(asked).toBe(false);
  });

  it("trusts an owner credential only from a service that proved the unlock secret", async () => {
    const dir = folder();
    const keyFile = unlockServerKeyFile(dir);
    const key = randomBytes(32);
    writeFileSync(keyFile, key, { mode: 0o600 });
    const socketPath = path.join(dir, "u.sock");
    // It holds the key (a copy of the folder) but not the unlock secret.
    await impostor(socketPath, (line) => {
      if (line.type === "hello") {
        const nonce = "a".repeat(64);
        return { state: "open", nonce, proof: unlockServerProof(key, "open", line.nonce as string, nonce) };
      }
      return { ok: true, socket: "/elsewhere.sock", ownerToken: "e".repeat(64) };
    });
    await expect(openBackgroundWallet({
      socketPath, unlockSecret: secret, serverKeyFile: keyFile, requireServerProof: true, timeoutMs: 2_000,
      startup: () => ({ ownerToken: OWNER }),
    })).rejects.toBeInstanceOf(UnlockRefused);
  });

  it("unlocks a real service, then proves the secret to it, both with proofs", async () => {
    const dir = folder();
    const keyFile = unlockServerKeyFile(dir);
    let open: OpenWallet | null = null;
    const server: UnlockServer = await listenForUnlock({
      socketPath: path.join(dir, "u.sock"),
      serverKeyFile: keyFile,
      unlock: async () => {
        open = { unlockSecret: secret, ownerToken: OWNER, socket: "/w.sock" };
      },
      opened: () => open,
      log: () => undefined,
    });
    cleanups.push(() => server.close());
    const options = { socketPath: path.join(dir, "u.sock"), unlockSecret: secret, serverKeyFile: keyFile,
      requireServerProof: true, timeoutMs: 2_000, startup: () => ({ ownerToken: OWNER }) };
    expect(await openBackgroundWallet(options)).toEqual({ socket: "/w.sock", ownerToken: OWNER, unlocked: true });
    expect(await openBackgroundWallet(options)).toEqual({ socket: "/w.sock", ownerToken: OWNER, unlocked: false });
    // The same service still answers a host that asks for no proof.
    const { serverKeyFile: _unused, ...plain } = options;
    expect(await openBackgroundWallet({ ...plain, requireServerProof: false }))
      .toMatchObject({ ownerToken: OWNER });
  });

  it("makes its key once, private to the user", async () => {
    const dir = folder();
    const keyFile = unlockServerKeyFile(dir);
    const { loadUnlockServerKey } = await import("../src/unlock-server.js");
    const first = loadUnlockServerKey(keyFile);
    expect(first).toHaveLength(32);
    expect(loadUnlockServerKey(keyFile).equals(first)).toBe(true);
    const { statSync } = await import("node:fs");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    chmodSync(keyFile, 0o644);
    expect(() => loadUnlockServerKey(keyFile)).toThrow(/private to you/);
  });
});

describe.skipIf(process.platform === "win32")("the AppContainer pipe helper", () => {
  const name = "\\\\.\\pipe\\LOCAL\\agenc-market-0123456789abcdef";
  const profile = "AgenC.OA" + "a".repeat(24);

  it("says plainly that it did not start when it is missing", async () => {
    await expect(listenWindowsPipe(name, () => undefined, profile, { helper: path.join(folder(), "market-pipe.exe") }))
      .rejects.toBeInstanceOf(PipeHelperUnavailable);
    const saved = process.env.AGENC_MARKET_PIPE_HELPER;
    delete process.env.AGENC_MARKET_PIPE_HELPER;
    cleanups.push(() => { if (saved !== undefined) process.env.AGENC_MARKET_PIPE_HELPER = saved; });
    await expect(listenWindowsPipe(name, () => undefined, profile)).rejects.toThrow("The Windows pipe helper did not start.");
    expect(spawned.calls).toEqual([]);
  });

  it("says so when it stops before it is ready", async () => {
    const helper = path.join(folder(), "helper.sh");
    writeFileSync(helper, "#!/bin/sh\nexit 77\n", { mode: 0o700 });
    await expect(listenWindowsPipe(name, () => undefined, profile, { helper })).rejects.toBeInstanceOf(PipeHelperUnavailable);
    expect(spawned.calls).toEqual([{ file: helper, args: [name, profile] }]);
  });

  it("carries a client's bytes both ways over the helper's line protocol", async () => {
    const dir = folder();
    const helper = path.join(dir, "helper.mjs");
    // Stands in for market-pipe.exe: one client connects and says hello, then
    // whatever comes back for it is echoed in the log the test reads.
    writeFileSync(helper, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
console.log("ready");
console.log("1 +");
console.log("1 " + Buffer.from("hello").toString("base64"));
createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync(${JSON.stringify(path.join(dir, "log"))}, line + "\\n");
  if (line === "1 -") process.exit(0);
});
`, { mode: 0o700 });
    const got = await new Promise<string>((resolve, reject) => {
      listenWindowsPipe(name, (socket) => {
        socket.on("data", (chunk) => {
          resolve(chunk.toString("utf8"));
          socket.end();
          socket.destroy();
        });
      }, profile, { helper }).then((stop) => cleanups.push(stop), reject);
    });
    expect(got).toBe("hello");
    expect(spawned.calls[0]).toEqual({ file: helper, args: [name, profile] });
  });
});
