// The service side of `client/unlock.ts`: a wallet service started by the
// person's service manager waits here, locked, until its host hands it the
// start-up line; afterwards a host proves it holds the unlock secret to be
// told the owner credential. One JSON line each way.
import { listenWindowsPipe } from "./client/windows-pipe.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { MAX_UNLOCK_LINE_BYTES, unlockProof } from "./client/unlock.js";
import { WalletError } from "./errors.js";

/** What an open service tells a host that proved it holds the secret. */
export interface OpenWallet {
  unlockSecret: Uint8Array;
  ownerToken: string;
  socket: string;
}

export interface UnlockServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** Refuse a socket folder anyone else could reach into. */
function preparePrivateSocket(socketPath: string): void {
  if (!path.isAbsolute(socketPath)) {
    throw new WalletError("INTERNAL", "The unlock socket needs an absolute path.");
  }
  const directory = path.dirname(socketPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  const getuid = process.getuid;
  if (
    !info.isDirectory() ||
    (typeof getuid === "function" && info.uid !== getuid.call(process)) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new WalletError(
      "INTERNAL",
      "The unlock socket's folder must be private to you. Fix its permissions first.",
    );
  }
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) {
      throw new WalletError("INTERNAL", "Something else is in the way of the unlock socket.");
    }
    unlinkSync(socketPath);
  }
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Listen on `socketPath` for a host. `unlock` opens the wallet from a
 * start-up line (it throws when the line does not open it) and is never run
 * twice at once; `opened` says what runs once it has.
 */
export async function listenForUnlock(options: {
  socketPath: string;
  unlock: (startup: unknown) => Promise<void>;
  opened: () => OpenWallet | null;
  log: (line: string) => void;
}): Promise<UnlockServer> {
  if (process.platform !== "win32") preparePrivateSocket(options.socketPath);
  let unlocking: Promise<void> | null = null;
  const sockets = new Set<Socket>();

  const serveConnection = (socket: Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");
    // One value per connection, and it answers one proof only.
    let nonce: string | null = null;
    let buffered = "";
    const reply = (message: unknown): void => {
      socket.write(`${JSON.stringify(message)}\n`);
    };
    const refuse = (error: string): void => {
      reply({ ok: false, error });
      socket.end();
    };
    const onLine = async (line: string): Promise<void> => {
      let message: { type?: unknown; startup?: unknown; mac?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        refuse("That is not a request this wallet understands.");
        return;
      }
      if (message.type === "hello") {
        const open = options.opened();
        if (open === null) {
          reply({ state: "locked" });
        } else {
          nonce = randomBytes(32).toString("hex");
          reply({ state: "open", nonce });
        }
        return;
      }
      if (message.type === "unlock") {
        if (options.opened() !== null) {
          refuse("This wallet is already open. Prove the secret instead.");
          return;
        }
        // Several hosts can be waiting here: each looks again after every
        // attempt it waited for, so only one of them goes next.
        while (unlocking !== null) await unlocking.catch(() => undefined);
        if (options.opened() !== null) {
          refuse("This wallet is already open. Prove the secret instead.");
          return;
        }
        const attempt = options.unlock(message.startup);
        unlocking = attempt;
        try {
          await attempt;
        } catch (error) {
          // Never echo the start-up line or its parts back, or into the log.
          options.log("unlock refused");
          refuse(error instanceof WalletError ? error.message : "That does not open this wallet.");
          return;
        } finally {
          unlocking = null;
        }
        const open = options.opened();
        if (open === null) {
          refuse("That does not open this wallet.");
          return;
        }
        reply({ ok: true, socket: open.socket });
        socket.end();
        return;
      }
      if (message.type === "prove") {
        const open = options.opened();
        const asked = nonce;
        nonce = null;
        if (open === null || asked === null || typeof message.mac !== "string") {
          refuse("Say hello first.");
          return;
        }
        if (!sameHex(message.mac, unlockProof(open.unlockSecret, asked))) {
          options.log("unlock proof refused");
          refuse("That is not this wallet's secret.");
          return;
        }
        reply({ ok: true, socket: open.socket, ownerToken: open.ownerToken });
        socket.end();
        return;
      }
      refuse("That is not a request this wallet understands.");
    };
    let queue: Promise<void> = Promise.resolve();
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_UNLOCK_LINE_BYTES) {
        socket.destroy();
        return;
      }
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        queue = queue
          .then(() => onLine(line))
          .catch(() => {
            socket.destroy();
          });
        newline = buffered.indexOf("\n");
      }
    });
  };

  if (process.platform === "win32") {
    const stop = await listenWindowsPipe(options.socketPath,serveConnection);
    return {socketPath:options.socketPath,close:async () => { for (const socket of sockets) socket.destroy(); stop(); }};
  }
  const server = createServer(serveConnection);
  return new Promise<UnlockServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve({
        socketPath: options.socketPath,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
