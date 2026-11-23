import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { loadState, saveState } from "@tetsuo-ai/agenc-worker";
import type { Address } from "@solana/kit";
import { findClaimPda, findAgentPda, values } from "@tetsuo-ai/marketplace-sdk";
import { readListing } from "../src/market.js";
import { StateStore } from "../src/store.js";
import { CENT, eventually, setEarnWithApproval, setOfferWithApproval, startWorld, type World } from "../tests-e2e/harness.js";

let world: World | null = null;
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await world?.wallet.close();
  world = null;
});
function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { entered, release, wait: async () => { enter(); await released; } };
}
const EARN = {
  executor: { argv: [process.execPath, "-e", "process.stdout.write('done')", "{prompt}"], mode: "sandboxed" as const, envAllowlist: [], timeoutMs: 10000 },
  pollIntervalMs: 100,
  retryDelayMs: 1000,
};
async function post(title = "Review job") {
  return world!.sandbox.postOpenJob({ title, instructions: "Write one line.", rewardLamports: 50n * CENT });
}
async function view(id: string) {
  return (await world!.wallet.overview()).agents.find((agent) => agent.id === id)!;
}
async function delivered(task: string) {
  return eventually(async () => (await world!.wallet.listJobs({ role: "working" }, true)).find((job) => job.task === task && job.status === "delivered"));
}

it.each([false, true])("drains a failed saved upload while Off (reopen: %s), without new claims or a new model budget", async (reopen) => {
  const upload = gate();
  let uploads = 0;
  let restored = false;
  let claims = 0;
  world = await startWorld({ earn: EARN, services: (base) => ({
    ...base,
    resultUploader(signer) {
      const uploader = base.resultUploader(signer)!;
      return { ...uploader, fetch: async (...args) => {
        uploads += 1;
        if (uploads === 1) await upload.wait();
        if (!restored) throw new Error("temporary upload outage");
        return uploader.fetch(...args);
      } };
    },
  }), chain: (base) => ({ ...base, clientFor(signer) {
    const original = base.clientFor(signer);
    return Object.create(original, { claimTaskWithJobSpec: { value: async (...args: Parameters<typeof original.claimTaskWithJobSpec>) => {
      claims += 1;
      return original.claimTaskWithJobSpec(...args);
    } } }) as typeof original;
  } }) });
  const agent = await world.wallet.createAgent();
  await setEarnWithApproval(world.wallet, agent.id, true, 10);
  const job = await post();
  await upload.entered;
  expect((await world.wallet.setEarn(agent.id, false)).earn.state).toBe("finishing");
  upload.release();
  const stateDir = path.join(world.dataDir, "earn", agent.id);
  await eventually(async () => loadState(stateDir).openClaim?.failures === 1);
  expect(loadState(stateDir).openClaim).toMatchObject({ task: job.task, phase: "uploading", modelBudget: { totalCents: 50, remainingCents: 0 } });
  if (reopen) {
    await world.wallet.close();
    expect(loadState(stateDir).openClaim?.task).toBe(job.task);
    world.wallet = await world.reopen();
  }
  expect((await view(agent.id)).earn).toMatchObject({ enabled: false, state: "finishing" });
  const untouched = await post("Must not be claimed while Off");
  restored = true;
  await delivered(job.task);
  await eventually(async () => (await view(agent.id)).earn.state === "off");
  expect(uploads).toBeGreaterThan(1);
  expect(claims).toBe(1);
  const state = loadState(stateDir);
  expect(state.openClaim).toBeNull();
  expect(state.submissions.find((entry) => entry.task === job.task)?.modelBudget).toEqual({ totalCents: 50, remainingCents: 0 });
  expect(state.submissions.some((entry) => entry.task === untouched.task)).toBe(false);
}, 30000);

