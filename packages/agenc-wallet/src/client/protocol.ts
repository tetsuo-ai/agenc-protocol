import type { MoneyMethods } from "./money-operations.js";
import type { ListingMethods } from "./listing-methods.js";
import type { BusinessMethods } from "./business.js";
import type { ChildHireMethods } from "./child-hire.js";
import type { ExchangeMethods } from "./exchange-methods.js";
import type { ConnectionMethods } from "./connections.js";
import type { DiscoveryQuery, DiscoveryPage } from "./discovery.js";
// The request/response table of the wallet service. One entry per method;
// the server and the client are both typed from it, so they cannot drift.
import type { DeliveryFile } from "./delivery-files.js";
import type {
  ActivityView,
  AgentPolicy,
  AgentView,
  ApprovalView,
  JobStatus,
  JobView,
  JobResult,
  Money,
  WalletOverview,
} from "./types.js";

/** An amount a caller names either in US cents or in lamports. */
export type AmountInput = { usdCents: number } | { lamports: string };

/** The program accepts listing deadlines up to one year. */
export const MAX_LISTING_DELIVERY_SECS = 31_536_000;

export interface SellerOfferInput {
  /** Enable Earns with this offer under the same owner quote. */
  enableEarns?: true;
  /** Identifies the room setup shown with the quote. */
  setupId?: string;
  name: string;
  summary: string;
  price: AmountInput;
  terms?: Partial<import("./seller-terms.js").SellerTerms>;
  deliverySecs?: number;
}

export type ServiceOfferInput = SellerOfferInput;

export interface WalletMethods extends ConnectionMethods, MoneyMethods, ListingMethods, BusinessMethods, ChildHireMethods, ExchangeMethods {
  "work.list": {
    params: { agentId: string; offset?: number; task?: string };
    /** shortOfMoney: open jobs this page left out only because the agent's own money cannot pay the claim deposit and rent; needs is the least more money that takes one of them, and add that amount in dollars rounded up to a cent. */
    /** next names a page of one listing; pass it back as offset. relisted: that listing was gone, so these jobs are page 1 of a new listing and replace every job read before. */
    result: { eligibility?:{task:string;code:string;message:string;retryable:boolean}; relisted?: true; shortOfMoney?: { jobs: number; needs: import("./types.js").Money; add: string }; jobs: import("./types.js").WorkerJobView[]; next: number | null; held: import("./types.js").WorkerJobView | null };
  };
  "work.quote": {
    params: { agentId: string; task: string; action: import("./types.js").WorkAction };
    result: import("./types.js").WorkerQuote;
  };
  "work.pending": { params: Record<string, never>; result: import("./types.js").WorkerQuote[] };
  "work.decide": { params: { id: string; approve: boolean }; result: { approved: boolean } };
  "work.choose": { params: { agentId: string; manual: boolean }; result: { manual: boolean } };
  /**
   * Balances, agents, counts and service `capabilities` on every response.
   * "earn-finishing" means disabling earning replies once the agent takes
   * no new job; an in-progress job stays "finishing", never "off".
   * Clients may ignore capabilities they do not recognize.
   */
  overview: { params: Record<string, never>; result: WalletOverview };

  /**
   * Make an agent, with its own wallet. Without a name it is called
   * "Agent 2", "Agent 3" and so on. `scope` ties it to a place the host
   * knows (one agent per scope).
   */
  "agents.create": { params: { name?: string; scope?: string | null }; result: AgentView };
  /**
   * The one spending setting: what the agent may spend on its own each day.
   * The wallet keeps that much in the agent's wallet, from the main balance,
   * and anything beyond it waits for the person. Zero: it asks every time.
   */
  "agents.setBudget": { params: { agentId: string; perDayCents: number }; result: AgentView };
  "agents.rename": { params: { agentId: string; name: string }; result: AgentView };
  "agents.setPolicy": {
    params: { agentId: string; policy: AgentPolicy };
    result: AgentView;
  };
  /** Move money from the main balance into an agent's wallet. */
  "agents.fund": {
    params: { agentId: string; amount: AmountInput };
    result: AgentView;
  };
  /** Move money from an agent's wallet back to the main balance. */
  "agents.reclaim": {
    params: { agentId: string; amount: AmountInput | "all" };
    result: AgentView;
  };
  /**
   * Stop an agent earning for good: its services come off the marketplace
   * for good, then it is retired there, which brings its deposit for taking
   * jobs (`earn.setAside`) back to its own money. It cannot take jobs again.
   * Refused, with a sentence that says why, while it still takes jobs (Earns
   * on, a service on offer), has a job that is not finished or holds one, or
   * someone hired it and waits for the work.
   */
  "agents.retire": { params: { agentId: string }; result: AgentView };

