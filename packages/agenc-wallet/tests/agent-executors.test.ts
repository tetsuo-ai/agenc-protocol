import { outputAgreementCriterion } from "../src/client/job-exchange.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { KeyPairSigner } from "@solana/kit";
import type { Chain } from "../src/chain.js";
import type { MarketServices } from "../src/services.js";
import { EarnHost, type EarnExecutor } from "../src/earn.js";
import { earnOptions } from "../src/earn-bootstrap.js";
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

function host(options: ConstructorParameters<typeof EarnHost>[0]["options"], chainNow = 1000, storage = false, fetchResult?: MarketServices['fetchResult']) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agent-executors-"));
  folders.push(dataDir);
  return new EarnHost({ dataDir, chain: { clusterTime: async () => chainNow, clientFor: () => ({}), network: "sandbox" } as unknown as Chain,
    services: { fetchResult, resultUploader: () => storage ? {url:"agenc://local", fetch:vi.fn()} : null, fileLinkPrefix: storage ? "agenc://file/" : null } as unknown as MarketServices, options, log: vi.fn(), notify: vi.fn() });
}

it("passes the owner's 0.01 SOL ceiling and buyer allowlist into a named-only worker", async () => {
  const bootstrap = { ownerToken: "fake", unlockSecret: "fake", earn: {
    executor: null, agentExecutors: { named: local }, maxRewardLamports: "10000000", ownJobsOnly: true,
  } };
  const options = withAgentExecutors(earnOptions(bootstrap), bootstrap.earn.agentExecutors, () => local);
  const earn = host(options);
  void earn.start({ agentId: "named", signer: { address: "fixture" } as unknown as KeyPairSigner, minRewardLamports: 0n });
  try {
    await vi.waitFor(() => expect(seen.contexts).toHaveLength(1));
    expect(seen.contexts[0]).toMatchObject({ config: {
      maxRewardLamports: 10_000_000n, allowUnboundedReward: false, allowAnyCreator: false, creatorAllowlist: [],
    } });
  } finally { await earn.stopAll(); }
});

