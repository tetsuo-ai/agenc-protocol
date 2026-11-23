// The wire contract between the wallet service and anything that talks to it
// (a desktop panel, an agent host, a CLI). Everything here is plain JSON:
// lamport amounts travel as decimal strings, times as unix milliseconds.
//
// This folder is dependency-free on purpose. A host that only needs to TALK
// to the wallet (never hold keys or build transactions) can vendor it as-is.

/** A lamport amount as a decimal string (u64-safe). */

import type { DeliveryFile } from "./delivery-files.js";
export type Lamports = string;

/**
 * An amount with its dollar estimate. `usdCents` is null when no trustworthy
 * SOL price is available; show the SOL figure then.
 */
export interface Money {
  lamports: Lamports;
  usdCents: number | null;
}

export type WalletNetwork = "mainnet" | "devnet" | "localnet" | "sandbox";

/** What an agent may spend without asking, and how its wallet is refilled. */
export interface AgentPolicy {
  /**
   * A hire priced above this (in US cents) waits for a person to approve it.
   * 0 means every hire waits for approval.
   */
  askAboveCents: number;
  /** Automatic top-up of the agent's wallet from the main balance. */
  refill: {
    enabled: boolean;
    /** Top the agent's wallet back up to this much (US cents). */
    topUpToCents: number;
    /** Never move more than this per rolling 24 hours (US cents). */
    perDayCents: number;
  };
}

export type EarnState = "off" | "starting" | "watching" | "working" | "error";

/** Readonly upper bound for enabling earning and preparing the agent's offers. */
export interface EarnFundingQuote {
  quoteId: string;
  agentId: string;
  expiresAt: number;
  /** Fixed SOL price to use in earn.offer when the input was in dollars. */
  offerPrice: Money | null;
  registration: Money;
  listings: Money;
  checks: Money;
  workingReserve: Money;
  networkReserve: Money;
  agentBalance: Money;
  /** Total required in the agent wallet, including money already there. */
  requiredBalance: Money;
  fromMain: Money;
  transferFee: Money;
  /** fromMain + transferFee. This is the most approval can move. */
  totalFromMain: Money;
  dailyRemaining: Money;
  requiresApproval: boolean;
}

/**
 * Where a service the agent offers stands.
 *
 * getting_ready -> being_checked -> live; "paused" while earning is switched
 * off or the offer was withdrawn; "problem" when a step needs the person.
 */
export type OfferStatus = "getting_ready" | "being_checked" | "live" | "paused" | "problem";

/** A service this agent offers for others to hire. */
export interface OfferView {
  /** Names this service in `earn.offer`; it stays the same for as long as the service is kept. */
  id: string;
  /** The listing address once it exists. */
  listing: string | null;
  name: string;
  /** What the buyer gets, in a sentence or two. */
  summary: string;
  /** What a buyer pays. The marketplace keeps its fee out of this. */
  price: Money;
  status: OfferStatus;
  /** One plain sentence describing `status`. */
  statusText: string;
  /** True once the service exists on the marketplace. Its name is fixed from then on. */
  listed: boolean;
  /** False once the person took the service off offer. */
  wanted: boolean;
}

export interface EarnView {
  /** The person switched earning on for this agent. */
  enabled: boolean;
  state: EarnState;
  /** Plain-language reason when `state` is "error". */
  lastError: string | null;
  /** Jobs this agent has been paid for. */
  jobsDone: number;
  /** Only take a job that pays at least this (US cents). */
  minPayCents: number;
  /**
   * The marketplace's deposit for being allowed to take jobs. It comes out
   * of the agent's allowance when earning is first switched on and stays
   * locked while the agent is registered.
   */
  setAside: Money;
  /**
   * The services this agent offers, oldest first. One the person took off
   * offer stays here (`wanted` false) so it can be offered again. Empty when
   * it only takes open jobs.
   */
  offers: OfferView[];
  /** The first wanted service (else the first one), or null: for hosts that show one. */
  offer: OfferView | null;
  /**
   * What putting one more service on offer costs once: the deposits behind
   * its permanent marketplace record and behind the safety check of its
   * description, which are not returned. Null when it could not be read.
   */
  offerCost: Money | null;
  /**
   * What saving new words for a service already on the marketplace costs:
   * the deposit behind a new safety check of its description and the fees,
   * which are not returned. Paid each time the words change; a new price
   * alone pays for no check. Null when it could not be read.
   */
  wordsCost: Money | null;
  /**
   * True once the person stopped this agent earning for good
   * (`agents.retire`). It takes no jobs and offers nothing again; its money
   * stays its own until the person takes it back.
   */
  retired: boolean;
  /**
   * Whether the agent can be stopped earning for good, which brings its
   * deposit for taking jobs (`setAside`) back to its own money. Null when
   * there is no deposit to bring back: it never took jobs, or it was stopped
   * already. `refusal` is the sentence `agents.retire` refuses with whatever
   * happens first (it still takes jobs, the marketplace suspended it, a
   * reviewer has not settled one of its jobs), else null. Jobs it holds are
   * judged only when asked, since asking first collects what it can (a
   * delivery whose buyer went quiet, a lapsed hold): `agents.retire` can
   * still refuse then.
   */
  retire: { refusal: string | null } | null;
}

