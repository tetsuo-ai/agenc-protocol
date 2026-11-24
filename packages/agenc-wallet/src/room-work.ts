// Wallet side of the worker's RoomWork for a seller's private job. The job room
// program gets B's scoped exchange session for this claim and room through a
// per-run socket, and a buyer's answer becomes one durable resume of that run.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Address } from "@solana/kit";
import { ExecutorError, runExecutor, type WorkerContext } from "@tetsuo-ai/agenc-worker";

type RoomWork = NonNullable<WorkerContext["roomWork"]>;
type VerifiedRoomWork = Parameters<RoomWork["admit"]>[0];
import type { JobExchangeSession } from "./job-exchange-session.js";
import type { ExchangeReceipt, JobMessage } from "./client/job-exchange.js";
import { bundleManifest, privateRequirementFromSpec } from "./private-inputs.js";
import { ROOM_EXCHANGE_METHODS } from "./client/room-exchange.js";

type Execute = typeof runExecutor;
type Input = Parameters<Execute>[0];

/** Serve one session to one room run. The token is single-run; the socket lives in a private folder. */
export async function serveRoomExchange(session: JobExchangeSession) {
  const dir = mkdtempSync(join(tmpdir(), "agenc-rx-"));
  const socket = join(dir, "x.sock");
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
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  return {
    address: { socket, token },
    async close() {
      for (const conn of open) conn.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Add `exchange` to the wallet's scope JSON for this task. The room program reads it from there. */
function withExchange(argv: readonly string[], task: string, address: { socket: string; token: string }) {
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
    const link = await serveRoomExchange(session);
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

