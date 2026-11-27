import { outputAgreementCriterion } from "../src/client/job-exchange.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { KeyPairSigner } from "@solana/kit";
import type { Chain } from "../src/chain.js";
import type { MarketServices } from "../src/services.js";
import { EarnHost, type EarnExecutor } from "../src/earn.js";
import { withAgentExecutors } from "../src/agent-executors.js";

const seen = vi.hoisted(() => ({ runs: [] as { agent: string; argv: string[] }[], contexts: [] as unknown[] }));
vi.mock("@tetsuo-ai/agenc-worker", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tetsuo-ai/agenc-worker")>(),
  checkSettlements: vi.fn(async () => []),
  runUpkeep: vi.fn(async () => undefined),
  runUp: vi.fn(async (ctx: { config: { executor: string[] }; agentId?: string }) => {
    seen.contexts.push(ctx);
    seen.runs.push({ agent: ctx.config.executor.find((p) => p.startsWith("room:"))!.slice(5), argv: ctx.config.executor });
    throw new Error("stop after one look");
  }),
}));

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  seen.runs.length = 0;
  seen.contexts.length = 0;
});

const local: EarnExecutor = { argv: ["/local/room", "job", "room:{agent}", "{prompt}"], mode: "safe", envAllowlist: [], timeoutMs: 60_000 };
const peer: EarnExecutor = { argv: ["/node", "/job-room.mjs", "peer-job", "room:{agent}", "{prompt}"], mode: "safe", envAllowlist: [], timeoutMs: 60_000 };

function host(options: ConstructorParameters<typeof EarnHost>[0]["options"]) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agent-executors-"));
  folders.push(dataDir);
  return new EarnHost({ dataDir, chain: { clientFor: () => ({}), network: "sandbox" } as unknown as Chain,
    services: { resultUploader: () => null, fileLinkPrefix: null } as unknown as MarketServices, options, log: vi.fn(), notify: vi.fn() });
}

it("keeps the shared executor for every seller the host did not pair", () => {
  const earn = host({ executor: local, agentExecutors: { paired: peer } });
  expect(earn.executorFor("paired")).toBe(peer);
  expect(earn.executorFor("local")).toBe(local);
  expect(earn.executorFor("another")).toBe(local);
  expect(earn.available).toBe(true);
});

it("lets a paired seller earn when this computer has no local room", () => {
  const earn = host({ executor: null, agentExecutors: { paired: peer } });
  expect(earn.available).toBe(true);
  expect(earn.executorFor("paired")).toBe(peer);
  expect(earn.executorFor("local")).toBeNull();
  expect(earn.executorFor("__proto__")).toBeNull();
});

it("runs two sellers at once, one through the paired room and one locally", async () => {
  const earn = host({ executor: local, agentExecutors: { paired: peer }, pollIntervalMs: 10, maxIdlePollIntervalMs: 10 });
  const agent = (agentId: string) => ({ agentId, signer: { address: "x" } as unknown as KeyPairSigner, minRewardLamports: 0n });
  void earn.start(agent("paired"));
  void earn.start(agent("local"));
  await vi.waitFor(() => {
    expect(seen.runs.some((r) => r.agent === "paired")).toBe(true);
    expect(seen.runs.some((r) => r.agent === "local")).toBe(true);
  });
  earn.stopAll?.();
  expect(seen.runs.find((r) => r.agent === "paired")!.argv[2]).toBe("peer-job");
  expect(seen.runs.find((r) => r.agent === "local")!.argv[0]).toBe("/local/room");
});

it("checks each named executor like the shared one and refuses bad names", () => {
  const check = vi.fn((executor: object) => executor as EarnExecutor);
  expect(withAgentExecutors({ executor: local }, undefined, check)).toEqual({ executor: local });
  expect(withAgentExecutors({ executor: null }, { paired: peer }, check)).toEqual({ executor: null, agentExecutors: { paired: peer } });
  expect(check).toHaveBeenCalledTimes(1);
  expect(() => withAgentExecutors({ executor: local }, { "../x": peer }, check)).toThrow(/not valid/);
  expect(() => withAgentExecutors({ executor: local }, [peer], check)).toThrow(/not valid/);
  expect(() => withAgentExecutors({ executor: local }, { paired: null }, check)).toThrow(/not valid/);
  expect(() => withAgentExecutors({ executor: local }, { paired: { argv: [] } }, () => { throw new Error("needs {prompt}"); })).toThrow(/prompt/);
});

