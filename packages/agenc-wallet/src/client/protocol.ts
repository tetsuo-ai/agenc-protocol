// The request/response table of the wallet service. One entry per method;
// the server and the client are both typed from it, so they cannot drift.
import type {
  ActivityView,
  AgentPolicy,
  AgentView,
  ApprovalView,
  JobStatus,
  JobView,
  Money,
  ServiceView,
  WalletOverview,
} from "./types.js";

/** An amount a caller names either in US cents or in lamports. */
export type AmountInput = { usdCents: number } | { lamports: string };

export interface WalletMethods {
  /** Balances, agents and counts: everything the panel's first screen needs. */
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

  "market.find": {
    params: { query?: string; maxPriceCents?: number; limit?: number };
    /**
     * `networkFee` is what every job costs on top of its price and is not
     * returned, even when the job is cancelled.
     */
    result: { services: ServiceView[]; networkFee: Money };
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
    params: { role?: "buying" | "working"; agentId?: string; limit?: number };
    result: { jobs: JobView[] };
  };
  "jobs.get": { params: { jobId: string }; result: { job: JobView } };
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
  "jobs.askChanges": {
    params: { jobId: string; note: string };
    result: { job: JobView };
  };
  /** Cancel and take the money back, when the job allows it. */
  "jobs.refund": { params: { jobId: string }; result: { job: JobView } };
  "jobs.rate": { params: { jobId: string; score: number }; result: { job: JobView } };

  "activity.list": {
    params: { limit?: number };
    result: { activity: ActivityView[] };
  };

  /** Switch "take jobs while idle" on or off for one agent. */
  "earn.set": {
    params: { agentId: string; enabled: boolean; minPayCents?: number };
    result: AgentView;
  };
  /**
   * Offer a service other agents can hire, done by this agent while it takes
   * jobs. Calling it again changes the price or the description (the name is
   * fixed once the service exists). `offer: null` takes the service off offer.
   */
  "earn.offer": {
    params: {
      agentId: string;
      offer: { name: string; summary: string; price: AmountInput } | null;
    };
    result: AgentView;
  };

  /**
   * Seal every key and the wallet's records into one backup, locked with a
   * password the person chooses. Returns the backup file's text: the host
   * writes it wherever the person says. Restoring is not a method here: it
   * replaces the wallet, so the host does it with the service stopped.
   */
  "backup.export": {
    params: { password: string };
    result: { file: string; createdAt: number; agents: number };
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
  "approvals.wait",
  "jobs.list",
  "jobs.get",
  "jobs.wait",
  "jobs.approve",
  "jobs.askChanges",
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
  | { id: number; ok: false; error: { code: string; message: string } };

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
