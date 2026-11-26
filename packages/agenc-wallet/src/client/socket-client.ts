// A small client for the wallet service: newline-delimited JSON over a local
// socket (a Unix domain socket, or a named pipe on Windows). No dependencies
// beyond Node's built-ins, so a host can vendor this folder unchanged.
import { HELLO_NONCE, helloNonce, helloProof, sameProof, type HelloProofContext } from "./hello-proof.js";
import { connect, type Socket } from "node:net";
import {
  MAX_FRAME_BYTES,
  type MethodParams,
  type MethodResult,
  type RpcHello,
  type RpcHelloReply,
  type RpcResponse,
  type WalletEvent,
  type WalletMethod,
} from "./protocol.js";
import type { WalletErrorCode, WalletErrorShape } from "./types.js";

/** A failure the service reported. `message` is safe to show to a person. */
export class WalletClientError extends Error implements WalletErrorShape {
  readonly code: WalletErrorCode;
  /** Whether the service said trying again later may work (see `WalletErrorShape`). */
  readonly retryable?: boolean;

  constructor(code: WalletErrorCode, message: string, retryable?: boolean) {
    super(message);
    this.name = "WalletClientError";
    this.code = code;
    if (retryable !== undefined) this.retryable = retryable;
  }
}

export interface WalletClientOptions {
  /** Path of the service socket. */
  socketPath: string;
  /** Owner or agent credential issued by the service. */
  token: string;
  /** Narrow an owner credential to this agent for the whole connection. */
  actAs?: string;
  /** Receive pushed events (the panel wants them; a tool call does not). */
  onEvent?: (event: WalletEvent) => void;
  /** Called once when the connection ends for any reason. */
  onClose?: (reason: string) => void;
  /** Give up connecting after this long. Default 5 seconds. */
  connectTimeoutMs?: number;
  /**
   * Send no credential: prove it, after the service proved it holds it
   * (`hello-proof.ts`). Always on Windows, where a program of the same user
   * could have taken the pipe's name first; this turns it on elsewhere.
   */
  proveServer?: boolean;
}

export interface WalletClient {
  readonly role: "owner" | "agent";
  readonly agentId: string | null;
  call<M extends WalletMethod>(
    method: M,
    params: MethodParams<M>,
    options?: { signal?: AbortSignal },
  ): Promise<MethodResult<M>>;
  close(): void;
}

const KNOWN_CODES: readonly WalletErrorCode[] = [
  "NOT_FOUND",
  "BAD_REQUEST",
  "NOT_ALLOWED",
  "NOT_ENOUGH_MONEY",
  "PRICE_CHANGED",
  "NOT_AVAILABLE",
  "NEEDS_APPROVAL",
  "APPROVAL_REQUIRED",
  "NETWORK",
  "BUSY",
  "INTERNAL",
];

function toCode(value: unknown): WalletErrorCode {
  return KNOWN_CODES.includes(value as WalletErrorCode)
    ? (value as WalletErrorCode)
    : "INTERNAL";
}

/** Split a byte stream into JSON lines, refusing an oversized frame. */
export function createLineReader(
  onLine: (line: string) => void,
  onOverflow: () => void,
): (chunk: Buffer) => void {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  return (chunk) => {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) break;
      const piece = chunk.subarray(start, newline);
      const line =
        pending.length === 0
          ? piece.toString("utf8")
          : Buffer.concat([...pending, piece]).toString("utf8");
      pending = [];
      pendingBytes = 0;
      start = newline + 1;
      if (line.length > 0) onLine(line);
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      pendingBytes += rest.length;
      if (pendingBytes > MAX_FRAME_BYTES) {
        pending = [];
        pendingBytes = 0;
        onOverflow();
        return;
      }
      pending.push(rest);
    }
  };
}

const NOT_PROVED = "The wallet service did not prove it is your wallet, so no credential was sent.";

