import { runMarketTool, MARKET_TOOLS } from "./client/tools.js";
// The wallet behind a local socket: newline-delimited JSON over a Unix domain
// socket (a named pipe on Windows). No TCP listener, ever.
//
// Two kinds of caller exist. The OWNER is the person's own app: it may do
// everything. An AGENT connection is bound to one agent id when it says
// hello and can reach only the methods in AGENT_METHODS, always as itself.
// The binding comes from the credential, never from a request argument.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
import { createLineReader, WalletClientError, type WalletClient } from "./client/socket-client.js";
import { describeError, toWalletErrorShape, WalletError } from "./errors.js";
import type { AgencWallet } from "./wallet.js";

import { featureCall, featureRoutes } from "./feature-dispatch.js";
import { ConnectionGrants } from "./connection-grants.js";
import { listenWindowsPipe } from "./client/windows-pipe.js";
import type { ConnectionScope } from "./client/connections.js";

const CONNECTION_METHODS = new Set(["connections.attach", "connections.tool", "connections.info", "connections.changes", "connections.subscribe",
  "handoff.status", "handoff.delivery", "handoff.file", "handoff.propose"]);
const READ_METHODS = new Set(["market.find", "jobs.list", "jobs.get", "jobs.wait", "jobs.delivery",
  "jobs.reviewRecord", "jobs.callOutcome", "jobs.contestPage", "jobs.contestReceipts", "jobs.contestQuote",
  "approvals.wait", "work.list", "jobs.inbox", "earn.operation", "listings.inquiries", "jobs.readDeliveryChunk"]);
export function brokerSocketPath(socket: string): string {
  if (process.platform === "win32") return socket + "-market";
  return path.join(path.dirname(socket), createHash("sha256").update(socket).digest("hex").slice(0,12) + ".mcp");
}

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
  grantFile?: string;
  network?: string;
  background?: boolean;
  log?: (line: string) => void;
}

export interface WalletServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

