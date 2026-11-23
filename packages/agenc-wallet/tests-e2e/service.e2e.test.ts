import type { WalletState } from "../src/store.js";
// The wallet behind its socket, driven the way a desktop host drives it:
// an owner connection for the panel and an agent-bound connection for the
// four chat tools. Proves an agent connection cannot reach owner methods.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Chain } from "../src/chain.js";
import { connectWallet, type WalletClient } from "../src/client/socket-client.js";
import { runMarketTool } from "../src/client/tools.js";
import { MAX_FRAME_BYTES, type WalletEvent } from "../src/client/protocol.js";
import { agentToken, serveWallet, type WalletServer } from "../src/server.js";
import { eventually, startWorld, type World } from "./harness.js";

let world: World | null = null;
let server: WalletServer | null = null;
const clients: WalletClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await server?.close();
  server = null;
  await world?.wallet.close();
  world = null;
});

async function serve(current: World) {
  const ownerToken = randomBytes(32).toString("hex");
  const socketPath = path.join(current.dataDir, "sock", "wallet.sock");
  server = await serveWallet({
    wallet: current.wallet,
    socketPath,
    ownerToken,
    agentExists: (agentId) => current.wallet.hasAgent(agentId),
  });
  const connect = async (options: { token?: string; actAs?: string; onEvent?: (event: WalletEvent) => void }) => {
    const client = await connectWallet({
      socketPath,
      token: options.token ?? ownerToken,
      ...(options.actAs !== undefined ? { actAs: options.actAs } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });
    clients.push(client);
    return client;
  };
  return { ownerToken, socketPath, connect };
}

/** The practice chain, presented as a network whose money is worth backing up. */
const asLocalnet = (chain: Chain): Chain =>
  Object.create(chain, { network: { value: "localnet", enumerable: true } }) as Chain;

describe("the wallet service", () => {
  it("backs up a wallet far bigger than one message can carry", async () => {
    world = await startWorld({ chain: asLocalnet });
    const { connect } = await serve(world);
    const owner = await connect({});
    const agent = await owner.call("agents.create", { name: "My assistant" });
    // Years of work ledgers: more than the longest frame either side accepts.
    const ledgers = path.join(world.dataDir, "earn", agent.id);
    mkdirSync(ledgers, { recursive: true });
    for (let index = 0; index < 3; index += 1) {
      writeFileSync(path.join(ledgers, `ledger-${index}.json`), randomBytes(700_000).toString("hex"));
    }
    const file = path.join(mkdtempSync(path.join(tmpdir(), "agenc-wallet-e2e-big-")), "backup.agencbackup");

    const made = await owner.call("backup.export", { password: "a long enough password", file });
    expect(made.agents).toBe(1);
    expect(statSync(file).size).toBeGreaterThan(4 * MAX_FRAME_BYTES);
    // The answer is a few numbers: the backup itself never crosses the socket.
    expect(JSON.stringify(made).length).toBeLessThan(200);
    expect(await owner.call("backup.check", { password: "a long enough password", file })).toEqual(made);
    await expect(owner.call("backup.check", { password: "not the password", file })).rejects.toMatchObject({
      message: "That password does not open this backup.",
    });
    expect((await owner.call("overview", {})).backup).toEqual({ at: made.createdAt, upToDate: true });
  });

  it("rejects a wrong credential", async () => {
    world = await startWorld();
    const { socketPath } = await serve(world);
    await expect(connectWallet({ socketPath, token: "x".repeat(64) })).rejects.toMatchObject({
      code: "NOT_ALLOWED",
    });
  });

  it("keeps an agent connection inside its own lane", async () => {
    world = await startWorld();
    const { connect, ownerToken } = await serve(world);
    const owner = await connect({});
    expect(owner.role).toBe("owner");
    const mine = await owner.call("agents.create", { name: "My assistant" });
    const other = await owner.call("agents.create", { name: "Research agent" });
    await owner.call("agents.fund", { agentId: other.id, amount: { usdCents: 300 } });

    // Both ways of getting an agent connection: the owner narrowing its own
    // credential, and a standalone credential derived for that agent.
    const narrowed = await connect({ actAs: mine.id });
    const standalone = await connect({ token: agentToken(ownerToken, mine.id), actAs: mine.id });
    for (const agent of [narrowed, standalone]) {
      expect(agent.role).toBe("agent");
      expect(agent.agentId).toBe(mine.id);
      await expect(agent.call("overview", {})).rejects.toMatchObject({ code: "NOT_ALLOWED" });
      await expect(
        agent.call("agents.fund", { agentId: mine.id, amount: { usdCents: 100 } }),
      ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
      await expect(
        agent.call("agents.setPolicy", {
          agentId: mine.id,
          policy: { askAboveCents: 99_999, refill: { enabled: false, topUpToCents: 0, perDayCents: 0 } },
        }),
      ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
      // Its own budget, and making more agents, are the owner's to decide.
      await expect(
        agent.call("agents.setBudget", { agentId: mine.id, perDayCents: 99_999 }),
      ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
      await expect(agent.call("agents.create", {})).rejects.toMatchObject({ code: "NOT_ALLOWED" });
      // An agent can neither take a copy of the keys nor try passwords on one.
      await expect(
        agent.call("backup.export", { password: "a long enough password", file: path.join(world.dataDir, "x") }),
      ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
      await expect(
        agent.call("backup.check", { password: "a long enough password", file: path.join(world.dataDir, "x") }),
      ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
      await expect(
        agent.call("wallet.withdraw", { to: other.address, amount: "all" }),
      ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
      await expect(agent.call("approvals.list", {})).rejects.toMatchObject({ code: "NOT_ALLOWED" });
      // Posting from the main balance is the person's: an agent posts only from its own money.
      await expect(
        agent.call("wallet.post", { request: "A haiku about rain.", reward: { usdCents: 30 } }),
      ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
      // Earning and what is put on offer are the owner's decisions too.
      await expect(
        agent.call("earn.set", { agentId: mine.id, enabled: true }),
      ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
      await expect(
        agent.call("earn.offer", {
          agentId: mine.id,
          offer: { name: "Anything", summary: "Anything at all.", price: { usdCents: 1 } },
        }),
      ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    }
    // The owner makes an agent with one empty call, tied to a place or not,
    // and sets what it may spend with one number.
    const third = await owner.call("agents.create", {});
    expect(third.name).toBe("Agent 3");
    const tied = await owner.call("agents.create", { scope: "/home/me/project" });
    expect(tied).toMatchObject({ name: "Agent 4", scope: "/home/me/project", budgetCents: 0 });
    const budgeted = await owner.call("agents.setBudget", { agentId: third.id, perDayCents: 200 });
    expect(budgeted).toMatchObject({ budgetCents: 200 });
    expect(budgeted.balance.usdCents).toBe(199.95);

    // A credential for one agent does not open another agent's lane.
    await expect(
      connect({ token: agentToken(ownerToken, mine.id), actAs: other.id }),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });

    // Naming another agent in a request changes nothing: the hire is made as
    // the connection's own agent, which has no allowance, so it needs a yes.
    const hired = await narrowed.call("market.hire", {
      agentId: other.id,
      listing: world.listing,
      request: "A haiku.",
    });
    expect(hired.job.agentId).toBe(mine.id);
    expect(hired.job.status).toBe("needs_approval");
    await expect(
      narrowed.call("approvals.decide", { approvalId: hired.approval!.id, approve: true }),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });

    // The same for a request it posts: made as itself, from its own money,
    // which is empty, so it waits for the person.
    const asked = await narrowed.call("market.post", {
      agentId: other.id,
      request: "A haiku about rain.",
      reward: { usdCents: 30 },
    });
    expect(asked.job).toMatchObject({ agentId: mine.id, kind: "request", status: "needs_approval" });
    expect(asked.approval).toMatchObject({ kind: "request", service: null });
    const input = { request: "A haiku about snow.", reward: { usdCents: 30 } };
    await expect(owner.call("wallet.post", input)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(owner.call("market.hire", { agentId: mine.id, listing: world.listing, request: input.request })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    const quote = await owner.call("wallet.quotePost", input);
    const own = await owner.call("approvals.decide", { approvalId: quote.approval!.id, approve: true });
    expect(own.job).toMatchObject({ agentId: "", kind: "request", status: "waiting" });

    // Another agent cannot watch that request either.
    const otherLane = await connect({ actAs: other.id });
    await expect(
      otherLane.call("approvals.wait", { approvalId: hired.approval!.id, timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The same tool call delivered twice is one hire, not two.
    const first = await runMarketTool(
      otherLane,
      other.id,
      "market_hire",
      { service: world.listing, request: "A haiku." },
      { idempotencyKey: "call-1", approvalWaitMs: 10 },
    );
    const second = await runMarketTool(
      otherLane,
      other.id,
      "market_hire",
      { service: world.listing, request: "A haiku." },
      { idempotencyKey: "call-1", approvalWaitMs: 10 },
    );
    expect(second.job!.job_id).toBe(first.job!.job_id);
    const { jobs } = await otherLane.call("jobs.list", {});
    expect(jobs).toHaveLength(1);
  });

  it("runs the four chat tools from find to paid, with one approval click", async () => {
    world = await startWorld();
    const { sandbox } = world;
    const events: WalletEvent[] = [];
    const { connect } = await serve(world);
    const owner = await connect({ onEvent: (event) => events.push(event) });
    const agentView = await owner.call("agents.create", { name: "My assistant" });
    const agent = await connect({ actAs: agentView.id });

    const found = await runMarketTool(agent, agentView.id, "market_find", { query: "poem haiku" });
    expect(found.ok).toBe(true);
    expect(found.services).toHaveLength(1);
    expect(found.services![0]).toMatchObject({ name: "Haiku Writer", price: "$0.20" });
    expect(found.message).toMatch(/network fees/);

    // The tool call waits while the person decides in the panel.
    const hiring = runMarketTool(agent, agentView.id, "market_hire", {
      service: found.services![0]!.id,
      request: "A haiku about a lighthouse.",
      max_price_usd: 1,
    });
    const approval = await eventually(async () => {
      const { approvals } = await owner.call("approvals.list", {});
      return approvals[0];
    });
    expect(approval.agentName).toBe("My assistant");
    expect(events.some((event) => event.type === "approval")).toBe(true);
    await owner.call("approvals.decide", { approvalId: approval.id, approve: true });
    const hired = await hiring;
    expect(hired.ok).toBe(true);
    expect(hired.job!.status).toBe("waiting");

    const waiting = runMarketTool(agent, agentView.id, "market_status", {
      job_id: hired.job!.job_id,
      wait: true,
    });
    await sandbox.workOnce();
    const delivered = await waiting;
    expect(delivered.job!.status).toBe("delivered");
    expect(delivered.job!.delivery?.untrusted_content).toContain("A haiku about a lighthouse.");
    expect(delivered.job!.delivery?.matches_recorded_fingerprint).toBe(true);
    expect(delivered.job!.can).toEqual(["approve", "ask_changes"]);

    const refused = await runMarketTool(agent, agentView.id, "market_review", {
      job_id: hired.job!.job_id,
      action: "refund",
    });
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/user's decision/);

    const paid = await runMarketTool(agent, agentView.id, "market_review", {
      job_id: hired.job!.job_id,
      action: "approve",
    });
    expect(paid.ok).toBe(true);
    expect(paid.job!.status).toBe("paid");

    const list = await runMarketTool(agent, agentView.id, "market_status", {});
    expect(list.jobs).toHaveLength(1);
    const bad = await runMarketTool(agent, agentView.id, "market_hire", { service: "nope" });
    expect(bad.ok).toBe(false);
  });

  it("posts a request with the chat tools and follows it to paid, once per call", async () => {
    world = await startWorld();
    const { sandbox } = world;
    const { connect } = await serve(world);
    const owner = await connect({});
    const agentView = await owner.call("agents.create", { name: "My assistant" });
    await owner.call("agents.setBudget", { agentId: agentView.id, perDayCents: 500 });
    const agent = await connect({ actAs: agentView.id });

    const args = { request: "A haiku about a lighthouse.", reward_usd: 0.3 };
    const posted = await runMarketTool(agent, agentView.id, "market_post", args, { idempotencyKey: "call-9" });
    expect(posted.ok).toBe(true);
    expect(posted.message).toMatch(/Anyone can read the request\./);
    expect(posted.job).toMatchObject({ posted_request: "A haiku about a lighthouse", status: "waiting", price: "$0.30", can: ["refund"] });
    // The same call delivered twice posts once.
    const again = await runMarketTool(agent, agentView.id, "market_post", args, { idempotencyKey: "call-9" });
    expect(again.job!.job_id).toBe(posted.job!.job_id);

    // A stranger takes it and delivers; the agent waits for that and pays.
    const waiting = runMarketTool(agent, agentView.id, "market_status", { job_id: posted.job!.job_id, wait: true });
    await sandbox.workOnce();
    const delivered = await waiting;
    expect(delivered.job!.status).toBe("delivered");
    expect(delivered.job!.delivery?.untrusted_content).toContain("You asked: A haiku about a lighthouse.");
    const paid = await runMarketTool(agent, agentView.id, "market_review", {
      job_id: posted.job!.job_id,
      action: "approve",
      rating: 5,
    });
    expect(paid.ok).toBe(true);
    expect(paid.job!.status).toBe("paid");
    const { jobs } = await agent.call("jobs.list", {});
    expect(jobs).toHaveLength(1);
  });
});

it("uses the same fractional maximum for search and hire over the agent socket", async () => {
  world = await startWorld();
  const buyer = await world.wallet.createAgent("Buyer");
  await world.wallet.setBudget(buyer.id, 500);
  const { connect } = await serve(world);
  const agent = await connect({ actAs: buyer.id });
  const cap = { max_price_usd: 0.199 };
  const search = await runMarketTool(agent, buyer.id, "market_find", { query: "haiku", ...cap });
  expect(search.services).toEqual([]);
  const before = await world.balance(buyer.address);
  const hire = await runMarketTool(agent, buyer.id, "market_hire", { service: world.listing, request: "Write it.", ...cap });
  expect(hire).toMatchObject({ ok: false, message: expect.stringMatching(/price limit/) });
  expect(await world.balance(buyer.address)).toBe(before);
  expect(await world.wallet.listJobs({}, true)).toEqual([]);
});

it("pages a queue larger than a socket frame, with full briefs available by ID", async () => {
  world = await startWorld();
  const agent = await world.wallet.createAgent("Buyer");
  const request = "🌳".repeat(1900);
  const { approval } = await world.wallet.hire({ agentId: agent.id, listing: world.listing, request });
  await world.wallet.close();
  const file = path.join(world.dataDir, "state.json");
  const state = JSON.parse(readFileSync(file, "utf8")) as WalletState;
  const model = state.approvals[approval!.id]!;
  for (let n = 0; n < 160; n++) {
    const id = "quote-" + n;
    state.approvals[id] = { ...model, id };
  }
  writeFileSync(file, JSON.stringify(state));
  world.wallet = await world.reopen();
  const owner = await (await serve(world)).connect({});
  const ids: string[] = [];
  let after: string | undefined;
  do {
    const page = await owner.call("approvals.page", after ? { after } : {});
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(8192);
    ids.push(...page.entries.map(entry => entry.id));
    after = page.next ?? undefined;
  } while (after);
  expect(new Set(ids).size).toBe(161);
  expect((await owner.call("approvals.get", { approvalId: ids.at(-1)! })).approval.request).toBe(request);
});
