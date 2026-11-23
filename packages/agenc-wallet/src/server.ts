// The wallet behind a local socket: newline-delimited JSON over a Unix domain
// socket (a named pipe on Windows). No TCP listener, ever.
//
// Two kinds of caller exist. The OWNER is the person's own app: it may do
// everything. An AGENT connection is bound to one agent id when it says
// hello and can reach only the methods in AGENT_METHODS, always as itself.
// The binding comes from the credential, never from a request argument.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import {
  AGENT_METHODS,
  type MethodParams,
  type MethodResult,
  type RpcHello,
  type RpcHelloReply,
  type RpcRequest,
  type RpcResponse,
  type WalletEvent,
  type WalletMethod,
} from "./client/protocol.js";
import { createLineReader } from "./client/socket-client.js";
import { describeError, toWalletErrorShape, WalletError } from "./errors.js";
import type { AgencWallet } from "./wallet.js";

const MAX_CONNECTIONS = 64;
const MAX_IN_FLIGHT = 16;
const HELLO_TIMEOUT_MS = 5_000;

/** Longest socket path every supported system accepts (macOS allows 103). */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Where a wallet in `baseDir` listens. Socket paths are short by law of the
 * operating system, so a deep wallet folder gets a socket in a private
 * folder under the temp directory instead, named after the wallet folder.
 */
