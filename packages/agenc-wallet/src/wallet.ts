// The wallet: one main balance, one small wallet per agent, and a journal of
// every job. It accepts plain requests ("hire this", "approve that"), decides
// whether the agent's own allowance covers them or a person must say yes,
// and then builds, signs and follows the marketplace transactions itself.
//
// An agent can never name a destination, an amount to send, or a transaction.
// The worst a compromised agent can do is spend the allowance in its own
// wallet on marketplace jobs, each of which is escrowed and refundable.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { address, type Address, type KeyPairSigner } from "@solana/kit";
import { AgencError, taskThread, values } from "@tetsuo-ai/marketplace-sdk";
import { transferInstruction, type Chain } from "./chain.js";
import { formatMoney } from "./client/format.js";
import type { AmountInput, WalletEvent } from "./client/protocol.js";
import type {
  ActivityKind,
  ActivityView,
  AgentPolicy,
  AgentView,
  ApprovalView,
  JobStatus,
  JobView,
  Money,
  ServiceView,
  WalletOverview,
} from "./client/types.js";
import { EarnHost, type EarnNotice, type EarnOptions } from "./earn.js";
import { describeError, WalletError } from "./errors.js";
import {
  alreadyRated,
  DEFAULT_REVIEW_WINDOW_SECS,
  findListingGate,
  findTaskGate,
  hireLanded,
  inspectJob,
  isActivated,
  purchaseDeposits,
  ratingCost,
  readHireableListing,
  sendActivation,
  sendApproval,
  sendCancel,
  sendChangesRequest,
  sendHire,
  sendRating,
  sendReject,
  sendTidy,
  TASK_ACCOUNT_SPACE,
  taskAddressFor,
  type ListingTerms,
} from "./market.js";
import { centsToLamports, lamportsToCents, type PriceSource } from "./pricing.js";
import {
  buildJobSpec,
  jobSpecHash,
  tidyText,
  type CatalogRow,
  type MarketServices,
} from "./services.js";
import {
  acquireServiceLock,
  StateStore,
  type AgentRecord,
  type JobRecord,
  type WalletState,
} from "./store.js";
import { KeyVault } from "./vault.js";
import { activityView, approvalView, jobStatus, jobView, money } from "./views.js";

const MAIN_KEY = "main";
/** Base fees of the four transactions of a plain job (hire, post, pay, tidy). */
const JOB_TRANSACTION_FEES_LAMPORTS = 20_000n;
/** A hire that may have been sent is given this long to show up on-chain. */
const HIRE_RECONCILE_GRACE_MS = 150_000;
/** A hired job that cannot be posted is refunded after this long. */
const POSTING_GIVE_UP_MS = 30 * 60_000;
/** A provider who started is given this long past the deadline to deliver. */
const NO_SHOW_GRACE_SECS = 120;
const MAX_RESULT_TEXT = 20_000;
const BALANCE_CACHE_MS = 4_000;
const STALE_PRICE_MS = 6 * 60 * 60_000;

export interface WalletConfig {
  /** Absolute folder for the vault, the journal and the earn ledgers. */
  dataDir: string;
  /** Unlocks the vault. Held by the host (an OS keychain), never stored here. */
  unlockSecret: Uint8Array;
  chain: Chain;
  services: MarketServices;
  prices: PriceSource;
  earn?: EarnOptions;
  now?: () => number;
  /** Diagnostic sink. Lines may contain addresses; never show them in a panel. */
  log?: (line: string) => void;
  /** A posted job nobody starts is refunded after this long. Default 10 minutes. */
  autoRefundAfterMs?: number;
  /** An approval nobody answers lapses after this long. Default 30 minutes. */
  approvalTtlMs?: number;
  /** How long a buyer has to review before a delivery pays itself. Default 24 hours. */
  reviewWindowSecs?: bigint;
  /** How long a paid job stays open for a rating before it is tidied. Default 1 hour. */
  rateWindowMs?: number;
}

interface BalanceSnapshot {
  at: number;
  values: Map<string, bigint>;
  offline: boolean;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

function clampName(value: string): string {
  const name = tidyText(value, 40);
  if (name === null) throw new WalletError("BAD_REQUEST", "Give the agent a name.");
  return name;
}

function assertPolicy(policy: AgentPolicy): AgentPolicy {
  const cents = (value: unknown, label: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000_000) {
      throw new WalletError("BAD_REQUEST", `${label} must be a dollar amount of zero or more.`);
    }
    return Math.round(value);
  };
  if (typeof policy !== "object" || policy === null || typeof policy.refill !== "object") {
    throw new WalletError("BAD_REQUEST", "Those settings are not valid.");
  }
  return {
    askAboveCents: cents(policy.askAboveCents, "The approval limit"),
    refill: {
      enabled: policy.refill.enabled === true,
      topUpToCents: cents(policy.refill.topUpToCents, "The top-up amount"),
      perDayCents: cents(policy.refill.perDayCents, "The daily top-up limit"),
    },
  };
}

function toAddress(value: string, what: string): Address {
  try {
    return address(value);
  } catch {
    throw new WalletError("BAD_REQUEST", `That ${what} is not valid.`);
  }
}

/** True when a send certainly did not move money. */
function sendDefinitelyFailed(error: unknown): boolean {
  return error instanceof AgencError && (error.signature === null || error.code !== null);
}

function hireFailureText(error: unknown): { code: "PRICE_CHANGED" | "NOT_ENOUGH_MONEY" | "NOT_AVAILABLE"; message: string } {
  const name = error instanceof AgencError ? (error.errorName ?? "") : "";
  const text = error instanceof Error ? error.message : String(error);
  if (/Price|Version|ListingChanged|Mismatch/i.test(name)) {
    return {
      code: "PRICE_CHANGED",
      message: "The service changed its terms while the order was being placed. Nothing was spent.",
    };
  }
  if (/insufficient (funds|lamports)|InsufficientFunds/i.test(`${name} ${text}`)) {
    return {
      code: "NOT_ENOUGH_MONEY",
      message: "There was not enough money to place the order. Nothing was spent.",
    };
  }
  return {
    code: "NOT_AVAILABLE",
    message: "The marketplace did not accept the order. Nothing was spent.",
  };
}

export class AgencWallet {
  readonly #config: WalletConfig;
  readonly #chain: Chain;
  readonly #services: MarketServices;
  readonly #vault: KeyVault;
  readonly #store: StateStore;
  readonly #earn: EarnHost;
  readonly #releaseLock: () => void;
  readonly #listeners = new Set<(event: WalletEvent) => void>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  #balances: BalanceSnapshot | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking: Promise<void> | null = null;
  #closed = false;