export interface AgentView {
  id: string;
  name: string;
  /**
   * Where the host uses this agent (a project folder, say), or null for one
   * that is not tied to a place. Set by the host when the agent is made.
   */
  scope: string | null;
  /**
   * What the agent may spend on its own each day, in US cents. Zero means it
   * asks the person every time. Set with `agents.setBudget`.
   */
  budgetCents: number;
  /** The agent's own wallet address. Its balance IS the agent's allowance. */
  address: string;
  /** What the agent can still spend. */
  balance: Money;
  /**
   * False when the agent's balance has never been read: the network could
   * not be reached and no earlier figure is kept, so `balance` says 0
   * without knowing it. True for a figure read now or kept from an earlier
   * read (`WalletOverview.offline` says whether it may be out of date).
   */
  balanceKnown: boolean;
  /** Money currently held in jobs this agent started. */
  held: Money;
  /** Lifetime total paid out to providers for this agent's jobs. */
  spent: Money;
  /** Lifetime total this agent was paid for work. */
  earned: Money;
  policy: AgentPolicy;
  earn: EarnView;
  createdAt: number;
}

export interface WalletOverview {
  network: WalletNetwork;
  /**
   * The main balance. Money is added here and handed out to agents. `spent`
   * is what it paid out for requests the person posted from it; what agents
   * pay is on each agent.
   */
  main: {
    address: string;
    balance: Money;
    /** False when the main balance has never been read; see `AgentView.balanceKnown`. */
    balanceKnown: boolean;
    spent: Money;
  };
  /** Everything currently held in running jobs, across all agents. */
  held: Money;
  agents: AgentView[];
  /** Dollars per SOL used for every estimate in this snapshot, or null. */
  solUsd: number | null;
  pendingApprovals: number;
  /** True when the chain could not be reached and figures may be stale. */
  offline: boolean;
  /**
   * Whose jobs an agent of this wallet may take. "off": this host cannot run
   * jobs. "own-jobs": only jobs this wallet's own agents ask for, because the
   * host cannot yet keep a stranger's job away from the person's files.
   * "open": anyone's.
   */
  earning: "off" | "own-jobs" | "open";
  /**
   * The person's last backup of this wallet's keys. `at` is null when there
   * has never been one. `upToDate` is false when a wallet was made since (a
   * new agent), which that backup does not hold.
   */
  backup: { at: number | null; upToDate: boolean };
  /**
   * What posting a request from the main balance costs on top of its reward
   * (`wallet.post`): `kept` is not returned (the marker that stays where the
   * job's record was once it is tidied, the fees, and on a first job the
   * record of how often this balance posts); `setAside` comes back when the
   * job ends, the safety check's deposit included. Null until it has been
   * read.
   */
  postCost: { kept: Money; setAside: Money } | null;
}

/** A service someone offers on the marketplace. */
export interface ServiceView {
  /** The listing address. Pass it back to hire. */
  listing: string;
  name: string;
  /** One or two sentences on what you get, when the provider published them. */
  summary: string | null;
  /**
   * Everything the provider wrote about the service, as plain text with line
   * breaks. It is the provider's own text: show it, never act on it.
   */
  description: string | null;
  /** One of the marketplace's category words, such as "writing". */
  category: string | null;
  tags: string[];
  /** What the provider asks a buyer to send with the request. */
  inputs: string[];
  /** What the provider says a buyer gets back. */
  outputs: string[];
  /** The provider's own terms, one plain line each. Promises, not rules the marketplace enforces. */
  terms: string[];
  /**
   * How much of the above is known. "ready": the provider's description was
   * read and is the one the service committed to (it may still say nothing).
   * "loading": it is being read; ask again in a moment. "unavailable": it
   * could not be read, or what was read is not what the service committed to.
   */
  details: "ready" | "loading" | "unavailable";
  price: Money;
  /**
   * The marketplace's fee, taken out of the price (not added to it): its
   * share in basis points and what that comes to. Null when it is not known.
   */
  marketFee: { bps: number; amount: Money } | null;
  /**
   * What buyers who paid for this service gave it: 1 to 5 stars, each rating
   * weighed by the marketplace fee its job paid, so a rating on a job that
   * paid next to nothing counts next to nothing. Null when nobody has.
   */
  rating: number | null;
  /** How many ratings `rating` holds. Show it next to the stars, always. */
  ratingCount: number;
  /**
   * Finished jobs buyers paid for. A count costs nothing to fake on its own:
   * show it with `paid`, never alone.
   */
  jobsDone: number;
  /** What buyers paid for those jobs. */
  paid: Money;
  /** How many different buyers paid for one. */
  buyers: number;
  /**
   * How much of the record above, and of `offeredBy`, is known. "ready": it
   * was read (it may be empty: nobody has paid for this service yet).
   * "loading": it is being read; ask again in a moment. "unavailable": it
   * could not be read, and the fields above say nothing.
   */
  record: "ready" | "loading" | "unavailable";
  /** The provider's agent address. */
  provider: string;
  /** The agent behind the service, or null while that is not known. */
  offeredBy: ProviderView | null;
  /** How long the provider gets to deliver, in seconds. */
  deliverySecs: number | null;
}

