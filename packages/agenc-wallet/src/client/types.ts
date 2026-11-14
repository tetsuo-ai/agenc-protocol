// The wire contract between the wallet service and anything that talks to it
// (a desktop panel, an agent host, a CLI). Everything here is plain JSON:
// lamport amounts travel as decimal strings, times as unix milliseconds.
//
// This folder is dependency-free on purpose. A host that only needs to TALK
// to the wallet (never hold keys or build transactions) can vendor it as-is.

/** A lamport amount as a decimal string (u64-safe). */
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
}

export interface AgentView {
  id: string;
  name: string;
  /** The agent's own wallet address. Its balance IS the agent's allowance. */
  address: string;
  /** What the agent can still spend. */
  balance: Money;
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
  /** The main balance. Money is added here and handed out to agents. */
  main: { address: string; balance: Money };
  /** Everything currently held in running jobs, across all agents. */
  held: Money;
  agents: AgentView[];
  /** Dollars per SOL used for every estimate in this snapshot, or null. */
  solUsd: number | null;
  pendingApprovals: number;
  /** True when the chain could not be reached and figures may be stale. */
  offline: boolean;
}

/** A service someone offers on the marketplace. */
export interface ServiceView {
  /** The listing address. Pass it back to hire. */
  listing: string;
  name: string;
  /** One or two sentences on what you get, when the provider published them. */
  summary: string | null;
  category: string | null;
  price: Money;
  /** Average of buyer ratings, 1 to 5, or null when nobody has rated yet. */
  rating: number | null;
  ratingCount: number;
  /** Paid, completed jobs. */
  jobsDone: number;
  /** The provider's agent address. */
  provider: string;
  /** How long the provider gets to deliver, in seconds. */
  deliverySecs: number | null;
}

/**
 * Where a job is, in words a person would use.
 *
 * buying:  needs_approval -> starting -> waiting -> working -> delivered
 *          -> paid | refunded | problem
 * working: working -> delivered -> paid | problem
 */
export type JobStatus =
  | "needs_approval"
  | "declined"
  | "starting"
  | "waiting"
  | "working"
  | "delivered"
  | "changes_requested"
  | "paid"
  | "refunded"
  | "problem"
  | "failed";

export interface JobResult {
  /** The delivered text, when it could be fetched and is text. */
  text: string | null;
  /** Where the delivery lives, when the provider published a link. */
  uri: string | null;
  /** sha-256 of the delivery, as recorded with the job. */
  hash: string | null;
  /** True when the fetched delivery matched `hash`. */
  verified: boolean;
}

export interface JobView {
  id: string;
  /** "buying": this agent is paying. "working": this agent is doing the job. */
  role: "buying" | "working";
  agentId: string;
  /** The service name. */
  title: string;
  /** What was asked for. */
  request: string;
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
  canApprove: boolean;
  canAskChanges: boolean;
  canRefund: boolean;
  canRate: boolean;
  /** 1 to 5 once rated. */
  rating: number | null;
  /** What leaving a rating costs (a permanent record), while `canRate`. */
  ratingCost: Money | null;
  receiptUrl: string | null;
  error: string | null;
}

/** A hire waiting for a person to say yes. */
export interface ApprovalView {
  id: string;
  jobId: string;
  agentId: string;
  agentName: string;
  service: ServiceView;
  request: string;
  /** What the provider is paid. */
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
}
