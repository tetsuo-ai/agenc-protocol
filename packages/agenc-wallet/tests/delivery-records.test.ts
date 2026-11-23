import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAddressDecoder } from "@solana/kit";
import { emptyState, loadState, saveState } from "@tetsuo-ai/agenc-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectWallet } from "../src/client/socket-client.js";
import { serveWallet } from "../src/server.js";
import type { Chain } from "../src/chain.js";
import { EarnHost } from "../src/earn.js";
import type { JobOnChain } from "../src/market.js";
import { fixedPrice } from "../src/pricing.js";
import type { MarketServices } from "../src/services.js";
import { MAX_WORK_RECORD_CACHE_BYTES, StateStore, type JobRecord } from "../src/store.js";
import { AgencWallet, type WalletConfig } from "../src/wallet.js";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), tidy: vi.fn(async () => null) }));
vi.mock("../src/market.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/market.js")>(),
  inspectJob: mocks.inspect,
  sendTidy: mocks.tidy,
}));
const NOW = 1_800_000_000_000;
const HASH = "ab".repeat(32);
const TASK = "7Z9CYgQ4ytmGHW9a8qr998CiS6DJn7wdeWcCNQFBAGid";
const URI = `https://artifacts.example/artifacts/${HASH}`;
const folders: string[] = [];
const wallets: AgencWallet[] = [];

afterEach(async () => {
  for (const wallet of wallets.splice(0)) await wallet.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
  mocks.inspect.mockReset();
  mocks.tidy.mockClear();
});

function job(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_test", role: "buying", agentId: "", createdAt: NOW, updatedAt: NOW,
    idempotencyKey: null, listing: TASK, providerAgent: TASK, title: "A delivery",
    request: "Write a report.", acceptance: ["Include sources."], priceLamports: "2000000",
    expectedVersion: "1", listingSpecHashHex: HASH, payer: "main", taskIdHex: HASH,
    task: TASK, jobSpec: {}, jobSpecHashHex: HASH, jobSpecUri: null, phase: "active",
    hireAttemptAt: null, hiredAt: NOW, chainStatus: "pending_validation", deadline: null,
    reviewDeadlineAt: NOW / 1000 + 86400, autoRefundAt: null, outcome: null,
    changesRequested: false, result: null, rating: null, tidied: false, signatures: {},
    changes: [], error: null, providerRecorded: true, ...patch,
  };
}

function chainJob(status: JobOnChain["status"] = "pending_validation"): JobOnChain {
  return {
    status, deadline: 0, rewardLamports: 2000000n, workers: 1, completions: 1,
    activated: true, turnDown: null, closed: false,
    submission: { address: TASK as never, status: status === "completed" ? 2 : 1, proofHashHex: HASH,
      resultData: new TextEncoder().encode("artifact pointer"), reviewDeadlineAt: NOW / 1000 + 86400, submissionCount: 1 },
  };
}

async function fixture(entries: JobRecord[] = [job()]) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "delivery-records-"));
  folders.push(dataDir);
  const clock = { now: NOW };
  const fetchResult = vi.fn<MarketServices["fetchResult"]>(async () => ({ bytes: new TextEncoder().encode("Complete work."), uri: URI }));
  const chain = {
    network: "sandbox", transferFeeLamports: 5000n,
    getMinimumBalanceForRentExemption: async () => 0n,
    getBalances: async (list: unknown[]) => list.map(() => 0n),
    getBalance: async () => 0n,
    clientFor: () => ({}),
    readAccount: async () => null,
    readAccountInfo: async () => null,
    clusterTime: async () => clock.now / 1000,
  } as unknown as Chain;
  const log = vi.fn();
  const config: WalletConfig = {
    log,
    dataDir, chain, unlockSecret: randomBytes(32), now: () => clock.now,
    services: { fetchResult } as unknown as MarketServices, prices: fixedPrice(100),
  };
  let wallet = await AgencWallet.open(config);
  const agent = await wallet.createAgent("Seller");
  await wallet.close();
  StateStore.open(path.join(dataDir, "state.json"), NOW).update((draft) => {
    for (const entry of entries) draft.jobs[entry.id] = entry;
  });
  wallet = await AgencWallet.open(config);
  wallets.push(wallet);
  mocks.inspect.mockResolvedValue(chainJob());
  return { wallet, agent, clock, dataDir, config, chain, fetchResult, log,
    async reopen() {
      await wallet.close();
      wallet = await AgencWallet.open(config);
      wallets.push(wallet);
      return wallet;
    },
  };
}