/** Connect and authenticate. Rejects when the service refuses the token. */
export function connectWallet(options: WalletClientOptions): Promise<WalletClient> {
  return new Promise<WalletClient>((resolve, reject) => {
    const socket: Socket = connect(options.socketPath);
    const proveServer = options.proveServer ?? process.platform === "win32";
    let proving: HelloProofContext | null = null;
    // With `proveServer`, nothing counts as the service's yes before it proved itself.
    let serverProved = !proveServer;
    const waiting = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    let nextId = 1;
    let ready = false;
    let closed = false;
    let settled = false;

    const timer = setTimeout(() => {
      fail(new WalletClientError("NETWORK", "The wallet service did not answer."));
      socket.destroy();
    }, options.connectTimeoutMs ?? 5_000);

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }

    function shutdown(reason: string): void {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const entry of waiting.values()) {
        entry.reject(new WalletClientError("NETWORK", reason));
      }
      waiting.clear();
      fail(new WalletClientError("NETWORK", reason));
      options.onClose?.(reason);
    }

    function send(value: unknown): void {
      socket.write(`${JSON.stringify(value)}\n`);
    }

    const read = createLineReader(
      (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (typeof message !== "object" || message === null) return;
        if (!ready && proving !== null && (message as { hello?: unknown }).hello === 2) {
          const challenge = message as { nonce?: unknown; proofs?: unknown };
          const context = proving;
          proving = null;
          if (typeof challenge.nonce !== "string" || !HELLO_NONCE.test(challenge.nonce) || !Array.isArray(challenge.proofs)) {
            fail(new WalletClientError("NOT_ALLOWED", NOT_PROVED));
            socket.destroy();
            return;
          }
          context.serverNonce = challenge.nonce;
          const expected = helloProof(options.token, "server", context);
          if (!challenge.proofs.slice(0, 2).some((proof) => sameProof(proof, expected))) {
            fail(new WalletClientError("NOT_ALLOWED", NOT_PROVED));
            socket.destroy();
            return;
          }
          serverProved = true;
          send({ hello: 2, proof: helloProof(options.token, "client", context) });
          return;
        }
        if (!ready) {
          const reply = message as RpcHelloReply;
          if (reply.hello !== 1) return;
          if (!reply.ok) {
            fail(new WalletClientError("NOT_ALLOWED", reply.error));
            socket.destroy();
            return;
          }
          if (!serverProved) {
            fail(new WalletClientError("NOT_ALLOWED", NOT_PROVED));
            socket.destroy();
            return;
          }
          ready = true;
          settled = true;
          clearTimeout(timer);
          resolve({
            role: reply.role,
            agentId: reply.agentId,
            call(method, params, callOptions) {
              return new Promise((resolveCall, rejectCall) => {
                if (closed) {
                  rejectCall(
                    new WalletClientError("NETWORK", "The wallet service is not connected."),
                  );
                  return;
                }
                const id = nextId++;
                const signal = callOptions?.signal;
                const onAbort = (): void => {
                  if (waiting.delete(id)) {
                    rejectCall(new WalletClientError("BUSY", "The request was cancelled."));
                  }
                };
                if (signal?.aborted) {
                  onAbort();
                  return;
                }
                signal?.addEventListener("abort", onAbort, { once: true });
                waiting.set(id, {
                  resolve: (value) => {
                    signal?.removeEventListener("abort", onAbort);
                    resolveCall(value as MethodResult<typeof method>);
                  },
                  reject: (error) => {
                    signal?.removeEventListener("abort", onAbort);
                    rejectCall(error);
                  },
                });
                send({ id, method, params });
              });
            },
            close() {
              socket.end();
            },
          });
          return;
        }
        if ("event" in message) {
          options.onEvent?.((message as { event: WalletEvent }).event);
          return;
        }
        const response = message as RpcResponse;
        const entry = waiting.get(response.id);
        if (!entry) return;
        waiting.delete(response.id);
        if (response.ok) entry.resolve(response.result);
        else {
          entry.reject(
            new WalletClientError(
              toCode(response.error.code),
              response.error.message,
              typeof response.error.retryable === "boolean" ? response.error.retryable : undefined,
            ),
          );
        }
      },
      () => socket.destroy(),
    );

    socket.on("connect", () => {
      if (proveServer) {
        proving = {
          clientNonce: helloNonce(),
          serverNonce: "",
          ...(options.actAs !== undefined ? { actAs: options.actAs } : {}),
          ...(options.onEvent ? { events: true } : {}),
        };
        send({ hello: 2, nonce: proving.clientNonce, ...(proving.events ? { events: true } : {}),
          ...(proving.actAs !== undefined ? { actAs: proving.actAs } : {}) });
        return;
      }
      const hello: RpcHello = {
        hello: 1,
        token: options.token,
        ...(options.onEvent ? { events: true } : {}),
        ...(options.actAs !== undefined ? { actAs: options.actAs } : {}),
      };
      send(hello);
    });
    socket.on("data", read);
    socket.on("error", (error) => {
      shutdown(`The wallet service is not reachable (${error.message}).`);
    });
    socket.on("close", () => shutdown("The wallet service closed the connection."));
  });
}
