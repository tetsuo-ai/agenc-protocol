// The job list a panel reads (jobs.list). A buying job that can still be
// turned down or cancelled says what the first turn-down or cancel of the
// money paying for it costs, as the job's own view does, and a list of many
// jobs asks the chain once per paying wallet. Against a stand-in chain that
// holds hand-built accounts.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findCreatorStatsPda,
  getCreatorStatsDiscriminatorBytes,
  getCreatorStatsSize,
} from "@tetsuo-ai/marketplace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { JobView } from "../src/client/types.js";
import type { Chain } from "../src/chain.js";
import { fixedPrice } from "../src/pricing.js";
import type { MarketServices } from "../src/services.js";
import { StateStore, type JobRecord } from "../src/store.js";
import { AgencWallet, type WalletConfig } from "../src/wallet.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** What the network asks to keep an account of `space` bytes. */
const rent = (space: number): bigint => BigInt(128 + space) * 6_960n;
/** A wallet's record of its turn-downs and cancels: 1,788,720 lamports on a live run. */
const RECORD_COST = rent(getCreatorStatsSize()).toString();

function job(id: string, patch: Partial<JobRecord>): JobRecord {
  return {
    id,
    role: "buying",
    kind: "hire",
    agentId: "",
    createdAt: NOW,
    updatedAt: NOW,
    idempotencyKey: null,
    listing: "7Z9CYgQ4ytmGHW9a8qr998CiS6DJn7wdeWcCNQFBAGid",
    providerAgent: "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
    title: "Haiku Writer",
    request: "A haiku.",
    acceptance: [],
    priceLamports: "2000000",
    expectedVersion: "1",
    listingSpecHashHex: "cd".repeat(32),
    payer: "main",
    taskIdHex: "00".repeat(32),
    task: "7Z9CYgQ4ytmGHW9a8qr998CiS6DJn7wdeWcCNQFBAGid",
    jobSpec: {},
    jobSpecHashHex: "ab".repeat(32),
    jobSpecUri: null,
    phase: "active",
    hireAttemptAt: null,
    hiredAt: NOW,
    chainStatus: "pending_validation",
    deadline: null,
    reviewDeadlineAt: NOW / 1000 + 86_400,
    autoRefundAt: null,
    outcome: null,
    changesRequested: false,
    result: null,
    rating: null,
    tidied: false,
    signatures: {},
    changes: [],
    error: null,
    ...patch,
  };
}

/** A request posted for anyone to take, from the balance. */
const request = (id: string, patch: Partial<JobRecord>): JobRecord =>
  job(id, { kind: "request", listing: "", title: "A haiku about rain", ...patch });

interface Opened {
  wallet: AgencWallet;
  clock: { now: number };
  /** The records of the balance and of the agent, which their first turn-down or cancel starts. */
  records: { main: Address; agent: Address };
  /** How often the wallet looked `record` up. */
  readsOf(record: Address): number;
  /** Every record the wallet looked up. */
  reads(): number;
  /** The record now exists, as after the first turn-down or cancel of that money. */
  start(record: Address): void;
  list(): Promise<JobView[]>;
}

