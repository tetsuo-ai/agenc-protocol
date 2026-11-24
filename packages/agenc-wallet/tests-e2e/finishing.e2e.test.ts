import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { connectWallet, type WalletClient } from "../src/client/socket-client.js";
import type { AgentView } from "../src/client/types.js";
import type { EarnOptions } from "../src/earn.js";
import { serveWallet, type WalletServer } from "../src/server.js";
import { CENT, eventually, setEarnWithApproval, setOfferWithApproval, startWorld, type World } from "./harness.js";

let world: World | null = null;
let server: WalletServer | null = null;
let client: WalletClient | null = null;
const releases: (() => void)[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  client?.close();
  client = null;
  await server?.close();
  server = null;
  await world?.wallet.close();
  world = null;
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { entered, release, wait: async () => { enter(); await released; } };
}

/** Fail before releasing the job, so a blocking stop cannot accidentally pass. */
async function promptly<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("reply waited for the job")), 1_500);
      }),
    ]);
    expect(Date.now() - started).toBeLessThan(1_500);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function execution() {
  const dir = mkdtempSync(path.join(tmpdir(), "wallet-finishing-"));
  folders.push(dir);
  const script = [
    'const fs=require("node:fs"),path=require("node:path");',
    'const prefix=path.join(process.argv[1],process.argv[2]);',
    'fs.writeFileSync(prefix+".started","");',
    'const timer=setInterval(()=>{if(fs.existsSync(prefix+".release")){',
    'clearInterval(timer);process.stdout.write("The finished work.");}},20);',
  ].join("");
  const earn: EarnOptions = {
    executor: {
      argv: [process.execPath, "-e", script, dir, "{agent}", "{prompt}"],
      mode: "sandboxed", envAllowlist: [], timeoutMs: 30_000,
    },
    pollIntervalMs: 100,
  };
  return {
    earn,
    started: (id: string) => eventually(async () => existsSync(path.join(dir, `${id}.started`))),
    release: (id: string) => writeFileSync(path.join(dir, `${id}.release`), ""),
  };
}

async function post(title = "A paid job") {
  return world!.sandbox.postOpenJob({ title, instructions: "Write a friendly line.", rewardLamports: 50n * CENT });
}

async function view(id: string): Promise<AgentView> {
  return (await world!.wallet.overview()).agents.find((agent) => agent.id === id)!;
}

async function delivered(task: string): Promise<void> {
  await eventually(async () => (await world!.wallet.listJobs({ role: "working" }, true))
    .some((job) => job.task === task && job.status === "delivered"));
}

async function off(id: string): Promise<void> {
  await eventually(async () => (await view(id)).earn.state === "off");
}