it("applies verified requirements to callbacks, listing terms and the first paid turn", async () => {
  let generation = "one", agent = "claude-code" as "core" | "claude-code";
  const check = vi.fn(async () => {});
  const room = {...local, mode:"sandboxed" as const, isolatedJobRoom:true, jobRoom:true};
  const earn = host({executor:room, roomWork:()=>({} as never), checkExecutionReady:check,
    defaultExecutorGeneration:()=>generation, liveRoomState:()=>({agent,coreCommand:null,generation,ready:true})});
  void earn.start({agentId:"seller",signer:{address:"fake"} as unknown as KeyPairSigner,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx = seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const facts = {task:"task" as never,creator:"buyer" as never,firstRoundCents:4,promptBytes:40,acceptance:[outputAgreementCriterion({requiredFiles:[],allowTextOnly:true})]};
    await ctx.checkExecutionReady!(facts);
    expect(check).toHaveBeenCalledWith(expect.objectContaining({admission:expect.objectContaining({source:"external",promptBytes:40})}));
    for (const extra of [{privateInputs:true}, {reviewFiles:1}, {promptBytes:6144},
      {acceptance:[outputAgreementCriterion({requiredFiles:["answer.txt"],allowTextOnly:false})]}])
      await expect(ctx.checkExecutionReady!({...facts,...extra})).rejects.toThrow();
    expect(earn.supportsPrivateInputs("seller")).toBe(false);
    expect(earn.supportsService("seller",{servicePin:true})).toBe(false);
    generation = "two"; agent = "core";
    expect(earn.supportsPrivateInputs("seller")).toBe(true);
    expect(earn.supportsService("seller",{servicePin:true})).toBe(true);
  } finally { await earn.stopAll(); }
});

it.each([
  ["missing delivery store",{acceptance:[outputAgreementCriterion({requiredFiles:["answer.txt"],allowTextOnly:false})]}],
  ["first turn, 6 KiB",{promptBytes:6144}],["first turn, minimum JSON envelope",{promptBytes:4920}],
  ["private hire sent to a callback",{privateInputs:true}],["review attachments",{reviewFiles:1}],
] as const)("refuses %s before the host callback commits a claim",async (_name,extra)=>{
  const room={...local,mode:"sandboxed" as const,isolatedJobRoom:true};
  const earn=host({executor:room,roomWork:()=>({} as never),checkExecutionReady:async()=>{},
    liveRoomState:()=>({agent:"claude-code",ready:true,coreCommand:null,generation:"one"})});
  void earn.start({agentId:"seller",signer:{address:"fake"} as unknown as KeyPairSigner,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    await expect(ctx.checkExecutionReady!({task:"task" as never,creator:"external" as never,promptBytes:100,
      firstRoundCents:1,...extra})).rejects.toThrow();
  } finally { await earn.stopAll(); }
});

it("rechecks the specific listing's advertised terms through a Core to Claude switch", async ()=>{
  let agent:"core"|"claude-code"="core";
  const room={...local,mode:"sandboxed" as const,isolatedJobRoom:true,jobRoom:true};
  const earn=host({executor:room,roomWork:()=>({} as never),checkExecutionReady:async()=>{},
    liveRoomState:()=>({agent,generation:agent,ready:true,coreCommand:process.execPath}),defaultExecutorGeneration:()=>agent});
  void earn.start({agentId:"seller",signer:{address:"fake"} as unknown as KeyPairSigner,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    ctx.log({event:"watch.started"});
    const ready=await earn.checkListingReady("seller",undefined,{servicePin:true});
    ready();
    agent="claude-code";
    expect(()=>ready()).toThrow();
    await expect(earn.checkListingReady("seller",undefined,{servicePin:true})).rejects.toThrow();
    expect(earn.supportsPrivateInputs("seller")).toBe(false);
  } finally { await earn.stopAll(); }
});

it("hands the executor only the remaining chain time on the host monotonic clock", async () => {
  const earn = host({executor:{...local,argv:[...local.argv,"{jobDeadline}"]}},1000);
  void earn.start({agentId:"seller",signer:{address:"fake"} as unknown as KeyPairSigner,minRewardLamports:0n,solUsd:async()=>100});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx = seen.contexts[0] as { executorForTask(...args:unknown[]):Promise<string[]> };
    const start = (await import("@tetsuo-ai/agenc-worker")).monotonicMs();
    const result = await ctx.executorForTask({creator:"buyer",deadline:0n,rewardAmount:100000000n},"task",undefined,null,null,undefined,undefined,undefined,1030n);
    const until = Number(result.at(-1)?.replace("boot:",""));
    expect(until-start).toBeGreaterThanOrEqual(29000);
    expect(until-start).toBeLessThanOrEqual(30100);
  } finally { await earn.stopAll(); }
});

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
  const ready = { ...local, argv:[process.execPath,"-e","void 0","room:{agent}","{prompt}"],mode:"sandboxed" as const, isolatedJobRoom:true, readiness:{argv:["/ready"]} };
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
    const paid = {task:"test" as never,creator:"buyer" as never,promptBytes:36};
    await expect(ctx.checkExecutionReady!({...paid, firstRoundCents:77})).rejects.toThrow("allowance");
    await expect(ctx.checkExecutionReady!({...paid, firstRoundCents:78})).resolves.toBeTypeOf("function");
  } finally { await earn.stopAll(); }
});

it.each(["codex-api","codex-plan"] as const)("applies verified job requirements to %s before the host check", async agent => {
  const probe = vi.fn(async () => {});
  const earn = host({executor:{...local, mode:"sandboxed", isolatedJobRoom:true},
    liveRoomState:()=>({agent,ready:true,coreCommand:null,generation:"selected",
      ...(agent === "codex-plan" && {minimumModelCents:78})}), checkExecutionReady:probe},1000,true);
  void earn.start({agentId:"seller",signer:{address:"fake"} as unknown as KeyPairSigner,minRewardLamports:0n});
  try {
    await vi.waitFor(() => expect(seen.contexts).toHaveLength(1));
    const ctx = seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const paid = {acceptance:[outputAgreementCriterion({requiredFiles:[],allowTextOnly:true})],task:"test" as never, creator:"buyer" as never, firstRoundCents:1, promptBytes:20000};
    const {acceptance: _agreement, ...withoutAgreement} = paid;
    await expect(ctx.checkExecutionReady!({...withoutAgreement, firstRoundCents:200})).rejects.toThrow(/tools/);
    await expect(ctx.checkExecutionReady!({...paid, extraRoomFeatures:true, firstRoundCents:200})).rejects.toThrow(/tools/);
    await expect(ctx.checkExecutionReady!(paid)).rejects.toThrow(/allowance/);
    if (agent === "codex-api") {
      await expect(ctx.checkExecutionReady!({...paid, promptBytes:11_000})).rejects.toThrow(/allowance/);
      await expect(ctx.checkExecutionReady!({...paid, promptBytes:7_600})).resolves.toBeTypeOf("function");
      const acceptance=[outputAgreementCriterion({allowTextOnly:false,requiredFiles:["answer.txt"]})];
      await expect(ctx.checkExecutionReady!({...paid, acceptance, promptBytes:7_600})).rejects.toMatchObject({name:"ExecutorBudgetError"});
      await expect(ctx.checkExecutionReady!({...paid, acceptance, promptBytes:7_600,firstRoundCents:4})).resolves.toBeTypeOf("function");
    }
    await expect(ctx.checkExecutionReady!({...paid, firstRoundCents:100,reviewFiles:1})).rejects.toThrow(/tools/);
    expect(earn.supportsPrivateInputs("seller")).toBe(false);
    expect(earn.supportsService("seller",{servicePin:true})).toBe(false);
    await expect(ctx.checkExecutionReady!({...paid,firstRoundCents:100})).resolves.toBeTypeOf("function");
  } finally { await earn.stopAll(); }
});

