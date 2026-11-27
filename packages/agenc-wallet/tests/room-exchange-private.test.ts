// Where a private job's per-run exchange lives and how its token reaches the job room program.
// Another program of the same user reads a program's arguments (ps) and the shared temp folder, so neither may
// open the buyer's private files: the token is never in argv, and the socket sits in the wallet's private folder.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { checkRoomExchangeAddress, connectRoomExchange } from "../src/client/room-exchange.js";
import { fallbackSocketDir, roomExchangeDir, serveRoomExchange, walletRoomWork } from "../src/room-work.js";

const task = "So11111111111111111111111111111111111111112";
const secret = "the buyer's private rows";
const session = {
  join: async () => undefined,
  refresh: async () => ({ state: "waitingForRoom" }),
  status: async () => ({ waiting: null }),
  roomInputs: async () => ({ requirement: {}, room: "a".repeat(64), bundle: { files: [{ name: "in.txt", base64: Buffer.from(secret).toString("base64") }] } }),
};
const privateDir = () => { const dir = mkdtempSync(path.join(tmpdir(), "rxp-")); chmodSync(dir, 0o700); return dir; };

/** What a program holding only these lines gets back from the socket. */
function ask(socketPath: string, lines: object[]): Promise<string> {
  return new Promise<string>((resolve) => {
    const socket = connect(socketPath);
    let got = "";
    socket.on("error", () => resolve(got));
    socket.on("close", () => resolve(got));
    socket.on("data", (chunk) => { got += chunk.toString("utf8"); });
    socket.write(lines.map((line) => JSON.stringify(line) + "\n").join(""));
    setTimeout(() => socket.destroy(), 300);
  });
}

it("gives the room program two paths in the wallet's private socket folder and no token in its arguments", async () => {
  const exchangeDir = privateDir();
  let seen: string[] = [];
  let withArgvOnly = "";
  let asRoom = "";
  let modes: number[] = [];
  const work = walletRoomWork({
    session: async () => session as never,
    stateDir: mkdtempSync(path.join(tmpdir(), "rxp-state-")),
    exchangeDir,
    execute: (async (input: { argv: string[] }) => {
      seen = input.argv;
      const scope = JSON.parse(seen.find((part) => part.startsWith("{"))!) as { exchange: { socket: string; tokenFile: string } };
      // Everything the arguments hold, sent as the token: no answer.
      withArgvOnly = await ask(scope.exchange.socket, [{ token: seen.join(" ") }, { id: 1, method: "roomInputs" }]);
      withArgvOnly += await ask(scope.exchange.socket, [{ id: 1, method: "roomInputs" }]);
      modes = [exchangeDir, scope.exchange.socket, scope.exchange.tokenFile].map((file) => statSync(file).mode & 0o777);
      // The room program itself (same user, outside any wall) reads the token file and is served.
      const link = await connectRoomExchange(scope.exchange);
      asRoom = JSON.stringify(await link.roomInputs());
      link.close();
      return { stdout: Buffer.from("x") };
    }) as never,
  });
  const turn = await work.open({ task, seller: task, deadline: 0n, spec: {}, privateInputs: true, listingMetadata: null, listing: null } as never);
  expect(turn.state).toBe("ready");
  await (turn as { execute(input: unknown): Promise<unknown> }).execute({ argv: ["node", "room.mjs", "job", "external", JSON.stringify({ task }), "{prompt}"], prompt: "p", timeoutMs: 1000, envAllowlist: [] });
  const scope = JSON.parse(seen.find((part) => part.startsWith("{"))!) as { exchange: Record<string, string> };
  expect(Object.keys(scope.exchange).sort()).toEqual(["socket", "tokenFile"]);
  expect(seen.join(" ")).not.toMatch(/[a-f0-9]{64}/);
  expect(path.dirname(scope.exchange.socket!)).toBe(exchangeDir);
  expect(path.dirname(scope.exchange.tokenFile!)).toBe(exchangeDir);
  expect(modes).toEqual([0o700, 0o600, 0o600]);
  expect(withArgvOnly).toBe("");
  expect(asRoom).toContain(Buffer.from(secret).toString("base64"));
  // Nothing of the run is left behind.
  expect(readdirSync(exchangeDir)).toEqual([]);
});

it("never serves in a fresh folder of the shared temp folder", () => {
  expect(fallbackSocketDir()).toBe(path.join(tmpdir(), `agenc-wallet-${process.getuid!()}`));
  expect(roomExchangeDir()).toBe(fallbackSocketDir());
  expect(statSync(fallbackSocketDir()).mode & 0o777).toBe(0o700);
});

