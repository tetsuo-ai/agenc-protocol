// The wallet's journal: agents, jobs, approvals and the activity list, in one
// private JSON file that is rewritten atomically on every change.
//
// The journal is what makes the service crash-safe. A job's intent (which
// service, which task address, what price) is written BEFORE any transaction
// is sent, so after a restart the service can look at the chain and finish or
// fail the job instead of guessing.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import type {
  ActivityKind,
  AgentPolicy,
  JobResult,
  ServiceView,
} from "./client/types.js";
import { WalletError } from "./errors.js";
import { readPrivateFile, writePrivateFileAtomic } from "./vault.js";

export const STATE_VERSION = 1;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVITY = 1_000;
const MAX_FINISHED_JOBS = 500;

export interface AgentRecord {
  id: string;
  name: string;
  /** Vault key id holding this agent's wallet. */
  keyId: string;
  address: string;
  createdAt: number;
  policy: AgentPolicy;
  /** Lifetime lamports paid to providers. */
  spentLamports: string;
  /** Lifetime lamports earned as a provider. */
  earnedLamports: string;
  /** Automatic top-ups in the last day, for the per-day rule. */
  refills: { ts: number; lamports: string }[];
  earn: {
    enabled: boolean;
    minPayCents: number;
    jobsDone: number;
    lastError: string | null;
  };
}

/**
 * How far a purchase has got.
 *
 * needs_approval -> (declined) | cleared -> hiring -> hired -> active -> done
 *
 * "hiring" means a hire transaction may have been sent; only the chain says
 * whether it landed. "failed" always means no money left the wallet.
 */
export type JobPhase =
  | "needs_approval"
  | "declined"
  | "cleared"
  | "hiring"
  | "hired"
  | "active"
  | "done"
  | "failed";

export type ChainTaskStatus =
  | "open"
  | "in_progress"
  | "pending_validation"
  | "completed"
  | "cancelled"
  | "disputed"
  | "reject_frozen";

export interface JobRecord {
  id: string;
  role: "buying" | "working";
  agentId: string;
  createdAt: number;
  updatedAt: number;
  idempotencyKey: string | null;

  listing: string;
  providerAgent: string;
  title: string;
  request: string;
  acceptance: string[];
  priceLamports: string;

  /** Listing terms the hire is pinned to (compare-and-swap on-chain). */
  expectedVersion: string;
  listingSpecHashHex: string;

  /**
   * Which wallet pays. "agent": the agent's own allowance. "main": the main
   * balance, after a person approved a hire the allowance could not cover.
   * Null until the job is cleared to proceed.
   */
  payer: "agent" | "main" | null;
  /** Random per job; with the payer's address it fixes the task address. */
  taskIdHex: string;
  /** The task address, known once the payer is. */
  task: string | null;
  /** The job spec committed at hire time and pinned at activation. */
  jobSpec: Record<string, unknown>;
  jobSpecHashHex: string;
  jobSpecUri: string | null;

  phase: JobPhase;
  /** When the hire transaction was first handed to the network. */
  hireAttemptAt: number | null;
  /** When the task was confirmed to exist (start of the posting clock). */
  hiredAt: number | null;

  chainStatus: ChainTaskStatus | null;
  /** Unix seconds: the provider's deadline. */
  deadline: number | null;
  /** Unix seconds: when an unreviewed delivery pays out by itself. */
  reviewDeadlineAt: number | null;
  /** Unix ms: when a job nobody started is refunded by itself. */
  autoRefundAt: number | null;
  outcome: "paid" | "refunded" | "problem" | null;
  changesRequested: boolean;
  result: JobResult | null;
  rating: number | null;
  /** The finished job's deposits were collected and its slot released. */
  tidied: boolean;
  signatures: {
    hire?: string;
    activate?: string;
    accept?: string;
    cancel?: string;
    changes?: string;
    rate?: string;
    close?: string;
  };
  changes: { note: string; hashHex: string; ts: number }[];
  error: string | null;
}

export interface ApprovalRecord {
  id: string;
  jobId: string;
  agentId: string;
  service: ServiceView;
  request: string;
  priceLamports: string;
  depositsLamports: string;
  /** The part of the deposits that is never returned. */
  keptLamports: string;
  fromMainLamports: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "declined" | "expired";
}

export interface ActivityRecord {
  id: string;
  ts: number;
  kind: ActivityKind;
  text: string;
  lamports: string | null;
  agentId: string | null;
  jobId: string | null;
  signature: string | null;
}

