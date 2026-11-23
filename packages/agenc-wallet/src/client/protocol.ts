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
  ServiceView,
  WalletOverview,
} from "./types.js";

/** An amount a caller names either in US cents or in lamports. */
export type AmountInput = { usdCents: number } | { lamports: string };

export interface WalletMethods {
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

  "market.find": {
    /** `limit` is at most 50 a page; `offset` skips that many of the best matches. */
    params: { query?: string; maxPriceCents?: number; limit?: number; offset?: number };
    /**
     * `total` is how many services match in all, of which `services` is one
     * page. `networkFee` is what every job costs on top of its price and is
     * not returned, even when the job is cancelled.
     */
    result: { services: ServiceView[]; total: number; networkFee: Money };
  };
  "market.hire": {
    params: {
      agentId: string;
      listing: string;
      /** What the buyer wants done, in plain words. */
      request: string;
      /** Refuse if the service costs more than this. */
      maxPriceCents?: number;
      /** Checks the delivery must pass, written for the provider to read. */
      acceptance?: string[];
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
      agentId: string;
      /** What is wanted, in plain words, written for whoever takes it. */
      request: string;
      /** What whoever does it is paid. */
      reward: AmountInput;
      /** Days to deliver in, 1 to 30. Default 7. Nobody can take it after that. */
      deadlineDays?: number;
      /** Checks the delivery must pass. */
      acceptance?: string[];
      /** Makes a retried call return the same job instead of posting twice. */
      idempotencyKey?: string;
    };
    result: { job: JobView; approval: ApprovalView | null };
  };
  /**
   * The person posts a request from the main balance. Owner only: asking is
   * the yes, so nothing waits for approval. `overview.postCost` says what it
   * costs on top of the reward.
   */
  "wallet.post": {
    params: {
      request: string;
      reward: AmountInput;
      deadlineDays?: number;
      acceptance?: string[];
      idempotencyKey?: string;
    };
    result: { job: JobView };
  };

  "approvals.list": { params: Record<string, never>; result: { approvals: ApprovalView[] } };
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
  "jobs.get": { params: { jobId: string }; result: { job: JobView } };
  /** Complete verified delivery, including text beyond the list preview. */
  "jobs.delivery": { params: { jobId: string }; result: { result: JobResult } };
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
    params: { jobId: string; rating?: number };
    result: { job: JobView };
  };
  "jobs.reviewRecord": { params: { jobId: string }; result: import("./reviews.js").ReviewRecord };
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
  "jobs.rate": { params: { jobId: string; score: number }; result: { job: JobView } };

  "activity.list": {
    params: { limit?: number };
    result: { activity: ActivityView[] };
  };

  /** Switch taking jobs on or off. Off replies while an existing job is still finishing. */
  "earn.set": {
    params: { agentId: string; enabled: boolean; minPayCents?: number };
    result: AgentView;
  };
  /** Quote before enabling earning, offering, changing words/price, or funding upkeep. */
  "earn.quote": {
    params: { agentId: string; offerId?: string; offer?: { name: string; summary: string; price: AmountInput } };
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
      offer: { name: string; summary: string; price: AmountInput } | null;
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
    params: { password: string; file: string };
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
  "market.find",
  "market.hire",
  "market.post",
  "approvals.wait",
  "jobs.list",
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