describe("switching earning off while finishing work", () => {
  it("replies during execution, emits the end of finishing, and still delivers and gets paid", async () => {
    const work = execution();
    world = await startWorld({ earn: work.earn });
    const { wallet, sandbox, clock } = world;
    const agent = await wallet.createAgent("Worker");
    await setEarnWithApproval(wallet, agent.id, true, 10);
    const job = await post();
    await work.started(agent.id);
    expect((await promptly(wallet.setEarn(agent.id, false))).earn).toMatchObject({ enabled: false, state: "finishing" });
    expect((await view(agent.id)).earn).toMatchObject({ enabled: false, state: "finishing" });
    // A repeated off call must neither wait nor hide the running job.
    expect((await promptly(wallet.setEarn(agent.id, false))).earn.state).toBe("finishing");
    const observed: Promise<string>[] = [];
    const unsubscribe = wallet.on((event) => {
      if (event.type === "overview") observed.push(view(agent.id).then((agent) => agent.earn.state));
    });
    work.release(agent.id);
    await delivered(job.task);
    await off(agent.id);
    await eventually(async () => (await Promise.all(observed)).includes("off"));
    unsubscribe();
    // No buyer action is required: background upkeep collects an overdue review.
    sandbox.advanceClock(3_700);
    clock.now += 3_700_000;
    await wallet.tick();
    const paid = await view(agent.id);
    expect(paid.earn).toMatchObject({ enabled: false, state: "off", jobsDone: 1 });
    expect(paid.earned.lamports).toBe(((50n * CENT * 95n) / 100n).toString());
    expect((await wallet.getJob(`earn_${agent.id}_${job.task}`, true)).status).toBe("paid");
    const next = await post("Must stay unclaimed");
    await wallet.tick();
    await delay(300);
    expect((await wallet.listJobs({ role: "working" }, true)).some((job) => job.task === next.task)).toBe(false);
  }, 60_000);

  it.each(["upload", "submission"] as const)("keeps finishing throughout %s", async (phase) => {
    const work = execution();
    const pending = gate();
    world = await startWorld({
      earn: work.earn,
      ...(phase === "upload" ? {
        services: (base) => ({
          ...base,
          resultUploader(signer) {
            const uploader = base.resultUploader(signer)!;
            return { ...uploader, fetch: async (...args) => { await pending.wait(); return uploader.fetch(...args); } };
          },
        }),
      } : {
        chain: (base) => ({
          ...base,
          clientFor(signer) {
            const original = base.clientFor(signer);
            return Object.create(original, {
              submitTaskResult: { value: async (...args: Parameters<typeof original.submitTaskResult>) => {
                await pending.wait();
                return original.submitTaskResult(...args);
              } },
            }) as typeof original;
          },
        }),
      }),
    });
    const agent = await world.wallet.createAgent("Worker");
    await setEarnWithApproval(world.wallet, agent.id, true, 10);
    const job = await post();
    await work.started(agent.id);
    work.release(agent.id);
    await pending.entered;
    expect((await promptly(world.wallet.setEarn(agent.id, false))).earn).toMatchObject({ enabled: false, state: "finishing" });
    expect((await view(agent.id)).earn.state).toBe("finishing");
    pending.release();
    await delivered(job.task);
    await off(agent.id);
  }, 60_000);

  it("disables two executing agents promptly and lets both deliver", async () => {
    const work = execution();
    world = await startWorld({ earn: work.earn });
    const a = await world.wallet.createAgent("Worker A");
    const b = await world.wallet.createAgent("Worker B");
    await setEarnWithApproval(world.wallet, a.id, true, 10);
    const first = await post("First job");
    await work.started(a.id);
    await setEarnWithApproval(world.wallet, b.id, true, 10);
    const second = await post("Second job");
    await work.started(b.id);
    for (const agent of [a, b]) {
      expect((await promptly(world.wallet.setEarn(agent.id, false))).earn).toMatchObject({ enabled: false, state: "finishing" });
    }
    expect((await world.wallet.overview()).agents.map((agent) => agent.earn.state)).toEqual(["finishing", "finishing"]);
    work.release(a.id);
    work.release(b.id);
    await delivered(first.task);
    await delivered(second.task);
    await off(a.id);
    await off(b.id);
  }, 60_000);

  it("re-enables during finishing and resumes taking jobs after delivery", async () => {
    const work = execution();
    world = await startWorld({ earn: work.earn });
    const agent = await world.wallet.createAgent("Worker");
    await world.wallet.fundAgent(agent.id, { usdCents: 1_000 });
    await setEarnWithApproval(world.wallet, agent.id, true, 10);
    const first = await post();
    await work.started(agent.id);
    expect((await promptly(world.wallet.setEarn(agent.id, false))).earn.state).toBe("finishing");
    expect((await promptly(world.wallet.setEarn(agent.id, true))).earn).toMatchObject({ enabled: true, state: "working" });
    work.release(agent.id);
    await delivered(first.task);
    const second = await post("Next job");
    // No housekeeping tick is needed to restart discovery after the old run drains.
    await delivered(second.task);
    expect((await view(agent.id)).earn.enabled).toBe(true);
  }, 60_000);

  it("returns the finishing reply and overview through the socket, then pushes an off overview", async () => {
    const work = execution();
    world = await startWorld({ earn: work.earn });
    const { wallet, dataDir } = world;
    const agent = await wallet.createAgent("Worker");
    await setEarnWithApproval(wallet, agent.id, true, 10);
    const job = await post();
    await work.started(agent.id);
    const socketPath = path.join(dataDir, "wallet.sock");
    const ownerToken = "finishing-test-owner-credential-32-chars";
    server = await serveWallet({ wallet, socketPath, ownerToken, agentExists: (id) => wallet.hasAgent(id) });
    const observed: Promise<string>[] = [];
    client = await connectWallet({ socketPath, token: ownerToken, onEvent: (event) => {
      if (event.type === "overview" && client !== null) {
        observed.push(client.call("overview", {}).then((overview) => overview.agents[0]!.earn.state));
      }
    } });
    expect((await promptly(client.call("earn.set", { agentId: agent.id, enabled: false }))).earn)
      .toMatchObject({ enabled: false, state: "finishing" });
    const finishing = await promptly(client.call("overview", {}));
    expect(finishing.capabilities).toEqual(["earn-finishing", "job-terms", "job-spend-quotes", "contests", "service-discovery-v1", "chosen-work", "delivery-review-v4"]);
    expect(finishing.agents[0]!.earn)
      .toMatchObject({ enabled: false, state: "finishing" });
    await eventually(async () => (await Promise.all(observed)).includes("finishing"));
    observed.length = 0;
    work.release(agent.id);
    await delivered(job.task);
    await eventually(async () => (await Promise.all(observed)).includes("off"));
    const finished = await client.call("overview", {});
    expect(finished.capabilities).toEqual(["earn-finishing", "job-terms", "job-spend-quotes", "contests", "service-discovery-v1", "chosen-work", "delivery-review-v4"]);
    expect(finished.agents[0]!.earn).toMatchObject({ enabled: false, state: "off" });
  }, 60_000);

  it("keeps retirement waiting for the running job", async () => {
    const work = execution();
    world = await startWorld({ earn: work.earn });
    const agent = await world.wallet.createAgent("Worker");
    await setEarnWithApproval(world.wallet, agent.id, true, 10);
    const job = await post();
    await work.started(agent.id);
    await promptly(world.wallet.setEarn(agent.id, false));
    let settled = false;
    const retirement = world.wallet.retireAgent(agent.id).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    await delay(200);
    expect(settled).toBe(false);
    work.release(agent.id);
    await delivered(job.task);
    // A delivered job still awaiting review prevents retirement.
    expect(await retirement).toMatchObject({ code: "NOT_ALLOWED" });
  }, 60_000);

  it("replies without waiting for a slow marketplace listing pause", async () => {
    const work = execution();
    const pause = gate();
    let holdPause = false;
    world = await startWorld({
      earn: work.earn,
      chain: (base) => ({
        ...base,
        clientFor(signer) {
          const original = base.clientFor(signer);
          return Object.create(original, {
            send: { value: async (...args: Parameters<typeof original.send>) => {
              if (holdPause) { holdPause = false; await pause.wait(); }
              return original.send(...args);
            } },
          }) as typeof original;
        },
      }),
    });
    const agent = await world.wallet.createAgent("Worker");
    await setEarnWithApproval(world.wallet, agent.id, true, 10);
    await setOfferWithApproval(world.wallet, agent.id, {
      name: "Line Writer", summary: "Write a friendly line.", price: { usdCents: 50 },
    });
    await eventually(async () => {
      await world!.wallet.tick();
      return (await view(agent.id)).earn.offer?.status === "live";
    });
    holdPause = true;
    expect((await promptly(world.wallet.setEarn(agent.id, false))).earn).toMatchObject({ enabled: false, state: "off" });
    await promptly(pause.entered);
    pause.release();
    await eventually(async () => (await view(agent.id)).earn.offer?.status === "paused");
  }, 60_000);

  it("does not begin a claim after disabling during the fresh funding check", async () => {
    const work = execution();
    const funding = gate();
    let holdFunding = false;
    let claims = 0;
    world = await startWorld({
      earn: { ...work.earn, checkExecutionReady: async () => { holdFunding = true; } },
      chain: (base) => ({
        ...base,
        getBalance: async (account) => {
          if (holdFunding) { holdFunding = false; await funding.wait(); }
          return base.getBalance(account);
        },
        clientFor(signer) {
          const original = base.clientFor(signer);
          return Object.create(original, {
            claimTaskWithJobSpec: { value: (...args: Parameters<typeof original.claimTaskWithJobSpec>) => {
              claims += 1;
              return original.claimTaskWithJobSpec(...args);
            } },
          }) as typeof original;
        },
      }),
    });
    const agent = await world.wallet.createAgent("Worker");
    await setEarnWithApproval(world.wallet, agent.id, true, 10);
    await post();
    await funding.entered;
    expect((await promptly(world.wallet.setEarn(agent.id, false))).earn).toMatchObject({ enabled: false, state: "off" });
    funding.release();
    await delay(300);
    expect(claims).toBe(0);
    expect(await world.wallet.listJobs({ role: "working" }, true)).toEqual([]);
  }, 60_000);
});
