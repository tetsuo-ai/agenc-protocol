// The agent's market_post tool against a stand-in wallet connection: what it
// sends, what it refuses before sending anything, and what it tells the model.
import { describe, expect, it } from "vitest";
import type { WalletClient } from "../src/client/socket-client.js";
import { MARKET_TOOL_INSTRUCTIONS, MARKET_TOOLS, runMarketTool } from "../src/client/tools.js";
import type { ApprovalView, JobView } from "../src/client/types.js";

const usd = (cents: number) => ({ lamports: String(cents * 100_000), usdCents: cents });

function job(patch: Partial<JobView> = {}): JobView {
  return {
    id: "job_1",
    role: "buying",
    kind: "request",
    agentId: "agent_1",
    title: "A haiku about rain",
    request: "A haiku about rain.",
    price: usd(30),
    status: "waiting",
    statusText: "Waiting for someone to take it. If nobody does, it is cancelled and the reward comes back in 7 days.",
    createdAt: 0,
    updatedAt: 0,
    task: null,
    listing: null,
    provider: null,
    result: null,
    autoApproveAt: null,
    autoRefundAt: 7 * 86_400_000,
    reviewEndsAt: null,
    canApprove: false,
    canAskChanges: false,
    canRefund: true,
    canRate: false,
    rating: null,
    ratingCost: null,
    turnDownCost: null,
    receiptUrl: null,
    error: null,
    ...patch,
  };
}

/** A connection that answers each method from `answers` and records what was asked. */
function wallet(answers: Record<string, unknown>) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    role: "agent",
    agentId: "agent_1",
    async call(method: string, params: unknown) {
      calls.push([method, params]);
      if (!(method in answers)) throw new Error(`unexpected ${method}`);
      return answers[method];
    },
    close() {},
  } as unknown as WalletClient;
  return { client, calls };
}

describe("market_post", () => {
  it("is one of five tools, and its arguments are spelled out", () => {
    expect(MARKET_TOOLS.map((tool) => tool.name)).toEqual([
      "market_find",
      "market_hire",
      "market_post",
      "market_status",
      "market_review",
    ]);
    const post = MARKET_TOOLS.find((tool) => tool.name === "market_post")!;
    expect(post.readOnly).toBe(false);
    expect(post.inputSchema.required).toEqual(["request", "reward_usd"]);
    expect(Object.keys(post.inputSchema.properties as object).sort()).toEqual([
      "acceptance",
      "deadline_days",
      "request",
      "reward_usd",
    ]);
    // The model is told, in the tool and in its instructions, that a request is public.
    expect(post.description).toMatch(/The request is public: anyone can read it/);
    expect(MARKET_TOOL_INSTRUCTIONS).toMatch(/market_post .* It is public: anyone can read it/);
  });

  it("posts as the agent, in cents, and passes the call's key", async () => {
    const { client, calls } = wallet({ "market.post": { job: job(), approval: null } });
    const result = await runMarketTool(
      client,
      "agent_1",
      "market_post",
      { request: "  A haiku about rain.  ", reward_usd: 0.3, deadline_days: 3, acceptance: ["Three lines"] },
      { idempotencyKey: "tool:call-1" },
    );
    expect(calls).toEqual([
      [
        "market.post",
        {
          agentId: "agent_1",
          request: "A haiku about rain.",
          reward: { usdCents: 30 },
          deadlineDays: 3,
          acceptance: ["Three lines"],
          idempotencyKey: "tool:call-1",
        },
      ],
    ]);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^Waiting for someone to take it\..* Anyone can read the request\./);
    // The job is the agent's own request, not a service it hired.
    expect(result.job).toMatchObject({ job_id: "job_1", posted_request: "A haiku about rain", price: "$0.30", can: ["refund"] });
    expect(result.job).not.toHaveProperty("service");
  });

  it("refuses what it cannot post before anything reaches the wallet", async () => {
    const { client, calls } = wallet({});
    const tries: Record<string, unknown>[] = [
      { reward_usd: 1 },
      { request: "A haiku." },
      { request: "A haiku.", reward_usd: 0 },
      { request: "A haiku.", reward_usd: -1 },
      { request: "A haiku.", reward_usd: 1, deadline_days: 31 },
      { request: "A haiku.", reward_usd: 1, deadline_days: 2.5 },
      { request: "x".repeat(4_001), reward_usd: 1 },
      { request: "A haiku.", reward_usd: 1, acceptance: Array.from({ length: 9 }, () => "a check") },
    ];
    for (const args of tries) {
      const result = await runMarketTool(client, "agent_1", "market_post", args);
      expect(result.ok, JSON.stringify(args)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("waits for the person above the budget, and says what they answered", async () => {
    const approval = { id: "ok_1" } as ApprovalView;
    const waiting = wallet({
      "market.post": { job: job({ status: "needs_approval" }), approval },
      "approvals.wait": { decided: false, job: job({ status: "needs_approval" }) },
    });
    const pending = await runMarketTool(waiting.client, "agent_1", "market_post", { request: "A sonnet.", reward_usd: 6 }, { approvalWaitMs: 10 });
    expect(pending.ok).toBe(true);
    expect(pending.message).toBe(
      "Waiting for the user to approve $0.30 for this request in the Market panel. Nothing has been spent. Call market_status with this job_id after they answer.",
    );
    expect(waiting.calls[1]).toEqual(["approvals.wait", { approvalId: "ok_1", timeoutMs: 10 }]);

    const declined = wallet({
      "market.post": { job: job({ status: "needs_approval" }), approval },
      "approvals.wait": { decided: true, job: job({ status: "declined", statusText: "Not approved. Nothing was spent." }) },
    });
    const no = await runMarketTool(declined.client, "agent_1", "market_post", { request: "A sonnet.", reward_usd: 6 });
    expect(no).toMatchObject({ ok: false, message: "The user declined this request. Nothing was spent." });

    const failed = wallet({
      "market.post": { job: job({ status: "failed", error: "There was not enough money to post the request. Nothing was spent." }), approval: null },
    });
    const broke = await runMarketTool(failed.client, "agent_1", "market_post", { request: "A sonnet.", reward_usd: 6 });
    expect(broke).toMatchObject({
      ok: false,
      message: "The request was not posted and nothing was spent. There was not enough money to post the request. Nothing was spent.",
    });
  });
});
