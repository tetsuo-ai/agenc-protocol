// Opening a wallet service that runs in the background, started by the
// person's service manager rather than by the host.
//
// Such a service starts locked: it holds no secret and serves nothing. The
// host hands it the same start-up line it would write to a child's stdin
// (the unlock secret, a fresh owner credential, the job program...), over a
// private local socket. Once it runs, a host that starts again does not send
// the secret a second time: it proves it holds it (an HMAC over a one-time
// value the service picks) and is given the current owner credential.
//
// The secret is never written anywhere: it goes from the host's memory, over
// the socket, into the service's memory. Before anything is sent, the socket
// must sit in a folder only this user can reach into and belong to this user:
// a socket in a shared place such as /tmp could otherwise be someone else's.
// On Windows a pipe has no folder to check, and a program of the same user
// could take its name first. There the service first proves it holds a key it
// keeps in the wallet's own folder (`unlockServerKeyFile`), which only this
// user can read, and when it is open, that it holds the unlock secret.
// Dependency-free (node built-ins only), so a host can vendor this folder
// unchanged.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";

/** What the HMAC proof is bound to, so it means nothing anywhere else. */
export const UNLOCK_PROOF_CONTEXT = "agenc-wallet unlock v1";
/** Longest line either side sends on the unlock socket. */
export const MAX_UNLOCK_LINE_BYTES = 1024 * 1024;

/** First line from the service: whether it still needs the start-up line. */
export type UnlockHello =
  | { state: "locked" }
  | { state: "open"; nonce: string };

/** What the service's own proofs are bound to. */
export const UNLOCK_SERVER_PROOF_CONTEXT = "agenc-wallet unlock server v1";

/** The service's key, in the wallet's own folder (`serve --data-dir`). */
export function unlockServerKeyFile(dataDir: string): string {
  return join(dataDir, "unlock-server.key");
}

/** The service proves it holds its key file: for the hello it answers. */
export function unlockServerProof(key: Uint8Array, state: string, clientNonce: string, serverNonce: string | null): string {
  return createHmac("sha256", key)
    .update(JSON.stringify([UNLOCK_SERVER_PROOF_CONTEXT, "hello", state, clientNonce, serverNonce]))
    .digest("hex");
}

/** An open service proves it holds the unlock secret, and binds what it hands back. */
export function unlockOpenProof(
  unlockSecret: Uint8Array,
  clientNonce: string,
  serverNonce: string,
  socket: string,
  ownerToken: string,
): string {
  return createHmac("sha256", unlockSecret)
    .update(JSON.stringify([UNLOCK_SERVER_PROOF_CONTEXT, "open", clientNonce, serverNonce, socket, ownerToken]))
    .digest("hex");
}

function sameHex(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

const NOT_PROVED = "The background wallet did not prove it is yours, so nothing was sent to it.";

/** The proof a host that holds `unlockSecret` gives for `nonce`. */
export function unlockProof(unlockSecret: Uint8Array, nonce: string): string {
  return createHmac("sha256", unlockSecret).update(`${UNLOCK_PROOF_CONTEXT}\n${nonce}`).digest("hex");
}

export interface OpenedBackgroundWallet {
  /** The wallet socket to connect to. */
  socket: string;
  /** The owner credential the service runs with. */
  ownerToken: string;
  /** True when this call unlocked it; false when it was already running. */
  unlocked: boolean;
}

/** Thrown when the service refused: a wrong secret, or not this wallet. */
export class UnlockRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnlockRefused";
  }
}

/**
 * Refuse a socket anyone else could have put there: its folder must be this
 * user's and closed to everyone else, and the socket this user's. A missing
 * one throws the file system's own ENOENT, so a caller can wait for it.
 */
export function assertPrivateSocket(socketPath: string): void {
  if (process.platform === "win32") return;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const folder = lstatSync(dirname(socketPath));
  if (!folder.isDirectory() || (uid !== null && folder.uid !== uid) || (folder.mode & 0o077) !== 0) {
    throw new UnlockRefused("The wallet's socket folder is not private to you, so nothing was sent to it.");
  }
  const socket = lstatSync(socketPath);
  if (!socket.isSocket() || (uid !== null && socket.uid !== uid)) {
    throw new UnlockRefused("Something other than your wallet is at its socket, so nothing was sent to it.");
  }
}

