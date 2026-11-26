// Wallet side of the worker's RoomWork for a seller's private job. The job room
// program gets B's scoped exchange session for this claim and room through a
// per-run socket, and a buyer's answer becomes one durable resume of that run.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { Address } from "@solana/kit";
import { ExecutorError, runExecutor, type WorkerContext } from "@tetsuo-ai/agenc-worker";

type RoomWork = NonNullable<WorkerContext["roomWork"]>;
type VerifiedRoomWork = Parameters<RoomWork["admit"]>[0];
import type { JobExchangeSession } from "./job-exchange-session.js";
import { outputAgreementFromSpec, type ExchangeReceipt, type JobMessage } from "./client/job-exchange.js";
import { bundleManifest, privateRequirementFromSpec } from "./private-inputs.js";
import { ROOM_EXCHANGE_METHODS, type RoomExchangeAddress } from "./client/room-exchange.js";

type Execute = typeof runExecutor;
type Input = Parameters<Execute>[0];

/** The folder a standalone wallet keeps its sockets in when its own folder is too deep (`defaultSocketPath`). */
export function fallbackSocketDir(): string {
  return join(tmpdir(), `agenc-wallet-${typeof process.getuid === "function" ? process.getuid() : 0}`);
}

/**
 * The private folder a run's exchange socket and token file live in: the folder of the wallet's own socket, which
 * a host that walls other programs in (Desktop's outside agents) already keeps them out of. Owner-only, or nothing
 * is served. Never a fresh folder in the shared temp folder: no wall knows that one.
 */
export function roomExchangeDir(configured?: string): string {
  if (process.platform === "win32") throw new Error("A private job room needs a Unix socket, which this system does not have.");
  const dir = configured ?? fallbackSocketDir();
  if (!isAbsolute(dir)) throw new Error("The private exchange needs an absolute folder.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0)
    throw new Error("The private exchange folder is not private to this user.");
  return dir;
}

/** Longest socket path every supported system accepts (macOS allows 103), as the wallet's own socket. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Serve one session to one room run, in `dir` (see `roomExchangeDir`). The one-run token is written to an
 * owner-only file beside the socket; the room program is told only the two paths, never the token: a program's
 * arguments and environment are readable by every other program of the same user.
 */
export async function serveRoomExchange(session: JobExchangeSession, configuredDir?: string) {
  const dir = roomExchangeDir(configuredDir);
  const name = "rx-" + randomBytes(6).toString("hex");
  const socket = join(dir, name + ".sock");
  const tokenFile = join(dir, name + ".key");
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) throw new Error("The private exchange folder's path is too long for a socket.");
  const token = randomBytes(32).toString("hex");
  const open = new Set<Socket>();
  const server: Server = createServer(conn => {
    open.add(conn);
    conn.on("close", () => open.delete(conn));
    conn.on("error", () => conn.destroy());
    let authed = false;
    let queue = Promise.resolve();
    createInterface({ input: conn }).on("line", line => {
      queue = queue.then(async () => {
        let message: { token?: string; id?: number; method?: string; params?: Record<string, unknown> };
        try { message = JSON.parse(line); } catch { conn.destroy(); return; }
        if (!authed) {
          const given = Buffer.from(String(message.token ?? ""));
          if (given.length !== token.length || !timingSafeEqual(given, Buffer.from(token))) { conn.destroy(); return; }
          authed = true;
          return;
        }
        const { id, method, params } = message;
        const reply = (body: object) => conn.write(JSON.stringify({ id, ...body }) + "\n");
        try {
          if (!(ROOM_EXCHANGE_METHODS as readonly string[]).includes(String(method))) throw new Error("Unknown private exchange step.");
          let result: unknown;
          if (method === "roomInputs") result = await session.roomInputs();
          else if (method === "importInputs") {
            const receipt = params?.receipt as ExchangeReceipt;
            result = await session.importInputs(async bundle => {
              // The room computed this against the same bundle; the wallet checks it again before signing the receipt.
              if (receipt?.manifest !== bundleManifest(bundle) || receipt.version !== bundle.version) throw new Error("The room receipt changed.");
              return receipt;
            });
          } else if (method === "returnRoomOutput") result = await session.returnRoomOutput(String(params?.text ?? ""), params?.files as never);
          else if (method === "send") result = await session.send(params?.message as JobMessage);
          else if (method === "roomTurnState") result = await session.roomTurnState();
          else result = await session.status();
          reply({ ok: true, result: result ?? null });
        } catch (error) {
          reply({ ok: false, error: error instanceof Error ? error.message : "The private exchange refused this step." });
        }
      });
    });
  });
  const remove = () => { rmSync(tokenFile, { force: true }); rmSync(socket, { force: true }); };
  try {
    writeFileSync(tokenFile, token, { flag: "wx", mode: 0o600 });
    // The folder is owner-only, so the socket is never reachable by anyone else, also before this chmod.
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    chmodSync(socket, 0o600);
  } catch (error) { server.close(); remove(); throw error; }
  return {
    address: { socket, tokenFile },
    async close() {
      for (const conn of open) conn.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      remove();
    },
  };
}