it("gives a paired seller's peer the verified request, its usage reservation and the approved processing", async () => {
  const pin = { digest: "a".repeat(64), runtimeDigest: "b".repeat(64), permissionDigest: "c".repeat(64), capabilities: "1" as const };
  const paired: EarnExecutor = { argv: ["/node", "/job-room.mjs", "peer-job", "/profile.json", "{task}", "{servicePin}", "{jobExpires}", "{pay}", "{requestSource}", "{prompt}"],
    mode: "sandboxed", isolatedJobRoom: true, envAllowlist: [], timeoutMs: 60_000,
    readiness: { argv: ["/node", "/job-room.mjs", "peer-ready", "/profile.json"], timeoutMs: 1000 } } as EarnExecutor;
  const dataDir = mkdtempSync(path.join(tmpdir(), "agent-executors-"));
  folders.push(dataDir);
  const processing = vi.fn(async () => "Runs in the verified job room.");
  const earn = new EarnHost({ dataDir, chain: { clientFor: () => ({}), network: "sandbox" } as unknown as Chain,
    services: { resultUploader: () => null, fileLinkPrefix: null } as unknown as MarketServices,
    options: { executor: local, agentExecutors: { paired }, pollIntervalMs: 10, maxIdlePollIntervalMs: 10 }, log: vi.fn(), notify: vi.fn(),
    privateProcessing: processing });
  void earn.start({ agentId: "paired", signer: { address: "x" } as unknown as KeyPairSigner, minRewardLamports: 0n,
    specialistTerms: () => ({ servicePin: pin }) });
  await vi.waitFor(() => expect(seen.contexts.length).toBeGreaterThan(0));
  earn.stopAll?.();
  const ctx = seen.contexts[0] as { executorForTask: (...args: unknown[]) => Promise<string[]> };
  const task = { creator: "Buyer1111111111111111111111111111111111111", deadline: 99n, rewardAmount: 1n, requiredCapabilities: 1n };
  const address = "Task11111111111111111111111111111111111111";
  const argv = await ctx.executorForTask(task, address, 40, null, null, "Draw the verified postcard.");
  expect(argv[2]).toBe("peer-job");
  const context = JSON.parse(argv[argv.indexOf("external") + 1]!);
  expect(context).toMatchObject({ task: address, pin, request: "Draw the verified postcard.", privateProcessing: "Runs in the verified job room.", bundleDir: null });
  expect(context.receipt).toMatch(/service-usage/);
  expect(processing).toHaveBeenCalledWith("paired", address);
});

it("hands the room the verified job's agreed outputs and refuses a malformed agreement", async () => {
  const pin = { digest: "a".repeat(64), runtimeDigest: "b".repeat(64), permissionDigest: "c".repeat(64), capabilities: "1" as const };
  const paired: EarnExecutor = { argv: ["/node", "/job-room.mjs", "peer-job", "/profile.json", "{task}", "{servicePin}", "{jobExpires}", "{pay}", "{requestSource}", "{prompt}"],
    mode: "sandboxed", isolatedJobRoom: true, envAllowlist: [], timeoutMs: 60_000,
    readiness: { argv: ["/node", "/job-room.mjs", "peer-ready", "/profile.json"], timeoutMs: 1000 } } as EarnExecutor;
  const dataDir = mkdtempSync(path.join(tmpdir(), "agent-executors-"));
  folders.push(dataDir);
  const earn = new EarnHost({ dataDir, chain: { clientFor: () => ({}), network: "sandbox" } as unknown as Chain,
    services: { resultUploader: () => null, fileLinkPrefix: null } as unknown as MarketServices,
    options: { executor: local, agentExecutors: { paired }, pollIntervalMs: 10, maxIdlePollIntervalMs: 10 }, log: vi.fn(), notify: vi.fn(),
    privateProcessing: vi.fn(async () => null) });
  void earn.start({ agentId: "paired", signer: { address: "x" } as unknown as KeyPairSigner, minRewardLamports: 0n,
    specialistTerms: () => ({ servicePin: pin }) });
  await vi.waitFor(() => expect(seen.contexts.length).toBeGreaterThan(0));
  earn.stopAll?.();
  const ctx = seen.contexts.at(-1) as { executorForTask: (...args: unknown[]) => Promise<string[]> };
  const task = { creator: "Buyer1111111111111111111111111111111111111", deadline: 99n, rewardAmount: 1n, requiredCapabilities: 1n };
  const address = "Task11111111111111111111111111111111111111";
  const scope = async (acceptance?: string[]) => {
    const argv = await ctx.executorForTask(task, address, 40, null, null, "Make the table.", acceptance);
    return JSON.parse(argv[argv.indexOf("external") + 1]!);
  };
  expect(await scope(["Name the source.", outputAgreementCriterion({ requiredFiles: ["report.csv"], allowTextOnly: false })]))
    .toMatchObject({ outputs: { requiredFiles: ["report.csv"], allowTextOnly: false } });
  expect(await scope(["Name the source."])).not.toHaveProperty("outputs");
  await expect(scope(["Agreed outputs v1: anything goes"])).rejects.toThrow();
});