it.each(["expired", "ambiguous"] as const)("reconciles a persisted %s claim while Off after restart", async (kind) => {
  const upload = gate();
  let uploads = 0;
  world = await startWorld({ earn: EARN, services: (base) => ({ ...base, resultUploader(signer) {
    const uploader = base.resultUploader(signer)!;
    return { ...uploader, fetch: async () => { uploads += 1; await upload.wait(); throw new Error("offline"); } };
  } }) });
  const agent = await world.wallet.createAgent();
  await setEarnWithApproval(world.wallet, agent.id, true, 10);
  const job = await post();
  await upload.entered;
  await world.wallet.setEarn(agent.id, false);
  const closed = world.wallet.close();
  upload.release();
  await closed;
  const stateDir = path.join(world.dataDir, "earn", agent.id);
  const state = loadState(stateDir);
  const [bidder] = await findAgentPda({ agentId: values.hexToBytes(state.agentIdHex!) });
  const [claim] = await findClaimPda({ task: job.task, bidder });
  world.sandbox.advanceClock(8 * 86400);
  world.clock.now += 8 * 86400_000;
  world.wallet = await world.reopen();
  await eventually(async () => (await view(agent.id)).earn.state === "off");
  expect(loadState(stateDir).failedJobs.find((entry) => entry.task === job.task)).toMatchObject({ cause: "expired", claimReleased: true });
  expect(await world.sandbox.chain.readAccountInfo(claim)).toBeNull();
  expect(uploads).toBe(1);
  if (kind === "ambiguous") {
    await world.wallet.close();
    const unseen = await post("An unlanded claim");
    const saved = loadState(stateDir);
    saved.openClaim = { task: unseen.task, phase: "claiming", claimedAt: new Date(Date.now() - 10 * 60_000).toISOString(), modelBudget: { totalCents: 50, remainingCents: 50 } };
    saveState(stateDir, saved);
    world.wallet = await world.reopen();
    await eventually(async () => (await view(agent.id)).earn.state === "off");
    expect(loadState(stateDir).openClaim).toBeNull();
    expect(uploads).toBe(1);
  }
}, 30000);

it("keeps an in-flight claim visible and restarts one loop after repeated Off/On", async () => {
  const claim = gate();
  let claims = 0;
  world = await startWorld({ earn: EARN, chain: (base) => ({ ...base, clientFor(signer) {
    const original = base.clientFor(signer);
    return Object.create(original, { claimTaskWithJobSpec: { value: async (...args: Parameters<typeof original.claimTaskWithJobSpec>) => {
      claims += 1;
      if (claims === 1) await claim.wait();
      return original.claimTaskWithJobSpec(...args);
    } } }) as typeof original;
  } }) });
  const agent = await world.wallet.createAgent();
  await world.wallet.fundAgent(agent.id, { usdCents: 1000 });
  await setEarnWithApproval(world.wallet, agent.id, true, 10);
  const first = await post();
  await claim.entered;
  for (let i = 0; i < 3; i++) {
    expect((await world.wallet.setEarn(agent.id, false)).earn.state).toBe("finishing");
    await world.wallet.setEarn(agent.id, true);
  }
  claim.release();
  await delivered(first.task);
  const second = await post("Second job");
  await delivered(second.task);
  expect(claims).toBe(2);
  expect((await view(agent.id)).earn.enabled).toBe(true);
}, 30000);

it("serializes a slow background pause before On resumes the listing", async () => {
  const pause = gate();
  let hold = false;
  world = await startWorld({ earn: EARN, chain: (base) => ({ ...base, clientFor(signer) {
    const original = base.clientFor(signer);
    return Object.create(original, { send: { value: async (...args: Parameters<typeof original.send>) => {
      if (hold) { hold = false; await pause.wait(); }
      return original.send(...args);
    } } }) as typeof original;
  } }) });
  const agent = await world.wallet.createAgent();
  await setEarnWithApproval(world.wallet, agent.id, true, 10);
  await setOfferWithApproval(world.wallet, agent.id, { name: "Writer", summary: "Write a line.", price: { usdCents: 50 } });
  const offer = await eventually(async () => { await world!.wallet.tick(); const v = await view(agent.id); return v.earn.offer?.status === "live" ? v.earn.offer : null; });
  hold = true;
  await world.wallet.setEarn(agent.id, false);
  await pause.entered;
  const on = world.wallet.setEarn(agent.id, true);
  await delay(100);
  pause.release();
  await on;
  expect(await readListing(world.sandbox.chain, offer.listing as Address)).toMatchObject({ state: 0 });
  expect((await view(agent.id)).earn).toMatchObject({ enabled: true, offer: { status: "live" } });
}, 30000);

