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
// the socket, into the service's memory. Dependency-free (node:net and
// node:crypto), so a host can vendor this folder unchanged.
import { createHmac } from "node:crypto";
import { connect } from "node:net";

/** What the HMAC proof is bound to, so it means nothing anywhere else. */
export const UNLOCK_PROOF_CONTEXT = "agenc-wallet unlock v1";
/** Longest line either side sends on the unlock socket. */
export const MAX_UNLOCK_LINE_BYTES = 1024 * 1024;

/** First line from the service: whether it still needs the start-up line. */
export type UnlockHello =
  | { state: "locked" }
  | { state: "open"; nonce: string };

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
}): Promise<OpenedBackgroundWallet> {
  return new Promise<OpenedBackgroundWallet>((resolve, reject) => {
    const socket = connect(options.socketPath);
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
      if (message.state === "locked") {
        const startup = options.startup();
        sentOwnerToken = startup.ownerToken;
        send({ type: "unlock", startup });
        return;
      }
      if (message.state === "open" && typeof message.nonce === "string") {
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
    socket.on("connect", () => send({ type: "hello" }));
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("the background wallet closed the connection")));
  });
}
