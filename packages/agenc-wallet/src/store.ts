import { recordListingCreation } from "./seller-operation.js";
import { ARCHIVE_FILE, MoneyArchive } from "./money-archive.js";
import type { ChildHireState } from "./child-hire-store.js";
import type { JobTerms } from "./client/types.js";
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
import type { AllowanceCharge, PendingListingSend } from "./transport-scope.js";
import { WalletError } from "./errors.js";
import { readPrivateFile, writePrivateFileAtomic } from "./vault.js";

export const STATE_VERSION = 1;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVITY = 1_000;
const MAX_FINISHED_JOBS = 500;
export const MAX_WORK_RECORD_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_WORK_RECORDS = 1_000;

/**
 * A service an earning agent offers for others to hire.
 *
 * The record says what the person WANTS on offer. What is actually on the
 * marketplace is read from the chain on every housekeeping pass and brought
 * in line one step at a time, so a crash between steps loses nothing.
 */
export interface OfferRecord {
  /** Until live, reconciliation cannot debit the owner again for this approved offer. */
  fundingConfirmed?: true;
  terms?: import("./client/seller-terms.js").SellerTerms;
  /**
   * Stable for as long as the person keeps this service, while its listing
   * may be replaced (a retired listing starts over under a new id).
   */
  id: string;
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
  /** An explicit seller edit, retained until the same listing confirms it. */
  pendingDeliverySecs?: number | undefined;
  /** The advertised description, and the hash of it the listing commits to. */
  spec: Record<string, unknown>;
  specHashHex: string;
  /** Where that description was published, once it has been. The listing points here. */
  specUri?: string | null;
  /** False once the person withdrew the offer; the listing is then kept paused. */
  wanted: boolean;
  /** What the last housekeeping pass found. */
  status: "getting_ready" | "being_checked" | "live" | "paused" | "problem" | "awaiting_approval";
  /** The reason for a problem or a funding approval request. */
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
  /** Completed intent during an interrupted pass. Cleared after the full pass. */
  reconciledForLive?: boolean;
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
  refills: AllowanceCharge[];
  jobSpends?: { id: string; at: number; microcents: string | null }[];
  /** Set by a restore: until then the ledger may miss spends made after the backup. */
  allowanceUnknownUntil?: number;
  earn: {
    chooseOpenJobs?: boolean;
    enabled: boolean;
    minPayCents: number;
    /** Interrupted listing work must read the chain before admitting jobs. */
    listingReconciliationRequired?: boolean;
    /** Signed sends whose outcome is unknown, persisted before dispatch. */
    pendingListingSends?: PendingListingSend[];
    sellerDecisions?: Record<string, { action: string; landed: boolean; signature?: string }>;
    jobsDone: number;
    /** Idempotency receipts for replayed worker settlements. */
    creditedTasks?: Record<string, true>;
    lastError: string | null;
    /**
     * The services this agent offers, oldest first. A journal from before an
     * agent could offer several holds `offer` instead; it is moved here when
     * the journal is read.
     */
    offers?: OfferRecord[];
    /** Journals written before several services: read once, then gone. */
    offer?: OfferRecord | null;
    /**
     * When the person stopped this agent earning for good: its services left
     * the marketplace for good and it was retired there, which brought its
     * deposit back. It takes no jobs again. Absent until then.
     */
    retiredAt?: number | null;
  };
}