/** Add `exchange` (two paths, no secret) to the wallet's scope JSON for this task. The room program reads it from there. */
function withExchange(argv: readonly string[], task: string, address: RoomExchangeAddress) {
  let found = false;
  const out = argv.map(part => {
    if (found || !part.startsWith("{") || !part.includes(task)) return part;
    try {
      const scope = JSON.parse(part) as Record<string, unknown>;
      if (scope.task !== task) return part;
      found = true;
      return JSON.stringify({ ...scope, exchange: address });
    } catch { return part; }
  });
  if (!found) throw new Error("The room needs the wallet's verified job scope.");
  return out;
}

export interface RoomWorkPorts {
  /** B's session for this seller's confirmed claim and its assigned room, or null when none is assigned. */
  session(task: Address): Promise<JobExchangeSession | null>;
  /** Folder for this seller's durable room runs and continuations. */
  stateDir: string;
  /** The wallet's private socket folder, where each run's exchange is served. Default: the standalone wallet's. */
  exchangeDir?: string;
  execute?: Execute;
}

const runFile = (dir: string, task: string) => join(dir, "room-runs", task + ".json");
const resumeDir = (dir: string, task: string) => join(dir, "room-resume", task);

/** The worker's RoomWork for one seller agent. Jobs without private inputs keep the ordinary path. */
export function walletRoomWork(ports: RoomWorkPorts): RoomWork {
  const execute = ports.execute ?? runExecutor;
  const pending = (task: string) => {
    let names: string[] = [];
    try { names = readdirSync(resumeDir(ports.stateDir, task)); } catch { return null; }
    const id = names.find(n => /^[a-f0-9]{64}\.json$/.test(n));
    return id ? id.slice(0, 64) : null;
  };
  const runRoom = async (binding: VerifiedRoomWork, session: JobExchangeSession, input: Input) => {
    const link = await serveRoomExchange(session, ports.exchangeDir);
    try {
      return { state: "delivered" as const, stdout: (await execute({ ...input, argv: withExchange(input.argv, binding.task, link.address) })).stdout };
    } catch (error) {
      const { waiting } = await session.status().catch(() => ({ waiting: null }));
      if (waiting && !waiting.answer && !(error instanceof ExecutorError && error.detail.reason === "aborted")) return { state: "parked" as const };
      throw error;
    } finally { await link.close(); }
  };
  return {
    async admit(binding: VerifiedRoomWork) {
      if (binding.privateInputs && !privateRequirementFromSpec(binding.spec)) throw new Error("The private input terms are not valid.");
      // Before the claim, so no deposit moves: a public job whose agreed outputs are malformed, repeated, or name a
      // file no delivery can carry is one this seller could never deliver. (A private job's are in its staged bundle.)
      outputAgreementFromSpec(binding.spec);
    },
    async questions(binding: VerifiedRoomWork) {
      if (!binding.privateInputs) return undefined;
      const session = await ports.session(binding.task);
      if (!session) return undefined;
      return {
        session,
        // Durable before the wallet acknowledges the answer: a restart finds the same continuation.
        async enqueueOnce(id: string, answer: string, deadline: number) {
          mkdirSync(resumeDir(ports.stateDir, binding.task), { recursive: true, mode: 0o700 });
          try { writeFileSync(join(resumeDir(ports.stateDir, binding.task), id + ".json"), JSON.stringify({ answer, deadline }), { flag: "wx", mode: 0o600 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        },
      };
    },
    async open(binding: VerifiedRoomWork) {
      if (!binding.privateInputs) return { state: "ordinary" as const };
      const session = await ports.session(binding.task);
      if (!session) return { state: "waiting" as const };
      await session.join();
      const status = await session.refresh();
      if (status.state !== "waitingForRoom" && status.state !== "received") return { state: "waiting" as const };
      const continuation = pending(binding.task);
      if (continuation) {
        return {
          state: "resume" as const,
          async resume() {
            const saved = JSON.parse(readFileSync(runFile(ports.stateDir, binding.task), "utf8")) as Input;
            // Consume the continuation once: a restarted host cannot run it again.
            const done = join(resumeDir(ports.stateDir, binding.task), continuation + ".done");
            writeFileSync(done, "", { flag: "wx", mode: 0o600 });
            rmSync(join(resumeDir(ports.stateDir, binding.task), continuation + ".json"));
            return runRoom(binding, session, saved);
          },
        };
      }
      return {
        state: "ready" as const,
        async execute(input: Input) {
          // Kept so the buyer's answer resumes this same reserved run (same argv, budget receipt and deadline).
          mkdirSync(join(ports.stateDir, "room-runs"), { recursive: true, mode: 0o700 });
          const { signal: _signal, ...durable } = input;
          writeFileSync(runFile(ports.stateDir, binding.task), JSON.stringify(durable), { mode: 0o600 });
          return runRoom(binding, session, input);
        },
      };
    },
  };
}