it("hands a local room the agreed outputs even without a reservation or a pinned service", async () => {
  const room: EarnExecutor = { argv: ["/node", "/job-room.mjs", "job", "/room", "agenc", "900", "/assets", "/out", "/files", "{pay}", "{requestSource}", "{prompt}"],
    mode: "sandboxed", isolatedJobRoom: true, envAllowlist: [], timeoutMs: 60_000 } as EarnExecutor;
  const dataDir = mkdtempSync(path.join(tmpdir(), "agent-executors-"));
  folders.push(dataDir);
  const earn = new EarnHost({ dataDir, chain: { clientFor: () => ({}), network: "sandbox" } as unknown as Chain,
    services: { resultUploader: () => null, fileLinkPrefix: null } as unknown as MarketServices,
    options: { executor: room, pollIntervalMs: 10, maxIdlePollIntervalMs: 10 }, log: vi.fn(), notify: vi.fn() });
  void earn.start({ agentId: "solo", signer: { address: "x" } as unknown as KeyPairSigner, minRewardLamports: 0n, solUsd: async () => 100 });
  await vi.waitFor(() => expect(seen.contexts.length).toBeGreaterThan(0));
  earn.stopAll?.();
  const ctx = seen.contexts.at(-1) as { executorForTask: (...args: unknown[]) => Promise<string[]> };
  const task = { creator: "Buyer1111111111111111111111111111111111111", deadline: 99n, rewardAmount: 100_000_000n, requiredCapabilities: 1n };
  const address = "Task11111111111111111111111111111111111111";
  const argv = await ctx.executorForTask(task, address, undefined, null, null, "Make the table.",
    [outputAgreementCriterion({ requiredFiles: ["report.csv"], allowTextOnly: false })]);
  const scope = JSON.parse(argv[argv.indexOf("external") + 1]!);
  expect(scope).toMatchObject({ receipt: null, pin: null, task: address, outputs: { requiredFiles: ["report.csv"], allowTextOnly: false } });
  // Without agreed outputs nothing changes for an ordinary public job.
  const plain = await ctx.executorForTask(task, address, undefined, null, null, "Make the table.", ["Name the source."]);
  expect(plain.some(part => part.startsWith('{"'))).toBe(false);
});

it.each([[0n, 90n, "90"], [150n, 90n, "90"], [75n, 90n, "75"]])("binds executor time to task %s and canonical claim %s", async (deadline, expiry, expected) => {
  const earn = host({executor: { ...local, argv: [...local.argv, "{jobExpires}"] }});
  void earn.start({agentId:"worker", signer:{address:"fake"} as unknown as KeyPairSigner, minRewardLamports:0n, solUsd:async()=>100});
  try {
    await vi.waitFor(() => expect(seen.contexts).toHaveLength(1));
    const ctx = seen.contexts[0] as { executorForTask(...args: unknown[]): Promise<string[]> };
    const argv = await ctx.executorForTask({creator:"buyer", deadline, rewardAmount:100_000_000n}, "task",
      undefined, null, null, undefined, undefined, undefined, expiry);
    expect(argv.at(-1)).toBe(expected);
  } finally { await earn.stopAll(); }
});

it("keeps hand-picked jobs available to a named worker with its own ready sandbox", async () => {
  const ready = { ...local, mode:"sandboxed" as const, isolatedJobRoom:true, readiness:{argv:["/ready"]} };
  const earn = host({ executor:ready, agentExecutors:{named:ready}, defaultExecutorEnabled:()=>false,
    chosenRoomEnabled:()=>true, checkExecutionReady:async()=>{} });
  void earn.start({agentId:"named", signer:{address:"fake"} as unknown as KeyPairSigner, minRewardLamports:0n});
  try {
    await vi.waitFor(() => expect(seen.contexts).toHaveLength(1));
    const ctx = seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const dispatch = vi.fn();
    ctx.log({event:"watch.started"});
    ctx.onWorkerReady!(dispatch, dispatch);
    expect(earn.workerLane("named")).toBe(dispatch);
    await expect(ctx.withChosenRoom!(async stop => { await ctx.checkChosenRoom!(stop); return !stop.aborted; })).resolves.toBe(true);
  } finally { await earn.stopAll(); }
});