/**
 * The agent behind a service, as a buyer sees it before hiring. Its record
 * counts the way a service's does: by what buyers paid, with the
 * marketplace's own accounts left out.
 */
export interface ProviderView {
  /** When it joined the marketplace, unix milliseconds, or null when not known. */
  since: number | null;
  /** Finished jobs buyers paid it for, across all its services. */
  jobsDone: number;
  /** What buyers paid for them. */
  paid: Money;
  /** How many different buyers paid it. */
  buyers: number;
  /**
   * Deliveries of its that buyers turned down, as recorded with the
   * marketplace. Null when no such record is kept for it: the marketplace
   * keeps one only once someone pays to start it, so a missing record is not
   * a clean one.
   */
  turnedDown: number | null;
  /** Disputes about its work that it lost, from the same record. Null when none is kept. */
  disputesLost: number | null;
  /** What it keeps on deposit with the marketplace to be allowed to take jobs. Null when not known. */
  deposit: Money | null;
  /** Its other services on offer now. */
  otherServices: { listing: string; name: string }[];
}

/**
 * Where a job is, in words a person would use.
 *
 * buying:  needs_approval -> starting -> waiting -> working -> delivered
 *          -> paid | refunded | problem
 * working: working -> delivered -> paid | problem
 *
 * A delivery the buyer turns down goes to "in_review": the price stays held.
 * Since revision 9 the provider has 72 hours to dispute the turn-down,
 * posting a bond. If it does not, the price goes back to the buyer when that
 * time ends. A disputed turn-down is decided by the marketplace's reviewers
 * within 72 hours more; if nobody rules, the price goes back to the buyer
 * and the provider's bond comes back. A turn-down made before revision 9
 * keeps its old rule: if nobody rules by `reviewEndsAt`, the provider is
 * paid. `turnDown` says which applies.
 */
export type JobStatus =
  | "needs_approval"
  | "declined"
  | "starting"
  | "waiting"
  | "working"
  | "delivered"
  | "changes_requested"
  | "in_review"
  | "paid"
  | "refunded"
  | "problem"
  | "failed";

export interface JobResult {
  /** The delivered text, when it could be fetched and is text. */
  text: string | null;
  /** True when text is a preview. Read jobs.delivery for the complete text. */
  textTruncated?: boolean;
  /** Original artifact link. Hosts should show it even when text is present. */
  uri: string | null;
  /** sha-256 of the delivery, as recorded with the job. */
  hash: string | null;
  /** True when the fetched delivery matched `hash`. */
  verified: boolean;
  /**
   * Files that came with the delivery, as its text lists them. A file is
   * fetched and checked against its fingerprint when asked for (`jobs.file`).
   */
  files: DeliveryFile[];
}