it.each(["acp", "pi"] as const)("refuses an unfundable first %s call before the seller can sign", async agent => {
  const room = {...local, mode:"sandboxed" as const, isolatedJobRoom:true};
  const firstCall = {baseTicks:60_000_000_000,inputTicksPerByte:0,tokenHold:500000};
  const earn = host({executor:room, roomWork:()=>({} as never), checkExecutionReady:async()=>{},
    liveRoomState:()=>({agent, ready:true, identity:agent+":grok:"+"a".repeat(64), coreCommand:null, generation:"one", firstCall})});
  void earn.start({agentId:"seller",signer:{address:"fake"} as unknown as KeyPairSigner,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx = seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const facts = {task:"task" as never,creator:"buyer" as never,promptBytes:40, acceptance:[outputAgreementCriterion({requiredFiles:[],allowTextOnly:true})]};
    if (agent === "pi") await expect(ctx.checkExecutionReady!({...facts,creator:"buyer" as never})).rejects.toThrow(/allowance/);
    await expect(ctx.checkExecutionReady!({...facts,firstRoundCents:599})).rejects.toThrow(/allowance/);
    await ctx.checkExecutionReady!({...facts,firstRoundCents:600});
    expect(earn.supportsPrivateInputs("seller")).toBe(false);
  } finally { await earn.stopAll(); }
});

it("prices the required Claude system instruction and Bash tool before admission", async () => {
  const earn = host({ executor:{...local,mode:"sandboxed",isolatedJobRoom:true}, checkExecutionReady:async()=>{},
    liveRoomState:()=>({agent:"claude-code",coreCommand:null,ready:true,generation:"test"}) });
  void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const job={task:"job" as never, creator:"buyer" as never,firstRoundCents:1,promptBytes:4850,acceptance:[outputAgreementCriterion({requiredFiles:[],allowTextOnly:true})]};
    await expect(ctx.checkExecutionReady!(job)).rejects.toMatchObject({name:"ExecutorBudgetError"});
    await expect(ctx.checkExecutionReady!({...job,promptBytes:100,firstRoundCents:4})).resolves.toBeTypeOf("function");
  } finally {await earn.stopAll();}
});

it("refuses pinned paired offers without file transport", () => {
  const earn = host({executor:null,agentExecutors:{seller:{...peer,mode:"sandboxed",isolatedJobRoom:true}}});
  expect(earn.supportsService("seller",{servicePin:true})).toBe(false);
});

it("keeps a clock refusal before launch out of the usage receipt", async () => {
  const earn=host({executor:{...local,argv:[...local.argv,"{jobDeadline}"]}},1000);
  void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const task="11111111111111111111111111111111" as never;
    await expect(ctx.executorForTask!({deadline:1001n,creator:"other"} as never,task,3,null,null,undefined,undefined,5,999n)).rejects.toThrow();
    const {serviceUsage}=await import("../src/service-usage.js");
    expect(serviceUsage(earn.stateDir("seller"),task)).toBeNull();
  } finally {await earn.stopAll();}
});