interface Session {
  connection?: ConnectionScope;
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

function handlers(wallet: AgencWallet, grants: ConnectionGrants | null, options: ServeWalletOptions): Handlers {
  const book = () => {
    if (!grants) throw new WalletError("NOT_AVAILABLE", "Pairing is unavailable on this wallet.");
    return grants;
  };
  const installation = (session: Session) => {
    if (!session.connection) throw new WalletError("NOT_ALLOWED", "This needs a paired installation.");
    return book().scope(session.connection.id);
  };
  const owner = (session: Session): boolean => session.role === "owner";
  const scope = (session: Session): string | undefined => session.agentId ?? undefined;
  const table: Handlers = {
    ...featureRoutes(wallet),
    "connections.invite": async p => {
      if (!wallet.hasAgent(p.agentId)) throw new WalletError("NOT_FOUND", "Choose an existing wallet agent.");
      return book().invite(p);
    },
    "connections.attach": async (_,s) => book().attach(installation(s).id),
    "connections.redeem": async p => book().redeem(p.ticket),
    "connections.check": async p => book().scope(p.id),
    "connections.list": async () => book().list(),
    "connections.revoke": async p => book().revoke(p.id),
    "connections.handoff": async p => {
      const job = await wallet.getJob(text(p.jobId, "job"), true);
      return book().grant(p.id, job.id, job.agentId, p.permissions);
    },
    "agents.self": async (_,s) => {
      const agent = (await wallet.overview()).agents.find(a=>a.id === s.agentId);
      if (!agent) throw new WalletError("NOT_FOUND","No connected agent.");
      return {id:agent.id,address:agent.address};
    },
    "connections.info": async (_, s) => ({ ...installation(s), network: options.network ?? "sandbox", background: options.background === true }),
    "connections.tool": async (p, s) => {
      const grant = installation(s);
      if (!MARKET_TOOLS.some(t => t.name === p.name)) throw new WalletError("BAD_REQUEST", "Unknown Market tool.");
      const purchase = p.name === "market_hire" || p.name === "market_post";
      if (purchase && (typeof p.operationId !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(p.operationId)))
        throw new WalletError("BAD_REQUEST", "A purchase needs a stable operation ID.");
      if (p.lookup && !purchase) throw new WalletError("BAD_REQUEST", "Choose a purchase to look up.");
      if (p.lookup) {
        try { await wallet.callOutcome(grant.agentId, p.name === "market_hire" ? "hire" : "request", p.operationId!); }
        catch (err) { if (err instanceof WalletError && err.code === "NOT_FOUND") return null; throw err; }
      }
      const client: WalletClient = {
        role: "agent", agentId: grant.agentId, close() {},
        async call(method, params) {
          const current = installation(s);
          if (!AGENT_METHODS.includes(method) || (current.access === "read" && !READ_METHODS.has(method))) {
            throw new WalletClientError("NOT_ALLOWED", "The connection has read access only.");
          }
          try { return await table[method](params,s); }
          catch (err) { if (err instanceof WalletError) throw new WalletClientError(err.code,err.message); throw err; }
        },
      };
      return runMarketTool(client,grant.agentId,p.name,object(p.args),{
        ...(p.operationId ? { idempotencyKey: p.operationId } : {}), readOutcomeOnly: p.lookup === true, approvalWaitMs: 1, statusWaitMs: 1000,
      });
    },
    "connections.changes": async (p,s) => book().changes(installation(s).id, p.cursor),
    "connections.subscribe": async (p,s) => {
      const c = installation(s), jobId = text(p.jobId,"job");
      try { await wallet.getJob(jobId, false, c.agentId); }
      catch (error) {
        if (!(error instanceof WalletError) || error.code !== "NOT_FOUND") throw error;
        book().permission(c.id, jobId, "status");
      }
      return book().subscribe(installation(s).id, jobId);
    },
    "handoff.status": async (p,s) => {
      const grant = book().permission(installation(s).id, p.jobId, "status");
      const job = await wallet.getJob(grant.jobId, false, grant.payer);
      book().permission(installation(s).id, p.jobId, "status");
      return { jobId: job.id, payer: grant.payer, title: job.title, status: job.status, task: job.task, updatedAt: job.updatedAt };
    },
    "handoff.delivery": async (p,s) => {
      const g = book().permission(installation(s).id,p.jobId,"artifacts");
      const result = await wallet.jobDelivery(g.jobId,false,g.payer);
      book().permission(installation(s).id,p.jobId,"artifacts");
      return {result};
    },
    "handoff.file": async (p,s) => {
      const g = book().permission(installation(s).id,p.jobId,"artifacts");
      const file = await wallet.jobFile(g.jobId,text(p.sha256,"file"));
      book().permission(installation(s).id,p.jobId,"artifacts");
      return {file};
    },
    "handoff.propose": async (p,s) => {
      const g = book().permission(installation(s).id,p.jobId,"propose");
      if (!["change","reject","dispute"].includes(p.action)) throw new WalletError("BAD_REQUEST", "Choose a review proposal.");
      return { draft: await wallet.draftReview(g.jobId,p.action,text(p.note,"note"),undefined,g.payer) };
    },
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
    "market.find": (params) => wallet.findPage(params),
    "market.hire": (params, session) => {
      if (owner(session)) throw new WalletError("NOT_ALLOWED", "Request a quote and approve its ID before hiring.");
      return wallet.hire({
        ...params,
        // An agent can only ever hire as itself.
        agentId: session.agentId ?? text(params.agentId, "agent"),
      });
    },
    "market.postContest": (params, session) => {
      if (owner(session)) throw new WalletError("NOT_ALLOWED", "Request a quote and approve its ID before posting.");
      return wallet.post({ ...params, contestEntries: params.contestEntries ?? 0, agentId: session.agentId ?? text(params.agentId, "agent") });
    },
    "market.post": (params, session) => {
      if (owner(session)) throw new WalletError("NOT_ALLOWED", "Request a quote and approve its ID before posting.");
      return wallet.post({
        ...params,
        // An agent can only ever post as itself, from its own money.
        agentId: session.agentId ?? text(params.agentId, "agent"),
      });
    },
    "wallet.post": async (params) => ({ job: await wallet.postFromBalance(params) }),
    "wallet.quoteHire": (params) => wallet.hire(params, true),
    "wallet.quotePost": (params) => wallet.quotePost(params),
    "jobs.callOutcome": (params, session) => wallet.callOutcome(session.agentId ?? text(params.agentId, "agent"), params.kind, text(params.key, "call key")),
    "approvals.page": params => wallet.approvalPage(params.after),
    "approvals.get": params => wallet.getApproval(text(params.approvalId, "request")),
    "approvals.outcome": params => wallet.approvalOutcome(text(params.approvalId, "request")),
    "approvals.refresh": params => wallet.refreshApproval(text(params.approvalId, "request")),
    "approvals.list": params => wallet.approvalListPage(params.after),
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
    "jobs.contestPage": async (params, session) => wallet.contestPage(text(params.jobId, "job"), params.after, scope(session)),
    "jobs.contestReceipts": async (params, session) => wallet.contestReceipts(text(params.jobId, "job"), params.after, scope(session)),
    "jobs.contestQuote": async (params, session) => wallet.savedContestQuote(text(params.jobId, "job"), text(params.quoteId, "quote"), scope(session)),
    "jobs.quoteContest": async (params, session) => ({ job: await wallet.quoteContest(text(params.jobId, "job"), params, scope(session)) }),
    "jobs.decideContest": async params => ({ job: await wallet.decideContest(text(params.jobId, "job"), text(params.quoteId, "quote"), params.approve === true) }),
    "jobs.get": async (params, session) => ({
      job: await wallet.getJob(text(params.jobId, "job"), owner(session), scope(session)),
    }),
    "jobs.delivery": async (params, session) => ({
      result: await wallet.jobDelivery(text(params.jobId, "job"), owner(session), scope(session), params.entryId),
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
      job: await featureCall(wallet, "approveJob",
        text(params.jobId, "job"),
        params.rating,
        owner(session),
        scope(session),
        params.quoteId, params.ratingQuoteId,
      ),
    }),
    "jobs.reviewRecord": (params, session) => wallet.reviewRecord(text(params.jobId, "job"), scope(session), params),
    "jobs.draftReview": async (params, session) => ({
      draft: await wallet.draftReview(text(params.jobId, "job"), params.action, params.note, params.attachments, scope(session)),
    }),
    "jobs.confirmReview": async (params, session) => ({
      job: await wallet.confirmReview(text(params.jobId, "job"), params.review, owner(session)),
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
      job: await featureCall(wallet, "rateJob",
        text(params.jobId, "job"),
        params.score,
        owner(session),
        scope(session), params.ratingQuoteId,
      ),
    }),
    "activity.list": async (params) => ({ activity: await wallet.listActivity(params.limit) }),
    "earn.set": (params) =>
      wallet.setEarn(text(params.agentId, "agent"), params.enabled === true, params.minPayCents, params.fundingQuoteId),
    "earn.quote": (params) => wallet.quoteEarn(text(params.agentId, "agent"), params.offer, params.offerId, params.minPayCents),
    "earn.approveFunding": (params) => wallet.approveEarnFunding(text(params.quoteId, "quote")),
    "earn.offer": (params) =>
      wallet.setOffer(
        text(params.agentId, "agent"),
        params.offer ?? null,
        params.offerId === undefined || params.offerId === null
          ? undefined
          : text(params.offerId, "service"),
        params.fundingQuoteId,
      ),
    "wallet.withdraw": (params) => wallet.withdraw(text(params.to, "address"), params.amount),
    "backup.export": (params) =>
      featureCall(wallet, "exportBackup", text(params.password, "password"), text(params.file, "file"), params.business),
    "backup.check": (params) =>
      wallet.checkBackup(text(params.password, "password"), text(params.file, "file")),
  };
  return table;
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
  const brokerPath = brokerSocketPath(options.socketPath);
  const grants = options.grantFile ? new ConnectionGrants(options.grantFile, brokerPath) : null;
  const table = handlers(options.wallet, grants, options);
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

  const accept = (socket: Socket, paired: boolean) => {
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
    let nonce = paired ? randomBytes(32).toString("base64url") : null;
    let challenged = false;
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
          let result: Session | string = "Say hello first.";
          if (paired && nonce && grants) {
            try {
              if (!challenged) {
                send(grants.challenge((message as { probe: string }).probe, nonce));
                challenged = true;
                return;
              }
              const proof = message as Parameters<ConnectionGrants["authenticate"]>[1];
              const c = grants.authenticate(nonce, proof);
              if (!options.agentExists(c.agentId)) throw new Error();
              result = { role: "agent", agentId: c.agentId, connection: c };
            } catch { result = "Pair again in Market. This connection is unavailable."; }
            nonce = null;
          } else if (!paired && hello.hello === 1) result = authenticate(hello);
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
        if (paired && !CONNECTION_METHODS.has(request.method)) {
          respond({ id: request.id, ok: false, error: { code: "NOT_ALLOWED", message: "Use a scoped Market tool." } });
          return;
        }
        if (activeSession.role === "agent" && !agentMethods.has(request.method) && !(paired && CONNECTION_METHODS.has(request.method))) {
          respond({
            id: request.id,
            ok: false,
            error: {
              code: "NOT_ALLOWED",
              message: ["jobs.askChanges", "jobs.dispute", "jobs.confirmReview"].includes(request.method)
                ? "Review the current delivery and confirm this decision in Market."
                : "Only the person who owns this wallet can do that.",
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
            if (activeSession.connection) {
              const current = grants!.scope(activeSession.connection.id);
              if (!options.agentExists(current.agentId) || (current.access === "read" &&
                  !READ_METHODS.has(method) && !CONNECTION_METHODS.has(method))) {
                throw new WalletError("NOT_ALLOWED", "This connection cannot make that decision.");
              }
            }
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
  };
  const server: Server = createServer(socket => accept(socket,false));
  let closeOwnerPipe: (() => void) | undefined;
  if (process.platform === "win32") closeOwnerPipe = await listenWindowsPipe(options.socketPath, socket => accept(socket,false));
  else await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") chmodSync(options.socketPath, 0o600);

  let closeBroker: (() => void) | undefined;
  try {
    if (grants) {
      if (process.platform === "win32") closeBroker = await listenWindowsPipe(brokerPath, socket => accept(socket,true));
      else {
        prepareSocketPath(brokerPath);
        const broker = createServer(socket => accept(socket,true));
        await new Promise<void>((resolve,reject) => { broker.once("error",reject); broker.listen(brokerPath, resolve); });
        closeBroker = () => { broker.close(); };
        chmodSync(brokerPath, 0o600);
      }
    }
  } catch (error) { closeBroker?.(); closeOwnerPipe?.(); server.close(); throw error; }
  const stopEvents = grants ? options.wallet.on(event => {
    if (event.type === "job") grants.changed(event.jobId);
  }) : undefined;
  return {
    socketPath: options.socketPath,
    close() {
      stopEvents?.();
      closeBroker?.();
      closeOwnerPipe?.();
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
