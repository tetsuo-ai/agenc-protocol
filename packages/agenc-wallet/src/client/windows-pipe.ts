// Local listeners for the wallet and its hosts on Windows.
//
// Every listener without an AppContainer profile (the owner pipe, the broker,
// the unlock pipe, Desktop's controls) is Node's own named pipe. libuv creates
// its first instance with FILE_FLAG_FIRST_PIPE_INSTANCE, so a name another
// program took first fails with EADDRINUSE and nothing is served on it. The
// default named pipe DACL grants write access only to this user, SYSTEM and
// the administrators; everyone else may only read. libuv sets no
// PIPE_REJECT_REMOTE_CLIENTS, so every server here speaks only after the
// client wrote first: a reader that cannot write gets nothing. (Wine 10 does
// not enforce the first instance flag; Windows does.) A program of this
// user's can still take the name first, so no client sends a secret before
// the service proved it holds it (`hello-proof.ts`, the unlock server key in
// `unlock.ts`).
//
// An AppContainer chat needs an explicit ACE for its AppContainer SID, which
// Node cannot set. That listener is a fixed, precompiled helper
// (`market-pipe.exe`, shipped with Desktop) that owns the pipe and carries
// bytes over its stdio. Node never opens a second, less restricted listener
// behind it. Nothing here compiles or runs a script.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { Duplex } from "node:stream";

/** Where a host names the AppContainer pipe helper when it passes no path. */
export const PIPE_HELPER_ENV = "AGENC_MARKET_PIPE_HELPER";

/** The AppContainer pipe helper is missing or did not start. */
export class PipeHelperUnavailable extends Error {
  constructor(message = "The Windows pipe helper did not start.") {
    super(message);
    this.name = "PipeHelperUnavailable";
  }
}

/** Another program already serves this pipe or socket name. */
export class PipeNameTaken extends Error {
  readonly code = "EADDRINUSE";
  constructor() {
    super("Another program is already using this connection's name, so it was not opened. Close that program and try again.");
    this.name = "PipeNameTaken";
  }
}

/** `server.listen(endpoint)`, with a name taken first as a plain error. */
export function listenLocal(server: Server, endpoint: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException): void => {
      reject(error.code === "EADDRINUSE" ? new PipeNameTaken() : error);
    };
    server.once("error", failed);
    server.listen(endpoint, () => {
      server.off("error", failed);
      resolve();
    });
  });
}

/**
 * Serve `accept` on the named pipe `endpoint`. With `profile` (an AppContainer
 * profile name) the pipe sits under `\\.\pipe\LOCAL\` and also admits that
 * AppContainer, through the helper named by `options.helper` or
 * `AGENC_MARKET_PIPE_HELPER`; without one it is Node's own named pipe.
 */
export async function listenWindowsPipe(
  endpoint: string,
  accept: (socket: Socket) => void,
  profile = "",
  options: { helper?: string; startupTimeoutMs?: number } = {},
): Promise<() => void> {
  const prefix = profile ? "\\\\.\\pipe\\LOCAL\\" : "\\\\.\\pipe\\";
  if (
    (profile && !/^AgenC\.OA[a-f0-9]{24}$/.test(profile)) ||
    !endpoint.startsWith(prefix) ||
    !/^agenc-[a-z0-9-]{1,90}$/i.test(endpoint.slice(prefix.length))
  )
    throw new Error("Invalid Market pipe name.");
  if (!profile) {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      accept(socket);
    });
    await listenLocal(server, endpoint);
    return () => {
      server.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    };
  }
  return listenThroughHelper(endpoint, accept, profile, options);
}

function helperPath(explicit: string | undefined): string {
  const file = explicit ?? process.env[PIPE_HELPER_ENV] ?? "";
  if (!file || !(path.win32.isAbsolute(file) || path.isAbsolute(file))) throw new PipeHelperUnavailable();
  try {
    if (!existsSync(file) || !statSync(file).isFile()) throw new PipeHelperUnavailable();
  } catch {
    throw new PipeHelperUnavailable();
  }
  return file;
}

function listenThroughHelper(
  endpoint: string,
  accept: (socket: Socket) => void,
  profile: string,
  options: { helper?: string; startupTimeoutMs?: number },
): Promise<() => void> {
  const file = helperPath(options.helper);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(file, [endpoint, profile], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return Promise.reject(new PipeHelperUnavailable());
  }
  const input = child.stdin!;
  child.stderr!.resume();
  const clients = new Map<string, Duplex>();
  let ready = false;
  const stop = () => {
    child.kill();
    for (const s of clients.values()) s.destroy();
    clients.clear();
  };
  return new Promise((resolve, reject) => {
    const startup = setTimeout(() => {
      stop();
      reject(new PipeHelperUnavailable());
    }, options.startupTimeoutMs ?? 15_000);
    child.once("error", () => {
      clearTimeout(startup);
      stop();
      if (!ready) reject(new PipeHelperUnavailable());
    });
    child.once("exit", () => {
      clearTimeout(startup);
      stop();
      if (!ready) reject(new PipeHelperUnavailable());
    });
    input.on("error", () => stop());
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (line === "ready") {
        if (ready) return;
        ready = true;
        clearTimeout(startup);
        resolve(stop);
        return;
      }
      if (!ready) return;
      const i = line.indexOf(" "),
        id = line.slice(0, i),
        content = line.slice(i + 1);
      if (!/^\d+$/.test(id)) return;
      if (content === "+") {
        const stream = new Duplex({
          read() {},
          write(chunk: Buffer, _encoding, done) {
            input.write(id + " " + chunk.toString("base64") + "\n", done);
          },
          destroy(err, done) {
            clients.delete(id);
            if (input.writable) input.write(id + " -\n");
            done(err);
          },
        });
        // HTTP uses the Socket timeout/no-delay API on accepted streams.
        let timer: NodeJS.Timeout | undefined;
        Object.assign(stream, {
          setNoDelay: () => stream,
          setKeepAlive: () => stream,
          setTimeout(ms: number, cb?: () => void) {
            clearTimeout(timer);
            if (cb) stream.once("timeout", cb);
            if (ms > 0) timer = setTimeout(() => stream.emit("timeout"), ms).unref();
            return stream;
          },
        });
        stream.once("close", () => clearTimeout(timer));
        clients.set(id, stream);
        accept(stream as Socket);
      } else {
        const stream = clients.get(id);
        if (content === "-") stream?.push(null);
        else if (stream) {
          if (stream.readableLength > 4 * 1024 * 1024) stream.destroy();
          else stream.push(Buffer.from(content, "base64"));
        }
      }
    });
  });
}