/** The services an agent offers, whatever journal it came from. */
export function agentOffers(agent: Pick<AgentRecord, "earn">): OfferRecord[] {
  const earn = agent.earn as AgentRecord["earn"];
  if (earn.offers !== undefined) return earn.offers;
  const legacy = earn.offer ?? null;
  return legacy === null ? [] : [{ ...legacy, id: legacy.id ?? legacy.listingIdHex }];
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

export interface ContestRegistration {
  agentId: string;
  stake: string;
  rent: string;
}

export interface JobRecord {
  parties?: import("./client/business.js").JobParties;
  contestRegistration?: ContestRegistration;
  contestEntries?: Array<import("./client/types.js").ContestEntry & { commitment?: string; observedEvent?: boolean; eventId?: string }>;
  contestQuote?: import("./client/types.js").ContestQuote;
  contestReceipts?: string[];
  contestSettlements?: import("./client/types.js").ContestReceipt[];
  contestClaims?: { claim: string; workerAuthority: string }[];
  contestCleanup?: boolean;
  contestCancel?: boolean;
  contestPending?: import("./transport-scope.js").PendingListingSend;
  contestReleaseOpen?: boolean;
  contestCreditMicrocents?: string;
  contestFailedExpense?: { credit: string; charge: string };
  contestOverBudget?: boolean;
  contestOverage?: string;
  contestCursor?: string;
  contestScanned?: boolean;
  contestCheckpoint?: import("./contest-history.js").ContestCheckpoint;
  terms?: JobTerms;
  inputFingerprint?: string;
  /**
   * Set by a restore on a job the backup knew as not yet funded. Its task may
   * have been funded after the backup, so the chain is asked before anything else.
   */
  fundingUnknown?: true;
  /** Null when the buyer left the maximum to the quote. Older journals omit this field. */
  buyerMaxPriceCents?: number | null;
  maxPriceCents?: number;
  /** Costs and expiry of the exact quote authorized for this job. */
  ownerApproved?: boolean;
  approvalId?: string;
  approvedCosts?: { rentTerms?: string; networkFees?: string; cancellationRent?: string; total: string; kept: string; protocolFeeBps: number; expiresAt: number };
  revisionDeadlines?: Record<string, number>;
  reviewDraft?: import("./client/reviews.js").ReviewDraft;
  id: string;
  role: "buying" | "working";
  /**
   * "hire": a service was hired. "request": a request was posted for anyone
   * to take; it has no listing, and no provider until someone takes it.
   * Absent in journals written before requests existed: a hire.
   */
  kind?: "hire" | "request";
  /** The agent that pays, or "" for a request the person posted from the main balance. */
  agentId: string;
  createdAt: number;
  updatedAt: number;
  idempotencyKey: string | null;

  /** The service hired; "" for a request. */
  listing: string;
  /** The provider agent; for a request, "" until someone takes it. */
  providerAgent: string;
  title: string;
  request: string;
  acceptance: string[];
  /** What the provider is paid: the service's price, or a request's reward. */
  priceLamports: string;
  /** A request only: how long whoever takes it has to deliver, in seconds. */
  deliverWithinSecs?: number;
  /**
   * A request only: unix seconds by which the work must be delivered, fixed
   * when the brief is prepared. Nobody can take it after that.
   */
  requestDeadline?: number | null;

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
  /** Learned from the task account, including when refreshing an older record. */
  tokenReward?: boolean;
  /** Unix seconds: the provider's deadline. */
  deadline: number | null;
  /** Unix seconds: when an unreviewed delivery pays out by itself. */
  reviewDeadlineAt: number | null;
  /** Unix ms: when a job nobody started is refunded by itself. */
  autoRefundAt: number | null;
  /** Explicit local timeout, separate from the chain-derived display timestamp. */
  autoRefundTimeoutAt?: number;
  /** A hire whose provider took it and gave it back (seen started, then open with nobody on it). */
  providerGaveBack?: boolean;
  outcome: "paid" | "refunded" | "problem" | null;
  changesRequested: boolean;
  result: JobResult | null;
  /** Durable download pointer, retained even when a fetch fails or the job is paid. */
  deliveryPointer?: { hash: string; dataBase64: string };
  /** The pointer was authenticated against the final paid commitment. */
  finalDeliveryChecked?: boolean;

  /**
   * Whether the provider has a marketplace record of turn-downs, read while
   * the job is delivered until it has one (a record is never removed). Since
   * revision 9 every turn-down is counted; a provider whose claim predates
   * revision 9 may have none, and the turn-down then starts it, paid by the
   * buyer. Absent until read.
   */
  providerRecorded?: boolean;
  /**
   * While the job is turned down (reject_frozen): the turn-down as the chain
   * shows it, read on every look. Absent otherwise.
   */
  turnDown?: {
    /**
     * True: a revision 9 turn-down. The provider may dispute it until
     * `disputeUntil`, and the buyer is refunded unless a ruling pays the
     * provider. False: one made before revision 9, which pays the provider
     * if nobody rules by its review time (`disputeUntil` holds it).
     */
    disputable: boolean;
    /** Unix seconds. */
    disputeUntil: number;
    /** Lamports a dispute posts as its bond. */
    bondLamports: string;
    /** Unix seconds: the last second a ruling may land, once disputed. Null before. */
    rulingUntil: number | null;
    /** Whether the provider may dispute it now, by the cluster's clock at the last look. */
    disputeOpen: boolean;
    /**
     * The marketplace suspended the provider's agent at the last look, so it
     * cannot dispute. Absent in records written before this was read.
     */
    providerSuspended?: boolean;
  };
  /**
   * Lamports the paying wallet lacked, at the last try, to cancel the job for
   * its refund: a first cancel starts the wallet's marketplace record. Absent
   * when nothing was missing.
   */
  refundBlockedLamports?: string;
  rating: number | null;
  /** The finished job's deposits were collected and its slot released. */
  tidied: boolean;
  /**
   * False while what this job gave back to the main balance (its price on a
   * refund, its deposits when it was tidied) has not yet been counted into
   * the balance the wallet compares against, so it is not taken for money
   * that arrived. Absent on jobs from before this existed: counted.
   */
  balanceSettled?: boolean;
  /**
   * When it gave that money back (ms). Only a balance read a minute or more
   * later counts it in: a connection can answer with an older balance.
   */
  returnedAt?: number;
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
  contestOverBudget?: boolean;
  contestOverage?: string;
  entryRentLamports?: string;
  workerRecordLamports?: string;
  contestRegistration?: ContestRegistration;
  networkFees?: string;
  retainedRent?: string;
  cancellationRent?: string;
  protocolFeeBps?: number;
  terms?: JobTerms;
  acceptance?: string[];
  maxPriceCents?: number;
  /** Rate used when displaying this quote, fixed until it expires. */
  quoteRate?: number | null;
  id: string;
  jobId: string;
  agentId: string;
  /** What the agent asks to do. Absent in journals written before requests existed: a hire. */
  kind?: "hire" | "request";
  /** The service to hire; null for a request posted for anyone to take. */
  service: ServiceView | null;
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

export interface WalletState extends ChildHireState {
  moneyArchiveId?: string;
  contestRegistrations?: Record<string, ContestRegistration>;
  actionInbox?: import("./action-inbox.js").SavedAction[];
  businessRecovery?: { restoredAt: number; requiresConsent: boolean; sellers?: string[] };
  setupQuotes?: Record<string, { quote: import("./client/types.js").EarnFundingQuote; action: string; before: string; offers: OfferRecord[] }>;
  version: number;
  createdAt: number;
  agents: Record<string, AgentRecord>;
  jobs: Record<string, JobRecord>;
  /** Seller delivery cache and durable review-change timestamps. */
  reviewIntents?: Record<string, {
    payer: string; agentId: string | null; rate: number | null; reconciled?: boolean;
    intendedDelivery?: import("./client/reviews.js").ReviewedDelivery;
    quoteId: string; action: string; createdAt: number; hashes: string[]; published?: string[]; confirmed: boolean;
    receipt?: PendingListingSend;
  }>;
  workRecords?: Record<string, {
    parties?: import("./client/business.js").JobParties;
    /** The parties were read after the task or claim closed, or the job ended. Lists stop re-reading them. */
    partiesFinal?: boolean;
    revisionDeadlines?: Record<string, number>;
    reviewDraft?: import("./client/reviews.js").ReviewDraft;
    result?: JobResult;
    request?: string;
    acceptance?: string[];
    terms?: JobTerms;
    updatedAt?: number;
    reviewDeadlineAt?: number;
    turnDown?: JobRecord["turnDown"];
  }>;

  /** Final keyed outcomes outlive the activity feed and finished-job list. */
  callReceipts?: Record<string, JobRecord>;
  approvals: Record<string, ApprovalRecord>;
  activity: ActivityRecord[];
  /** Last known dollars-per-SOL, kept so an offline start can still estimate. */
  lastSolUsd: { value: number; ts: number } | null;
  /** Main-balance lamports last seen, to notice money arriving. */
  lastMainLamports: string | null;
  /**
   * Lifetime lamports the main balance paid out for requests the person
   * posted from it. What agents pay is counted on each agent.
   */
  mainSpentLamports?: string;
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
    (job.phase === "done" && job.tidied && (!job.terms?.contest || job.contestScanned === true))
  );
}

/** Keep the file bounded: old finished jobs and old activity fall off. */
function prune(state: WalletState): void {
  // Complete worker request evidence lives in its archive. These are disposable
  // display caches; retain compact review metadata while a dispute is unresolved.
  const records = state.workRecords ?? {};
  const ordered = Object.entries(records).sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
  let size = Buffer.byteLength(JSON.stringify(records));
  let count = ordered.length;
  for (const [id, record] of ordered) {
    if (size <= MAX_WORK_RECORD_CACHE_BYTES && count <= MAX_WORK_RECORDS) break;
    const before = Buffer.byteLength(JSON.stringify({ [id]: record }));
    if (record.turnDown !== undefined || record.reviewDeadlineAt !== undefined) {
      delete record.result;
      delete record.request;
      delete record.acceptance;
      size -= before - Buffer.byteLength(JSON.stringify({ [id]: record }));
    } else {
      delete records[id];
      count -= 1;
      size -= before - 1;
    }
  }
  if (state.activity.length > MAX_ACTIVITY) {
    state.activity = state.activity.slice(state.activity.length - MAX_ACTIVITY);
  }
  const finished = Object.values(state.jobs)
    .filter(isFinished)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
    if (job.contestRegistration && job.terms?.contest && job.role === "buying" && job.payer === "main")
      (state.contestRegistrations ??= {})[job.id] = job.contestRegistration;
    if (job.idempotencyKey) {
      const key = JSON.stringify([job.agentId, job.kind ?? "hire", job.idempotencyKey]);
      (state.callReceipts ??= {})[key] = {
        ...job, jobSpec: {}, result: null, changes: [],
      };
    }
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
  #closed = false;
  readonly archive: MoneyArchive;

  private constructor(file: string, state: WalletState) {
    this.#file = file;
    this.#state = state;
    this.archive = new MoneyArchive(path.join(path.dirname(file), ARCHIVE_FILE), state.moneyArchiveId);
    this.checkpoint();
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
    // An agent from a journal written before several services keeps its one
    // service as the first of its list.
    for (const agent of Object.values(parsed.agents)) {
      if (agent.jobSpends === undefined) {
        // Older journals did not record the dollar rate at signing. Keep
        // those jobs in the window and leave new spending to the owner.
        agent.jobSpends = Object.values(parsed.jobs).flatMap(job => {
          const at = job.hireAttemptAt ?? job.hiredAt;
          return job.agentId === agent.id && job.role === "buying" && job.payer === "agent" &&
            at != null && at > now - 86_400_000 ? [{ id: job.id, at, microcents: null }] : [];
        });
      }
      if (agent.earn.offers === undefined) {
        agent.earn.offers = agentOffers(agent);
        delete agent.earn.offer;
      }
      // Older seller receipts referenced the current listing. Preserve the
      // creation proof before a later edit or replacement changes that record.
      for (const offer of agentOffers(agent)) {
        if (offer.listing && offer.signatures?.create)
          recordListingCreation(agent, offer.id, offer.listingIdHex, offer.listing, offer.signatures.create);
      }
    }
    return new StateStore(file, parsed);
  }

  /** A read-only view. Never mutate it; go through {@link update}. */
  get state(): Readonly<WalletState> {
    return this.#state;
  }

  operation(id: string) {
    return this.#state.moneyOperations?.[id] ?? this.archive.operation(id)?.operation;
  }

  purchaseBinding(key: string) {
    return this.#state.purchaseBindings?.[key] ?? this.archive.binding("purchase", key);
  }

  purchase(key: string) {
    return this.#state.callReceipts?.[key] ?? this.archive.purchase(key);
  }

  checkpoint() {
    if (this.archive.checkpoint(this.#state)) this.#save();
  }

  /** Permanently fence this owner before its directory lock is released. */
  close(): void {
    if (this.#closed) return;
    this.checkpoint();
    this.#closed = true;
    this.archive.close();
  }

  /**
   * Apply a change and persist it before returning. The mutator works on a
   * copy; if it throws or the write fails, memory keeps the previous state.
   */
  update<T>(mutator: (draft: WalletState) => T): T {
    if (this.#closed) throw new WalletError("NOT_AVAILABLE", "This wallet is closed.");
    this.checkpoint();
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
    const serialized = JSON.stringify(this.#state);
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
      throw new WalletError("INTERNAL", "The wallet's records exceed the storage limit.");
    }
    writePrivateFileAtomic(this.#file, serialized);
  }
}