it("reads a restored seller's measured cost from the original claim",async()=>{
  const fs=await import("node:fs");
  const {serviceUsage,indexClaimUsage}=await import("../src/service-usage.js");
  const root=mkdtempSync(path.join(tmpdir(),"usage-restore-")); folders.push(root);
  const task="1".repeat(32), state=path.join(root,"earn","seller"),dir=path.join(root,"model-spend",task+"-"+task);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"admission"),JSON.stringify({executor:"core",budget:10}));
  fs.writeFileSync(path.join(dir,"0"),"8");
  fs.writeFileSync(path.join(dir,"0.usage"),JSON.stringify({reservedCents:8,costUsd:0.071}));
  indexClaimUsage(state,task,path.join(dir,"0"));
  fs.mkdirSync(state,{recursive:true}); fs.rmSync(state,{recursive:true});
  expect(serviceUsage(state,task)).toEqual({budgetCents:10,reservedCents:8,unknownReservedCents:0,costUsd:0.071,runs:1});
});


it("pins the actual Codex executor and prices mandatory tool and final turns before signing", async () => {
  const check = vi.fn(async()=>{});
  let agent: "codex-plan" | "codex-api" = "codex-plan";
  const earn = host({executor:{...local, argv:["/node","/room","job","{prompt}"], mode:"sandboxed",isolatedJobRoom:true},
    liveRoomState:()=>({agent,...(agent==="codex-plan" && {minimumModelCents:78}),coreCommand:null,ready:true,generation:agent}),
    checkExecutionReady:check},1000,true);
  void earn.start({agentId:"seller",signer:{address:"fake"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const job={acceptance:[outputAgreementCriterion({requiredFiles:[],allowTextOnly:true})],creator:"buyer" as never,task:"task" as never,firstRoundCents:78,promptBytes:20};
    const acceptance=[outputAgreementCriterion({allowTextOnly:false,requiredFiles:["answer.txt"]})];
    await expect(ctx.checkExecutionReady!({...job,acceptance})).rejects.toMatchObject({name:"ExecutorBudgetError"});
    await expect(ctx.checkExecutionReady!({...job,acceptance,firstRoundCents:155})).rejects.toThrow(/allowance/);
    expect(check).not.toHaveBeenCalled();
    await expect(ctx.checkExecutionReady!({...job,acceptance,firstRoundCents:156})).resolves.toBeTypeOf("function");
    await expect(ctx.checkExecutionReady!(job)).resolves.toBeTypeOf("function");
    expect(ctx.executorIdentity!()).toBe("codex-plan");
    await expect(ctx.checkExecutionReady!({...job,revision:true,claimCounts:()=>({tokens:600001,calls:2})})).rejects.toMatchObject({name:"ExecutorBudgetError"});
    await expect(ctx.checkExecutionReady!({...job,revision:true,claimCounts:()=>({tokens:600000,calls:63})})).resolves.toBeTypeOf("function");
    await expect(ctx.checkExecutionReady!({...job,revision:true,claimCounts:()=>({tokens:0,calls:64})})).rejects.toMatchObject({name:"ExecutorBudgetError"});
    agent="codex-api";
    expect(ctx.executorIdentity!()).toBe("codex-api");
    await expect(ctx.checkExecutionReady!({...job,firstRoundCents:1,promptBytes:16_384})).rejects.toMatchObject({name:"ExecutorBudgetError"});
  } finally {await earn.stopAll();}
});

it("uses the offer's first-round money at activation and availability", async () => {
  const check = vi.fn(async()=>{});
  const earn=host({executor:{...local, mode:"sandboxed", isolatedJobRoom:true,reserveRevisionBudget:true},
    liveRoomState:()=>({agent:"codex-plan",minimumModelCents:78,coreCommand:null,ready:true,generation:"plan"}),checkExecutionReady:check});
  void earn.start({agentId:"seller",signer:{address:"fake"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    (seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext).log({event:"watch.started"});
    for(const modelBudgetCents of [20,78]) {
      await expect(earn.checkListingReady("seller",undefined,{modelCapCents:modelBudgetCents})).rejects.toMatchObject({name:"ExecutorBudgetError"});
    }
    await expect(earn.checkListingReady("seller",undefined,{modelCapCents:200})).resolves.toBeTypeOf("function");
    expect(check).toHaveBeenCalledWith(expect.objectContaining({admission:expect.objectContaining({firstRoundCents:120})}));
  } finally {await earn.stopAll();}
});

it("keeps file correction closed when a seller switches a pinned ACP claim to Core", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { fileCorrectionAllowed, indexClaimUsage } = await import("../src/service-usage.js");
  const root = mkdtempSync(path.join(tmpdir(), "file-correction-"));
  folders.push(root);
  const task = "1".repeat(32);
  const state = path.join(root, "earn", "seller");
  const ledger = path.join(root, "model-spend", task + "-" + task);
  mkdirSync(ledger, {recursive:true});
  writeFileSync(path.join(ledger, "admission"), JSON.stringify({executor:"acp:grok:fixture", budget:6000}));
  indexClaimUsage(state, task, path.join(ledger, "0"));
  expect(fileCorrectionAllowed(state, task, "core")).toBe(false);
});

it("prices the ACP command, answer and each promised revision before approval",async()=>{
  const firstCall={baseTicks:60000000000,inputTicksPerByte:0,tokenHold:500000};
  const earn=host({executor:{...local, mode:"sandboxed",isolatedJobRoom:true},roomWork:()=>({} as never),
    checkExecutionReady:async()=>{},liveRoomState:()=>({agent:"acp",identity:"acp:grok:"+"a".repeat(64),ready:true,coreCommand:null,generation:"one",firstCall})},1000,true);
  void earn.start({agentId:"seller",signer:{address:"fixture"} as unknown as KeyPairSigner,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const facts={task:"job" as never,creator:"buyer" as never,promptBytes:60,acceptance:[outputAgreementCriterion({requiredFiles:[],allowTextOnly:true})]};
    const files={...facts,acceptance:["Agreed outputs v1: at least one file; required files: note.txt"]};
    await expect.soft(ctx.checkExecutionReady!({...files,firstRoundCents:600})).rejects.toThrow(/allowance/);
    await expect.soft(ctx.checkExecutionReady!({...facts,firstRoundCents:600,laterRoundCents:[200,200]})).rejects.toThrow(/allowance/);
    await expect(ctx.checkExecutionReady!({...files,firstRoundCents:1200,laterRoundCents:[1200,1200]})).resolves.toBeTypeOf("function");
    expect(ctx.executorIdentity?.()).toBe("acp:grok:"+"a".repeat(64));
    await expect(ctx.checkExecutionReady!({...facts,acceptance:[],firstRoundCents:600})).rejects.toThrow();
    expect(earn.supportsService("seller",{requiredFiles:["note.txt"],modelCapCents:600})).toBe(false);
    expect(earn.supportsService("seller",{requiredFiles:["note.txt"],modelCapCents:1200})).toBe(true);
  } finally {await earn.stopAll();}
});
it.each(["claude-code","codex","acp:fixture","pi"])("admits only verified public work for %s", async agent => {
  const callback = vi.fn(async () => {});
  const room = {...local,mode:"sandboxed" as const,isolatedJobRoom:true, reserveRevisionBudget:true};
  const earn=host({executor:room,roomWork:()=>({} as never),checkExecutionReady:callback,
    connectedPublicJobs:{[agent]:{canDeliver:name=>name.endsWith(".txt"),firstTurnFits:(cents,bytes)=>cents>=4 && bytes<5000}},
    liveRoomState:()=>({agent,coreCommand:null,ready:true,generation:agent})},1000,true);
  void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    ctx.log({event:"watch.started"});
    const facts={task:"job" as never,creator:"buyer" as never,acceptance:[outputAgreementCriterion({requiredFiles:[],allowTextOnly:true})],promptBytes:30,firstRoundCents:6};
    await expect(ctx.checkExecutionReady!(facts)).resolves.toBeTypeOf("function");
    for (const extra of [{privateInputs:true},{reviewFiles:1},{extraRoomFeatures:true},{revision:true,reviewAttachments:1},
      {acceptance:[]},{requiredCapabilities:2n}]) {
      await expect(ctx.checkExecutionReady!({...facts,...extra})).rejects.toThrow();
    }
    expect(callback).toHaveBeenCalledTimes(1);
    await expect(ctx.checkExecutionReady!({...facts,acceptance:[outputAgreementCriterion({requiredFiles:["chart.csv"],allowTextOnly:false})]})).rejects.toThrow();
    await expect(ctx.checkExecutionReady!({...facts,revision:true})).resolves.toBeTypeOf("function");
    await expect(ctx.checkExecutionReady!({...facts,acceptance:[outputAgreementCriterion({requiredFiles:["answer.txt"],allowTextOnly:false})]})).resolves.toBeTypeOf("function");
    await expect(ctx.checkExecutionReady!({...facts,acceptance:[outputAgreementCriterion({requiredFiles:[],allowTextOnly:false})]})).rejects.toThrow();
    expect(earn.supportsService("seller",{modelCapCents:1})).toBe(false);
    await expect(earn.checkListingReady("seller",undefined,{modelCapCents:5})).rejects.toThrow();
    await expect(earn.checkListingReady("seller",undefined,{modelCapCents:10})).resolves.toBeTypeOf("function");
    await expect(earn.checkListingReady("seller",undefined,{modelCapCents:10,promptBytes:6000})).rejects.toThrow();
  } finally {await earn.stopAll();}
});

it("refuses a named job executable that disappears or loses execute permission",async()=>{
  const fs=await import("node:fs");
  const dir=fs.mkdtempSync(path.join(tmpdir(),"named-job-"));folders.push(dir);
  const exe=path.join(dir,"room");fs.writeFileSync(exe,"#!/bin/sh\nexit 0\n",{mode:0o700});
  const callback=vi.fn(async()=>{});
  const earn=host({executor:null,agentExecutors:{seller:{...local,argv:[exe,"room:{agent}","{prompt}"]}},checkExecutionReady:callback});
  void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const current=await ctx.checkExecutionReady!({task:"job" as never,creator:"buyer" as never});
    fs.chmodSync(exe,0o600);
    expect(()=>current && current()).toThrow();
    await expect(ctx.checkExecutionReady!({task:"job" as never,creator:"buyer" as never})).rejects.toThrow();
    fs.rmSync(exe);
    await expect(ctx.checkExecutionReady!({task:"job" as never,creator:"buyer" as never})).rejects.toThrow();
  } finally {await earn.stopAll();}
});

it.each(["job","peer-job"].flatMap(mode=>["outputs","private","revision"].map(kind=>[mode,kind])))("refuses unsupported %s rehearsal %s before admission",async (mode,kind)=>{
  const fs=await import("node:fs"),{createHash}=await import("node:crypto");
  const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
  const runtimeDigest="a".repeat(64), permissionDigest="b".repeat(64);
  const manifest=JSON.stringify({outputs:["answer.txt"],files:[],runtimeDigest,permissionDigest,capabilities:"1"});
  const pin={digest:sha(manifest),runtimeDigest,permissionDigest,capabilities:"1" as const};
  const dir=mkdtempSync(path.join(tmpdir(),"pinned-admission-"));folders.push(dir);
  const callback=vi.fn(async()=>{}),room={...local,jobRoom:true,mode:"sandboxed" as const,isolatedJobRoom:true,argv:[process.execPath,"room:{agent}",mode,"pair:fixture","{prompt}"]};
  const earn=new EarnHost({dataDir:dir,chain:{clientFor:()=>({}),network:"sandbox"} as never,
    services:{resultUploader:()=>({url:"agenc://test",fetch:vi.fn()}),fileLinkPrefix:"agenc://file/"} as never,
    options:{executor:room,checkExecutionReady:callback,roomWork:()=>({} as never)},log:vi.fn(),notify:vi.fn()});
  const installed=path.join(earn.stateDir("seller"),"service-bundles",pin.digest);fs.mkdirSync(installed,{recursive:true});
  fs.writeFileSync(path.join(installed,"manifest.json"),manifest);fs.writeFileSync(path.join(installed,"passed.json"),JSON.stringify({passed:true,digest:pin.digest}));
  void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n,specialistTerms:()=>({servicePin:pin})});
  try{
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const facts={task:"job" as never,creator:"buyer" as never,requiredCapabilities:5n};
    const agreement=(name:string)=>[outputAgreementCriterion({requiredFiles:[name],allowTextOnly:false})];
    await expect(ctx.checkExecutionReady!({...facts,acceptance:agreement("answer.txt")})).resolves.toBeTypeOf("function");
    const extra = kind === "outputs" ? {acceptance:agreement("chart.csv")} : kind === "private" ? {privateInputs:true} : {revision:true};
    await expect(ctx.checkExecutionReady!({...facts,...extra})).rejects.toThrow();
    expect(callback).toHaveBeenCalledOnce();
  }finally{await earn.stopAll();}
});

