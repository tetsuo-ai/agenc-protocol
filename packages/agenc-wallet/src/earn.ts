// "Take jobs while idle": run the stock marketplace worker loop for an agent,
// signing with that agent's own wallet.
//
// The loop itself is `@tetsuo-ai/agenc-worker` unchanged: watch for jobs, check
// the job spec against the chain, take one at a time, run the host's executor
// on it, deliver. This file only supplies its dependencies (the agent's
// signer, the chain, where to publish deliveries) and keeps it running.
//
// What can go wrong is bounded twice: the agent's wallet holds only what the
// person gave it, and the executor is whatever the host configured (for the
// desktop app, AgenC Core in its OS sandbox in a throwaway folder).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Address, KeyPairSigner } from "@solana/kit";
import { findAgentPda, values, type AgentRegistration } from "@tetsuo-ai/marketplace-sdk";
import {
  acquireStateLock,
  AGENT_STATS_ACCOUNT_SIZE,
  checkSettlements,
  claimFundingRequirement,
  clearWorkerPause,
  DEFAULT_ENDPOINT,
  hexToBytes,
  loadState,
  saveState,
  readJobEvidence,
  readClaimAccountRentMinimums,
  readMinAgentStake,
  registrationFundingRequirement,
  resumeOpenClaim,
  runUp,
  runExecutor,
  runUpkeep,
  type ExecutorMode,
  type UpkeepMemory,
  type WorkerAgent,
  type WorkerContext,
  type WorkerLogEvent,
} from "@tetsuo-ai/agenc-worker";
import type { Chain } from "./chain.js";
import type { EarnState } from "./client/types.js";
import { describeError } from "./errors.js";
import { readAgent } from "./market.js";
import { prepareOutbox, publishingOutbox } from "./outbox.js";
import type { MarketServices } from "./services.js";

/** The program the worker hands each job to. */
export interface EarnExecutor {
  /**
   * Command and arguments; one element must be exactly "{prompt}". Wherever
   * these appear they are replaced:
   *
   * - "{agent}": the id of the agent doing the job, so a host can give each
   *   agent its own working folder.
   * - "{outbox}": the folder where the command leaves files to go with its
   *   delivery, each named by its sha-256 and listed at the end of the
   *   delivery text (see `client/delivery-files.ts`). Empty when this
   *   network cannot keep files: the delivery is then text only.
   * - "{files}": what a file's sha-256 is added to, to make its address in
   *   the delivery store. Empty with "{outbox}".
   * - "{pay}": this job's reward in whole US cents, rounded down. A missing
   *   or invalid rate stops the job before claiming or running the command.
   */
  argv: string[];
  /**
   * "sandboxed": the command confines itself (the worker still gives it a
   * throwaway folder and a minimal environment). "safe": the built-in
   * tool-less Claude command. "unsafe": inherits the host environment.
   */
  mode: ExecutorMode;
  /** Environment variables the command is allowed to inherit. */
  envAllowlist: string[];
  /** Wall-clock limit for one job. */
  timeoutMs: number;
  /** Host self-test, run without buyer data before every claim. Exit 0 means ready. */
  readiness?: { argv: string[]; timeoutMs?: number };
}

export interface EarnOptions {
  /** Null when this host cannot run jobs (earning is then unavailable). */
  executor: EarnExecutor | null;
  /**
   * Never take a job that pays more than this. A reward far above the going
   * rate is how a hostile job baits a worker; null disables the check.
   */
  maxRewardLamports?: bigint | null;
  pollIntervalMs?: number;
  maxIdlePollIntervalMs?: number;
  /** In-process equivalent of executor.readiness. Throw when the job room is unavailable. */
  checkExecutionReady?: (input: { agentId: string; signal?: AbortSignal }) => Promise<void>;
  /** Endpoint recorded with the agent's registration. */
  endpoint?: string;
  /**
   * Take jobs only from this wallet's own addresses: its main balance and its
   * agents. For a host whose executor cannot yet keep a stranger's job away
   * from the person's files. Nothing a stranger wrote is then ever run.
   */
  ownJobsOnly?: boolean;
  /**
   * How often the watch for jobs starts afresh while the agent offers a
   * service. The stock watcher reports a job once. A hire of the agent's own
   * service that could not be taken at that moment (its wallet was short
   * while another job's deposits were out, the network hiccuped) would never
   * be looked at again, and nobody else can take it. Default fifteen minutes.
   */
  serviceRefreshMs?: number;
  /** Attempts a failing job gets before it is given up (worker default 3). */
  maxJobAttempts?: number;
  /** Wait before the second attempt; later waits grow (worker default one minute). */
  retryDelayMs?: number;
  /** Jobs given up in a row before the agent takes no new one (worker default 3). */
  maxFailedJobsInARow?: number;
}