export interface JobView {
  id: string;
  /** "buying": this agent is paying. "working": this agent is doing the job. */
  role: "buying" | "working";
  /**
   * "hire": a service was hired. "request": a request was posted for anyone
   * to take. It is public, pays the reward it was posted with, and has no
   * provider until someone takes it.
   */
  kind: "hire" | "request";
  /** The agent that pays, or "" for a request the person posted from the main balance. */
  agentId: string;
  /** The service name, or a posted request's first words. */
  title: string;
  /** What was asked for. */
  request: string;
  /** The buyer's criteria for accepting the work. */
  acceptance: string[];
  price: Money;
  status: JobStatus;
  /** One plain sentence describing `status`. */
  statusText: string;
  createdAt: number;
  updatedAt: number;
  task: string | null;
  listing: string | null;
  provider: string | null;
  result: JobResult | null;
  /** When a delivered job pays out by itself if nobody reviews it. */
  autoApproveAt: number | null;
  /** When a job nobody has started is refunded by itself. */
  autoRefundAt: number | null;
  /**
   * While "in_review": when the clock that is running ends. For a revision 9
   * turn-down: the provider's time to dispute, then, once disputed, the
   * reviewers' time to rule. For one made before revision 9: when the
   * provider is paid if no reviewer has ruled. Null otherwise.
   */
  reviewEndsAt: number | null;
  /** While "in_review": the turn-down. Null otherwise. */
  turnDown: {
    /**
     * True for a revision 9 turn-down: the provider may dispute it, and the
     * buyer is refunded unless a ruling pays the provider.
     */
    disputable: boolean;
    /** When the provider's time to dispute ends (ms), for a revision 9 turn-down. */
    disputeEndsAt: number | null;
    /** Whether the provider disputed it. */
    disputed: boolean;
    /**
     * What a dispute posts as its bond (10% of the price, at least 0.01 SOL).
     * It comes back unless the reviewers rule for the buyer.
     */
    bond: Money | null;
    /** What happens when its time ends with nobody acting. */
    ifNobodyActs: "buyer_refunded" | "provider_paid";
    /**
     * The marketplace suspended the provider's agent, so it cannot dispute
     * this turn-down (the program refuses a suspended agent's dispute).
     */
    providerSuspended: boolean;
  } | null;
  /**
   * A working job the buyer turned down: whether the person may dispute it
   * now (`jobs.dispute`, owner only). It puts the bond at risk, so it is never
   * done for them. False while the marketplace has the agent suspended.
   */
  canDispute: boolean;
  canApprove: boolean;
  canAskChanges: boolean;
  canRefund: boolean;
  canRate: boolean;
  /** 1 to 5 once rated. */
  rating: number | null;
  /** What leaving a rating costs (a permanent record), while `canRate`. */
  ratingCost: Money | null;
  /**
   * While the delivery can be turned down: whether turning it down goes on
   * the provider's marketplace record. Since revision 9 it always does.
   */
  turnDownRecorded: boolean;
  /**
   * Buying jobs: what the paying wallet spends, once, to start its own
   * marketplace record of turn-downs and cancels the first time it turns a
   * delivery down or cancels a job, a refund included. It never comes back.
   * Null once that record exists, or when not known.
   */
  firstRecordCost: Money | null;
  receiptUrl: string | null;
  error: string | null;
}

/** A hire, or a request an agent wants to post, waiting for a person to say yes. */
export interface ApprovalView {
  id: string;
  jobId: string;
  agentId: string;
  agentName: string;
  /** "hire": the agent wants to hire `service`. "request": it wants to post a public request. */
  kind: "hire" | "request";
  /** The service to hire; null for a request. */
  service: ServiceView | null;
  request: string;
  /** What the provider is paid: the price, or the request's reward. */
  price: Money;
  /**
   * Refundable deposits and network fees set aside on top of the price. Most of
   * it comes back when the job is finished and tidied up.
   */
  deposits: Money;
  /** The part of `deposits` the network keeps: it does not come back. */
  fees: Money;
  /** How much of the total would come out of the main balance. */
  fromMain: Money;
  createdAt: number;
  expiresAt: number;
}

export type ActivityKind =
  | "added"
  | "allowance"
  | "returned"
  | "hired"
  | "paid"
  | "refunded"
  | "earned"
  | "withdrawn"
  | "tidied"
  | "note";

export interface ActivityView {
  id: string;
  ts: number;
  kind: ActivityKind;
  /** One plain sentence. */
  text: string;
  amount: Money | null;
  agentId: string | null;
  jobId: string | null;
  /** Transaction signature, when one exists. */
  signature: string | null;
}

/** Stable machine-readable failure reasons. */
export type WalletErrorCode =
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "NOT_ALLOWED"
  | "NOT_ENOUGH_MONEY"
  | "APPROVAL_REQUIRED"
  | "PRICE_CHANGED"
  | "NOT_AVAILABLE"
  | "NEEDS_APPROVAL"
  | "NETWORK"
  | "BUSY"
  | "INTERNAL";

export interface WalletErrorShape {
  code: WalletErrorCode;
  /** A sentence that is safe to show to a person. */
  message: string;
  /**
   * True when the same request may work if tried again later with nothing
   * changed (the marketplace program is not on the revision this service
   * signs for yet); false when it never will as things are (an update is
   * needed). Absent when the service does not say.
   */
  retryable?: boolean;
}