it("holds text revisions of delivered files and rejects new files in a text correction",async()=>{
  const {withFiles}=await import("../src/client/delivery-files.js");
  const body=Buffer.from(withFiles("Original plot.",[{name:"plot.png",type:"image/png",bytes:5,sha256:"b".repeat(64)}],"agenc://file/"));
  const {createHash}=await import("node:crypto");
  const previous={proofHashHex:createHash("sha256").update(body).digest("hex"),resultData:new Uint8Array(64)};
  const fetch=vi.fn(async()=>({bytes:body,uri:null}));
  const earn=host({executor:{...local,isolatedJobRoom:true,mode:"sandboxed"},
    liveRoomState:()=>({agent:"claude-code",coreCommand:null,ready:true,generation:"same"})},1000,true,fetch);
  void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    await expect(ctx.checkTextRevision?.({previous}) ?? Promise.resolve()).rejects.toThrow(/file/);
    expect(fetch).toHaveBeenCalledWith(previous);
    await expect(ctx.checkTextRevision?.({output:body}) ?? Promise.resolve()).rejects.toThrow(/file/);
    await expect(ctx.checkTextRevision?.({output:Buffer.from("Changed sentence.")})).resolves.toBeUndefined();
  } finally {await earn.stopAll();}
});

it("refuses a file agreement on an unlabeled named text executor",async()=>{
  const room={...local,argv:["/bin/true","--","room:{agent}","{prompt}"],mode:"sandboxed" as const,isolatedJobRoom:true};
  const earn=host({executor:null,agentExecutors:{seller:room},checkExecutionReady:async()=>{}},1000,true);
  void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const job={task:"job" as never,creator:"buyer" as never,acceptance:[outputAgreementCriterion({requiredFiles:["report.pdf"],allowTextOnly:false})]};
    await expect(ctx.checkExecutionReady!(job)).rejects.toThrow();
  } finally {await earn.stopAll();}
});