function seedWork(dataDir: string, agentId: string, count = 1) {
  const state = emptyState();
  state.agentIdHex = "cd".repeat(32);
  for (let i = 0; i < count; i++) {
    state.submissions.push({
      task: i === 0 ? TASK : getAddressDecoder().decode(new Uint8Array(32).fill(i)),
      submissionSignature: `submitted-${i}`, resultUri: URI, resultHashHex: HASH,
      rewardAmount: "2000000", submittedAt: new Date(NOW + i * 1000).toISOString(), settled: false,
      title: "Report", jobEvidence: { request: "Write a report.", acceptance: ["Include sources."] },
    });
  }
  saveState(path.join(dataDir, "earn", agentId), state);
}

describe("delivery recovery", () => {
  it.each(["throw", "missing", "empty"])("retries a %s download and persists only the successful result", async (failure) => {
    const f = await fixture();
    if (failure === "throw") f.fetchResult.mockRejectedValueOnce(new Error("timeout"));
    if (failure === "missing") f.fetchResult.mockResolvedValueOnce(null);
    if (failure === "empty") f.fetchResult.mockResolvedValueOnce({ bytes: new Uint8Array(), uri: URI });
    expect((await f.wallet.getJob("job_test", true)).result).toBeNull();
    const reopened = await f.reopen();
    expect((await reopened.getJob("job_test", true)).result).toMatchObject({ text: "Complete work.", uri: URI, verified: true });
    expect(f.fetchResult).toHaveBeenCalledTimes(2);
    await reopened.getJob("job_test", true);
    expect(f.fetchResult).toHaveBeenCalledTimes(2);
  });

  it("repairs an empty result cached by an older build with the matching hash", async () => {
    const f = await fixture([job({ result: { hash: HASH, text: null, uri: null, verified: false, files: [] } })]);
    expect((await f.wallet.getJob("job_test", true)).result?.text).toBe("Complete work.");
  });

  it("fetches a first-seen paid job, retries after restart with its submission gone, and defers cleanup", async () => {
    const f = await fixture([job({ rating: 5 })]);
    mocks.inspect.mockResolvedValue(chainJob("completed"));
    f.fetchResult.mockResolvedValue(null);
    expect(await f.wallet.getJob("job_test", true)).toMatchObject({ status: "paid", result: null });
    expect(mocks.tidy).not.toHaveBeenCalled();
    const reopened = await f.reopen();
    mocks.inspect.mockResolvedValue({ ...chainJob("completed"), submission: null });
    f.fetchResult.mockResolvedValue({ bytes: new TextEncoder().encode("Recovered after payment."), uri: URI });
    expect((await reopened.getJob("job_test", true)).result?.text).toBe("Recovered after payment.");
    expect(mocks.tidy).toHaveBeenCalledTimes(1);
    expect((await reopened.listActivity()).filter((entry) => entry.kind === "paid")).toHaveLength(1);
  });

  it("recovers a first-seen auto-paid delivery from history after the submission account closed", async () => {
    const f = await fixture();
    mocks.inspect.mockResolvedValue({ ...chainJob("completed"), submission: null });
    f.chain.findSettledDelivery = vi.fn(async () => ({ worker: TASK as never, proofHashHex: HASH, resultData: new TextEncoder().encode(URI) }));
    expect(await f.wallet.getJob("job_test", true)).toMatchObject({ status: "paid", result: { text: "Complete work.", uri: URI, verified: true } });
    expect(f.chain.findSettledDelivery).toHaveBeenCalledWith(TASK, f.wallet.mainAddress);
  });

  it("serves full delivery text over the socket and keeps agent reads scoped", async () => {
    const f = await fixture();
    const text = "Complete report. ".repeat(3000);
    f.fetchResult.mockResolvedValue({ bytes: new TextEncoder().encode(text), uri: URI });
    const ownerToken = randomBytes(32).toString("hex");
    const socketPath = path.join(f.dataDir, "w.sock");
    const server = await serveWallet({ wallet: f.wallet, socketPath, ownerToken, agentExists: (id) => f.wallet.hasAgent(id) });
    const owner = await connectWallet({ socketPath, token: ownerToken });
    const agent = await connectWallet({ socketPath, token: ownerToken, actAs: f.agent.id });
    try {
      expect((await owner.call("jobs.delivery", { jobId: "job_test" })).result).toMatchObject({ text, textTruncated: false, uri: URI });
      await expect(agent.call("jobs.delivery", { jobId: "job_test" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      owner.close();
      agent.close();
      await server.close();
    }
  });

  it("repairs a legacy paid job and keeps text beyond 20,000 characters with the artifact link", async () => {
    const f = await fixture([job({ phase: "done", outcome: "paid", chainStatus: "completed", tidied: true })]);
    const text = `${"Long work. ".repeat(3000)}Final paragraph.`;
    f.fetchResult.mockResolvedValue({ bytes: new TextEncoder().encode(text), uri: URI });
    mocks.inspect.mockResolvedValue(chainJob("completed"));
    expect((await f.wallet.getJob("job_test", true)).result).toMatchObject({ text: text.slice(0, 20000), textTruncated: true, uri: URI });
    expect(await f.wallet.jobDelivery("job_test", true)).toMatchObject({ text, textTruncated: false, uri: URI });
    await expect(f.wallet.jobDelivery("job_test", false, "another-agent")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("seller records", () => {
  it("includes the request, criteria, complete text, files and artifact URI", async () => {
    const f = await fixture([]);
    seedWork(f.dataDir, f.agent.id);
    const bytes = Buffer.from("Full file.");
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    f.config.services.fetchFile = vi.fn(async () => bytes);
    const text = `The full report.\n\n---\nFiles with this delivery:\n1. report.txt (text/plain, ${bytes.length} bytes)\n   https://artifacts.example/artifacts/${fileHash}\n`;
    f.fetchResult.mockResolvedValue({ bytes: new TextEncoder().encode(text), uri: URI });
    const record = await f.wallet.getJob(`earn_${f.agent.id}_${TASK}`, true);
    expect(record).toMatchObject({ request: "Write a report.", acceptance: ["Include sources."], result: { text: "The full report.", uri: URI, verified: true } });
    expect(record.result?.files).toHaveLength(1);
    expect(await f.wallet.jobFile(record.id, fileHash)).toMatchObject({ base64: bytes.toString("base64"), sha256: fileHash });
    const reopened = await f.reopen();
    f.fetchResult.mockRejectedValue(new Error("offline"));
    expect((await reopened.getJob(record.id, true)).result).toEqual(record.result);
  });

  it("finds an old seller job outside the first 50, pages through it, and enforces agent scope", async () => {
    const f = await fixture([]);
    seedWork(f.dataDir, f.agent.id, 61);
    const first = await f.wallet.listJobs({ role: "working" }, true);
    expect(first).toHaveLength(50);
    expect(first.some((job) => job.task === TASK)).toBe(false);
    const oldId = `earn_${f.agent.id}_${TASK}`;
    expect((await f.wallet.getJob(oldId, true)).task).toBe(TASK);
    await expect(f.wallet.getJob(oldId, false, "another-agent")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.wallet.getJob(`earn_../../outside_${TASK}`, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const last = await f.wallet.listJobs({ role: "working", before: first.at(-1)!.id }, true);
    expect(last).toHaveLength(11);
    expect(last.at(-1)?.id).toBe(oldId);
    expect(new Set([...first, ...last].map((job) => job.id)).size).toBe(61);
  });

  it("pages buying jobs with tied timestamps without losing the old unresolved record", async () => {
    const f = await fixture(Array.from({ length: 61 }, (_, index) => job({ id: `job_${String(index).padStart(3, "0")}` })));
    const first = await f.wallet.listJobs({ role: "buying" }, true);
    const last = await f.wallet.listJobs({ role: "buying", before: first.at(-1)!.id }, true);
    expect(first).toHaveLength(50);
    expect(last).toHaveLength(11);
    expect(new Set([...first, ...last].map((job) => job.id)).size).toBe(61);
    expect((await f.wallet.getJob("job_060", true)).id).toBe("job_060");
  });

  it("persists a rejection timestamp for catch-up notifications without changing it on every restart", async () => {
    const f = await fixture([]);
    seedWork(f.dataDir, f.agent.id);
    vi.spyOn(EarnHost.prototype, "tidyUp").mockResolvedValue();
    f.clock.now += 100000;
    mocks.inspect.mockResolvedValue({ ...chainJob("reject_frozen"), turnDown: {
      disputable: true, disputeUntil: NOW / 1000 + 86400, bondLamports: 10000000n,
      rulingUntil: null, disputeOpen: true, providerSuspended: false, expiryDue: null,
    } });
    await f.wallet.tick();
    const id = `earn_${f.agent.id}_${TASK}`;
    expect(await f.wallet.getJob(id, true)).toMatchObject({ status: "in_review", updatedAt: f.clock.now });
    const changedAt = f.clock.now;
    const reopened = await f.reopen();
    f.clock.now += 5000;
    await reopened.tick();
    expect(await reopened.getJob(id, true)).toMatchObject({ status: "in_review", updatedAt: changedAt });
  });

  it.each(["accepted", "closed"] as const)("replays a %s settlement and never counts it twice across restarts", async (outcome) => {
    const f = await fixture([]);
    seedWork(f.dataDir, f.agent.id);
    const stateDir = path.join(f.dataDir, "earn", f.agent.id);
    const state = loadState(stateDir);
    Object.assign(state.submissions[0]!, {
      settled: true, outcome, earnedLamports: "1900000",
      settledAt: new Date(NOW).toISOString(), settlementSignature: null,
      settlementEventPending: true,
    });
    saveState(stateDir, state);
    await f.wallet.tick();
    expect(f.log.mock.calls).toEqual([]);
    expect((await f.wallet.overview()).agents[0]).toMatchObject({ earned: { lamports: "1900000" }, earn: { jobsDone: 1 } });
    expect(loadState(stateDir).submissions[0]?.settlementEventPending).toBe(false);
    // Simulate death after the wallet committed, before the worker acknowledged.
    const replay = loadState(stateDir);
    replay.submissions[0]!.settlementEventPending = true;
    saveState(stateDir, replay);
    const reopened = await f.reopen();
    await reopened.tick();
    expect((await reopened.overview()).agents[0]).toMatchObject({ earned: { lamports: "1900000" }, earn: { jobsDone: 1 } });
    expect((await reopened.listActivity()).filter((entry) => entry.kind === "earned")).toHaveLength(1);
    expect(loadState(stateDir).submissions[0]?.settlementEventPending).toBe(false);
  });

  it("runs upkeep for paused earning without restarting work", async () => {
    const f = await fixture([]);
    seedWork(f.dataDir, f.agent.id);
    const upkeep = vi.spyOn(EarnHost.prototype, "tidyUp").mockResolvedValue();
    const start = vi.spyOn(EarnHost.prototype, "start");
    await f.wallet.tick();
    expect(upkeep).toHaveBeenCalledWith(expect.objectContaining({ agentId: f.agent.id }));
    expect(start).not.toHaveBeenCalled();
  });
});

describe("bounded evidence and offline upgrades", () => {
  it.each([50, 200])("serves %s large escaped multi-byte seller previews over the socket", async (count) => {
    const f = await fixture([]);
    seedWork(f.dataDir, f.agent.id, count);
    const stateDir = path.join(f.dataDir, "earn", f.agent.id);
    const state = loadState(stateDir);
    const large = 'é雪😀"\\\n'.repeat(3000);
    for (const record of state.submissions) record.jobEvidence = { request: large, acceptance: [large] };
    saveState(stateDir, state);
    f.fetchResult.mockResolvedValue({ bytes: Buffer.from(large), uri: URI });
    const token = "a".repeat(40);
    const socketPath = path.join(f.dataDir, "s.sock");
    const server = await serveWallet({ wallet: f.wallet, socketPath, ownerToken: token, agentExists: () => true });
    const owner = await connectWallet({ socketPath, token });
    try {
      const response = await owner.call("jobs.list", { role: "working", limit: count });
      expect(response.jobs).toHaveLength(count);
      expect(Buffer.byteLength(JSON.stringify({ id: 1, result: response }))).toBeLessThan(1024 * 1024);
      for (const row of response.jobs) {
        expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThanOrEqual(4096);
        expect(row.previewTruncated).toBe(true);
        expect(row.result?.textTruncated).toBe(true);
      }
      const id = response.jobs[0]!.id;
      expect((await owner.call("jobs.get", { jobId: id })).job).toMatchObject({ request: large, acceptance: [large] });
      expect((await owner.call("jobs.delivery", { jobId: id })).result).toMatchObject({ text: large, textTruncated: false });
      expect(statSync(path.join(f.dataDir, "state.json")).size).toBeLessThan(8 * 1024 * 1024);
      const reopened = await f.reopen();
      expect((await reopened.getJob(id, true)).request).toBe(large);
    } finally {
      owner.close();
      await server.close();
    }
  }, 30_000);

  it("bounds wallet work caches by bytes and count while retaining pending review metadata", async () => {
    const f = await fixture([]);
    const file = path.join(f.dataDir, "state.json");
    await f.wallet.close();
    const store = StateStore.open(file, NOW);
    store.update((draft) => {
      draft.workRecords = {};
      for (let i = 0; i < 600; i++) {
        draft.workRecords[`earn_${i}`] = { request: "é".repeat(30000), acceptance: ["x".repeat(10000)], updatedAt: i };
      }
      draft.workRecords.pending = { request: "x".repeat(60000), reviewDeadlineAt: NOW + 3600000, updatedAt: -1 };
    });
    const reopened = StateStore.open(file, NOW);
    expect(Buffer.byteLength(JSON.stringify(reopened.state.workRecords))).toBeLessThanOrEqual(MAX_WORK_RECORD_CACHE_BYTES);
    expect(reopened.state.workRecords?.pending).toEqual({ reviewDeadlineAt: NOW + 3600000, updatedAt: -1 });
    reopened.update((draft) => {
      for (let i = 0; i < 1500; i++) (draft.workRecords ??= {})[`tiny_${i}`] = { request: "tiny", updatedAt: i };
    });
    expect(Object.keys(StateStore.open(file, NOW).state.workRecords!)).toHaveLength(1000);
  });

  it.each([false, true])("authenticates the final offline revision and persists it (download delayed: %s)", async (delayed) => {
    const old = { text: "First revision", uri: URI, hash: HASH, verified: true, files: [] };
    const f = await fixture([job({ result: old, deliveryPointer: { hash: HASH, dataBase64: Buffer.from(URI).toString("base64") }, changesRequested: true })]);
    mocks.inspect.mockResolvedValue({ ...chainJob("completed"), submission: null });
    const finalHash = "cd".repeat(32);
    const finalUri = "https://artifacts.example/final";
    f.chain.findSettledDelivery = vi.fn(async () => ({ worker: TASK as never, proofHashHex: finalHash, resultData: Buffer.from(finalUri) }));
    f.fetchResult.mockResolvedValue(delayed ? null : { bytes: Buffer.from("Final revision"), uri: finalUri });
    const paid = await f.wallet.getJob("job_test", true);
    expect(paid.status).toBe("paid");
    expect(paid.result?.text ?? null).toBe(delayed ? null : "Final revision");
    expect(f.chain.findSettledDelivery).toHaveBeenCalledOnce();
    const reopened = await f.reopen();
    f.fetchResult.mockResolvedValue({ bytes: Buffer.from("Final revision"), uri: finalUri });
    expect(await reopened.getJob("job_test", true)).toMatchObject({ status: "paid", result: { text: "Final revision", hash: finalHash } });
    expect(f.chain.findSettledDelivery).toHaveBeenCalledOnce();
    expect(StateStore.open(path.join(f.dataDir, "state.json"), NOW).state.jobs.job_test?.finalDeliveryChecked).toBe(true);
  });

  it.each(["active", "done"] as const)("retries an unavailable final commitment for a %s job without exposing its earlier revision", async (phase) => {
    const f = await fixture([job({ phase, ...(phase === "done" ? { outcome: "paid" as const, tidied: true } : {}), result: { text: "Old", uri: URI, hash: HASH, verified: true, files: [] }, deliveryPointer: { hash: HASH, dataBase64: Buffer.from(URI).toString("base64") } })]);
    mocks.inspect.mockResolvedValue({ ...chainJob("completed"), submission: null });
    f.chain.findSettledDelivery = vi.fn(async () => null);
    expect((await f.wallet.getJob("job_test", true)).result).toBeNull();
    await expect(f.wallet.jobDelivery("job_test", true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const reopened = await f.reopen();
    f.chain.findSettledDelivery = vi.fn(async () => ({ worker: TASK as never, proofHashHex: "cd".repeat(32), resultData: Buffer.from(URI) }));
    expect((await reopened.getJob("job_test", true)).result?.text).toBe("Complete work.");
  });

  it.each([undefined, 5 * 60_000, 2 * 3600_000])("reconciles a reopened legacy refund time (configured timeout: %s)", async (timeout) => {
    const stale = timeout === undefined ? NOW - 1000 : NOW + 5 * 60_000;
    const f = await fixture([job({ chainStatus: "open", autoRefundAt: stale })]);
    if (timeout !== undefined) f.config.autoRefundAfterMs = timeout;
    const reopened = await f.reopen();
    mocks.inspect.mockResolvedValue({ ...chainJob("open"), workers: 0, completions: 0, submission: null, deadline: NOW / 1000 + 3600 });
    const expected = NOW + Math.min(timeout ?? 3600000, 3600000);
    expect(await reopened.getJob("job_test", true)).toMatchObject({ status: "waiting", autoRefundAt: expected });
    expect(StateStore.open(path.join(f.dataDir, "state.json"), NOW).state.jobs.job_test?.autoRefundAt).toBe(expected);
    expect((await (await f.reopen()).getJob("job_test", true)).autoRefundAt).toBe(expected);
  });
});

it("bounds every variable buyer preview field without changing exact job evidence", async () => {
  const large = '雪😀\u0001"\\'.repeat(500);
  const result = { text: large, uri: `https://artifacts.example/${"x".repeat(5000)}`, hash: HASH, verified: true, files: Array.from({ length: 8 }, () => ({ name: "x".repeat(64), type: "application/octet-stream", bytes: 1, sha256: HASH })) };
  const f = await fixture(Array.from({ length: 200 }, (_, i) => job({ id: `job_${i}`, phase: "failed", title: large, request: large, acceptance: Array.from({ length: 4 }, () => large), error: large, result })));
  const token = "a".repeat(40);
  const socketPath = path.join(f.dataDir, "s.sock");
  const server = await serveWallet({ wallet: f.wallet, socketPath, ownerToken: token, agentExists: () => true });
  const owner = await connectWallet({ socketPath, token });
  try {
    const { jobs } = await owner.call("jobs.list", { role: "buying", limit: 200 });
    expect(jobs).toHaveLength(200);
    expect(Buffer.byteLength(JSON.stringify({ id: 1, result: { jobs } }))).toBeLessThan(1024 * 1024);
    expect(jobs.every((row) => Buffer.byteLength(JSON.stringify(row)) <= 4096 && row.previewTruncated)).toBe(true);
    expect(jobs[0]?.result?.uri).toBeNull();
    expect(jobs[0]?.result?.files.length).toBeLessThan(8);
    expect((await f.wallet.getJob(jobs[0]!.id, true)).acceptance).toEqual(Array.from({ length: 4 }, () => large));
  } finally {
    owner.close();
    await server.close();
  }
}, 30_000);