export interface EarnAgent {
  agentId: string;
  signer: KeyPairSigner;
  /** Skip jobs that pay less than this. */
  minRewardLamports: bigint;
  /** Fresh dollars per SOL. Required before a job can be claimed or executed. */
  solUsd?: () => Promise<number | null>;
  /** Leave the worker free for existing service hires while reopening listings. */
  reconcileBeforeOpenJobs?: boolean;
  /** Hires it owes, by task, with what each pays: taken whatever the floor. */
  owed?: ReadonlyMap<string, bigint>;
}

/** Why the worker gave a job up, as its ledger records it. */
export interface EarnFailure {
  /** "attempts": it kept failing. "expired": time ran out. "cancelled": the job ended first. */
  cause: "attempts" | "expired" | "cancelled";
  /** The worker's own words (a technical line, not for a person). */
  reason: string;
  attempts: number;
}

/** One job the agent took, as the worker's own ledger records it. */
export interface EarnedJob {
  task: string;
  rewardLamports: bigint;
  state: "working" | "delivered" | "paid" | "not_paid" | "failed";
  earnedLamports: bigint | null;
  at: number;
  resultHashHex: string | null;
  resultUri: string | null;
  request: string;
  acceptance: string[];
  createdAt: number;
  settlementSignature: string | null;
  /** What the job is called in its job spec: the buyer's words. */
  title: string | null;
  /** The listing a hire came from, or null for an open job. */
  listing: string | null;
  /** Set when the job was given up. */
  failure: EarnFailure | null;
}

export type EarnNotice =
  | { type: "state" }
  | { type: "paid"; task: string; earnedLamports: bigint; signature: string | null }
  | { type: "failed"; task: string; failure: EarnFailure };

const DEFAULT_MAX_REWARD_LAMPORTS = 1_000_000_000n;
/** Never advertise more than this worker can accept. */
export function maximumOfferPrice(options: EarnOptions): bigint {
  const configured = options.maxRewardLamports;
  return configured != null && configured < DEFAULT_MAX_REWARD_LAMPORTS
    ? configured : DEFAULT_MAX_REWARD_LAMPORTS;
}

/** A zero/empty budget is unsafe for hosts that interpret it as unlimited. */
export function jobPayCents(reward: bigint, rate: number | null): number {
  const cents = rate === null ? NaN : Math.floor(Number(reward) * rate / 10_000_000);
  if (rate === null || !Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error("A current dollar price is needed to set this job's spending limit.");
  }
  return cents;
}
const RESTART_DELAY_MS = 20_000;
export const DEFAULT_SERVICE_REFRESH_MS = 15 * 60_000;
export const DEFAULT_EARN_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_EARN_IDLE_POLL_INTERVAL_MS = 5 * 60_000;

interface Running {
  recoveryOnly: boolean;
  discovering: boolean;
  firstDiscovery: Promise<void>;
  finishStartup: () => void;
  awaitingListings: boolean;
  checkReady?: (signal?: AbortSignal) => Promise<void>;
  controller: AbortController;
  done: Promise<void>;
  state: EarnState;
  lastError: string | null;
  /** Set while the worker takes no new job after several failed in a row. */
  paused: string | null;
}

export class EarnHost {
  readonly #chain: Chain;
  readonly #services: MarketServices;
  readonly #options: EarnOptions;
  readonly #dataDir: string;
  readonly #log: (line: string) => void;
  readonly #notify: (agentId: string, notice: EarnNotice) => void;
  readonly #serves: (agentId: string) => boolean;
  readonly #ownAddresses: () => Address[];
  readonly #running = new Map<string, Running>();
  /**
   * Aborted when the wallet closes. A job program in progress is then killed
   * at once (it would otherwise outlive the wallet, spending with nobody to
   * deliver its work) and runs again on the next start. Switching an agent's
   * earning off only stops it looking for work: a job in progress finishes.
   */
  readonly #shutdown = new AbortController();

  constructor(deps: {
    chain: Chain;
    services: MarketServices;
    options: EarnOptions;
    /** Folder that holds one worker ledger per agent. */
    dataDir: string;
    log: (line: string) => void;
    notify: (agentId: string, notice: EarnNotice) => void;
    /** Whether the agent has a service on offer right now. Default: never. */
    serves?: (agentId: string) => boolean;
    /** Every address of this wallet, for {@link EarnOptions.ownJobsOnly}. */
    ownAddresses?: () => Address[];
  }) {
    this.#chain = deps.chain;
    this.#services = deps.services;
    this.#options = deps.options;
    this.#dataDir = deps.dataDir;
    this.#log = deps.log;
    this.#notify = deps.notify;
    this.#serves = deps.serves ?? (() => false);
    this.#ownAddresses = deps.ownAddresses ?? (() => []);
  }