it.each([false,true])("gives an ordinary job argument no built-in file policy (named %s)",named=>{
  const room={...local, argv:[process.execPath,"/fixture/ordinary.js","job","{prompt}"], mode:"sandboxed" as const, isolatedJobRoom:true};
  const earn=host({executor:named?null:room,...(named && {agentExecutors:{seller:room}})},1000,true);
  expect(earn.supportsService("seller",{requiredFiles:["report.pdf"]})).toBe(false);
  expect(earn.supportsService("seller",{})).toBe(true);
});

it("pins the resolved named program even when both rooms use the same adapter ID",async()=>{
  const fs=await import("node:fs");
  const dir=fs.mkdtempSync(path.join(tmpdir(),"named-id-"));folders.push(dir);
  const program=path.join(dir,"program");
  const identity=async()=>{
    const earn=host({executor:null,agentExecutors:{seller:{...local,argv:[program,"room:{agent}","{prompt}"],connectedAgent:"acp:example"}}});
    const count=seen.contexts.length;
    void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n});
    try {
      await vi.waitFor(()=>expect(seen.contexts).toHaveLength(count+1));
      const ctx=seen.contexts.at(-1) as import("@tetsuo-ai/agenc-worker").WorkerContext;
      return [ctx.executorIdentity?.(),ctx.executorProgram?.()];
    } finally {await earn.stopAll();}
  };
  fs.writeFileSync(program,"#!/bin/sh\nexit 0\n",{mode:0o700});
  const first=await identity();
  fs.writeFileSync(program,"#!/bin/sh\nexit 1\n");
  const second=await identity();
  expect(second[0]).toBe(first[0]);
  expect(second[1]).not.toBe(first[1]);
});