  "market.find": { params: DiscoveryQuery; result: DiscoveryPage };
  "market.hire": {
    params: {
      childPolicyDigest?:string;
      listingAgreement?: import("./listing-exchange.js").ListingAgreement;
      agentId: string;
      listing: string;
      /** What the buyer wants done, in plain words. */
      request: string;
      privateCommitment?:string;
      /** Required file names and whether a text-only delivery is accepted. Default: text allowed, no required files. */
      outputs?: import("./job-exchange.js").OutputAgreement;
      /** Refuse if the service costs more than this. */
      maxPriceCents?: number;
      expectedPriceLamports?: string;
      expectedSpecHash?: string;
      /** Existing panel guard when the explicit buyer ceiling is higher than the displayed-price limit. */
      displayedLimitCents?: number;
      /** Checks the delivery must pass, written for the provider to read. */
      acceptance?: string[];
      /** Exact delivery deadline, in Unix seconds. */
      deadline?: number;
      reviewWindowSecs?: number;
      /** Makes a retried call return the same job instead of hiring twice. */
      idempotencyKey?: string;
    };
    result: { job: JobView; approval: ApprovalView | null };
  };

  /**
   * Post a request for anyone on the marketplace to take, as an agent paying
   * from its own money: one worker, and the delivery is reviewed before it is
   * paid. A reward within the agent's daily budget that its money covers is
   * posted at once; anything else waits for the person, as a hire does. The
   * request is public: anyone can read it.
   */
  "market.post": {
    params: {
      contestEntries?: number;
      agentId: string;
      /** What is wanted, in plain words, written for whoever takes it. */
      request: string;
      privateCommitment?:string;
      /** Required file names and whether a text-only delivery is accepted. Default: text allowed, no required files. */
      outputs?: import("./job-exchange.js").OutputAgreement;
      /** What whoever does it is paid. */
      reward: AmountInput;
      /** Days to deliver in, 1 to 30. Default 7. Nobody can take it after that. */
      deadlineDays?: number;
      minReputation?: number;
      /** Nonzero unsigned 64-bit mask, encoded as decimal text. */
      requiredCapabilities?: string;
      /** Checks the delivery must pass. */
      acceptance?: string[];
      /** Exact delivery deadline, in Unix seconds. */
      deadline?: number;
      reviewWindowSecs?: number;
      /** Makes a retried call return the same job instead of posting twice. */
      idempotencyKey?: string;
    };
    result: { job: JobView; approval: ApprovalView | null };
  };
  /**
   * Legacy owner method. Direct creation is refused. Use wallet.quotePost and confirm its ID.
   */
  "wallet.post": {
    params: {
      contestEntries?: number;
      request: string;
      privateCommitment?:string;
      /** Required file names and whether a text-only delivery is accepted. Default: text allowed, no required files. */
      outputs?: import("./job-exchange.js").OutputAgreement;
      reward: AmountInput;
      deadlineDays?: number;
      minReputation?: number;
      /** Nonzero unsigned 64-bit mask, encoded as decimal text. */
      requiredCapabilities?: string;
      acceptance?: string[];
      /** Exact delivery deadline, in Unix seconds. */
      deadline?: number;
      reviewWindowSecs?: number;
      idempotencyKey?: string;
    };
    result: { job: JobView };
  };

  /** Agent route that an older wallet cannot mistake for a single-worker post. */
  "market.postContest": {
    params: WalletMethods["market.post"]["params"] & { contestEntries: number };
    result: WalletMethods["market.post"]["result"];
  };
  /** Owner previews. These always wait for a separate approvals.decide. */
  "wallet.quoteHire": WalletMethods["market.hire"];
  "wallet.quotePost": { params: WalletMethods["wallet.post"]["params"]; result: WalletMethods["market.post"]["result"] };

