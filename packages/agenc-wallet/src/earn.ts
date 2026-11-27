import { createHash } from "node:crypto";
import type { BriefTerms } from "@tetsuo-ai/agenc-worker";
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
import { fundingShortLogLine } from "./earn-log-lines.js";
import { deliveryFileProblem } from "./client/delivery-files.js";
import { indexClaimUsage, reserveServiceRun, serviceUsage, type ServiceUsage } from "./service-usage.js";
import { recordServiceBudget } from "./service-budget.js";
import { readServiceRehearsal } from "./service-rehearsal.js";
import { validServicePin, type SellerTerms } from "./client/seller-terms.js";
import { serviceEconomics } from "./service-economics.js";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Address, KeyPairSigner } from "@solana/kit";
import { findAgentPda, values, type AgentRegistration } from "@tetsuo-ai/marketplace-sdk";
import {
  requireClaimExecutor,
  acquireStateLock,
  AGENT_STATS_ACCOUNT_SIZE,
  checkSettlements,
  claimFundingRequirement,
  clearWorkerPause,
  DEFAULT_ENDPOINT,
  hexToBytes,
  loadState,
  saveState,
  pendingOwnerClaim,
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
  type WorkerDispatch,
  type WorkerContext,
  type WorkerLogEvent,
} from "@tetsuo-ai/agenc-worker";
import { chainDeadline, monotonicMs, ExecutorCapabilityError } from "@tetsuo-ai/agenc-worker";
import { checkNamedProgram, commandGeneration, type RoomSelection } from "./room-selection.js";
import type { Chain } from "./chain.js";
import type { EarnState } from "./client/types.js";
import { outputAgreementFromSpec } from "./client/job-exchange.js";
import { WalletError, describeError } from "./errors.js";
import { readAgent } from "./market.js";
import { prepareOutbox, publishingOutbox } from "./outbox.js";
import type { MarketServices } from "./services.js";