it("checks the interpreter entry point after flags before admission and signing",async()=>{
  const fs=await import("node:fs");
  const dir=fs.mkdtempSync(path.join(tmpdir(),"entrypoint-"));folders.push(dir);
  const script=path.join(dir,"work.js");
  const earn=host({executor:null,agentExecutors:{seller:{...local,argv:[process.execPath,"--no-warnings",script,"room:{agent}","{prompt}"]}},
    checkExecutionReady:async()=>{}});
  void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const job={task:"job" as never,creator:"buyer" as never};
    await expect(ctx.checkExecutionReady!(job)).rejects.toThrow();
    fs.writeFileSync(script,"void 0");
    const check=await ctx.checkExecutionReady!(job);
    fs.unlinkSync(script);
    expect(()=>check && check()).toThrow();
  } finally {await earn.stopAll();}
});

it("holds a Core private hire when its approved processing selection is removed",async()=>{
  const fs=await import("node:fs"), dir=fs.mkdtempSync(path.join(tmpdir(),"private-choice-"));folders.push(dir);
  const slot=path.join(dir,"seller.processing.json");
  const earn=host({executor:{...local,mode:"sandboxed",jobRoom:true,isolatedJobRoom:true,argv:[process.execPath,"/fixture/room.mjs","job",path.join(dir,"{agent}"),"room:{agent}","{prompt}"]},
    roomWork:()=>({} as never),checkExecutionReady:async()=>{}});
  void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const job={task:"job" as never,creator:"buyer" as never,privateInputs:true};
    fs.writeFileSync(slot,JSON.stringify({version:1,provider:"fixture",model:"example"}));
    const check=await ctx.checkExecutionReady!(job);
    fs.unlinkSync(slot);
    await expect(ctx.checkExecutionReady!(job)).rejects.toThrow();
    expect(()=>check && check()).toThrow();
  } finally {await earn.stopAll();}
});

