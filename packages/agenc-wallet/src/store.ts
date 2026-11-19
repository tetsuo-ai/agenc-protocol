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

/**
 * A service an earning agent offers for others to hire.
 *
 * The record says what the person WANTS on offer. What is actually on the
 * marketplace is read from the chain on every housekeeping pass and brought
 * in line one step at a time, so a crash between steps loses nothing.
 */
export interface OfferRecord {
  /** Random per offer; with the agent's marketplace address it fixes the listing address. */
  listingIdHex: string;
  /** The listing address, known once the agent is registered on the marketplace. */
  listing: string | null;
  /** True once the listing was seen on-chain. Its deposit is paid from then on. */
  listed: boolean;
  /** Fixed once the listing exists (the marketplace does not rename listings). */
  name: string;
  summary: string;
  category: string;
  priceLamports: string;
  /** Seconds the agent gets to deliver a hired job. */
  deliverySecs: number;
  /** The advertised description, and the hash of it the listing commits to. */
  spec: Record<string, unknown>;
  specHashHex: string;
  /** Where that description was published, once it has been. The listing points here. */
  specUri?: string | null;
  /** False once the person withdrew the offer; the listing is then kept paused. */
  wanted: boolean;
  /** What the last housekeeping pass found. */
  status: "getting_ready" | "being_checked" | "live" | "paused" | "problem";
  /** A plain sentence when `status` is "problem". */
  error: string | null;
  /** When the marketplace's safety check was last asked, to space out retries. */
  lastCheckAt: number | null;
  /**
   * The sentence the safety check refused this exact description with. It is
   * not asked again until the description changes.
   */
  refused: string | null;
  /**
   * When this wallet last signed and sent a payment for the safety check. A
   * payment that may still be on its way is not made a second time.
   */
  approvalAttemptAt?: number | null;
  signatures: { create?: string; update?: string; state?: string; approval?: string };
}

export interface AgentRecord {
  id: string;
  name: string;
  /**
   * Where the host uses this agent, in the host's own words: a project
   * folder, say. The wallet stores it and gives it back, nothing more. At
   * most one agent has a given scope.
   */
  scope?: string | null;
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
    /** Absent in journals written before offers existed; treat as null. */
    offer?: OfferRecord | null;
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
  /**
   * The job's request as providers read it, its hash and where it is
   * published. A draft until the job is cleared: the request is published
   * then, before any money moves, and the hire commits to that hash.
   */
  jobSpec: Record<string, unknown>;
  jobSpecHashHex: string;
  jobSpecUri: string | null;

  phase: JobPhase;
  /** When the hire transaction was first handed to the network. */
  hireAttemptAt: number | null;
  /** Times the network was too busy to take the hire at all. It is sent again a few times. */
  hireRetries?: number;
  /** When the task was confirmed to exist (start of the posting clock). */
  hiredAt: number | null;
  /**
   * When this wallet last signed and sent a payment for the safety check of
   * the job's request. A payment that may still be on its way is not made a
   * second time.
   */
  approvalAttemptAt?: number | null;

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
  /**
   * Whether the provider already has its marketplace record of turn-downs,
   * read once the job is delivered. Turning down a provider's first delivery
   * also pays for that record. Absent until read.
   */
  providerRecorded?: boolean;
  rating: number | null;
  /** The finished job's deposits were collected and its slot released. */
  tidied: boolean;
  signatures: {
    hire?: string;
    /** The buyer's payment for the safety check of the request. */
    approval?: string;
    activate?: string;
    accept?: string;
    cancel?: string;
    changes?: string;
    /** The buyer turned the delivery down and the price went on hold. */
    reject?: string;
    /** This wallet settled a turned-down job once its review time ran out. */
    settle?: string;
    rate?: string;
    close?: string;
  };
  /**
   * When this wallet last sent the settlement of a turned-down job. A
   * settlement that may still be on its way is not sent a second time.
   */
  settleAttemptAt?: number | null;
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
  /**
   * The last balance read for each wallet (the main one and every agent's),
   * by id. Only for showing something true when the network cannot be reached.
   */
  lastSeenLamports?: Record<string, string>;
  /**
   * The last backup the person made: when, and which keys it holds. A key
   * made since (a new agent) is not in it, and the person is told.
   */
  backup?: { at: number; keyIds: string[] } | null;
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