it("refuses a folder others can enter, a relative folder and a path too long for a socket", async () => {
  const open = mkdtempSync(path.join(tmpdir(), "rxp-open-"));
  chmodSync(open, 0o750);
  await expect(serveRoomExchange(session as never, open)).rejects.toThrow(/not private/);
  await expect(serveRoomExchange(session as never, "relative")).rejects.toThrow(/absolute/);
  const deep = path.join(privateDir(), "d".repeat(90));
  await expect(serveRoomExchange(session as never, deep)).rejects.toThrow(/too long/);
  expect(readdirSync(deep)).toEqual([]);
});

it("the room program refuses a link with a token in it, a token file others can read and a file outside the socket's folder", async () => {
  const dir = privateDir();
  const link = await serveRoomExchange(session as never, dir);
  try {
    const token = "a".repeat(64);
    expect(() => checkRoomExchangeAddress({ socket: link.address.socket, token })).toThrow(/not valid/);
    expect(() => checkRoomExchangeAddress({ ...link.address, token })).toThrow(/not valid/);
    const elsewhere = privateDir();
    writeFileSync(path.join(elsewhere, "t.key"), token, { mode: 0o600 });
    await expect(connectRoomExchange({ socket: link.address.socket, tokenFile: path.join(elsewhere, "t.key") })).rejects.toThrow(/not valid/);
    chmodSync(link.address.tokenFile, 0o644);
    await expect(connectRoomExchange(link.address)).rejects.toThrow(/not valid/);
    chmodSync(link.address.tokenFile, 0o600);
    const sub = path.join(dir, "sub");
    mkdirSync(sub, { mode: 0o755 });
    chmodSync(sub, 0o755);
    writeFileSync(path.join(sub, "t.key"), token, { mode: 0o600 });
    await expect(connectRoomExchange({ socket: path.join(sub, "x.sock"), tokenFile: path.join(sub, "t.key") })).rejects.toThrow(/not valid/);
    // The wallet's own link still works.
    const room = await connectRoomExchange(link.address);
    expect(JSON.stringify(await room.roomInputs())).toContain(Buffer.from(secret).toString("base64"));
    room.close();
  } finally { await link.close(); }
});

it.each(["own","external"])("resumes a parked 0.1.17 %s job with its original source and the earlier deadline",async source=>{
  const {rmSync,existsSync}=await import("node:fs");
  const {monotonicMs}=await import("@tetsuo-ai/agenc-worker");
  const dir=privateDir(), id="a".repeat(64);
  try {
    const resume=path.join(dir,"room-resume",task);
    mkdirSync(resume,{recursive:true}); mkdirSync(path.join(dir,"room-runs"));
    const message=path.join(resume,id+".json");
    writeFileSync(message,JSON.stringify({answer:"Q3",deadline:1_020_000}));
    const argv=["/node","/host","job","/room","/core","780","/assets","","","2",source,JSON.stringify({task,pin:null,receipt:path.join(dir,"first.receipt")}),"question"];
    writeFileSync(path.join(dir,"room-runs",task+".json"),JSON.stringify({argv,timeoutMs:780000,prompt:"question"}));
    let now=1030, run:string[]=[];
    const work=walletRoomWork({stateDir:dir,exchangeDir:dir,session:async()=>session as never,clusterTime:async()=>now,
      execute:async input=>{run=[...input.argv];return {stdout:Buffer.from("Q3")} as never;}});
    const turn=await work.open({task,privateInputs:true} as never);
    if(turn.state!=="resume") throw new Error("Expected a parked run.");
    const start=monotonicMs();
    await expect(turn.resume(start+30_000)).rejects.toThrow();
    expect(existsSync(message)).toBe(true);
    now=1000;
    const claimDir=path.join(dir,"model-spend","test-claim");
    const round=path.join(claimDir,"0");
    mkdirSync(claimDir,{recursive:true});
    writeFileSync(path.join(claimDir,"admission"),JSON.stringify({executor:"core",budget:2}));
    writeFileSync(round,"2");
    // An old layout alone cannot prove how much of the original grant is left.
    expect(await turn.resume(start+30_000,undefined,round)).toEqual({state:"parked"});
    expect(run).toEqual([]);
    expect(existsSync(message)).toBe(true);
    writeFileSync(round+".usage",JSON.stringify({reservedCents:2,costUsd:0.004}));
    writeFileSync(round+".counts",JSON.stringify({tokens:400,calls:1}));
    await turn.resume(start+30_000,undefined,round);
    expect(run[10]).toMatch(/^boot:/);
    expect(Number(run[10]!.slice(5))-start).toBeLessThan(20_000);
    expect(run[11]).toBe(source);
    expect(JSON.parse(run[12]!)).toMatchObject({task,executor:"core",claimRound:round,resume:true});
    expect(existsSync(path.join(claimDir,"continuation-"+id))).toBe(true);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