  "jobs.callOutcome": { params: { agentId: string; kind: "hire" | "request"; key: string }; result: WalletMethods["market.hire"]["result"] & {receipt?: Record<string, unknown> | null} };
  "approvals.page": {
    params: { after?: string };
    result: { entries: { id: string; jobId: string }[]; next: string | null };
  };
  "approvals.get": { params: { approvalId: string }; result: { approval: ApprovalView; status: "pending" | "approved" | "expired" | "declined" } };
  "approvals.outcome": { params: { approvalId: string }; result: { job: JobView; status: "pending" | "approved" | "expired" | "declined"; approval?: ApprovalView } };
  "approvals.refresh": { params: { approvalId: string }; result: { approval: ApprovalView } };
  "approvals.list": { params: { after?: string }; result: { approvals: ApprovalView[]; next?: string | null } };
  "approvals.decide": {
    params: { approvalId: string; approve: boolean };
    result: { job: JobView };
  };
  /** Resolves when the approval is decided or expires, or after `timeoutMs`. */
  "approvals.wait": {
    params: { approvalId: string; timeoutMs?: number };
    result: { decided: boolean; job: JobView };
  };

  "jobs.list": {
    params: { role?: "buying" | "working"; agentId?: string; limit?: number; before?: string };
    result: { jobs: JobView[] };
  };
  "jobs.contestPage": {
    params: { jobId: string; after?: string }; result: { entries: import("./types.js").ContestEntry[]; next: string | null };
  };
  "jobs.contestReceipts": {
    params: { jobId: string; after?: string }; result: { receipts: import("./types.js").ContestReceipt[]; next: string | null };
  };
  "jobs.contestQuote": {
    params: { jobId: string; quoteId: string }; result: { quote: import("./types.js").ContestQuote };
  };
  "jobs.quoteContest": {
    params: { jobId: string; entryId: string; action: import("./types.js").ContestAction; reason?: string };
    result: { job: JobView };
  };
  "jobs.decideContest": {
    params: { jobId: string; quoteId: string; approve: boolean };
    result: { job: JobView };
  };
  "jobs.get": { params: { jobId: string }; result: { job: JobView } };
  /** Complete verified delivery, including text beyond the list preview. */
  "jobs.delivery": { params: { jobId: string; entryId?: string }; result: { result: JobResult } };
  /**
   * One file of a job's delivery, fetched from the delivery store by its
   * fingerprint and checked against it. Owner only: a file's bytes are for a
   * person to look at, not for an agent's context.
   */
  "jobs.file": {
    params: { jobId: string; sha256: string };
    result: { file: DeliveryFile & { base64: string } };
  };
  /** Resolves when the job reaches one of `until`, or after `timeoutMs`. */
  "jobs.wait": {
    params: { jobId: string; until?: JobStatus[]; timeoutMs?: number };
    result: { reached: boolean; job: JobView };
  };
  /** Accept the delivery and pay the provider. */
  "jobs.approve": {
    params: { jobId: string; rating?: number; ratingQuoteId?: string; quoteId?: string };
    result: { job: JobView };
  };
  "jobs.reviewRecord": { params: { jobId: string; termsOnly?: boolean; before?: string }; result: import("./reviews.js").ReviewRecord };
  "jobs.draftReview": {
    params: { jobId: string; action: import("./reviews.js").ReviewAction; note: string; attachments?: import("./reviews.js").ReviewAttachment[] };
    result: { draft: import("./reviews.js").ReviewDraft };
  };
  "jobs.confirmReview": {
    params: { jobId: string; review: import("./reviews.js").ReviewConfirmation };
    result: { job: JobView };
  };
  "jobs.askChanges": {
    params: { jobId: string; note: string };
    result: { job: JobView };
  };
  /** Cancel and take the money back, when the job allows it. */
  "jobs.refund": { params: { jobId: string }; result: { job: JobView } };
  /**
   * Owner only. Dispute a buyer's turn-down of a delivery one of this wallet's
   * agents made, posting the bond (`JobView.turnDown.bond`). Never an agent's call.
   */
  "jobs.dispute": { params: { jobId: string }; result: { job: JobView } };
  "jobs.rate": { params: { jobId: string; score: number; ratingQuoteId?: string }; result: { job: JobView } };

  "activity.list": {
    params: { limit?: number };
    result: { activity: ActivityView[] };
  };

