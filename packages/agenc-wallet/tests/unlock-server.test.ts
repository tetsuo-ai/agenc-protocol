// A wallet waiting to be unlocked opens for one start-up line at a time, even
// when several hosts send theirs together and the first one is refused.
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WalletError } from "../src/errors.js";
import { listenForUnlock, type OpenWallet, type UnlockServer } from "../src/unlock-server.js";

const servers: UnlockServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/** Send one line and read the one answer. */
function ask(socketPath: string, message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
      socket.destroy();
    });
    socket.on("error", reject);
  });
}

describe.skipIf(process.platform === "win32")("a wallet waiting to be unlocked", () => {
  it("never unlocks twice at once, even after a refused first try", async () => {
    const socketPath = path.join(mkdtempSync(path.join(tmpdir(), "agenc-unlock-server-")), "unlock.sock");
    let open: OpenWallet | null = null;
    let calls = 0;
    let running = 0;
    let most = 0;
    const server = await listenForUnlock({
      socketPath,
      unlock: async () => {
        calls += 1;
        const call = calls;
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, call === 1 ? 300 : 50));
        running -= 1;
        // The first start-up line does not open this wallet; the next one does.
        if (call === 1) throw new WalletError("INTERNAL", "That does not open this wallet.");
        open ??= { unlockSecret: new Uint8Array(32).fill(1), ownerToken: "o".repeat(64), socket: "/wallet.sock" };
      },
      opened: () => open,
      log: () => {},
    });
    servers.push(server);

    // Four hosts send their start-up line at about the same time.
    const answers = await Promise.all(
      [0, 1, 2, 3].map(async (index) => {
        await new Promise((resolve) => setTimeout(resolve, index * 20));
        return ask(socketPath, { type: "unlock", startup: { ownerToken: String(index) } });
      }),
    );
    expect(most).toBe(1);
    expect(calls).toBe(2);
    expect(answers.filter((answer) => answer.ok === true)).toHaveLength(1);
    expect(answers.filter((answer) => answer.ok === false)).toHaveLength(3);
  });
});