const folders: string[] = [];
const wallets: AgencWallet[] = [];
afterEach(async () => {
  for (const wallet of wallets.splice(0)) await wallet.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A wallet with one agent, whose journal holds `jobs` (given the agent's id). */
async function walletWith(jobs: (agentId: string) => JobRecord[]): Promise<Opened> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agenc-wallet-jobs-"));
  folders.push(dataDir);
  const clock = { now: NOW };
  const accounts = new Map<string, { owner: Address; data: Uint8Array; executable: boolean }>();
  const looked: string[] = [];
  const chain = {
    network: "sandbox",
    transferFeeLamports: 5_000n,
    readAccountInfo: async (account: Address) => {
      looked.push(account);
      return accounts.get(account) ?? null;
    },
    getMinimumBalanceForRentExemption: async (space: number) => rent(space),
    getBalances: async (list: readonly Address[]) => list.map(() => 0n),
  } as unknown as Chain;
  const config: WalletConfig = {
    dataDir,
    unlockSecret: randomBytes(32),
    chain,
    services: {} as unknown as MarketServices,
    prices: fixedPrice(100),
    now: () => clock.now,
  };
  const first = await AgencWallet.open(config);
  const agent = await first.createAgent("Buyer");
  const main = first.mainAddress;
  await first.close();
  StateStore.open(path.join(dataDir, "state.json"), NOW).update((draft) => {
    for (const entry of jobs(agent.id)) draft.jobs[entry.id] = entry;
  });
  const wallet = await AgencWallet.open(config);
  wallets.push(wallet);
  const [mainRecord] = await findCreatorStatsPda({ authority: main });
  const [agentRecord] = await findCreatorStatsPda({ authority: agent.address as Address });
  const records = { main: mainRecord, agent: agentRecord };
  const ours = new Set<string>([mainRecord, agentRecord]);
  return {
    wallet,
    clock,
    records,
    readsOf: (record) => looked.filter((account) => account === record).length,
    reads: () => looked.filter((account) => ours.has(account)).length,
    start(record) {
      const data = new Uint8Array(getCreatorStatsSize());
      data.set(getCreatorStatsDiscriminatorBytes(), 0);
      accounts.set(record, { owner: AGENC_COORDINATION_PROGRAM_ADDRESS, data, executable: false });
    },
    list: () => wallet.listJobs({ role: "buying", limit: 50 }, true),
  };
}

/** Each job's first turn-down or cancel cost in lamports, or null when it names none. */
function costs(jobs: readonly JobView[]): Record<string, string | null> {
  return Object.fromEntries(jobs.map((entry) => [entry.id, entry.firstRecordCost?.lamports ?? null]));
}

/** Jobs that can still be turned down or cancelled: two paid by the agent's money, two by the balance. */
const open = (agentId: string): JobRecord[] => [
  job("job_delivered", { agentId, payer: "agent", createdAt: NOW - 1 }),
  job("job_starting", { agentId, payer: "agent", phase: "hired", chainStatus: null, createdAt: NOW - 2 }),
  request("job_request_delivered", { createdAt: NOW - 3 }),
  request("job_request_waiting", {
    chainStatus: "open",
    reviewDeadlineAt: null,
    autoRefundAt: NOW + 10 * MINUTE,
    createdAt: NOW - 4,
  }),
];

describe("the job list a panel reads", () => {
  it("names the cost of the first turn-down or cancel while the paying money has no record, read once per paying wallet", async () => {
    const opened = await walletWith(open);
    // The panel asks for its list twice at once on a refresh.
    const [listed, again] = await Promise.all([opened.list(), opened.list()]);
    const expected = {
      job_delivered: RECORD_COST,
      job_starting: RECORD_COST,
      job_request_delivered: RECORD_COST,
      job_request_waiting: RECORD_COST,
    };
    expect(costs(listed)).toEqual(expected);
    expect(costs(again)).toEqual(expected);
    expect(listed.find((entry) => entry.id === "job_delivered")).toMatchObject({
      status: "delivered",
      canRefund: true,
      firstRecordCost: { lamports: RECORD_COST },
    });
    expect(listed.find((entry) => entry.id === "job_request_waiting")?.status).toBe("waiting");
    expect(opened.readsOf(opened.records.agent)).toBe(1);
    expect(opened.readsOf(opened.records.main)).toBe(1);

    // Within the minute the answer is kept: the next refresh asks nothing.
    opened.clock.now += MINUTE - 1;
    expect(costs(await opened.list())).toEqual(expected);
    expect(opened.reads()).toBe(2);
  });

  it("names no cost once the paying money has its record, and stops asking for it", async () => {
    const opened = await walletWith(open);
    await opened.list();
    // The balance's first turn-down or cancel started its record.
    opened.start(opened.records.main);

    // A missing record is asked for again after a minute.
    opened.clock.now += MINUTE;
    expect(costs(await opened.list())).toEqual({
      job_delivered: RECORD_COST,
      job_starting: RECORD_COST,
      job_request_delivered: null,
      job_request_waiting: null,
    });
    expect(opened.readsOf(opened.records.main)).toBe(2);
    expect(opened.readsOf(opened.records.agent)).toBe(2);

    // A record is never removed: the balance's is not asked for again.
    opened.clock.now += MINUTE;
    await opened.list();
    expect(opened.readsOf(opened.records.main)).toBe(2);
    expect(opened.readsOf(opened.records.agent)).toBe(3);
  });

  it("names no cost for a job that can no longer be turned down or cancelled, and asks the chain nothing for it", async () => {
    const opened = await walletWith((agentId) => [
      job("job_paid", { agentId, payer: "agent", phase: "done", chainStatus: "completed", outcome: "paid" }),
      request("job_refunded", { phase: "done", chainStatus: "cancelled", outcome: "refunded" }),
      job("job_asking", { agentId, payer: null, phase: "needs_approval", chainStatus: null, hiredAt: null }),
      job("job_declined", { agentId, payer: null, phase: "declined", chainStatus: null, hiredAt: null }),
      job("job_failed", { agentId, payer: "agent", phase: "failed", chainStatus: null }),
    ]);
    const listed = await opened.list();
    expect(costs(listed)).toEqual({
      job_paid: null,
      job_refunded: null,
      job_asking: null,
      job_declined: null,
      job_failed: null,
    });
    expect(listed.map((entry) => entry.status).sort()).toEqual(
      ["declined", "failed", "needs_approval", "paid", "refunded"],
    );
    expect(opened.reads()).toBe(0);
  });
});
