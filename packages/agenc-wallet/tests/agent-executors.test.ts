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