  /** Switch taking jobs on or off. Off replies while an existing job is still finishing. */
  "earn.set": {
    params: { agentId: string; enabled: boolean; minPayCents?: number; fundingQuoteId?: string };
    result: AgentView;
  };
  /** Quote before enabling earning, offering, changing words/price, or funding upkeep. */
  "earn.quote": {
    params: { agentId: string; offerId?: string; minPayCents?: number; offer?: SellerOfferInput };
    result: import("./types.js").EarnFundingQuote;
  };
  /** Owner only. Explicitly approve the quoted transfer to this agent, once. */
  "earn.approveFunding": {
    params: { quoteId: string };
    result: AgentView;
  };
  /**
   * Offer a service other agents can hire, done by this agent while it takes
   * jobs. An agent can offer several. `offerId` names one of them (from
   * `AgentView.earn.offers`): with `offer` it changes that service's price
   * or description (its name is fixed once it exists), with `offer: null` it
   * takes that service off offer. Without `offerId` a new service is offered,
   * unless the agent already offers one by that name, which is then changed.
   */
  "earn.offer": {
    params: {
      agentId: string;
      offerId?: string;
      offer: SellerOfferInput | null;
      fundingQuoteId?: string;
    };
    result: AgentView;
  };

  /**
   * Seal every key and the wallet's records into one backup at `file` (a
   * full path the host chose with the person), locked with a password the
   * person chooses. The service writes the file itself, so a backup of any
   * size never has to fit in one message. Restoring is not a method here: it
   * replaces the wallet, so the host does it with the service stopped.
   */
  "backup.export": {
    params: { password: string; file: string; businessSnapshot?: string };
    result: { createdAt: number; agents: number; main: string };
  };
  /**
   * Try a password on the backup at `file` without changing anything, and
   * say what the backup holds. A host asks this before it stops the service
   * to restore, so a mistyped password costs the person nothing.
   */
  "backup.check": {
    params: { password: string; file: string };
    result: { createdAt: number; agents: number; main: string };
  };

  /** Send money from the main balance to an outside address. */
  "wallet.withdraw": {
    params: { to: string; amount: AmountInput | "all" };
    result: { signature: string };
  };
}

export type WalletMethod = keyof WalletMethods;
export type MethodParams<M extends WalletMethod> = WalletMethods[M]["params"];
export type MethodResult<M extends WalletMethod> = WalletMethods[M]["result"];

/**
 * What a connection may call. The owner is the person at the panel. An agent
 * connection is bound to one agent id and can never move money between
 * wallets, change its own rules, approve its own request, or withdraw.
 */
export const AGENT_METHODS: readonly WalletMethod[] = [
  "agents.self", "jobs.inbox", "jobs.dismiss", "listings.inquiries", "listings.message", "jobs.ratingQuote", "earn.operation", "jobs.readDeliveryChunk", "jobs.exchange", "jobs.acknowledgeDeliveryChunk",
  "work.list",
  "work.quote",
  "market.find",
  "market.hire",
  "market.post",
  "market.postContest",
  "approvals.wait",
  "jobs.callOutcome",
  "jobs.list",
  "jobs.contestPage", "jobs.contestReceipts", "jobs.contestQuote",
  "jobs.quoteContest",
  "jobs.get",
  "jobs.delivery",
  "jobs.wait",
  "jobs.approve",
  "jobs.reviewRecord",
  "jobs.draftReview",
  "jobs.refund",
  "jobs.rate",
];

/** Server-pushed notification: something a panel should re-read. */
export type WalletEvent =
  | { type: "overview" }
  | { type: "job"; jobId: string }
  | { type: "approval"; approvalId: string }
  | { type: "activity" };

export interface RpcRequest {
  id: number;
  method: string;
  params: unknown;
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string; retryable?: boolean } };

export interface RpcHello {
  hello: 1;
  /** The bearer credential for this connection. */
  token: string;
  /** Ask the server to push {@link WalletEvent}s on this connection. */
  events?: boolean;
  /**
   * Narrow an owner credential to one agent for this connection. A host that
   * holds the owner credential uses this for every agent tool call, so a tool
   * call can never reach an owner-only method.
   */
  actAs?: string;
}

export type RpcHelloReply =
  | { hello: 1; ok: true; role: "owner" | "agent"; agentId: string | null }
  | { hello: 1; ok: false; error: string };

/** Longest single frame either side accepts (bytes of UTF-8 JSON). */
export const MAX_FRAME_BYTES = 1024 * 1024;
