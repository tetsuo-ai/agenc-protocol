import { parseJobBrief } from "@tetsuo-ai/agenc-worker";
// The wallet: one main balance, one small wallet per agent, and a journal of
// every job. It accepts plain requests ("hire this", "approve that"), decides
// whether the agent's own allowance covers them or a person must say yes,
// and then builds, signs and follows the marketplace transactions itself.
//
// An agent can never name a destination, an amount to send, or a transaction.
// The worst a compromised agent can do is spend the allowance in its own
// wallet on marketplace jobs, each of which is escrowed and refundable.
import { abortableTransport, fundedOfferId, inTransportScope, scopeAdapterRequests, listingRequest, transportSignal, withListingOperation, type ListingOperation, type AllowanceCharge } from "./transport-scope.js";
import { applySellerDecision, saveSellerOffer, type SellerEffect, type SellerDecision } from "./seller-decision.js";
import { checkHireOperator, checkOperator } from "./payable-operator.js";
import { fillCatalogTerms, reducesListingCapacity, resolveTerms, sameChainTerms, sellerProceeds, storedTerms } from "./seller-terms.js";
import { sellerListingSpec } from "./seller-terms.js";
import { serviceEconomics } from "./service-economics.js";
import { readServiceRehearsal } from "./service-rehearsal.js";
import { fractionalQuoteUsd } from "./job-money.js";
import { facade, findAgentStatsPda, getAgentStatsSize } from "@tetsuo-ai/marketplace-sdk";
import type { SellerOfferInput } from "./client/protocol.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { createNoopSigner, address, type Address, type KeyPairSigner } from "@solana/kit";
import {
  AgencError,
  SubmissionStatus,
  findClaimPda,
  getTaskMarkerSize,
  taskThread,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import { workerJob, workAddress, quoteTransfers, workAuthorizationTerms, releaseQuoteLifetime } from "./worker-jobs.js";
import type { WorkerQuote, WorkAction } from "./client/types.js";
import { loadState as loadWorkerState, saveState as saveWorkerState, type SubmissionIntent, type WorkerDispatch, browseOpenWork, heldWork, takeOpenWork, finishChosenWork, type OpenWork, type HeldWork, readReviewEnvelope, decodeHostedBrief, fetchAndVerifyJobSpec } from "@tetsuo-ai/agenc-worker";
import { deliveryNotice } from "./review-history.js";
import { publishReviewFiles, reviewChargeCents, quoteReview, reviewRead, reviewAttachments, reviewNote } from "./review.js";
import type { ReviewAction, ReviewAttachment, ReviewConfirmation, ReviewDraft, ReviewQuote, ReviewRecord } from "./client/reviews.js";
import { isNetworkTrouble, scopedChainReads, transferInstruction, type Chain } from "./chain.js";
import { deliveryFileType, deliveryFileProblem, splitDelivery, type DeliveryFile } from "./client/delivery-files.js";
import { formatMoney } from "./client/format.js";
import { MAX_FRAME_BYTES, MAX_LISTING_DELIVERY_SECS, type MethodParams, type MethodResult, type AmountInput, type WalletEvent } from "./client/protocol.js";
import { identifyEntry, entrantCosts, contestClaims, archiveContestEntries, contestPostCosts, liveContestEntries, sendContest, contestUnavailable } from "./contest.js";
import { contestPage, contestReceipts } from "./contest-page.js";
import { contestPlan } from "./contest-decision.js";
import { beforeContestExpiry, contestSigner } from "./contest-deadline.js";
import type { ContestAction, ContestQuote } from "./client/types.js";
import { ceilingLamports, jobNetworkFees, microcents, remainingJobMicrocents, reserveJobSpend, type JobDeposits } from "./job-money.js";
import { checkedAcceptance, jobIdentity, resolveJobTerms, type TermsInput } from "./job-terms.js";
import { legacyRefreshLimit, buildJobQuote, checkPriceLimit, jobCosts } from "./job-quote.js";
import type { JobTerms, ServiceView } from "./client/types.js";
import { WALLET_CAPABILITIES } from "./client/types.js";
import type {
  ActivityKind,
  ActivityView,
  AgentPolicy,
  AgentView,
  ApprovalView,
  EarnFundingQuote,
  JobStatus,
  JobView,
  Money,
  OfferView,
  WalletOverview,
} from "./client/types.js";
import {
  APPROVAL_FEE_LAMPORTS,
  approvalCost,
  signApproval,
  type ApprovalTarget,
} from "./approval.js";
import {
  EarnHost,
  maximumOfferPrice,
  failureWords,
  type EarnedJob,
  type EarnNotice,
  type EarnOptions,
} from "./earn.js";
import { firstPartyAccounts } from "./first-party.js";
import { checkBackup, createBackup, readBackupFile, writeBackupFile } from "./backup.js";
import { describeError, WalletError } from "./errors.js";
import { jobListPreview } from "./list-preview.js";
import {
  acceptedApprovers,
  alreadyRated,
  DEFAULT_REVIEW_WINDOW_SECS,
  FEE_HEADROOM_LAMPORTS,
  findListingGate,
  findTaskGate,
  hireLanded,
  inspectJob,
  settledOperatorPayment,
  isActivated,
  LISTING_ACCOUNT_SPACE,
  LISTING_NAME_MAX_BYTES,
  listingAddressFor,
  providerHasRecord,
  purchaseDeposits,
  ratingCost,
  isRetiredAgent,
  listingsOf,
  readAgent,
  readHireableListing,
  readListing,
  readTask,
  readProtocolConfig,
  prepareTidy, requestDeposits,
  requestLanded,
  requestWorker,
  sendActivation,
  sendApproval,
  sendCancel,
  sendChangesRequest,
  cancelShortfall,
  creatorRecordCost,
  sendDisputeTurnDown,
  sendFrozenExpiry,
  sendCreateListing,
  sendHire,
  sendListingState,
  sendRating,
  sendRejectAndFreeze,
  sendRequest,
  sendListingStates,
  sendRetireAgent,
  sendTidy,
  sendUpdateListing,
  taskAddressFor,
  readTurnDownOnChain,
  readSubmission,
  waitingHires,
  type AmountWords,
  type ListingTerms,
  type RequestIntent,
  type TurnDownOnChain,
} from "./market.js";
import { centsToLamports, lamportsToCents, type PriceSource } from "./pricing.js";
import { createRecordKeeper, type RecordKeeper } from "./records.js";
import {
  buildJobSpec,

  jobSpecHash,
  tidyText,
  type CatalogRow,
  type MarketServices,
  type ApprovalPayment,
  type PublishedJob,
} from "./services.js";
import type { AgentRegistration } from "@tetsuo-ai/marketplace-sdk";
import {
  acquireServiceLock,
  StateStore,
  type ApprovalRecord,
  type AgentRecord,
  type JobRecord,
  type OfferRecord,
  type WalletState,
  agentOffers,
} from "./store.js";
import { ServiceDiscovery, recordRow, type ServiceContext } from "./service-discovery.js";
import { priceCeiling } from "./price-ceiling.js";
import { DISCOVERY_CAPABILITY } from "./client/discovery.js";
import { KeyVault } from "./vault.js";
import { activityView, amountWords, approvalView, jobStatus, jobView, money } from "./views.js";

const MAIN_KEY = "main";
/**
 * A payment for a safety check that was sent is given this long to show up
 * before another one is asked for. Longer than a transaction can stay alive.
 */
const APPROVAL_SETTLE_MS = 120_000;
/** A hire that may have been sent is given this long to show up on-chain. */
const HIRE_RECONCILE_GRACE_MS = 150_000;
/** A hire the network was too busy to take is sent again this many times, one pass apart. */
const HIRE_BUSY_RETRIES = 8;
/** A hired job that cannot be posted is refunded after this long. */
const POSTING_GIVE_UP_MS = 30 * 60_000;
/** A provider who started is given this long past the deadline to deliver. */
const NO_SHOW_GRACE_SECS = 120;
/**
 * How long to wait before sending the settlement of a turned-down job again.
 * The first one may still be on its way, or the other side may have sent it.
 */
const FROZEN_SETTLE_RETRY_MS = 120_000;
/** Tries, and the gap between them, to read a turn-down back right after it lands. */
const FREEZE_READ_BACK_TRIES = 3;
const FREEZE_READ_BACK_GAP_MS = 500;
const MAX_RESULT_TEXT = 20_000;
/**
 * True when a delivery's text is an SVG drawing: after an optional byte-order
 * mark, XML declaration, comments and doctype, the document opens with <svg>.
 */
function isDrawing(text: string): boolean {
  let rest = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).slice(0, 4096).trimStart();
  for (let step = 0; step < 6; step += 1) {
    const close = rest.startsWith("<?") ? "?>" : rest.startsWith("<!--") ? "-->" : /^<!doctype/i.test(rest) ? ">" : null;
    if (close === null) break;
    const end = rest.indexOf(close);
    if (end === -1) return false;
    rest = rest.slice(end + close.length).trimStart();
  }
  return /^<svg[\s>]/i.test(rest);
}

const BALANCE_CACHE_MS = 4_000;
/**
 * How long after a job gives money back to the main balance a read of that
 * balance may still be from before: a connection can lag a little. Only a
 * read this much later counts the money in.
 */
const BALANCE_SETTLE_MS = 60_000;
const STALE_PRICE_MS = 6 * 60 * 60_000;
/**
 * How long a list of services waits for the record of who offers them and
 * what buyers paid them, when that is being read. The rest is filled in when
 * the list is read again.
 */
const RECORD_WAIT_MS = 4_000;
/** How long the marketplace's fee rate is used before it is read again. */
const FEE_RATE_TTL_MS = 10 * 60_000;
/** After the fee rate could not be read, how long before it is tried again. */
const FEE_RATE_RETRY_MS = 60_000;
/** The marketplace's catalog hides a service priced below this. */
const MIN_OFFER_PRICE_LAMPORTS = 1_000n;
/** How long an agent gets to deliver a job hired from its own service. */
const OFFER_DELIVERY_SECS = 60 * 60;

function checkOfferDelivery(seconds: number | undefined): void {
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_LISTING_DELIVERY_SECS)) {
    throw new WalletError("BAD_REQUEST", "Set a delivery period from 1 second to 365 days.");
  }
}
/** The marketplace's safety check is asked at most this often per service. */
const OFFER_CHECK_RETRY_MS = 60_000;
/** Steps one housekeeping pass may take for one offer (create, update, switch, check). */
const OFFER_STEPS_PER_PASS = 4;
/**
 * Services one agent may offer. The marketplace has no limit, but each one
 * keeps a deposit for good and every hire of any of them is done by the same
 * agent, one at a time.
 */
const MAX_OFFERS_PER_AGENT = 10;
/** How many earlier jobs may still wait for payment while a new hire is taken. */
const OFFER_SPARE_JOBS = 4n;
const DAY_SECS = 24 * 60 * 60;
/** How long whoever takes a posted request has to deliver, unless it says otherwise. */
const DEFAULT_REQUEST_DAYS = 7;

/** How long a quote for posting a request from the main balance is trusted. */
const POST_COST_TTL_MS = 10 * 60_000;
const LISTING_STATE_ACTIVE = 0;
const LISTING_STATE_PAUSED = 1;
const LISTING_STATE_RETIRED = 2;
/** `AgentRegistration.status` of an agent the marketplace suspended. */
const AGENT_STATUS_SUSPENDED = 3;

/** What the marketplace's record of an earning agent says about stopping it for good. */
interface RegistrationFacts {
  /** Its deposit for taking jobs. */
  stake: bigint;
  /** Jobs it holds: taken and not yet paid, or given up and not yet let go. */
  activeTasks: number;
  /** Turned-down work of its, or disputes, a reviewer has not settled. */
  disputes: number;
  /** Retired already: it can never take a job again. */
  retired: boolean;
  /** Suspended by the marketplace: it cannot be retired until that is lifted. */
  suspended: boolean;
}

/** What a service costs that does not come back, in lamports; null when it could not be read. */
interface ServiceCosts {
  /** Putting one more service on offer. */
  offer: bigint | null;
  /** Saving new words for a service already on the marketplace. */
  words: bigint | null;
}

/**
 * A marketplace step during retirement, in plain words when it fails: the
 * marketplace refusing it is said as such; anything else is the network,
 * and every step is safe to try again.
 */
async function unreachable<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof WalletError) throw error;
    // The program's own error code; anything else may be the network, even a
    // send whose outcome is unknown, which trying again settles.
    if (error instanceof AgencError && error.code !== null) {
      throw new WalletError("NOT_ALLOWED", "The marketplace refused this step right now.", { cause: error });
    }
    throw new WalletError(
      "NETWORK",
      "Market could not reach the marketplace right now. Try again in a moment.",
      { cause: error },
    );
  }
}

function registrationFacts(account: AgentRegistration): RegistrationFacts {
  return {
    stake: account.stake,
    activeTasks: account.activeTasks,
    disputes: account.disputesAsDefendant + account.activeDisputeVotes,
    retired: isRetiredAgent(account),
    suspended: Number(account.status) === AGENT_STATUS_SUSPENDED,
  };
}

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
  /** Optional earlier refund timeout for unstarted hires. Default: the on-chain delivery deadline. */
  autoRefundAfterMs?: number;
  /** An approval nobody answers lapses after this long. Default 30 minutes. */
  approvalTtlMs?: number;
  /** How long a buyer has to review before a delivery pays itself. Default 24 hours. */
  reviewWindowSecs?: bigint;
  /** How long a paid job stays open for a rating before it is tidied. Default 1 hour. */
  rateWindowMs?: number;
  /** Deadline per listing transport request or confirmation wait. Default 30 seconds. */
  listingTimeoutMs?: number;
}

interface BalanceSnapshot {
  at: number;
  values: Map<string, bigint>;
  offline: boolean;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

function sameOfferTerms(left: OfferRecord, right: OfferRecord): boolean {
  return JSON.stringify(storedTerms(left)) === JSON.stringify(storedTerms(right));
}

function clearOfferFundingWait(offer: OfferRecord): void {
  if (offer.status !== "awaiting_approval") return;
  offer.status = "getting_ready";
  offer.error = null;
  delete offer.reconciledForLive;
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

function hireFailureText(
  error: unknown,
  what: "order" | "request" = "order",
): { code: "PRICE_CHANGED" | "NOT_ENOUGH_MONEY" | "NOT_AVAILABLE"; message: string } {
  if (isNetworkTrouble(error)) {
    return {
      code: "NOT_AVAILABLE",
      message:
        what === "order"
          ? "The network was too busy to place the order. Nothing was spent."
          : "The network was too busy to post the request. Nothing was spent.",
    };
  }
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
      message:
        what === "order"
          ? "There was not enough money to place the order. Nothing was spent."
          : "There was not enough money to post the request. Nothing was spent.",
    };
  }
  return {
    code: "NOT_AVAILABLE",
    message:
      what === "order"
        ? "The marketplace did not accept the order. Nothing was spent."
        : "The marketplace did not accept the request. Nothing was spent.",
  };
}

/**
 * A posted request's title: its first sentence, kept short and without the
 * mark that ends it, so it reads inside another sentence ("Paid for ...").
 * It is public with the request.
 */
export function requestTitle(request: string): string {
  const line = (request.split("\n").find((entry) => entry.trim().length > 0) ?? "").trim().slice(0, 400);
  // The first sentence ends at the first mark that is followed by a space.
  let end = line.length;
  for (let index = 0; index < line.length; index += 1) {
    const next = line[index + 1];
    if (".!?".includes(line[index]!) && (next === undefined || next.trim() === "")) {
      end = index;
      break;
    }
  }
  // Plain loops, no pattern: no text can make them slow.
  while (end > 0 && " \t\r.!?,;:".includes(line[end - 1]!)) end -= 1;
  return tidyText(line.slice(0, end), 60) ?? "Request";
}

/** What the journal keeps of a turn-down the chain shows, or nothing. */
function turnDownRecord(turnDown: TurnDownOnChain | null): JobRecord["turnDown"] {
  if (turnDown === null) return undefined;
  return {
    disputable: turnDown.disputable,
    disputeUntil: turnDown.disputeUntil,
    bondLamports: turnDown.bondLamports.toString(),
    rulingUntil: turnDown.rulingUntil,
    disputeOpen: turnDown.disputeOpen,
    providerSuspended: turnDown.providerSuspended,
  };
}

function sameTurnDown(a: JobRecord["turnDown"], b: JobRecord["turnDown"]): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.disputable === b.disputable &&
    a.disputeUntil === b.disputeUntil &&
    a.bondLamports === b.bondLamports &&
    a.rulingUntil === b.rulingUntil &&
    a.disputeOpen === b.disputeOpen &&
    (a.providerSuspended === true) === (b.providerSuspended === true)
  );
}

function isRequest(job: Pick<JobRecord, "kind">): boolean {
  return job.kind === "request";
}

/** A request as checked before it is journaled. */
interface RequestTerms {
  terms: JobTerms;
  rate: number | null;
  title: string;
  request: string;
  acceptance: string[];
  rewardLamports: bigint;
  deliverWithinSecs: number;
}