it("requires the current native image probe to show a picker result",async()=>{
  const fs=await import("node:fs"),dir=mkdtempSync(path.join(tmpdir(),"picker-image-"));folders.push(dir);
  const count=path.join(dir,"probes"),bad=path.join(dir,"bad");
  let generation="1";
  const code="const fs=require('fs');fs.appendFileSync(process.argv[1],'x');process.exit(fs.existsSync(process.argv[2])?78:0)";
  const earn=host({executor:{...local,mode:"sandboxed",readiness:{argv:[process.execPath,"-e",code,count,bad]}},defaultExecutorGeneration:()=>generation});
  void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const job={task:"job" as never,creator:"buyer" as never,preview:true};
    fs.writeFileSync(bad,"invalid digest");
    await expect(ctx.checkExecutionReady!(job)).rejects.toThrow();
    generation="2";fs.unlinkSync(bad);
    await ctx.checkExecutionReady!(job);await ctx.checkExecutionReady!(job);
    expect(fs.readFileSync(count,"utf8")).toBe("xx");
    generation="3";fs.writeFileSync(bad,"different invalid digest");
    await expect(ctx.checkExecutionReady!(job)).rejects.toThrow();
  } finally {await earn.stopAll();}
});

it("keeps the full chosen file delivery allowance and both buyer revisions", async () => {
  const earn=host({executor:{...local,mode:"sandboxed",isolatedJobRoom:true},roomWork:()=>({} as never),checkExecutionReady:async()=>{},
    liveRoomState:()=>({agent:"acp",identity:"acp:grok:"+"b".repeat(64),ready:true,coreCommand:null,generation:"one",
      firstCall:{baseTicks:60000000000,inputTicksPerByte:0,tokenHold:500000}})},1000,true);
  void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const acceptance=[outputAgreementCriterion({requiredFiles:["note.txt"],allowTextOnly:false})];
    const correct=ctx.chosenCorrectionFits?.(acceptance) ?? true;
    const {admissionRounds,claimBudget}=await import("@tetsuo-ai/agenc-worker");
    const rounds=admissionRounds(6000,true,correct);
    expect(rounds).toEqual({firstRoundCents:3600,laterRoundCents:[1200,1200]});
    expect(claimBudget(6000,true,correct)).toEqual({totalCents:6000,remainingCents:3600,revisionRound:0});
    expect(ctx.roundCapacity?.(acceptance)).toEqual({calls:2,tokens:500001});
    await expect(ctx.checkExecutionReady!({task:"job" as never,creator:"buyer" as never,acceptance,...rounds})).resolves.toBeTypeOf("function");
  } finally { await earn.stopAll(); }
});

it("requires the business grant to cover the promised job window", async () => {
  const start=Date.now(), firstCall={needsExpiry:true,baseTicks:100,inputTicksPerByte:0,tokenHold:25000};
  let validUntil=start+600000;
  const earn=host({executor:{...local, mode:"sandboxed",isolatedJobRoom:true},roomWork:()=>({} as never),checkExecutionReady:async()=>{},
    liveRoomState:()=>({agent:"acp",identity:"acp:antigravity-business:"+"c".repeat(64),ready:true,coreCommand:null,generation:"one",validUntil,firstCall})},1000,true);
  void earn.start({agentId:"seller",signer:{address:"fixture"} as never,minRewardLamports:0n});
  try {
    await vi.waitFor(()=>expect(seen.contexts).toHaveLength(1));
    const ctx=seen.contexts[0] as import("@tetsuo-ai/agenc-worker").WorkerContext;
    const needs={task:"job" as never,creator:"buyer" as never,firstRoundCents:600,loginThroughMs:start+86400000,
      acceptance:[outputAgreementCriterion({requiredFiles:[],allowTextOnly:true})]};
    await expect(ctx.checkExecutionReady!(needs)).rejects.toThrow(/expires/);
    validUntil=start+86400001;
    const guard=await ctx.checkExecutionReady!(needs);
    validUntil=start+100;
    expect(guard).toThrow(/expires/);
  } finally { await earn.stopAll(); }
});