/**
 * Open the background service at `socketPath`: unlock it with the start-up
 * line from `startup()` when it is locked (only then is that line made), or
 * prove `unlockSecret` when it already runs.
 */
export function openBackgroundWallet(options: {
  socketPath: string;
  unlockSecret: Uint8Array;
  /** The start-up line, with `unlockSecret` and a fresh `ownerToken`. */
  startup: () => { ownerToken: string } & Record<string, unknown>;
  timeoutMs?: number;
  /** The service's key file (`unlockServerKeyFile`). Needed on Windows. */
  serverKeyFile?: string;
  /**
   * Send nothing before the service proved itself. Always on Windows, where
   * the socket's folder cannot be checked; this turns it on elsewhere.
   */
  requireServerProof?: boolean;
}): Promise<OpenedBackgroundWallet> {
  const requireProof = options.requireServerProof ?? process.platform === "win32";
  try {
    assertPrivateSocket(options.socketPath);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<OpenedBackgroundWallet>((resolve, reject) => {
    const socket = connect(options.socketPath);
    const clientNonce = randomBytes(32).toString("hex");
    let serverNonce: string | null = null;
    let buffered = "";
    let settled = false;
    let sentOwnerToken: string | null = null;
    const finish = (error: Error | null, value?: OpenedBackgroundWallet): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== null) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () => finish(new Error("the background wallet did not answer in time")),
      options.timeoutMs ?? 30_000,
    );
    const send = (message: unknown): void => {
      socket.write(`${JSON.stringify(message)}\n`);
    };
    const onLine = (line: string): void => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        finish(new Error("the background wallet answered with something unreadable"));
        return;
      }
      if (message.state === "locked" || message.state === "open") {
        if (requireProof) {
          // The key file is read only now: the service makes it before it listens.
          let key: Buffer;
          try {
            if (options.serverKeyFile === undefined) throw new Error("no key file");
            key = readFileSync(options.serverKeyFile);
            if (key.length !== 32) throw new Error("bad key file");
          } catch {
            finish(new UnlockRefused(NOT_PROVED));
            return;
          }
          const nonce = typeof message.nonce === "string" ? message.nonce : null;
          const ok = sameHex(message.proof, unlockServerProof(key, message.state, clientNonce, nonce));
          key.fill(0);
          if (!ok) {
            finish(new UnlockRefused(NOT_PROVED));
            return;
          }
        }
      }
      if (message.state === "locked") {
        const startup = options.startup();
        sentOwnerToken = startup.ownerToken;
        send({ type: "unlock", startup });
        return;
      }
      if (message.state === "open" && typeof message.nonce === "string") {
        serverNonce = message.nonce;
        send({ type: "prove", mac: unlockProof(options.unlockSecret, message.nonce) });
        return;
      }
      if (message.ok === true && typeof message.socket === "string") {
        const ownerToken =
          typeof message.ownerToken === "string" ? message.ownerToken : sentOwnerToken;
        if (ownerToken === null) {
          finish(new Error("the background wallet did not say how to connect"));
          return;
        }
        // An owner credential handed back is trusted only from a service that
        // proved it holds the unlock secret, for this very exchange.
        if (requireProof && sentOwnerToken === null && (serverNonce === null ||
            !sameHex(message.proof, unlockOpenProof(options.unlockSecret, clientNonce, serverNonce, message.socket, ownerToken)))) {
          finish(new UnlockRefused(NOT_PROVED));
          return;
        }
        finish(null, { socket: message.socket, ownerToken, unlocked: sentOwnerToken !== null });
        return;
      }
      finish(
        new UnlockRefused(
          typeof message.error === "string" ? message.error : "The background wallet refused.",
        ),
      );
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_UNLOCK_LINE_BYTES) {
        finish(new Error("the background wallet sent too much"));
        return;
      }
      let newline = buffered.indexOf("\n");
      while (newline !== -1 && !settled) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        onLine(line);
        newline = buffered.indexOf("\n");
      }
    });
    socket.on("connect", () => send({ type: "hello", nonce: clientNonce }));
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("the background wallet closed the connection")));
  });
}