function sellerMoney(lamports: bigint, rate: number | null) {
  const exact = rate === null ? undefined : fractionalQuoteUsd(lamports, rate);
  return { ...money(lamports, rate), ...(exact === undefined ? {} : { quotedUsd: exact }) };
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
  readonly #panelQuotes = new Map<string, { job: JobRecord; approval: ApprovalRecord }>();
  readonly #jobCalls = new Map<string, { fingerprint: string; run: Promise<unknown> }>();
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  #balances: BalanceSnapshot | null = null;
  /**
   * Deliveries of this wallet's agents that a buyer turned down, by task:
   * when their review time ends, and when collecting was last tried. Review
   * changes are journaled so catch-up notifications survive a restart.
   */
  readonly #frozenWork = new Map<
    string,
    { reviewDeadlineAt: number; attemptAt: number | null; turnDown: JobRecord["turnDown"] }
  >();
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking: Promise<void> | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  readonly #background = new Set<Promise<unknown>>();
  readonly #listingAbort = new AbortController();
  /** Set while closing: every service comes off offer, since nobody will do the work. */
  #closing = false;
  /** Agents being stopped earning for good right now. */
  readonly #retiring = new Set<string>();
  readonly #quotedContinuation = new AsyncLocalStorage<{ agentId: string; active: boolean }>();
  readonly #fundingQuotes = new Map<string, { quote: EarnFundingQuote; target: bigint; action: string; before: string; offers: OfferRecord[] }>();
  readonly #workQuotes = new Map<string, { quote: WorkerQuote; terms: string }>();
  /**
   * An agent's waiting hires, found when stopping it for good was refused for
   * them, with what each pays: its loop takes them whatever its smallest pay
   * says, or it could never stop. Every other job keeps that floor.
   */
  readonly #owed = new Map<string, ReadonlyMap<string, bigint>>();
  /** Who offers each service and what buyers paid them, read in the background. */
  readonly #discovery: ServiceDiscovery;
  readonly #records: RecordKeeper;
  /** The marketplace's fee rate in basis points, as last read (null: it could not be). */
  #feeRate: { at: number; bps: number | null } | null = null;

  private constructor(
    config: WalletConfig,
    vault: KeyVault,
    store: StateStore,
    releaseLock: () => void,
  ) {
    this.#config = config;
    this.#chain = scopedChainReads(config.chain);
    this.#services = scopeAdapterRequests(config.services, ["trustedModerators", "publishListing", "attestListing"]);
    this.#vault = vault;
    this.#store = store;
    this.#releaseLock = releaseLock;
    this.#now = config.now ?? Date.now;
    this.#log = config.log ?? (() => {});
    this.#discovery = new ServiceDiscovery({
      rate: () => this.#displayRate(), listServices: (filters) => this.#services.listServices(filters),
      fillTerms: (rows) => fillCatalogTerms(this.#chain, rows),
      ownServices: (rows) => this.#ownServices(rows), context: (rows, rate) => this.#serviceContext(rows, RECORD_WAIT_MS, rate),
      publicNetwork: this.#chain.network === "mainnet", now: this.#now,
    });
    this.#records = createRecordKeeper(
      {
        chain: config.chain,
        services: config.services,
        firstParty: firstPartyAccounts(config.chain.network),
      },
      this.#now,
    );
    for (const [jobId, record] of Object.entries(this.#store.state.workRecords ?? {})) {
      if (record.turnDown !== undefined && record.reviewDeadlineAt !== undefined) {
        const task = jobId.slice(jobId.lastIndexOf("_") + 1);
        this.#frozenWork.set(task, { reviewDeadlineAt: record.reviewDeadlineAt, attemptAt: null, turnDown: record.turnDown });
      }
    }
    this.#earn = new EarnHost({
      chain: this.#chain,
      services: config.services,
      options: config.earn ?? { executor: null },
      dataDir: path.join(config.dataDir, "earn"),
      log: this.#log,
      notify: (agentId, notice) => this.#onEarnNotice(agentId, notice),
      serves: (agentId) => {
        const agent = this.#store.state.agents[agentId];
        return agent !== undefined && agentOffers(agent).some((offer) => offer.wanted && offer.listed);
      },
      ownAddresses: () => this.#walletIds().map((entry) => entry.address),
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
      if (Object.values(store.state.jobs).some((job) => job.outcome === "paid" && !job.finalDeliveryChecked && (job.result !== null || job.deliveryPointer !== undefined))) {
        store.update((draft) => {
          for (const job of Object.values(draft.jobs)) {
            if (job.outcome === "paid" && !job.finalDeliveryChecked) {
              job.result = null;
              delete job.deliveryPointer;
            }
          }
        });
      }
      const wallet = new AgencWallet(config, vault, store, releaseLock);
      for (const agent of Object.values(store.state.agents)) {
        wallet.#backgroundWork(wallet.#resumeEarning(agent.id));
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
    if (this.#closed && !this.#closing) return Promise.reject(new WalletError("NOT_AVAILABLE", "This wallet is closed."));
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

  /** Join detached startup, stop continuations and listing work before releasing ownership. */
  #backgroundWork(work: Promise<unknown>): void {
    this.#background.add(work);
    void work.catch((error) => this.#log(`background work: ${describeError(error)}`)).finally(() => {
      this.#background.delete(work);
    });
  }

  async #resumeEarning(agentId: string): Promise<void> {
    if (this.#closed) return;
    const agent = this.#agentRecord(agentId);
    if (agent.earn.enabled) await this.#startEarning(agent);
    else {
      await this.#lock(`earn-start:${agent.id}`, () => this.#startDrain(agent));
      await this.#advanceOffer(agentId);
    }
  }

  async #startDrain(agent: AgentRecord): Promise<void> {
    if (this.#closed || agent.earn.retiredAt != null || !this.#earn.hasUnfinishedJob(agent.id)) return;
    const signer = await this.#vault.signer(agent.keyId);
    if (this.#closed || this.#agentRecord(agent.id).earn.enabled) return;
    this.#earn.start({ agentId: agent.id, signer, minRewardLamports: 0n,
      solUsd: () => this.#freshRate() }, true);
  }

  /** Share the whole call, including preparation, before a job has been recorded. */
  #singleJobCall<T>(
    agentId: string,
    kind: "hire" | "post" | "postFromBalance",
    key: string | undefined,
    fingerprint: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const requestKey = key?.trim();
    if (!requestKey) return work();
    const scope = JSON.stringify([agentId, kind, requestKey]);
    const pending = this.#jobCalls.get(scope);
    if (pending !== undefined) {
      this.#checkFingerprint(pending.fingerprint, fingerprint);
      return pending.run as Promise<T>;
    }
    // Install the promise before work starts or yields. Later retries consult
    // #sameCall's durable record, never advance a possibly sent job again.
    const run = Promise.resolve().then(work);
    this.#jobCalls.set(scope, { fingerprint, run });
    const clear = () => { this.#jobCalls.delete(scope); };
    void run.then(clear, clear);
    return run;
  }

  #checkFingerprint(saved: string | undefined, requested: string): void {
    if (saved !== requested) throw new WalletError("BAD_REQUEST", "That request key already belongs to different or older terms.");
  }

  // ------------------------------------------------------------- prices

  /** A fresh dollars-per-SOL, or null. Remembers the last good value. */
  async #freshRate(fresh = false): Promise<number | null> {
    const raw = await listingRequest(() => this.#config.prices.solUsd({ fresh }));
    const value = raw !== null && Number.isFinite(raw) && raw > 0 ? raw : null;
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

  /** How a refusal for lack of money says its amounts: the person's money. */
  async #amountWords(): Promise<AmountWords> {
    return amountWords(await this.#displayRate());
  }

  async #toLamports(amount: AmountInput, quotedRate?: number | null): Promise<bigint> {
    if ("lamports" in amount) {
      if (!/^(?:0|[1-9][0-9]{0,18})$/.test(amount.lamports)) {
        throw new WalletError("BAD_REQUEST", "That amount is not valid.");
      }
      return BigInt(amount.lamports);
    }
    if (typeof amount.usdCents !== "number" || !Number.isFinite(amount.usdCents) || amount.usdCents <= 0) {
      throw new WalletError("BAD_REQUEST", "That amount is not valid.");
    }
    const rate = quotedRate === undefined ? await this.#freshRate() : quotedRate;
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
      const amounts = await this.#chain.getBalances(wallets.map((wallet) => wallet.address));
      // A read that began before an agent was made does not cover it, and may
      // end after one that did: what it did not read keeps its last figure,
      // so a new agent is never taken for one whose balance was never read.
      const values = new Map<string, bigint>(this.#balances?.values ?? []);
      wallets.forEach((wallet, index) => values.set(wallet.id, amounts[index]!));
      this.#balances = { at: this.#now(), values, offline: false };
      // Remembered across restarts, so a busy network never shows an agent
      // with nothing when it has money.
      const known = this.#store.state.lastSeenLamports ?? {};
      if ([...values].some(([id, lamports]) => known[id] !== lamports.toString())) {
        this.#store.update((draft) => {
          draft.lastSeenLamports = Object.fromEntries(
            [...values].map(([id, lamports]) => [id, lamports.toString()]),
          );
        });
      }
    } catch (error) {
      this.#log(`balances unavailable: ${describeError(error)}`);
      // The last figures seen: from this run, else from the journal.
      const values = new Map(this.#balances?.values ?? []);
      for (const [id, lamports] of Object.entries(this.#store.state.lastSeenLamports ?? {})) {
        if (!values.has(id)) values.set(id, BigInt(lamports));
      }
      const last = this.#store.state.lastMainLamports;
      if (!values.has(MAIN_KEY) && last !== null) values.set(MAIN_KEY, BigInt(last));
      this.#balances = { at: this.#now(), values, offline: true };
    }
    return this.#balances;
  }

  /** The balances have changed: read them again next time, but keep the last ones to fall back on. */
  #dropBalances(): void {
    if (this.#balances !== null) this.#balances = { ...this.#balances, at: 0 };
  }

  /** The smallest balance a wallet may hold without the network closing it. */
  #floor(): Promise<bigint> {
    return this.#chain.getMinimumBalanceForRentExemption(0);
  }

  /**
   * The jobs that may still have this payer send a transaction: waiting for
   * a yes, under way, or finished and not yet tidied. A job whose payer is
   * not chosen yet counts for both its agent and the main balance.
   */
  #openJobsPaidBy(payer: "main" | AgentRecord): number {
    return Object.values(this.#store.state.jobs).filter((job) => {
      if (job.role !== "buying") return false;
      const open =
        job.phase === "needs_approval" ||
        job.phase === "cleared" ||
        job.phase === "hiring" ||
        job.phase === "hired" ||
        job.phase === "active" ||
        (job.phase === "done" && !job.tidied);
      if (!open) return false;
      if (payer === "main") return job.payer !== "agent";
      return job.agentId === payer.id && job.payer !== "main";
    }).length;
  }

  /**
   * What "all" leaves behind in a wallet, besides the fee of this very
   * transfer. A wallet with nothing left to pay for is emptied: nothing of
   * the person's stays where it can never be used. One that may still pay
   * keeps the network's minimum, below which it could pay nothing at all,
   * and the room for fees each of its open jobs was set up with.
   */
  async #keepOnAll(payer: "main" | AgentRecord): Promise<bigint> {
    const fee = this.#chain.transferFeeLamports;
    const open = this.#openJobsPaidBy(payer);
    const earning =
      payer !== "main" &&
      (payer.earn.enabled ||
        this.#earn.jobs(payer.id).some((entry) => entry.state === "working" || entry.state === "delivered"));
    if (open === 0 && !earning) return fee;
    // An open job may still be cancelled or turned down, and the wallet's
    // first one starts its marketplace record: keep that too.
    const record =
      open === 0
        ? 0n
        : await creatorRecordCost(
            this.#chain,
            (payer === "main" ? this.mainAddress : payer.address) as Address,
          );
    return (await this.#floor()) + fee + BigInt(open) * FEE_HEADROOM_LAMPORTS + record;
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

  #offerView(agent: AgentRecord, offer: OfferRecord, rate: number | null): OfferView {
    const status = offer.status === "awaiting_approval" ? "problem" : offer.status;
    const statusText: Record<OfferView["status"], string> = {
      getting_ready: agent.earn.enabled
        ? "Getting ready to go on offer."
        : "Switch on taking jobs to put this on offer.",
      being_checked: "Waiting for the marketplace's safety check.",
      live: "On offer. Other agents can hire it.",
      paused: offer.error ?? (offer.wanted ? "Off offer while taking jobs is switched off." : "Off offer."),
      problem: offer.error ?? "This could not be put on offer.",
    };
    const terms = storedTerms(offer);
    return {
      id: offer.id,
      listing: offer.listing,
      name: offer.name,
      summary: offer.summary,
      price: money(offer.priceLamports, rate),
      terms,
      proceeds: sellerProceeds(BigInt(offer.priceLamports), terms.operatorFeeBps, this.#feeRate?.bps ?? null, rate),
      status,
      deliverySecs: offer.deliverySecs > 0 ? offer.deliverySecs : null,
      statusText: offer.listed && !offer.deliverySecs
        ? (status === "live" ? "" : statusText[status] + " ") + "Set a delivery period so buyers can hire this service."
        : statusText[status],
      listed: offer.listed,
      wanted: offer.wanted,
    };
  }

  #agentView(
    agent: AgentRecord,
    /** Null when the agent's balance has never been read. */
    balance: bigint | null,
    rate: number | null,
    facts: RegistrationFacts | null,
    costs: ServiceCosts,
  ): AgentView {
    const earn = this.#earn.state(agent.id);
    const retired = agent.earn.retiredAt != null || facts?.retired === true;
    // A service the person took off offer is still listed, so it can be
    // offered again.
    const offers = agentOffers(agent).map((offer) => this.#offerView(agent, offer, rate));
    return {
      id: agent.id,
      name: agent.name,
      scope: agent.scope ?? null,
      budgetCents: agent.policy.refill.perDayCents,
      address: agent.address,
      balance: money(balance ?? 0n, rate),
      balanceKnown: balance !== null,
      held: money(this.#heldBy(agent.id), rate),
      spent: money(agent.spentLamports, rate),
      earned: money(agent.earnedLamports, rate),
      policy: agent.policy,
      earn: {
        enabled: agent.earn.enabled && !retired,
        ...(this.#earn.chosenRoom && { chooseOpenJobs: agent.earn.chooseOpenJobs ?? (agentOffers(agent).length > 0) }),
        ...(this.#earn.hasChosenClaim(agent.id) && { heldChosenJob: true }),
        state: agent.earn.enabled && !retired
          ? earn.state
          : this.#earn.hasUnfinishedJob(agent.id) ? "finishing" : "off",
        lastError: earn.lastError ?? agent.earn.lastError,
        jobsDone: agent.earn.jobsDone,
        minPayCents: agent.earn.minPayCents,
        setAside: money(facts?.stake ?? 0n, rate),
        offers,
        offer: offers.find((offer) => offer.wanted) ?? offers[0] ?? null,
        offerCost: costs.offer === null ? null : money(costs.offer, rate),
        wordsCost: costs.words === null ? null : money(costs.words, rate),
        retired,
        retire:
          retired || facts === null || facts.stake === 0n
            ? null
            : { refusal: this.#retireRefusal(agent, facts, false) },
      },
      createdAt: agent.createdAt,
    };
  }

  async #oneAgentView(agentId: string): Promise<AgentView> {
    const [balances, rate] = await Promise.all([this.#readBalances(true), this.#displayRate()]);
    const agent = this.#agentRecord(agentId);
    if (agentOffers(agent).length) await this.#marketFeeBps();
    return this.#agentView(
      agent,
      balances.values.get(agentId) ?? null,
      rate,
      await this.#registrationFacts(agent),
      await this.#serviceCosts(),
    );
  }

  #serviceCostLamports: ServiceCosts | null = null;

  /**
   * What a service costs that does not come back. `offer`: putting one on
   * offer, once: the deposits behind its permanent marketplace record and
   * behind the safety check of its description, plus the fees. `words`:
   * saving new words for one already on the marketplace: the deposit behind
   * a new safety check, the check's fee and the change's own fee. Read once.
   */
  async #serviceCosts(): Promise<ServiceCosts> {
    if (this.#serviceCostLamports === null) {
      const read = await Promise.all([
        this.#chain.getMinimumBalanceForRentExemption(LISTING_ACCOUNT_SPACE),
        approvalCost(this.#chain, "listing"),
      ]).catch(() => null);
      if (read === null) return { offer: null, words: null };
      const [rent, check] = read;
      const fee = this.#chain.transferFeeLamports;
      this.#serviceCostLamports = { offer: rent + fee + check, words: check + fee };
    }
    return this.#serviceCostLamports;
  }

  /**
   * The agent's marketplace deposit. It stays locked while the agent is
   * registered, whether or not taking jobs is switched on, so it is shown
   * either way. An agent that never registered costs no network read.
   */
  /** The agent's record on the marketplace, or null when it never registered (or cannot be read). */
  async #registrationFacts(agent: AgentRecord): Promise<RegistrationFacts | null> {
    const found = await this.#earn.registration(agent.id).catch(() => null);
    return found === null ? null : registrationFacts(found.account);
  }

  #ratingCostLamports: bigint | null = null;

  /** What a rating costs, read once and remembered. */
  async #ratingCost(): Promise<bigint | null> {
    if (this.#ratingCostLamports === null) {
      this.#ratingCostLamports = await ratingCost(this.#chain).catch(() => null);
    }
    return this.#ratingCostLamports;
  }

  /** What posting a request from the main balance costs on top of its reward, when read. */
  #postCostCache: (JobDeposits & { at: number }) | null = null;
  #postCostReading: Promise<void> | null = null;

  /**
   * The quote for posting a request from the main balance. It takes several
   * reads, so an overview never waits for it: the first one goes without it,
   * and the panel is told to read again once it is in. It is read again
   * after a while, and after the main balance's first job, whose one-time
   * record it no longer has to pay.
   */
  #postCost(rate: number | null): WalletOverview["postCost"] {
    const cached = this.#postCostCache;
    if ((cached === null || this.#now() - cached.at >= POST_COST_TTL_MS) && this.#postCostReading === null) {
      this.#postCostReading = requestDeposits(this.#chain, this.mainAddress)
        .then((deposits) => {
          this.#postCostCache = { at: this.#now(), ...deposits };
          this.#emit({ type: "overview" });
        })
        .catch((error: unknown) => {
          this.#log(`posting quote: ${describeError(error)}`);
        })
        .finally(() => {
          this.#postCostReading = null;
        });
    }
    if (cached === null) return null;
    // Kept: the records that stay, and the fees of the job's transactions
    // (post, its check, pin, pay or cancel, tidy). Set aside: the deposits
    // that come back when the job is tidied. The room left for fees is
    // neither, since it is never spent.
    const cost = jobCosts(cached);
    return {
      kept: money(cost.fees - cached.cancellationRent, rate),
      setAside: money(cost.returned, rate),
    };
  }

  async #jobView(job: JobRecord, isOwner: boolean): Promise<JobView> {
    const rate = await this.#displayRate();
    const view = jobView(job, {
      usdPerSol: rate,
      now: this.#now(),
      network: this.#chain.network,
      isOwner,
      ratingCostLamports: await this.#ratingCost(),
      changesCanBeSent: this.#services.postChangeRequest !== undefined,
      firstRecordCostLamports: await this.#firstRecordCost(job),
    });
    if (job.task && view.status === "paid") {
      const split = await settledOperatorPayment(this.#chain, job.task as Address).catch(() => null);
      if (split) view.operatorPayment = { address: split.address, paid: money(split.paid, rate),
        forfeited: money(split.forfeited, rate), sellerNet: money(split.sellerNet, rate) };
    }
    return view;
  }

  /** Per paying wallet: what its first turn-down or cancel spends on its record. */
  readonly #recordCosts = new Map<string, { lamports: bigint; at: number }>();
  /** Per paying wallet: the read of that cost under way, which all its jobs wait on. */
  readonly #recordCostReads = new Map<string, Promise<bigint | null>>();

  /** After a turn-down or cancel the paying wallet has its record: read it again. */
  #forgetRecordCost(job: JobRecord): void {
    const payer =
      job.payer === "main" ? this.mainAddress : this.#store.state.agents[job.agentId]?.address;
    if (payer === undefined) return;
    this.#recordCosts.delete(payer);
    // A read under way may have looked before the record was made.
    this.#recordCostReads.delete(payer);
  }

  /**
   * What the job's paying wallet would spend, once, to start its marketplace
   * record if it turned the job down or cancelled it now, read from rent. Only
   * read while a buying job can still be turned down or cancelled. A record
   * is never removed, so once it exists the answer stays 0; a missing one is
   * read again after a minute. The jobs one wallet pays for share one read,
   * so a list of many costs one read per paying wallet.
   */
  async #firstRecordCost(job: JobRecord): Promise<bigint | null> {
    if (job.role !== "buying" || job.payer === null || job.outcome !== null) return null;
    if (job.phase !== "active" && job.phase !== "hired") return null;
    const payer =
      job.payer === "main"
        ? this.mainAddress
        : (this.#store.state.agents[job.agentId]?.address as Address | undefined);
    if (payer === undefined) return null;
    const cached = this.#recordCosts.get(payer);
    if (cached !== undefined && (cached.lamports === 0n || this.#now() - cached.at < 60_000)) {
      return cached.lamports;
    }
    const pending = this.#recordCostReads.get(payer);
    if (pending !== undefined) return pending;
    const read: Promise<bigint | null> = creatorRecordCost(this.#chain, payer).then(
      (lamports) => {
        // Not kept when a turn-down or cancel came in between.
        if (this.#recordCostReads.get(payer) === read) {
          this.#recordCostReads.delete(payer);
          this.#recordCosts.set(payer, { lamports, at: this.#now() });
        }
        return lamports;
      },
      () => {
        if (this.#recordCostReads.get(payer) === read) this.#recordCostReads.delete(payer);
        return cached?.lamports ?? null;
      },
    );
    this.#recordCostReads.set(payer, read);
    return read;
  }

  async overview(): Promise<WalletOverview> {
    const [balances, rate] = await Promise.all([this.#readBalances(), this.#displayRate()]);
    const state = this.#store.state;
    const ordered = Object.values(state.agents).sort((a, b) => a.createdAt - b.createdAt);
    const facts = await Promise.all(ordered.map((agent) => this.#registrationFacts(agent)));
    const [costs] = await Promise.all([this.#serviceCosts(), ordered.some((agent) => agentOffers(agent).length) && this.#marketFeeBps()]);
    return {
      capabilities: [...WALLET_CAPABILITIES],
      network: this.#chain.network,
      main: {
        address: this.mainAddress,
        balance: money(balances.values.get(MAIN_KEY) ?? 0n, rate),
        // Offline with no figure kept from an earlier read, the 0 above is not known to be the balance.
        balanceKnown: balances.values.has(MAIN_KEY),
        spent: money(state.mainSpentLamports ?? "0", rate),
      },
      held: money(this.#heldBy(null), rate),
      agents: ordered.map((agent, index) =>
        this.#agentView(agent, balances.values.get(agent.id) ?? null, rate, facts[index] ?? null, costs),
      ),
      solUsd: rate,
      pendingApprovals: Object.values(state.approvals).filter(
        (approval) => approval.status === "pending",
      ).length,
      offline: balances.offline,
      earning: !this.#earn.available ? "off" : this.#earn.ownJobsOnly ? "own-jobs" : "open",
      backup: this.#backupStatus(),
      postCost: this.#postCost(rate),
    };
  }

  // ------------------------------------------------------------- backup

  #backupStatus(): WalletOverview["backup"] {
    const last = this.#store.state.backup ?? null;
    if (last === null) return { at: null, upToDate: false };
    const held = new Set(last.keyIds);
    return { at: last.at, upToDate: this.#vault.ids().every((id) => held.has(id)) };
  }

  /**
   * Seal every key and the journal into one backup locked with `password`,
   * written to `file`. Owner only: this is the one place a key leaves the
   * vault, and it leaves encrypted. The wallet counts itself backed up only
   * once the file is in place.
   */
  async exportBackup(
    password: string,
    file: string,
  ): Promise<{ createdAt: number; agents: number; main: string }> {
    const { text, header } = await createBackup({
      dataDir: this.#config.dataDir,
      vault: this.#vault,
      password,
      network: this.#chain.network,
      agents: Object.keys(this.#store.state.agents).length,
      now: this.#now(),
    });
    writeBackupFile(file, text);
    this.#store.update((draft) => {
      draft.backup = { at: header.createdAt, keyIds: this.#vault.ids() };
    });
    this.#emit({ type: "overview" });
    return { createdAt: header.createdAt, agents: header.agents, main: header.main };
  }

  /**
   * Try a password on the backup at `file` without changing anything. A host
   * asks this before it stops the service to restore, so a mistyped password
   * costs the person nothing.
   */
  async checkBackup(
    password: string,
    file: string,
  ): Promise<{ createdAt: number; agents: number; main: string }> {
    const header = checkBackup({
      text: readBackupFile(file),
      password,
      network: this.#chain.network,
    });
    return { createdAt: header.createdAt, agents: header.agents, main: header.main };
  }

  // ------------------------------------------------------------- agents

  /**
   * Make an agent with its own wallet. Nothing else is needed before it can
   * be used: it starts by asking the person every time, and a hire they
   * approve is paid from the main balance.
   */
  async createAgent(name?: string, scope: string | null = null): Promise<AgentView> {
    const agents = Object.values(this.#store.state.agents);
    const place = scope === null ? null : tidyText(scope, 512);
    if (place !== null && agents.some((agent) => (agent.scope ?? null) === place)) {
      throw new WalletError("BAD_REQUEST", "That already has an agent of its own.");
    }
    let clean: string;
    if (name !== undefined && name.trim().length > 0) {
      clean = clampName(name);
    } else {
      // "Agent 2", "Agent 3": the first number no agent is called yet.
      const taken = new Set(agents.map((agent) => agent.name));
      let number = agents.length + 1;
      while (taken.has(`Agent ${number}`)) number += 1;
      clean = `Agent ${number}`;
    }
    const id = newId("agent").toLowerCase().replace(/[^a-z0-9_]/g, "x");
    const keyId = `agent:${id}`;
    const agentAddress = await this.#vault.create(keyId);
    this.#store.update((draft) => {
      draft.agents[id] = {
        id,
        name: clean,
        scope: place,
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
        jobSpends: [],
        earn: { enabled: false, minPayCents: 0, jobsDone: 0, lastError: null, offer: null },
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
    await this.#lock(`wallet:${agentId}`, async () => this.#store.update(draft => { draft.agents[agentId]!.policy = clean; }));
    this.#emit({ type: "overview" });
    return this.#oneAgentView(agentId);
  }

  /**
   * The one spending setting a person needs: what an agent may spend on its
   * own each day. The agent's wallet is kept at that amount from the main
   * balance, never given more than that in a day, and a hire it cannot cover
   * waits for the person. Zero switches it off: the agent asks every time.
   * Money the agent already holds stays where it is.
   */
  async setBudget(agentId: string, perDayCents: number): Promise<AgentView> {
    const budget = assertPolicy({
      askAboveCents: perDayCents,
      refill: { enabled: perDayCents > 0, topUpToCents: perDayCents, perDayCents },
    });
    this.#agentRecord(agentId);
    await this.#lock(`wallet:${agentId}`, async () => this.#store.update(draft => { draft.agents[agentId]!.policy = budget; }));
    // Hand it over now, not at the next housekeeping pass.
    await this.#refill().catch((error) => {
      this.#log(`refill: ${describeError(error)}`);
    });
    this.#emit({ type: "overview" });
    return this.#oneAgentView(agentId);
  }

  /** Send lamports between two of this wallet's own keys, or out of it. */
  async #send(fromKey: string, to: Address, lamports: bigint, singleAttempt = false): Promise<string> {
    const signer = await this.#vault.signer(fromKey);
    try {
      const result = await this.#chain
        .clientFor(signer)
        .send([transferInstruction(signer, to, lamports)], singleAttempt ? { maxRetries: 0 } : undefined);
      return result.signature;
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError(
        "NETWORK",
        "Market could not confirm the transfer. Check its status before trying again.",
        { cause: error },
      );
    } finally {
      this.#dropBalances();
    }
  }

  #reserveCharge(agent: AgentRecord, charge: AllowanceCharge, signature?: string): void {
    const cutoff = this.#now() - 86_400_000;
    agent.refills = agent.refills.filter((item) => item.work || item.ts > cutoff);
    if (charge.ts <= cutoff) return;
    const existing = agent.refills.find((item) => item.id === charge.id);
    if (!existing) agent.refills.push({ ...charge, ...(signature && { signature }) });
    else if (signature) existing.signature = signature;
  }

  /** Apply the signed operation and consume its receipt in the same journal write. */
  #finishListingSend(agentId: string, signature: string, landed: boolean, completed?: ListingOperation): void {
    this.#store.update((draft) => {
      const agent = draft.agents[agentId]!;
      const pending = agent.earn.pendingListingSends;
      const operation = pending?.find((r) => r.signature === signature)?.operation ?? completed;
      if (pending) agent.earn.pendingListingSends = pending.filter((r) => r.signature !== signature);
      if (operation?.kind === "funding" && operation.decision) {
        if (agent.earn.sellerDecisions?.[operation.decision.quoteId]) return;
        applySellerDecision(agent, operation.decision, landed, signature);
        if (landed) agentOffers(agent).forEach(clearOfferFundingWait);
      }
      if (!landed || !operation) return;
      if (operation.kind === "funding") {
        if (operation.charge) this.#reserveCharge(agent, operation.charge, signature);
        this.#note(draft, { kind: "allowance", agentId, signature, text: operation.text, lamports: BigInt(operation.lamports) });
        // Replaying an old receipt must not overwrite a newer balance observation.
        if (completed || draft.lastMainLamports === operation.priorObservation) {
          draft.lastMainLamports = (BigInt(operation.mainBalance) - BigInt(operation.lamports)).toString();
        }
      } else if (operation.kind === "create") {
        const offer = agentOffers(agent).find((item) => item.listing === operation.listing);
        if (offer) {
          offer.listed = true;
          offer.signatures.create = signature;
          offer.status = "being_checked";
          offer.error = null;
        }
        this.#note(draft, { kind: "note", text: `${agent.name} now offers “${operation.name}”.`, agentId, signature });
      } else {
        for (const offer of agentOffers(agent)) {
          if (offer.listing && operation.listings.includes(offer.listing)) offer.signatures[operation.kind] = signature;
        }
      }
    });
  }

  /** Move `lamports` from the main balance to an agent, keeping main alive. */
  async #mainToAgent(
    agent: AgentRecord,
    lamports: bigint,
    text: string,
    funding?: { approved?: boolean; exact?: EarnFundingQuote; decision?: SellerDecision },
  ): Promise<void> {
    await this.#lock(MAIN_KEY, async () => {
      this.#checkPendingFunding(agent.id);
      const floor = await this.#floor();
      const mainBalance = await this.#chain.getBalance(this.mainAddress);
      const agentBalance = await this.#chain.getBalance(agent.address as Address);
      const continuation = this.#quotedContinuation.getStore();
      if (funding && !funding.approved && continuation?.active && continuation.agentId === agent.id) {
        throw new WalletError("APPROVAL_REQUIRED", "The action needs more funding. Review a new quote.");
      }
      if (funding?.exact && (funding.exact.expiresAt <= this.#now() ||
        agentBalance !== BigInt(funding.exact.agentBalance.lamports) ||
        this.#chain.transferFeeLamports !== BigInt(funding.exact.transferFee.lamports))) {
        throw new WalletError("PRICE_CHANGED", "Funding changed or the quote expired. Review a new quote.");
      }
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
      let reservation: AllowanceCharge | undefined;
      if (funding !== undefined) {
        const rate = await this.#freshRate().catch(() => null);
        const charge = lamports + this.#chain.transferFeeLamports;
        const dailyRoom = this.#dailyRoom(this.#agentRecord(agent.id), rate);
        if (funding.exact && BigInt(funding.exact.dailyRemaining.lamports) !== dailyRoom)
          throw new WalletError("PRICE_CHANGED", "The remaining daily allowance changed. Review a new quote.");
        if (!funding.approved && charge > dailyRoom) {
          throw new WalletError(
            "APPROVAL_REQUIRED",
            "This funding needs your approval. Review the full earning quote first.",
          );
        }
        // Reserve before broadcast under the main-wallet lock. An ambiguous
        // send or crash keeps its charge, so retrying cannot bypass the cap.
        const reserved = {
          id: newId("refill"),
          ts: this.#now(),
          lamports: charge.toString(),
          usdCents: rate === null ? null :
            Number((charge * BigInt(Math.ceil(rate * 1_000_000)) + 9_999_999n) / 10_000_000n) / 1_000_000,
        };
        reservation = reserved;
        if (!funding.decision) this.#store.update((draft) => this.#reserveCharge(draft.agents[agent.id]!, reserved));
      }
      const operation: ListingOperation = {
        kind: "funding", lamports: lamports.toString(), mainBalance: mainBalance.toString(),
        priorObservation: this.#store.state.lastMainLamports, text,
        ...(reservation && { charge: reservation }),
        ...(funding?.decision && { decision: funding.decision }),
      };
      const signature = await withListingOperation(operation, () => this.#send(MAIN_KEY, agent.address as Address, lamports, !!funding?.decision));
      if (!transportSignal()) this.#finishListingSend(agent.id, signature, true, operation);
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
      // A part leaves the network's minimum and the fee of this very
      // transfer; all of it leaves nothing once the agent pays for nothing.
      const keep =
        amount === "all" ? await this.#keepOnAll(agent) : (await this.#floor()) + this.#chain.transferFeeLamports;
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
      throw new WalletError("BAD_REQUEST", "That address is already yours: your balance or one of your agents.");
    }
    return this.#lock(MAIN_KEY, async () => {
      const floor = await this.#floor();
      // As for an agent: everything leaves when nothing may still need it.
      const keep = amount === "all" ? await this.#keepOnAll("main") : floor + this.#chain.transferFeeLamports;
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
          text: "Sent money out of your balance.",
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

  /**
   * The marketplace's fee rate, in basis points: its share of every price.
   * Null when it cannot be read.
   */
  async #marketFeeBps(): Promise<number | null> {
    const known = this.#feeRate;
    if (known !== null && this.#now() - known.at < (known.bps === null ? FEE_RATE_RETRY_MS : FEE_RATE_TTL_MS)) {
      return known.bps;
    }
    let bps: number | null = null;
    try {
      const config = await readProtocolConfig(this.#chain);
      bps = config.protocolFeeBps >= 0 && config.protocolFeeBps <= 10_000 ? config.protocolFeeBps : null;
    } catch {
      bps = null;
    }
    // A rate read before stays good when a later read fails.
    this.#feeRate = { at: this.#now(), bps: bps ?? (known?.bps ?? null) };
    return bps ?? known?.bps ?? null;
  }

  /** Everything a list of services is described with, besides the services themselves. */
  async #serviceContext(rows: readonly CatalogRow[], waitMs: number, rate: number | null): Promise<ServiceContext> {
    const [known, feeBps] = await Promise.all([
      rows.some((row) => !row.recordPending)
        ? this.#records.read(rows.filter((row) => !row.recordPending).map(recordRow), waitMs)
        : { record: null, reading: false },
      this.#marketFeeBps(),
    ]);
    const byProvider = new Map<string, { listing: string; name: string }[]>();
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.listing)) continue;
      seen.add(row.listing);
      const list = byProvider.get(row.providerAgent) ?? [];
      list.push({ listing: row.listing, name: row.name });
      byProvider.set(row.providerAgent, list);
    }
    return { known, rate, feeBps, byProvider };
  }

  /**
   * What every job costs on top of its price and never comes back: the
   * deposit of the small marker that stays where the finished job's record
   * was, plus the fees of its transactions. Revision 9: the rest of the
   * record's deposit and the deposit behind the safety check of the request
   * come back when the job is tidied.
   */
  async networkFee(rateSnapshot?: number | null): Promise<Money> {
    const [marker, rate] = await Promise.all([
      this.#chain.getMinimumBalanceForRentExemption(getTaskMarkerSize()),
      rateSnapshot === undefined ? this.#displayRate() : rateSnapshot,
    ]);
    return money(marker + jobNetworkFees(this.#chain.transferFeeLamports), rate);
  }

  async find(params: MethodParams<"market.find">) {
    return (await this.#discovery.search(params)).page;
  }

  async findPage(params: MethodParams<"market.find">): Promise<MethodResult<"market.find">> {
    const { page, rate } = await this.#discovery.search(params);
    return { ...page, discovery: DISCOVERY_CAPABILITY, networkFee: await this.networkFee(rate) };
  }

  /**
   * The services this wallet's own agents have on offer right now that the
   * marketplace's list does not show yet. That list is put together by the
   * marketplace's site and runs minutes behind: a service that just went on
   * offer, or came back when the app was opened, is missing from it for a
   * while, and one of the person's agents could not find another's. The
   * wallet knows its own, so it adds them.
   */
  async #ownServices(listed: readonly CatalogRow[]): Promise<CatalogRow[]> {
    const known = new Set(listed.map((row) => row.listing));
    const own: CatalogRow[] = [];
    for (const agent of Object.values(this.#store.state.agents)) {
      for (const offer of agentOffers(agent)) {
        if (offer.status !== "live" || offer.listing === null) continue;
        if (known.has(offer.listing as Address)) continue;
        const providerAgent = await this.#earn.marketplaceAgent(agent.id).catch(() => null);
        if (providerAgent === null) continue;
        const terms = storedTerms(offer);
        own.push({
          listing: offer.listing as Address,
          providerAgent,
          name: offer.name,
          category: offer.category,
          summary: offer.summary,
          description: offer.summary,
          tags: terms.tags,
          inputs: terms.inputs,
          outputs: terms.outputs,
          maxOpenJobs: terms.maxOpenJobs,
          operator: terms.operator,
          operatorFeeBps: terms.operatorFeeBps,
          terms: [],
          details: "ready",
          priceLamports: BigInt(offer.priceLamports),
          rating: null,
          ratingCount: 0,
          jobsDone: 0,
          deliverySecs: offer.deliverySecs > 0 ? offer.deliverySecs : null,
          specHashHex: offer.specHashHex,
        });
      }
    }
    return own;
  }

  // --------------------------------------------------------------- hire

  /**
   * Start a purchase for an agent. Returns once the job is posted, has
   * failed, or is waiting for a person's approval.
   */
  async hire(params: Pick<TermsInput, "deadline" | "reviewWindowSecs"> & {
    agentId: string;
    listing: string;
    request: string;
    maxPriceCents?: number;
    expectedPriceLamports?: string;
    expectedSpecHash?: string;
    displayedLimitCents?: number;
    acceptance?: string[];
    idempotencyKey?: string;
  }, quoteOnly = false): Promise<{ job: JobView; approval: ApprovalView | null }> {
    const fingerprint = jobIdentity(params, quoteOnly);
    return this.#singleJobCall(params.agentId, "hire", params.idempotencyKey, fingerprint, () => this.#hire(params, quoteOnly, fingerprint));
  }

  async #hire(params: Parameters<AgencWallet["hire"]>[0], quoteOnly: boolean, fingerprint: string): Promise<{ job: JobView; approval: ApprovalView | null }> {
    const agent = this.#agentRecord(params.agentId);
    const request = typeof params.request === "string" ? params.request.trim() : "";
    if (request.length === 0 || request.length > 4_000) {
      throw new WalletError("BAD_REQUEST", "Say what you want done, in up to 4,000 characters.");
    }
    const acceptance = checkedAcceptance(params.acceptance);
    const key = params.idempotencyKey?.trim() || null;
    const again = await this.#sameCall(agent.id, key, "hire", fingerprint, () => jobIdentity(params, quoteOnly, "raw"));
    if (again !== null) return again;

    const listing = toAddress(params.listing, "service");
    if (agentOffers(agent).some((offer) => offer.listing === listing)) {
      throw new WalletError("NOT_ALLOWED", "An agent cannot hire its own service.");
    }
    const terms = await readHireableListing(this.#chain, listing);
    const rate = await this.#freshRate(true);
    const ceiling = params.displayedLimitCents === undefined ? params.maxPriceCents
      : Math.min(params.maxPriceCents ?? Infinity, params.displayedLimitCents);
    checkPriceLimit(terms.priceLamports, ceiling, rate);
    if ((params.expectedPriceLamports !== undefined && params.expectedPriceLamports !== terms.priceLamports.toString()) ||
        (params.expectedSpecHash !== undefined && params.expectedSpecHash !== values.bytesToHex(terms.specHash))) {
      throw new WalletError("PRICE_CHANGED", "The service changed. Refresh its details and request a new quote.");
    }

    const duration = terms.deliverySecs;
    if (duration === null) throw new WalletError("NOT_AVAILABLE", "The seller must set a delivery period before this service can be quoted.");
    const jobTerms = resolveJobTerms(params, await this.#chain.clusterTime(), this.#config.reviewWindowSecs ?? DEFAULT_REVIEW_WINDOW_SECS, duration);
    const spec = buildJobSpec({ title: terms.name, request, acceptance, listing, terms: jobTerms });
    const hash = await jobSpecHash(spec);
    const deposits = await purchaseDeposits(this.#chain, agent.address as Address);
    const floor = await this.#floor();
    const need = terms.priceLamports + deposits.total + floor;
    const agentBalance = await this.#chain.getBalance(agent.address as Address);
    const priceCents = lamportsToCents(terms.priceLamports, rate);
    // Without a price the limit cannot be checked, so a person decides.
    const withinLimit = priceCents !== null && priceCents <= agent.policy.askAboveCents;
    const covered = agentBalance >= need;
    const autonomous = !quoteOnly && withinLimit && covered;
    const taskId = values.randomId32();
    await checkHireOperator(terms.operator, terms.operatorFeeBps, covered ? agent.address as Address : this.mainAddress, taskId);

    const now = this.#now();
    const jobId = newId("job");
    if (quoteOnly) {
      const rows = await this.#services.listServices({ listing }).catch(() => []);
      const row = rows.find(candidate => candidate.listing === listing);
      if (row && row.specHashHex !== values.bytesToHex(terms.specHash))
        throw new WalletError("PRICE_CHANGED", "The description changed. Refresh the listing.");
      if (row) this.#discovery.rememberListing(row, await this.#serviceContext([row], 0, rate));
    }
    const service = this.#discovery.describeHire(terms, rate, await this.#marketFeeBps());
    const record: JobRecord = {
      id: jobId,
      inputFingerprint: fingerprint,
      buyerMaxPriceCents: params.maxPriceCents ?? null,
      ...(params.maxPriceCents !== undefined && { maxPriceCents: params.maxPriceCents }),
      terms: jobTerms,
      role: "buying",
      kind: "hire",
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
      taskIdHex: values.bytesToHex(taskId),
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

    return this.#queueJob(record, covered ? "agent" : "main", service, rate, quoteOnly);
  }

  async #jobDeposits(job: JobRecord, payer: Address) {
    if (!job.terms?.contest) return (isRequest(job) ? requestDeposits : purchaseDeposits)(this.#chain, payer);
    const registrationId = payer !== this.mainAddress && job.agentId !== ""
      ? this.#earn.contestRegistrationId(job.agentId, job.taskIdHex) : job.taskIdHex;
    const costs = await contestPostCosts(this.#chain, payer, registrationId);
    if (job.contestRegistration && JSON.stringify(job.contestRegistration) !== JSON.stringify(costs.registration)) {
      throw new WalletError("PRICE_CHANGED", "The creator registration changed. Request a new quote.");
    }
    if (!job.contestRegistration) job.contestRegistration = costs.registration;
    return costs;
  }

  async #queueJob(record: JobRecord, payer: "main" | "agent", service: ServiceView | null, rate: number | null, panel: boolean, replaces?: string) {
    const address = payer === "main" ? this.mainAddress : this.#agentRecord(record.agentId).address as Address;
    const [deposits, { protocolFeeBps }, chainNow] = await Promise.all([
      this.#jobDeposits(record, address),
      readProtocolConfig(this.#chain),
      this.#chain.clusterTime(),
    ]);
    if (!record.terms || record.terms.deadline <= chainNow) {
      throw new WalletError("NOT_AVAILABLE", "The delivery deadline has passed. Choose a new deadline.");
    }
    const now = this.#now();
    const remainingDeliveryMs = (record.terms.deadline - chainNow) * 1000;
    const expiresAt = now + Math.min(this.#config.approvalTtlMs ?? 30 * 60_000, remainingDeliveryMs);
    const approvalId = newId("ok");
    const name = record.agentId === "" ? "You" : this.#agentRecord(record.agentId).name;
    const { job, approval } = buildJobQuote(record, {
      approvalId, payer, service, deposits, protocolFeeBps, rate, now, expiresAt,
    });
    if (record.terms.contest) {
      Object.assign(approval, await entrantCosts(this.#chain));
      if (payer === "agent" && rate !== null) {
        const allIn = microcents(BigInt(job.priceLamports) + jobCosts(deposits).extra, rate);
        const agent = this.#agentRecord(record.agentId);
        const remaining = remainingJobMicrocents(agent, now, job.id);
        job.contestOverage = (allIn > remaining ? allIn - remaining : 0n).toString();
        approval.contestOverage = job.contestOverage;
        job.contestOverBudget = allIn > remaining;
        approval.contestOverBudget = job.contestOverBudget;
      }
    }
    if (job.phase === "cleared" && rate !== null) {
      const allowed = await this.#lock(this.#payerLock(job), async () => this.#store.update(draft => {
        const charge = microcents(BigInt(job.priceLamports) + jobCosts(deposits).extra, rate);
        if (!reserveJobSpend(draft.agents[job.agentId]!, job.id, charge, microcents(BigInt(job.priceLamports), rate), now, false)) return false;
        draft.jobs[job.id] = job;
        draft.approvals[approvalId] = { ...approval, status: "approved" };
        return true;
      }));
      if (allowed) {
        await this.#advance(job.id);
        const pending = this.#store.state.approvals[approvalId]!;
        return { job: await this.#jobView(this.#jobRecord(job.id), false), approval: pending.status === "pending" ? approvalView(pending, name, rate) : null };
      }
      job.phase = "needs_approval";
    }
    if (panel) {
      // Drafts shown while typing cannot appear as jobs or spend. A restart invalidates them.
      for (const [id, draft] of this.#panelQuotes) {
        if (draft.approval.expiresAt <= now) this.#panelQuotes.delete(id);
      }
      const oldest = this.#panelQuotes.keys().next().value;
      if (oldest && this.#panelQuotes.size >= 128) this.#panelQuotes.delete(oldest);
      this.#panelQuotes.set(approvalId, { job, approval });
    } else {
      this.#store.update(draft => {
        draft.jobs[job.id] = job;
        if (replaces) {
          if (draft.approvals[replaces]?.status !== "pending") throw new WalletError("NOT_AVAILABLE", "The original quote expired.");
          draft.approvals[replaces]!.status = "expired";
        }
        draft.approvals[approvalId] = approval;
      });
      this.#emit({ type: "approval", approvalId });
      this.#emit({ type: "job", jobId: record.id });
      this.#emit({ type: "overview" });
    }
    return {
      job: await this.#jobView(job, record.agentId === ""),
      approval: approvalView(approval, name, rate),
    };
  }

  /**
   * The job an earlier call with the same key started, as that call answered
   * it: a call delivered twice hires or posts once.
   */
  async #sameCall(
    agentId: string,
    key: string | null,
    kind: "hire" | "request",
    fingerprint?: string,
    rawFingerprint?: () => string,
  ): Promise<{ job: JobView; approval: ApprovalView | null } | null> {
    if (key === null) return null;
    const panel = Array.from(this.#panelQuotes.values()).find(({ job }) => job.agentId === agentId && job.idempotencyKey === key && job.kind === kind);
    if (panel && panel.approval.expiresAt > this.#now()) {
      if (fingerprint) this.#checkFingerprint(panel.job.inputFingerprint, fingerprint);
      const name = agentId === "" ? "You" : this.#agentRecord(agentId).name;
      return { job: await this.#jobView(panel.job, true), approval: approvalView(panel.approval, name, panel.approval.quoteRate ?? null) };
    }
    const existing = Object.values(this.#store.state.jobs).find(
      (job) => job.agentId === agentId && job.idempotencyKey === key && (job.kind ?? "hire") === kind,
    ) ?? this.#store.state.callReceipts?.[JSON.stringify([agentId, kind, key])];
    if (existing === undefined) return null;
    if (fingerprint && existing.inputFingerprint !== fingerprint) {
      this.#checkFingerprint(existing.inputFingerprint, rawFingerprint?.() ?? fingerprint);
    }
    const approval = Object.values(this.#store.state.approvals).find(
      (entry) => entry.jobId === existing.id && entry.status === "pending",
    );
    // An owner re-entering the same panel request joins the original decision,
    // including one still publishing its brief.
    if (existing.approvalId && agentId === "" && this.#locks.has(`decision:${existing.approvalId}`)) {
      await this.#locks.get(`decision:${existing.approvalId}`);
      return { job: await this.#jobView(this.#jobRecord(existing.id), true), approval: null };
    }
    const rate = await this.#displayRate();
    const name = agentId === "" ? "You" : this.#store.state.agents[agentId]?.name ?? "An agent";
    return {
      job: await this.#jobView(existing, agentId === ""),
      approval: approval === undefined ? null : approvalView(approval, name, rate),
    };
  }

  async callOutcome(agentId: string, kind: "hire" | "request", key: string) {
    const result = await this.#sameCall(agentId, key.trim(), kind);
    if (!result) throw new WalletError("NOT_FOUND", "There is no saved outcome for this call.");
    return result;
  }

  // --------------------------------------------------------------- post

  /** What a request asks for and pays, checked the same way for an agent and for the person. */
  async #requestTerms(params: TermsInput & {
    request: string;
    reward: AmountInput;
    deadlineDays?: number;
    acceptance?: string[];
  }): Promise<RequestTerms> {
    const request = typeof params.request === "string" ? params.request.trim() : "";
    if (request.length === 0 || request.length > 4_000) {
      throw new WalletError("BAD_REQUEST", "Say what you need, in up to 4,000 characters.");
    }
    const acceptance = checkedAcceptance(params.acceptance);
    const clock = await this.#chain.clusterTime();
    const terms = resolveJobTerms(params, clock, this.#config.reviewWindowSecs ?? DEFAULT_REVIEW_WINDOW_SECS, null);
    if (typeof params.reward !== "object" || params.reward === null) {
      throw new WalletError("BAD_REQUEST", "Say what the request pays.");
    }
    const rate = await this.#freshRate(true);
    if (terms.contest && rate === null) throw new WalletError("NETWORK", "Dollar prices are unavailable. Refresh the contest quote.");
    const rewardLamports = "usdCents" in params.reward && rate !== null
      ? ceilingLamports(params.reward.usdCents, rate) : await this.#toLamports(params.reward, rate);
    if (rewardLamports < MIN_OFFER_PRICE_LAMPORTS) {
      throw new WalletError("BAD_REQUEST", "That reward is too small to post.");
    }
    return {
      title: requestTitle(request),
      request,
      acceptance,
      rewardLamports,
      rate,
      deliverWithinSecs: terms.deadline - clock,
      terms,
    };
  }

  async #requestRecord(
    agentId: string,
    key: string | null,
    terms: RequestTerms,
    phase: "cleared" | "needs_approval",
    payer: "agent" | "main" | null,
  ): Promise<JobRecord> {
    const now = this.#now();
    // A draft of what will be published; the published one replaces it.
    const spec = buildJobSpec({
      title: terms.title,
      terms: terms.terms,
      request: terms.request,
      acceptance: terms.acceptance,
      listing: null,
    });
    return {
      id: newId("job"),
      role: "buying",
      kind: "request",
      agentId,
      createdAt: now,
      updatedAt: now,
      idempotencyKey: key,
      listing: "",
      providerAgent: "",
      title: terms.title,
      terms: terms.terms,
      request: terms.request,
      acceptance: terms.acceptance,
      priceLamports: terms.rewardLamports.toString(),
      deliverWithinSecs: terms.deliverWithinSecs,
      requestDeadline: terms.terms.deadline,
      expectedVersion: "0",
      listingSpecHashHex: "",
      payer,
      taskIdHex: values.bytesToHex(values.randomId32()),
      task: null,
      jobSpec: spec,
      jobSpecHashHex: (await jobSpecHash(spec)).hex,
      jobSpecUri: null,
      phase,
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
  }

  /**
   * Post a request for anyone to take, as an agent paying from its own
   * money. Within its daily budget, and when its money covers the reward and
   * the deposits, it is posted at once; otherwise it waits for the person, as
   * a hire does. Returns once it is posted, has failed, or waits.
   */
  async post(params: TermsInput & {
    agentId: string;
    request: string;
    reward: AmountInput;
    deadlineDays?: number;
    acceptance?: string[];
    idempotencyKey?: string;
  }): Promise<{ job: JobView; approval: ApprovalView | null }> {
    const fingerprint = jobIdentity(params, false);
    return this.#singleJobCall(params.agentId, "post", params.idempotencyKey, fingerprint, () => this.#post(params, fingerprint));
  }

  async #post(params: Parameters<AgencWallet["post"]>[0], fingerprint: string): Promise<{ job: JobView; approval: ApprovalView | null }> {
    const agent = this.#agentRecord(params.agentId);
    const key = params.idempotencyKey?.trim() || null;
    const again = await this.#sameCall(agent.id, key, "request", fingerprint, () => jobIdentity(params, false, "raw"));
    if (again !== null) return again;
    const terms = await this.#requestTerms(params);
    const rate = terms.rate;
    const deposits = await (terms.terms.contest
      ? contestPostCosts(this.#chain, agent.address as Address, "") : requestDeposits(this.#chain, agent.address as Address));
    const floor = await this.#floor();
    const need = terms.rewardLamports + deposits.total + floor;
    const agentBalance = await this.#chain.getBalance(agent.address as Address);
    const rewardCents = lamportsToCents(terms.rewardLamports, rate);
    // Without a price the budget cannot be checked, so a person decides.
    const withinLimit = rewardCents !== null && rewardCents <= agent.policy.askAboveCents;
    const covered = agentBalance >= need;
    const autonomous = !terms.terms.contest && withinLimit && covered;
    const record = await this.#requestRecord(
      agent.id,
      key,
      terms,
      autonomous ? "cleared" : "needs_approval",
      autonomous ? "agent" : null,
    );
    record.inputFingerprint = fingerprint;
    if ("usdCents" in params.reward) record.maxPriceCents = params.reward.usdCents;
    return this.#queueJob(record, covered ? "agent" : "main", null, rate, false);
  }

  /** Legacy direct creation is refused even for an owner connection. */
  async postFromBalance(_params: TermsInput & { request: string; reward: AmountInput; acceptance?: string[]; idempotencyKey?: string }): Promise<JobView> {
    throw new WalletError("NOT_ALLOWED", "Request a quote and approve its ID before posting.");
  }

  async quotePost(params: Parameters<AgencWallet["postFromBalance"]>[0]) {
    return this.#balanceRequest(params, true);
  }

  async #balanceRequest(params: Parameters<AgencWallet["postFromBalance"]>[0], quoteOnly: boolean) {
    const fingerprint = jobIdentity(params, quoteOnly);
    return this.#singleJobCall("", "postFromBalance", params.idempotencyKey, fingerprint, () => this.#postFromBalance(params, quoteOnly, fingerprint));
  }

  async #postFromBalance(params: Parameters<AgencWallet["postFromBalance"]>[0], quoteOnly: boolean, fingerprint: string) {
    const key = params.idempotencyKey?.trim() || null;
    const again = await this.#sameCall("", key, "request", fingerprint, () => jobIdentity(params, quoteOnly, "raw"));
    if (again !== null) return again;
    const terms = await this.#requestTerms(params);
    // Said at once here; checked again just before anything is sent.
    if (terms.terms.contest && !quoteOnly) throw new WalletError("NOT_ALLOWED", "Review the contest quote before posting.");
    const deposits = await (terms.terms.contest ? contestPostCosts(this.#chain, this.mainAddress, "") : requestDeposits(this.#chain, this.mainAddress));
    const floor = await this.#floor();
    const need = terms.rewardLamports + deposits.total + floor;
    const balance = await this.#chain.getBalance(this.mainAddress);
    if (balance < need) {
      const rate = await this.#displayRate();
      throw new WalletError(
        "NOT_ENOUGH_MONEY",
        `There is not enough in your balance. This needs ${formatMoney(money(need, rate))} and you have ${formatMoney(money(balance, rate))}.`,
      );
    }
    const record = await this.#requestRecord("", key, terms, "needs_approval", "main");
    record.inputFingerprint = fingerprint;
    if ("usdCents" in params.reward) record.maxPriceCents = params.reward.usdCents;
    return this.#queueJob(record, "main", null, terms.rate, true);
  }

  /**
   * Pay for a safety check the marketplace handed back. The transaction was
   * built by the approver: it is checked against what was asked for, signed
   * with the paying wallet's key, and sent. `sending` runs once it is signed,
   * just before it goes out, so the caller can note that a payment may be on
   * its way.
   */
  async #payApproval(
    payer: KeyPairSigner,
    payment: ApprovalPayment,
    target: ApprovalTarget,
    sending: () => void,
  ): Promise<string> {
    // A record by anyone else would not be accepted afterwards, so paying for
    // one would be money for nothing.
    const accepted = await acceptedApprovers(this.#chain, this.#services);
    if (!accepted.includes(payment.moderator)) {
      throw new WalletError(
        "NETWORK",
        "The marketplace's safety check sent back something that cannot be trusted. Nothing was paid.",
      );
    }
    const ready = await signApproval(this.#chain, payer, payment, target);
    sending();
    const signature = target.kind === "listing"
      ? await withListingOperation({ kind: "approval", listings: [target.listing],
          lamports: (ready.depositLamports + APPROVAL_FEE_LAMPORTS).toString() }, () => this.#chain.sendSigned(ready.transaction))
      : await this.#chain.sendSigned(ready.transaction);
    this.#dropBalances();
    this.#emit({ type: "overview" });
    return signature;
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

  async approvalPage(after?: string) {
    // A stable compound cursor survives another approval leaving the queue.
    const cursor = (a: ApprovalRecord) => String(a.createdAt).padStart(16, "0") + ":" + a.id;
    const ordered = Object.values(this.#store.state.approvals)
      .filter(a => a.status === "pending" && (!after || cursor(a) > after))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const rows = ordered.slice(0, 48);
    return { entries: rows.map(({ id, jobId }) => ({ id, jobId })), next: ordered.length > rows.length ? cursor(rows.at(-1)!) : null };
  }

  async getApproval(id: string) {
    const entry = this.#panelQuotes.get(id)?.approval ?? this.#store.state.approvals[id];
    if (!entry) throw new WalletError("NOT_FOUND", "That quote is no longer available.");
    const name = entry.agentId === "" ? "You" : this.#store.state.agents[entry.agentId]?.name ?? "An agent";
    return { approval: approvalView(entry, name, entry.quoteRate ?? null), status: entry.status };
  }

  async approvalListPage(after?: string) {
    const page = await this.approvalPage(after);
    const approvals: ApprovalView[] = [];
    let bytes = 0;
    for (const { id } of page.entries) {
      const { approval } = await this.getApproval(id);
      bytes += Buffer.byteLength(JSON.stringify(approval)) + 1;
      if (bytes > 512 * 1024 && approvals.length) {
        const last = approvals.at(-1)!;
        return { approvals, next: String(last.createdAt).padStart(16, "0") + ":" + last.id };
      }
      approvals.push(approval);
    }
    return { approvals, next: page.next };
  }

  async approvalOutcome(id: string) {
    const panel = this.#panelQuotes.get(id);
    const entry = panel?.approval ?? this.#store.state.approvals[id];
    if (!entry) {
      const receipt = Object.values(this.#store.state.callReceipts ?? {}).find(job => job.approvalId === id);
      if (receipt) return { status: receipt.phase === "declined" ? "declined" as const : "approved" as const, job: await this.#jobView(receipt, true) };
      throw new WalletError("NOT_FOUND", "That quote is no longer available.");
    }
    const { status, approval } = await this.getApproval(id);
    const job = panel?.job ?? this.#jobRecord(entry.jobId);
    return { status, approval, job: await this.#jobView(job, true) };
  }

  async refreshApproval(id: string) {
    return this.#lock(`decision:${id}`, async () => {
      const entry = this.#store.state.approvals[id];
      if (!entry || entry.status !== "pending") throw new WalletError("NOT_AVAILABLE", "That quote cannot be refreshed.");
      const rate = await this.#freshRate(true);
      if (rate === null) throw new WalletError("NETWORK", "Dollar prices are still unavailable.");
      const old = this.#jobRecord(entry.jobId);
      if (!old.payer) throw new WalletError("NOT_AVAILABLE", "Request a new quote.");
      // Older priced hires stored only the effective maximum. Release it only
      // if the request fingerprint proves that the buyer gave no limit.
      const cap = old.buyerMaxPriceCents === undefined
        ? legacyRefreshLimit(old)
        : old.buyerMaxPriceCents ?? undefined;
      checkPriceLimit(BigInt(old.priceLamports), cap, rate);
      const replacement = { ...old };
      if (cap === undefined) delete replacement.maxPriceCents;
      else replacement.maxPriceCents = cap;
      const result = await this.#queueJob(replacement, old.payer, entry.service, rate, false, id);
      return { approval: result.approval! };
    });
  }

  async listApprovals(): Promise<ApprovalView[]> {
    const rate = await this.#displayRate();
    const state = this.#store.state;
    return Object.values(state.approvals)
      .filter((approval) => approval.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((approval) =>
        approvalView(approval, approval.agentId === "" ? "You" : state.agents[approval.agentId]?.name ?? "An agent", rate),
      );
  }

  /** A person answers an approval. Approving starts the purchase. */
  async decideApproval(approvalId: string, approve: boolean): Promise<JobView> {
    return this.#lock(`decision:${approvalId}`, () => this.#decideJobQuote(approvalId, approve));
  }

  async #decideJobQuote(approvalId: string, approve: boolean): Promise<JobView> {
    const panel = this.#panelQuotes.get(approvalId);
    const approval = panel?.approval ?? this.#store.state.approvals[approvalId];
    if (approval === undefined) throw new WalletError("NOT_FOUND", "That request is gone.");
    if (approval.status === "expired" && approve) throw new WalletError("NOT_AVAILABLE", "The quote expired. Request a new quote.");
    if (approval.status !== "pending") {
      if (approve && approval.status === "approved" && this.#jobRecord(approval.jobId).terms?.contest) await this.#advance(approval.jobId, true);
      return this.#jobView(this.#jobRecord(approval.jobId), true);
    }
    const jobId = approval.jobId;
    if (!approve) {
      if (panel) {
        this.#panelQuotes.delete(approvalId);
        return this.#jobView({ ...panel.job, phase: "declined" }, true);
      }
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

    const job = panel?.job ?? this.#jobRecord(jobId);
    if (!job.approvedCosts || !job.terms || job.payer === null) {
      throw new WalletError("NOT_AVAILABLE", "This quote needs to be made again. Decline it and request a new quote.");
    }
    const payer = job.payer;
    const address = payer === "main" ? this.mainAddress : this.#agentRecord(job.agentId).address as Address;
    const deposits = await this.#jobDeposits(job, address);
    const need = BigInt(job.priceLamports) + deposits.total + await this.#floor();
    const available = await this.#chain.getBalance(address);
    await this.#checkJobQuote(job, deposits);
    if (!isRequest(job)) {
      const terms = await readHireableListing(this.#chain, job.listing as Address);
      await checkHireOperator(terms.operator, terms.operatorFeeBps, address, values.hexToBytes(job.taskIdHex));
    }
    if (job.terms.contest) {
      const costs = await entrantCosts(this.#chain);
      if (costs.entryRentLamports !== approval.entryRentLamports || costs.workerRecordLamports !== approval.workerRecordLamports) {
        throw new WalletError("PRICE_CHANGED", "The entry costs changed. Request a new quote.");
      }
    }
    if (panel) {
      // A yes binds the draft to a durable job, including when its payer needs more money.
      this.#store.update(draft => {
        draft.jobs[jobId] = job;
        draft.approvals[approvalId] = approval;
      });
      this.#panelQuotes.delete(approvalId);
    }
    if (this.#store.state.approvals[approvalId]?.status !== "pending") {
      return this.#jobView(this.#jobRecord(jobId), true);
    }
    if (available < need) {
      this.#emit({ type: "approval", approvalId });
      this.#emit({ type: "overview" });
      throw new WalletError("NOT_ENOUGH_MONEY", payer === "main"
        ? "There is not enough in your balance. Add money and approve this quote again."
        : "The agent's balance is too low. Fund it and approve this quote again.");
    }
    this.#store.update((draft) => {
      draft.approvals[approvalId]!.status = "approved";
      const entry = draft.jobs[jobId];
      if (entry !== undefined && entry.phase === "needs_approval") {
        entry.phase = "cleared";
        entry.ownerApproved = true;
        entry.payer = payer;
        entry.updatedAt = this.#now();
      }
    });
    this.#emit({ type: "approval", approvalId });
    this.#emit({ type: "overview" });
    await this.#advance(jobId, true);
    this.#emit({ type: "job", jobId });
    return this.#jobView(this.#jobRecord(jobId), true);
  }

  async #checkJobQuote(job: JobRecord, deposits: JobDeposits) {
    const quote = job.approvedCosts;
    if (job.terms && await this.#chain.clusterTime() >= job.terms.deadline) {
      throw new WalletError("NOT_AVAILABLE", "The delivery deadline has passed.");
    }
    if (!quote?.networkFees || job.maxPriceCents === undefined) {
      throw new WalletError("NOT_AVAILABLE", "Refresh the quote to get the current costs.");
    }
    if (quote.expiresAt <= this.#now()) throw new WalletError("NOT_AVAILABLE", "This quote has expired.");
    const rate = await this.#freshRate(true);
    checkPriceLimit(BigInt(job.priceLamports), job.maxPriceCents, rate);
    const { protocolFeeBps } = await readProtocolConfig(this.#chain);
    if (quote.networkFees !== deposits.networkFees.toString() || quote.cancellationRent !== deposits.cancellationRent.toString() || quote.protocolFeeBps !== protocolFeeBps || quote.total !== deposits.total.toString() || quote.kept !== deposits.kept.toString()) {
      throw new WalletError("PRICE_CHANGED", "The deposit or fees changed. Request a new quote.");
    }
    return rate!;
  }

  /** Last check under the payer lock, before the write-ahead send marker. */
  async #authorizeCreation(job: JobRecord, deposits: JobDeposits): Promise<boolean> {
    const rate = await this.#checkJobQuote(job, deposits);
    if (job.terms?.contest) {
      const saved = this.#store.state.approvals[job.approvalId!];
      if (!saved?.quoteRate || rate > saved.quoteRate) throw new WalletError("PRICE_CHANGED", "The dollar total changed. Request a new contest quote.");
    }
    if (job.payer === "main") {
      if (!job.ownerApproved) throw new WalletError("NOT_ALLOWED", "Approve this quote before funding it.");
      return true;
    }
    const charge = microcents(BigInt(job.priceLamports) + jobCosts(deposits).extra, rate);
    const approved = this.#store.update(draft => {
      const agent = draft.agents[job.agentId]!;
      if (job.terms?.contest) {
        if (charge > remainingJobMicrocents(agent, this.#now(), job.id) + BigInt(job.contestOverage ?? "0")) {
          throw new WalletError("PRICE_CHANGED", "The remaining daily allowance changed. Request a new contest quote.");
        }
        draft.jobs[job.id]!.contestCreditMicrocents = microcents(2n * this.#chain.transferFeeLamports + deposits.cancellationRent, rate).toString();
      }
      if (reserveJobSpend(agent, job.id, charge, microcents(BigInt(job.priceLamports), rate), this.#now(), job.ownerApproved === true)) return true;
      agent.jobSpends = agent.jobSpends?.filter(entry => entry.id !== job.id) ?? [];
      draft.jobs[job.id]!.phase = "needs_approval";
      const approval = job.approvalId && draft.approvals[job.approvalId];
      if (!approval) throw new WalletError("NOT_ALLOWED", "Request a new quote.");
      approval.status = "pending";
      return false;
    });
    if (!approved) this.#emit({ type: "overview" });
    return approved;
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

  async #payerSigner(job: JobRecord, decisionExpiry?: number): Promise<KeyPairSigner> {
    const signer = await this.#vault.signer(job.payer === "main" ? MAIN_KEY : this.#agentRecord(job.agentId).keyId);
    if (decisionExpiry !== undefined) return contestSigner(signer, decisionExpiry, this.#now);
    return job.terms?.contest && ["cleared", "hiring", "hired"].includes(job.phase)
      ? contestSigner(signer, job.approvedCosts?.expiresAt ?? 0, this.#now) : signer;
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
    this.#patchJob(jobId, (job, draft) => {
      const agent = draft.agents[job.agentId];
      if (agent?.jobSpends && job.hireAttemptAt === null) agent.jobSpends = agent.jobSpends.filter(entry => entry.id !== jobId);
      job.phase = "failed";
      job.error = message;
    });
    this.#emit({ type: "overview" });
  }

  /** Move one job as far as it can go right now. Safe to call at any time. */
  #advance(jobId: string, fundContest = false): Promise<void> {
    return this.#lock(`job:${jobId}`, async () => {
      for (let step = 0; step < 6; step += 1) {
        const before = this.#store.state.jobs[jobId];
        if (before === undefined || before.role !== "buying") return;
        try {
          if (before.terms?.contest && (before.phase === "done" || (!fundContest && before.phase === "hired"))) {
            await this.#refreshContest(before);
            return;
          }
          if (before.terms?.contest && !fundContest && ["cleared", "hiring"].includes(before.phase)) {
            if (before.phase === "hiring" && before.hireAttemptAt !== null) await this.#stepSendRequest(before, true);
            return;
          }
          if (before.phase === "cleared" || before.phase === "hiring" || before.phase === "hired") {
            const advanceFunding = () => before.phase === "cleared" ? this.#stepClear(before)
              : before.phase === "hiring" ? this.#stepHire(before) : this.#stepPost(before);
            if (before.terms?.contest) {
              const expiry = before.approvedCosts?.expiresAt ?? 0;
              const signal = AbortSignal.timeout(Math.max(1, expiry - this.#now()));
              await inTransportScope({ signal, sending: () => beforeContestExpiry(expiry, this.#now), confirmed() {} }, advanceFunding);
            } else await advanceFunding();
          }
          else if (before.phase === "active") await this.#stepTrack(before);
          else if (before.phase === "done") await this.#stepTidy(before);
          else return;
        } catch (error) {
          if (before.phase === "cleared" && error instanceof WalletError && error.code !== "NETWORK") this.#failJob(jobId, error.message);
          this.#log(`job ${jobId} ${before.phase}: ${describeError(error)}`);
          return;
        }
        const after = this.#store.state.jobs[jobId];
        if (after === undefined || after.phase === before.phase) return;
      }
    });
  }

  async #checkBeforePublish(job: JobRecord) {
    if (!job.approvedCosts?.networkFees || job.approvedCosts.expiresAt <= this.#now() ||
        !job.terms || job.terms.deadline <= await this.#chain.clusterTime()) {
      throw new WalletError("NOT_AVAILABLE", "This quote has expired. Request a new quote.");
    }
  }

  /** cleared -> hiring: fix the payer and the task address, re-check terms. */
  async #stepClear(job: JobRecord): Promise<void> {
    await this.#checkBeforePublish(job);
    if (isRequest(job)) {
      await this.#stepClearRequest(job);
      return;
    }
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
    if (terms.deliverySecs === null || terms.deliverySecs !== job.terms?.listingDurationSecs) {
      throw new WalletError("PRICE_CHANGED", "The service delivery period changed. Request a new quote.");
    }
    await this.#ensureListingGate(terms);
    await this.#checkBeforePublish(job);
    // The request is published now: after the person's OK, before any money
    // moves. The hire commits to the hash of exactly what was published.
    let published: PublishedJob;
    try {
      published = await this.#services.publishJobSpec({
        title: job.title,
        request: job.request,
        acceptance: job.acceptance,
        ...(job.terms && { terms: job.terms }),
        listing: job.listing as Address,
        signer: payer,
      });
    } catch (error) {
      if (error instanceof WalletError && error.code !== "NETWORK") {
        this.#failJob(job.id, `${error.message} Nothing was spent.`);
        return;
      }
      throw error;
    }
    const task = await taskAddressFor(payer.address, values.hexToBytes(job.taskIdHex));
    this.#patchJob(job.id, (entry) => {
      entry.jobSpec = published.spec;
      entry.jobSpecHashHex = published.hashHex;
      entry.jobSpecUri = published.uri;
      entry.task = task;
      entry.phase = "hiring";
    });
  }

  /**
   * cleared -> hiring, for a request: publish it (after the person's OK,
   * before any money moves), then fix the task address and the time by which
   * it must be delivered.
   */
  async #stepClearRequest(job: JobRecord): Promise<void> {
    const payer = await this.#payerSigner(job);
    await this.#checkBeforePublish(job);
    let published: PublishedJob;
    try {
      published = await this.#services.publishJobSpec({
        title: job.title,
        request: job.request,
        acceptance: job.acceptance,
        ...(job.terms && { terms: job.terms }),
        listing: null,
        signer: payer,
      });
    } catch (error) {
      if (error instanceof WalletError && error.code !== "NETWORK") {
        this.#failJob(job.id, `${error.message} Nothing was spent.`);
        return;
      }
      throw error;
    }
    const task = await taskAddressFor(payer.address, values.hexToBytes(job.taskIdHex));
    const deadline =
      job.requestDeadline ?? (await this.#chain.clusterTime()) + (job.deliverWithinSecs ?? DEFAULT_REQUEST_DAYS * DAY_SECS);
    this.#patchJob(job.id, (entry) => {
      entry.jobSpec = published.spec;
      entry.jobSpecHashHex = published.hashHex;
      entry.jobSpecUri = published.uri;
      entry.task = task;
      entry.requestDeadline = deadline;
      entry.phase = "hiring";
    });
  }

  #markHired(jobId: string, signature?: string): void {
    const job = this.#store.state.jobs[jobId];
    this.#patchJob(jobId, (entry) => {
      entry.phase = "hired";
      entry.hiredAt = this.#now();
      if (signature !== undefined) entry.signatures.hire = signature;
    });
    // The main balance's first job makes its one-time record: quote again,
    // showing the last quote until then.
    if (job?.payer === "main" && this.#postCostCache !== null) {
      this.#postCostCache = { ...this.#postCostCache, at: 0 };
    }
    this.#dropBalances();
    this.#emit({ type: "overview" });
  }

  /**
   * A creation that may already have been sent: the chain says whether it
   * landed. True when that was the case to settle, so nothing is sent again.
   */
  async #reconcileCreation(
    job: JobRecord,
    landed: () => Promise<boolean>,
    what: "order" | "request",
  ): Promise<boolean> {
    if (job.hireAttemptAt === null) return false;
    if (await landed()) this.#markHired(job.id);
    else if (this.#now() - job.hireAttemptAt > HIRE_RECONCILE_GRACE_MS) {
      this.#failJob(
        job.id,
        what === "order"
          ? "The order did not reach the marketplace. Nothing was spent."
          : "The request did not reach the marketplace. Nothing was spent.",
      );
    }
    return true;
  }

  /**
   * Send the transaction that creates the job's task, once, and let the
   * chain say what happened. The caller holds the payer's lock and has
   * checked the money.
   */
  async #sendCreation(
    job: JobRecord,
    what: "order" | "request",
    landed: () => Promise<boolean>,
    send: () => Promise<string>,
  ): Promise<void> {
    // Written before the send: after a crash the chain decides the outcome.
    this.#patchJob(job.id, (entry) => {
      entry.hireAttemptAt = this.#now();
    });
    try {
      this.#markHired(job.id, await send());
    } catch (error) {
      this.#log(`job ${job.id} ${what}: ${describeError(error)}`);
      if (await landed().catch(() => false)) {
        this.#markHired(job.id);
      } else if (sendDefinitelyFailed(error)) {
        if (isNetworkTrouble(error) && (job.hireRetries ?? 0) < HIRE_BUSY_RETRIES) {
          // The network turned it away before taking it. Nothing moved, and
          // the task address admits one task only, so the next pass simply
          // sends it again.
          this.#patchJob(job.id, (entry) => {
            entry.hireAttemptAt = null;
            entry.hireRetries = (entry.hireRetries ?? 0) + 1;
          });
        } else {
          this.#failJob(job.id, hireFailureText(error, what).message);
        }
      }
      // Otherwise the outcome is unknown: the next pass reconciles it.
    }
  }

  /** hiring -> hired, for a request: create its task with the reward in escrow. */
  async #stepSendRequest(job: JobRecord, readOnly = false): Promise<void> {
    const authority = job.payer === "main" ? this.mainAddress : this.#agentRecord(job.agentId).address as Address;
    const task = job.task as Address;
    const intent: RequestIntent = {
      ...(job.terms?.contest && { maxEntries: job.terms.contest.maxEntries }),
      taskId: values.hexToBytes(job.taskIdHex),
      jobSpecHash: values.hexToBytes(job.jobSpecHashHex),
      minReputation: job.terms?.eligibility?.minReputation ?? 0,
      requiredCapabilities: BigInt(job.terms?.eligibility?.requiredCapabilities ?? "1"),
      rewardLamports: BigInt(job.priceLamports),
      deadline: BigInt(job.requestDeadline ?? 0),
      reviewWindowSecs: BigInt(job.terms?.reviewWindowSecs ?? this.#config.reviewWindowSecs ?? DEFAULT_REVIEW_WINDOW_SECS),
    };
    const landed = (): Promise<boolean> => requestLanded(this.#chain, authority, task, intent);
    if (await this.#reconcileCreation(job, landed, "request") || readOnly) return;
    const payer = await this.#payerSigner(job);
    await this.#lock(this.#payerLock(job), async () => {
      let deposits;
      try {
        deposits = await this.#jobDeposits(job, payer.address);
      } catch (error) {
        if (!(error instanceof WalletError) || error.code === "NETWORK") throw error;
        this.#failJob(job.id, error.message);
        return;
      }
      const floor = await this.#floor();
      const balance = await this.#chain.getBalance(payer.address);
      if (balance < intent.rewardLamports + deposits.total + floor) {
        this.#failJob(job.id, "There was not enough money to post the request. Nothing was spent.");
        return;
      }
      try {
        if (!await this.#authorizeCreation(job, deposits)) return;
      } catch (error) {
        if (!(error instanceof WalletError) || error.code === "NETWORK") throw error;
        this.#failJob(job.id, error.message);
        return;
      }
      if (job.payer === "agent" && job.contestRegistration && job.contestRegistration.rent !== "0") {
        const id = this.#earn.contestRegistrationId(job.agentId, job.contestRegistration.agentId, true);
        if (id !== job.contestRegistration.agentId) {
          this.#failJob(job.id, "The agent registration changed. Get a new contest quote.");
          return;
        }
      }
      const chainExpiry = job.contestRegistration ? await this.#chain.clusterTime() + Math.floor((job.approvedCosts!.expiresAt - this.#now()) / 1000) : 0;
      await this.#sendCreation(job, "request", landed, () => job.contestRegistration
        ? sendContest(this.#chain, payer, intent, job.contestRegistration, chainExpiry) : sendRequest(this.#chain, payer, intent));
    });
  }

  /** hiring -> hired: send the hire once, then let the chain say what happened. */
  async #stepHire(job: JobRecord): Promise<void> {
    if (isRequest(job)) {
      await this.#stepSendRequest(job);
      return;
    }
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
      reviewWindowSecs: BigInt(job.terms?.reviewWindowSecs ?? this.#config.reviewWindowSecs ?? DEFAULT_REVIEW_WINDOW_SECS),
    };
    const landed = (): Promise<boolean> => hireLanded(this.#chain, payer.address, task, intent);
    if (await this.#reconcileCreation(job, landed, "order")) return;

    await this.#lock(this.#payerLock(job), async () => {
      const terms = {
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
      try {
        if (!await this.#authorizeCreation(job, deposits)) return;
      } catch (error) {
        if (!(error instanceof WalletError) || error.code === "NETWORK") throw error;
        this.#failJob(job.id, error.message);
        return;
      }
      await this.#sendCreation(job, "order", landed, () => sendHire(this.#chain, payer, intent, gate));
    });
  }

  /** hired -> active: get the job spec attested and published, then pin it. */
  async #stepPost(job: JobRecord): Promise<void> {
    const payer = await this.#payerSigner(job);
    const task = job.task as Address;
    const hash = values.hexToBytes(job.jobSpecHashHex);
    const request = isRequest(job);
    const activate = async (signature?: string): Promise<void> => {
      const agent = this.#store.state.agents[job.agentId];
      // Hires can wait behind another listing's work. Use the agreed chain
      // deadline, never the old unconditional ten-minute timer.
      const seen = await inspectJob(this.#chain, task, this.#provider(job));
      const clock = await this.#chain.clusterTime();
      const deadline = seen?.deadline ?? job.requestDeadline ?? 0;
      const timeoutAt = !request && this.#config.autoRefundAfterMs !== undefined
        ? this.#now() + this.#config.autoRefundAfterMs
        : null;
      const chainRefundAt = deadline > 0 ? this.#now() + Math.max(0, deadline - clock) * 1000 : null;
      const refundAt = timeoutAt === null ? chainRefundAt
        : chainRefundAt === null ? timeoutAt : Math.min(timeoutAt, chainRefundAt);
      this.#patchJob(job.id, (entry, draft) => {
        entry.phase = "active";
        entry.chainStatus = "open";
        entry.autoRefundAt = refundAt;
        if (timeoutAt !== null) entry.autoRefundTimeoutAt = timeoutAt;
        if (signature !== undefined) entry.signatures.activate = signature;
        this.#note(draft, {
          kind: "hired",
          text: request
            ? `${agent?.name ?? "You"} posted a request: ${entry.title}.`
            : `${agent?.name ?? "An agent"} hired ${entry.title}.`,
          lamports: BigInt(entry.priceLamports),
          agentId: agent === undefined ? null : entry.agentId,
          jobId: entry.id,
          signature: entry.signatures.hire ?? null,
        });
      });
      this.#emit({ type: "activity" });
      this.#emit({ type: "overview" });
    };
    const notPosted = request
      ? "The request could not be posted, so it was cancelled and the reward came back."
      : "The job could not be posted, so it was cancelled and the price returned.";

    if (await isActivated(this.#chain, task)) {
      await activate();
      return;
    }

    let gate = await findTaskGate(this.#chain, this.#services, {
      task,
      creator: payer.address,
      jobSpecHash: hash,
    });
    let jobSpecUri = job.jobSpecUri;
    if (jobSpecUri === null) {
      // A job hired before requests were published first. Publishing it now
      // only helps if that gives the very request the hire committed to.
      const published = await this.#services.publishJobSpec({
        title: job.title,
        request: job.request,
        acceptance: job.acceptance,
        ...(job.terms && { terms: job.terms }),
        listing: request ? null : (job.listing as Address),
        signer: payer,
      });
      if (published.hashHex !== job.jobSpecHashHex) {
        await this.#cancelUnposted(job, notPosted);
        return;
      }
      const found = published.uri;
      jobSpecUri = found;
      this.#patchJob(job.id, (entry) => {
        entry.jobSpecUri = found;
      });
    }
    if (gate === null) {
      // A payment for the check that was already sent may still be landing.
      const sentAt = job.approvalAttemptAt ?? null;
      if (sentAt !== null && this.#now() - sentAt < APPROVAL_SETTLE_MS) return;
      try {
        const payment = await this.#services.attestTask({
          task,
          jobSpecHashHex: job.jobSpecHashHex,
          jobSpec: job.jobSpec,
          jobSpecUri,
          payer: payer.address,
        });
        if (payment !== null) {
          // The buyer pays for the check of its own request.
          const signature = await this.#payApproval(
            payer,
            payment,
            { kind: "task", task, hash },
            () => {
              this.#patchJob(job.id, (entry) => {
                entry.approvalAttemptAt = this.#now();
              });
            },
          );
          this.#patchJob(job.id, (entry) => {
            entry.signatures.approval = signature;
          });
        }
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
                  request
                    ? "so the request was cancelled and the reward came back."
                    : "so the job was cancelled and the price returned.",
                )
              : notPosted,
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
    let signature: string;
    try {
      signature = await sendActivation(this.#chain, payer, { task, jobSpecHash: hash, jobSpecUri }, gate);
    } catch (error) {
      this.#log(`job ${job.id} activate: ${describeError(error)}`);
      if (await isActivated(this.#chain, task)) await activate();
      return;
    }
    await activate(signature);
  }

  /** The job's provider, or null for a request nobody is known to have taken. */
  #provider(job: JobRecord): Address | null {
    return job.providerAgent === "" ? null : (job.providerAgent as Address);
  }

  /** Cancel a hired job that never got posted, and record the refund. */
  async #cancelUnposted(job: JobRecord, message: string): Promise<void> {
    if (job.terms?.contest) {
      this.#patchJob(job.id, record => { record.error = "Publication stopped. Review a cancellation quote to recover the prize."; });
      return;
    }
    const payer = await this.#payerSigner(job);
    const signature = await sendCancel(
      this.#chain,
      payer,
      job.task as Address,
      this.#provider(job),
      await this.#amountWords(),
    );
    this.#recordRefund(job.id, signature, message);
  }

  /**
   * Whether the job's refund cannot be paid yet: the paying wallet's first
   * cancel starts its marketplace record, and the wallet lacks that. The job
   * then says how much to add, and the refund is tried again on later looks.
   */
  async #refundBlocked(job: JobRecord, payer: Address): Promise<boolean> {
    const quote = job.approvedCosts;
    const approvedRent = quote?.cancellationRent;
    if (quote?.networkFees && approvedRent && (await creatorRecordCost(this.#chain, payer) > BigInt(approvedRent) ||
        jobNetworkFees(this.#chain.transferFeeLamports) > BigInt(quote.networkFees))) {
      const message = "Refund costs changed. Review the new cost before cancelling.";
      if (job.error !== message) this.#patchJob(job.id, entry => { entry.error = message; });
      return true;
    }
    const missing = await cancelShortfall(this.#chain, payer);
    const blocked = missing > 0n ? missing.toString() : undefined;
    if (blocked !== job.refundBlockedLamports) {
      this.#patchJob(job.id, (entry) => {
        if (blocked === undefined) delete entry.refundBlockedLamports;
        else entry.refundBlockedLamports = blocked;
      });
    }
    return blocked !== undefined;
  }

  #recordRefund(jobId: string, signature: string | null, message: string | null): void {
    const refunded = this.#store.state.jobs[jobId];
    if (refunded !== undefined) this.#forgetRecordCost(refunded);
    this.#patchJob(jobId, (entry, draft) => {
      entry.phase = "done";
      entry.chainStatus = "cancelled";
      entry.outcome = "refunded";
      entry.autoRefundAt = null;
      entry.error = message;
      delete entry.refundBlockedLamports;
      if (signature !== null) entry.signatures.cancel = signature;
      this.#note(draft, {
        kind: "refunded",
        text: isRequest(entry)
          ? `${entry.title} was cancelled and the reward came back.`
          : `${entry.title} was cancelled and the price came back.`,
        lamports: BigInt(entry.priceLamports),
        agentId: entry.agentId === "" ? null : entry.agentId,
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
      } else if (entry.agentId === "") {
        // A request the person posted from the main balance.
        draft.mainSpentLamports = (BigInt(draft.mainSpentLamports ?? "0") + BigInt(entry.priceLamports)).toString();
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
    const request = isRequest(job);
    let provider = this.#provider(job);
    // Whether the provider has its record yet: per provider, so it is read
    // again when a request changes hands.
    let knownRecorded = job.providerRecorded;
    let seen = await inspectJob(this.#chain, task, provider);
    if (seen === null) return;

    if (job.terms?.contest) {
      await this.#trackContest(job, seen);
      return;
    }
    if (request) {
      // Nobody is named for a request: who took it is read from the chain.
      if (provider !== null && seen.status === "open" && seen.workers === 0) {
        // Whoever took it let it go, and anyone may take it again.
        provider = null;
        knownRecorded = undefined;
        this.#patchJob(job.id, (entry) => {
          entry.providerAgent = "";
          delete entry.providerRecorded;
        });
      } else if (
        seen.workers > 0 &&
        (provider === null || (seen.submission === null && !(await this.#holdsClaim(task, provider))))
      ) {
        const worker = await requestWorker(this.#chain, task);
        if (worker !== null && worker !== provider) {
          provider = worker;
          knownRecorded = undefined;
          this.#patchJob(job.id, (entry) => {
            entry.providerAgent = worker;
            delete entry.providerRecorded;
          });
          seen = (await inspectJob(this.#chain, task, provider)) ?? seen;
        }
      }
    }

    // Keep the commitment before settlement or cleanup can remove its account.
    if (seen.submission !== null) {
      const pointer = {
        hash: seen.submission.proofHashHex,
        dataBase64: Buffer.from(seen.submission.resultData).toString("base64"),
      };
      if (job.deliveryPointer?.hash !== pointer.hash || job.deliveryPointer?.dataBase64 !== pointer.dataBase64) {
        this.#patchJob(job.id, (entry) => { entry.deliveryPointer = pointer; entry.result = null; });
      }
      if (seen.status === "completed" && seen.submission.status === SubmissionStatus.Accepted) {
        this.#patchJob(job.id, (entry) => { entry.finalDeliveryChecked = true; });
      }
    }
    await this.#refreshDelivery(this.#jobRecord(job.id));

    if (seen.status === "completed") {
      if (!this.#jobRecord(job.id).finalDeliveryChecked) {
        // An earlier verified revision is not evidence of what was paid for.
        this.#patchJob(job.id, (entry) => { entry.result = null; delete entry.deliveryPointer; });
      }
      await this.#recoverPaidDelivery(this.#jobRecord(job.id));
      this.#recordPaid(job.id, null);
      return;
    }
    if (seen.status === "cancelled") {
      this.#recordRefund(job.id, null, null);
      return;
    }

    let autoRefundAt: number | null = null;
    const configuredAt = request ? null : job.autoRefundTimeoutAt ?? (this.#config.autoRefundAfterMs === undefined
      ? null : (job.hiredAt ?? job.createdAt) + this.#config.autoRefundAfterMs);
    if (seen.status === "open") {
      const clock = await this.#chain.clusterTime();
      const chainRefundAt = seen.deadline > 0 ? this.#now() + (seen.deadline - clock) * 1000 : null;
      autoRefundAt = chainRefundAt === null ? configuredAt
        : configuredAt === null ? chainRefundAt : Math.min(chainRefundAt, configuredAt);
      // Migrate before any early return (including a refund blocked by funding).
      if (job.autoRefundAt !== autoRefundAt || (configuredAt !== null && job.autoRefundTimeoutAt !== configuredAt)) {
        this.#patchJob(job.id, (entry) => {
          entry.autoRefundAt = autoRefundAt;
          if (configuredAt !== null) entry.autoRefundTimeoutAt = configuredAt;
        });
      }
    }
    if (seen.status === "open" && seen.workers === 0) {
      // Also applies to records made by older wallets with a ten-minute
      // autoRefundAt. A queued hire keeps its agreed start window on upgrade.
      const deadlineDue = seen.deadline > 0 && (await this.#chain.clusterTime()) >= seen.deadline;
      const due = deadlineDue || (configuredAt !== null && this.#now() >= configuredAt);
      if (due) {
        const payer = await this.#payerSigner(job);
        if (await this.#refundBlocked(job, payer.address)) return;
        const signature = await sendCancel(this.#chain, payer, task, null);
        this.#recordRefund(
          job.id,
          signature,
          request
            ? "Nobody took this request in time, so it was cancelled and the reward came back."
            : "Nobody started this job in time, so it was cancelled and the price returned.",
        );
        return;
      }
    }

    if (seen.status === "in_progress" && seen.deadline > 0 && seen.completions === 0 && provider !== null) {
      const clock = await this.#chain.clusterTime();
      const waitingOnBuyer = seen.submission !== null && seen.submission.status === 1;
      if (!waitingOnBuyer && clock > seen.deadline + NO_SHOW_GRACE_SECS) {
        const payer = await this.#payerSigner(job);
        if (await this.#refundBlocked(job, payer.address)) return;
        const signature = await sendCancel(this.#chain, payer, task, provider);
        this.#recordRefund(
          job.id,
          signature,
          request
            ? "Whoever took this request did not deliver in time, so it was cancelled and the reward came back."
            : "The provider did not deliver in time, so the job was cancelled and the price returned.",
        );
        return;
      }
    }

    if (seen.status === "reject_frozen" && seen.turnDown !== null && provider !== null) {
      // Turned down and on hold. Once its time is over, either side may
      // settle it, and so that no job is left hanging this wallet does. One
      // attempt at a time. A revision 9 turn-down then refunds the buyer
      // (nobody disputed it, or nobody ruled on the dispute); one made before
      // revision 9 pays the provider. What the chain said decides how it is
      // recorded: a refund is never recorded as a payment.
      const recently =
        job.settleAttemptAt != null && this.#now() - job.settleAttemptAt < FROZEN_SETTLE_RETRY_MS;
      if (seen.turnDown.expiryDue !== null && !recently) {
        this.#patchJob(job.id, (entry) => {
          entry.settleAttemptAt = this.#now();
        });
        try {
          const payer = await this.#payerSigner(job);
          const settled = await sendFrozenExpiry(this.#chain, payer, task, provider);
          this.#patchJob(job.id, (entry) => {
            entry.signatures.settle = settled.signature;
          });
          if (settled.paidProvider) {
            this.#recordPaid(job.id, settled.signature);
          } else {
            const disputed = seen.turnDown.rulingUntil !== null;
            this.#recordRefund(
              job.id,
              settled.signature,
              request
                ? disputed
                  ? "Your turn-down was disputed and nobody ruled in time, so the reward came back."
                  : "Nobody disputed your turn-down in time, so the reward came back."
                : disputed
                  ? "The provider disputed your turn-down and nobody ruled in time, so the price came back."
                  : "The provider did not dispute your turn-down in time, so the price came back.",
            );
          }
          return;
        } catch (error) {
          // The provider's own wallet may have settled it first; the next
          // look shows the job completed or cancelled either way.
          this.#log(`job ${job.id} settle after review: ${describeError(error)}`);
        }
      }
    }

    const result = this.#jobRecord(job.id).result;
    let providerRecorded = knownRecorded;
    if (seen.status === "pending_validation" && seen.submission !== null) {
      // Whether turning this down would go on the provider's record. Read
      // until it has one: anyone may start it at any time, and nobody can
      // remove it.
      if (providerRecorded !== true && provider !== null) {
        providerRecorded =
          (await providerHasRecord(this.#chain, provider).catch(() => undefined)) ?? providerRecorded;
      }
    }
    // On hold after a turn-down, the clock that matters is the one running:
    // the provider's time to dispute, then the reviewers' time to rule.
    const reviewDeadlineAt =
      seen.status === "reject_frozen" && seen.turnDown !== null
        ? (seen.turnDown.rulingUntil ?? seen.turnDown.disputeUntil)
        : (seen.status === "pending_validation" || seen.status === "reject_frozen") &&
            seen.submission !== null
          ? seen.submission.reviewDeadlineAt
          : null;
    const turnDown = turnDownRecord(seen.turnDown);
    const changed =
      job.chainStatus !== seen.status ||
      (seen.tokenReward !== undefined && Boolean(job.tokenReward) !== seen.tokenReward) ||
      job.deadline !== seen.deadline ||
      job.autoRefundAt !== autoRefundAt ||
      job.reviewDeadlineAt !== reviewDeadlineAt ||
      job.result !== result ||
      knownRecorded !== providerRecorded ||
      !sameTurnDown(job.turnDown, turnDown);
    if (!changed) return;
    this.#patchJob(job.id, (entry) => {
      entry.chainStatus = seen.status;
      if (seen.tokenReward !== undefined) entry.tokenReward = seen.tokenReward;
      entry.deadline = seen.deadline;
      entry.reviewDeadlineAt = reviewDeadlineAt;
      entry.result = result;
      if (turnDown === undefined) delete entry.turnDown;
      else entry.turnDown = turnDown;
      if (providerRecorded !== undefined) entry.providerRecorded = providerRecorded;
      if (seen.status === "pending_validation") entry.changesRequested = false;
      entry.autoRefundAt = autoRefundAt;
    });
  }

  async #refreshContest(job: JobRecord) {
    if (!job.task) return;
    await this.#trackContest(job, await inspectJob(this.#chain, job.task as Address, null));
  }

  async #trackContest(job: JobRecord, seen: Awaited<ReturnType<typeof inspectJob>>) {
    const task = job.task as Address;
    if (job.contestPending) {
      await this.#reconcileContest(job);
      job = this.#jobRecord(job.id);
    }

    // Keep live entries usable during an RPC history outage. A terminal task
    // stays retryable until its historical submissions have been recovered.
    const historyPage = await this.#chain.contestHistory?.(task, job.contestCursor ?? null, job.contestCheckpoint).catch(error => {
      this.#log(`contest history: ${describeError(error)}`);
      return null;
    });
    const [live, clock, claims] = await Promise.all([liveContestEntries(this.#chain, task, historyPage?.checkpoint?.slot), this.#chain.clusterTime(), contestClaims(this.#chain, task)]);
    const previous = job.contestEntries ?? [];
    const archived = await archiveContestEntries(this.#chain, previous, historyPage?.events ?? []);
    const entries = await Promise.all(live.map(async ({ entry: snapshot, data }) => {
      const entry = identifyEntry(snapshot, archived);
      if (entry.text !== null || entry.uri !== null || entry.files?.length) return entry;
      const result = await this.#loadResult(entry.hash, data);
      return { ...entry, text: result?.text ?? null, uri: result?.uri ?? null, textTruncated: result?.textTruncated ?? false, files: result?.files ?? [] };
    }));
    const history = archived.filter(e => !entries.some(l => l.id === e.id)).map(entry =>
      entry.status === "submitted" ? { ...entry, status: "closed" as const } : entry);
    const all = [...history, ...entries];
    const releaseOpen = clock >= job.terms!.contest!.releaseAt;
    const status = seen?.status ?? job.chainStatus;
    const terminal = job.phase === "done" || status === "completed" || status === "cancelled";
    const outstanding = terminal ? claims.map(({ claim, workerAuthority }) => ({ claim, workerAuthority })) : [];
    const canCancel = !!seen && !terminal && !live.length && (status === "open" || (status === "in_progress" && clock > seen.deadline + NO_SHOW_GRACE_SECS));
    const address = job.payer === "main" ? this.mainAddress : this.#agentRecord(job.agentId).address as Address;
    const canClean = terminal && !claims.length && !!await prepareTidy(this.#chain, createNoopSigner(address), task, null);
    const scanned = terminal && !!historyPage && !historyPage.checkpoint?.before && !historyPage.checkpoint?.rows.some(row => !row.events);
    if (job.contestScanned !== scanned || JSON.stringify(historyPage?.checkpoint) !== JSON.stringify(job.contestCheckpoint) || (historyPage?.cursor && job.contestCursor !== historyPage.cursor) || JSON.stringify(previous) !== JSON.stringify(all) ||
        job.contestReleaseOpen !== releaseOpen || job.chainStatus !== status || job.contestCleanup !== canClean ||
        job.contestCancel !== canCancel || JSON.stringify(job.contestClaims) !== JSON.stringify(outstanding)) {
      this.#patchJob(job.id, record => {
        if (historyPage?.checkpoint) record.contestCheckpoint = historyPage.checkpoint;
        if (historyPage?.cursor) record.contestCursor = historyPage.cursor;
        record.contestEntries = all;
        record.contestScanned = scanned;
        record.contestReleaseOpen = releaseOpen;
        record.contestCancel = canCancel;
        record.contestClaims = outstanding;
        record.contestCleanup = canClean;
        if (terminal) record.tidied = !claims.length && !canClean;
        record.chainStatus = status;
        if (seen?.deadline) record.deadline = seen.deadline;
      });
    }
    if (job.phase !== "done" && status === "completed") this.#recordPaid(job.id, null);
    if (job.phase !== "done" && status === "cancelled") this.#recordRefund(job.id, null, null);
  }

  #confirmContest(job: JobRecord, signature: string) {
    const quote = job.contestQuote!;
    this.#patchJob(job.id, record => {
      const entry = record.contestEntries?.find(e => e.id === quote.entryId);
      if (entry) entry.status = quote.action === "release" ? "released" : quote.action === "reject" ? "rejected" : "winner";
      if (entry && quote.action === "reject") entry.reason = quote.reason;
      (record.contestReceipts ??= []).push(quote.id);
      (record.contestSettlements ??= []).push({ quoteId: quote.id, action: quote.action, entryId: quote.entryId, signature, transfers: quote.transfers ?? [], networkFee: quote.networkFee,
        recordCost: quote.recordCost, ...(quote.proof && { proof: quote.proof }), ...(quote.reason && { reason: quote.reason }) });
      if (quote.action === "cleanup") record.signatures.close = signature;
      delete record.contestPending;
      delete record.contestFailedExpense;
      delete record.contestQuote;
    });
    if (quote.action === "cancel") this.#recordRefund(job.id, signature, null);
    if (quote.action === "winner") this.#recordPaid(job.id, signature);
  }

  async #reconcileContest(job: JobRecord) {
    if (!job.contestPending) return;
    const outcome = await this.#chain.listingSendOutcome?.(job.contestPending);
    if (outcome === "landed") this.#confirmContest(job, job.contestPending.signature);
    else if (outcome === "failed") this.#patchJob(job.id, (record, draft) => {
      // An expired, unseen signature and a failed execution share this outcome.
      // Keep the quoted network fee conservatively. No records were created.
      if (record.contestFailedExpense) {
        const reserved = draft.agents[job.agentId]?.jobSpends?.find(r => r.id === record.contestQuote?.id);
        if (reserved) reserved.microcents = record.contestFailedExpense.charge;
        record.contestCreditMicrocents = record.contestFailedExpense.credit;
        delete record.contestFailedExpense;
      }
      delete record.contestPending;
      delete record.contestQuote;
    });
    else throw new WalletError("NETWORK", "Market is checking the previous contest decision.");
  }

  contestPage(jobId: string, after?: string, agentId?: string) {
    return contestPage(this.#ownedJob(jobId, agentId), after);
  }

  contestReceipts(jobId: string, after?: string, agentId?: string) {
    return contestReceipts(this.#ownedJob(jobId, agentId), after);
  }

  savedContestQuote(jobId: string, id: string, agentId?: string) {
    const quote = this.#ownedJob(jobId, agentId).contestQuote;
    if (quote?.id !== id) throw new WalletError("NOT_FOUND", "That contest quote is no longer available.");
    return { quote };
  }

  /** Either side of the wallet UI can draft. Only the owner RPC can confirm the exact quote. */
  async quoteContest(jobId: string, input: { entryId: string; action: ContestAction; reason?: string }, agentId?: string) {
    this.#ownedJob(jobId, agentId);
    await this.#advance(jobId);
    return this.#lock(`job:${jobId}`, async () => {
      const job = this.#ownedJob(jobId, agentId);
      if (job.contestPending) throw new WalletError("NETWORK", "Market is checking the previous contest decision.");
      if (!job.terms?.contest || !job.task || !["active", "done", "hired"].includes(job.phase)) return contestUnavailable("This contest is not open for review.");
      const payer = job.payer === "main" ? this.mainAddress : this.#agentRecord(job.agentId).address as Address;
      const [clock, rate] = await Promise.all([this.#chain.clusterTime(), this.#freshRate(true)]);
      const window = ["winner", "reject"].includes(input.action) ? (job.terms.contest.releaseAt - clock) * 1000 : Infinity;
      const ttl = Math.min(window, this.#config.approvalTtlMs ?? 30 * 60_000);
      const expiry = this.#now() + ttl;
      const { quote } = await contestPlan(this.#chain, job, createNoopSigner(payer), input, newId("contest"), expiry, clock + Math.ceil(ttl / 1000), rate);
      quote.overageMicrocents = this.#contestOverage(job, quote).toString();
      quote.allowanceExceeded = quote.overageMicrocents !== "0";
      beforeContestExpiry(expiry, this.#now);
      this.#patchJob(jobId, entry => { entry.contestQuote = quote; });
      return this.#jobView(this.#jobRecord(jobId), agentId === undefined);
    });
  }

  #contestExpense(job: JobRecord, quote: ContestQuote, feeOnly = false) {
    // Funding already reserved two settlement/cleanup fees and the first cancellation record.
    const reservation = this.#agentRecord(job.agentId).jobSpends?.find(row => row.id === job.id && row.at > this.#now() - 86_400_000);
    const credit = reservation ? BigInt(job.contestCreditMicrocents ?? 0) : 0n;
    const expense = microcents(BigInt(quote.networkFee.lamports) + (feeOnly ? 0n : BigInt(quote.recordCost.lamports)), quote.rate!);
    return { charge: expense > credit ? expense - credit : 0n, credit: expense < credit ? credit - expense : 0n };
  }

  #contestOverage(job: JobRecord, quote: ContestQuote) {
    if (job.payer !== "agent") return 0n;
    const extra = this.#contestExpense(job, quote).charge - remainingJobMicrocents(this.#agentRecord(job.agentId), this.#now());
    return extra > 0n ? extra : 0n;
  }

  async decideContest(jobId: string, quoteId: string, approve: boolean) {
    await this.#lock(`job:${jobId}`, async () => {
      await this.#reconcileContest(this.#ownedJob(jobId, undefined));
      const job = this.#jobRecord(jobId);
      if (job.contestReceipts?.includes(quoteId)) return;
      const q = job.contestQuote;
      if (!q || q.id !== quoteId || !job.task || !job.terms?.contest) return contestUnavailable("Refresh the contest quote.");
      if (!approve) {
        this.#patchJob(jobId, e => { delete e.contestQuote; });
        return;
      }
      await this.#lock(this.#payerLock(job), async () => {
        beforeContestExpiry(q.expiresAt, this.#now);
        if (!q.chainExpiry || !q.stateHash || !q.rate) return contestUnavailable("Refresh the contest quote.");
        const signal = AbortSignal.timeout(Math.max(1, q.expiresAt - this.#now()));
        const signature = await inTransportScope({
          signal,
          sending: receipt => {
            beforeContestExpiry(q.expiresAt, this.#now);
            this.#patchJob(jobId, (record, draft) => {
              if (job.payer === "agent") {
                const expense = this.#contestExpense(job, q);
                if (this.#contestOverage(job, q) > BigInt(q.overageMicrocents ?? "0")) {
                  throw new WalletError("PRICE_CHANGED", "The remaining allowance changed. Review a new quote.");
                }
                reserveJobSpend(draft.agents[job.agentId]!, q.id, expense.charge, 0n, this.#now(), true);
                const failed = this.#contestExpense(job, q, true);
                record.contestFailedExpense = { credit: failed.credit.toString(), charge: failed.charge.toString() };
                record.contestCreditMicrocents = expense.credit.toString();
              }
              record.contestPending = receipt;
            });
          },
          confirmed: () => {},
        }, async () => {
          const payer = await this.#payerSigner(job, q.expiresAt);
          const rate = await abortableTransport(signal, () => this.#freshRate(true));
          const plan = await abortableTransport(signal, () => contestPlan(this.#chain, job, payer, q, q.id, q.expiresAt, q.chainExpiry!, rate));
          if (plan.quote.stateHash !== q.stateHash || rate === null || rate > q.rate! ||
              plan.quote.recipient !== q.recipient || plan.quote.treasury !== q.treasury || plan.quote.proof !== q.proof ||
              plan.quote.networkFee.lamports !== q.networkFee.lamports || plan.quote.recordCost.lamports !== q.recordCost.lamports ||
              JSON.stringify(plan.quote.transfers?.map(t => [t.label, t.recipient, t.amount.lamports])) !== JSON.stringify(q.transfers?.map(t => [t.label, t.recipient, t.amount.lamports])) ||
              (this.#contestOverage(job, q) > BigInt(q.overageMicrocents ?? "0"))) {
            throw new WalletError("PRICE_CHANGED", "The payout, allowance or fees changed. Review a new quote.");
          }
          const need = BigInt(q.networkFee.lamports) + BigInt(q.recordCost.lamports) + await this.#floor();
          if (await this.#chain.getBalance(payer.address) < need) throw new WalletError("NOT_ENOUGH_MONEY", "The paying balance cannot cover these fees.");
          beforeContestExpiry(q.expiresAt, this.#now);
          return (await this.#chain.clientFor(payer).send(plan.instructions)).signature;
        });
        this.#confirmContest(job, signature);
      });
    });
    await this.#advance(jobId);
    const job = this.#jobRecord(jobId);
    const receipt = job.contestSettlements?.find(row => row.quoteId === quoteId);
    return { ...await this.#jobView(job, true), ...(receipt && { contestReceipt: receipt }) };
  }

  /** Whether `provider` still holds its claim on the task. */
  async #holdsClaim(task: Address, provider: Address): Promise<boolean> {
    const [claim] = await findClaimPda({ task, bidder: provider });
    return (await this.#chain.readAccountInfo(claim)) !== null;
  }

  async #recoverPaidDelivery(job: JobRecord): Promise<void> {
    if (job.finalDeliveryChecked || job.task === null) return;
    const creator = job.payer === "main" ? this.mainAddress : this.#store.state.agents[job.agentId]?.address;
    if (creator === undefined || this.#chain.findSettledDelivery === undefined) return;
    try {
      const delivery = await this.#chain.findSettledDelivery(job.task as Address, creator as Address);
      if (delivery === null || (job.providerAgent && job.providerAgent !== delivery.worker)) return;
      this.#patchJob(job.id, (entry) => {
        entry.providerAgent = delivery.worker;
        const pointer = { hash: delivery.proofHashHex, dataBase64: Buffer.from(delivery.resultData).toString("base64") };
        if (entry.deliveryPointer?.hash !== pointer.hash || entry.deliveryPointer?.dataBase64 !== pointer.dataBase64) entry.result = null;
        entry.deliveryPointer = pointer;
        entry.finalDeliveryChecked = true;
      });
      await this.#refreshDelivery(this.#jobRecord(job.id));
    } catch (error) {
      this.#log(`paid delivery lookup: ${describeError(error)}`);
    }
  }

  async #refreshDelivery(job: JobRecord): Promise<void> {
    const pointer = job.deliveryPointer;
    if (pointer === undefined) return;
    if (job.result?.verified && job.result.hash === pointer.hash) return;
    const result = await this.#loadResult(pointer.hash, Buffer.from(pointer.dataBase64, "base64"));
    if (result !== null || job.result !== null) {
      this.#patchJob(job.id, (entry) => { entry.result = result; });
    }
  }

  async #loadResult(
    proofHashHex: string,
    resultData: Uint8Array,
    fullText = false,
  ): Promise<JobRecord["result"]> {
    try {
      const fetched = await this.#services.fetchResult({ proofHashHex, resultData });
      if (fetched !== null && fetched.bytes.length > 0) {
        let text: string | null = null;
        let files: DeliveryFile[] = [];
        try {
          const whole = new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes);
          // A drawing is a picture that happens to be written as text. Shown
          // as words it is a page of code; it is handed on as a file instead.
          if (!isDrawing(whole)) {
            // Files that came with it are listed at the end of the text.
            const parts = splitDelivery(whole);
            files = parts.files;
            text = parts.text;
          }
        } catch {
          text = null;
        }
        // A host opens this address for a person. Whatever a source of
        // deliveries hands back, only a web address ever leaves here.
        const uri = fetched.uri !== null && /^https:\/\/[^\s]+$/.test(fetched.uri) ? fetched.uri : null;
        const textTruncated = !fullText && text !== null && text.length > MAX_RESULT_TEXT;
        return {
          text: textTruncated ? text!.slice(0, MAX_RESULT_TEXT) : text,
          textTruncated, uri, hash: proofHashHex, verified: true, files,
        };
      }
    } catch (error) {
      this.#log(`delivery fetch: ${describeError(error)}`);
    }
    return null;
  }

  /** done: collect what can come back and free the provider's slot. */
  async #stepTidy(job: JobRecord): Promise<void> {
    // Downloads still retry after payment, including records made by older builds.
    if (!job.terms?.contest && job.outcome === "paid" && (!job.finalDeliveryChecked || !job.result?.verified)) {
      if (!job.finalDeliveryChecked) {
        this.#patchJob(job.id, (entry) => { entry.result = null; delete entry.deliveryPointer; });
      }
      if (!job.finalDeliveryChecked && job.task !== null) {
        const seen = await inspectJob(this.#chain, job.task as Address, this.#provider(job)).catch((error) => {
          this.#log(`paid account lookup: ${describeError(error)}`);
          return null;
        });
        if (seen?.status === "completed" && seen.submission?.status === SubmissionStatus.Accepted) {
          this.#patchJob(job.id, (entry) => {
            entry.result = null;
            entry.finalDeliveryChecked = true;
            entry.deliveryPointer = {
              hash: seen.submission!.proofHashHex,
              dataBase64: Buffer.from(seen.submission!.resultData).toString("base64"),
            };
          });
        }
      }
      await this.#recoverPaidDelivery(this.#jobRecord(job.id));
      if (!this.#jobRecord(job.id).finalDeliveryChecked) {
        this.#patchJob(job.id, (entry) => { entry.result = null; delete entry.deliveryPointer; });
        return;
      }
      await this.#refreshDelivery(this.#jobRecord(job.id));
      // Do not destroy the last on-chain pointer before retaining the delivery.
      if (!this.#jobRecord(job.id).result?.verified) return;
    }
    if (job.tidied || job.task === null) return;
    if (job.terms?.contest) return;
    // A paid hire stays open for a while so it can be rated. A request has
    // no service to rate, so it is tidied at once.
    if (!isRequest(job) && job.outcome === "paid" && job.rating === null) {
      const window = this.#config.rateWindowMs ?? 60 * 60_000;
      if (this.#now() - job.updatedAt < window) return;
    }
    const payer = await this.#payerSigner(job);
    const tidy = async (): Promise<string | null> => {
      const sent = await sendTidy(this.#chain, payer, job.task as Address, this.#provider(job));
      this.#store.update((draft) => {
        const entry = draft.jobs[job.id];
        if (entry === undefined) return;
        entry.tidied = true;
        // What came back to the main balance is not money that arrived.
        if (entry.payer === "main") {
          entry.balanceSettled = false;
          entry.returnedAt = this.#now();
        }
      });
      return sent;
    };
    // Not alongside the check for money that arrived in the main balance.
    const signature =
      job.payer === "main" ? await this.#lock(MAIN_KEY, tidy) : await tidy();
    this.#store.update((draft) => {
      const entry = draft.jobs[job.id];
      if (entry === undefined) return;
      if (signature !== null) {
        entry.signatures.close = signature;
        this.#note(draft, {
          kind: "tidied",
          text: `Collected the deposits from ${entry.title}.`,
          agentId: entry.agentId === "" ? null : entry.agentId,
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

  /**
   * Look at the deliveries this wallet's agents are waiting to be paid for.
   * One that the buyer turned down is on hold: remember what the chain says
   * about it, for the person to see. Since revision 9 the provider may
   * dispute the turn-down within 72 hours, posting a bond; that is the
   * person's decision (`disputeTurnDown`), never this wallet's. Once the
   * time is over, settle it, so the provider does not depend on the buyer's
   * software: that returns its claim and submission rent (and a bond nobody
   * ruled on) while the buyer is refunded, or, for a turn-down made before
   * revision 9, pays it.
   */
  async #watchFrozenWork(): Promise<void> {
    const seenNow = new Set<string>();
    for (const agent of Object.values(this.#store.state.agents)) {
      const waiting = this.#earn.jobs(agent.id).filter((entry) => entry.state === "delivered");
      if (waiting.length === 0) continue;
      const provider = await this.#earn.marketplaceAgent(agent.id);
      if (provider === null) continue;
      for (const entry of waiting) {
        const seen = await inspectJob(this.#chain, entry.task as Address, provider);
        if (seen === null) {
          if (this.#frozenWork.has(entry.task)) seenNow.add(entry.task);
          continue;
        }
        const jobId = `earn_${agent.id}_${entry.task}`;
        if (seen.status !== "reject_frozen" || seen.turnDown === null) {
          if (this.#frozenWork.has(entry.task)) {
            this.#store.update((draft) => {
              const record = (draft.workRecords ??= {})[jobId] ??= {};
              record.updatedAt = this.#now();
              delete record.turnDown;
              delete record.reviewDeadlineAt;
            });
          }
          continue;
        }
        seenNow.add(entry.task);
        const previous = this.#frozenWork.get(entry.task);
        const deadline = seen.turnDown.rulingUntil ?? seen.turnDown.disputeUntil;
        const turnDown = turnDownRecord(seen.turnDown);
        if (previous?.reviewDeadlineAt !== deadline || !sameTurnDown(previous.turnDown, turnDown)) {
          this.#store.update((draft) => {
            const record = (draft.workRecords ??= {})[jobId] ??= {};
            record.updatedAt = this.#now();
            record.reviewDeadlineAt = deadline;
            if (turnDown !== undefined) record.turnDown = turnDown;
          });
          this.#frozenWork.set(entry.task, {
            reviewDeadlineAt: deadline,
            attemptAt: previous?.attemptAt ?? null,
            turnDown,
          });
          this.#emit({ type: "job", jobId: `earn_${agent.id}_${entry.task}` });
        }
        const state = this.#frozenWork.get(entry.task)!;
        const recently =
          state.attemptAt !== null && this.#now() - state.attemptAt < FROZEN_SETTLE_RETRY_MS;
        if (seen.turnDown.expiryDue !== null && !recently) {
          state.attemptAt = this.#now();
          try {
            await sendFrozenExpiry(
              this.#chain,
              await this.#vault.signer(agent.keyId),
              entry.task as Address,
              provider,
            );
            this.#dropBalances();
            this.#emit({ type: "overview" });
          } catch (error) {
            this.#log(`collecting a turned-down job: ${describeError(error)}`);
          }
        }
      }
    }
    for (const task of [...this.#frozenWork.keys()]) {
      if (!seenNow.has(task)) this.#frozenWork.delete(task);
    }
  }

  /**
   * Dispute a buyer's turn-down of a delivery one of this wallet's agents
   * made (revision 9). It posts the bond from the agent's wallet: 10% of the
   * price, at least 0.01 SOL, plus a deposit for the bond's record that
   * comes back. The marketplace's reviewers then rule within 72 hours. For
   * the provider, it is paid and the bond comes back. For the buyer, the
   * bond goes to the buyer. With no ruling, the price goes back to the buyer
   * and the bond comes back. Only the person may do this.
   */
  async disputeTurnDown(jobId: string, isOwner: boolean, agentId?: string): Promise<JobView> {
    this.#reviewJob(jobId, agentId);
    throw this.#reviewRequired(isOwner);
  }

  #earnJobs(agentId: string): JobRecord[] {
    const agent = this.#store.state.agents[agentId];
    // A job keeps its listing only when it came through one of this agent's
    // own services: its name is then the person's own words. Any other
    // job's title is a stranger's, and a host may show a listed job's name
    // where it looks like the host's own (a system notification).
    const own = new Set(
      agent === undefined
        ? []
        : agentOffers(agent).flatMap((offer) => (offer.listing !== null ? [offer.listing] : [])),
    );
    return this.#earn.jobs(agentId).map((entry) => ({
      id: `earn_${agentId}_${entry.task}`,
      ...(entry.modelUsage && { modelUsage: entry.modelUsage, settledSellerLamports: entry.earnedLamports?.toString() ?? null }),
      role: "working" as const,
      agentId,
      createdAt: entry.createdAt,
      updatedAt: Math.max(entry.at, this.#store.state.workRecords?.[`earn_${agentId}_${entry.task}`]?.updatedAt ?? 0),
      idempotencyKey: null,
      listing: entry.listing !== null && own.has(entry.listing) ? entry.listing : "",
      providerAgent: "",
      title: agent === undefined ? "Job from the marketplace" : this.#earnedJobName(agent, entry),
      request: entry.request || this.#store.state.workRecords?.[`earn_${agentId}_${entry.task}`]?.request || "",
      acceptance: entry.acceptance.length > 0 ? entry.acceptance : this.#store.state.workRecords?.[`earn_${agentId}_${entry.task}`]?.acceptance ?? [],
      priceLamports: (entry.earnedLamports ?? entry.rewardLamports).toString(),
      expectedVersion: "0",
      listingSpecHashHex: "",
      payer: null,
      taskIdHex: "",
      task: entry.task,
      jobSpec: {},
      jobSpecHashHex: "",
      jobSpecUri: null,
      phase:
        entry.state === "failed"
          ? ("failed" as const)
          : entry.state === "paid" || entry.state === "not_paid"
            ? ("done" as const)
            : ("active" as const),
      hireAttemptAt: null,
      hiredAt: null,
      chainStatus:
        entry.state === "working"
          ? "in_progress"
          : entry.state === "delivered"
            ? this.#frozenWork.has(entry.task)
              ? "reject_frozen"
              : "pending_validation"
            : entry.state === "paid"
              ? "completed"
              : "cancelled",
      deadline: entry.marketplaceDeadline ?? null,
      ...(entry.terms && { terms: entry.terms }),
      reviewDeadlineAt:
        entry.state === "delivered"
          ? (this.#frozenWork.get(entry.task)?.reviewDeadlineAt ?? null)
          : null,
      ...(entry.state === "delivered" && this.#frozenWork.get(entry.task)?.turnDown !== undefined
        ? { turnDown: this.#frozenWork.get(entry.task)!.turnDown! }
        : {}),
      autoRefundAt: null,
      outcome: entry.state === "paid" ? "paid" : entry.state === "not_paid" ? "refunded" : null,
      changesRequested: false,
      result: this.#store.state.workRecords?.[`earn_${agentId}_${entry.task}`]?.result?.hash === entry.resultHashHex
        ? this.#store.state.workRecords![`earn_${agentId}_${entry.task}`]!.result!
        : null,
      ...(entry.resultHashHex !== null ? { deliveryPointer: {
        hash: entry.resultHashHex,
        dataBase64: Buffer.from(entry.resultUri ?? "").toString("base64"),
      } } : {}),
      rating: null,
      tidied: true,
      signatures: entry.settlementSignature === null ? {} : { accept: entry.settlementSignature },
      changes: [],
      error: entry.failure === null ? null : earnFailureSentence(entry.failure),
    }));
  }

  /** Hydrate a seller record without losing evidence on a transient fetch failure. */
  async #workDelivery(job: JobRecord): Promise<void> {
    await this.#lock(`work-evidence:${job.id}`, async () => {
      const cached = this.#store.state.workRecords?.[job.id];
      if (!job.request && cached?.request) {
        job.request = cached.request;
        job.acceptance = cached.acceptance ?? [];
        if (cached.terms) job.terms = cached.terms;
      }
      if (!job.request && job.task !== null) {
        try {
          const verified = await fetchAndVerifyJobSpec({
            task: job.task as Address,
            readAccount: this.#chain.readAccount,
            ...(this.#services.resolveAgencUri ? { resolveAgencUri: this.#services.resolveAgencUri } : {}),
          });
          const spec = JSON.parse(new TextDecoder().decode(verified.content)) as Record<string, unknown>;
          Object.assign(job, parseJobBrief(spec));
        } catch (error) {
          this.#log(`work request fetch: ${describeError(error)}`);
        }
      }
      const pointer = job.deliveryPointer;
      if (pointer !== undefined && (!job.result?.verified || job.result.hash !== pointer.hash)) {
        job.result = cached?.result?.verified && cached.result.hash === pointer.hash
          ? cached.result
          : await this.#loadResult(pointer.hash, Buffer.from(pointer.dataBase64, "base64"));
      }
      if ((job.result !== null && job.result !== cached?.result) || (job.request && job.request !== cached?.request)) {
        this.#store.update((draft) => {
          const record = (draft.workRecords ??= {})[job.id] ??= {};
          if (job.result !== null) record.result = job.result;
          if (job.request) { record.request = job.request; record.acceptance = job.acceptance; if (job.terms) record.terms = job.terms; }
        });
      }
    });
  }

  async listJobs(
    params: { role?: "buying" | "working"; agentId?: string; limit?: number; before?: string },
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
    records.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const limit = Math.min(200, Math.max(1, Math.trunc(params.limit ?? 50)));
    const cursor = params.before === undefined ? -1 : records.findIndex((job) => job.id === params.before);
    if (params.before !== undefined && cursor === -1) {
      throw new WalletError("NOT_FOUND", "That job cursor no longer exists. Refresh the list.");
    }
    const shown = records.slice(cursor + 1, cursor + 1 + limit);
    await Promise.all(shown.filter((job) => job.role === "working").map((job) => this.#workDelivery(job)));

    const context = {
      usdPerSol: await this.#displayRate(),
      now: this.#now(),
      network: this.#chain.network,
      isOwner,
      ratingCostLamports: await this.#ratingCost(),
      changesCanBeSent: this.#services.postChangeRequest !== undefined,
    };
    // A panel reads its jobs here only: each says what a first turn-down or
    // cancel costs, as one job's own view does.
    const recordCosts = await Promise.all(shown.map((job) => this.#firstRecordCost(job)));
    return shown.map((job, index) =>
      jobListPreview(jobView(job, { ...context, firstRecordCostLamports: recordCosts[index] ?? null })),
    );
  }

  /** The job, refreshed from the chain first when it is still running. */
  async getJob(jobId: string, isOwner: boolean, agentId?: string): Promise<JobView> {
    if (jobId.startsWith("earn_")) {
      const match = /^earn_(.+)_([1-9A-HJ-NP-Za-km-z]{32,44})$/u.exec(jobId);
      if (match === null || this.#store.state.agents[match[1]!] === undefined || (agentId !== undefined && match[1] !== agentId)) {
        throw new WalletError("NOT_FOUND", "That job does not exist.");
      }
      const found = this.#earnJobs(match[1]!).find((job) => job.id === jobId);
      if (found === undefined) throw new WalletError("NOT_FOUND", "That job does not exist.");
      await this.#workDelivery(found);
      return this.#jobView(found, isOwner);
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

  /** Read the complete delivery without storing an oversized list preview. */
  async jobDelivery(jobId: string, isOwner: boolean, agentId?: string, entryId?: string): Promise<NonNullable<JobRecord["result"]>> {
    const view = await this.getJob(jobId, isOwner, agentId);
    const job = view.role === "buying" ? this.#jobRecord(jobId) : this.#earnJobs(view.agentId).find((entry) => entry.id === jobId)!;
    if (entryId !== undefined) {
      const e = job.contestEntries?.find(e => e.id === entryId);
      if (!e) throw new WalletError("NOT_FOUND", "That entry is not part of this contest.");
      const result = await this.#loadResult(e.hash, values.hexToBytes(e.dataHex), true);
      if (!result) throw new WalletError("NOT_AVAILABLE", "The entry has no readable hosted delivery.");
      if (JSON.stringify(e.files ?? []) !== JSON.stringify(result.files)) {
        this.#patchJob(jobId, record => { record.contestEntries!.find(entry => entry.id === e.id)!.files = result.files; });
      }
      return result;
    }
    if (job.role === "buying" && job.outcome === "paid" && !job.finalDeliveryChecked) {
      throw new WalletError("NOT_FOUND", "The paid delivery has not been authenticated yet.");
    }
    const hash = job.deliveryPointer?.hash ?? view.result?.hash;
    if (hash == null) throw new WalletError("NOT_FOUND", "This job has no delivery yet.");
    const pointer = job.deliveryPointer !== undefined
      ? Buffer.from(job.deliveryPointer.dataBase64, "base64")
      : new TextEncoder().encode(view.result?.uri ?? "");
    const result = await this.#loadResult(hash, pointer, true);
    if (result === null) throw new WalletError("NETWORK", "The delivery could not be fetched right now. Try again in a moment.");
    return result;
  }

  /**
   * One file of a job's delivery. It is fetched from the delivery store by
   * the fingerprint the delivery lists for it, and handed over only when it
   * is that size, matches that fingerprint and really is the kind of file
   * its name says.
   */
  async jobFile(jobId: string, sha256: string): Promise<DeliveryFile & { base64: string }> {
    const job = await this.getJob(jobId, true);
    const listed = (job.result?.files ?? []).find(file => file.sha256 === sha256) ??
      this.#store.state.jobs[jobId]?.contestEntries?.flatMap(entry => entry.files ?? []).find(file => file.sha256 === sha256);
    if (listed === undefined) {
      let reference: ReviewAttachment | undefined;
      let before: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await this.reviewRecord(jobId, undefined, before ? { before } : {});
        reference = page.entries.flatMap(entry => entry.attachments).find(file =>
          file.hash === sha256 && new URL(file.uri).pathname.endsWith("/" + sha256));
        before = page.continuation;
        if (!before || seen.has(before)) break;
        seen.add(before);
      } while (!reference);
      if (!reference) throw new WalletError("NOT_FOUND", "That file is not part of this delivery.");
      const name = new URL(reference.uri).hash.slice(1);
      const type = deliveryFileType(name);
      if (!type) throw new WalletError("NOT_ALLOWED", "This reference has no supported file name.");
      const bytes = await this.#services.fetchFile(sha256);
      if (!bytes || createHash("sha256").update(bytes).digest("hex") !== sha256 || deliveryFileProblem(name, bytes)) {
        throw new WalletError("NOT_AVAILABLE", "The attached file could not be verified.");
      }
      return { name, type, bytes: bytes.length, sha256, base64: Buffer.from(bytes).toString("base64") };
    }
    const bytes = await this.#services.fetchFile(listed.sha256).catch(() => null);
    if (bytes === null) {
      throw new WalletError("NETWORK", "The file could not be fetched right now. Try again in a moment.");
    }
    if (
      bytes.length !== listed.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== listed.sha256 ||
      deliveryFileProblem(listed.name, bytes) !== null
    ) {
      throw new WalletError("NOT_ALLOWED", "The file is not what the delivery says it is, so it was not opened.");
    }
    return { ...listed, base64: Buffer.from(bytes).toString("base64") };
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
    quoteId?: string,
  ): Promise<JobView> {
    if (this.#ownedJob(jobId, agentId).terms?.contest) return contestUnavailable("Review the contest payout quote in Jobs.");
    const initial = this.#ownedJob(jobId, agentId);
    if (initial.payer !== "agent" && !isOwner) throw this.#reviewRequired(false);
    if (!quoteId) throw new WalletError(isOwner ? "APPROVAL_REQUIRED" : "NOT_ALLOWED",
      isOwner ? "Review the current delivery and confirm payment in Market." : "Read the current delivery in chat before approving payment.");
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
      const provider = this.#knownProvider(job);
      const { quote } = await this.#quoteReview(job, provider, null);
      if (!quote?.canPay || quote.id !== quoteId) {
        throw new WalletError("NOT_ALLOWED", "The delivery or payment terms changed. Open the job and review it again.");
      }
      await this.#withReviewPayment(job, quote, "approve", async payer => {
        const signature = await sendApproval(this.#chain, payer, job.task as Address, provider, quote);
        this.#recordPaid(jobId, signature);
        this.#records.invalidate();
      }).catch(cause => { throw this.#reviewError(jobId, quote.id, "approve", cause); });
    });
    // A request was not hired from a service, so there is nothing to rate.
    if (rating !== undefined && !isRequest(this.#jobRecord(jobId))) {
      await this.rateJob(jobId, rating, isOwner, agentId).catch((error) => {
        this.#log(`job ${jobId} rating: ${describeError(error)}`);
      });
    }
    void this.#advance(jobId);
    return this.#jobView(this.#jobRecord(jobId), isOwner);
  }

  /**
   * The provider a step on a delivered job is sent to. A request's is read
   * from the chain; until it has been, nothing is sent.
   */
  #knownProvider(job: JobRecord): Address {
    const provider = this.#provider(job);
    if (provider === null) {
      throw new WalletError(
        "NETWORK",
        "The marketplace has not said yet who took this request. Try again in a moment.",
      );
    }
    return provider;
  }

  #reviewJob(jobId: string, agentId?: string): JobRecord {
    if (!jobId.startsWith("earn_")) {
      const job = this.#ownedJob(jobId, agentId);
      if (job.terms?.contest) return contestUnavailable("Review contest entries in Jobs.");
      return job;
    }
    const match = /^earn_(.+)_([1-9A-HJ-NP-Za-km-z]{32,44})$/u.exec(jobId);
    if (match && (agentId === undefined || agentId === match[1])) {
      const job = this.#earnJobs(match[1]!).find(entry => entry.id === jobId);
      if (job) return job;
    }
    throw new WalletError("NOT_FOUND", "That job does not exist.");
  }

  async #reviewProvider(job: JobRecord) {
    return job.role === "working" ? this.#earn.marketplaceAgent(job.agentId) : this.#provider(job);
  }

  #reviewRequired(owner: boolean): WalletError {
    return new WalletError(owner ? "APPROVAL_REQUIRED" : "NOT_ALLOWED", "Review the current delivery and confirm this decision in Market.");
  }

  #quoteReview(job: JobRecord, provider: Address, rate: number | null) {
    const agent = job.payer === "main" ? null : this.#agentRecord(job.agentId);
    return quoteReview(this.#chain, job.id, job.task as Address, provider, job.role === "buying", rate, {
      payer: agent?.address ?? this.mainAddress,
      dailyLimitCents: agent ? (agent.policy.refill.enabled ? agent.policy.refill.perDayCents : 0) : null,
    });
  }

  async reviewRecord(jobId: string, agentId?: string, options: { before?: string; termsOnly?: boolean } = {}): Promise<ReviewRecord> {
    const job = this.#reviewJob(jobId, agentId);
    const provider = await reviewRead(this.#reviewProvider(job));
    const task = job.task as Address | null;
    if (!task || !provider) return { entries: [], historyAvailable: !task, termsAvailable: !task, resubmitBy: null, quote: null, draft: null };
    const [claim] = await findClaimPda({ task, bidder: provider });
    const rate = await reviewRead(this.#displayRate());
    const [terms, history] = await Promise.all([
      reviewRead(this.#quoteReview(job, provider, rate)),
      options.termsOnly || !this.#chain.reviewHistory ? null : reviewRead(this.#chain.reviewHistory(task, claim, options.before), 6000),
    ]);
    const saved = job.role === "working" ? this.#store.state.workRecords?.[jobId] : job;
    const latest = history?.entries.find(entry => entry.action === "change" && entry.round === terms?.lastRevision?.round);
    const revision = terms?.lastRevision;
    if (latest && revision && saved?.revisionDeadlines?.[latest.hash] !== revision.due) {
      this.#store.update(state => {
        const target = job.role === "working" ? ((state.workRecords ??= {})[jobId] ??= {}) : state.jobs[jobId]!;
        (target.revisionDeadlines ??= {})[latest.hash] = revision.due;
      });
    }
    const entries = await Promise.all((history?.entries ?? []).map(async receipt => {
      const frozen = terms?.frozenDelivery;
      const entry = frozen && receipt.intendedDelivery && receipt.action === "reject" && receipt.hash === frozen.reason && receipt.at === frozen.at
        ? { ...receipt, appliedDelivery: frozen.delivery } : receipt;
      const { feeLamports, rentLamports, bondLamports, round, ...anchor } = entry;
      const notice = deliveryNotice(entry);
      const role = anchor.action === "dispute" ? "worker" : "buyer";
      const envelope = anchor.action === "approve" ? null : await reviewRead(readReviewEnvelope(hash => this.#services.fetchFile(hash), task, anchor.hash, role));
      const external = anchor.evidenceUri?.startsWith("https://") && this.#services.fetchReviewEvidence
        ? await reviewRead(this.#services.fetchReviewEvidence(anchor.evidenceUri, anchor.hash)) : null;
      const deadline = anchor.action === "change"
        ? anchor.deadline ?? (revision && round === revision.round ? revision.due : saved?.revisionDeadlines?.[anchor.hash] ?? null)
        : anchor.deadline;
      return { ...anchor, ...(notice && { deliveryNotice: notice }), deadline, note: envelope?.body ?? null,
        ...(anchor.evidenceUri && { evidenceVerified: !!external || (anchor.evidenceUri === "agenc://artifact/sha256/" + anchor.hash && !!envelope) }),
        attachments: envelope?.attachments ?? (external && anchor.evidenceUri ? [{ uri: anchor.evidenceUri, hash: anchor.hash }] : []),
        fee: feeLamports === null ? null : money(feeLamports, rate),
        rent: rentLamports === null ? null : money(rentLamports, rate),
        bond: bondLamports === null ? null : money(bondLamports, rate) };
    }));
    const draft = saved?.reviewDraft;
    if (!options.termsOnly && this.#store.state.reviewIntents?.[jobId]?.receipt) {
      await reviewRead(this.#lock(this.#payerLock(job), () => this.#reconcileReview(jobId)));
    }
    const intent = this.#store.state.reviewIntents?.[jobId];
    return { entries, ...(history?.continuation && { continuation: history.continuation }),
      ...(intent && { publication: { ...(intent.intendedDelivery && { intendedDelivery: intent.intendedDelivery }),
        hashes: intent.hashes, published: intent.published ?? [], confirmed: intent.confirmed, ...(intent.receipt && { signature: intent.receipt.signature }) } }),
      historyIncomplete: history?.missing === true, historyAvailable: history?.complete === true, termsAvailable: terms !== null,
      resubmitBy: terms?.resubmitBy ?? null, quote: terms?.quote ?? null,
      draft: draft && draft.quoteId === terms?.quote?.id ? draft : null };
  }

  async draftReview(jobId: string, action: ReviewAction, note: string, attachments?: ReviewAttachment[], agentId?: string): Promise<ReviewDraft> {
    const job = this.#reviewJob(jobId, agentId);
    const provider = await this.#reviewProvider(job);
    if (!job.task || !provider) throw new WalletError("NOT_ALLOWED", "This job has no delivery to review.");
    const text = reviewNote(note);
    const files = reviewAttachments(attachments, job.task);
    const { quote } = await this.#quoteReview(job, provider, null);
    if (!quote?.actions.includes(action)) throw new WalletError("NOT_ALLOWED", "That decision is unavailable for this job.");
    const draft = { action, note: text, attachments: files, quoteId: quote.id };
    this.#store.update(state => {
      const target = job.role === "working" ? ((state.workRecords ??= {})[jobId] ??= {}) : state.jobs[jobId]!;
      target.reviewDraft = draft;
      target.updatedAt = Math.max(this.#now(), (target.updatedAt ?? 0) + 1);
    });
    this.#emit({ type: "job", jobId });
    return draft;
  }

  async #checkReview(job: JobRecord, review: ReviewConfirmation, action: ReviewAction) {
    const provider = await this.#reviewProvider(job);
    const { quote } = provider && job.task
      ? await this.#quoteReview(job, provider, null)
      : { quote: null };
    if (!quote || !quote.actions.includes(action) || review.action !== action || quote.id !== review.quoteId) {
      throw new WalletError("NOT_ALLOWED", "The delivery, deadline or costs changed. Open the job and review it again.");
    }
    return quote;
  }

  /** Check a signed transaction before accepting a new decision for the same job. */
  async #reconcileReview(jobId: string) {
    const prior = this.#store.state.reviewIntents?.[jobId];
    if (!prior?.receipt || prior.reconciled) return;
    const receipt = prior.receipt;
    const outcome = prior.confirmed ? "landed" : this.#chain.reviewSendOutcome
      ? await this.#chain.reviewSendOutcome(receipt) : await this.#chain.listingSendOutcome?.(receipt);
    if (!outcome || outcome === "pending") {
      throw new WalletError("NETWORK", "The review transaction is awaiting confirmation. Open the record for its signature.");
    }
    const paid = prior.agentId && this.#chain.reviewDebit
      ? await this.#chain.reviewDebit(receipt.signature, prior.payer as Address) : null;
    if (prior.agentId && !paid && outcome !== "expired") {
      throw new WalletError("NETWORK", "The review receipt is unavailable. Its allowance remains reserved until it can be checked.");
    }
    this.#store.update(state => {
      const intent = state.reviewIntents![jobId]!;
      if (intent.receipt?.signature !== receipt.signature) return;
      if (prior.agentId && outcome === "expired" && !paid) {
        const agent = state.agents[prior.agentId];
        if (agent) agent.refills = agent.refills.filter(entry => entry.signature !== receipt.signature);
      } else if (prior.agentId && paid && prior.rate) {
        const entry = state.agents[prior.agentId]?.refills.find(item => item.signature === receipt.signature);
        if (entry) {
          const actual = prior.action === "approve" || outcome === "failed" ? paid.fee : paid.debit;
          entry.lamports = String(actual);
          entry.usdCents = reviewChargeCents(actual, prior.rate);
        }
      }
      if (outcome === "landed") {
        intent.confirmed = true;
        intent.reconciled = !prior.agentId || paid !== null;
      } else {
        delete intent.receipt;
      }
    });
  }

  /** The signed transport supplies the signature before broadcast. Persist the
   * receipt and debit together, including when its acknowledgement never arrives. */
  async #withReviewPayment(job: JobRecord, quote: ReviewQuote, action: ReviewAction | "approve",
    work: (payer: KeyPairSigner) => Promise<void>): Promise<void> {
    const jobId = job.id;
    const cost = BigInt((action === "reject" ? quote.rejectionTotal : action === "dispute" ? quote.disputeTotal : quote.fee).lamports);
    const payer = await this.#payerSigner(job);
    const agentId = job.payer === "main" ? null : job.agentId;
    await this.#lock(this.#payerLock(job), async () => {
      await this.#reconcileReview(jobId);
      const prior = this.#store.state.reviewIntents?.[jobId];
      if (prior?.confirmed && prior.quoteId === quote.id) throw new WalletError("NOT_ALLOWED", "This decision is already confirmed.");
      await this.#chain.assertSigningRevision?.();
      const balance = await this.#chain.getBalance(payer.address);
      if (balance < cost) {
        const words = await this.#amountWords();
        throw new WalletError("NOT_ENOUGH_MONEY", `This decision needs ${words.cost(cost)}. Add at least ${words.add(cost - balance)}.`);
      }
      const rate = agentId === null ? null : await this.#freshRate().catch(() => null);
      const checkRoom = () => {
        if (agentId !== null && cost > this.#dailyRoom(this.#agentRecord(agentId), rate)) {
          throw new WalletError("NOT_ALLOWED", "This review would exceed the agent's daily allowance.");
        }
      };
      checkRoom();
      this.#store.update(state => {
        (state.reviewIntents ??= {})[jobId] = { quoteId: quote.id, action, confirmed: false, payer: payer.address, agentId, rate,
          ...(action !== "dispute" && { intendedDelivery: { submissionCount: quote.submissionCount, deliveryHash: quote.deliveryHash } }),
          createdAt: prior?.quoteId === quote.id ? prior.createdAt : this.#now(),
          hashes: prior && !prior.confirmed ? prior.hashes : [], published: prior && !prior.confirmed ? prior.published ?? [] : [] };
      });
      await inTransportScope({
        signal: AbortSignal.timeout(60_000),
        sending: receipt => {
          checkRoom();
          this.#store.update(state => {
            const intent = state.reviewIntents![jobId]!;
            if (intent.receipt) throw new WalletError("NETWORK", "The review transaction is awaiting confirmation.");
            intent.receipt = receipt;
            if (agentId !== null && rate !== null) {
              this.#reserveCharge(state.agents[agentId]!, { id: "review:" + jobId + ":" + receipt.signature,
                ts: this.#now(), lamports: String(cost),
                usdCents: reviewChargeCents(cost, rate),
              }, receipt.signature);
            }
          });
        },
        confirmed: signature => this.#store.update(state => {
          const intent = state.reviewIntents![jobId]!;
          if (intent.receipt?.signature === signature) intent.confirmed = true;
        }),
      }, () => work(payer));
      await this.#reconcileReview(jobId);
    });
  }

  #reviewError(jobId: string, quoteId: string, action: ReviewAction | "approve", cause: unknown) {
    const intent = this.#store.state.reviewIntents?.[jobId];
    if (!intent || intent.quoteId !== quoteId || intent.action !== action) return cause;
    const evidence = intent.published?.length ? "The verified evidence is public. Its fingerprints are in the job record."
      : intent.hashes.length ? "Evidence may already be public. Its fingerprints are in the job record." : "";
    if (intent.confirmed || intent.receipt) {
      const status = intent.confirmed
        ? (intent.reconciled ? "The review was confirmed." : "The review was confirmed. Its final cost is awaiting reconciliation in the job record.")
        : "Check the review transaction in the job record before retrying.";
      return new WalletError(intent.reconciled ? "NOT_ALLOWED" : "NETWORK", [status, evidence].filter(Boolean).join(" "), { cause });
    }
    if (!evidence && cause instanceof WalletError) return cause;
    const decision = { approve: "payment", change: "change request", reject: "rejection", dispute: "dispute" }[action];
    const reason = cause instanceof WalletError ? cause.message : "";
    return new WalletError(cause instanceof WalletError ? cause.code : "NETWORK",
      [evidence, `The ${decision} was not sent.`, reason].filter(Boolean).join(" "), { cause });
  }

  async confirmReview(jobId: string, input: ReviewConfirmation, isOwner: boolean): Promise<JobView> {
    if (!isOwner) throw this.#reviewRequired(false);
    const initial = this.#reviewJob(jobId);
    if (!initial.task || !input) throw new WalletError("BAD_REQUEST", "Choose a delivery to review.");
    const review = { ...input, note: reviewNote(input.note), attachments: reviewAttachments(input.attachments, initial.task) };
    await this.#lock(`job:${jobId}`, async () => {
      await this.#reconcileReview(jobId);
      const job = this.#reviewJob(jobId);
      const quote = await this.#checkReview(job, review, review.action);
      const task = job.task as Address;
      const provider = (await this.#reviewProvider(job))!;
      await this.#withReviewPayment(job, quote, review.action, async payer => {
        const submission = await readSubmission(this.#chain, task, provider);
        if (!submission) throw this.#reviewRequired(true);
        const parent = review.action === "dispute" ? Buffer.from(submission.account.rejectionHash).toString("hex") : job.changes.at(-1)?.hashHex ?? null;
        const reason = await this.#publishDecision(job, payer, review, parent);
        switch (review.action) {
          case "change": {
            const signature = await sendChangesRequest(this.#chain, payer, task, provider, reason.hash, quote);
            this.#patchJob(jobId, entry => {
              entry.changesRequested = true;
              entry.chainStatus = "in_progress";
              entry.reviewDeadlineAt = null;
              entry.signatures.changes = signature;
              entry.changes.push({ note: review.note, hashHex: reason.hex, ts: this.#now() });
            });
            break;
          }
          case "reject": {
            const { signature } = await sendRejectAndFreeze(this.#chain, payer, task, provider, reason.hash, await this.#amountWords(), quote);
            this.#forgetRecordCost(job);
            const frozen = await this.#readFreezeBack(task, provider);
            this.#patchJob(jobId, (entry, state) => {
              entry.chainStatus = "reject_frozen";
              entry.signatures.reject = signature;
              entry.providerRecorded = true;
              entry.reviewDeadlineAt = frozen ? frozen.rulingUntil ?? frozen.disputeUntil : null;
              const record = turnDownRecord(frozen);
              if (record) entry.turnDown = record;
              this.#note(state, { kind: "note", text: `You turned down ${entry.title}. The provider can dispute it within 72 hours.`,
                agentId: entry.agentId || null, jobId, signature });
            });
            break;
          }
          case "dispute": {
            const sent = await sendDisputeTurnDown(this.#chain, payer, task, provider, await this.#amountWords(), reason);
            this.#store.update(state => this.#note(state, { kind: "note", text: "The seller disputed the turn-down.",
              lamports: sent.bondLamports, agentId: job.agentId, jobId, signature: sent.signature }));
            break;
          }
        }
      });
    }).catch(cause => { throw this.#reviewError(jobId, review.quoteId, review.action, cause); });
    if (review.action === "dispute") {
      this.#frozenWork.delete(initial.task as Address);
      await this.#watchFrozenWork();
    }
    this.#dropBalances();
    this.#emit({ type: "job", jobId });
    this.#emit({ type: "activity" });
    this.#emit({ type: "overview" });
    return this.getJob(jobId, true);
  }

  async #publishDecision(job: JobRecord, payer: KeyPairSigner, review: ReviewConfirmation, parentHash: string | null) {
    const post = this.#services.postChangeRequest;
    if (!post) throw new WalletError("NOT_AVAILABLE", "This network has nowhere to publish evidence.");
    const publishing = (hash: string, verified = false) => this.#store.update(state => {
      const intent = state.reviewIntents![job.id]!;
      if (!intent.hashes.includes(hash)) intent.hashes.push(hash);
      if (verified && !intent.published?.includes(hash)) (intent.published ??= []).push(hash);
    });
    const envelope: taskThread.TaskThreadEnvelope = {
      v: 1, taskPda: job.task!, parentHash, role: review.action === "dispute" ? "worker" : "buyer",
      body: review.note, attachments: await publishReviewFiles(this.#services, payer, review, publishing),
      ts: Math.floor(this.#store.state.reviewIntents![job.id]!.createdAt / 1000),
    };
    const { bytes: hash, hex } = await taskThread.envelopeHash(envelope);
    publishing(hex);
    const prior = await this.#services.fetchFile(hex).catch(() => null);
    if (!prior || createHash("sha256").update(prior).digest("hex") !== hex) await post.call(this.#services, envelope, payer);
    publishing(hex, true);
    await this.#checkReview(job, review, review.action);
    return { hash, hex, uri: `agenc://artifact/sha256/${hex}` };
  }

  /** Send a delivery back with a note saying what to change. */
  async askChanges(jobId: string, _note: string, isOwner: boolean, agentId?: string): Promise<JobView> {
    this.#ownedJob(jobId, agentId);
    throw this.#reviewRequired(isOwner);
  }

  /**
   * Cancel and take the money back where the job allows it.
   *
   * A person may also turn down a delivery; an agent may not. Turning a
   * delivery down does NOT bring the price back at once, because the buyer
   * has already read the work: the price goes on hold and the provider has
   * 72 hours to dispute the turn-down. If it does not, the price comes back
   * then. If it does, the marketplace's reviewers decide; if nobody rules in
   * time, the price comes back. Asking for changes is the way to get the work
   * fixed. A first turn-down or cancel also starts the buyer's marketplace
   * record, paid once by the buyer.
   */
  /**
   * A turn-down this wallet just sent, read back from the chain: a few tries,
   * since the freeze is confirmed but a node may lag. Null when it cannot be
   * read yet.
   */
  async #readFreezeBack(task: Address, provider: Address): Promise<TurnDownOnChain | null> {
    for (let attempt = 0; attempt < FREEZE_READ_BACK_TRIES; attempt += 1) {
      const frozen = await readTurnDownOnChain(this.#chain, task, provider).catch(() => null);
      if (frozen !== null) return frozen;
      if (attempt + 1 < FREEZE_READ_BACK_TRIES) {
        await new Promise((resolve) => setTimeout(resolve, FREEZE_READ_BACK_GAP_MS));
      }
    }
    return null;
  }

  async refundJob(jobId: string, isOwner: boolean, agentId?: string): Promise<JobView> {
    const initial = this.#ownedJob(jobId, agentId);
    if (initial.terms?.contest && initial.phase !== "needs_approval") {
      if (initial.contestPending) await this.#advance(jobId);
      const current = this.#jobRecord(jobId);
      if (current.outcome === "refunded") return this.#jobView(current, isOwner);
      return this.quoteContest(jobId, { entryId: "", action: "cancel" }, agentId);
    }
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
      if (job.chainStatus === "reject_frozen") {
        throw new WalletError(
          "NOT_ALLOWED",
          isRequest(job)
            ? "This delivery was already turned down. Its reward is on hold until it is reviewed."
            : "This delivery was already turned down. Its price is on hold until it is reviewed.",
        );
      }
      if (job.chainStatus === "pending_validation") throw this.#reviewRequired(isOwner);
      const payer = await this.#payerSigner(job);
      const task = job.task as Address;
      try {
        // Before anyone takes a request there is nobody to name; afterwards
        // the cancel names whoever holds it, once their deadline has passed.
        const signature = await sendCancel(
          this.#chain,
          payer,
          task,
          this.#provider(job),
          await this.#amountWords(),
        );
        this.#recordRefund(jobId, signature, null);
      } catch (error) {
        if (error instanceof WalletError) throw error;
        throw new WalletError(
          "NOT_ALLOWED",
          isRequest(job)
            ? "This request cannot be cancelled right now. Someone has taken it; if they do not deliver in time, it is cancelled and the reward comes back."
            : "This job cannot be cancelled right now. If the provider has started, it can be cancelled once their deadline passes.",
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
      if (isRequest(job)) {
        throw new WalletError("NOT_ALLOWED", "Only a hired service can be rated.");
      }
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
          this.#records.invalidate();
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

  chooseWork(agentId: string, manual: boolean) {
    this.#agentRecord(agentId);
    if (!this.#earn.chosenRoom || typeof manual !== "boolean")
      throw new WalletError("NOT_AVAILABLE", "Choosing jobs needs an enabled job room.");
    this.#store.update((draft) => { draft.agents[agentId]!.earn.chooseOpenJobs = manual; });
    this.#emit({ type: "overview" });
    return { manual };
  }

  async #workRate() {
    const rate = await this.#freshRate();
    if (rate === null) throw new WalletError("NETWORK", "A current dollar price is needed for this job.");
    return rate;
  }

  #workLane(agentId: string, heldOnly = false, readonly = false): WorkerDispatch {
    const agent = this.#agentRecord(agentId);
    if (this.#closed || this.#closing || agent.earn.retiredAt != null) throw new WalletError("NOT_AVAILABLE", "This worker is unavailable.");
    if (heldOnly) {
      if (!this.#earn.hasChosenClaim(agentId)) throw new WalletError("NOT_AVAILABLE", "There is no chosen claim.");
      // A stopped-wallet reconciliation takes the journal lock. Queue it with
      // startup so opening the picker cannot lock the worker out on restart.
      return this.#earn.activeHeldLane(agentId, readonly) ?? (work => this.#lock(`earn-start:${agentId}`, () =>
        this.#earn.heldLane(agentId, () => this.#vault.signer(agent.keyId), readonly)(work)));
    }
    if (!this.#agentRecord(agentId).earn.enabled || this.#closed || this.#closing)
      throw new WalletError("NOT_ALLOWED", "Turn on Earns for this agent to choose work.");
    return this.#earn.workerLane(agentId, false, readonly);
  }

  async openWork(agentId: string, offset = 0, task?: string) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new WalletError("BAD_REQUEST", "That page is not available.");
    const target = task === undefined ? undefined : workAddress(task);
    const existing = this.#earn.hasChosenClaim(agentId);
    const dispatch = this.#workLane(agentId, existing, true);
    const rate = await this.#workRate();
    return dispatch(async (ctx, agent) => {
      const held = await heldWork(ctx, agent);
      const page = held || existing ? { jobs: [], next: null } : await browseOpenWork(ctx, agent, offset, target);
      const view = (job: OpenWork | HeldWork) => workerJob(job, rate, this.#chain.transferFeeLamports);
      return { jobs: page.jobs.map(view), next: page.next, held: held ? { ...view(held), canSubmit: held.canSubmit && this.#earn.chosenRoom && this.#agentRecord(agentId).earn.enabled } : null };
    });
  }

  pendingWork() {
    for (const [id, { quote }] of this.#workQuotes) {
      if (quote.expiresAt <= this.#now()) this.#workQuotes.delete(id);
    }
    return [...this.#workQuotes.values()].map(({ quote }) => structuredClone(quote));
  }

  async quoteWork(agentId: string, task: string, action: WorkAction) {
    const target = workAddress(task);
    if (action !== "claim" && action !== "submit" && action !== "release")
      throw new WalletError("BAD_REQUEST", "Choose a worker action.");
    const dispatch = this.#workLane(agentId, action === "release", true);
    await this.#reconcileWorkAllowance(agentId);
    const rate = await this.#workRate();
    return dispatch(async (ctx, agent) => {
      const job = action === "claim" ? (await browseOpenWork(ctx, agent, 0, target)).jobs[0] : await heldWork(ctx, agent);
      if (job?.task !== task)
        throw new WalletError("NOT_ALLOWED", "This job is no longer available for that action.");
      const view = workerJob(job, rate, this.#chain.transferFeeLamports, action);
      const quotedAt = this.#now();
      const lifetime = action === "release" ? releaseQuoteLifetime(view, await this.#chain.clusterTime()) : Infinity;
      if ((action === "release" && !view.canRelease) || (action === "submit" && !view.canSubmit))
        throw new WalletError("NOT_ALLOWED", "This job is no longer available for that action.");
      const quote: WorkerQuote = {
        id: newId("work"), agentId, action, job: view, ...quoteTransfers(job, action, rate),
        dailyRemaining: money(this.#dailyRoom(this.#agentRecord(agentId), rate), rate),
        expiresAt: quotedAt + Math.min(5 * 60_000, lifetime),
      };
      const terms = workAuthorizationTerms(job, action);
      for (const pending of this.pendingWork()) {
        if (pending.agentId === agentId && pending.action === action && pending.job.task === task) {
          if (this.#workQuotes.get(pending.id)?.terms === terms && pending.expiresAt <= quote.expiresAt && pending.charge.usdCents === quote.charge.usdCents &&
            pending.dailyRemaining.lamports === quote.dailyRemaining.lamports) return pending;
          this.#workQuotes.delete(pending.id);
        }
      }
      // The owner must always be able to read the entire pending list over the wallet socket.
      const pendingBytes = Buffer.byteLength(JSON.stringify([...this.pendingWork(), quote]));
      if (this.#workQuotes.size >= 24 || pendingBytes > MAX_FRAME_BYTES - 4096) throw new WalletError("NOT_ALLOWED", "Too many job requests are waiting.");
      this.#workQuotes.set(quote.id, { quote, terms });
      this.#emit({ type: "approval", approvalId: quote.id });
      this.#emit({ type: "overview" });
      return structuredClone(quote);
    });
  }

  async decideWork(id: string, approve: boolean) {
    const entry = this.#workQuotes.get(id);
    this.#workQuotes.delete(id);
    this.#emit({ type: "overview" });
    if (!entry || entry.quote.expiresAt <= this.#now()) throw new WalletError("NOT_ALLOWED", "That job quote has expired.");
    if (!approve) return { approved: false };
    const { agentId, action, job, charge } = entry.quote;
    const task = workAddress(job.task);
    const dispatch = this.#workLane(agentId, action === "release");
    await dispatch(async (ctx, agent, signal) => {
      let rate: number | undefined;
      let sent = false;
      let delivery: SubmissionIntent | undefined;
      const amount = BigInt(charge.lamports);
      const check = () => {
        this.#workLane(agentId, action === "release");
        signal.throwIfAborted();
        if (rate === undefined || this.#now() >= entry.quote.expiresAt)
          throw new WalletError("NOT_ALLOWED", "Review a new job quote.");
        if (amount > this.#dailyRoom(this.#agentRecord(agentId), rate))
          throw new WalletError("NOT_ALLOWED", "This job exceeds the agent's remaining daily allowance.");
      };
      const authorize = async (current: OpenWork | HeldWork) => {
        rate = await this.#workRate();
        if (workAuthorizationTerms(current, action) !== entry.terms ||
          JSON.stringify(quoteTransfers(current, action, rate).flows) !== JSON.stringify(entry.quote.flows))
          throw new WalletError("NOT_ALLOWED", "The job or its quote changed. Review a new quote.");
        check();
      };
      const sending = (receipt: { signature: string; lastValidBlockHeight: string }) => {
        check();
        if (sent) throw new Error("This quote already authorized a transaction.");
        sent = true;
        {
          const state = loadWorkerState(ctx.stateDir);
          if (state.openClaim?.task !== task || !state.openClaim.chosen || state.openClaim.chosenAttempt)
            throw new Error("The chosen claim changed.");
          if (action === "claim") {
            state.openClaim.claimTransactionSignature = receipt.signature;
            state.openClaim.claimLastValidBlockHeight = receipt.lastValidBlockHeight;
          } else {
            state.openClaim.chosenAttempt = { ...receipt, ...(action === "release" && job.cleanup && { cleanup: true }), ...(delivery && { delivery }) };
          }
          saveWorkerState(ctx.stateDir, state);
        }
        const micros = (amount * BigInt(Math.ceil(rate! * 1_000_000)) + 9_999_999n) / 10_000_000n;
        this.#store.update(draft => this.#reserveCharge(draft.agents[agentId]!, {
          id, lamports: charge.lamports, usdCents: Number(micros) / 1_000_000, ts: this.#now(),
          signature: receipt.signature, work: { lastValidBlockHeight: receipt.lastValidBlockHeight, fee: job.networkFee.lamports, rate: rate! },
        }));
      };
      const checkReleaseTime = async () => { releaseQuoteLifetime(job, await this.#chain.clusterTime()); };
      try {
        if (action === "release") await checkReleaseTime();
        await inTransportScope({ signal, sending, ...(action === "release" && { beforeSend: checkReleaseTime }), confirmed: () => {} }, async () => {
          if (action === "claim") await takeOpenWork(ctx, agent, signal, task, authorize);
          else await finishChosenWork(ctx, agent, signal, task, action, authorize, intent => { delivery = intent; });
        });
      } catch (error) {
        if (error instanceof WalletError) throw error;
        // The SDK wraps a wallet refusal at the transport boundary in its own error.
        if (!sent && error instanceof Error && error.cause instanceof WalletError) throw error.cause;
        throw new WalletError("NOT_AVAILABLE", "The worker could not confirm this action. Refresh the jobs before trying again.", { cause: error });
      } finally {
        if (sent) await this.#reconcileWorkAllowance(agentId);
      }
    });
    this.#emit({ type: "overview" });
    return { approved: true };
  }

  async #reconcileWorkAllowance(agentId: string) {
    if (!this.#chain.workOutcome) return;
    for (const charge of this.#agentRecord(agentId).refills) {
      if (!charge.work || !charge.signature) continue;
      const { lastValidBlockHeight, fee, rate } = charge.work;
      const outcome = await this.#chain.workOutcome({ signature: charge.signature, lastValidBlockHeight });
      if (outcome === "pending") continue;
      this.#store.update(draft => {
        const agent = draft.agents[agentId]!;
        const current = agent.refills.find(c => c.id === charge.id && c.signature === charge.signature);
        if (!current?.work) return;
        delete current.work;
        if (outcome === "expired") agent.refills = agent.refills.filter(c => c !== current);
        if (outcome === "failed") {
          current.lamports = fee;
          current.usdCents = Number((BigInt(fee) * BigInt(Math.ceil(rate * 1_000_000)) + 9_999_999n) / 10_000_000n) / 1_000_000;
        }
      });
    }
  }

  #checkOfferPrice(price: bigint): void {
    if (price < MIN_OFFER_PRICE_LAMPORTS) throw new WalletError("BAD_REQUEST", "That price is too low to offer.");
    const maximum = maximumOfferPrice(this.#config.earn ?? { executor: null });
    if (price > maximum)
      throw new WalletError(
        "BAD_REQUEST",
        "That price is above what this worker can accept. Use 1 SOL or less and stay within the worker's reward limit.",
      );
  }

  /** One allowance shared by refills, registration, listings and upkeep. */
  #dailyRoom(agent: AgentRecord, rate: number | null): bigint {
    const rule = agent.policy.refill;
    if (rate === null || !rule.enabled || rule.perDayCents <= 0) return 0n;
    const rateMicros = BigInt(Math.ceil(rate * 1_000_000));
    let usedMicros = 0n;
    for (const entry of agent.refills) {
      if (!entry.work && entry.ts <= this.#now() - 86_400_000) continue;
      // An approved transfer with no dollar price must not open automatic room.
      if (entry.usdCents === null) return 0n;
      usedMicros +=
        entry.usdCents === undefined
          ? (BigInt(entry.lamports) * rateMicros + 9_999_999n) / 10_000_000n
          : BigInt(Math.round(entry.usdCents * 1_000_000));
    }
    const transferRoom = BigInt(rule.perDayCents) * 1_000_000n - usedMicros;
    const jobRoom = remainingJobMicrocents(agent, this.#now());
    const remaining = transferRoom < jobRoom ? transferRoom : jobRoom;
    return remaining <= 0n ? 0n : (remaining * 10_000_000n) / rateMicros;
  }

  /** Live funding plan. No signer, upload or transaction is used. */
  async #earningQuote(agent: AgentRecord, offers = agentOffers(agent), quotedOfferId?: string): Promise<EarnFundingQuote> {
    const rate = await this.#freshRate().catch(() => null);
    const registration = await this.#earn.registration(agent.id);
    if (registration !== null && isRetiredAgent(registration.account)) {
      throw new WalletError("NOT_ALLOWED", `${agent.name} stopped earning for good.`);
    }
    const wanted = offers.filter((offer) => offer.wanted);
    for (const offer of wanted) {
      this.#checkOfferPrice(BigInt(offer.priceLamports));
      const terms = storedTerms(offer);
      checkOperator(terms.operator, terms.operatorFeeBps);
    }
    const price =
      wanted.length === 0
        ? undefined
        : wanted.reduce(
            (highest, offer) => (BigInt(offer.priceLamports) > highest ? BigInt(offer.priceLamports) : highest),
            0n,
          );
    const mask = wanted.reduce((bits, offer) => bits | BigInt(offer.terms?.servicePin?.capabilities ?? "1"), 1n);
    const updateFee = registration && (mask & registration.account.capabilities) !== mask ? this.#chain.transferFeeLamports : 0n;
    const registrationCost =
      registration === null
        ? (await this.#earn.startupRequirement()) - (await this.#earn.jobReserve()) + FEE_HEADROOM_LAMPORTS
        : updateFee;
    // One claim can need the permanent worker record. Every advertised slot
    // needs its own claim/submission rents, price-dependent bond and fees.
    const firstJob = await this.#earn.jobReserve(price);
    let workingReserve = firstJob;
    const deposits = await this.#earn.jobDeposits();
    if (wanted.length) {
      let concurrent = 0n;
      for (const offer of wanted) {
        const perHire = deposits + values.claimDepositLamports(BigInt(offer.priceLamports)) + FEE_HEADROOM_LAMPORTS;
        concurrent += BigInt(storedTerms(offer).maxOpenJobs) * perHire;
      }
      const firstSlot = deposits + values.claimDepositLamports(price!) + FEE_HEADROOM_LAMPORTS;
      const extra = concurrent - firstSlot;
      const spare = OFFER_SPARE_JOBS * deposits;
      workingReserve += extra > spare ? extra : spare;
    }
    let capacity: EarnFundingQuote["capacity"];
    let listingRent = 0n;
    let moderationRent = 0n;
    let setupFees = registration === null ? this.#chain.transferFeeLamports : updateFee;
    let listings = 0n;
    let checks = 0n;
    for (const offer of wanted) {
      const account = offer.listing === null ? null : await readListing(this.#chain, offer.listing as Address);
      const retired =
        account !== null &&
        Number(account.state) !== LISTING_STATE_ACTIVE &&
        Number(account.state) !== LISTING_STATE_PAUSED;
      if (offer.id === quotedOfferId) {
        capacity = { open: account?.openJobs ?? 0, proposed: storedTerms(offer).maxOpenJobs,
          pausing: !!account && reducesListingCapacity(account.maxOpenJobs, storedTerms(offer).maxOpenJobs) };
      }
      if (account === null || retired) {
        const rent = await this.#chain.getMinimumBalanceForRentExemption(LISTING_ACCOUNT_SPACE);
        listingRent += rent;
        listings += rent + FEE_HEADROOM_LAMPORTS;
        setupFees += this.#chain.transferFeeLamports;
      } else {
        const terms = storedTerms(offer);
        const changed = !sameChainTerms(account, terms) || account.price !== BigInt(offer.priceLamports) ||
          values.bytesToHex(new Uint8Array(account.specHash)) !== offer.specHashHex || account.specUri !== offer.specUri;
        const sends = Number(changed) + (Number(account.state) === LISTING_STATE_PAUSED ? 1 : reducesListingCapacity(account.maxOpenJobs, terms.maxOpenJobs) ? 2 : 0);
        setupFees += BigInt(sends) * this.#chain.transferFeeLamports;
        if (changed) listings += FEE_HEADROOM_LAMPORTS;
        if (Number(account.state) === LISTING_STATE_PAUSED) listings += FEE_HEADROOM_LAMPORTS;
        else if (reducesListingCapacity(account.maxOpenJobs, terms.maxOpenJobs)) listings += 2n * FEE_HEADROOM_LAMPORTS;
      }
      const gate =
        account === null || retired || registration === null
          ? null
          : await findListingGate(this.#chain, this.#services, {
              listing: offer.listing as Address,
              specHash: values.hexToBytes(offer.specHashHex),
              providerAgent: registration.address,
            });
      if (gate === null) {
        const cost = await approvalCost(this.#chain, "listing");
        moderationRent += cost - APPROVAL_FEE_LAMPORTS;
        setupFees += APPROVAL_FEE_LAMPORTS;
        checks += cost + FEE_HEADROOM_LAMPORTS;
      }
    }
    const networkReserve = await this.#floor();
    const required = registrationCost + workingReserve + listings + checks + networkReserve;
    const balance = await this.#chain.getBalance(agent.address as Address);
    const fromMain = required > balance ? required - balance : 0n;
    const fee = fromMain === 0n ? 0n : this.#chain.transferFeeLamports;
    const room = this.#dailyRoom(agent, rate);
    const registrationRent = registration ? 0n : await this.#chain.getMinimumBalanceForRentExemption(566);
    const lockedStake = registration ? 0n : registrationCost - registrationRent - FEE_HEADROOM_LAMPORTS;
    const firstClaimRecordRent = registration && await this.#chain.readAccount((await findAgentStatsPda({ creatorAgent: registration.address }))[0])
      ? 0n : await this.#chain.getMinimumBalanceForRentExemption(getAgentStatsSize());
    const slots = wanted.length ? wanted.reduce((sum, offer) => sum + BigInt(storedTerms(offer).maxOpenJobs), 0n) : 1n;
    const refundableClaimRent = slots * deposits;
    const claimDeposits = wanted.length ? wanted.reduce((sum, offer) => sum + BigInt(storedTerms(offer).maxOpenJobs) *
      values.claimDepositLamports(BigInt(offer.priceLamports)), 0n) : firstJob - refundableClaimRent -
      await this.#chain.getMinimumBalanceForRentExemption(getAgentStatsSize()) - FEE_HEADROOM_LAMPORTS;
    const keep = await this.#keepOnAll(agent);
    const feeReserve = required - networkReserve - registrationRent - lockedStake - refundableClaimRent - claimDeposits -
      firstClaimRecordRent - listingRent - moderationRent - setupFees;
    const exact = (n: bigint) => sellerMoney(n, rate);
    return {
      sellerFunding: {
        alreadyStaked: exact(registration?.account.stake ?? 0n), lockedStake: exact(lockedStake), claimDeposits: exact(claimDeposits), refundableClaimRent: exact(refundableClaimRent),
        registrationRent: exact(registrationRent), listingRent: exact(listingRent), moderationRent: exact(moderationRent),
        firstClaimRecordRent: exact(firstClaimRecordRent), setupFees: exact(setupFees), feeReserve: exact(feeReserve),
        reclaimNow: exact(balance > keep ? balance - keep : 0n),
      },
      ...(capacity && { capacity }),
      quoteId: newId("fund"),
      agentId: agent.id,
      expiresAt: this.#now() + 5 * 60_000,
      offerPrice: null,
      registration: sellerMoney(registrationCost, rate),
      listings: sellerMoney(listings, rate),
      checks: sellerMoney(checks, rate),
      workingReserve: sellerMoney(workingReserve, rate),
      networkReserve: sellerMoney(networkReserve, rate),
      agentBalance: sellerMoney(balance, rate),
      requiredBalance: sellerMoney(required, rate),
      fromMain: sellerMoney(fromMain, rate),
      transferFee: sellerMoney(fee, rate),
      totalFromMain: sellerMoney(fromMain + fee, rate),
      dailyRemaining: sellerMoney(room, rate),
      requiresApproval: fromMain + fee > room,
    };
  }

  async quoteEarn(
    agentId: string,
    input?: SellerOfferInput,
    offerId?: string,
    minPayCents?: number,
  ): Promise<EarnFundingQuote> {
    const agent = this.#agentRecord(agentId);
    this.#refuseIfRetired(agent);
    if (minPayCents !== undefined && (input !== undefined || !Number.isSafeInteger(minPayCents) || minPayCents < 0))
      throw new WalletError("BAD_REQUEST", "Give a valid minimum job payment when turning on Earns.");
    if (input?.setupId !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(input.setupId))
      throw new WalletError("BAD_REQUEST", "Invalid service setup identifier.");
    let offers = agentOffers(agent);
    let price: bigint | null = null;
    let quotedTerms: ReturnType<typeof storedTerms> | undefined;
    let action = JSON.stringify(["enable", minPayCents ?? null]);
    if (input !== undefined) {
      if (input === null || typeof input !== "object") {
        throw new WalletError("BAD_REQUEST", "That service is not valid.");
      }
      checkOfferDelivery(input.deliverySecs);
      const name = tidyText(input.name, 60);
      const summary = tidyText(input.summary, 280);
      if (name === null || summary === null || Buffer.byteLength(name, "utf8") > LISTING_NAME_MAX_BYTES) {
        throw new WalletError("BAD_REQUEST", "Give the service a short name and description.");
      }
      const previous = offers.find((offer) => (offerId === undefined ? offer.name === name : offer.id === offerId));
      if (offerId !== undefined && previous === undefined)
        throw new WalletError("NOT_FOUND", "That service does not exist.");
      if (previous?.listed && previous.name !== name)
        throw new WalletError("BAD_REQUEST", "A listed service's name cannot change.");
      if (offers.some((offer) => offer.id !== previous?.id && offer.wanted && offer.name === name)) {
        throw new WalletError("BAD_REQUEST", "This agent already offers a service by that name.");
      }
      if (previous === undefined && offers.filter((offer) => offer.wanted).length >= MAX_OFFERS_PER_AGENT)
        throw new WalletError("BAD_REQUEST", "Take one service off offer first.");
      price = await this.#offerLamports(input.price);
      this.#checkOfferPrice(price);
      const terms = resolveTerms(input.deliverySecs === undefined ? input.terms : { ...input.terms, deliverySecs: input.deliverySecs }, previous);
      quotedTerms = terms;
      const spec = sellerListingSpec({ name, summary, ...terms }, agent.address);
      action = this.#quotedOfferKey(offerId, name, summary, price, terms, input.enableEarns, input.setupId);
      const completed = input.setupId && Object.hasOwn(agent.serviceSetups ?? {}, input.setupId) ? agent.serviceSetups![input.setupId] : undefined;
      if (completed) throw new WalletError(completed.action !== action ? "PRICE_CHANGED" : "BAD_REQUEST",
        completed.action !== action ? "This setup already approved different terms." : "This service setup was already funded. Check its status.");
      const hash = await jobSpecHash(spec);
      const next: OfferRecord = {
        id: previous?.id ?? "quote",
        listingIdHex: previous?.listingIdHex ?? "",
        listing: previous?.listing ?? null,
        listed: previous?.listed ?? false,
        name,
        summary,
        category: terms.category,
        terms,
        priceLamports: price.toString(),
        deliverySecs: terms.deliverySecs,
        spec,
        specHashHex: hash.hex,
        specUri: previous?.specHashHex === hash.hex ? (previous.specUri ?? null) : null,
        wanted: true,
        status: "getting_ready",
        error: null,
        lastCheckAt: null,
        refused: null,
        signatures: {},
      };
      offers = [...offers.filter((offer) => offer.id !== previous?.id), next];
    }
    const admission = price !== null && quotedTerms ? await this.#serviceAdmission(agentId, price, quotedTerms) : undefined;
    const quote = await this.#earningQuote(agent, offers, input && offers.at(-1)?.id);
    if (admission) quote.serviceAdmission = admission;
    quote.confirmAction = true;
    const total = BigInt(quote.totalFromMain.lamports);
    if (total > 0n) {
      const available = await this.#chain.getBalance(this.mainAddress);
      const missing = total + BigInt(quote.networkReserve.lamports) - available;
      quote.shortfall = money(missing > 0n ? missing : 0n, await this.#displayRate());
    }
    if (price !== null && quotedTerms) {
      const rate = await this.#displayRate();
      quote.offerPrice = money(price, rate);
      if (quote.sellerFunding) quote.sellerFunding.price = sellerMoney(price, rate);
      quote.sellerTerms = quotedTerms;
      quote.proceeds = sellerProceeds(price, quotedTerms.operatorFeeBps, await this.#marketFeeBps(), rate);
    }
    for (const [id, value] of this.#fundingQuotes)
      if (value.quote.expiresAt <= this.#now()) this.#fundingQuotes.delete(id);
    if (this.#fundingQuotes.size >= 100) this.#fundingQuotes.delete(this.#fundingQuotes.keys().next().value!);
    if (input?.setupId) {
      if (typeof input.setupId !== "string" || input.setupId.length > 80) throw new WalletError("BAD_REQUEST", "Invalid service setup.");
      this.#store.update(state => {
        const saved = state.setupQuotes ??= {};
        for (const [key, entry] of Object.entries(saved)) if (entry.quote.expiresAt <= this.#now()) delete saved[key];
        if (Object.keys(saved).length >= 100) delete saved[Object.keys(saved)[0]!];
        saved[quote.quoteId] = { quote: structuredClone(quote), action, before: this.#sellerRevision(agent), offers: structuredClone(offers) };
      });
      return quote;
    }
    this.#fundingQuotes.set(quote.quoteId, {
      quote: structuredClone(quote),
      target: BigInt(quote.requiredBalance.lamports),
      action, before: this.#sellerRevision(agent), offers: structuredClone(offers),
    });
    return quote;
  }

  async #continueSellerAction<T>(agentId: string, quoteId: string | undefined, work: () => Promise<T>): Promise<T> {
    if (quoteId === undefined) return work();
    const scope = { agentId, active: true };
    try {
      return await this.#quotedContinuation.run(scope, work);
    } finally {
      // Future maintenance keeps using the ordinary daily allowance.
      scope.active = false;
    }
  }

  #enabledServiceMask(agent: AgentRecord): bigint {
    return agentOffers(agent).reduce((mask, offer) => {
      if (!offer.wanted || !offer.terms?.servicePin) return mask;
      readServiceRehearsal(this.#earn.stateDir(agent.id), offer.terms.servicePin);
      return mask | BigInt(offer.terms.servicePin.capabilities);
    }, 1n);
  }

  /** A picker cannot promise an unregistered or locally unavailable feature. */
  async effectiveServiceCapabilities(agentId: string): Promise<bigint> {
    const registration = await this.#earn.registration(agentId);
    return registration ? this.#enabledServiceMask(this.#agentRecord(agentId)) & registration.account.capabilities : 0n;
  }

  async #serviceAdmission(agentId: string, priceLamports: bigint, terms: ReturnType<typeof storedTerms>) {
    if (terms.servicePin) readServiceRehearsal(this.#earn.stateDir(agentId), terms.servicePin);
    const result = serviceEconomics({ priceLamports, ...terms, marketFeeBps: await this.#marketFeeBps(),
      usdPerSol: await this.#freshRate().catch(() => null) });
    return { minimumPriceLamports: String(result.minimumPriceLamports), modelBudgetCents: result.modelBudgetCents,
      capabilities: terms.servicePin?.capabilities ?? "1" };
  }

  #sellerRevision(agent: AgentRecord): string {
    return JSON.stringify([agent.earn.enabled, agent.earn.minPayCents, agent.earn.chooseOpenJobs ?? null, agentOffers(agent).map((offer) =>
      [offer.id, offer.name, offer.wanted, offer.specHashHex, offer.priceLamports, storedTerms(offer)])]);
  }

  #offerLamports(price: AmountInput): Promise<bigint> {
    if (!price || typeof price !== "object" || ("usdCents" in price) === ("lamports" in price) ||
      ("lamports" in price && typeof price.lamports !== "string")) {
      throw new WalletError("BAD_REQUEST", "Give one price, in dollars or lamports.");
    }
    return this.#toLamports(price);
  }

  #quotedOfferKey(id: string | undefined, name: string, summary: string, price: bigint, terms: ReturnType<typeof storedTerms>, enableEarns?: true, setupId?: string): string {
    return JSON.stringify([id ?? null, name, summary, price.toString(), terms, ...(enableEarns ? ["enableEarns"] : []), ...(setupId ? [setupId] : [])]);
  }

  /** Explicit owner approval of this quote's agent and maximum transfer, once. */
  async approveEarnFunding(quoteId: string): Promise<AgentView> {
    const { agent } = await this.#consumeFunding(quoteId);
    return this.#oneAgentView(agent.id);
  }

  #checkPendingFunding(agentId: string, stopping?: { offerId?: string | undefined }): void {
    const pending = this.#agentRecord(agentId).earn.pendingListingSends ?? [];
    if (pending.some(({ operation }) => {
      if (operation?.kind !== "funding") return false;
      const target = fundedOfferId(operation);
      return !stopping || target === undefined || target === stopping.offerId;
    }))
      throw new WalletError("NETWORK", "Market is checking an earlier funding transfer. Wait for its outcome.");
  }

  async #consumeFunding(quoteId: string, confirm?: { agentId: string; action: string; effect: SellerEffect }): Promise<{ agent: AgentRecord; replayed: boolean }> {
    if (confirm) {
      const agent = this.#agentRecord(confirm.agentId);
      if ("offer" in confirm.effect && confirm.effect.setupId && Object.hasOwn(agent.serviceSetups ?? {}, confirm.effect.setupId)) {
        const saved = agent.serviceSetups![confirm.effect.setupId]!;
        if (saved.action !== confirm.action) throw new WalletError("PRICE_CHANGED", "This setup approved different terms.");
        return { agent, replayed: true };
      }
      const previous = agent.earn.sellerDecisions?.[quoteId];
      if (previous) {
        if (previous.action !== confirm.action) throw new WalletError("PRICE_CHANGED", "This quote approved different terms.");
        if (!previous.landed) throw new WalletError("BAD_REQUEST", "The earlier transfer did not land. Review a new quote.");
        return { agent, replayed: true };
      }
      this.#checkPendingFunding(agent.id);
    }
    const setup = this.#store.state.setupQuotes?.[quoteId];
    if (setup && !confirm) throw new WalletError("NOT_ALLOWED", "Use this quote to confirm the service setup.");
    const entry = setup ? { ...setup, target: BigInt(setup.quote.requiredBalance.lamports) } : this.#fundingQuotes.get(quoteId);
    if (setup) this.#store.update(state => { delete state.setupQuotes![quoteId]; });
    this.#fundingQuotes.delete(quoteId);
    if (entry === undefined || entry.quote.expiresAt <= this.#now())
      throw new WalletError("BAD_REQUEST", "That funding quote expired or was already used. Get a new quote.");
    const agent = this.#agentRecord(entry.quote.agentId);
    this.#refuseIfRetired(agent);
    await this.#lock(`offer:${agent.id}`, () => this.#lock(`funding:${agent.id}`, async () => {
      this.#checkPendingFunding(agent.id);
      this.#refuseIfRetired(this.#agentRecord(agent.id));
      if (confirm && (confirm.agentId !== agent.id || confirm.action !== entry.action ||
        entry.before !== this.#sellerRevision(this.#agentRecord(agent.id)))) {
        throw new WalletError("PRICE_CHANGED", "The service or earning settings changed. Review a new quote.");
      }
      const balance = await this.#chain.getBalance(agent.address as Address);
      if (confirm) {
        const fresh = await this.#earningQuote(agent, entry.offers, entry.quote.capacity && entry.offers.at(-1)?.id);
        if (confirm && "offer" in confirm.effect && entry.quote.serviceAdmission) {
          const offer = confirm.effect.offer;
          const admission = await this.#serviceAdmission(agent.id, BigInt(offer.priceLamports), storedTerms(offer));
          if (JSON.stringify(admission) !== JSON.stringify(entry.quote.serviceAdmission))
            throw new WalletError("PRICE_CHANGED", "The service budget changed. Review a new quote.");
        }
        if (JSON.stringify(fresh.capacity) !== JSON.stringify(entry.quote.capacity))
          throw new WalletError("PRICE_CHANGED", "The number of open hires changed. Review a new quote.");
        if (entry.quote.sellerFunding && fresh.sellerFunding) {
          const approvedRows = { ...entry.quote.sellerFunding, price: undefined };
          if (JSON.stringify(approvedRows) !== JSON.stringify(fresh.sellerFunding))
            throw new WalletError("PRICE_CHANGED", "The funding breakdown changed. Review a new quote.");
        }
        for (const key of ["registration", "listings", "checks", "workingReserve", "networkReserve", "fromMain", "transferFee", "dailyRemaining"] as const) {
          if (fresh[key].lamports !== entry.quote[key].lamports)
            throw new WalletError("PRICE_CHANGED", "The funding figures changed. Review a new quote.");
        }
      }
      const missing = entry.target > balance ? entry.target - balance : 0n;
      const quoted = BigInt(entry.quote.fromMain.lamports);
      if (confirm && (entry.quote.expiresAt <= this.#now() || missing !== quoted ||
        (quoted > 0n && this.#chain.transferFeeLamports !== BigInt(entry.quote.transferFee.lamports)))) {
        throw new WalletError("PRICE_CHANGED", "Funding changed or the quote expired. Review a new quote.");
      }
      const amount = missing < quoted ? missing : quoted;
      if (amount > 0n && amount + this.#chain.transferFeeLamports > BigInt(entry.quote.totalFromMain.lamports)) {
        throw new WalletError("PRICE_CHANGED", "The funding fee changed. Review a new quote.");
      }
      const decision = confirm && { quoteId, action: confirm.action, effect: confirm.effect, fundedLamports: amount.toString(), expiresAt: entry.quote.expiresAt };
      if (amount > 0n) {
        await this.#withListingTransport(agent.id, this.#listingAbort.signal, () =>
          this.#mainToAgent(agent, amount, `Approved funding for ${agent.name} to earn.`,
            { approved: true, ...(decision && { exact: entry.quote, decision }) }));
      } else if (decision) {
        this.#store.update((draft) => applySellerDecision(draft.agents[agent.id]!, decision, true));
      }
      this.#store.update((draft) => agentOffers(draft.agents[agent.id]!).forEach(clearOfferFundingWait));
      this.#emit({ type: "overview" });
    }));
    return { agent, replayed: false };
  }

  async #fundEarning(agent: AgentRecord, offer?: OfferRecord): Promise<void> {
    await this.#lock(`funding:${agent.id}`, async () => {
      const quote = await this.#earningQuote(this.#agentRecord(agent.id));
      const amount = BigInt(quote.fromMain.lamports);
      if (amount > 0n && offer?.fundingConfirmed)
        throw new WalletError("APPROVAL_REQUIRED", "The action needs more funding. Review a new quote.");
      if (amount > 0n) await this.#mainToAgent(agent, amount, `Set money aside so ${agent.name} can earn.`, {});
    });
  }

  #startEarning(agent: AgentRecord): Promise<void> {
    return this.#lock(`earn-start:${agent.id}`, () => this.#startEarningLocked(agent));
  }

  async #startEarningLocked(agent: AgentRecord): Promise<void> {
    if (this.#closed) return;
    // A retired agent can never take a job again, whatever older records say.
    if (agent.earn.retiredAt != null) return;
    const startupRead = <T>(read: () => Promise<T>) => this.#withListingTransport(agent.id, this.#listingAbort.signal, read);
    const registration = await startupRead(() => this.#earn.registration(agent.id)).catch(() => null);
    if (this.#closed) return;
    if (registration !== null && this.#noticeRetired(agent.id, registration.account)) return;
    try {
      const signer = await this.#vault.signer(agent.keyId);
      const rate = await startupRead(() => this.#freshRate()).catch(() => null);
      if (rate === null) throw new WalletError("NETWORK", "A current dollar price is needed before taking jobs.");
      const minRewardLamports = centsToLamports(agent.earn.minPayCents, rate);
      const owed = this.#owed.get(agent.id);
      // A switch off or shutdown may have happened while startup was waiting.
      const current = this.#agentRecord(agent.id);
      if (this.#closed || !current.earn.enabled || current.earn.retiredAt != null) return;
      // Reconcile stored listing intent before admitting work after a restart.
      if (!await this.#advanceOffer(agent.id)) {
        throw new WalletError("NETWORK", "The services must be reconciled before taking jobs.");
      }
      if (this.#earn.isRecovering(agent.id)) await this.#earn.stop(agent.id);
      if (this.#closed || !this.#agentRecord(agent.id).earn.enabled) return;
      const started = this.#earn.start({
        agentId: agent.id,
        signer,
        minRewardLamports,
        chooseOpenJobs: () => {
          const current = this.#agentRecord(agent.id);
          return current.earn.chooseOpenJobs ?? (agentOffers(current).length > 0);
        },
        capabilities: this.#enabledServiceMask(current),
        currentCapabilities: async () => {
          const local = this.#enabledServiceMask(this.#agentRecord(agent.id));
          if (local === 1n) return local;
          const registered = await this.#earn.registration(agent.id);
          return registered ? local & registered.account.capabilities : local;
        },
        specialistTerms: required => agentOffers(this.#agentRecord(agent.id)).find(offer => offer.wanted && required > 1n &&
          offer.terms?.servicePin && (BigInt(offer.terms.servicePin.capabilities) & required) === required)?.terms,
        admitsListing: listing => {
          const offers = agentOffers(this.#agentRecord(agent.id));
          return offers.some(offer => offer.listing === listing && offer.listed);
        },
        reconcileBeforeOpenJobs: agentOffers(current).some((offer) => offer.wanted && offer.listed),
        ...(owed !== undefined ? { owed } : {}),
        solUsd: () => this.#freshRate(),
      });
      if (agentOffers(current).some((offer) => offer.wanted)) {
        const resume = started.then(() => this.#earn.canTakeJobs(agent.id) && this.#advanceOffer(agent.id));
        if (this.#earn.hasUnfinishedJob(agent.id)) this.#backgroundWork(resume);
        else await resume;
      }
      this.#store.update((draft) => { draft.agents[agent.id]!.earn.lastError = null; });
    } catch (error) {
      this.#store.update((draft) => { draft.agents[agent.id]!.earn.lastError = "A current dollar price and marketplace connection are needed before taking jobs."; });
      this.#log(`earn ${agent.id}: ${describeError(error)}`);
    }
  }

  #onEarnNotice(agentId: string, notice: EarnNotice): void {
    if (notice.type === "paid" || notice.type === "failed") {
      const jobId = `earn_${agentId}_${notice.task}`;
      const entry = this.#earn.jobs(agentId).find((job) => job.task === notice.task);
      const record = this.#store.state.agents[agentId];
      const name = entry === undefined || record === undefined ? null : this.#earnedJobName(record, entry);
      this.#store.update((draft) => {
        const agent = draft.agents[agentId];
        if (agent === undefined) return;
        if (notice.type === "paid") {
          const credited = agent.earn.creditedTasks ??= {};
          if (credited[notice.task]) return;
          credited[notice.task] = true;
          agent.earnedLamports = (BigInt(agent.earnedLamports) + notice.earnedLamports).toString();
          agent.earn.jobsDone += 1;
          this.#note(draft, {
            kind: "earned",
            text: name === null ? `${agent.name} was paid for a job.` : `${agent.name} was paid for ${name}.`,
            lamports: notice.earnedLamports,
            agentId,
            jobId,
            signature: notice.signature,
          });
        } else {
          this.#note(draft, {
            kind: "note",
            text: `${agent.name} could not do ${name ?? "a job"}: ${earnFailureWords(notice.failure)}.`,
            agentId,
            jobId,
          });
        }
      });
      this.#dropBalances();
      this.#emit({ type: "activity" });
      // Hosts tell the person about a job that was paid, or that failed.
      this.#emit({ type: "job", jobId });
    }
    this.#emit({ type: "overview" });
  }

  /**
   * What an earned job is called: the agent's own service when it was a hire
   * of it, else the title its job spec gives (the buyer's words), else a
   * plain stand-in.
   */
  #earnedJobName(agent: AgentRecord, entry: EarnedJob): string {
    if (entry.listing !== null) {
      const offer = agentOffers(agent).find((candidate) => candidate.listing === entry.listing);
      if (offer !== undefined) return offer.name;
    }
    // A hire made by this kind of wallet titles its request "Hire: <service>".
    const title = entry.title?.replace(/^Hire:\s*/u, "").trim() ?? "";
    return title.length > 0 ? title : "Job from the marketplace";
  }

  /** Read the original funding receipt and current listing without dispatching work. */
  sellerSetup(agentId: string, setupId: string) {
    const agent = this.#agentRecord(agentId);
    const saved = Object.hasOwn(agent.serviceSetups ?? {}, setupId) ? agent.serviceSetups![setupId] : undefined;
    if (!saved) return null;
    const offer = agentOffers(agent).find(o => o.id === saved.offerId);
    return { ...saved, listing: offer?.listing ?? null, stage: offer?.status ?? "problem", error: offer?.error ?? null };
  }

  async quoteManualWork(agentId: string) {
    const agent = this.#agentRecord(agentId);
    const quote = await this.quoteEarn(agentId, undefined, undefined, agent.earn.minPayCents);
    const entry = this.#fundingQuotes.get(quote.quoteId)!;
    this.#store.update(state => {
      const saved = state.setupQuotes ??= {};
      for (const [id, q] of Object.entries(saved)) if (q.quote.expiresAt <= this.#now()) delete saved[id];
      saved[quote.quoteId] = { quote: structuredClone(quote), before: entry.before, offers: entry.offers,
        action: JSON.stringify(["enable-manual", agent.earn.minPayCents]) };
    });
    this.#fundingQuotes.delete(quote.quoteId);
    return quote;
  }

  async startManualWork(agentId: string, fundingQuoteId: string) {
    if (!fundingQuoteId || !this.#earn.chosenRoom) throw new WalletError("NOT_AVAILABLE", "Prepare the job room and review the worker quote.");
    return this.#lock(`seller-confirm:${agentId}`, () => this.#setEarn(agentId, true, this.#agentRecord(agentId).earn.minPayCents, fundingQuoteId, true));
  }

  async setEarn(agentId: string, enabled: boolean, minPayCents?: number, fundingQuoteId?: string): Promise<AgentView> {
    const apply = () => this.#setEarn(agentId, enabled, minPayCents, fundingQuoteId);
    return this.#lock(`seller-confirm:${agentId}`, apply);
  }

  async #setEarn(agentId: string, enabled: boolean, minPayCents?: number, fundingQuoteId?: string, manual = false): Promise<AgentView> {
    if (this.#closed) throw new WalletError("NOT_AVAILABLE", "This wallet is closed.");
    const agent = this.#agentRecord(agentId);
    this.#checkPendingFunding(agentId, enabled ? undefined : {});
    if (!enabled && fundingQuoteId !== undefined) throw new WalletError("BAD_REQUEST", "Turning off Earns does not use a funding quote.");
    if (enabled) this.#refuseIfRetired(agent);
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
      if (fundingQuoteId !== undefined) {
        const decision = await this.#consumeFunding(fundingQuoteId, {
          agentId, action: JSON.stringify([manual ? "enable-manual" : "enable", minPayCents ?? null]),
          effect: { ...(manual && { manual }), minPayCents: minPayCents ?? agent.earn.minPayCents },
        });
        if (decision.replayed) return this.#oneAgentView(agentId);
      } else await this.#fundEarning(agent);
    }
    // Setting money aside takes a moment; the agent may have been stopped for good meanwhile.
    if (enabled) this.#refuseIfRetired(this.#agentRecord(agentId));
    if (!(enabled && fundingQuoteId)) this.#store.update((draft) => {
      const entry = draft.agents[agentId]!;
      if (entry.earn.enabled !== enabled) agentOffers(entry).forEach(clearOfferFundingWait);
      entry.earn.enabled = enabled && entry.earn.retiredAt == null;
      if (enabled && agentOffers(entry).length === 0) entry.earn.chooseOpenJobs ??= false;
      entry.earn.lastError = null;
      if (minPayCents !== undefined) entry.earn.minPayCents = Math.round(minPayCents);
    });
    if (enabled) {
      // Switching on is the person's go to try again after the agent
      // stopped because several jobs in a row failed.
      if (this.#earn.pausedReason(agentId) !== null) {
        await this.#earn.stop(agentId);
        this.#earn.clearPause(agentId);
      }
      await this.#continueSellerAction(agentId, fundingQuoteId, () => this.#startEarning(this.#agentRecord(agentId)));
    } else {
      // stop aborts discovery synchronously. Its promise still drains the job,
      // but the owner can turn other agents off while that work finishes.
      this.#backgroundWork(this.#earn.stop(agentId).then(() => this.#resumeEarning(agentId)));
    }
    // A service follows the switch, while Off remains responsive to the owner.
    if (!enabled) this.#backgroundWork(this.#advanceOffer(agentId).then(() => {
      this.#emit({ type: "overview" });
    }));
    this.#emit({ type: "overview" });
    return this.#oneAgentView(agentId);
  }

  /** A stopped agent takes no jobs and offers nothing, ever. */
  #refuseIfRetired(agent: AgentRecord): void {
    if (agent.earn.retiredAt != null || this.#retiring.has(agent.id)) {
      throw new WalletError("NOT_ALLOWED", `${agent.name} stopped earning for good.`);
    }
  }

  /**
   * Why the agent cannot stop earning for good right now, in plain words, or
   * null when nothing the wallet knows of stands in the way. `facts` is its
   * record on the marketplace. Jobs it still holds are judged only when
   * `jobs` is true: after its own jobs were brought up to date, which may
   * have paid a delivery whose buyer went quiet or let go of a lapsed hold.
   * Judged before that, a refusal could never clear while earning is off.
   */
  #retireRefusal(agent: AgentRecord, facts: RegistrationFacts, jobs: boolean): string | null {
    if (agent.earn.enabled) {
      const onOffer = agentOffers(agent).find((offer) => offer.wanted);
      return onOffer !== undefined
        ? `${agent.name} still offers “${onOffer.name}”. Switch off Earns first.`
        : `${agent.name} is still taking jobs. Switch off Earns first.`;
    }
    if (facts.suspended) {
      return `The marketplace has suspended ${agent.name}, so its deposit cannot come back for now.`;
    }
    if (facts.disputes > 0) {
      return `A job ${agent.name} did is in a dispute on the marketplace. Try again once that is settled.`;
    }
    if (jobs && facts.activeTasks > 0) {
      const jobs = this.#earn.jobs(agent.id);
      if (jobs.some((job) => job.state === "working")) {
        // With Earns off its loop is not running, so the job goes on only with it.
        return `${agent.name} has a job it has not finished. Switch on Earns until it is paid, then switch it off and try again.`;
      }
      if (jobs.some((job) => job.state === "delivered")) {
        return `${agent.name} is waiting to be paid for a job. Try again once it is paid.`;
      }
      return `${agent.name} still holds a job it gave up. Try again once that job's time runs out.`;
    }
    return null;
  }

  /**
   * Stop an agent earning for good. Owner only. Refused, with a sentence
   * that says why, while it still takes jobs (Earns on, a service on offer),
   * has a job that is not finished or holds one. Otherwise its own jobs are
   * brought up to date, every service it has on the marketplace is taken off
   * for good, and then the agent is retired there, which brings its deposit
   * for taking jobs back to its own wallet. A hire of it that nobody started
   * stops it just before that, since the buyer would wait for nothing.
   */
  async retireAgent(agentId: string): Promise<AgentView> {
    const first = this.#agentRecord(agentId);
    if (first.earn.retiredAt != null) return this.#oneAgentView(agentId);
    if (this.#retiring.has(agentId)) {
      throw new WalletError("BUSY", `${first.name} is already stopping.`);
    }
    this.#retiring.add(agentId);
    try {
      // Not alongside a step that puts one of its services on offer.
      await this.#lock(`offer:${agentId}`, () => this.#retire(agentId));
    } finally {
      this.#retiring.delete(agentId);
    }
    this.#dropBalances();
    this.#emit({ type: "overview" });
    this.#emit({ type: "activity" });
    return this.#oneAgentView(agentId);
  }

  async #retire(agentId: string): Promise<void> {
    const agent = this.#agentRecord(agentId);
    this.#checkPendingFunding(agentId);
    if (agent.earn.enabled) {
      throw new WalletError(
        "NOT_ALLOWED",
        this.#retireRefusal(agent, { stake: 0n, activeTasks: 0, disputes: 0, retired: false, suspended: false }, true)!,
      );
    }
    const providerAgent = await this.#earn.marketplaceAgent(agentId);
    const found =
      providerAgent === null ? null : await unreachable(() => readAgent(this.#chain, providerAgent));
    if (providerAgent === null || found === null) {
      throw new WalletError(
        "NOT_ALLOWED",
        `${agent.name} has never taken jobs, so it has no deposit to get back.`,
      );
    }
    if (isRetiredAgent(found)) {
      // Retired already (the wallet stopped right after it last time).
      this.#markRetired(agentId, null, null);
      return;
    }
    // Nothing is sent for an agent the marketplace would refuse anyway.
    const first = this.#retireRefusal(agent, registrationFacts(found), false);
    if (first !== null) throw new WalletError("NOT_ALLOWED", first);
    // Earning is off, so its loop is stopped or finishing a job; let it end,
    // then bring its own jobs up to date: what was paid meanwhile, a buyer
    // who let the review time pass, a job it gave up whose time is over.
    await this.#earn.stop(agentId);
    const signer = await this.#vault.signer(agent.keyId);
    await this.#earn.tidyUp({ agentId, signer, minRewardLamports: 0n });
    const now = await unreachable(() => readAgent(this.#chain, providerAgent));
    if (now === null) {
      throw new WalletError("NETWORK", "Market could not reach the marketplace right now. Try again in a moment.");
    }
    const refusal = this.#retireRefusal(this.#agentRecord(agentId), registrationFacts(now), true);
    if (refusal !== null) throw new WalletError("NOT_ALLOWED", refusal);

    // Every listing it has counts, the ones this wallet replaced too.
    const listings = new Map<Address, number>();
    await unreachable(async () => {
      for (const offer of agentOffers(agent)) {
        if (offer.listing === null) continue;
        const account = await readListing(this.#chain, offer.listing as Address);
        if (account !== null) listings.set(offer.listing as Address, Number(account.state));
      }
      for (const entry of await listingsOf(this.#chain, providerAgent)) {
        listings.set(entry.address, Number(entry.listing.state));
      }
    });
    // One still on offer (taking it off had failed) is taken off first, which
    // can be undone: from then on nobody can hire the agent.
    const onOffer = [...listings].filter(([, state]) => state === LISTING_STATE_ACTIVE).map(([listing]) => listing);
    if (onOffer.length > 0) {
      const paused = await unreachable(() => sendListingStates(this.#chain, signer, providerAgent, onOffer, "Paused"));
      this.#patchListingSignatures(agentId, paused);
      for (const listing of onOffer) listings.set(listing, LISTING_STATE_PAUSED);
    }
    // A hire made before that and not started yet: only this agent may do
    // it, so the buyer would wait out the whole time to deliver for nothing.
    // Nothing for good has happened yet; with Earns on again it gets done.
    const waiting = await unreachable(() => waitingHires(this.#chain, providerAgent));
    if (waiting.length > 0) {
      this.#owed.set(agentId, new Map(waiting.map((hire) => [hire.task, hire.rewardLamports])));
      throw new WalletError(
        "NOT_ALLOWED",
        `Someone hired ${agent.name} and is waiting for the work. Switch on Earns until it is done and paid, then switch it off and try again.`,
      );
    }

    // Its services off the marketplace for good, then the agent.
    const toRetire = [...listings].filter(([, state]) => state !== LISTING_STATE_RETIRED).map(([listing]) => listing);
    const sent = await unreachable(() => sendListingStates(this.#chain, signer, providerAgent, toRetire, "Retired"));
    this.#patchListingSignatures(agentId, sent);

    const before = await unreachable(() => this.#chain.readRawAccount(providerAgent));
    const signature = await unreachable(() => sendRetireAgent(this.#chain, signer, providerAgent));
    const after = await this.#chain.readRawAccount(providerAgent).catch(() => null);
    const returned =
      before !== null && after !== null && before.lamports > after.lamports
        ? before.lamports - after.lamports
        : found.stake;
    this.#markRetired(agentId, signature, returned);
  }

  #patchListingSignatures(agentId: string, sent: ReadonlyMap<Address, string>): void {
    this.#store.update((draft) => {
      const owner = draft.agents[agentId];
      if (owner === undefined) return;
      for (const offer of agentOffers(owner)) {
        const signature = offer.listing === null ? undefined : sent.get(offer.listing as Address);
        if (signature !== undefined) offer.signatures.state = signature;
      }
    });
  }

  /**
   * The marketplace says the agent is retired but this wallet's records do
   * not (a journal restored from before, or a retirement whose answer was
   * lost): record it, and stop anything still running for it.
   */
  #noticeRetired(agentId: string, account: AgentRegistration): boolean {
    const agent = this.#store.state.agents[agentId];
    if (agent === undefined || !isRetiredAgent(account)) return false;
    if (agent.earn.retiredAt == null) this.#markRetired(agentId, null, null);
    return true;
  }

  /** Record that the agent was retired on the marketplace. */
  #markRetired(agentId: string, signature: string | null, returned: bigint | null): void {
    this.#store.update((draft) => {
      const agent = draft.agents[agentId];
      if (agent === undefined) return;
      agent.earn.enabled = false;
      agent.earn.lastError = null;
      agent.earn.retiredAt = this.#now();
      for (const offer of agentOffers(agent)) {
        offer.wanted = false;
        offer.status = "paused";
        offer.error = null;
      }
      // Retiring always returns the deposit; the amount is known when this wallet saw it happen.
      this.#note(draft, {
        kind: "returned",
        text: `${agent.name} stopped earning for good. Its deposit came back to its own money.`,
        lamports: returned,
        agentId,
        ...(signature === null ? {} : { signature }),
      });
    });
    // Whatever may still run for it ends (a switch that raced this one).
    void this.#earn.stop(agentId);
    this.#owed.delete(agentId);
    this.#emit({ type: "overview" });
  }

  // -------------------------------------------------------------- offer

  #patchOffer(agentId: string, offerId: string, patch: (offer: OfferRecord) => void): void {
    this.#store.update((draft) => {
      const agent = draft.agents[agentId];
      const offer = agent === undefined ? undefined : agentOffers(agent).find((entry) => entry.id === offerId);
      if (offer) patch(offer);
    });
  }

  /**
   * Offer a service others can hire, done by this agent while it takes jobs.
   * An agent can offer several. `offerId` names one of them: then `input`
   * changes its price or description and `null` takes it off offer. Without
   * `offerId` a new service is offered, unless the agent already has one by
   * that name, which is then changed (or offered again, if it was taken off).
   * Owner only.
   */
  async setOffer(
    agentId: string,
    input: SellerOfferInput | null,
    offerId?: string,
    fundingQuoteId?: string,
  ): Promise<AgentView> {
    const apply = () => this.#setOffer(agentId, input, offerId, fundingQuoteId);
    return this.#lock(`seller-confirm:${agentId}`, apply);
  }

  async #setOffer(agentId: string, input: SellerOfferInput | null, offerId?: string, fundingQuoteId?: string): Promise<AgentView> {
    const agent = this.#agentRecord(agentId);
    if (input !== null) {
      this.#refuseIfRetired(agent);
      this.#checkPendingFunding(agentId);
    }
    const offers = agentOffers(agent);
    if (input === null) {
      if (fundingQuoteId !== undefined) throw new WalletError("BAD_REQUEST", "Taking a service off offer does not use a funding quote.");
      const wanted = offers.filter((offer) => offer.wanted);
      const target =
        offerId !== undefined
          ? offers.find((offer) => offer.id === offerId)
          : wanted.length === 1
            ? wanted[0]
            : undefined;
      this.#checkPendingFunding(agentId, { offerId: target?.id ?? offerId });
      if (offerId !== undefined && target === undefined) {
        throw new WalletError("NOT_FOUND", "That service does not exist.");
      }
      if (target === undefined && wanted.length > 1) {
        throw new WalletError("BAD_REQUEST", "Say which service to take off offer.");
      }
      if (target !== undefined && target.wanted) {
        this.#patchOffer(agentId, target.id, (offer) => {
          clearOfferFundingWait(offer);
          offer.wanted = false;
          delete offer.reconciledForLive;
          offer.error = null;
        });
        await this.#advanceOffer(agentId);
        this.#emit({ type: "overview" });
      }
      return this.#oneAgentView(agentId);
    }
    if (typeof input !== "object") {
      throw new WalletError("BAD_REQUEST", "That service is not valid.");
    }
    if (!this.#earn.available) {
      throw new WalletError("NOT_AVAILABLE", "This computer is not set up to do jobs yet.");
    }
    if (input.enableEarns && !fundingQuoteId) throw new WalletError("APPROVAL_REQUIRED", "Approve the service setup quote in Market.");
    checkOfferDelivery(input.deliverySecs);
    const name = tidyText(input.name, 60);
    if (name === null) throw new WalletError("BAD_REQUEST", "Give the service a name.");
    if (Buffer.byteLength(name, "utf8") > LISTING_NAME_MAX_BYTES) {
      throw new WalletError(
        "BAD_REQUEST",
        `Use a shorter name: up to ${LISTING_NAME_MAX_BYTES} letters.`,
      );
    }
    const summary = tidyText(input.summary, 280);
    if (summary === null) {
      throw new WalletError("BAD_REQUEST", "Say what the buyer gets, in a sentence.");
    }
    let current: OfferRecord | null;
    if (offerId !== undefined) {
      current = offers.find((offer) => offer.id === offerId) ?? null;
      if (current === null) throw new WalletError("NOT_FOUND", "That service does not exist.");
      if (current.listed && current.name !== name) {
        throw new WalletError(
          "BAD_REQUEST",
          "A service's name cannot be changed once it exists. Its price and description can.",
        );
      }
      if (offers.some((offer) => offer.id !== offerId && offer.wanted && offer.name === name)) {
        throw new WalletError("BAD_REQUEST", "This agent already offers a service by that name.");
      }
    } else {
      // The same name is the same service: change it, or offer it again.
      current = offers.find((offer) => offer.name === name) ?? null;
      if (current === null && offers.filter((offer) => offer.wanted).length >= MAX_OFFERS_PER_AGENT) {
        throw new WalletError(
          "BAD_REQUEST",
          `An agent can offer up to ${MAX_OFFERS_PER_AGENT} services. Take one off offer first.`,
        );
      }
    }
    const priceLamports = await this.#offerLamports(input.price);
    this.#checkOfferPrice(priceLamports);
    const terms = resolveTerms(input.deliverySecs === undefined ? input.terms : { ...input.terms, deliverySecs: input.deliverySecs }, current);
    if (!fundingQuoteId) {
      if (terms.servicePin || terms.modelCapCents || terms.minimumMarginCents || terms.childPolicy)
        throw new WalletError("APPROVAL_REQUIRED", "Review the rehearsed service and spending limits in Market.");
      await this.#serviceAdmission(agentId, priceLamports, terms);
    }
    const category = terms.category;
    const spec = sellerListingSpec({ name, summary, ...terms }, agent.address);
    const hash = await jobSpecHash(spec);
    const price = priceLamports.toString();
    const id = current?.id ?? values.bytesToHex(values.randomId32());
    const previous = current;
    const sameWords = previous !== null && previous.specHashHex === hash.hex;
    const sameTerms = previous !== null && JSON.stringify(storedTerms(previous)) === JSON.stringify(terms);
    if (!fundingQuoteId && (terms.operator !== (previous?.terms?.operator ?? null) ||
      terms.operatorFeeBps !== (previous?.terms?.operatorFeeBps ?? 0))) {
      throw new WalletError("APPROVAL_REQUIRED", "Review a funding quote before changing the operator or share.");
    }
    const next: OfferRecord = {
      id,
      listingIdHex: previous?.listingIdHex ?? values.bytesToHex(values.randomId32()),
      listing: previous?.listing ?? null,
      listed: previous?.listed ?? false,
      name,
      summary,
      category,
      priceLamports: price,
      deliverySecs: previous?.deliverySecs ?? terms.deliverySecs,
      ...((input.deliverySecs !== undefined || input.terms?.deliverySecs !== undefined) && { pendingDeliverySecs: terms.deliverySecs }),
      terms,
      spec,
      specHashHex: hash.hex,
      specUri: sameWords ? (previous.specUri ?? null) : null,
      wanted: true,
      status:
        previous !== null && previous.status === "live" && previous.wanted && sameTerms && sameWords && previous.priceLamports === price
          ? "live"
          : "getting_ready",
      error: null,
      // A changed description is checked straight away; the same words are
      // not asked about again sooner than before.
      lastCheckAt: sameWords ? previous.lastCheckAt : null,
      refused: sameWords ? previous.refused : null,
      signatures: previous?.signatures ?? {},
    };
    if (fundingQuoteId !== undefined) {
      const action = this.#quotedOfferKey(offerId, name, summary, priceLamports, terms, input.enableEarns, input.setupId);
      const decision = await this.#consumeFunding(fundingQuoteId, { agentId, action, effect: { offer: next, ...(input.setupId && { setupId: input.setupId }), ...(input.enableEarns && { enableEarns: true }) } });
      if (decision.replayed) return this.#oneAgentView(agentId);
    } else {
      if (previous?.status === "awaiting_approval" && sameTerms && sameWords && previous.priceLamports === price)
        return this.#oneAgentView(agentId);
      this.#store.update((draft) => saveSellerOffer(draft.agents[agentId]!, next));
    }
    await this.#continueSellerAction(agentId, fundingQuoteId, async () => {
      if (input.enableEarns) await this.#startEarning(this.#agentRecord(agentId));
      await this.#advanceOffer(agentId);
    });
    this.#emit({ type: "overview" });
    return this.#oneAgentView(agentId);
  }

  /**
   * Where this service's description is published, publishing it first when
   * that has not happened for these exact words. Null when the network has
   * nowhere to publish it.
   */
  async #publishedOffer(agent: AgentRecord, offer: OfferRecord): Promise<string | null> {
    const known = offer.specUri ?? null;
    if (known !== null) return known;
    const uri = await this.#services.publishListing({
      spec: offer.spec,
      specHashHex: offer.specHashHex,
      signer: await this.#vault.signer(agent.keyId),
    });
    if (uri !== null) {
      this.#patchOffer(agent.id, offer.id, (entry) => {
        if (entry.specHashHex === offer.specHashHex) entry.specUri = uri;
      });
    }
    return uri;
  }

  #withListingTransport<T>(agentId: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return inTransportScope({
      signal,
      ...(this.#config.listingTimeoutMs !== undefined && { timeoutMs: this.#config.listingTimeoutMs }),
      sending: (receipt) => this.#store.update((draft) => {
        const agent = draft.agents[agentId]!;
        const op = receipt.operation;
        // Readiness or owner intent can change during signing or blockhash lookup.
        const opening = op?.kind === "create" ? [op.listing] : op?.kind === "state" && op.state === "Active" ? op.listings : [];
        for (const listing of opening) {
          const offer = agentOffers(agent).find((entry) => entry.listing === listing);
          if (!offer || !this.#wantsLive(agent, offer)) throw new Error("The service is no longer ready to take jobs.");
        }
        const pending = agent.earn.pendingListingSends ??= [];
        if (pending.some((entry) => entry.signature === receipt.signature)) return;
        if (op?.kind === "funding" && op.decision) {
          if (this.#now() >= op.decision.expiresAt) throw new WalletError("PRICE_CHANGED", "The funding quote expired before signing finished.");
          if (op.charge) this.#reserveCharge(agent, op.charge);
        }
        pending.push(receipt);
      }),
      confirmed: (signature, operation) => this.#finishListingSend(agentId, signature, true, operation),
    }, work);
  }

  async #reconcileListingSends(agentId: string): Promise<Set<string> | null> {
    const pendingOffers = new Set<string>();
    // A cancelled HTTP request may already have broadcast. Never admit
    // jobs or send a conflicting listing change while it can still land.
    for (const receipt of this.#store.state.agents[agentId]!.earn.pendingListingSends ?? []) {
      const offerId = fundedOfferId(receipt.operation);
      let outcome = await this.#chain.listingSendOutcome?.(receipt).catch((error) => {
        if (offerId === undefined) throw error;
        this.#log(`funding ${offerId}: ${describeError(error)}`);
        return "pending" as const;
      });
      // Older adapters know only that a send is terminal. That suffices
      // for legacy receipts, whose listing state is read back below.
      if (!outcome && !receipt.operation && await this.#chain.listingSendSettled?.(receipt)) outcome = "failed";
      if (!outcome || outcome === "pending") {
        if (offerId === undefined) return null;
        pendingOffers.add(offerId);
        continue;
      }
      this.#finishListingSend(agentId, receipt.signature, outcome === "landed");
      if (outcome === "landed") {
        this.#dropBalances();
        this.#emit({ type: "overview" });
        if (receipt.operation?.kind === "funding" || receipt.operation?.kind === "create") this.#emit({ type: "activity" });
      }
    }
    return pendingOffers;
  }

  /**
   * Bring what is on the marketplace in line with what the person wants on
   * offer. Each step reads the chain first and sends at most one transaction,
   * so it can be repeated or interrupted anywhere. Never throws.
   */
  #advanceOffer(agentId: string, shutdown = false): Promise<boolean> {
    if (this.#closed && !shutdown) return Promise.resolve(false);
    // One agent's services one after another: they share its wallet.
    return this.#lock(`offer:${agentId}`, async () => {
      if (this.#closed && !shutdown) return false;
      const signal = shutdown ? new AbortController().signal : this.#listingAbort.signal;
      this.#store.update((draft) => { draft.agents[agentId]!.earn.listingReconciliationRequired = true; });
      try {
        return await this.#withListingTransport(agentId, signal, async () => {
          const pendingOffers = await this.#reconcileListingSends(agentId);
          if (pendingOffers === null) return false;
          // Only an additional uncertain send needs to interrupt this pass.
          const interrupted = () => shutdown || signal.aborted || this.#agentRecord(agentId).earn.pendingListingSends?.some(
            ({ operation }) => !pendingOffers.has(fundedOfferId(operation) ?? ""),
          );
          const agent = this.#agentRecord(agentId);
          const remaining = agentOffers(agent).filter((offer) =>
            !pendingOffers.has(offer.id) && this.#offerNeedsStep(agent, offer));
          try {
            await this.#offerStatesTogether(agentId, remaining);
          } catch (error) {
            if (interrupted()) throw error;
            // Batching saves a fee. Individual steps can still make progress.
            this.#log(`offer batch ${agentId}: ${describeError(error)}`);
          }
          for (const offer of remaining) {
            const wantLive = this.#wantsLive(this.#agentRecord(agentId), offer);
            try {
              let again = true;
              for (let step = 0; again && step < OFFER_STEPS_PER_PASS; step++) {
                signal.throwIfAborted();
                again = await this.#offerStep(agentId, offer.id);
              }
              signal.throwIfAborted();
              if (!again) {
                this.#patchOffer(agentId, offer.id, (entry) => {
                  if (entry.wanted === offer.wanted && entry.priceLamports === offer.priceLamports &&
                      entry.specHashHex === offer.specHashHex && sameOfferTerms(entry, offer)) entry.reconciledForLive = wantLive;
                });
              }
            } catch (error) {
              if (interrupted()) throw error;
              this.#offerFailed(agentId, offer, error);
            }
          }
          signal.throwIfAborted();
          if (pendingOffers.size > 0) return false;
          const current = this.#agentRecord(agentId);
          if (agentOffers(current).some((offer) => this.#offerNeedsStep(current, offer))) return false;
          this.#store.update((draft) => {
            const record = draft.agents[agentId]!;
            record.earn.listingReconciliationRequired = false;
            for (const offer of agentOffers(record)) delete offer.reconciledForLive;
          });
          this.#earn.listingsReconciled(agentId);
          return true;
        });
      } catch (error) {
        this.#log(`offer ${agentId}: ${describeError(error)}`);
        return false;
      }
    });
  }

  /** A failed step: say so when a person has to act, otherwise try again later. */
  #offerFailed(agentId: string, attempted: OfferRecord, error: unknown): void {
    this.#log(`offer ${agentId}: ${describeError(error)}`);
    const text = error instanceof Error ? error.message : String(error);
    let message: string | null = null;
    if (
      error instanceof WalletError &&
      (error.code === "NOT_ALLOWED" || error.code === "NOT_ENOUGH_MONEY" || error.code === "BAD_REQUEST" || error.code === "APPROVAL_REQUIRED")
    ) {
      message = error.message;
    } else if (/insufficient (funds|lamports)|InsufficientFunds/i.test(text)) {
      message = "This agent's wallet does not hold enough to put the service on offer.";
    }
    if (message === null) return;
    const sentence = message;
    this.#patchOffer(agentId, attempted.id, (offer) => {
      if (offer.status === "awaiting_approval") return;
      if (error instanceof WalletError && error.code === "APPROVAL_REQUIRED") {
        // The owner may have edited or withdrawn the offer while funding was being checked.
        if (
          !this.#agentRecord(agentId).earn.enabled || !offer.wanted ||
          offer.specHashHex !== attempted.specHashHex || offer.priceLamports !== attempted.priceLamports || !sameOfferTerms(offer, attempted)
        ) return;
        offer.status = "awaiting_approval";
        offer.lastCheckAt = null;
      } else {
        offer.status = "problem";
      }
      offer.error = sentence;
    });
    this.#emit({ type: "overview" });
  }

  /**
   * On offer only while someone is here to do the work: wanted, taking jobs
   * switched on, a host that can run jobs at all, and not closing.
   */
  #wantsLive(agent: AgentRecord, offer: OfferRecord): boolean {
    return (
      offer.wanted &&
      BigInt(offer.priceLamports) <= maximumOfferPrice(this.#config.earn ?? { executor: null }) &&
      agent.earn.enabled &&
      !this.#closing &&
      this.#earn.canTakeJobs(agent.id)
    );
  }

  #offerNeedsStep(agent: AgentRecord, offer: OfferRecord): boolean {
    const wantLive = this.#wantsLive(agent, offer);
    // A listed service must still pause when discovery stops or the wallet closes.
    if (offer.status === "awaiting_approval" && (wantLive || !offer.listed)) return false;
    return offer.reconciledForLive !== wantLive;
  }

  /**
   * Several of an agent's services going off offer, or back on as they
   * were, go in one transaction: one fee for all of them instead of one
   * each. What is left (one service, a new listing, new words or price, the
   * safety check) is done by the steps one at a time.
   */
  async #offerStatesTogether(agentId: string, remaining: OfferRecord[]): Promise<void> {
    const agent = this.#store.state.agents[agentId];
    if (agent === undefined) return;
    const offers = remaining.filter((offer) =>
      offer.status !== "awaiting_approval" && offer.listed && offer.listing !== null &&
      (this.#wantsLive(agent, offer) || offer.status !== "paused"));
    if (offers.length < 2) return;
    const providerAgent = await this.#earn.marketplaceAgent(agentId);
    if (providerAgent === null || (await readAgent(this.#chain, providerAgent)) === null) return;
    const pause: Address[] = [];
    const resume: Address[] = [];
    for (const offer of offers) {
      const listing = offer.listing as Address;
      const account = await readListing(this.#chain, listing);
      if (account === null) continue;
      const state = Number(account.state);
      const wantLive = this.#wantsLive(agent, offer);
      if (!wantLive && state === LISTING_STATE_ACTIVE) pause.push(listing);
      if (
        wantLive &&
        state === LISTING_STATE_PAUSED &&
        // Back exactly as it was: same price, same words, where they are.
        sameChainTerms(account, storedTerms(offer)) &&
        account.price === BigInt(offer.priceLamports) &&
        (offer.pendingDeliverySecs === undefined || account.defaultDeadlineSecs === BigInt(offer.pendingDeliverySecs)) &&
        values.bytesToHex(new Uint8Array(account.specHash)) === offer.specHashHex &&
        (offer.specUri ?? null) !== null &&
        account.specUri === offer.specUri
      ) {
        resume.push(listing);
      }
    }
    for (const [found, state] of [
      [pause, "Paused"],
      [resume, "Active"],
    ] as const) {
      // The reads above took a while: only what is still wanted that way goes.
      if (found.length < 2) continue;
      if (state === "Active") await listingRequest(() => this.#earn.checkListingReady(agentId, transportSignal()));
      const now = this.#agentRecord(agentId);
      const listings = found.filter((listing) => {
        const offer = agentOffers(now).find((entry) => entry.listing === listing);
        return offer !== undefined && this.#wantsLive(now, offer) === (state === "Active");
      });
      if (listings.length < 2) continue;
      await sendListingStates(
        this.#chain,
        await this.#vault.signer(agent.keyId),
        providerAgent,
        listings,
        state,
      );
      if (state === "Active") this.#earn.listingsReconciled(agentId);
      this.#dropBalances();
    }
  }

  /** One step. Returns true when it changed something and another look is worth it. */
  async #offerStep(agentId: string, offerId: string): Promise<boolean> {
    const agent = this.#store.state.agents[agentId];
    const offer = agent === undefined ? null : (agentOffers(agent).find((entry) => entry.id === offerId) ?? null);
    if (agent === undefined || offer === null || !this.#offerNeedsStep(agent, offer)) return false;
    const wantLive = this.#wantsLive(agent, offer);
    const settle = (status: OfferRecord["status"], error: string | null = null): false => {
      if (offer.status !== "awaiting_approval" && (offer.status !== status || offer.error !== error || (status === "live" && offer.fundingConfirmed))) {
        this.#patchOffer(agentId, offerId, (entry) => {
          entry.status = status;
          if (status === "live") delete entry.fundingConfirmed;
          entry.error = error;
        });
        this.#emit({ type: "overview" });
      }
      return false;
    };

    // The worker registers the agent on the marketplace on its first pass.
    // Nothing can be listed before that, and nothing is on offer either.
    const providerAgent = await this.#earn.marketplaceAgent(agentId);
    const registration = providerAgent === null ? null : await readAgent(this.#chain, providerAgent);
    if (providerAgent === null || registration === null) {
      return settle(wantLive ? "getting_ready" : "paused");
    }
    // Retired there for good, whatever these records said.
    if (this.#noticeRetired(agentId, registration)) return settle("paused");
    if (wantLive && offer.terms?.servicePin) {
      const required = BigInt(offer.terms.servicePin.capabilities);
      readServiceRehearsal(this.#earn.stateDir(agentId), offer.terms.servicePin);
      if ((registration.capabilities & required) !== required) {
        if (!offer.fundingConfirmed) return settle("problem", "Review a new service quote to update this agent's capabilities.");
        const signer = await this.#vault.signer(agent.keyId);
        await this.#chain.clientFor(signer).send([facade.updateAgent({ agent: providerAgent, authority: signer,
          capabilities: registration.capabilities | required })], { maxRetries: 0 });
        const landed = await readAgent(this.#chain, providerAgent);
        if (!landed || (landed.capabilities & required) !== required) throw new Error("The capability update has not been verified.");
        this.#earn.capabilitiesChanged(agentId);
      }
    }
    const listingId = values.hexToBytes(offer.listingIdHex);
    const listing = await listingAddressFor(providerAgent, listingId);
    const account = await readListing(this.#chain, listing);

    if (account === null) {
      if (offer.listing !== listing) {
        this.#patchOffer(agentId, offerId, (entry) => {
          entry.listing = listing;
        });
      }
      if (!wantLive) return settle("paused");
      const specUri = await this.#publishedOffer(agent, offer);
      if (specUri === null) {
        return settle("problem", "This network has nowhere to publish a service's description yet.");
      }
      await this.#fundEarning(agent, offer);
      const deposit = await this.#chain.getMinimumBalanceForRentExemption(LISTING_ACCOUNT_SPACE);
      const latest = this.#agentRecord(agentId);
      const wanted = agentOffers(latest).find((item) => item.id === offerId);
      if (!wanted || !this.#wantsLive(latest, wanted)) return settle("paused");
      await withListingOperation({ kind: "create", listing, name: offer.name, lamports: deposit.toString() },
        async () => sendCreateListing(this.#chain, await this.#vault.signer(agent.keyId), {
          providerAgent, listingId, name: offer.name, category: offer.category,
          specHash: values.hexToBytes(offer.specHashHex), specUri,
          priceLamports: BigInt(offer.priceLamports), deliverySecs: offer.pendingDeliverySecs ?? offer.deliverySecs, terms: storedTerms(offer),
        }));
      this.#dropBalances();
      this.#emit({ type: "overview" });
      this.#emit({ type: "activity" });
      return true;
    }

    if (!offer.listed || offer.listing !== listing) {
      this.#patchOffer(agentId, offerId, (entry) => {
        entry.listing = listing;
        entry.listed = true;
      });
    }
    const landedPeriod = Number(account.defaultDeadlineSecs);
    if (offer.deliverySecs !== landedPeriod || offer.pendingDeliverySecs === landedPeriod) {
      this.#patchOffer(agentId, offerId, entry => {
        entry.deliverySecs = landedPeriod;
        if (entry.terms && entry.pendingDeliverySecs === undefined) entry.terms.deliverySecs = landedPeriod;
        if (entry.pendingDeliverySecs === landedPeriod) delete entry.pendingDeliverySecs;
      });
      this.#emit({ type: "overview" });
    }
    const state = Number(account.state);
    if (state !== LISTING_STATE_ACTIVE && state !== LISTING_STATE_PAUSED) {
      // Retired on the marketplace, which cannot be undone. An offer the
      // person still wants starts over as a new listing.
      if (!offer.wanted) return settle("paused");
      this.#patchOffer(agentId, offerId, (entry) => {
        entry.listingIdHex = values.bytesToHex(values.randomId32());
        entry.listing = null;
        entry.listed = false;
        entry.lastCheckAt = null;
        entry.signatures = {};
      });
      return true;
    }
    if (!wantLive) {
      if (state === LISTING_STATE_ACTIVE) {
        await sendListingState(
          this.#chain,
          await this.#vault.signer(agent.keyId),
          { listing, providerAgent, state: "Paused" },
        );
        this.#dropBalances();
      }
      return offer.wanted && BigInt(offer.priceLamports) > maximumOfferPrice(this.#config.earn ?? { executor: null })
        ? settle("problem", "This service is above the worker's reward limit. Lower its price to offer it again.")
        : settle("paused");
    }

    // Freeze admissions before trying a finite cap. The program refuses a cap
    // below outstanding hires, and another buyer must not extend that backlog.
    const terms = { ...storedTerms(offer), deliverySecs: offer.pendingDeliverySecs ?? landedPeriod };
    const reducingCapacity = reducesListingCapacity(account.maxOpenJobs, terms.maxOpenJobs);
    if (reducingCapacity && state === LISTING_STATE_ACTIVE) {
      await sendListingState(this.#chain, await this.#vault.signer(agent.keyId), {
        listing, providerAgent, state: "Paused",
      });
      this.#patchOffer(agentId, offerId, (entry) => { entry.status = "paused"; });
      this.#dropBalances();
      return true;
    }
    if (reducingCapacity && account.openJobs > terms.maxOpenJobs) {
      return settle("paused", "Existing hires must finish before this service can take new work.");
    }

    const priceChanged = account.price !== BigInt(offer.priceLamports);
    const wordsChanged = values.bytesToHex(new Uint8Array(account.specHash)) !== offer.specHashHex;
    // The listing has to point at where its description really is, or
    // neither the safety check nor a buyer can read it.
    const specUri = await this.#publishedOffer(agent, offer);
    if (specUri === null) {
      return settle("problem", "This network has nowhere to publish a service's description yet.");
    }
    const movedDescription = account.specUri !== specUri;
    if (priceChanged || wordsChanged || movedDescription || !sameChainTerms(account, terms)) {
      await this.#fundEarning(agent, offer);
      const spec =
        wordsChanged || movedDescription
          ? { hash: values.hexToBytes(offer.specHashHex), uri: specUri }
          : null;
      await sendUpdateListing(
        this.#chain,
        await this.#vault.signer(agent.keyId),
        { listing, providerAgent, priceLamports: BigInt(offer.priceLamports), spec, terms },
      );
      this.#dropBalances();
      return true;
    }
    if (state === LISTING_STATE_PAUSED) {
      await listingRequest(() => this.#earn.checkListingReady(agentId, transportSignal()));
      const current = this.#agentRecord(agentId);
      const latest = agentOffers(current).find((item) => item.id === offerId);
      if (!latest || !this.#wantsLive(current, latest)) return settle("paused");
      await sendListingState(
        this.#chain,
        await this.#vault.signer(agent.keyId),
        { listing, providerAgent, state: "Active" },
      );
      this.#earn.listingsReconciled(agentId);
      this.#dropBalances();
      return true;
    }

    // On the marketplace with the right price and words. Buyers can hire it
    // once it carries the safety check for exactly these words.
    const gate = await findListingGate(this.#chain, this.#services, {
      listing,
      specHash: new Uint8Array(account.specHash),
      providerAgent,
    });
    if (gate !== null) return settle("live");
    if (offer.refused !== null) return settle("problem", offer.refused);
    const now = this.#now();
    const paidAt = offer.approvalAttemptAt ?? null;
    if (
      (offer.lastCheckAt !== null && now - offer.lastCheckAt < OFFER_CHECK_RETRY_MS) ||
      // A payment for the check that was already sent may still be landing.
      (paidAt !== null && now - paidAt < APPROVAL_SETTLE_MS)
    ) {
      return settle("being_checked");
    }
    this.#patchOffer(agentId, offerId, (entry) => {
      entry.lastCheckAt = now;
      entry.status = "being_checked";
      entry.error = null;
    });
    this.#emit({ type: "overview" });
    // The agent pays for the check of its own description. Its wallet was
    // funded for that when the listing was made; top it up if that is gone.
    await this.#fundEarning(agent, offer);
    try {
      const payment = await this.#services.attestListing({
        listing,
        specHashHex: offer.specHashHex,
        spec: offer.spec,
        specUri,
        payer: agent.address as Address,
      });
      if (payment !== null) {
        await this.#payApproval(
          await this.#vault.signer(agent.keyId),
          payment,
          { kind: "listing", listing, hash: values.hexToBytes(offer.specHashHex) },
          () => {
            this.#patchOffer(agentId, offerId, (entry) => {
              entry.approvalAttemptAt = this.#now();
            });
          },
        );
      }
    } catch (error) {
      if (error instanceof WalletError && error.code === "NOT_ALLOWED") {
        const sentence = error.message;
        this.#patchOffer(agentId, offerId, (entry) => {
          entry.refused = sentence;
        });
      }
      throw error;
    }
    return true;
  }

  // ------------------------------------------------------------ janitor

  /** One housekeeping pass. The service calls this on a timer. */
  tick(): Promise<void> {
    if (this.#closed) return Promise.resolve();
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
          (job.phase === "done" && ((job.terms?.contest && !job.contestScanned) || !job.tidied || (!job.terms?.contest && job.outcome === "paid" && (!job.finalDeliveryChecked || !job.result?.verified))))),
    );
    await Promise.all(open.map((job) => this.#advance(job.id)));

    for (const agent of Object.values(this.#store.state.agents)) {
      if (agent.refills.some(entry => entry.work))
        await this.#reconcileWorkAllowance(agent.id).catch(error => this.#log(`worker allowance: ${describeError(error)}`));
      if (!agent.earn.enabled && agent.earn.retiredAt == null) {
        await this.#lock(`earn-start:${agent.id}`, () => this.#startDrain(agent));
        await this.#earn.tidyUp({
          agentId: agent.id,
          signer: await this.#vault.signer(agent.keyId),
          minRewardLamports: 0n,
        }).catch((error) => this.#log(`earn upkeep ${agent.id}: ${describeError(error)}`));
      }
    }
    await this.#watchFrozenWork().catch((error) => {
      this.#log(`turned-down work check: ${describeError(error)}`);
    });
    await this.#noticeDeposits().catch((error) => {
      this.#log(`deposit check: ${describeError(error)}`);
    });
    await this.#refill().catch((error) => {
      this.#log(`refill: ${describeError(error)}`);
    });
    for (const agent of Object.values(this.#store.state.agents)) {
      if (agent.earn.enabled && this.#earn.state(agent.id).state === "off") await this.#startEarning(agent);
      else if (agentOffers(agent).length > 0 || agent.earn.pendingListingSends?.length) await this.#advanceOffer(agent.id);
    }
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
      // Jobs that gave money back which is not counted in yet. A read soon
      // after may still show the balance from before, so only a look well
      // after counts it in, whatever it shows; until then a rise is theirs.
      const now = this.#now();
      const unsettled = Object.values(this.#store.state.jobs).filter(
        (job) => job.payer === "main" && job.balanceSettled === false,
      );
      const settling = unsettled
        .filter((job) => now - (job.returnedAt ?? 0) >= BALANCE_SETTLE_MS)
        .map((job) => job.id);
      const markSettled = (draft: WalletState): void => {
        for (const id of settling) {
          const entry = draft.jobs[id];
          if (entry !== undefined) entry.balanceSettled = true;
        }
      };
      if (balance === previous) {
        if (settling.length > 0) this.#store.update(markSettled);
        return;
      }
      // Purchases paid from the main balance move it too; only a rise that
      // no running job explains is reported as money added. A job that just
      // ended gave its price or deposits back, and that is no arrival either.
      const mainJobsMoving =
        unsettled.length > 0 ||
        Object.values(this.#store.state.jobs).some(
          (job) => job.payer === "main" && !(job.phase === "done" && job.tidied) && job.phase !== "failed" && job.phase !== "declined",
        );
      this.#store.update((draft) => {
        markSettled(draft);
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
    for (const agent of Object.values(this.#store.state.agents)) {
      const rule = agent.policy.refill;
      if (!rule.enabled || rule.topUpToCents <= 0 || rule.perDayCents <= 0) continue;
      const balance = await this.#chain.getBalance(agent.address as Address);
      const target = centsToLamports(rule.topUpToCents, rate);
      // Top up only once the wallet has fallen to half its target, so small
      // spends do not each cost a transfer.
      if (balance * 2n > target) continue;
      const allowance = this.#dailyRoom(agent, rate);
      const room = allowance > this.#chain.transferFeeLamports ? allowance - this.#chain.transferFeeLamports : 0n;
      const amount = target - balance < room ? target - balance : room;
      if (amount <= 0n) continue;
      try {
        await this.#mainToAgent(agent, amount, `Topped up ${agent.name}.`, {});
      } catch (error) {
        if (!(error instanceof WalletError)) throw error;
        continue;
      }
    }
  }

  /** Housekeeping every minute while busy, every five while idle. An explicit interval wins. */
  start(intervalMs?: number): void {
    if (this.#timer !== null || this.#closed) return;
    let lastTickAt = Date.now();
    void this.tick();
    this.#timer = setInterval(() => {
      const busy = Object.values(this.#store.state.jobs).some((job) =>
        ["cleared", "hiring", "hired", "active"].includes(job.phase) || (job.phase === "done" && !job.tidied),
      ) || Object.values(this.#store.state.agents).some((agent) =>
        this.#earn.state(agent.id).state === "working" ||
        agentOffers(agent).some((offer) => offer.status === "getting_ready" || offer.status === "being_checked"),
      );
      if (intervalMs === undefined && !busy && Date.now() - lastTickAt < 5 * 60_000) return;
      lastTickAt = Date.now();
      void this.tick();
    }, intervalMs ?? 60_000);
    this.#timer.unref?.();
  }

  /** Stop timers and earning loops and release the folder lock. */
  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#closing = true;
    this.#listingAbort.abort(new DOMException("Wallet closing", "AbortError"));
    this.#closePromise = this.#finishClose();
    return this.#closePromise;
  }

  async #finishClose(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#earn.stopAll();
    if (this.#ticking !== null) await this.#ticking.catch(() => undefined);
    // Cancellation reaches the transports first. Join their wallet continuations
    // before fencing the store; never release a live writer on a timeout race.
    while (this.#background.size > 0 || this.#locks.size > 0) {
      await Promise.allSettled([...this.#background, ...this.#locks.values()]);
    }
    const offering = Object.values(this.#store.state.agents).filter(
      (agent) => agentOffers(agent).some((offer) => offer.listed),
    );
    await Promise.all(offering.map((agent) => this.#advanceOffer(agent.id, true)));
    this.#store.close();
    this.#closing = false;
    this.#releaseLock();
  }
}

/** Status used by tests and hosts that inspect a record directly. */
export { jobStatus };

/** Why an earned job failed, in a few plain words. */
function earnFailureWords(failure: EarnedJob["failure"] & object): string {
  switch (failure.cause) {
    case "expired":
      return "the time to deliver ran out";
    case "released": return "the agent gave the job back";
    case "cancelled":
      return "the buyer cancelled it first";
    case "attempts":
      return failureWords(failure.reason);
  }
}

/** The status line of an earned job that was given up. */
function earnFailureSentence(failure: EarnedJob["failure"] & object): string {
  switch (failure.cause) {
    case "expired":
      return "Your agent ran out of time to deliver this job.";
    case "released": return "Your agent gave this job back.";
    case "cancelled":
      return "The buyer cancelled this job before your agent delivered it.";
    case "attempts":
      return failure.attempts > 1
        ? `Your agent stopped after ${failure.attempts} tries: ${failureWords(failure.reason)}.`
        : `Your agent could not do this job: ${failureWords(failure.reason)}.`;
  }
}
