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
import type { Address, KeyPairSigner } from "@solana/kit";
import { findAgentPda, getAgentRegistrationDecoder } from "@tetsuo-ai/marketplace-sdk";
import {
  claimFundingRequirement,
  DEFAULT_ENDPOINT,
  hexToBytes,
  loadState,
  readClaimAccountRentMinimums,
  readMinAgentStake,
  registrationFundingRequirement,
  runUp,
  type ExecutorMode,
  type WorkerContext,
  type WorkerLogEvent,
} from "@tetsuo-ai/agenc-worker";
import type { Chain } from "./chain.js";
import type { EarnState } from "./client/types.js";
import { describeError } from "./errors.js";
import type { MarketServices } from "./services.js";

/** The program the worker hands each job to. */
export interface EarnExecutor {
  /**
   * Command and arguments; one element must be exactly "{prompt}". Wherever
   * "{agent}" appears it is replaced with the id of the agent doing the job,
   * so a host can give each agent its own working folder.
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
   * be looked at again, and nobody else can take it. Default one minute.
   */
  serviceRefreshMs?: number;
}

export interface EarnAgent {
  agentId: string;
  signer: KeyPairSigner;
  /** Skip jobs that pay less than this. */
  minRewardLamports: bigint;
}

/** One job the agent took, as the worker's own ledger records it. */
export interface EarnedJob {
  task: string;
  rewardLamports: bigint;
  state: "working" | "delivered" | "paid" | "not_paid";
  earnedLamports: bigint | null;
  at: number;
  resultHashHex: string | null;
  settlementSignature: string | null;
}

export type EarnNotice =
  | { type: "state" }
  | { type: "paid"; task: string; earnedLamports: bigint; signature: string | null };

const DEFAULT_MAX_REWARD_LAMPORTS = 1_000_000_000n;
const RESTART_DELAY_MS = 20_000;
const DEFAULT_SERVICE_REFRESH_MS = 60_000;

interface Running {
  controller: AbortController;
  done: Promise<void>;
  state: EarnState;
  lastError: string | null;
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

  state(agentId: string): { state: EarnState; lastError: string | null } {
    const running = this.#running.get(agentId);
    return running === undefined
      ? { state: "off", lastError: null }
      : { state: running.state, lastError: running.lastError };
  }