  /** Whether this host can run jobs at all. */
  get available(): boolean {
    return this.#options.executor !== null;
  }

  /** Whether only jobs from this wallet's own addresses are taken. */
  get ownJobsOnly(): boolean {
    return this.#options.ownJobsOnly === true;
  }

  stateDir(agentId: string): string {
    return path.join(this.#dataDir, agentId);
  }

  /** A first contest uses the same registration as the worker and its retirement flow. */
  contestRegistrationId(agentId: string, proposedId: string, reserve = false): string {
    const dir = this.stateDir(agentId);
    const state = loadState(dir);
    if (state.agentIdHex !== null) return state.agentIdHex;
    if (reserve) saveState(dir, { ...state, agentIdHex: proposedId });
    return proposedId;
  }

  state(agentId: string): { state: EarnState; lastError: string | null } {
    const running = this.#running.get(agentId);
    return running === undefined
      ? { state: "off", lastError: null }
      : { state: running.state, lastError: running.lastError };
  }

  /** Include a claim awaiting upload/submission recovery, even after its loop ends. */
  hasUnfinishedJob(agentId: string): boolean {
    if (this.#running.get(agentId)?.state === "working") return true;
    try {
      const state = loadState(this.stateDir(agentId));
      return state.openClaim !== null || state.failedJobs.some((job) => !job.claimReleased);
    } catch (error) {
      this.#log(`earn ${agentId}: reading unfinished work: ${describeError(error)}`);
      // An unreadable journal cannot establish that all work is finished.
      return true;
    }
  }

  /**
   * Lamports the agent's wallet needs before it can register and take its
   * first job: the marketplace's stake, the deposits behind its registration
   * and one job, the job's claim deposit, its marketplace record (started at
   * its first claim and kept), and fee headroom. The stake and deposits come
   * back; the record does not.
   */
  async startupRequirement(): Promise<bigint> {
    const stake = await readMinAgentStake(this.#chain.readAccount);
    const rent = (space: number) => this.#chain.getMinimumBalanceForRentExemption(space);
    const [agent, claim, submission, agentStats] = await Promise.all([
      rent(566),
      rent(203),
      rent(273),
      rent(AGENT_STATS_ACCOUNT_SIZE),
    ]);
    return registrationFundingRequirement(stake, { agent, claim, submission, agentStats });
  }

  /**
   * Lamports the worker wants in the agent's wallet before it takes a job:
   * the deposits behind the job's records and its claim deposit (they come
   * back), and fee headroom. A job priced above 0.1 SOL needs a larger claim
   * deposit (10% of its price); the worker checks that job's exact amount
   * right before it claims.
   */
  async jobReserve(priceLamports?: bigint): Promise<bigint> {
    return claimFundingRequirement(
      await readClaimAccountRentMinimums((space) =>
        this.#chain.getMinimumBalanceForRentExemption(space),
      ),
      {
        ...(priceLamports === undefined ? {} : { depositLamports: values.claimDepositLamports(priceLamports) }),
        recordRentLamports: await this.#chain.getMinimumBalanceForRentExemption(AGENT_STATS_ACCOUNT_SIZE),
      },
    );
  }

  /**
   * Lamports one job in progress ties up in its records until it is paid.
   * A service that should take a new hire while earlier jobs still wait for
   * their buyers needs this much spare per job that is out.
   */
  async jobDeposits(): Promise<bigint> {
    const rents = await readClaimAccountRentMinimums((space) =>
      this.#chain.getMinimumBalanceForRentExemption(space),
    );
    return rents.claim + rents.submission;
  }

  /**
   * The agent's address on the marketplace, once the worker has chosen its
   * id (it does on its first pass, just before registering). Null before.
   */
  async marketplaceAgent(agentId: string): Promise<Address | null> {
    let agentIdHex: string | null;
    try {
      agentIdHex = loadState(this.stateDir(agentId)).agentIdHex;
    } catch {
      return null;
    }
    if (agentIdHex === null) return null;
    const [agent] = await findAgentPda({ agentId: hexToBytes(agentIdHex) });
    return agent;
  }

  /**
   * The agent's record on the marketplace, or null when it has never
   * registered: its deposit for taking jobs (`stake`), how many jobs it holds
   * (`activeTasks`), and whether it was retired.
   */
  async registration(agentId: string): Promise<{ address: Address; account: AgentRegistration } | null> {
    const address = await this.marketplaceAgent(agentId);
    if (address === null) return null;
    const account = await readAgent(this.#chain, address);
    return account === null ? null : { address, account };
  }

  /**
   * Lamports locked as this agent's marketplace deposit (its stake), or 0
   * when it has never registered.
   */
  async setAside(agentId: string): Promise<bigint> {
    return (await this.registration(agentId))?.account.stake ?? 0n;
  }

  /**
   * Bring the agent's own jobs up to date once, without looking for new
   * work: record what was paid since its loop last ran, have a delivery whose
   * buyer let the review time pass paid, and give back the hold on a job it
   * gave up once that job's time is over. Its loop must not be running: this
   * also runs during wallet housekeeping while earning is switched off.
   * Failures are logged; the chain stays the judge of what is still open.
   */
  async tidyUp(agent: EarnAgent): Promise<void> {
    if (this.#running.has(agent.agentId)) return;
    const stateDir = this.stateDir(agent.agentId);
    let agentIdHex: string | null;
    try {
      agentIdHex = loadState(stateDir).agentIdHex;
    } catch {
      return;
    }
    if (agentIdHex === null) return;
    const agentId = hexToBytes(agentIdHex);
    const [agentPda] = await findAgentPda({ agentId });
    const worker: WorkerAgent = { agentId, agentPda, registered: true, justRegistered: false };
    const release = acquireStateLock(stateDir);
    try {
      const ctx: WorkerContext = {
        ...this.#chainContext(agent, stateDir),
        config: this.#config(agent, []),
        log: (event) => this.#workerEvent(agent.agentId, event),
      };
      await checkSettlements(ctx, worker);
      await runUpkeep(ctx, worker);
      await checkSettlements(ctx, worker);
    } catch (error) {
      this.#log(`earn ${agent.agentId}: tidying up: ${describeError(error)}`);
    } finally {
      release();
    }
  }

  #jobEvidence(agentId: string, entry: Parameters<typeof readJobEvidence>[1]) {
    try {
      return readJobEvidence(this.stateDir(agentId), entry);
    } catch (error) {
      this.#log(`earn evidence: ${String(error)}`);
      return undefined;
    }
  }

  /** The jobs this agent has taken, newest first. */
  jobs(agentId: string): EarnedJob[] {
    let state: ReturnType<typeof loadState>;
    try {
      state = loadState(this.stateDir(agentId));
    } catch {
      return [];
    }
    const jobs: EarnedJob[] = [];
    if (state.openClaim !== null) {
      const claim = state.openClaim;
      const evidence = this.#jobEvidence(agentId, claim);
      const reward = claim.execution?.rewardAmount ?? claim.submission?.rewardAmount;
      jobs.push({
        task: claim.task,
        rewardLamports: reward === undefined ? 0n : BigInt(reward),
        state: "working",
        earnedLamports: null,
        at: Date.parse(claim.claimedAt) || 0,
        resultHashHex: null,
        resultUri: null,
        request: evidence?.request ?? "",
        acceptance: evidence?.acceptance ?? [],
        createdAt: Date.parse(claim.claimedAt) || 0,
        settlementSignature: null,
        title: claim.title ?? null,
        listing: claim.listing ?? null,
        failure: null,
      });
    }
    for (const record of state.submissions) {
      const evidence = this.#jobEvidence(agentId, record);
      const earned =
        record.earnedLamports === undefined || record.earnedLamports === null
          ? null
          : BigInt(record.earnedLamports);
      jobs.push({
        task: record.task,
        rewardLamports: BigInt(record.rewardAmount),
        state: !record.settled
          ? "delivered"
          : record.outcome === "accepted" || (record.outcome === "closed" && earned !== null && earned > 0n)
            ? "paid"
            : "not_paid",
        earnedLamports: earned,
        at: Date.parse(record.settledAt ?? record.submittedAt) || 0,
        resultHashHex: record.resultHashHex,
        resultUri: record.resultUri,
        request: evidence?.request ?? "",
        acceptance: evidence?.acceptance ?? [],
        createdAt: Date.parse(record.submittedAt) || 0,
        settlementSignature: record.settlementSignature ?? null,
        title: record.title ?? null,
        listing: record.listing ?? null,
        failure: null,
      });
    }
    for (const job of state.failedJobs) {
      jobs.push({
        task: job.task,
        rewardLamports: job.rewardAmount === undefined ? 0n : BigInt(job.rewardAmount),
        state: "failed",
        earnedLamports: null,
        at: Date.parse(job.failedAt) || 0,
        resultHashHex: null,
        resultUri: null,
        request: "",
        acceptance: [],
        createdAt: Date.parse(job.claimedAt) || 0,
        settlementSignature: null,
        title: job.title ?? null,
        listing: job.listing ?? null,
        failure: { cause: job.cause, reason: job.reason, attempts: job.attempts },
      });
    }
    return jobs.sort((a, b) => b.at - a.at);
  }

  /**
   * Why the agent takes no new job, when several in a row failed: the
   * worker's own words for the last failure. Null when it is not stopped.
   */
  pausedReason(agentId: string): string | null {
    const running = this.#running.get(agentId);
    if (running !== undefined) return running.paused;
    try {
      return loadState(this.stateDir(agentId)).pause?.reason ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Let a stopped agent take jobs again (the person switched earning back
   * on). Its loop must not be running. Returns true when it was stopped.
   */
  clearPause(agentId: string): boolean {
    if (this.#running.has(agentId)) return false;
    try {
      return clearWorkerPause(this.stateDir(agentId));
    } catch {
      return false;
    }
  }

  canTakeJobs(agentId: string): boolean {
    const entry = this.#running.get(agentId);
    return entry?.discovering === true && !entry.controller.signal.aborted && entry.paused === null;
  }

  listingsReconciled(agentId: string): void {
    const entry = this.#running.get(agentId);
    if (entry?.discovering) entry.awaitingListings = false;
  }

  async checkListingReady(agentId: string, signal?: AbortSignal): Promise<void> {
    const entry = this.#running.get(agentId);
    if (!entry?.checkReady || !this.canTakeJobs(agentId)) throw new Error("Worker discovery is unavailable");
    await entry.checkReady(signal ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal);
  }

  /** Whether this agent is only draining persisted work. */
  isRecovering(agentId: string): boolean {
    return this.#running.get(agentId)?.recoveryOnly === true;
  }

  /** Start (or keep) one loop. Recovery never enters the discovery path. */
  start(agent: EarnAgent, recoveryOnly = false): Promise<void> {
    const executor = this.#options.executor;
    if (this.#shutdown.signal.aborted || (!recoveryOnly && executor === null)) return Promise.resolve();
    const running = this.#running.get(agent.agentId);
    if (running) return running.firstDiscovery;
    let finishStartup!: () => void;
    const firstDiscovery = new Promise<void>((resolve) => { finishStartup = resolve; });
    const controller = new AbortController();
    const entry: Running = {
      recoveryOnly,
      discovering: false,
      firstDiscovery, finishStartup,
      awaitingListings: agent.reconcileBeforeOpenJobs === true,
      controller,
      done: Promise.resolve(),
      state: "starting",
      lastError: null,
      paused: null,
    };
    try {
      entry.paused = loadState(this.stateDir(agent.agentId)).pause?.reason ?? null;
    } catch {
      entry.paused = null;
    }
    if (entry.paused !== null) {
      entry.state = "error";
      entry.lastError = pausedText(entry.paused);
    }
    this.#running.set(agent.agentId, entry);
    entry.done = this.#loop(agent, executor ?? {
      argv: [], mode: "sandboxed", envAllowlist: [], timeoutMs: 60_000,
    }, entry).catch((error) => {
      this.#log(`earn ${agent.agentId}: ${describeError(error)}`);
    }).finally(() => {
      entry.finishStartup();
      if (this.#running.get(agent.agentId) === entry) this.#running.delete(agent.agentId);
      this.#notify(agent.agentId, { type: "state" });
    });
    this.#notify(agent.agentId, { type: "state" });
    return firstDiscovery;
  }

  async stop(agentId: string): Promise<void> {
    const entry = this.#running.get(agentId);
    if (entry === undefined) return;
    entry.controller.abort();
    await entry.done;
  }

  /** The wallet is closing: stop every loop, and any job in progress with it. */
  async stopAll(): Promise<void> {
    this.#shutdown.abort();
    await Promise.all([...this.#running.keys()].map((agentId) => this.stop(agentId)));
  }

  async #loop(agent: EarnAgent, executor: EarnExecutor, entry: Running): Promise<void> {
    const signal = entry.controller.signal;
    const stateDir = this.stateDir(agent.agentId);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const uploader = this.#services.resultUploader(agent.signer);
    // Files can go with a delivery only where there is somewhere to keep them.
    const fileLinkPrefix = uploader === null ? null : this.#services.fileLinkPrefix;
    const outboxDir = path.join(stateDir, "outbox");
    if (fileLinkPrefix !== null) prepareOutbox(outboxDir);
    const fill = (part: string): string =>
      part
        .replaceAll("{agent}", agent.agentId)
        .replaceAll("{outbox}", fileLinkPrefix === null ? "" : outboxDir)
        .replaceAll("{files}", fileLinkPrefix ?? "");
    const setState = (wanted: EarnState, wantedError: string | null = null): void => {
      // A stopped agent stays shown as stopped, whatever the loop does.
      const state: EarnState = entry.paused !== null ? "error" : wanted;
      const lastError = entry.paused !== null ? pausedText(entry.paused) : wantedError;
      if (entry.state === state && entry.lastError === lastError) return;
      entry.state = state;
      entry.lastError = lastError;
      this.#notify(agent.agentId, { type: "state" });
    };

    const log = (event: WorkerLogEvent): void => {
      switch (event.event) {
        case "watch.started":
          if (!entry.discovering) {
            entry.discovering = true;
            setState("watching");
            entry.finishStartup();
          }
          break;
        case "task.claimed":
        case "task.resuming-open-claim":
        case "task.resuming-executed-result":
        case "task.resuming-submission":
          setState("working");
          break;
        case "task.execution-not-ready":
          this.#log(`earn ${agent.agentId}: job room not ready: ${String(event.reason ?? "")}`);
          setState("error", "The job room is not ready. No job was taken.");
          break;
        case "task.execution-failed":
        case "task.claim-failed":
        case "task.upload-failed":
          this.#log(`earn ${agent.agentId}: ${event.event} ${String(event.reason ?? "")}`);
          setState("watching");
          break;
        case "task.retry-scheduled":
          this.#log(
            `earn ${agent.agentId}: trying ${String(event.task)} again at ${String(event.retryAt)} (attempt ${String(event.attempt)} of ${String(event.maxAttempts)} failed)`,
          );
          break;
        case "task.given-up": {
          this.#log(
            `earn ${agent.agentId}: gave up ${String(event.task)} (${String(event.cause)}): ${String(event.reason ?? "")}`,
          );
          const cause = event.cause;
          if (
            typeof event.task === "string" &&
            (cause === "attempts" || cause === "expired" || cause === "cancelled")
          ) {
            this.#notify(agent.agentId, {
              type: "failed",
              task: event.task,
              failure: {
                cause,
                reason: typeof event.reason === "string" ? event.reason : "",
                attempts: typeof event.attempts === "number" ? event.attempts : 0,
              },
            });
          }
          setState("watching");
          break;
        }
        case "worker.paused":
          this.#log(`earn ${agent.agentId}: stopped taking jobs: ${String(event.reason ?? "")}`);
          entry.paused = typeof event.reason === "string" ? event.reason : "unknown failure";
          setState("error");
          break;
        case "settlement.observed":
          setState("watching");
          break;
        case "sweep.candidates":
          if (entry.state === "starting") setState("watching");
          break;
        case "task.processing-error":
        case "task.job-spec-rejected":
        case "task.service-spec-rejected":
        case "task.prompt-rejected":
          // A job it could not take. Said once, so the log explains a hire
          // that sat unstarted.
          this.#log(`earn ${agent.agentId}: ${event.event} ${String(event.reason ?? "").slice(0, 300)}`);
          break;
        default:
          break;
      }
      this.#workerEvent(agent.agentId, event);
    };

    const checkReady = async (signal?: AbortSignal): Promise<void> => {
      if (this.#options.checkExecutionReady !== undefined) {
        await this.#options.checkExecutionReady({ agentId: agent.agentId, ...(signal === undefined ? {} : { signal }) });
      } else if (executor.readiness !== undefined) {
        await runExecutor({
          argv: executor.readiness.argv.map(fill),
          timeoutMs: executor.readiness.timeoutMs ?? 30_000,
          envAllowlist: executor.envAllowlist,
          maxStdoutBytes: 64 * 1024,
          ...(signal === undefined ? {} : { signal }),
        });
      } else if (executor.mode === "sandboxed") {
        throw new Error("The host must configure a job room readiness self-test before taking jobs.");
      }
    };
    entry.checkReady = checkReady;

    const ctx: WorkerContext = {
      ...this.#chainContext(agent, stateDir),
      acceptServiceHiresBelowMinReward: true,
      modelBudgetForTask: async (task) => jobPayCents(task.rewardAmount, await agent.solUsd?.() ?? null),
      executorForTask: async (task, _address, reservedCents) => {
        const pay = reservedCents ?? jobPayCents(task.rewardAmount, await agent.solUsd?.() ?? null);
        return executor.argv.map((part) => fill(part).replaceAll("{pay}", String(pay)));
      },
      ...(agent.owed !== undefined && agent.owed.size > 0 ? { owedTasks: agent.owed } : {}),
      config: {
        ...this.#config(agent, executor.argv.map(fill)),
        executorMode: executor.mode,
        executorEnvAllowlist: executor.envAllowlist,
        resultUploader: uploader?.url ?? null,
        executorTimeoutMs: executor.timeoutMs,
      },
      log,
      checkExecutionReady: async ({ listing, signal }) => {
        if (!listing && entry.awaitingListings) throw new Error("Services are still being reconciled.");
        await checkReady(signal);
      },
      ...(uploader !== null
        ? { uploadFetch: fileLinkPrefix === null ? uploader.fetch : publishingOutbox(uploader.fetch, outboxDir) }
        : {}),
      ...(this.#services.resolveAgencUri !== undefined
        ? { resolveAgencUri: this.#services.resolveAgencUri }
        : {}),
      ...(this.#services.taskThreadTransport !== undefined
        ? { taskThreadTransport: this.#services.taskThreadTransport }
        : {}),
    };

    if (entry.recoveryOnly) {
      await this.#drain(agent, ctx, entry);
      return;
    }

    const refreshMs = this.#options.serviceRefreshMs ?? DEFAULT_SERVICE_REFRESH_MS;
    while (!signal.aborted) {
      // One run of the stock watcher. It ends when earning stops, or early
      // when an agent that offers a service is due a fresh look at what is
      // waiting. Ending a run lets a job in progress finish first.
      const run = new AbortController();
      const endRun = (): void => run.abort();
      signal.addEventListener("abort", endRun, { once: true });
      const startedAt = Date.now();
      const refresh = setInterval(
        () => {
          // An own-jobs loop also starts afresh, to learn of agents added since.
          const due = this.#serves(agent.agentId) || this.ownJobsOnly;
          if (due && Date.now() - startedAt >= refreshMs) run.abort();
        },
        Math.max(250, Math.min(refreshMs, 5_000)),
      );
      refresh.unref?.();
      // Whose jobs this run takes. Decided per run, so an own-jobs loop knows
      // every agent the wallet has by now.
      const own = this.ownJobsOnly ? this.#ownAddresses() : null;
      const runCtx: WorkerContext = {
        ...ctx,
        config: {
          ...ctx.config,
          creatorAllowlist: own,
          allowAnyCreator: own === null,
        },
      };
      try {
        // `runUp` returns only when its signal aborts; anything else is a
        // failure worth surfacing and retrying after a pause.
        const watching = setTimeout(() => {
          if (entry.state === "starting") setState("watching");
        }, 3_000);
        try {
          await runUp(runCtx, { signal: run.signal });
        } finally {
          clearTimeout(watching);
        }
      } catch (error) {
        if (signal.aborted) break;
        entry.discovering = false;
        entry.finishStartup();
        this.#log(`earn ${agent.agentId}: stopped (${describeError(error)})`);
        setState("error", earnFailureText(error));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, RESTART_DELAY_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (!signal.aborted) setState("starting");
      } finally {
        clearInterval(refresh);
        signal.removeEventListener("abort", endRun);
      }
    }
  }

  /** Only persisted work: no registration, discovery or new claims. */
  async #drain(agent: EarnAgent, ctx: WorkerContext, entry: Running): Promise<void> {
    const release = acquireStateLock(ctx.stateDir);
    const signal = entry.controller.signal;
    try {
      const agentIdHex = loadState(ctx.stateDir).agentIdHex;
      if (agentIdHex === null) return;
      const agentId = hexToBytes(agentIdHex);
      const [agentPda] = await findAgentPda({ agentId });
      const worker: WorkerAgent = { agentId, agentPda, registered: true, justRegistered: false };
      const upkeepMemory: UpkeepMemory = new Map();
      while (!signal.aborted) {
        try {
          await checkSettlements(ctx, worker);
          await resumeOpenClaim(ctx, worker);
          await runUpkeep(ctx, worker, upkeepMemory);
          await checkSettlements(ctx, worker);
        } catch (error) {
          this.#log(`earn ${agent.agentId}: recovering: ${describeError(error)}`);
        }
        const state = loadState(ctx.stateDir);
        if (state.openClaim === null && state.failedJobs.every((job) => job.claimReleased)) return;
        await delay(ctx.config.pollIntervalMs, undefined, { signal }).catch(() => undefined);
      }
    } finally {
      release();
    }
  }

  /** The worker settings every run for this agent shares. */
  #config(agent: EarnAgent, argv: string[]): WorkerContext["config"] {
    const executor = this.#options.executor;
    const maxReward =
      this.#options.maxRewardLamports === undefined
        ? DEFAULT_MAX_REWARD_LAMPORTS
        : this.#options.maxRewardLamports;
    return {
      capabilities: 1n,
      minRewardLamports: agent.minRewardLamports,
      maxRewardLamports: maxReward,
      allowUnboundedReward: maxReward === null,
      executor: argv,
      executorMode: executor?.mode ?? "sandboxed",
      executorEnvAllowlist: executor?.envAllowlist ?? [],
      resultUploader: null,
      creatorAllowlist: null,
      allowAnyCreator: true,
      endpoint: this.#options.endpoint ?? DEFAULT_ENDPOINT,
      executorTimeoutMs: executor?.timeoutMs ?? 60_000,
      pollIntervalMs: this.#options.pollIntervalMs ?? DEFAULT_EARN_POLL_INTERVAL_MS,
      maxIdlePollIntervalMs: this.#options.maxIdlePollIntervalMs ??
        Math.max(this.#options.pollIntervalMs ?? DEFAULT_EARN_POLL_INTERVAL_MS,
          this.#options.pollIntervalMs === undefined ? DEFAULT_EARN_IDLE_POLL_INTERVAL_MS : this.#options.pollIntervalMs),
      ...(this.#options.maxJobAttempts !== undefined
        ? { maxJobAttempts: this.#options.maxJobAttempts }
        : {}),
      ...(this.#options.retryDelayMs !== undefined
        ? { retryDelayMs: this.#options.retryDelayMs }
        : {}),
      ...(this.#options.maxFailedJobsInARow !== undefined
        ? { maxFailedJobsInARow: this.#options.maxFailedJobsInARow }
        : {}),
    };
  }

  /** How the worker reaches the chain as this agent. */
  #chainContext(agent: EarnAgent, stateDir: string): Omit<WorkerContext, "config" | "log"> {
    return {
      client: this.#chain.clientFor(agent.signer),
      signer: agent.signer,
      gpa: this.#chain.gpa,
      readAccount: (account: Address) => this.#chain.readAccount(account),
      readAccountInfo: this.#chain.readAccountInfo,
      stateDir,
      getBalance: (account) => this.#chain.getBalance(account),
      getMinimumBalanceForRentExemption: (space) =>
        this.#chain.getMinimumBalanceForRentExemption(space),
      // Review windows and claim times run on the chain's clock.
      clusterTime: () => this.#chain.clusterTime(),
      signal: this.#shutdown.signal,
      ...(this.#chain.findSettlementSignature !== undefined
        ? { findSettlementSignature: (task: Address) => this.#chain.findSettlementSignature!(task) }
        : {}),
    };
  }

  /** What every run reports alike: pay that arrived, and its own upkeep. */
  #workerEvent(agentId: string, event: WorkerLogEvent): void {
    switch (event.event) {
      case "settlement.auto-accepted":
      case "claim.released":
        this.#log(`earn ${agentId}: ${event.event} ${String(event.task ?? "")}`);
        break;
      case "settlement.auto-accept-failed":
      case "claim.release-failed":
        this.#log(
          `earn ${agentId}: ${event.event} ${String(event.task ?? "")}: ${String(event.reason ?? "").slice(0, 300)}`,
        );
        break;
      case "settlement.observed": {
        const earned =
          typeof event.earnedLamports === "string" ? BigInt(event.earnedLamports) : 0n;
        if ((event.outcome === "accepted" || event.outcome === "closed") && earned > 0n && typeof event.task === "string") {
          this.#notify(agentId, {
            type: "paid",
            task: event.task,
            earnedLamports: earned,
            signature:
              typeof event.settlementSignature === "string" ? event.settlementSignature : null,
          });
        }
        break;
      }
      default:
        break;
    }
    // Everything the worker decides, for diagnosing why a job was not taken.
    if (process.env.AGENC_WALLET_EARN_DEBUG === "1") {
      this.#log(`earn ${agentId}: ${JSON.stringify(event)}`);
    }
  }
}

/**
 * Why a job could not be done, in a few plain words, from the worker's own
 * account of its last failure.
 */
export function failureWords(reason: string): string {
  if (/timed out|timeout/i.test(reason)) return "it took longer than a job may take";
  if (/job spec/i.test(reason)) return "the job's description could not be read";
  if (/too large/i.test(reason)) return "the job is too large to run";
  if (/buyer's note/i.test(reason)) return "the buyer's note could not be read";
  if (/upload/i.test(reason)) return "the finished work could not be sent";
  if (/ran out|time to deliver/i.test(reason)) return "the time to deliver ran out";
  return "the program that does the work kept failing";
}

/** The agent's line while it takes no new job after several failed in a row. */
export function pausedText(reason: string): string {
  return `Stopped taking jobs after several in a row failed: ${failureWords(reason)}.`;
}

/** Reduce a worker failure to one sentence a person can act on. */
function earnFailureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/insufficient|fund|balance|lamports/i.test(message)) {
    return "This agent's wallet does not hold enough to register and take a job.";
  }
  if (/executor|spawn|ENOENT|not found/i.test(message)) {
    return "The program that does the work could not be started on this computer.";
  }
  if (/already|lock/i.test(message)) {
    return "Another program on this computer is already earning with this agent.";
  }
  return "Earning stopped because of a problem and will be retried shortly.";
}