/** The program the worker hands each job to. */
export interface EarnExecutor {
  /** Keep part of a new job’s original model allowance for its two revisions. */
  reserveRevisionBudget?: boolean;
  /** The trusted host selected the isolated guest adapter for this argv. */
  isolatedJobRoom?: boolean;
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

// The host bounds the pinned CLI's first envelope, including its system text and Bash tool.
export const MINIMUM_MESSAGE_BYTES = 18 * 1024;
export interface JobAdmission {
  source: "own" | "external";
  privateInputs: boolean;
  servicePin: boolean;
  serviceDigest?: string;
  reviewFiles: number;
  requiredFiles: readonly string[];
  allowTextOnly: boolean;
  fileTransport: boolean;
  promptBytes: number;
  firstRoundCents?: number;
  deadlineMs?: number;
}

export interface EarnOptions {
  liveRoomState?: () => RoomSelection;
  /** Host-owned exchange and supplier grant resolved independently for each seller. */
  roomWork?: (agentId: string) => WorkerContext["roomWork"];
  /** The host selected its isolated open-job room under the operator switch. */
  chosenRoomEnabled?: () => boolean;
  watchChosenRoom?: (revoke: () => void) => () => void;
  /** Null when this host cannot run jobs (earning is then unavailable). */
  executor: EarnExecutor | null;
  /** The host can make its preconfigured room available while this wallet is open. */
  defaultExecutorEnabled?: () => boolean;
  defaultExecutorGeneration?: () => string;
  /**
   * A different way of running jobs for named agents, such as the one seller
   * the owner paired with a remote room. Every other agent keeps `executor`.
   */
  agentExecutors?: Readonly<Record<string, EarnExecutor>>;
  /**
   * Never take a job that pays more than this. A reward far above the going
   * rate is how a hostile job baits a worker; null disables the check.
   */
  maxRewardLamports?: bigint | null;
  pollIntervalMs?: number;
  maxIdlePollIntervalMs?: number;
  /** In-process equivalent of executor.readiness. Throw when the job room is unavailable. */
  runReviewRoom?: typeof runExecutor;
  checkExecutionReady?: (input: { agentId: string; signal?: AbortSignal; admission?: JobAdmission }) => Promise<void | (() => void)>;
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
  chooseOpenJobs?: () => boolean;
  admitsListing?: (listing: Address) => boolean;
  capabilities?: bigint;
  currentCapabilities?: () => Promise<bigint>;
  specialistTerms?: (required: bigint) => Partial<SellerTerms> | undefined;
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
  cause: "attempts" | "expired" | "cancelled" | "released";
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
  modelUsage?: ServiceUsage | null;
  at: number;
  resultHashHex: string | null;
  resultUri: string | null;
  request: string;
  acceptance: string[];
  terms?: BriefTerms;
  marketplaceDeadline?: number;
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
  fileTransport?: boolean;
  capabilityRevision?: number;
  dispatch?: WorkerDispatch | null;
  read?: WorkerDispatch | undefined;
  recoveryOnly: boolean;
  discovering: boolean;
  firstDiscovery: Promise<void>;
  finishStartup: () => void;
  awaitingListings: boolean;
  checkReady?: (signal?: AbortSignal, requirements?: JobAdmission) => Promise<() => void>;
  controller: AbortController;
  done: Promise<void>;
  state: EarnState;
  lastError: string | null;
  /** Set while the worker takes no new job after several failed in a row. */
  paused: string | null;
  /** The last job it could not fund: what its wallet must hold to take it. Cleared once a job starts. */
  fundingShort?: { task: string; requiredLamports: bigint; at: number } | null;
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
  readonly #privateProcessing: (agentId: string, task: Address) => Promise<string | null>;
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
    /** The processing the buyer approved in this job's verified private inputs, or null. */
    privateProcessing?: (agentId: string, task: Address) => Promise<string | null>;
  }) {
    this.#chain = deps.chain;
    this.#services = deps.services;
    this.#options = deps.options;
    this.#dataDir = deps.dataDir;
    this.#log = deps.log;
    this.#notify = deps.notify;
    this.#serves = deps.serves ?? (() => false);
    this.#ownAddresses = deps.ownAddresses ?? (() => []);
    this.#privateProcessing = deps.privateProcessing ?? (async () => null);
  }

  #defaultExecutor(): EarnExecutor | null {
    return this.#options.defaultExecutorEnabled?.() === false ? null : this.#options.executor;
  }

  /** Whether this host can run jobs at all. */
  get available(): boolean {
    return this.#defaultExecutor() !== null || Object.keys(this.#options.agentExecutors ?? {}).length > 0;
  }

  /** How this agent's jobs run: its own executor when the host named one, else the shared one. */
  executorFor(agentId: string): EarnExecutor | null {
    const own = this.#options.agentExecutors;
    return own !== undefined && Object.hasOwn(own, agentId) ? own[agentId]! : this.#defaultExecutor();
  }

  generationFor(agentId: string): string {
    const executor = this.executorFor(agentId);
    const supplied = Object.hasOwn(this.#options.agentExecutors ?? {},agentId)
      ? "" : this.#options.defaultExecutorGeneration?.() ?? "";
    return JSON.stringify([supplied,executor && commandGeneration(executor.argv,executor.readiness?.argv)]);
  }

  #usesClaude(agentId: string): boolean {
    return !Object.hasOwn(this.#options.agentExecutors ?? {}, agentId) && this.#options.liveRoomState?.().agent === "claude-code";
  }

  supportsService(agentId: string, needs: {privateInputs?: boolean; servicePin?: boolean}): boolean {
    const executor = this.executorFor(agentId);
    if (needs.servicePin && ["job","peer-job"].includes(executor?.argv[2] ?? "") && (!this.#services.fileLinkPrefix || this.#running.get(agentId)?.fileTransport === false)) return false;
    return !!executor && (executor.argv[2] !== "peer-job" || (needs.servicePin && !needs.privateInputs) === true) && (!needs.privateInputs || this.supportsPrivateInputs(agentId)) &&
      (!needs.servicePin || !this.#usesClaude(agentId));
  }

  /** Whether this agent's verified isolated room can receive B's private file handoff. */
  supportsPrivateInputs(agentId: string): boolean {
    const executor = this.executorFor(agentId);
    return executor?.argv[2] !== "peer-job" && !this.#usesClaude(agentId) && executor?.isolatedJobRoom === true && executor.mode === "sandboxed" && !this.ownJobsOnly &&
      this.#options.roomWork?.(agentId) !== undefined;
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

  capabilitiesChanged(agentId: string): void {
    const running = this.#running.get(agentId);
    if (running) running.capabilityRevision = (running.capabilityRevision ?? 0) + 1;
  }

  state(agentId: string): { state: EarnState; lastError: string | null } {
    const running = this.#running.get(agentId);
    return running === undefined
      ? { state: "off", lastError: null }
      : { state: running.state, lastError: running.lastError };
  }

  /** The job this agent could not fund, with what its wallet must hold to take it, or null. */
  fundingShort(agentId: string): { task: string; requiredLamports: bigint; at: number } | null {
    return this.#running.get(agentId)?.fundingShort ?? null;
  }

  /** Whether one of these agents could not fund this task the last time it tried it. */
  cannotFund(agentIds: readonly string[], task: string): boolean {
    return agentIds.some((agentId) => this.#running.get(agentId)?.fundingShort?.task === task);
  }

  /** Whether one of these agents took the task, gave it up and gave its claim back. */
  gaveBack(agentIds: readonly string[], task: string): boolean {
    return agentIds.some((agentId) => {
      try {
        return loadState(this.stateDir(agentId)).failedJobs.some((job) => job.task === task && job.claimReleased);
      } catch {
        return false;
      }
    });
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
        ...(evidence?.terms && { terms: evidence.terms }),
        ...(evidence?.marketplaceDeadline !== undefined && { marketplaceDeadline: evidence.marketplaceDeadline }),
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
        modelUsage: serviceUsage(this.stateDir(agentId), record.task),
        at: Date.parse(record.settledAt ?? record.submittedAt) || 0,
        resultHashHex: record.resultHashHex,
        resultUri: record.resultUri,
        request: evidence?.request ?? "",
        acceptance: evidence?.acceptance ?? [],
        ...(evidence?.terms && { terms: evidence.terms }),
        ...(evidence?.marketplaceDeadline !== undefined && { marketplaceDeadline: evidence.marketplaceDeadline }),
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

  get chosenRoom(): boolean {
    return this.chosenRoomFor();
  }

  chosenRoomFor(agentId?: string): boolean {
    const executor = agentId === undefined ? this.#defaultExecutor() : this.executorFor(agentId);
    return this.#options.chosenRoomEnabled?.() === true && !this.ownJobsOnly &&
      executor?.mode === "sandboxed" &&
      !!(executor.readiness || this.#options.checkExecutionReady);
  }

  hasChosenClaim(agentId: string): boolean {
    try {
      const state = loadState(this.stateDir(agentId));
      return state.openClaim?.chosen === true || !!pendingOwnerClaim(state);
    }
    catch (error) {
      this.#log(`earn ${agentId}: reading chosen work: ${describeError(error)}`);
      return false;
    }
  }

  /**
   * This wallet just paid a job one of its own agents delivered: read the
   * settlement now rather than at the next poll (rt11-b: the seller's row
   * still read "Delivered" about 70 s after the buyer paid). True when read.
   */
  async checkPaidNow(agentId: string, task: string): Promise<boolean> {
    if (!this.jobs(agentId).some((job) => job.task === task && job.state === "delivered")) return false;
    const dispatch = this.activeHeldLane(agentId, false);
    if (!dispatch) return false;
    await dispatch((ctx, worker) => checkSettlements(ctx, worker));
    return true;
  }

  workerLane(agentId: string, heldOnly = false, readonly = false): WorkerDispatch {
    const running = this.#running.get(agentId);
    const dispatch = readonly ? running?.read : running?.dispatch;
    if (!dispatch || (heldOnly ? !this.hasChosenClaim(agentId) : !this.chosenRoomFor(agentId) || !this.canTakeJobs(agentId))) {
      throw new WalletError("NOT_AVAILABLE", "Turn on Take jobs from other agents and Earns with a ready job room.");
    }
    return dispatch;
  }

  // A stopped or replacement wallet may have no executor at all. An owner
  // decision still uses the same claim journal lock and can never start a room.
  activeHeldLane(agentId: string, readonly: boolean): WorkerDispatch | undefined {
    const entry = this.#running.get(agentId);
    const dispatch = readonly ? entry?.read : entry?.dispatch;
    return dispatch && !entry?.controller.signal.aborted ? dispatch : undefined;
  }

  heldLane(agentId: string, signer: () => Promise<KeyPairSigner>, readonly: boolean): WorkerDispatch {
    const active = this.activeHeldLane(agentId, readonly);
    if (active) return active;
    return async work => {
      // Startup and shutdown can both hold the journal before a dispatch is available.
      const running = this.#running.get(agentId);
      if (running) {
        if (!running.controller.signal.aborted) await running.firstDiscovery;
        const dispatch = this.activeHeldLane(agentId, readonly);
        if (dispatch) return dispatch(work);
        if (running.controller.signal.aborted) await running.done;
        else if (this.#running.get(agentId) === running)
          throw new WalletError("NOT_AVAILABLE", "The worker is changing state. Try again.");
      }
      const stateDir = this.stateDir(agentId);
      const key = await signer();
      const prior = loadState(stateDir);
      const reconcile = !!(prior.openClaim?.chosenAttempt || prior.openClaim?.releaseRequestedAt || pendingOwnerClaim(prior));
      const unlock = readonly && !reconcile ? () => {} : acquireStateLock(stateDir);
      try {
        const state = loadState(stateDir);
        if ((!state.openClaim?.chosen && !pendingOwnerClaim(state)) || !state.agentIdHex) throw new Error("There is no chosen claim.");
        const agentIdBytes = hexToBytes(state.agentIdHex);
        const [agentPda] = await findAgentPda({ agentId: agentIdBytes });
        const agent = { agentId, signer: key, minRewardLamports: 0n };
        const ctx: WorkerContext = { ...this.#chainContext(agent, stateDir), config: this.#config(agent, []), log: () => {} };
        const registered = { agentId: agentIdBytes, agentPda, registered: true, justRegistered: false };
        if (reconcile) await resumeOpenClaim(ctx, registered);
        return await work(ctx, registered, this.#shutdown.signal);
      } finally { unlock(); }
    };
  }

  canTakeJobs(agentId: string): boolean {
    const entry = this.#running.get(agentId);
    return entry?.discovering === true && !entry.controller.signal.aborted && entry.paused === null;
  }

  listingsReconciled(agentId: string): void {
    const entry = this.#running.get(agentId);
    if (entry?.discovering) entry.awaitingListings = false;
  }

  async checkListingReady(agentId: string, signal?: AbortSignal, needs: {privateInputs?: boolean; servicePin?: boolean; serviceDigest?: string} = {}) {
    const entry = this.#running.get(agentId);
    if (!entry?.checkReady || !this.canTakeJobs(agentId)) throw new Error("Worker discovery is unavailable");
    return entry.checkReady(signal ? AbortSignal.any([signal,entry.controller.signal]) : entry.controller.signal, {
      source:"external",privateInputs:!!needs.privateInputs,servicePin:!!needs.servicePin,...(needs.serviceDigest && {serviceDigest:needs.serviceDigest}),reviewFiles:0,
      requiredFiles:[],allowTextOnly:true,fileTransport:!!this.#services.fileLinkPrefix,promptBytes:0,
    });
  }

  /** Whether this agent is only draining persisted work. */
  isRecovering(agentId: string): boolean {
    return this.#running.get(agentId)?.recoveryOnly === true;
  }

  /** Start (or keep) one loop. Recovery never enters the discovery path. */
  start(agent: EarnAgent, recoveryOnly = false): Promise<void> {
    const executor = this.executorFor(agent.agentId);
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
    entry.fileTransport = !!fileLinkPrefix;
    const outboxDir = path.join(stateDir, "outbox");
    if (fileLinkPrefix !== null) prepareOutbox(outboxDir);
    const fill = (part: string): string =>
      (part === "{roomCore}" ? this.#options.liveRoomState?.().coreCommand ?? "room-agent" : part)
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
          if (entry.fundingShort) {
            entry.fundingShort = null;
            this.#notify(agent.agentId, { type: "state" });
          }
          setState("working");
          break;
        case "task.funding-short": {
          // Nothing was claimed. The worker tries this job again on its own
          // once the money is there; Market says what is missing meanwhile.
          const required = typeof event.requiredLamports === "string" && /^\d+$/.test(event.requiredLamports) ? BigInt(event.requiredLamports) : null;
          if (required === null || typeof event.task !== "string") break;
          const before = entry.fundingShort;
          entry.fundingShort = { task: event.task, requiredLamports: required, at: Date.now() };
          if (before?.task !== event.task || before.requiredLamports !== required) {
            this.#log(fundingShortLogLine(agent.agentId, event.task, event.reason));
            this.#notify(agent.agentId, { type: "state" });
          }
          break;
        }
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
            (cause === "attempts" || cause === "expired" || cause === "cancelled" || cause === "released")
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

    const generation = () => this.generationFor(agent.agentId);
    const executorIdentity = () => {
      if (executor.argv[2] === "peer-job") {
        if (executor.argv[4]?.startsWith("pair:")) return executor.argv[4];
        const profile = executor.argv[3];
        if (profile && path.isAbsolute(profile)) {
          const stat = statSync(profile, {bigint:true});
          return ["peer-file",stat.dev,stat.ino,stat.ctimeNs].join(":");
        }
        return "peer:" + generation();
      }
      if (this.#usesClaude(agent.agentId)) return "claude-code";
      if (executor.argv[2] === "job") return "core";
      return "command:" + createHash("sha256").update(JSON.stringify(executor.argv)).digest("hex");
    };
    const guard = () => {
      const selected = generation();
      return () => {
        if (this.executorFor(agent.agentId) !== executor || selected !== generation())
          throw new Error("This job room is no longer selected.");
      };
    };
    const checkReady = async (signal?: AbortSignal, requested?: JobAdmission, preview = false) => {
      const admission = requested && { ...requested, fileTransport: requested.fileTransport && !!fileLinkPrefix };
      const current = guard();
      const named = Object.hasOwn(this.#options.agentExecutors ?? {},agent.agentId);
      current();
      let hostCheck: void | (() => void);
      const check = () => {
        signal?.throwIfAborted();
        current();
        if (named) checkNamedProgram(executor.argv);
        if (hostCheck) hostCheck();
        if (!admission) return;
        if (admission.deadlineMs !== undefined && monotonicMs() >= admission.deadlineMs) throw new Error("The claim deadline passed.");
        if (!admission.fileTransport && (admission.requiredFiles.length || !admission.allowTextOnly ||
            (admission.servicePin && ["job", "peer-job"].includes(executor.argv[2] ?? ""))))
          throw new ExecutorCapabilityError("This job needs file delivery.");
        if (!this.supportsService(agent.agentId,admission) || ((this.#usesClaude(agent.agentId) || executor.argv[2] === "peer-job") && admission.reviewFiles))
          throw new ExecutorCapabilityError("This job needs tools the selected room cannot use.");
        if (this.#usesClaude(agent.agentId) && admission.firstRoundCents !== undefined &&
          (admission.promptBytes + MINIMUM_MESSAGE_BYTES + 64) * 40 + 100 > admission.firstRoundCents * 200_000)
          throw Object.assign(new Error("The first model turn exceeds this job's allowance."), {name:"ExecutorBudgetError"});
      };
      check();
      if (preview) return check;
      if (this.#options.checkExecutionReady !== undefined) {
        hostCheck = await this.#options.checkExecutionReady({agentId:agent.agentId,...(signal && {signal}),...(admission && {admission})});
      } else if (executor.readiness !== undefined) {
        await runExecutor({
          argv: [...executor.readiness.argv.map(fill), ...(admission && executor.readiness.argv[2] === "self-test" ?
            ["admit",admission.source,admission.privateInputs ? "private" : admission.servicePin ? "service" : "public"] :
            executor.readiness.argv[2] === "peer-ready" && admission?.serviceDigest ? [admission.serviceDigest] : [])],
          timeoutMs: executor.readiness.timeoutMs ?? 30_000,
          envAllowlist: executor.envAllowlist,
          maxStdoutBytes: 64 * 1024,
          ...(signal === undefined ? {} : { signal }),
        });
      } else if (executor.mode === "sandboxed") {
        throw new Error("The host must configure a job room readiness self-test before taking jobs.");
      }
      check();
      return check;
    };
    entry.checkReady = checkReady;

    const termsFor = (metadata?: Uint8Array | null): Partial<SellerTerms> => {
      if (!metadata) return {};
      const terms = JSON.parse(Buffer.from(metadata).toString("utf8")).custom?.listingMetadata?.fulfilment;
      if (terms === undefined) return {};
      if (!terms || typeof terms !== "object" || (terms.servicePin !== undefined && !validServicePin(terms.servicePin)))
        throw new Error("The hired service has invalid fulfilment terms.");
      return terms;
    };
    const roomWork = executor.isolatedJobRoom && executor.mode === "sandboxed" ? this.#options.roomWork?.(agent.agentId) : undefined;
    const ctx: WorkerContext = {
      ...this.#chainContext(agent, stateDir),
      chosenRoomCurrent:()=>this.chosenRoomFor(agent.agentId),
      executorIdentity, capabilityRefusals:new Map(), budgetRefusals:new Map(), revisionRefusals:new Map(),
      ...(roomWork && { roomWork }),
      admissionGeneration: () => String(generation() ?? "configured") + "/" + (entry.capabilityRevision ?? 0),
      ...(agent.admitsListing && { admitsListing: agent.admitsListing }),
      ...(agent.chooseOpenJobs && { chooseOpenJobs: agent.chooseOpenJobs }),
      onWorkerReady: (dispatch, read) => { entry.dispatch = dispatch; entry.read = read; },
      ...(!entry.recoveryOnly && !this.ownJobsOnly && executor.mode === "sandboxed" &&
        this.#options.chosenRoomEnabled && (executor.readiness || this.#options.checkExecutionReady) ? {
        withChosenRoom: async (work) => {
          const stop = new AbortController();
          const revoke = () => stop.abort(new Error("Taking jobs from other agents is off."));
          const current = AbortSignal.any([stop.signal, signal, this.#shutdown.signal]);
          const unwatch = this.#options.watchChosenRoom?.(revoke);
          const selected = guard();
          const check = () => {
            try { selected(); if (!this.chosenRoomFor(agent.agentId)) revoke(); }
            catch { revoke(); }
          };
          const timer = setInterval(check, 25);
          try {
            check();
            current.throwIfAborted();
            return await work(current);
          } finally { clearInterval(timer); unwatch?.(); }
        },
        checkChosenRoom: async (scope?: AbortSignal) => {
          if (!this.chosenRoomFor(agent.agentId)) throw new Error("Taking jobs from other agents is off.");
          signal.throwIfAborted();
          await checkReady(scope ?? signal);
          if (!this.chosenRoomFor(agent.agentId)) throw new Error("Taking jobs from other agents is off.");
          signal.throwIfAborted();
        },
      } : {}),
      acceptServiceHiresBelowMinReward: true,
      ...(executor.isolatedJobRoom && executor.mode === "sandboxed" && { reviewRoom: { fileProblem: deliveryFileProblem, execute: this.#options.runReviewRoom ?? runExecutor } }),
      modelSpendDir: path.resolve(this.#dataDir, "..", "model-spend"),
      reserveAtLaunch: true,
      reserveRevisionBudget: executor.reserveRevisionBudget === true,
      modelBudgetForTask: async (task, _address, metadata) => {
        const rate = await agent.solUsd?.() ?? null;
        const terms = metadata ? termsFor(metadata) : agent.specialistTerms?.(task.requiredCapabilities);
        if (!terms) return jobPayCents(task.rewardAmount, rate);
        return serviceEconomics({
          priceLamports: task.rewardAmount, usdPerSol: rate, marketFeeBps: task.protocolFeeBps,
          operatorFeeBps: task.operatorFeeBps, referrerFeeBps: task.referrerFeeBps,
          ...(terms.minimumMarginCents !== undefined && { minimumMarginCents: terms.minimumMarginCents }),
          ...(terms.modelCapCents !== undefined && { modelCapCents: terms.modelCapCents }),
        }).modelBudgetCents;
      },
      executorForTask: async (task, address, reservedCents, listing, metadata, request, acceptance, budgetTotalCents, claimExpires, claimRound, beforeLaunch, earlierDeadlineMs) => {
        // The room enforces the public job's agreed outputs on export. A private job's are in its staged bundle.
        const outputs = acceptance ? outputAgreementFromSpec({ acceptance: [...acceptance] }) : undefined;
        const ownRequest = this.#ownAddresses().includes(task.creator);
        const room = executor.isolatedJobRoom === true && executor.mode === "sandboxed";
        if (!ownRequest && (listing || metadata || this.ownJobsOnly) && !room)
          throw new Error("This buyer's hire requires the isolated job room.");
        const pin = (metadata ? termsFor(metadata) : agent.specialistTerms?.(task.requiredCapabilities))?.servicePin;
        if (pin && (!room || !executor.argv.includes("{requestSource}")))
          throw new Error("This service requires the rehearsed room.");
        const paired = executor.argv[2] === "peer-job";
        if (paired) {
          if (!room || !pin || executor.readiness?.argv[2] !== "peer-ready")
            throw new Error("The paired room cannot serve this job.");
          if (reservedCents === undefined)
            await runExecutor({ argv: [...executor.readiness.argv.map(fill), pin.digest], timeoutMs: executor.readiness.timeoutMs ?? 30000,
              envAllowlist: executor.envAllowlist, signal });
        }
        const bundleDir = pin && !paired ? readServiceRehearsal(stateDir, pin) : null;
        if (pin && bundleDir && reservedCents === undefined) {
          const argv = executor.readiness?.argv;
          if (!argv || argv[2] !== "self-test" || !argv[0] || !argv[1] || !argv[3])
            throw new Error("This service needs image verification before claim.");
          await runExecutor({ argv: [argv[0], argv[1], "verify-service", argv[3], bundleDir, JSON.stringify(pin)],
            timeoutMs: 30000, envAllowlist: executor.envAllowlist, signal });
        }
        const pay = reservedCents ?? jobPayCents(task.rewardAmount, await agent.solUsd?.() ?? null);
        // D's paired peer gets the verified request, usage reservation and the buyer-approved processing (or null).
        const privateProcessing = paired ? await this.#privateProcessing(agent.agentId, address).catch(() => null) : undefined;
        const deadline = executor.argv.includes("{jobDeadline}") ? Math.min(earlierDeadlineMs ?? Infinity,
          await chainDeadline(() => this.#chain.clusterTime(),executor.timeoutMs,task.deadline,claimExpires ?? 0n)) : earlierDeadlineMs;
        let legacyExpiry: bigint | undefined;
        if (executor.argv.includes("{jobExpires}")) {
          const ends = [task.deadline, claimExpires ?? 0n].filter(time => time > 0n);
          legacyExpiry = ends.length ? ends.reduce((a, b) => a < b ? a : b)
            : BigInt(await this.#chain.clusterTime()) + BigInt(Math.floor(executor.timeoutMs / 1000));
        }
        if (deadline !== undefined && monotonicMs() >= deadline) throw new Error("The claim expired.");
        if (claimRound) requireClaimExecutor(path.dirname(claimRound),executorIdentity());
        if (claimRound && (executor.argv[2] === "job" || executor.argv[2] === "peer-job")) indexClaimUsage(stateDir,address,claimRound);
        beforeLaunch?.();
        const receipt = reservedCents ? reserveServiceRun(stateDir,address,reservedCents) : null;
        if (receipt && budgetTotalCents) recordServiceBudget(stateDir,address,budgetTotalCents);
        return executor.argv.flatMap(part => {
          if (part === "{jobDeadline}") return ["boot:" + deadline];
          if (part === "{requestSource}") {
            const source = ownRequest ? "own" : "external";
            // The agreed outputs alone also need the scope, so a public post without a reservation still enforces them.
            return room && (receipt || bundleDir || (paired && pin) || outputs) ? [source, JSON.stringify({ bundleDir, pin: pin ?? null, receipt, ...(claimRound && {claimRound, executor:executorIdentity()}), hardBudget: !!listing || !!pin, task: address, ...(pin && { request }),
              ...(paired && { privateProcessing: privateProcessing ?? null }), ...(outputs && { outputs }) })] : [source];
          }
          if (part === "{task}") return [address];
          if (part === "{servicePin}") {
            if (!pin) throw new Error("The paired service requires a verified service pin.");
            return [pin.digest];
          }
          if (part === "{jobExpires}") return [legacyExpiry!.toString()];
          return [fill(part).replaceAll("{pay}", String(pay))];
        });
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
      checkExecutionReady: async ({ listing, signal, creator, listingMetadata, privateInputs, requiredCapabilities,
        acceptance, promptBytes, firstRoundCents, deadlineMs, reviewFiles, preview }) => {
        if (!listing && entry.awaitingListings) throw new Error("Services are still being reconciled.");
        const terms = listingMetadata ? termsFor(listingMetadata) : agent.specialistTerms?.(requiredCapabilities ?? 0n);
        const outputs = acceptance && outputAgreementFromSpec({acceptance:[...acceptance]});
        return checkReady(signal, creator ? {
          source:this.#ownAddresses().includes(creator) ? "own" : "external", privateInputs:!!privateInputs,
          servicePin:!!terms?.servicePin,...(terms?.servicePin && {serviceDigest:terms.servicePin.digest}),reviewFiles:reviewFiles ?? 0,requiredFiles:outputs?.requiredFiles ?? [],
          allowTextOnly:outputs?.allowTextOnly ?? true,fileTransport:!!fileLinkPrefix,promptBytes:promptBytes ?? 0,
          ...(firstRoundCents !== undefined && {firstRoundCents}),...(deadlineMs !== undefined && {deadlineMs}),
        } : undefined,preview);
      },
      ...(uploader !== null
        ? { uploadFetch: fileLinkPrefix === null ? uploader.fetch : publishingOutbox(uploader.fetch, outboxDir) }
        : {}),
      ...(this.#services.resolveAgencUri !== undefined
        ? { resolveAgencUri: this.#services.resolveAgencUri }
        : {}),
      ...(this.#services.fileLinkPrefix ? { readReviewArtifact: (hash: string) => this.#services.fetchFile(hash) } : {}),
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
      const revision = entry.capabilityRevision;
      const choosing = agent.chooseOpenJobs?.();
      if (agent.currentCapabilities) ctx.config.capabilities = await agent.currentCapabilities();
      const refresh = setInterval(
        () => {
          // An own-jobs loop also starts afresh, to learn of agents added since.
          if (choosing !== agent.chooseOpenJobs?.() || (revision !== entry.capabilityRevision && !this.hasUnfinishedJob(agent.agentId))) run.abort();
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
      let queue: Promise<unknown> = Promise.resolve();
      const serial = <T>(work: () => Promise<T>) => {
        const result = queue.then(work);
        queue = result.catch(() => {});
        return result;
      };
      entry.read = async read => { signal.throwIfAborted(); return read(ctx, worker, signal); };
      entry.dispatch = work => serial(() => { signal.throwIfAborted(); return work(ctx, worker, signal); });
      entry.finishStartup();
      const upkeepMemory: UpkeepMemory = new Map();
      while (!signal.aborted) {
        try {
          await serial(async () => {
            await checkSettlements(ctx, worker);
            await resumeOpenClaim(ctx, worker);
            await runUpkeep(ctx, worker, upkeepMemory);
            await checkSettlements(ctx, worker);
          });
        } catch (error) {
          this.#log(`earn ${agent.agentId}: recovering: ${describeError(error)}`);
        }
        const state = loadState(ctx.stateDir);
        if (state.openClaim === null && state.failedJobs.every((job) => job.claimReleased)) return;
        await delay(ctx.config.pollIntervalMs, undefined, { signal }).catch(() => undefined);
      }
      entry.dispatch = null;
      await queue;
    } finally {
      release();
    }
  }

  /** The worker settings every run for this agent shares. */
  #config(agent: EarnAgent, argv: string[]): WorkerContext["config"] {
    const executor = this.executorFor(agent.agentId);
    const maxReward =
      this.#options.maxRewardLamports === undefined
        ? DEFAULT_MAX_REWARD_LAMPORTS
        : this.#options.maxRewardLamports;
    return {
      capabilities: agent.capabilities ?? 1n,
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
      ...(this.#chain.simulateWork && { simulateWork: (ix, guards) => this.#chain.simulateWork!(agent.signer.address, ix, guards) }),
      ...(this.#chain.workOutcome && { chosenOutcome: receipt => this.#chain.workOutcome!(receipt) }),
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