it("invalidates an automatic admission while its room boots, including a switch away and back", async () => {
  let generation = "one";
  const earn = host({ executor:{...local, mode:"sandboxed"}, defaultExecutorGeneration:()=>generation,
    checkExecutionReady:async()=>{ generation="three"; } });
  void earn.start({agentId:"seller", signer:{address:"fake"} as unknown as KeyPairSigner, minRewardLamports:0n});
  try {
    await vi.waitFor(() => expect(seen.contexts).toHaveLength(1));
    const ctx = seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    await expect(ctx.checkExecutionReady!({task:"task" as never})).rejects.toThrow(/selected|changed/);
  } finally { await earn.stopAll(); }
});

it.each(["public", "service", "private"])("passes verified %s admission and provenance to the actual readiness process", async kind => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "room-preclaim-"));
  folders.push(dataDir);
  const program = path.join(dataDir, "room.cjs");
  const {writeFileSync} = await import("node:fs");
  // Stand-in readiness succeeds for a generic room probe. The paid executor rejects this buyer's job.
  writeFileSync(program, 'if(process.argv.slice(-3).join(" ") === "admit external '+kind+'") process.exit(78);');
  const room: EarnExecutor = {...local, mode:"sandboxed", isolatedJobRoom:true,
    readiness:{argv:[process.execPath, program, "self-test", "/assets", dataDir]} };
  const pin = {digest:"a".repeat(64),runtimeDigest:"b".repeat(64),permissionDigest:"c".repeat(64),capabilities:"1" as const};
  const earn = host({executor:room});
  void earn.start({agentId:"seller", signer:{address:"fake"} as unknown as KeyPairSigner, minRewardLamports:0n,
    ...(kind === "service" && {specialistTerms:()=>({servicePin:pin})}) });
  try {
    await vi.waitFor(() => expect(seen.contexts).toHaveLength(1));
    const ctx = seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    await expect(ctx.checkExecutionReady!({task:"task" as never,creator:"buyer" as never,
      privateInputs:kind === "private", requiredCapabilities:1n})).rejects.toThrow();
  } finally { await earn.stopAll(); }
});

it("refreshes room availability and readiness while the same wallet is open", async () => {
  let selected = false;
  const room: EarnExecutor = { ...local, mode: "sandboxed", isolatedJobRoom: true, readiness: { argv: ["/test/ready"] } };
  const earn = host({ executor: room, defaultExecutorEnabled: () => selected, chosenRoomEnabled: () => true,
    checkExecutionReady: async () => {}, pollIntervalMs: 10 });
  expect(earn.available).toBe(false);
  expect(earn.executorFor("agent_1")).toBeNull();
  selected = true;
  expect(earn.available).toBe(true);
  expect(earn.chosenRoom).toBe(true);
  expect(earn.executorFor("agent_1")).toBe(room);
  void earn.start({ agentId: "seller", signer: { address: "fake" } as unknown as KeyPairSigner, minRewardLamports: 0n });
  try {
    await vi.waitFor(() => expect(seen.contexts).toHaveLength(1));
    const ctx = seen.contexts[0] as { checkExecutionReady(scope: object): Promise<void> };
    selected = false;
    expect(earn.available).toBe(false);
    expect(earn.chosenRoom).toBe(false);
    await expect(ctx.checkExecutionReady({})).rejects.toThrow(/selected/);
  } finally { await earn.stopAll(); }
});

it("takes a model minimum only from the host room readiness report", async () => {
  const folder = mkdtempSync(path.join(tmpdir(),"room-allowance-"));
  folders.push(folder);
  const program = path.join(folder,"room.cjs");
  const {writeFileSync} = await import("node:fs");
  writeFileSync(program, 'console.log(JSON.stringify({ok:true,minimumModelCents:78}));');
  const earn = host({executor:{...local, mode:"sandboxed",isolatedJobRoom:true,
    readiness:{argv:[process.execPath,program,"self-test","/assets",folder]}}});
  void earn.start({agentId:"seller", signer:{address:"fake"} as unknown as KeyPairSigner,minRewardLamports:0n});
  try {
    await vi.waitFor(() => expect(seen.contexts).toHaveLength(1));
    const ctx = seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const admission = await ctx.checkExecutionReady!({task:"test" as never,creator:"buyer" as never});
    expect(admission).toMatchObject({minimumModelCents:78,current:expect.any(Function)});
  } finally { await earn.stopAll(); }
});
