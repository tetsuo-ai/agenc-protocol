// A host hands the unlock secret only to a socket that can be the wallet's:
// one in a folder this user alone can reach into, owned by this user. A socket
// in a shared place, such as a folder in /tmp someone else made first, gets
// nothing, not even a hello.
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openBackgroundWallet, UnlockRefused } from "../src/client/unlock.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A stand-in that says it is a locked wallet and records whatever it is sent. */
async function impostor(folderMode: number): Promise<{ socketPath: string; received: string[] }> {
  const folder = path.join(mkdtempSync(path.join(tmpdir(), "agenc-unlock-")), "run");
  mkdirSync(folder, { mode: folderMode });
  chmodSync(folder, folderMode);
  const socketPath = path.join(folder, "unlock.sock");
  const received: string[] = [];
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      received.push(chunk.toString("utf8"));
      socket.write(`${JSON.stringify({ state: "locked" })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, received };
}

const secret = new Uint8Array(32).fill(7);
const startup = () => ({ unlockSecret: Buffer.from(secret).toString("base64"), ownerToken: "t".repeat(64) });

describe.skipIf(process.platform === "win32")("a host opening a background wallet", () => {
  it("sends nothing to a socket in a folder others can reach into", async () => {
    const shared = await impostor(0o755);
    let asked = false;
    await expect(
      openBackgroundWallet({
        socketPath: shared.socketPath,
        unlockSecret: secret,
        startup: () => {
          asked = true;
          return startup();
        },
        timeoutMs: 2_000,
      }),
    ).rejects.toBeInstanceOf(UnlockRefused);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(shared.received).toEqual([]);
    expect(asked).toBe(false);
  });

  it("talks to a socket in a folder that is the user's alone", async () => {
    const own = await impostor(0o700);
    // The stand-in never answers the unlock, so this ends in a timeout; what
    // matters is that the hello and the start-up line went to it.
    await openBackgroundWallet({ socketPath: own.socketPath, unlockSecret: secret, startup, timeoutMs: 1_000 }).catch(() => undefined);
    expect(own.received.join("")).toContain('"type":"hello"');
  });

  it("waits for a socket that is not there yet", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "agenc-unlock-missing-"));
    await expect(
      openBackgroundWallet({ socketPath: path.join(folder, "unlock.sock"), unlockSecret: secret, startup, timeoutMs: 500 }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