  /**
   * Lamports the agent's wallet needs before it can register and take its
   * first job: the marketplace's stake, the deposits behind its registration
   * and one job, and fee headroom. The stake and deposits come back.
   */
  async startupRequirement(): Promise<bigint> {
    const stake = await readMinAgentStake(this.#chain.readAccount);
    const rent = (space: number) => this.#chain.getMinimumBalanceForRentExemption(space);
    const [agent, claim, submission] = await Promise.all([rent(566), rent(203), rent(273)]);
    return registrationFundingRequirement(stake, { agent, claim, submission });
  }

  /**
   * Lamports the worker wants in the agent's wallet before it takes a job:
   * the deposits behind the job's records (they come back) and fee headroom.
   */
  async jobReserve(): Promise<bigint> {
    return claimFundingRequirement(
      await readClaimAccountRentMinimums((space) =>
        this.#chain.getMinimumBalanceForRentExemption(space),
      ),
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
   * Lamports locked as this agent's marketplace deposit (its stake), or 0
   * when it has never registered.
   */
  async setAside(agentId: string): Promise<bigint> {
    const agent = await this.marketplaceAgent(agentId);
    if (agent === null) return 0n;
    const data = await this.#chain.readAccount(agent);
    if (data === null) return 0n;
    try {
      return getAgentRegistrationDecoder().decode(data).stake;
    } catch {
      return 0n;
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
      jobs.push({
        task: state.openClaim.task,
        rewardLamports: 0n,
        state: "working",
        earnedLamports: null,
        at: Date.parse(state.openClaim.claimedAt) || 0,
        resultHashHex: null,
        settlementSignature: null,
      });
    }
    for (const record of state.submissions) {
      const earned =
        record.earnedLamports === undefined || record.earnedLamports === null
          ? null
          : BigInt(record.earnedLamports);
      jobs.push({
        task: record.task,
        rewardLamports: BigInt(record.rewardAmount),
        state: !record.settled ? "delivered" : record.outcome === "accepted" ? "paid" : "not_paid",
        earnedLamports: earned,
        at: Date.parse(record.settledAt ?? record.submittedAt) || 0,
        resultHashHex: record.resultHashHex,
        settlementSignature: record.settlementSignature ?? null,
      });
    }
    return jobs.sort((a, b) => b.at - a.at);
  }

  /** Start (or keep) the loop for one agent. */
  start(agent: EarnAgent): void {
    const executor = this.#options.executor;
    if (executor === null || this.#running.has(agent.agentId)) return;
    const controller = new AbortController();
    const entry: Running = {
      controller,
      done: Promise.resolve(),
      state: "starting",
      lastError: null,
    };
    this.#running.set(agent.agentId, entry);
    entry.done = this.#loop(agent, executor, entry).finally(() => {
      if (this.#running.get(agent.agentId) === entry) this.#running.delete(agent.agentId);
      this.#notify(agent.agentId, { type: "state" });
    });
    this.#notify(agent.agentId, { type: "state" });
  }

  async stop(agentId: string): Promise<void> {
    const entry = this.#running.get(agentId);
    if (entry === undefined) return;
    entry.controller.abort();
    await entry.done;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#running.keys()].map((agentId) => this.stop(agentId)));
  }

  async #loop(agent: EarnAgent, executor: EarnExecutor, entry: Running): Promise<void> {
    const signal = entry.controller.signal;
    const stateDir = this.stateDir(agent.agentId);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const uploader = this.#services.resultUploader(agent.signer);
    const maxReward =
      this.#options.maxRewardLamports === undefined
        ? DEFAULT_MAX_REWARD_LAMPORTS
        : this.#options.maxRewardLamports;

    const setState = (state: EarnState, lastError: string | null = null): void => {
      if (entry.state === state && entry.lastError === lastError) return;
      entry.state = state;
      entry.lastError = lastError;
      this.#notify(agent.agentId, { type: "state" });
    };

    const log = (event: WorkerLogEvent): void => {
      switch (event.event) {
        case "task.claimed":
        case "task.resuming-open-claim":
        case "task.resuming-executed-result":
        case "task.resuming-submission":
          setState("working");
          break;
        case "task.execution-failed":
        case "task.claim-failed":
        case "task.upload-failed":
          this.#log(`earn ${agent.agentId}: ${event.event} ${String(event.reason ?? "")}`);
          setState("watching");
          break;
        case "settlement.observed": {
          setState("watching");
          const earned =
            typeof event.earnedLamports === "string" ? BigInt(event.earnedLamports) : 0n;
          if (event.outcome === "accepted" && earned > 0n && typeof event.task === "string") {
            this.#notify(agent.agentId, {
              type: "paid",
              task: event.task,
              earnedLamports: earned,
              signature:
                typeof event.settlementSignature === "string" ? event.settlementSignature : null,
            });
          }
          break;
        }
        case "sweep.candidates":
          if (entry.state === "starting") setState("watching");
          break;
        case "task.processing-error":
        case "task.job-spec-rejected":
        case "task.prompt-rejected":
          // A job it could not take. Said once, so the log explains a hire
          // that sat unstarted.
          this.#log(`earn ${agent.agentId}: ${event.event} ${String(event.reason ?? "").slice(0, 300)}`);
          break;
        default:
          break;
      }
      // Everything the worker decides, for diagnosing why a job was not taken.
      if (process.env.AGENC_WALLET_EARN_DEBUG === "1") {
        this.#log(`earn ${agent.agentId}: ${JSON.stringify(event)}`);
      }
    };

    const ctx: WorkerContext = {
      config: {
        capabilities: 1n,
        minRewardLamports: agent.minRewardLamports,
        maxRewardLamports: maxReward,
        allowUnboundedReward: maxReward === null,
        executor: executor.argv.map((part) => part.replaceAll("{agent}", agent.agentId)),
        executorMode: executor.mode,
        executorEnvAllowlist: executor.envAllowlist,
        resultUploader: uploader?.url ?? null,
        creatorAllowlist: null,
        allowAnyCreator: true,
        endpoint: this.#options.endpoint ?? DEFAULT_ENDPOINT,
        executorTimeoutMs: executor.timeoutMs,
        pollIntervalMs: this.#options.pollIntervalMs ?? 15_000,
      },
      client: this.#chain.clientFor(agent.signer),
      signer: agent.signer,
      gpa: this.#chain.gpa,
      readAccount: (account: Address) => this.#chain.readAccount(account),
      readAccountInfo: this.#chain.readAccountInfo,
      stateDir,
      log,
      getBalance: (account) => this.#chain.getBalance(account),
      getMinimumBalanceForRentExemption: (space) =>
        this.#chain.getMinimumBalanceForRentExemption(space),
      ...(uploader !== null ? { uploadFetch: uploader.fetch } : {}),
      ...(this.#services.resolveAgencUri !== undefined
        ? { resolveAgencUri: this.#services.resolveAgencUri }
        : {}),
      ...(this.#services.taskThreadTransport !== undefined
        ? { taskThreadTransport: this.#services.taskThreadTransport }
        : {}),
      ...(this.#chain.findSettlementSignature !== undefined
        ? { findSettlementSignature: (task) => this.#chain.findSettlementSignature!(task) }
        : {}),
    };

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