export interface WalletState {
  version: number;
  createdAt: number;
  agents: Record<string, AgentRecord>;
  jobs: Record<string, JobRecord>;
  approvals: Record<string, ApprovalRecord>;
  activity: ActivityRecord[];
  /** Last known dollars-per-SOL, kept so an offline start can still estimate. */
  lastSolUsd: { value: number; ts: number } | null;
  /** Main-balance lamports last seen, to notice money arriving. */
  lastMainLamports: string | null;
}

function emptyState(now: number): WalletState {
  return {
    version: STATE_VERSION,
    createdAt: now,
    agents: {},
    jobs: {},
    approvals: {},
    activity: [],
    lastSolUsd: null,
    lastMainLamports: null,
  };
}

function isFinished(job: JobRecord): boolean {
  return (
    job.phase === "declined" ||
    job.phase === "failed" ||
    (job.phase === "done" && job.tidied)
  );
}

/** Keep the file bounded: old finished jobs and old activity fall off. */
function prune(state: WalletState): void {
  if (state.activity.length > MAX_ACTIVITY) {
    state.activity = state.activity.slice(state.activity.length - MAX_ACTIVITY);
  }
  const finished = Object.values(state.jobs)
    .filter(isFinished)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
    delete state.jobs[job.id];
  }
  const liveJobs = new Set(Object.keys(state.jobs));
  for (const approval of Object.values(state.approvals)) {
    if (approval.status !== "pending" && !liveJobs.has(approval.jobId)) {
      delete state.approvals[approval.id];
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Folders this process already has open (a pid check cannot see those). */
const heldHere = new Set<string>();

/** Take the one-service-per-folder lock. Returns the release function. */
export function acquireServiceLock(directory: string): () => void {
  const file = path.join(directory, "service.lock");
  if (heldHere.has(file)) {
    throw new WalletError(
      "BUSY",
      "The wallet is already open in another program on this computer.",
    );
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      heldHere.add(file);
      return () => {
        if (released) return;
        released = true;
        heldHere.delete(file);
        try {
          unlinkSync(file);
        } catch {
          // Already removed.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = Number.NaN;
      try {
        owner = Number(readFileSync(file, "utf8").trim());
      } catch {
        // Unreadable lock: treat as stale below.
      }
      if (Number.isSafeInteger(owner) && owner > 0 && owner !== process.pid && processIsAlive(owner)) {
        throw new WalletError(
          "BUSY",
          "The wallet is already open in another program on this computer.",
        );
      }
      try {
        unlinkSync(file);
      } catch {
        // Lost a race with another starter; the retry settles it.
      }
    }
  }
  throw new WalletError("BUSY", "The wallet is already open in another program on this computer.");
}

export class StateStore {
  readonly #file: string;
  #state: WalletState;

  private constructor(file: string, state: WalletState) {
    this.#file = file;
    this.#state = state;
  }

  static open(file: string, now: number = Date.now()): StateStore {
    if (!existsSync(file)) {
      const store = new StateStore(file, emptyState(now));
      store.#save();
      return store;
    }
    let parsed: WalletState;
    try {
      parsed = JSON.parse(readPrivateFile(file, MAX_STATE_BYTES)) as WalletState;
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError("INTERNAL", "The wallet's records are damaged.", { cause: error });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.version !== STATE_VERSION ||
      typeof parsed.agents !== "object" ||
      typeof parsed.jobs !== "object" ||
      typeof parsed.approvals !== "object" ||
      !Array.isArray(parsed.activity)
    ) {
      throw new WalletError(
        "INTERNAL",
        "The wallet's records are from a version this build cannot read.",
      );
    }
    return new StateStore(file, parsed);
  }

  /** A read-only view. Never mutate it; go through {@link update}. */
  get state(): Readonly<WalletState> {
    return this.#state;
  }

  /**
   * Apply a change and persist it before returning. The mutator works on a
   * copy; if it throws or the write fails, memory keeps the previous state.
   */
  update<T>(mutator: (draft: WalletState) => T): T {
    const draft = structuredClone(this.#state);
    const result = mutator(draft);
    prune(draft);
    const previous = this.#state;
    this.#state = draft;
    try {
      this.#save();
    } catch (error) {
      this.#state = previous;
      throw new WalletError("INTERNAL", "The wallet could not save its records.", { cause: error });
    }
    return result;
  }

  #save(): void {
    writePrivateFileAtomic(this.#file, JSON.stringify(this.#state));
  }
}
