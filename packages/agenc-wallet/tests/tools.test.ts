// The agent tools against a stand-in wallet connection.
// - market_post: what it sends, what it refuses before sending anything, and
//   what it tells the model.
// - market_find: what an agent reads about a service: its record, weighed by
//   money, and the marketplace's share of the price, and nothing it cannot
//   know when a wallet older than its client leaves those out.
import { describe, expect, it } from "vitest";
import type { WalletClient } from "../src/client/socket-client.js";
import { MARKET_TOOL_INSTRUCTIONS, MARKET_TOOLS, runMarketTool } from "../src/client/tools.js";
import type { ApprovalView, JobView, ServiceView } from "../src/client/types.js";

const usd = (cents: number) => ({ lamports: String(cents * 100_000), usdCents: cents });

function job(patch: Partial<JobView> = {}): JobView {
  return {
    id: "job_1",
    role: "buying",
    kind: "request",
    agentId: "agent_1",
    title: "A haiku about rain",
    acceptance: [],
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
    turnDown: null,
    canDispute: false,
    turnDownRecorded: false,
    firstRecordCost: null,
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

describe("market tool IDs", () => {
  it("passes a 68-character seller job ID through status and review", async () => {
    // Recorded from a paid seller job in the LiteSVM wallet suite.
    const jobId = "earn_agent_qkhtzxfpd_gf_2PuKGjGNyhUyaGoF98LUsW5JGjqRayXGyCfVQnSajAt3";
    expect(jobId).toHaveLength(68);
    const answer = { job: job({ id: jobId, role: "working" }) };
    const { client, calls } = wallet({ "jobs.get": answer, "jobs.draftReview": { draft: {} } });
    await runMarketTool(client, "agent_qkhtzxfpd_gf", "market_status", { job_id: jobId });
    await runMarketTool(client, "agent_qkhtzxfpd_gf", "market_review", {
      job_id: jobId, action: "ask_changes", note: "Use two lines.",
    });
    expect(calls).toEqual([
      ["jobs.get", { jobId }],
      ["jobs.draftReview", { jobId, action: "change", note: "Use two lines." }],
    ]);
  });

  it.each([
    ["market_status", "job_id", {}, "jobs.get"],
    ["market_review", "job_id", { action: "refund" }, "jobs.refund"],
    ["market_hire", "service", { request: "Write two lines." }, "market.hire"],
  ] as const)("%s accepts up to 128 characters in %s", async (name, field, args, method) => {
    const schema = MARKET_TOOLS.find((tool) => tool.name === name)!.inputSchema;
    expect(schema.properties).toMatchObject({ [field]: { maxLength: 128 } });
    const { client, calls } = wallet({ [method]: { job: job(), approval: null } });
    const run = (length: number) => runMarketTool(client, "agent_1", name, { ...args, [field]: "x".repeat(length) });
    expect((await run(128)).ok).toBe(true);
    expect(await run(129)).toMatchObject({ ok: false, message: expect.stringContaining("128") });
    expect(calls.map(([called]) => called)).toEqual([method]);
  });
});

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
      "contest_entries",
      "deadline",
      "deadline_days",
      "min_reputation",
      "operation_id",
      "private_commitment",
      "request",
      "required_capabilities",
      "review_window_secs",
      "reward_usd",
    ]);
    // The model is told, in the tool and in its instructions, that a request is public.
    expect(post.description).toMatch(/The request is public: anyone can read it/);
    expect(MARKET_TOOL_INSTRUCTIONS).toMatch(/market_post .* It is public: anyone can read it/);
    // Revision 9: what a first cancel costs, once.
    expect(MARKET_TOOL_INSTRUCTIONS).toMatch(
      /The quote includes network fees, deposits and the cost of the payer's first cancellation record\./,
    );
  });

  it("reads the complete selected entry in chat and recovers a completed contest call without posting", async () => {
    const entry = "a".repeat(64);
    const content = "poem ".repeat(12000);
    const { client, calls } = wallet({
      "jobs.delivery": { result: { text: content, verified: true, files: [], hash: entry, uri: null } },
      "jobs.callOutcome": { job: job(), approval: null },
    });
    const read = await runMarketTool(client, "agent_1", "market_status", { job_id: "job_1", entry_id: entry });
    expect(read.delivery?.untrusted_content).toBe(content);
    await runMarketTool(client, "agent_1", "market_post", { request: "A poem", reward_usd: 9, contest_entries: 3 },
      { readOutcomeOnly: true, idempotencyKey: "contest-replay" });
    expect(calls.map(([method]) => method)).toEqual(["jobs.delivery", "jobs.callOutcome"]);
  });

  it("posts a contest and drafts each settlement choice without owner authority", async () => {
    const answer = { job: job(), approval: null };
    const { client, calls } = wallet({ "market.postContest": answer, "jobs.quoteContest": answer });
    const post = { request: "A poem", reward_usd: 9, contest_entries: 3 };
    expect((await runMarketTool(client, "agent_1", "market_post", post)).ok).toBe(true);
    for (const action of ["winner", "reject", "release"]) {
      const review = { job_id: "job_1", action, entry_id: "e1", note: "Missing a line" };
      expect((await runMarketTool(client, "agent_1", "market_review", review)).ok).toBe(true);
    }
    expect(calls).toEqual([
      ["market.postContest", { request: "A poem", reward: { usdCents: 900 }, contestEntries: 3, agentId: "agent_1" }],
      ["jobs.quoteContest", { jobId: "job_1", entryId: "e1", action: "winner" }],
      ["jobs.quoteContest", { jobId: "job_1", entryId: "e1", action: "reject", reason: "Missing a line" }],
      ["jobs.quoteContest", { jobId: "job_1", entryId: "e1", action: "release" }],
    ]);
  });

  it("posts as the agent, in cents, and passes the call's key", async () => {
    const { client, calls } = wallet({ "market.post": { job: job(), approval: null } });
    const result = await runMarketTool(
      client,
      "agent_1",
      "market_post",
      { request: "  A haiku about rain.  ", reward_usd: 0.3, deadline_days: 3, min_reputation: 10000, required_capabilities: "9223372036854775808", review_window_secs: 42, acceptance: ["Three lines"] },
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
          minReputation: 10000, requiredCapabilities: "9223372036854775808", reviewWindowSecs: 42,
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

const SERVICE: ServiceView = {
  listing: "AuvhnvakgqfJaBt5CSEnYZGsZYJt5LmCpanZDCWbf9hE",
  name: "Haiku Writer",
  summary: "A three-line poem about anything you name.",
  description: "A three-line poem about anything you name.",
  category: "writing",
  tags: [],
  inputs: [],
  outputs: [],
  terms: [],
  details: "ready",
  price: usd(20),
  marketFee: { bps: 500, amount: usd(1) },
  rating: 4.5,
  ratingCount: 2,
  jobsDone: 3,
  paid: usd(60),
  buyers: 2,
  record: "ready",
  provider: "3PgS4jwwpquqxVotTKkvR8wxNUZrExqtZckHehiABKAg",
  offeredBy: {
    since: Date.UTC(2026, 7, 21),
    jobsDone: 1,
    paid: usd(20),
    buyers: 1,
    turnedDown: 2,
    disputesLost: 1,
    deposit: usd(74),
    otherServices: [],
  },
  deliverySecs: 600,
};

function client(services: unknown[]): WalletClient {
  return {
    role: "agent",
    agentId: "agent_1",
    call: (async () => ({ services, total: services.length, networkFee: usd(22) })) as WalletClient["call"],
    close() {},
  };
}

async function described(service: unknown): Promise<Record<string, unknown>> {
  const result = await runMarketTool(client([service]), "agent_1", "market_find", { query: "poem" });
  expect(result.ok).toBe(true);
  return result.services![0] as unknown as Record<string, unknown>;
}

describe("a service as an agent reads it", () => {
  it("passes discovery filters and the offset, and returns navigable IDs and the next offset", async () => {
    const service = { ...SERVICE, listingUrl: `https://agenc.ag/listings/${SERVICE.listing}` };
    const { client, calls } = wallet({ "market.find": { discovery: "service-discovery-v1", cursor: "ranking", services: [service], total: 3, networkFee: usd(22) } });
    const page = await runMarketTool(client, "agent_1", "market_find", {
      query: SERVICE.listing, provider: SERVICE.provider, min_rating: 4.5, min_paid_jobs: 3,
      max_price_usd: 1.255, offset: 1, cursor: "ranking", limit: 1,
    });
    expect(calls).toEqual([["market.find", { query: SERVICE.listing, provider: SERVICE.provider,
      minRating: 4.5, minPaidJobs: 3, maxPriceCents: 125.5, offset: 1, cursor: "ranking", limit: 1 }]]);
    expect(page).toMatchObject({ ok: true, total: 3, next_offset: 2,
      services: [{ id: SERVICE.listing, provider_id: SERVICE.provider, url: service.listingUrl }] });
    expect((await runMarketTool(client, "agent_1", "market_find", { cursor: "ranking", offset: 2 })).next_offset).toBeNull();
  });

  it("reports an update for filtered and ID reads after reconnecting to a 0.1.15 wallet", async () => {
    const old = wallet({ "market.find": { services: [SERVICE], total: 1, networkFee: usd(22) } });
    for (const args of [{ provider: SERVICE.provider, min_paid_jobs: 1000 }, { query: SERVICE.provider }]) {
      const result = await runMarketTool(old.client, "agent_1", "market_find", args);
      expect(result).toEqual({ ok: false, message: expect.stringContaining("updated Market wallet") });
    }
  });

  it("hands the buyer's same fractional-cent limit to search and hire", async () => {
    const { client, calls } = wallet({
      "market.find": { services: [], total: 0, discovery: "service-discovery-v1", networkFee: usd(1) },
      "market.hire": { approval: null, job: job() },
    });
    await runMarketTool(client, "agent_1", "market_find", { max_price_usd: 0.199 });
    await runMarketTool(client, "agent_1", "market_hire", { service: SERVICE.listing, request: "A poem", max_price_usd: 0.199 });
    expect(calls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ maxPriceCents: 19.9 }), expect.objectContaining({ maxPriceCents: 19.9 }),
    ]);
  });

  it("rejects invalid filters or offsets without making a wallet call", async () => {
    const { client, calls } = wallet({});
    for (const args of [{ offset: -1 }, { offset: 0.5 }, { min_rating: 6 }, { min_rating: "4" }, { min_paid_jobs: 0 }, { provider: "partial" }]) {
      expect((await runMarketTool(client, "agent_1", "market_find", args)).ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("gives its record with the count beside the stars, and the marketplace's share", async () => {
    expect(await described(SERVICE)).toMatchObject({
      marketplace_fee: "$0.01 of the price (5%)",
      rating: "4.5 of 5 from 2 ratings",
      paid_jobs: "3 jobs, $0.60 paid by 2 buyers",
      provider: {
        on_the_marketplace_since: "2026-08-21",
        paid_jobs: "1 job, $0.20 paid by 1 buyer",
        turned_down: 2,
        disputes_lost: 1,
      },
    });
  });

  it("says no record of turn-downs and disputes is kept for a provider without one", async () => {
    const said = await described({
      ...SERVICE,
      offeredBy: { ...SERVICE.offeredBy!, turnedDown: null, disputesLost: null },
    });
    expect(said.provider).toMatchObject({ turned_down: "no record kept", disputes_lost: "no record kept" });
  });

  it("says when the record is not known, and claims nothing from it", async () => {
    const loading = await described({ ...SERVICE, record: "loading", offeredBy: null });
    expect(loading.record).toMatch(/still being read/);
    expect(loading).not.toHaveProperty("rating");
    expect(loading).not.toHaveProperty("paid_jobs");
    const unavailable = await described({ ...SERVICE, record: "unavailable", offeredBy: null });
    expect(unavailable.record).toMatch(/could not be read/);
  });

  it("reads a service from an older wallet, which has no record and no fee", async () => {
    const { marketFee: _fee, paid: _paid, buyers: _buyers, record: _record, offeredBy: _by, ...older } = SERVICE;
    const said = await described(older);
    expect(said).toMatchObject({ name: "Haiku Writer", price: "$0.20" });
    expect(said).not.toHaveProperty("marketplace_fee");
    expect(said).not.toHaveProperty("rating");
    expect(said.record).toMatch(/could not be read/);
  });
});

it("tells a buyer why chat cannot hire a listing without a delivery period", async () => {
  expect(await described({ ...SERVICE, deliverySecs: null })).toMatchObject({
    delivery: "The seller must set a delivery period before you can hire this service.",
  });
});

describe("market_status inbox and reminders (track F wiring)", () => {
  const action = { id: "e".repeat(64), jobId: "job_1", role: "buying", agentId: "agent_1", event: "review", title: "Review the poem", dueAt: 1, stage: "due" };
  it("lists the authenticated agent's inbox with no job ID, and says when it is unavailable", async () => {
    const { client, calls } = wallet({ "jobs.list": { jobs: [] }, "jobs.inbox": { actions: [action] } });
    const result = await runMarketTool(client, "agent_1", "market_status", {});
    expect(result).toMatchObject({ ok: true, actions: [action] });
    expect(calls).toContainEqual(["jobs.inbox", {}]);
    const old = wallet({ "jobs.list": { jobs: [] } });
    expect(await runMarketTool(old.client, "agent_1", "market_status", {})).toMatchObject({ ok: true, actions_unavailable: true });
  });

  it("shows the verified parties of a job", async () => {
    const parties = { creatorWallet: "B".repeat(32), workerRegistration: null, workerWallet: null, claimedAt: null, workerProfile: null };
    const { client } = wallet({ "jobs.list": { jobs: [job({ id: "job_1", parties } as never)] }, "jobs.inbox": { actions: [] } });
    const result = await runMarketTool(client, "agent_1", "market_status", {}) as { jobs: { parties?: unknown }[] };
    expect(result.jobs[0]!.parties).toEqual(parties);
  });

  it("dismisses only an exact reminder the agent's own inbox lists", async () => {
    const { client, calls } = wallet({ "jobs.inbox": { actions: [action] }, "jobs.dismiss": { dismissed: true } });
    expect(await runMarketTool(client, "agent_1", "market_review", { job_id: "job_2", action: "dismiss_reminder", event_id: action.id }))
      .toMatchObject({ ok: false, message: "This job has no matching unread reminder." });
    expect(calls.some(([method]) => method === "jobs.dismiss")).toBe(false);
    expect(await runMarketTool(client, "agent_1", "market_review", { job_id: "job_1", action: "dismiss_reminder", event_id: action.id }))
      .toMatchObject({ ok: true, message: "Reminder dismissed." });
    expect(calls).toContainEqual(["jobs.dismiss", { id: action.id }]);
  });
});