  private constructor(
    config: WalletConfig,
    vault: KeyVault,
    store: StateStore,
    releaseLock: () => void,
  ) {
    this.#config = config;
    this.#chain = config.chain;
    this.#services = config.services;
    this.#vault = vault;
    this.#store = store;
    this.#releaseLock = releaseLock;
    this.#now = config.now ?? Date.now;
    this.#log = config.log ?? (() => {});
    this.#earn = new EarnHost({
      chain: config.chain,
      services: config.services,
      options: config.earn ?? { executor: null },
      dataDir: path.join(config.dataDir, "earn"),
      log: this.#log,
      notify: (agentId, notice) => this.#onEarnNotice(agentId, notice),
    });
  }

  /** Open (or create) the wallet in `config.dataDir`. */
  static async open(config: WalletConfig): Promise<AgencWallet> {
    if (!path.isAbsolute(config.dataDir)) {
      throw new WalletError("INTERNAL", "The wallet needs an absolute folder to keep its files in.");
    }
    const vault = KeyVault.open({
      file: path.join(config.dataDir, "vault.json"),
      secret: config.unlockSecret,
    });
    const releaseLock = acquireServiceLock(config.dataDir);
    try {
      if (!vault.has(MAIN_KEY)) await vault.create(MAIN_KEY);
      const store = StateStore.open(path.join(config.dataDir, "state.json"), (config.now ?? Date.now)());
      const wallet = new AgencWallet(config, vault, store, releaseLock);
      for (const agent of Object.values(store.state.agents)) {
        if (agent.earn.enabled) void wallet.#startEarning(agent);
      }
      return wallet;
    } catch (error) {
      releaseLock();
      throw error;
    }
  }

  /** The address money is sent to in order to add it to the main balance. */
  get mainAddress(): Address {
    return this.#vault.address(MAIN_KEY);
  }

  /** Whether an agent with this id exists. */
  hasAgent(agentId: string): boolean {
    return Object.hasOwn(this.#store.state.agents, agentId);
  }

  /** Subscribe to change notifications. Returns the unsubscribe function. */
  on(listener: (event: WalletEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: WalletEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** Run `work` alone for `key`; later callers queue behind it. */
  #lock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(key, settled);
    void settled.then(() => {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    });
    return run;
  }

  // ------------------------------------------------------------- prices

  /** A fresh dollars-per-SOL, or null. Remembers the last good value. */
  async #freshRate(): Promise<number | null> {
    const value = await this.#config.prices.solUsd();
    if (value !== null) {
      const previous = this.#store.state.lastSolUsd;
      if (previous === null || Math.abs(previous.value - value) / value > 0.002) {
        this.#store.update((draft) => {
          draft.lastSolUsd = { value, ts: this.#now() };
        });
      }
    }
    return value;
  }

  /** The rate used for DISPLAY: fresh when possible, else recent, else null. */
  async #displayRate(): Promise<number | null> {
    const fresh = await this.#freshRate().catch(() => null);
    if (fresh !== null) return fresh;
    const last = this.#store.state.lastSolUsd;
    return last !== null && this.#now() - last.ts < STALE_PRICE_MS ? last.value : null;
  }

  async #toLamports(amount: AmountInput): Promise<bigint> {
    if ("lamports" in amount) {
      if (!/^(?:0|[1-9][0-9]{0,18})$/.test(amount.lamports)) {
        throw new WalletError("BAD_REQUEST", "That amount is not valid.");
      }
      return BigInt(amount.lamports);
    }
    if (typeof amount.usdCents !== "number" || !Number.isFinite(amount.usdCents) || amount.usdCents <= 0) {
      throw new WalletError("BAD_REQUEST", "That amount is not valid.");
    }
    const rate = await this.#freshRate();
    if (rate === null) {
      throw new WalletError(
        "NETWORK",
        "Dollar prices are not available right now. Try again in a moment.",
      );
    }
    return centsToLamports(amount.usdCents, rate);
  }

  // ----------------------------------------------------------- balances

  #walletIds(): { id: string; address: Address }[] {
    return [
      { id: MAIN_KEY, address: this.mainAddress },
      ...Object.values(this.#store.state.agents).map((agent) => ({
        id: agent.id,
        address: agent.address as Address,
      })),
    ];
  }

  async #readBalances(force = false): Promise<BalanceSnapshot> {
    if (!force && this.#balances !== null && this.#now() - this.#balances.at < BALANCE_CACHE_MS) {
      return this.#balances;
    }
    const wallets = this.#walletIds();
    try {
      const amounts = await Promise.all(
        wallets.map((wallet) => this.#chain.getBalance(wallet.address)),
      );
      const values = new Map<string, bigint>();
      wallets.forEach((wallet, index) => values.set(wallet.id, amounts[index]!));
      this.#balances = { at: this.#now(), values, offline: false };
    } catch (error) {
      this.#log(`balances unavailable: ${describeError(error)}`);
      const values = this.#balances?.values ?? new Map<string, bigint>();
      const last = this.#store.state.lastMainLamports;
      if (!values.has(MAIN_KEY) && last !== null) values.set(MAIN_KEY, BigInt(last));
      this.#balances = { at: this.#now(), values, offline: true };
    }
    return this.#balances;
  }

  #dropBalances(): void {
    this.#balances = null;
  }

  /** The smallest balance a wallet may hold without the network closing it. */
  #floor(): Promise<bigint> {
    return this.#chain.getMinimumBalanceForRentExemption(0);
  }

  // ---------------------------------------------------------- activity

  #note(
    draft: WalletState,
    entry: {
      kind: ActivityKind;
      text: string;
      lamports?: bigint | null;
      agentId?: string | null;
      jobId?: string | null;
      signature?: string | null;
    },
  ): void {
    draft.activity.push({
      id: newId("act"),
      ts: this.#now(),
      kind: entry.kind,
      text: entry.text,
      lamports: entry.lamports == null ? null : entry.lamports.toString(),
      agentId: entry.agentId ?? null,
      jobId: entry.jobId ?? null,
      signature: entry.signature ?? null,
    });
  }

  // -------------------------------------------------------------- views

  #agentRecord(agentId: string): AgentRecord {
    const agent = this.#store.state.agents[agentId];
    if (agent === undefined) throw new WalletError("NOT_FOUND", "That agent does not exist.");
    return agent;
  }

  #jobRecord(jobId: string): JobRecord {
    const job = this.#store.state.jobs[jobId];
    if (job === undefined) throw new WalletError("NOT_FOUND", "That job does not exist.");
    return job;
  }

  #heldBy(agentId: string | null): bigint {
    let held = 0n;
    for (const job of Object.values(this.#store.state.jobs)) {
      if (job.role !== "buying") continue;
      if (agentId !== null && job.agentId !== agentId) continue;
      const inEscrow =
        (job.phase === "hired" || job.phase === "active") && job.outcome === null;
      if (inEscrow) held += BigInt(job.priceLamports);
    }
    return held;
  }

  #agentView(
    agent: AgentRecord,
    balance: bigint,
    rate: number | null,
    setAside: bigint,
  ): AgentView {
    const earn = this.#earn.state(agent.id);
    return {
      id: agent.id,
      name: agent.name,
      address: agent.address,
      balance: money(balance, rate),
      held: money(this.#heldBy(agent.id), rate),
      spent: money(agent.spentLamports, rate),
      earned: money(agent.earnedLamports, rate),
      policy: agent.policy,
      earn: {
        enabled: agent.earn.enabled,
        state: agent.earn.enabled ? earn.state : "off",
        lastError: earn.lastError ?? agent.earn.lastError,
        jobsDone: agent.earn.jobsDone,
        minPayCents: agent.earn.minPayCents,
        setAside: money(setAside, rate),
      },
      createdAt: agent.createdAt,
    };
  }

  async #oneAgentView(agentId: string): Promise<AgentView> {
    const [balances, rate] = await Promise.all([this.#readBalances(true), this.#displayRate()]);
    const agent = this.#agentRecord(agentId);
    return this.#agentView(
      agent,
      balances.values.get(agentId) ?? 0n,
      rate,
      await this.#setAside(agent),
    );
  }

  /** The agent's marketplace deposit; only read for agents that ever earned. */
  async #setAside(agent: AgentRecord): Promise<bigint> {
    if (!agent.earn.enabled && agent.earn.jobsDone === 0) return 0n;
    return this.#earn.setAside(agent.id).catch(() => 0n);
  }

  #ratingCostLamports: bigint | null = null;

  /** What a rating costs, read once and remembered. */
  async #ratingCost(): Promise<bigint | null> {
    if (this.#ratingCostLamports === null) {
      this.#ratingCostLamports = await ratingCost(this.#chain).catch(() => null);
    }
    return this.#ratingCostLamports;
  }

  async #jobView(job: JobRecord, isOwner: boolean): Promise<JobView> {
    return jobView(job, {
      usdPerSol: await this.#displayRate(),
      now: this.#now(),
      network: this.#chain.network,
      isOwner,
      ratingCostLamports: await this.#ratingCost(),
    });
  }

  async overview(): Promise<WalletOverview> {
    const [balances, rate] = await Promise.all([this.#readBalances(), this.#displayRate()]);
    const state = this.#store.state;
    const ordered = Object.values(state.agents).sort((a, b) => a.createdAt - b.createdAt);
    const setAside = await Promise.all(ordered.map((agent) => this.#setAside(agent)));
    return {
      network: this.#chain.network,
      main: {
        address: this.mainAddress,
        balance: money(balances.values.get(MAIN_KEY) ?? 0n, rate),
      },
      held: money(this.#heldBy(null), rate),
      agents: ordered.map((agent, index) =>
        this.#agentView(agent, balances.values.get(agent.id) ?? 0n, rate, setAside[index]!),
      ),
      solUsd: rate,
      pendingApprovals: Object.values(state.approvals).filter(
        (approval) => approval.status === "pending",
      ).length,
      offline: balances.offline,
    };
  }

  // ------------------------------------------------------------- agents

  async createAgent(name: string): Promise<AgentView> {
    const clean = clampName(name);
    const id = newId("agent").toLowerCase().replace(/[^a-z0-9_]/g, "x");
    const keyId = `agent:${id}`;
    const agentAddress = await this.#vault.create(keyId);
    this.#store.update((draft) => {
      draft.agents[id] = {
        id,
        name: clean,
        keyId,
        address: agentAddress,
        createdAt: this.#now(),
        policy: {
          askAboveCents: 0,
          refill: { enabled: false, topUpToCents: 0, perDayCents: 0 },
        },
        spentLamports: "0",
        earnedLamports: "0",
        refills: [],
        earn: { enabled: false, minPayCents: 0, jobsDone: 0, lastError: null },
      };
    });
    this.#dropBalances();
    this.#emit({ type: "overview" });
    return this.#oneAgentView(id);
  }

  async renameAgent(agentId: string, name: string): Promise<AgentView> {
    const clean = clampName(name);
    this.#agentRecord(agentId);
    this.#store.update((draft) => {
      draft.agents[agentId]!.name = clean;
    });
    this.#emit({ type: "overview" });
    return this.#oneAgentView(agentId);
  }

  async setPolicy(agentId: string, policy: AgentPolicy): Promise<AgentView> {
    const clean = assertPolicy(policy);
    this.#agentRecord(agentId);
    this.#store.update((draft) => {
      draft.agents[agentId]!.policy = clean;
    });
    this.#emit({ type: "overview" });
    return this.#oneAgentView(agentId);
  }

  /** Send lamports between two of this wallet's own keys, or out of it. */
  async #send(fromKey: string, to: Address, lamports: bigint): Promise<string> {
    const signer = await this.#vault.signer(fromKey);
    try {
      const result = await this.#chain
        .clientFor(signer)
        .send([transferInstruction(signer, to, lamports)]);
      return result.signature;
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError(
        "NETWORK",
        "The money could not be moved right now. Nothing was changed; try again in a moment.",
        { cause: error },
      );
    } finally {
      this.#dropBalances();
    }
  }

  /** Move `lamports` from the main balance to an agent, keeping main alive. */
  async #mainToAgent(agent: AgentRecord, lamports: bigint, text: string): Promise<void> {
    await this.#lock(MAIN_KEY, async () => {
      const floor = await this.#floor();
      const mainBalance = await this.#chain.getBalance(this.mainAddress);
      const agentBalance = await this.#chain.getBalance(agent.address as Address);
      if (lamports <= 0n) throw new WalletError("BAD_REQUEST", "That amount is not valid.");
      if (agentBalance + lamports < floor) {
        const rate = await this.#displayRate();
        throw new WalletError(
          "BAD_REQUEST",
          `The smallest amount an agent's wallet can hold is ${formatMoney(money(floor, rate))}.`,
        );
      }
      const keep = floor + this.#chain.transferFeeLamports;
      if (mainBalance - lamports < keep) {
        const rate = await this.#displayRate();
        throw new WalletError(
          "NOT_ENOUGH_MONEY",
          `There is not enough in your balance. You have ${formatMoney(money(mainBalance > keep ? mainBalance - keep : 0n, rate))} available.`,
        );
      }
      const signature = await this.#send(MAIN_KEY, agent.address as Address, lamports);
      this.#store.update((draft) => {
        this.#note(draft, {
          kind: "allowance",
          text,
          lamports,
          agentId: agent.id,
          signature,
        });
        draft.lastMainLamports = (mainBalance - lamports).toString();
      });
      this.#emit({ type: "overview" });
      this.#emit({ type: "activity" });
    });
  }

  async fundAgent(agentId: string, amount: AmountInput): Promise<AgentView> {
    const agent = this.#agentRecord(agentId);
    const lamports = await this.#toLamports(amount);
    await this.#mainToAgent(agent, lamports, `Gave ${agent.name} an allowance.`);
    return this.#oneAgentView(agentId);
  }

  async reclaimFromAgent(agentId: string, amount: AmountInput | "all"): Promise<AgentView> {
    const agent = this.#agentRecord(agentId);
    await this.#lock(`wallet:${agentId}`, async () => {
      // The wallet keeps its minimum and the fee of this very transfer.
      const keep = (await this.#floor()) + this.#chain.transferFeeLamports;
      const balance = await this.#chain.getBalance(agent.address as Address);
      const available = balance > keep ? balance - keep : 0n;
      const lamports = amount === "all" ? available : await this.#toLamports(amount);
      if (lamports <= 0n || lamports > available) {
        throw new WalletError(
          "NOT_ENOUGH_MONEY",
          "That agent does not have that much to give back.",
        );
      }
      const signature = await this.#send(agent.keyId, this.mainAddress, lamports);
      this.#store.update((draft) => {
        this.#note(draft, {
          kind: "returned",
          text: `Took money back from ${agent.name}.`,
          lamports,
          agentId,
          signature,
        });
        if (draft.lastMainLamports !== null) {
          draft.lastMainLamports = (BigInt(draft.lastMainLamports) + lamports).toString();
        }
      });
    });
    this.#emit({ type: "overview" });
    this.#emit({ type: "activity" });
    return this.#oneAgentView(agentId);
  }

  /** Send money from the main balance to an outside address. Owner only. */
  async withdraw(to: string, amount: AmountInput | "all"): Promise<{ signature: string }> {
    const destination = toAddress(to, "address");
    if (this.#walletIds().some((wallet) => wallet.address === destination)) {
      throw new WalletError("BAD_REQUEST", "That address is one of this wallet's own.");
    }
    return this.#lock(MAIN_KEY, async () => {
      const floor = await this.#floor();
      const keep = floor + this.#chain.transferFeeLamports;
      const balance = await this.#chain.getBalance(this.mainAddress);
      const available = balance > keep ? balance - keep : 0n;
      const lamports = amount === "all" ? available : await this.#toLamports(amount);
      if (lamports <= 0n || lamports > available) {
        throw new WalletError("NOT_ENOUGH_MONEY", "There is not that much in your balance.");
      }
      const destinationBalance = await this.#chain.getBalance(destination);
      if (destinationBalance + lamports < floor) {
        throw new WalletError(
          "BAD_REQUEST",
          "That is too little to open a new wallet at that address. Send a larger amount.",
        );
      }
      const signature = await this.#send(MAIN_KEY, destination, lamports);
      this.#store.update((draft) => {
        this.#note(draft, {
          kind: "withdrawn",
          text: "Sent money out of the wallet.",
          lamports,
          signature,
        });
        draft.lastMainLamports = (balance - lamports).toString();
      });
      this.#emit({ type: "overview" });
      this.#emit({ type: "activity" });
      return { signature };
    });
  }

  // ------------------------------------------------------------ catalog

  #serviceView(row: CatalogRow, rate: number | null): ServiceView {
    return {
      listing: row.listing,
      name: row.name,
      summary: row.summary,
      category: row.category,
      price: money(row.priceLamports, rate),
      rating: row.rating,
      ratingCount: row.ratingCount,
      jobsDone: row.jobsDone,
      provider: row.providerAgent,
      deliverySecs: row.deliverySecs,
    };
  }

  /**
   * What every job costs on top of its price and never comes back: the
   * permanent job record's deposit plus the fees of its transactions.
   */
  async networkFee(): Promise<Money> {
    const [record, rate] = await Promise.all([
      this.#chain.getMinimumBalanceForRentExemption(TASK_ACCOUNT_SPACE),
      this.#displayRate(),
    ]);
    return money(record + JOB_TRANSACTION_FEES_LAMPORTS, rate);
  }

  async find(params: {
    query?: string;
    maxPriceCents?: number;
    limit?: number;
  }): Promise<ServiceView[]> {
    const [rows, rate] = await Promise.all([this.#services.listServices(), this.#displayRate()]);
    const words = (params.query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1);
    const limit = Math.min(20, Math.max(1, Math.trunc(params.limit ?? 8)));
    let maxLamports: bigint | null = null;
    if (params.maxPriceCents !== undefined) {
      if (rate === null) {
        throw new WalletError(
          "NETWORK",
          "Dollar prices are not available right now. Try again in a moment.",
        );
      }
      maxLamports = centsToLamports(params.maxPriceCents, rate);
    }
    const scored = rows
      .filter((row) => maxLamports === null || row.priceLamports <= maxLamports)
      .map((row) => {
        const haystack = `${row.name} ${row.summary ?? ""} ${row.category ?? ""}`.toLowerCase();
        const hits = words.filter((word) => haystack.includes(word)).length;
        return { row, hits };
      })
      .filter((entry) => words.length === 0 || entry.hits > 0);
    scored.sort(
      (a, b) =>
        b.hits - a.hits ||
        (b.row.rating ?? 0) - (a.row.rating ?? 0) ||
        b.row.jobsDone - a.row.jobsDone ||
        (a.row.priceLamports < b.row.priceLamports ? -1 : a.row.priceLamports > b.row.priceLamports ? 1 : 0),
    );
    return scored.slice(0, limit).map((entry) => this.#serviceView(entry.row, rate));
  }

  // --------------------------------------------------------------- hire

  /**
   * Start a purchase for an agent. Returns once the job is posted, has
   * failed, or is waiting for a person's approval.
   */
  async hire(params: {
    agentId: string;
    listing: string;
    request: string;
    maxPriceCents?: number;
    acceptance?: string[];
    idempotencyKey?: string;
  }): Promise<{ job: JobView; approval: ApprovalView | null }> {
    const agent = this.#agentRecord(params.agentId);
    const request = typeof params.request === "string" ? params.request.trim() : "";
    if (request.length === 0 || request.length > 4_000) {
      throw new WalletError("BAD_REQUEST", "Say what you want done, in up to 4,000 characters.");
    }
    const acceptance = (params.acceptance ?? []).map((item) => {
      const line = tidyText(item, 300);
      if (line === null) throw new WalletError("BAD_REQUEST", "A check cannot be empty.");
      return line;
    });
    if (acceptance.length > 8) {
      throw new WalletError("BAD_REQUEST", "Use at most 8 checks.");
    }
    const key = params.idempotencyKey?.trim() || null;
    if (key !== null) {
      const existing = Object.values(this.#store.state.jobs).find(
        (job) => job.agentId === agent.id && job.idempotencyKey === key,
      );
      if (existing !== undefined) {
        const approval = Object.values(this.#store.state.approvals).find(
          (entry) => entry.jobId === existing.id && entry.status === "pending",
        );
        const rate = await this.#displayRate();
        return {
          job: await this.#jobView(existing, false),
          approval: approval === undefined ? null : approvalView(approval, agent.name, rate),
        };
      }
    }

    const listing = toAddress(params.listing, "service");
    const terms = await readHireableListing(this.#chain, listing);
    const rate = await this.#freshRate();
    if (params.maxPriceCents !== undefined) {
      if (rate === null) {
        throw new WalletError(
          "NETWORK",
          "Dollar prices are not available right now, so the price limit cannot be checked.",
        );
      }
      if (terms.priceLamports > centsToLamports(params.maxPriceCents, rate)) {
        throw new WalletError(
          "PRICE_CHANGED",
          `That service costs ${formatMoney(money(terms.priceLamports, rate))}, which is above the limit given.`,
        );
      }
    }
    await this.#ensureListingGate(terms);

    const spec = buildJobSpec({ title: terms.name, request, acceptance, listing });
    const hash = await jobSpecHash(spec);
    const deposits = await purchaseDeposits(this.#chain, agent.address as Address);
    const floor = await this.#floor();
    const need = terms.priceLamports + deposits.total + floor;
    const agentBalance = await this.#chain.getBalance(agent.address as Address);
    const priceCents = lamportsToCents(terms.priceLamports, rate);
    // Without a price the limit cannot be checked, so a person decides.
    const withinLimit = priceCents !== null && priceCents <= agent.policy.askAboveCents;
    const covered = agentBalance >= need;
    const autonomous = withinLimit && covered;

    const now = this.#now();
    const jobId = newId("job");
    const catalogRow = (await this.#services.listServices().catch(() => [])).find(
      (row) => row.listing === listing,
    );
    const service: ServiceView = this.#serviceView(
      catalogRow ?? {
        listing,
        providerAgent: terms.providerAgent,
        name: terms.name,
        category: terms.category,
        summary: null,
        priceLamports: terms.priceLamports,
        rating: null,
        ratingCount: terms.ratingCount,
        jobsDone: 0,
        deliverySecs: terms.deliverySecs,
      },
      rate,
    );
    const record: JobRecord = {
      id: jobId,
      role: "buying",
      agentId: agent.id,
      createdAt: now,
      updatedAt: now,
      idempotencyKey: key,
      listing,
      providerAgent: terms.providerAgent,
      title: terms.name,
      request,
      acceptance,
      priceLamports: terms.priceLamports.toString(),
      expectedVersion: terms.version.toString(),
      listingSpecHashHex: values.bytesToHex(terms.specHash),
      payer: null,
      taskIdHex: values.bytesToHex(values.randomId32()),
      task: null,
      jobSpec: spec,
      jobSpecHashHex: hash.hex,
      jobSpecUri: null,
      phase: autonomous ? "cleared" : "needs_approval",
      hireAttemptAt: null,
      hiredAt: null,
      chainStatus: null,
      deadline: null,
      reviewDeadlineAt: null,
      autoRefundAt: null,
      outcome: null,
      changesRequested: false,
      result: null,
      rating: null,
      tidied: false,
      signatures: {},
      changes: [],
      error: null,
    };

    if (autonomous) {
      this.#store.update((draft) => {
        draft.jobs[jobId] = { ...record, payer: "agent" };
      });
      await this.#advance(jobId);
      this.#emit({ type: "job", jobId });
      return { job: await this.#jobView(this.#jobRecord(jobId), false), approval: null };
    }

    const approvalId = newId("ok");
    this.#store.update((draft) => {
      draft.jobs[jobId] = record;
      draft.approvals[approvalId] = {
        id: approvalId,
        jobId,
        agentId: agent.id,
        service,
        request,
        priceLamports: terms.priceLamports.toString(),
        depositsLamports: deposits.total.toString(),
        keptLamports: deposits.kept.toString(),
        fromMainLamports: covered ? "0" : (terms.priceLamports + deposits.total).toString(),
        createdAt: now,
        expiresAt: now + (this.#config.approvalTtlMs ?? 30 * 60_000),
        status: "pending",
      };
    });
    this.#emit({ type: "approval", approvalId });
    this.#emit({ type: "job", jobId });
    this.#emit({ type: "overview" });
    return {
      job: await this.#jobView(this.#jobRecord(jobId), false),
      approval: approvalView(this.#store.state.approvals[approvalId]!, agent.name, rate),
    };
  }

  /** Make sure an accepted attestation exists for the listing, or refuse. */
  async #ensureListingGate(terms: ListingTerms): Promise<void> {
    if ((await findListingGate(this.#chain, this.#services, terms)) !== null) return;
    await this.#services.acquireListingAttestation(terms.listing);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if ((await findListingGate(this.#chain, this.#services, terms)) !== null) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new WalletError(
      "NOT_AVAILABLE",
      "That service has not passed the marketplace's safety check yet. Try again in a moment.",
    );
  }

  // ---------------------------------------------------------- approvals

  async listApprovals(): Promise<ApprovalView[]> {
    const rate = await this.#displayRate();
    const state = this.#store.state;
    return Object.values(state.approvals)
      .filter((approval) => approval.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((approval) =>
        approvalView(approval, state.agents[approval.agentId]?.name ?? "An agent", rate),
      );
  }

  /** A person answers an approval. Approving starts the purchase. */
  async decideApproval(approvalId: string, approve: boolean): Promise<JobView> {
    const approval = this.#store.state.approvals[approvalId];
    if (approval === undefined) throw new WalletError("NOT_FOUND", "That request is gone.");
    if (approval.status !== "pending") {
      return this.#jobView(this.#jobRecord(approval.jobId), true);
    }
    const jobId = approval.jobId;
    if (!approve) {
      this.#store.update((draft) => {
        draft.approvals[approvalId]!.status = "declined";
        const job = draft.jobs[jobId];
        if (job !== undefined && job.phase === "needs_approval") {
          job.phase = "declined";
          job.updatedAt = this.#now();
        }
      });
      this.#emit({ type: "approval", approvalId });
      this.#emit({ type: "job", jobId });
      this.#emit({ type: "overview" });
      return this.#jobView(this.#jobRecord(jobId), true);
    }

    const job = this.#jobRecord(jobId);
    const agent = this.#agentRecord(job.agentId);
    const deposits = await purchaseDeposits(this.#chain, agent.address as Address);
    const floor = await this.#floor();
    const need = BigInt(job.priceLamports) + deposits.total + floor;
    const agentBalance = await this.#chain.getBalance(agent.address as Address);
    const payer: "agent" | "main" = agentBalance >= need ? "agent" : "main";
    if (payer === "main") {
      const mainDeposits = await purchaseDeposits(this.#chain, this.mainAddress);
      const mainNeed = BigInt(job.priceLamports) + mainDeposits.total + floor;
      const mainBalance = await this.#chain.getBalance(this.mainAddress);
      if (mainBalance < mainNeed) {
        const rate = await this.#displayRate();
        throw new WalletError(
          "NOT_ENOUGH_MONEY",
          `There is not enough in your balance. This needs ${formatMoney(money(mainNeed, rate))} and you have ${formatMoney(money(mainBalance, rate))}.`,
        );
      }
    }
    this.#store.update((draft) => {
      draft.approvals[approvalId]!.status = "approved";
      const entry = draft.jobs[jobId];
      if (entry !== undefined && entry.phase === "needs_approval") {
        entry.phase = "cleared";
        entry.payer = payer;
        entry.updatedAt = this.#now();
      }
    });
    this.#emit({ type: "approval", approvalId });
    this.#emit({ type: "overview" });
    await this.#advance(jobId);
    this.#emit({ type: "job", jobId });
    return this.#jobView(this.#jobRecord(jobId), true);
  }

  /** Resolve when an approval is answered or lapses, or after `timeoutMs`. */
  async waitApproval(
    approvalId: string,
    timeoutMs = 240_000,
    agentId?: string,
  ): Promise<{ decided: boolean; job: JobView }> {
    const approval = this.#store.state.approvals[approvalId];
    if (approval === undefined || (agentId !== undefined && approval.agentId !== agentId)) {
      throw new WalletError("NOT_FOUND", "That request is gone.");
    }
    const jobId = approval.jobId;
    const settled = (): boolean => {
      const phase = this.#store.state.jobs[jobId]?.phase;
      return phase === undefined || (phase !== "needs_approval" && phase !== "cleared" && phase !== "hiring" && phase !== "hired");
    };
    await this.#waitFor(settled, Math.min(Math.max(timeoutMs, 0), 600_000));
    const job = this.#jobRecord(jobId);
    return { decided: job.phase !== "needs_approval", job: await this.#jobView(job, false) };
  }

  #waitFor(done: () => boolean, timeoutMs: number): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const off = this.on(() => {
        if (done()) finish();
      });
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  // ---------------------------------------------------- purchase engine

  async #payerSigner(job: JobRecord): Promise<KeyPairSigner> {
    if (job.payer === "main") return this.#vault.signer(MAIN_KEY);
    return this.#vault.signer(this.#agentRecord(job.agentId).keyId);
  }

  #payerLock(job: JobRecord): string {
    return job.payer === "main" ? MAIN_KEY : `wallet:${job.agentId}`;
  }

  #patchJob(jobId: string, patch: (job: JobRecord, draft: WalletState) => void): void {
    this.#store.update((draft) => {
      const job = draft.jobs[jobId];
      if (job === undefined) return;
      patch(job, draft);
      job.updatedAt = this.#now();
    });
    this.#emit({ type: "job", jobId });
  }

  #failJob(jobId: string, message: string): void {
    this.#patchJob(jobId, (job) => {
      job.phase = "failed";
      job.error = message;
    });
    this.#emit({ type: "overview" });
  }

  /** Move one job as far as it can go right now. Safe to call at any time. */
  #advance(jobId: string): Promise<void> {
    return this.#lock(`job:${jobId}`, async () => {
      for (let step = 0; step < 6; step += 1) {
        const before = this.#store.state.jobs[jobId];
        if (before === undefined || before.role !== "buying") return;
        try {
          if (before.phase === "cleared") await this.#stepClear(before);
          else if (before.phase === "hiring") await this.#stepHire(before);
          else if (before.phase === "hired") await this.#stepPost(before);
          else if (before.phase === "active") await this.#stepTrack(before);
          else if (before.phase === "done") await this.#stepTidy(before);
          else return;
        } catch (error) {
          this.#log(`job ${jobId} ${before.phase}: ${describeError(error)}`);
          return;
        }
        const after = this.#store.state.jobs[jobId];
        if (after === undefined || after.phase === before.phase) return;
      }
    });
  }

  /** cleared -> hiring: fix the payer and the task address, re-check terms. */
  async #stepClear(job: JobRecord): Promise<void> {
    const payer = await this.#payerSigner(job);
    let terms: ListingTerms;
    try {
      terms = await readHireableListing(this.#chain, job.listing as Address);
    } catch (error) {
      if (error instanceof WalletError && error.code !== "NETWORK") {
        this.#failJob(job.id, `${error.message} Nothing was spent.`);
        return;
      }
      throw error;
    }
    if (
      terms.priceLamports.toString() !== job.priceLamports ||
      terms.version.toString() !== job.expectedVersion ||
      values.bytesToHex(terms.specHash) !== job.listingSpecHashHex
    ) {
      this.#failJob(
        job.id,
        "The service changed its price or terms after you saw them. Nothing was spent.",
      );
      return;
    }
    const task = await taskAddressFor(payer.address, values.hexToBytes(job.taskIdHex));
    this.#patchJob(job.id, (entry) => {
      entry.task = task;
      entry.phase = "hiring";
    });
  }

  /** hiring -> hired: send the hire once, then let the chain say what happened. */
  async #stepHire(job: JobRecord): Promise<void> {
    const payer = await this.#payerSigner(job);
    const task = job.task as Address;
    const intent = {
      listing: job.listing as Address,
      providerAgent: job.providerAgent as Address,
      taskId: values.hexToBytes(job.taskIdHex),
      jobSpecHash: values.hexToBytes(job.jobSpecHashHex),
      priceLamports: BigInt(job.priceLamports),
      listingVersion: BigInt(job.expectedVersion),
      listingSpecHash: values.hexToBytes(job.listingSpecHashHex),
      reviewWindowSecs: this.#config.reviewWindowSecs ?? DEFAULT_REVIEW_WINDOW_SECS,
    };
    const landed = (): Promise<boolean> => hireLanded(this.#chain, payer.address, task, intent);
    const markHired = (signature?: string): void => {
      this.#patchJob(job.id, (entry) => {
        entry.phase = "hired";
        entry.hiredAt = this.#now();
        if (signature !== undefined) entry.signatures.hire = signature;
      });
      this.#dropBalances();
      this.#emit({ type: "overview" });
    };

    if (job.hireAttemptAt !== null) {
      if (await landed()) markHired();
      else if (this.#now() - job.hireAttemptAt > HIRE_RECONCILE_GRACE_MS) {
        this.#failJob(job.id, "The order did not reach the marketplace. Nothing was spent.");
      }
      return;
    }

    await this.#lock(this.#payerLock(job), async () => {
      const terms: ListingTerms = {
        listing: intent.listing,
        providerAgent: intent.providerAgent,
        name: job.title,
        category: null,
        priceLamports: intent.priceLamports,
        version: intent.listingVersion,
        specHash: intent.listingSpecHash,
        deliverySecs: null,
        ratingCount: 0,
      };
      const gate = await findListingGate(this.#chain, this.#services, terms);
      if (gate === null) {
        this.#failJob(
          job.id,
          "That service is no longer cleared by the marketplace's safety check. Nothing was spent.",
        );
        return;
      }
      const deposits = await purchaseDeposits(this.#chain, payer.address);
      const floor = await this.#floor();
      const balance = await this.#chain.getBalance(payer.address);
      if (balance < intent.priceLamports + deposits.total + floor) {
        this.#failJob(job.id, "There was not enough money to place the order. Nothing was spent.");
        return;
      }
      // Written before the send: after a crash the chain decides the outcome.
      this.#patchJob(job.id, (entry) => {
        entry.hireAttemptAt = this.#now();
      });
      try {
        markHired(await sendHire(this.#chain, payer, intent, gate));
      } catch (error) {
        this.#log(`job ${job.id} hire: ${describeError(error)}`);
        if (await landed().catch(() => false)) {
          markHired();
        } else if (sendDefinitelyFailed(error)) {
          this.#failJob(job.id, hireFailureText(error).message);
        }
        // Otherwise the outcome is unknown: the next pass reconciles it.
      }
    });
  }

  /** hired -> active: get the job spec attested and published, then pin it. */
  async #stepPost(job: JobRecord): Promise<void> {
    const payer = await this.#payerSigner(job);
    const task = job.task as Address;
    const hash = values.hexToBytes(job.jobSpecHashHex);
    const activate = (signature?: string): void => {
      const agent = this.#store.state.agents[job.agentId];
      this.#patchJob(job.id, (entry, draft) => {
        entry.phase = "active";
        entry.chainStatus = "open";
        entry.autoRefundAt = this.#now() + (this.#config.autoRefundAfterMs ?? 10 * 60_000);
        if (signature !== undefined) entry.signatures.activate = signature;
        this.#note(draft, {
          kind: "hired",
          text: `${agent?.name ?? "An agent"} hired ${entry.title}.`,
          lamports: BigInt(entry.priceLamports),
          agentId: entry.agentId,
          jobId: entry.id,
          signature: entry.signatures.hire ?? null,
        });
      });
      this.#emit({ type: "activity" });
      this.#emit({ type: "overview" });
    };

    if (await isActivated(this.#chain, task)) {
      activate();
      return;
    }

    let gate = await findTaskGate(this.#chain, this.#services, {
      task,
      creator: payer.address,
      jobSpecHash: hash,
    });
    let jobSpecUri = job.jobSpecUri;
    if (gate === null) {
      try {
        const attested = await this.#services.attestTask({
          task,
          jobSpecHashHex: job.jobSpecHashHex,
          jobSpec: job.jobSpec,
        });
        jobSpecUri = attested.jobSpecUri;
        this.#patchJob(job.id, (entry) => {
          entry.jobSpecUri = attested.jobSpecUri;
        });
      } catch (error) {
        const refused = error instanceof WalletError && error.code === "NOT_ALLOWED";
        const stuck =
          job.hiredAt !== null && this.#now() - job.hiredAt > POSTING_GIVE_UP_MS;
        if (refused || stuck) {
          await this.#cancelUnposted(
            job,
            refused
              ? (error as WalletError).message.replace(
                  /so the job was not posted\.$/,
                  "so the job was cancelled and the price returned.",
                )
              : "The job could not be posted, so it was cancelled and the price returned.",
          );
          return;
        }
        throw error;
      }
      for (let attempt = 0; attempt < 20 && gate === null; attempt += 1) {
        gate = await findTaskGate(this.#chain, this.#services, {
          task,
          creator: payer.address,
          jobSpecHash: hash,
        });
        if (gate === null) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (gate === null) return; // Not visible yet; the next pass picks it up.
    }
    if (jobSpecUri === null) {
      jobSpecUri = await this.#services.jobSpecUriFor(job.jobSpecHashHex);
      if (jobSpecUri === null) return;
      const found = jobSpecUri;
      this.#patchJob(job.id, (entry) => {
        entry.jobSpecUri = found;
      });
    }
    try {
      activate(await sendActivation(this.#chain, payer, { task, jobSpecHash: hash, jobSpecUri }, gate));
    } catch (error) {
      this.#log(`job ${job.id} activate: ${describeError(error)}`);
      if (await isActivated(this.#chain, task)) activate();
    }
  }

  /** Cancel a hired job that never got posted, and record the refund. */
  async #cancelUnposted(job: JobRecord, message: string): Promise<void> {
    const payer = await this.#payerSigner(job);
    const signature = await sendCancel(
      this.#chain,
      payer,
      job.task as Address,
      job.providerAgent as Address,
    );
    this.#recordRefund(job.id, signature, message);
  }

  #recordRefund(jobId: string, signature: string | null, message: string | null): void {
    this.#patchJob(jobId, (entry, draft) => {
      entry.phase = "done";
      entry.chainStatus = "cancelled";
      entry.outcome = "refunded";
      entry.autoRefundAt = null;
      entry.error = message;
      if (signature !== null) entry.signatures.cancel = signature;
      this.#note(draft, {
        kind: "refunded",
        text: `${entry.title} was cancelled and the price came back.`,
        lamports: BigInt(entry.priceLamports),
        agentId: entry.agentId,
        jobId: entry.id,
        signature,
      });
    });
    this.#dropBalances();
    this.#emit({ type: "activity" });
    this.#emit({ type: "overview" });
  }

  #recordPaid(jobId: string, signature: string | null): void {
    this.#patchJob(jobId, (entry, draft) => {
      if (entry.outcome === "paid") return;
      entry.phase = "done";
      entry.chainStatus = "completed";
      entry.outcome = "paid";
      if (signature !== null) entry.signatures.accept = signature;
      const agent = draft.agents[entry.agentId];
      if (agent !== undefined) {
        agent.spentLamports = (BigInt(agent.spentLamports) + BigInt(entry.priceLamports)).toString();
      }
      this.#note(draft, {
        kind: "paid",
        text: `Paid for ${entry.title}.`,
        lamports: BigInt(entry.priceLamports),
        agentId: entry.agentId,
        jobId: entry.id,
        signature,
      });
    });
    this.#dropBalances();
    this.#emit({ type: "activity" });
    this.#emit({ type: "overview" });
  }

  /** active: mirror the chain, refund a job nobody takes, fetch a delivery. */
  async #stepTrack(job: JobRecord): Promise<void> {
    const task = job.task as Address;
    const provider = job.providerAgent as Address;
    const seen = await inspectJob(this.#chain, task, provider);
    if (seen === null) return;

    if (seen.status === "completed") {
      this.#recordPaid(job.id, null);
      return;
    }
    if (seen.status === "cancelled") {
      this.#recordRefund(job.id, null, null);
      return;
    }

    if (seen.status === "open" && seen.workers === 0) {
      if (job.autoRefundAt !== null && this.#now() >= job.autoRefundAt) {
        const payer = await this.#payerSigner(job);
        const signature = await sendCancel(this.#chain, payer, task, provider);
        this.#recordRefund(
          job.id,
          signature,
          "Nobody started this job in time, so it was cancelled and the price returned.",
        );
        return;
      }
    }

    if (seen.status === "in_progress" && seen.deadline > 0 && seen.completions === 0) {
      const clock = await this.#chain.clusterTime();
      const waitingOnBuyer = seen.submission !== null && seen.submission.status === 1;
      if (!waitingOnBuyer && clock > seen.deadline + NO_SHOW_GRACE_SECS) {
        const payer = await this.#payerSigner(job);
        const signature = await sendCancel(this.#chain, payer, task, provider);
        this.#recordRefund(
          job.id,
          signature,
          "The provider did not deliver in time, so the job was cancelled and the price returned.",
        );
        return;
      }
    }

    let result = job.result;
    if (seen.status === "pending_validation" && seen.submission !== null) {
      if (result === null || result.hash !== seen.submission.proofHashHex) {
        result = await this.#loadResult(seen.submission.proofHashHex, seen.submission.resultData);
      }
    }
    const reviewDeadlineAt =
      seen.status === "pending_validation" && seen.submission !== null
        ? seen.submission.reviewDeadlineAt
        : null;
    const changed =
      job.chainStatus !== seen.status ||
      job.deadline !== seen.deadline ||
      job.reviewDeadlineAt !== reviewDeadlineAt ||
      job.result !== result;
    if (!changed) return;
    this.#patchJob(job.id, (entry) => {
      entry.chainStatus = seen.status;
      entry.deadline = seen.deadline;
      entry.reviewDeadlineAt = reviewDeadlineAt;
      entry.result = result;
      if (seen.status === "pending_validation") entry.changesRequested = false;
      if (seen.status !== "open") entry.autoRefundAt = null;
    });
  }

  async #loadResult(
    proofHashHex: string,
    resultData: Uint8Array,
  ): Promise<NonNullable<JobRecord["result"]>> {
    try {
      const fetched = await this.#services.fetchResult({ proofHashHex, resultData });
      if (fetched !== null) {
        let text: string | null = null;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes);
          if (text.length > MAX_RESULT_TEXT) text = `${text.slice(0, MAX_RESULT_TEXT)}\n[cut here]`;
        } catch {
          text = null;
        }
        return { text, uri: fetched.uri, hash: proofHashHex, verified: true };
      }
    } catch (error) {
      this.#log(`delivery fetch: ${describeError(error)}`);
    }
    return { text: null, uri: null, hash: proofHashHex, verified: false };
  }

  /** done: collect what can come back and free the provider's slot. */
  async #stepTidy(job: JobRecord): Promise<void> {
    if (job.tidied || job.task === null) return;
    if (job.outcome === "paid" && job.rating === null) {
      const window = this.#config.rateWindowMs ?? 60 * 60_000;
      if (this.#now() - job.updatedAt < window) return;
    }
    const payer = await this.#payerSigner(job);
    const signature = await sendTidy(
      this.#chain,
      payer,
      job.task as Address,
      job.providerAgent as Address,
    );
    this.#store.update((draft) => {
      const entry = draft.jobs[job.id];
      if (entry === undefined) return;
      entry.tidied = true;
      if (signature !== null) {
        entry.signatures.close = signature;
        this.#note(draft, {
          kind: "tidied",
          text: `Collected the deposits from ${entry.title}.`,
          agentId: entry.agentId,
          jobId: entry.id,
          signature,
        });
      }
    });
    this.#dropBalances();
    this.#emit({ type: "job", jobId: job.id });
    this.#emit({ type: "overview" });
  }

  // --------------------------------------------------------------- jobs

  #earnJobs(agentId: string): JobRecord[] {
    return this.#earn.jobs(agentId).map((entry) => ({
      id: `earn_${agentId}_${entry.task}`,
      role: "working" as const,
      agentId,
      createdAt: entry.at,
      updatedAt: entry.at,
      idempotencyKey: null,
      listing: "",
      providerAgent: "",
      title: "Job from the marketplace",
      request: "",
      acceptance: [],
      priceLamports: (entry.earnedLamports ?? entry.rewardLamports).toString(),
      expectedVersion: "0",
      listingSpecHashHex: "",
      payer: null,
      taskIdHex: "",
      task: entry.task,
      jobSpec: {},
      jobSpecHashHex: "",
      jobSpecUri: null,
      phase: entry.state === "paid" || entry.state === "not_paid" ? "done" : "active",
      hireAttemptAt: null,
      hiredAt: null,
      chainStatus:
        entry.state === "working"
          ? "in_progress"
          : entry.state === "delivered"
            ? "pending_validation"
            : entry.state === "paid"
              ? "completed"
              : "cancelled",
      deadline: null,
      reviewDeadlineAt: null,
      autoRefundAt: null,
      outcome: entry.state === "paid" ? "paid" : entry.state === "not_paid" ? "refunded" : null,
      changesRequested: false,
      result:
        entry.resultHashHex === null
          ? null
          : { text: null, uri: null, hash: entry.resultHashHex, verified: false },
      rating: null,
      tidied: true,
      signatures: entry.settlementSignature === null ? {} : { accept: entry.settlementSignature },
      changes: [],
      error: null,
    }));
  }

  async listJobs(
    params: { role?: "buying" | "working"; agentId?: string; limit?: number },
    isOwner: boolean,
  ): Promise<JobView[]> {
    const state = this.#store.state;
    let records: JobRecord[] = [];
    if (params.role !== "working") {
      records = Object.values(state.jobs).filter(
        (job) => params.agentId === undefined || job.agentId === params.agentId,
      );
    }
    if (params.role !== "buying") {
      const agents =
        params.agentId === undefined ? Object.keys(state.agents) : [params.agentId];
      for (const agentId of agents) {
        if (state.agents[agentId] !== undefined) records.push(...this.#earnJobs(agentId));
      }
    }
    records.sort((a, b) => b.createdAt - a.createdAt);
    const limit = Math.min(200, Math.max(1, Math.trunc(params.limit ?? 50)));
    const context = {
      usdPerSol: await this.#displayRate(),
      now: this.#now(),
      network: this.#chain.network,
      isOwner,
      ratingCostLamports: await this.#ratingCost(),
    };
    return records.slice(0, limit).map((job) => jobView(job, context));
  }

  /** The job, refreshed from the chain first when it is still running. */
  async getJob(jobId: string, isOwner: boolean, agentId?: string): Promise<JobView> {
    if (jobId.startsWith("earn_")) {
      const all = await this.listJobs({ role: "working", ...(agentId ? { agentId } : {}) }, isOwner);
      const found = all.find((job) => job.id === jobId);
      if (found === undefined) throw new WalletError("NOT_FOUND", "That job does not exist.");
      return found;
    }
    const job = this.#jobRecord(jobId);
    if (agentId !== undefined && job.agentId !== agentId) {
      throw new WalletError("NOT_FOUND", "That job does not exist.");
    }
    if (job.phase !== "needs_approval" && job.phase !== "declined" && job.phase !== "failed") {
      await this.#advance(jobId);
    }
    return this.#jobView(this.#jobRecord(jobId), isOwner);
  }

  async waitJob(
    jobId: string,
    until: JobStatus[] | undefined,
    timeoutMs: number | undefined,
    isOwner: boolean,
    agentId?: string,
  ): Promise<{ reached: boolean; job: JobView }> {
    const targets = new Set<JobStatus>(
      until ?? ["delivered", "paid", "refunded", "problem", "failed", "declined"],
    );
    const deadline = this.#now() + Math.min(Math.max(timeoutMs ?? 240_000, 0), 600_000);
    for (;;) {
      const view = await this.getJob(jobId, isOwner, agentId);
      if (targets.has(view.status)) return { reached: true, job: view };
      const left = deadline - this.#now();
      if (left <= 0) return { reached: false, job: view };
      await new Promise((resolve) => setTimeout(resolve, Math.min(left, 3_000)));
    }
  }

  #ownedJob(jobId: string, agentId: string | undefined): JobRecord {
    const job = this.#jobRecord(jobId);
    if (job.role !== "buying" || (agentId !== undefined && job.agentId !== agentId)) {
      throw new WalletError("NOT_FOUND", "That job does not exist.");
    }
    return job;
  }

  /** Accept the delivery and pay the provider. Optionally leave stars. */
  async approveJob(
    jobId: string,
    rating: number | undefined,
    isOwner: boolean,
    agentId?: string,
  ): Promise<JobView> {
    this.#ownedJob(jobId, agentId);
    if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      throw new WalletError("BAD_REQUEST", "A rating is a whole number from 1 to 5.");
    }
    await this.#advance(jobId);
    await this.#lock(`job:${jobId}`, async () => {
      const job = this.#jobRecord(jobId);
      if (job.outcome === "paid") return;
      if (job.phase !== "active" || job.chainStatus !== "pending_validation") {
        throw new WalletError("NOT_ALLOWED", "There is no delivery to approve yet.");
      }
      const payer = await this.#payerSigner(job);
      try {
        const signature = await sendApproval(
          this.#chain,
          payer,
          job.task as Address,
          job.providerAgent as Address,
        );
        this.#recordPaid(jobId, signature);
      } catch (error) {
        if (error instanceof WalletError) throw error;
        throw new WalletError(
          "NETWORK",
          "The payment could not be sent right now. Nothing was paid; try again in a moment.",
          { cause: error },
        );
      }
    });
    if (rating !== undefined) {
      await this.rateJob(jobId, rating, isOwner, agentId).catch((error) => {
        this.#log(`job ${jobId} rating: ${describeError(error)}`);
      });
    }
    void this.#advance(jobId);
    return this.#jobView(this.#jobRecord(jobId), isOwner);
  }

  /** Send a delivery back with a note saying what to change. */
  async askChanges(
    jobId: string,
    note: string,
    isOwner: boolean,
    agentId?: string,
  ): Promise<JobView> {
    this.#ownedJob(jobId, agentId);
    const body = typeof note === "string" ? note.trim() : "";
    if (body.length === 0 || body.length > 2_000) {
      throw new WalletError("BAD_REQUEST", "Say what to change, in up to 2,000 characters.");
    }
    const post = this.#services.postChangeRequest;
    if (post === undefined) {
      throw new WalletError(
        "NOT_AVAILABLE",
        "Asking for changes is not available on this network yet. You can approve the delivery or turn it down.",
      );
    }
    await this.#advance(jobId);
    await this.#lock(`job:${jobId}`, async () => {
      const job = this.#jobRecord(jobId);
      if (job.phase !== "active" || job.chainStatus !== "pending_validation") {
        throw new WalletError("NOT_ALLOWED", "There is no delivery to send back yet.");
      }
      const previous = job.changes.at(-1)?.hashHex ?? null;
      const envelope: taskThread.TaskThreadEnvelope = {
        v: 1,
        taskPda: job.task as string,
        parentHash: previous,
        role: "buyer",
        body,
        attachments: [],
        ts: Math.floor(this.#now() / 1000),
      };
      const digest = await taskThread.envelopeHash(envelope);
      const payer = await this.#payerSigner(job);
      let signature: string;
      try {
        signature = await sendChangesRequest(
          this.#chain,
          payer,
          job.task as Address,
          job.providerAgent as Address,
          digest.bytes,
        );
      } catch (error) {
        const limit = error instanceof AgencError && /Revision|MaxRevision/i.test(error.errorName ?? "");
        throw new WalletError(
          limit ? "NOT_ALLOWED" : "NETWORK",
          limit
            ? "This job has had all the rounds of changes it allows. Approve it or turn it down."
            : "The request could not be sent right now. Try again in a moment.",
          { cause: error },
        );
      }
      await post.call(this.#services, envelope).catch((error: unknown) => {
        this.#log(`job ${jobId} change note: ${describeError(error)}`);
      });
      this.#patchJob(jobId, (entry) => {
        entry.changesRequested = true;
        entry.chainStatus = "in_progress";
        entry.reviewDeadlineAt = null;
        entry.signatures.changes = signature;
        entry.changes.push({ note: body, hashHex: digest.hex, ts: this.#now() });
      });
    });
    return this.#jobView(this.#jobRecord(jobId), isOwner);
  }

  /**
   * Cancel and take the money back where the job allows it. A person may
   * also turn down a delivery; an agent may not.
   */
  async refundJob(jobId: string, isOwner: boolean, agentId?: string): Promise<JobView> {
    const initial = this.#ownedJob(jobId, agentId);
    if (initial.phase === "needs_approval") {
      const approval = Object.values(this.#store.state.approvals).find(
        (entry) => entry.jobId === jobId && entry.status === "pending",
      );
      this.#store.update((draft) => {
        if (approval !== undefined) draft.approvals[approval.id]!.status = "declined";
        const job = draft.jobs[jobId]!;
        job.phase = "declined";
        job.updatedAt = this.#now();
      });
      if (approval !== undefined) this.#emit({ type: "approval", approvalId: approval.id });
      this.#emit({ type: "job", jobId });
      this.#emit({ type: "overview" });
      return this.#jobView(this.#jobRecord(jobId), isOwner);
    }
    await this.#advance(jobId);
    await this.#lock(`job:${jobId}`, async () => {
      const job = this.#jobRecord(jobId);
      if (job.outcome === "refunded") return;
      if (job.phase !== "active" && job.phase !== "hired") {
        throw new WalletError("NOT_ALLOWED", "This job can no longer be cancelled.");
      }
      const payer = await this.#payerSigner(job);
      const task = job.task as Address;
      const provider = job.providerAgent as Address;
      try {
        if (job.chainStatus === "pending_validation") {
          if (!isOwner) {
            throw new WalletError(
              "NOT_ALLOWED",
              "The provider has delivered. Turning a delivery down is the user's decision: they can do it from the Market panel.",
            );
          }
          const reason = await values.sha256(`declined:${job.id}:${this.#now()}`);
          await sendReject(this.#chain, payer, task, provider, reason);
        }
        const signature = await sendCancel(this.#chain, payer, task, provider);
        this.#recordRefund(jobId, signature, null);
      } catch (error) {
        if (error instanceof WalletError) throw error;
        throw new WalletError(
          "NOT_ALLOWED",
          "This job cannot be cancelled right now. If the provider has started, it can be cancelled once their deadline passes.",
          { cause: error },
        );
      }
    });
    void this.#advance(jobId);
    return this.#jobView(this.#jobRecord(jobId), isOwner);
  }

  /** Leave 1 to 5 stars on a paid job. */
  async rateJob(
    jobId: string,
    score: number,
    isOwner: boolean,
    agentId?: string,
  ): Promise<JobView> {
    this.#ownedJob(jobId, agentId);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new WalletError("BAD_REQUEST", "A rating is a whole number from 1 to 5.");
    }
    await this.#lock(`job:${jobId}`, async () => {
      const job = this.#jobRecord(jobId);
      if (job.rating !== null) return;
      if (job.outcome !== "paid" || job.tidied || job.task === null) {
        throw new WalletError("NOT_ALLOWED", "This job can no longer be rated.");
      }
      const task = job.task as Address;
      if (!(await alreadyRated(this.#chain, task))) {
        const payer = await this.#payerSigner(job);
        try {
          const signature = await sendRating(this.#chain, payer, task, job.listing as Address, score);
          this.#patchJob(jobId, (entry) => {
            entry.signatures.rate = signature;
          });
        } catch (error) {
          throw new WalletError(
            "NETWORK",
            "The rating could not be recorded right now. Try again in a moment.",
            { cause: error },
          );
        }
      }
      this.#patchJob(jobId, (entry) => {
        entry.rating = score;
      });
      this.#dropBalances();
    });
    void this.#advance(jobId);
    return this.#jobView(this.#jobRecord(jobId), isOwner);
  }

  async listActivity(limit = 50): Promise<ActivityView[]> {
    const rate = await this.#displayRate();
    const count = Math.min(500, Math.max(1, Math.trunc(limit)));
    return this.#store.state.activity
      .slice(-count)
      .reverse()
      .map((record) => activityView(record, rate));
  }

  // --------------------------------------------------------------- earn

  async #startEarning(agent: AgentRecord): Promise<void> {
    try {
      const signer = await this.#vault.signer(agent.keyId);
      const rate = await this.#freshRate().catch(() => null);
      const minRewardLamports =
        rate === null ? 0n : centsToLamports(agent.earn.minPayCents, rate);
      this.#earn.start({ agentId: agent.id, signer, minRewardLamports });
    } catch (error) {
      this.#log(`earn ${agent.id}: ${describeError(error)}`);
    }
  }

  #onEarnNotice(agentId: string, notice: EarnNotice): void {
    if (notice.type === "paid") {
      this.#store.update((draft) => {
        const agent = draft.agents[agentId];
        if (agent === undefined) return;
        agent.earnedLamports = (BigInt(agent.earnedLamports) + notice.earnedLamports).toString();
        agent.earn.jobsDone += 1;
        this.#note(draft, {
          kind: "earned",
          text: `${agent.name} was paid for a job.`,
          lamports: notice.earnedLamports,
          agentId,
          signature: notice.signature,
        });
      });
      this.#dropBalances();
      this.#emit({ type: "activity" });
    }
    this.#emit({ type: "overview" });
  }

  /** Switch "take jobs while idle" on or off for an agent. Owner only. */
  async setEarn(agentId: string, enabled: boolean, minPayCents?: number): Promise<AgentView> {
    const agent = this.#agentRecord(agentId);
    if (minPayCents !== undefined && (!Number.isFinite(minPayCents) || minPayCents < 0)) {
      throw new WalletError("BAD_REQUEST", "The smallest pay must be zero or more.");
    }
    if (enabled) {
      if (!this.#earn.available) {
        throw new WalletError(
          "NOT_AVAILABLE",
          "This computer is not set up to do jobs yet.",
        );
      }
      const floor = await this.#floor();
      const need = (await this.#earn.startupRequirement()) + floor;
      const balance = await this.#chain.getBalance(agent.address as Address);
      if (balance < need) {
        await this.#mainToAgent(
          agent,
          need - balance,
          `Set money aside so ${agent.name} can register to take jobs.`,
        );
      }
    }
    this.#store.update((draft) => {
      const entry = draft.agents[agentId]!;
      entry.earn.enabled = enabled;
      entry.earn.lastError = null;
      if (minPayCents !== undefined) entry.earn.minPayCents = Math.round(minPayCents);
    });
    if (enabled) await this.#startEarning(this.#agentRecord(agentId));
    else await this.#earn.stop(agentId);
    this.#emit({ type: "overview" });
    return this.#oneAgentView(agentId);
  }

  // ------------------------------------------------------------ janitor

  /** One housekeeping pass. The service calls this on a timer. */
  tick(): Promise<void> {
    if (this.#ticking !== null) return this.#ticking;
    this.#ticking = this.#runTick().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  async #runTick(): Promise<void> {
    const now = this.#now();
    const lapsed = Object.values(this.#store.state.approvals).filter(
      (approval) => approval.status === "pending" && approval.expiresAt <= now,
    );
    if (lapsed.length > 0) {
      this.#store.update((draft) => {
        for (const approval of lapsed) {
          draft.approvals[approval.id]!.status = "expired";
          const job = draft.jobs[approval.jobId];
          if (job !== undefined && job.phase === "needs_approval") {
            job.phase = "declined";
            job.error = "Nobody approved this in time. Nothing was spent.";
            job.updatedAt = now;
          }
        }
      });
      for (const approval of lapsed) {
        this.#emit({ type: "approval", approvalId: approval.id });
        this.#emit({ type: "job", jobId: approval.jobId });
      }
      this.#emit({ type: "overview" });
    }

    const open = Object.values(this.#store.state.jobs).filter(
      (job) =>
        job.role === "buying" &&
        (job.phase === "cleared" ||
          job.phase === "hiring" ||
          job.phase === "hired" ||
          job.phase === "active" ||
          (job.phase === "done" && !job.tidied)),
    );
    await Promise.all(open.map((job) => this.#advance(job.id)));

    await this.#noticeDeposits().catch((error) => {
      this.#log(`deposit check: ${describeError(error)}`);
    });
    await this.#refill().catch((error) => {
      this.#log(`refill: ${describeError(error)}`);
    });
  }

  /** Notice money that arrived in the main balance from outside. */
  async #noticeDeposits(): Promise<void> {
    await this.#lock(MAIN_KEY, async () => {
      const balance = await this.#chain.getBalance(this.mainAddress);
      const last = this.#store.state.lastMainLamports;
      if (last === null) {
        this.#store.update((draft) => {
          draft.lastMainLamports = balance.toString();
          if (balance > 0n) {
            this.#note(draft, {
              kind: "added",
              text: "Money arrived in your balance.",
              lamports: balance,
            });
          }
        });
        if (balance > 0n) this.#emit({ type: "activity" });
        return;
      }
      const previous = BigInt(last);
      if (balance === previous) return;
      // Purchases paid from the main balance move it too; only a rise that
      // no running job explains is reported as money added.
      const mainJobsMoving = Object.values(this.#store.state.jobs).some(
        (job) => job.payer === "main" && !(job.phase === "done" && job.tidied) && job.phase !== "failed" && job.phase !== "declined",
      );
      this.#store.update((draft) => {
        draft.lastMainLamports = balance.toString();
        if (balance > previous && !mainJobsMoving) {
          this.#note(draft, {
            kind: "added",
            text: "Money arrived in your balance.",
            lamports: balance - previous,
          });
        }
      });
      this.#dropBalances();
      this.#emit({ type: "overview" });
      if (balance > previous && !mainJobsMoving) this.#emit({ type: "activity" });
    });
  }

  /** Apply each agent's top-up rule. */
  async #refill(): Promise<void> {
    const rate = await this.#freshRate().catch(() => null);
    if (rate === null) return;
    const dayAgo = this.#now() - 24 * 60 * 60_000;
    for (const agent of Object.values(this.#store.state.agents)) {
      const rule = agent.policy.refill;
      if (!rule.enabled || rule.topUpToCents <= 0 || rule.perDayCents <= 0) continue;
      const balance = await this.#chain.getBalance(agent.address as Address);
      const target = centsToLamports(rule.topUpToCents, rate);
      // Top up only once the wallet has fallen to half its target, so small
      // spends do not each cost a transfer.
      if (balance * 2n > target) continue;
      const usedToday = agent.refills
        .filter((entry) => entry.ts > dayAgo)
        .reduce((sum, entry) => sum + BigInt(entry.lamports), 0n);
      const dayLimit = centsToLamports(rule.perDayCents, rate);
      const room = dayLimit > usedToday ? dayLimit - usedToday : 0n;
      const amount = target - balance < room ? target - balance : room;
      if (amount <= 0n) continue;
      try {
        await this.#mainToAgent(agent, amount, `Topped up ${agent.name}.`);
      } catch (error) {
        if (!(error instanceof WalletError)) throw error;
        continue;
      }
      this.#store.update((draft) => {
        const entry = draft.agents[agent.id];
        if (entry === undefined) return;
        entry.refills = [
          ...entry.refills.filter((item) => item.ts > dayAgo),
          { ts: this.#now(), lamports: amount.toString() },
        ];
      });
    }
  }

  /** Run the janitor every `intervalMs` (default 15 seconds). */
  start(intervalMs = 15_000): void {
    if (this.#timer !== null || this.#closed) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref?.();
  }

  /** Stop timers and earning loops and release the folder lock. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#earn.stopAll();
    if (this.#ticking !== null) await this.#ticking.catch(() => undefined);
    this.#releaseLock();
  }
}

/** Status used by tests and hosts that inspect a record directly. */
export { jobStatus };