export function defaultSocketPath(baseDir: string): string {
  if (process.platform === "win32") {
    const name = createHash("sha256").update(baseDir).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\agenc-wallet-${name}`;
  }
  const inside = path.join(baseDir, "wallet.sock");
  if (Buffer.byteLength(inside) <= MAX_SOCKET_PATH_BYTES) return inside;
  const owner = typeof process.getuid === "function" ? process.getuid() : 0;
  const name = createHash("sha256").update(baseDir).digest("hex").slice(0, 24);
  return path.join(tmpdir(), `agenc-wallet-${owner}`, `${name}.sock`);
}

/** The credential for one agent, derived from the owner's. */
export function agentToken(ownerToken: string, agentId: string): string {
  return createHmac("sha256", ownerToken).update(`agent:${agentId}`).digest("hex");
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface ServeWalletOptions {
  wallet: AgencWallet;
  /** Absolute socket path. Its folder is created private if missing. */
  socketPath: string;
  /** The owner credential: at least 32 characters of high entropy. */
  ownerToken: string;
  /** Agent ids that may connect. Called per hello, so new agents work. */
  agentExists: (agentId: string) => boolean;
  log?: (line: string) => void;
}

export interface WalletServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

interface Session {
  role: "owner" | "agent";
  agentId: string | null;
}

type Handlers = {
  [M in WalletMethod]: (
    params: MethodParams<M>,
    session: Session,
  ) => Promise<MethodResult<M>>;
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WalletError("BAD_REQUEST", "That request is not valid.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    throw new WalletError("BAD_REQUEST", `The ${what} is missing.`);
  }
  return value;
}

function handlers(wallet: AgencWallet): Handlers {
  const owner = (session: Session): boolean => session.role === "owner";
  const scope = (session: Session): string | undefined => session.agentId ?? undefined;
  return {
    overview: () => wallet.overview(),
    "work.list": (p, session) => wallet.openWork(session.agentId ?? text(p.agentId, "agent"), p.offset, p.task),
    "work.quote": (p, session) => wallet.quoteWork(session.agentId ?? text(p.agentId, "agent"), text(p.task, "task"), p.action),
    "work.pending": async () => wallet.pendingWork(),
    "work.decide": (p) => wallet.decideWork(text(p.id, "quote"), p.approve === true),
    "work.choose": async (p) => wallet.chooseWork(text(p.agentId, "agent"), p.manual),
    "agents.create": (params) =>
      wallet.createAgent(
        typeof params.name === "string" ? params.name : undefined,
        typeof params.scope === "string" ? params.scope : null,
      ),
    "agents.setBudget": (params) =>
      wallet.setBudget(text(params.agentId, "agent"), params.perDayCents),
    "agents.rename": (params) =>
      wallet.renameAgent(text(params.agentId, "agent"), text(params.name, "name")),
    "agents.setPolicy": (params) =>
      wallet.setPolicy(text(params.agentId, "agent"), params.policy),
    "agents.fund": (params) => wallet.fundAgent(text(params.agentId, "agent"), params.amount),
    "agents.reclaim": (params) =>
      wallet.reclaimFromAgent(text(params.agentId, "agent"), params.amount),
    "agents.retire": (params) => wallet.retireAgent(text(params.agentId, "agent")),
    "market.find": async (params) => ({
      ...(await wallet.find(params)),
      networkFee: await wallet.networkFee(),
    }),
    "market.hire": (params, session) =>
      wallet.hire({
        ...params,
        // An agent can only ever hire as itself.
        agentId: session.agentId ?? text(params.agentId, "agent"),
      }),
    "market.post": (params, session) =>
      wallet.post({
        ...params,
        // An agent can only ever post as itself, from its own money.
        agentId: session.agentId ?? text(params.agentId, "agent"),
      }),
    // Not an agent method: the main balance pays with no one asked.
    "wallet.post": async (params) => ({ job: await wallet.postFromBalance(params) }),
    "approvals.list": async () => ({ approvals: await wallet.listApprovals() }),
    "approvals.decide": async (params) => ({
      job: await wallet.decideApproval(text(params.approvalId, "request"), params.approve === true),
    }),
    "approvals.wait": (params, session) =>
      wallet.waitApproval(text(params.approvalId, "request"), params.timeoutMs, scope(session)),
    "jobs.list": async (params, session) => ({
      jobs: await wallet.listJobs(
        { ...params, ...(session.agentId !== null ? { agentId: session.agentId } : {}) },
        owner(session),
      ),
    }),
    "jobs.get": async (params, session) => ({
      job: await wallet.getJob(text(params.jobId, "job"), owner(session), scope(session)),
    }),
    "jobs.delivery": async (params, session) => ({
      result: await wallet.jobDelivery(text(params.jobId, "job"), owner(session), scope(session)),
    }),
    "jobs.file": async (params) => ({
      file: await wallet.jobFile(text(params.jobId, "job"), text(params.sha256, "file")),
    }),
    "jobs.wait": (params, session) =>
      wallet.waitJob(
        text(params.jobId, "job"),
        params.until,
        params.timeoutMs,
        owner(session),
        scope(session),
      ),
    "jobs.approve": async (params, session) => ({
      job: await wallet.approveJob(
        text(params.jobId, "job"),
        params.rating,
        owner(session),
        scope(session),
      ),
    }),
    "jobs.askChanges": async (params, session) => ({
      job: await wallet.askChanges(
        text(params.jobId, "job"),
        text(params.note, "note"),
        owner(session),
        scope(session),
      ),
    }),
    "jobs.refund": async (params, session) => ({
      job: await wallet.refundJob(text(params.jobId, "job"), owner(session), scope(session)),
    }),
    "jobs.dispute": async (params, session) => ({
      job: await wallet.disputeTurnDown(text(params.jobId, "job"), owner(session), scope(session)),
    }),
    "jobs.rate": async (params, session) => ({
      job: await wallet.rateJob(
        text(params.jobId, "job"),
        params.score,
        owner(session),
        scope(session),
      ),
    }),
    "activity.list": async (params) => ({ activity: await wallet.listActivity(params.limit) }),
    "earn.set": (params) =>
      wallet.setEarn(text(params.agentId, "agent"), params.enabled === true, params.minPayCents),
    "earn.quote": (params) => wallet.quoteEarn(text(params.agentId, "agent"), params.offer, params.offerId),
    "earn.approveFunding": (params) => wallet.approveEarnFunding(text(params.quoteId, "quote")),
    "earn.offer": (params) =>
      wallet.setOffer(
        text(params.agentId, "agent"),
        params.offer ?? null,
        params.offerId === undefined || params.offerId === null
          ? undefined
          : text(params.offerId, "service"),
      ),
    "wallet.withdraw": (params) => wallet.withdraw(text(params.to, "address"), params.amount),
    "backup.export": (params) =>
      wallet.exportBackup(text(params.password, "password"), text(params.file, "file")),
    "backup.check": (params) =>
      wallet.checkBackup(text(params.password, "password"), text(params.file, "file")),
  };
}

function prepareSocketPath(socketPath: string): void {
  if (process.platform === "win32") return;
  if (!path.isAbsolute(socketPath)) {
    throw new WalletError("INTERNAL", "The wallet's socket needs an absolute path.");
  }
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new WalletError(
      "INTERNAL",
      "The wallet's socket path is too long for this system. Use a shorter folder.",
    );
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
      "The wallet's socket folder must be private to you. Fix its permissions first.",
    );
  }
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) {
      throw new WalletError("INTERNAL", "Something else is in the way of the wallet's socket.");
    }
    unlinkSync(socketPath);
  }
}

/** Start serving `wallet` on `socketPath`. */
export async function serveWallet(options: ServeWalletOptions): Promise<WalletServer> {
  if (options.ownerToken.length < 32) {
    throw new WalletError("INTERNAL", "The wallet's owner credential is too short.");
  }
  const log = options.log ?? (() => {});
  const table = handlers(options.wallet);
  const agentMethods = new Set<string>(AGENT_METHODS);
  const sockets = new Set<Socket>();
  prepareSocketPath(options.socketPath);

  function authenticate(hello: RpcHello): Session | string {
    if (typeof hello.token !== "string") return "The wallet did not accept that credential.";
    if (sameSecret(hello.token, options.ownerToken)) {
      if (hello.actAs === undefined) return { role: "owner", agentId: null };
      if (typeof hello.actAs !== "string" || !options.agentExists(hello.actAs)) {
        return "That agent does not exist.";
      }
      return { role: "agent", agentId: hello.actAs };
    }
    // An agent credential names its agent in the hello and proves it by HMAC.
    if (typeof hello.actAs === "string" && options.agentExists(hello.actAs)) {
      if (sameSecret(hello.token, agentToken(options.ownerToken, hello.actAs))) {
        return { role: "agent", agentId: hello.actAs };
      }
    }
    return "The wallet did not accept that credential.";
  }

  const server: Server = createServer((socket) => {
    if (sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let session: Session | null = null;
    let inFlight = 0;
    let unsubscribe: (() => void) | null = null;

    const send = (value: unknown): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
    };
    const helloTimer = setTimeout(() => {
      if (session === null) socket.destroy();
    }, HELLO_TIMEOUT_MS);

    const read = createLineReader(
      (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (typeof message !== "object" || message === null) {
          socket.destroy();
          return;
        }
        if (session === null) {
          const hello = message as RpcHello;
          const result = hello.hello === 1 ? authenticate(hello) : "Say hello first.";
          if (typeof result === "string") {
            const reply: RpcHelloReply = { hello: 1, ok: false, error: result };
            send(reply);
            socket.end();
            return;
          }
          session = result;
          clearTimeout(helloTimer);
          const reply: RpcHelloReply = {
            hello: 1,
            ok: true,
            role: session.role,
            agentId: session.agentId,
          };
          send(reply);
          if (hello.events === true && session.role === "owner") {
            unsubscribe = options.wallet.on((event: WalletEvent) => send({ event }));
          }
          return;
        }
        const request = message as RpcRequest;
        if (typeof request.id !== "number" || typeof request.method !== "string") {
          socket.destroy();
          return;
        }
        const respond = (response: RpcResponse): void => send(response);
        const activeSession = session;
        if (!Object.hasOwn(table, request.method)) {
          respond({
            id: request.id,
            ok: false,
            error: { code: "BAD_REQUEST", message: "The wallet does not know that request." },
          });
          return;
        }
        if (activeSession.role === "agent" && !agentMethods.has(request.method)) {
          respond({
            id: request.id,
            ok: false,
            error: {
              code: "NOT_ALLOWED",
              message: "Only the person who owns this wallet can do that.",
            },
          });
          return;
        }
        if (inFlight >= MAX_IN_FLIGHT) {
          respond({
            id: request.id,
            ok: false,
            error: { code: "BUSY", message: "Busy for a moment. Try again." },
          });
          return;
        }
        inFlight += 1;
        const method = request.method as WalletMethod;
        void (async () => {
          try {
            const params = object(request.params ?? {});
            const handler = table[method] as (
              params: unknown,
              session: Session,
            ) => Promise<unknown>;
            respond({ id: request.id, ok: true, result: await handler(params, activeSession) });
          } catch (error) {
            if (!(error instanceof WalletError)) log(`${method}: ${describeError(error)}`);
            else if (error.cause !== undefined) log(`${method}: ${describeError(error)}`);
            respond({ id: request.id, ok: false, error: toWalletErrorShape(error) });
          } finally {
            inFlight -= 1;
          }
        })();
      },
      () => socket.destroy(),
    );

    socket.on("data", read);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(helloTimer);
      unsubscribe?.();
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") chmodSync(options.socketPath, 0o600);

  return {
    socketPath: options.socketPath,
    close() {
      return new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          if (process.platform !== "win32") {
            try {
              unlinkSync(options.socketPath);
            } catch {
              // Already gone.
            }
          }
          resolve();
        });
      });
    },
  };
}