it("shutdown still waits for the upload/submission after an asynchronous Off reply", async () => {
  const upload = gate();
  world = await startWorld({ earn: EARN, services: (base) => ({ ...base, resultUploader(signer) {
    const uploader = base.resultUploader(signer)!;
    return { ...uploader, fetch: async (...args) => { await upload.wait(); return uploader.fetch(...args); } };
  } }) });
  const agent = await world.wallet.createAgent();
  await setEarnWithApproval(world.wallet, agent.id, true, 10);
  const job = await post();
  await upload.entered;
  await world.wallet.setEarn(agent.id, false);
  let closed = false;
  const close = world.wallet.close().then(() => { closed = true; });
  await delay(200);
  expect(closed).toBe(false);
  upload.release();
  await close;
  const state = loadState(path.join(world.dataDir, "earn", agent.id));
  expect(state.openClaim).toBeNull();
  expect(state.submissions.some((record) => record.task === job.task)).toBe(true);
}, 30000);

it("holds ownership through a slow pause, fences the closed instance, and reconciles the reopened listing", async () => {
  const pause = gate();
  let hold = false;
  world = await startWorld({ earn: EARN, chain: (base) => ({ ...base, clientFor(signer) {
    const original = base.clientFor(signer);
    return Object.create(original, { send: { value: async (...args: Parameters<typeof original.send>) => {
      if (hold) { hold = false; await pause.wait(); }
      return original.send(...args);
    } } }) as typeof original;
  } }) });
  const agent = await world.wallet.createAgent();
  await setEarnWithApproval(world.wallet, agent.id, true, 10);
  await setOfferWithApproval(world.wallet, agent.id, { name: "Writer", summary: "Write a line.", price: { usdCents: 50 } });
  const offer = await eventually(async () => { await world!.wallet.tick(); const v = await view(agent.id); return v.earn.offer?.status === "live" ? v.earn.offer : null; });
  hold = true;
  await world.wallet.setEarn(agent.id, false);
  await pause.entered;
  const old = world.wallet;
  let closed = false;
  const close = old.close().then(() => { closed = true; });
  const secondClose = old.close();
  // Longer than the former four-second timeout. Ownership cannot expire.
  await delay(4500);
  expect(closed).toBe(false);
  await expect(world.reopen()).rejects.toMatchObject({ code: "BUSY" });
  pause.release();
  await Promise.all([close, secondClose]);
  world.wallet = await world.reopen();
  await world.wallet.setEarn(agent.id, true);
  await expect(old.setEarn(agent.id, false)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  await old.tick();
  expect(await readListing(world.sandbox.chain, offer.listing as Address)).toMatchObject({ state: 0 });
  expect((await view(agent.id)).earn.enabled).toBe(true);
  const disk = StateStore.open(path.join(world.dataDir, "state.json")).state;
  expect(disk.agents[agent.id]!.earn.enabled).toBe(true);
}, 30000);

it("reconciles a reopened listing before starting discovery", async () => {
  const resume = gate();
  let hold = false;
  let unavailable = false;
  let claims = 0;
  world = await startWorld({ earn: EARN, chain: (base) => ({ ...base, clientFor(signer) {
    const original = base.clientFor(signer);
    return Object.create(original, {
      send: { value: async (...args: Parameters<typeof original.send>) => {
        if (hold) { hold = false; await resume.wait(); }
        if (unavailable) throw new Error("listing RPC outage");
        return original.send(...args);
      } },
      claimTaskWithJobSpec: { value: async (...args: Parameters<typeof original.claimTaskWithJobSpec>) => {
        claims += 1;
        return original.claimTaskWithJobSpec(...args);
      } },
    }) as typeof original;
  } }) });
  const agent = await world.wallet.createAgent();
  await setEarnWithApproval(world.wallet, agent.id, true, 10);
  await setOfferWithApproval(world.wallet, agent.id, { name: "Writer", summary: "Write a line.", price: { usdCents: 50 } });
  const offer = await eventually(async () => { await world!.wallet.tick(); const v = await view(agent.id); return v.earn.offer?.status === "live" ? v.earn.offer : null; });
  await world.wallet.close();
  expect(await readListing(world.sandbox.chain, offer.listing as Address)).toMatchObject({ state: 1 });
  const job = await post("Wait for reconciliation");
  hold = true;
  unavailable = true;
  world.wallet = await world.reopen();
  await resume.entered;
  await delay(250);
  expect(claims).toBe(0);
  resume.release();
  await eventually(async () => (await view(agent.id)).earn.lastError !== null);
  expect(claims).toBe(0);
  expect(await readListing(world.sandbox.chain, offer.listing as Address)).toMatchObject({ state: 1 });
  unavailable = false;
  await world.wallet.tick();
  await delivered(job.task);
  expect(await readListing(world.sandbox.chain, offer.listing as Address)).toMatchObject({ state: 0 });
  expect(claims).toBe(1);
}, 30000);

it("retries a saved submission while Off after restart without another upload", async () => {
  const submit = gate();
  let submits = 0;
  let uploads = 0;
  world = await startWorld({ earn: EARN, chain: (base) => ({ ...base, clientFor(signer) {
    const original = base.clientFor(signer);
    return Object.create(original, { submitTaskResult: { value: async (...args: Parameters<typeof original.submitTaskResult>) => {
      submits += 1;
      if (submits === 1) { await submit.wait(); throw new Error("submission transport outage"); }
      return original.submitTaskResult(...args);
    } } }) as typeof original;
  } }), services: (base) => ({ ...base, resultUploader(signer) {
    const uploader = base.resultUploader(signer)!;
    return { ...uploader, fetch: async (...args) => { uploads += 1; return uploader.fetch(...args); } };
  } }) });
  const agent = await world.wallet.createAgent();
  await setEarnWithApproval(world.wallet, agent.id, true, 10);
  const job = await post();
  await submit.entered;
  expect((await world.wallet.setEarn(agent.id, false)).earn.state).toBe("finishing");
  const closed = world.wallet.close();
  submit.release();
  await closed;
  const stateDir = path.join(world.dataDir, "earn", agent.id);
  const state = loadState(stateDir);
  expect(state.openClaim).toMatchObject({ task: job.task, phase: "submitting", modelBudget: { remainingCents: 0 } });
  // Restart after the ambiguity grace, preserving the exact submitted intent.
  state.openClaim!.submission!.lastBroadcastAt = new Date(Date.now() - 10 * 60_000).toISOString();
  saveState(stateDir, state);
  world.wallet = await world.reopen();
  await delivered(job.task);
  await eventually(async () => (await view(agent.id)).earn.state === "off");
  expect(submits).toBe(2);
  expect(uploads).toBe(1);
}, 30000);

it("keeps the consumed model reservation when a stopped execution drains across restart", async () => {
  world = await startWorld({ earn: EARN });
  const attempts = path.join(world.dataDir, "attempts.txt");
  const earn = { ...EARN, checkExecutionReady: async () => {}, executor: { ...EARN.executor,
    argv: [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1],process.argv[2]+'\\n');setInterval(()=>{},1000)", attempts, "{pay}", "{prompt}"],
  } };
  await world.wallet.close();
  world.wallet = await world.reopen({ earn });
  const agent = await world.wallet.createAgent();
  await setEarnWithApproval(world.wallet, agent.id, true, 10);
  const job = await post();
  await eventually(async () => existsSync(attempts) && readFileSync(attempts, "utf8") === "50\n");
  expect((await world.wallet.setEarn(agent.id, false)).earn.state).toBe("finishing");
  await world.wallet.close();
  const stateDir = path.join(world.dataDir, "earn", agent.id);
  expect(loadState(stateDir).openClaim?.modelBudget).toEqual({ totalCents: 50, remainingCents: 0 });
  world.wallet = await world.reopen({ earn });
  await eventually(async () => (await view(agent.id)).earn.state === "off");
  expect(loadState(stateDir).failedJobs.find((entry) => entry.task === job.task)).toMatchObject({ claimReleased: true, cause: "attempts" });
  expect(readFileSync(attempts, "utf8")).toBe("50\n");
}, 30000);
